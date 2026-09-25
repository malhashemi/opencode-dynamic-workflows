/**
 * Server-Sent Events over `fetch`.
 *
 * `EventSource` cannot send headers, and a remote browser has to send its bearer token (tokens never travel in
 * URLs), so the stream is read with `fetch` and parsed here. The parser follows the WHATWG event-stream rules:
 * lines end in CRLF, LF or CR (a CRLF may be split across chunks), `:` starts a comment, a field's value drops
 * one leading space, `data` lines join with "\n", `id` persists across events, a blank line dispatches, and an
 * event without data is not dispatched.
 */

export interface SseMessage {
  event: string
  data: string
  /** The stream's last event id at dispatch time ("" when the server never sent one). */
  id: string
}

export class SseParser {
  lastEventId = ""
  retry: number | null = null
  private buffer = ""
  private data: string[] = []
  private hasData = false
  private eventType = ""
  private pendingCR = false
  private started = false

  constructor(lastEventId = "") {
    this.lastEventId = lastEventId
  }

  feed(chunk: string): SseMessage[] {
    const out: SseMessage[] = []
    let i = 0
    if (!this.started && chunk.length > 0) {
      this.started = true
      if (chunk.charCodeAt(0) === 0xfeff) i = 1
    }
    if (this.pendingCR && chunk.length > 0) {
      if (chunk.charCodeAt(i) === 10) i += 1
      this.pendingCR = false
    }
    let start = i
    for (; i < chunk.length; i++) {
      const code = chunk.charCodeAt(i)
      if (code !== 10 && code !== 13) continue
      this.line(this.buffer + chunk.slice(start, i), out)
      this.buffer = ""
      if (code === 13) {
        if (i + 1 < chunk.length) {
          if (chunk.charCodeAt(i + 1) === 10) i += 1
        } else this.pendingCR = true
      }
      start = i + 1
    }
    this.buffer += chunk.slice(start)
    return out
  }

  /** The stream ended: an incomplete event is discarded, as the spec says. */
  reset(): void {
    this.buffer = ""
    this.data = []
    this.hasData = false
    this.eventType = ""
    this.pendingCR = false
    this.started = false
  }

  private line(line: string, out: SseMessage[]): void {
    if (line === "") {
      if (this.hasData) out.push({ event: this.eventType || "message", data: this.data.join("\n"), id: this.lastEventId })
      this.data = []
      this.hasData = false
      this.eventType = ""
      return
    }
    if (line.charCodeAt(0) === 58) return // ":" comment
    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.charCodeAt(0) === 32) value = value.slice(1)
    switch (field) {
      case "event":
        this.eventType = value
        break
      case "data":
        this.data.push(value)
        this.hasData = true
        break
      case "id":
        if (!value.includes("\0")) this.lastEventId = value
        break
      case "retry":
        if (/^\d+$/.test(value)) this.retry = Number(value)
        break
    }
  }
}

export type SseStatus = "connecting" | "open" | "retrying" | "unauthorized" | "closed"

export interface SseOptions {
  url: string
  /** Headers for each (re)connection — read fresh so a newly paired token is picked up. */
  headers?: () => Record<string, string>
  onMessage(message: SseMessage): void
  onStatus?(status: SseStatus, detail?: string): void
  /** Called on 401 before retrying; may clear a revoked token. */
  onUnauthorized?(): void
  lastEventId?: string
  fetch?: typeof fetch
  /** Base retry delay; the server's `retry:` wins when present. */
  retryMs?: number
  maxRetryMs?: number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface SseConnection {
  close(): void
  readonly lastEventId: string
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(resolve, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/** Open a reconnecting event stream. Resumes with `Last-Event-ID` after every drop. */
export function connectSse(options: SseOptions): SseConnection {
  const controller = new AbortController()
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const sleep = options.sleep ?? defaultSleep
  const parser = new SseParser(options.lastEventId ?? "")
  const base = options.retryMs ?? 2000
  const max = options.maxRetryMs ?? 30_000
  let failures = 0

  const run = async () => {
    while (!controller.signal.aborted) {
      options.onStatus?.(failures === 0 ? "connecting" : "retrying")
      let delay = parser.retry ?? base
      try {
        const headers: Record<string, string> = { accept: "text/event-stream", ...(options.headers?.() ?? {}) }
        if (parser.lastEventId) headers["last-event-id"] = parser.lastEventId
        const response = await doFetch(options.url, { headers, signal: controller.signal, cache: "no-store" })
        if (response.status === 401) {
          options.onStatus?.("unauthorized")
          options.onUnauthorized?.()
          failures += 1
          delay = Math.min(max, base * 2 ** Math.min(failures, 4))
        } else if (!response.ok || !response.body) {
          failures += 1
          options.onStatus?.("retrying", `HTTP ${response.status}`)
          delay = Math.min(max, delay * 2 ** Math.min(failures - 1, 4))
        } else {
          options.onStatus?.("open")
          failures = 0
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
          try {
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              for (const message of parser.feed(value)) options.onMessage(message)
            }
          } finally {
            reader.releaseLock()
          }
          parser.reset()
          failures = 1
        }
      } catch (error) {
        if (controller.signal.aborted) break
        parser.reset()
        failures += 1
        options.onStatus?.("retrying", error instanceof Error ? error.message : String(error))
        delay = Math.min(max, delay * 2 ** Math.min(failures - 1, 4))
      }
      if (controller.signal.aborted) break
      options.onStatus?.("retrying")
      await sleep(delay, controller.signal)
    }
    options.onStatus?.("closed")
  }
  void run()

  return {
    close() {
      controller.abort()
    },
    get lastEventId() {
      return parser.lastEventId
    },
  }
}

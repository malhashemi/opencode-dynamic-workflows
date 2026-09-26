/**
 * One event stream per location, shared by every view. It turns the raw stream into two signals for listeners:
 * protocol events, and "re-read your snapshots" (a seq gap, a seq going backwards after a service restart, a
 * `resync.required`, or a reconnect — the replay after a reconnect is usually complete, but a restarted Gateway
 * cannot be told apart from a quiet one, so a cheap re-read is the safe default).
 *
 * Keeping a stream open also tells the engine a surface is attached, so questions and permission asks are
 * published to people instead of taking their headless defaults.
 */
import type { ProtocolEvent } from "@malhashemi/opencode-dynamic-workflows/protocol"
import { connectSse, type SseConnection, type SseMessage, type SseOptions, type SseStatus } from "./sse"
import { SeqTracker } from "./state"

export interface HubListener {
  event?(event: ProtocolEvent): void
  resync?(location: string, reason: string): void
}

export interface HubSource {
  eventsUrl(location: string): string
  authHeaders(): Record<string, string>
  onUnauthorized?(): void
}

export type LocationStatus = SseStatus

export class EventHub {
  private readonly listeners = new Set<HubListener>()
  private readonly streams = new Map<string, { connection: SseConnection; tracker: SeqTracker; opened: boolean }>()
  private readonly statuses = new Map<string, LocationStatus>()
  private readonly statusListeners = new Set<(statuses: ReadonlyMap<string, LocationStatus>) => void>()

  constructor(
    private readonly source: HubSource,
    private readonly connect: (options: SseOptions) => SseConnection = connectSse,
  ) {}

  locations(): string[] {
    return [...this.streams.keys()]
  }

  /** Open the stream for a location (idempotent). */
  ensure(location: string): void {
    if (this.streams.has(location)) return
    const tracker = new SeqTracker()
    const entry = { connection: undefined as unknown as SseConnection, tracker, opened: false }
    this.streams.set(location, entry)
    entry.connection = this.connect({
      url: this.source.eventsUrl(location),
      headers: () => this.source.authHeaders(),
      onUnauthorized: () => this.source.onUnauthorized?.(),
      onMessage: (message) => this.receive(location, tracker, message),
      onStatus: (status) => {
        if (status === "open") {
          if (entry.opened) this.resync(location, "reconnected")
          entry.opened = true
        }
        this.setStatus(location, status)
      },
    })
  }

  listen(listener: HubListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: (statuses: ReadonlyMap<string, LocationStatus>) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.statuses)
    return () => this.statusListeners.delete(listener)
  }

  close(): void {
    for (const { connection } of this.streams.values()) connection.close()
    this.streams.clear()
  }

  /** Exposed for tests: feed one raw SSE message as if it came from `location`'s stream. */
  receive(location: string, tracker: SeqTracker, message: SseMessage): void {
    let event: ProtocolEvent
    try {
      event = JSON.parse(message.data) as ProtocolEvent
    } catch {
      return
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") return
    if (event.type === "resync.required") {
      if (typeof event.seq === "number") tracker.resyncTo(event.seq, event.epoch)
      const reason = (event.data as { reason?: string } | undefined)?.reason ?? "resync required"
      this.resync(location, reason)
      return
    }
    const verdict = tracker.observe(event.seq, event.epoch)
    if (verdict !== "ok") this.resync(location, verdict === "gap" ? "missed events" : "the service restarted")
    for (const listener of [...this.listeners]) listener.event?.(event)
  }

  trackerFor(location: string): SeqTracker | undefined {
    return this.streams.get(location)?.tracker
  }

  private resync(location: string, reason: string): void {
    for (const listener of [...this.listeners]) listener.resync?.(location, reason)
  }

  private setStatus(location: string, status: LocationStatus): void {
    this.statuses.set(location, status)
    for (const listener of [...this.statusListeners]) listener(this.statuses)
  }
}

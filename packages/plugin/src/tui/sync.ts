/**
 * Keeps a {@link SyncState} current over the workflow RPC: snapshot, subscribe, apply, catch up, resync.
 *
 * OpenCode's event stream is volatile (no replay; the first event after subscribing can be missed),
 * so the controller never trusts it alone: it re-subscribes with backoff, and {@link WorkflowSync.poll} (run with
 * the attach heartbeat) asks `eventsSince` for anything the stream dropped. Every read goes through the pure
 * reducer in `state.ts`; this module only performs the I/O the reducer asks for.
 */
import type { ProtocolEvent } from "../protocol"
import { errorText, type EventStream, type WorkflowApi } from "./api"
import {
  applyActivitySnapshot,
  applyEvent,
  applyRunSnapshot,
  emptyState,
  fromSnapshot,
  type Effect,
  type SyncState,
} from "./state"

export interface SyncOptions {
  api: WorkflowApi
  events: EventStream
  onState: (state: SyncState) => void
  /** `waiting` and `ended` effects, for toasts and attention. */
  onNotice?: (effect: Extract<Effect, { kind: "waiting" | "ended" }>) => void
  onError?: (message: string | null) => void
  /** How many Runs of history the library reads (live Runs always come in full). */
  historyLimit?: number
  /** At most this many live Runs are read in full on a resync; the rest hydrate when an event needs them. */
  hydrateLimit?: number
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })

export class WorkflowSync {
  private state: SyncState = emptyState()
  private readonly queue: ProtocolEvent[] = []
  private busy = false
  private pendingResync: string | null = null
  private readonly hydrating = new Set<string>()
  private readonly abort = new AbortController()
  private readonly options: SyncOptions

  constructor(options: SyncOptions) {
    this.options = options
  }

  get current(): SyncState {
    return this.state
  }

  /** Subscribe first (so nothing is lost while the snapshot loads), then read the snapshot. */
  async start(): Promise<void> {
    void this.listen()
    await this.resync("start")
  }

  stop(): void {
    this.abort.abort()
  }

  get stopped(): boolean {
    return this.abort.signal.aborted
  }

  /** One event from the stream (or a test). Queued while a snapshot or catch-up is in flight. */
  receive(event: ProtocolEvent): void {
    if (this.busy) {
      this.queue.push(event)
      return
    }
    this.dispatch(event)
  }

  private set(state: SyncState): void {
    if (state === this.state) return
    this.state = state
    this.options.onState(state)
  }

  private dispatch(event: ProtocolEvent): void {
    const { state, effects } = applyEvent(this.state, event)
    this.set(state)
    for (const effect of effects) this.effect(effect)
  }

  private effect(effect: Effect): void {
    switch (effect.kind) {
      case "catchup":
        void this.catchup(effect.after)
        return
      case "resync":
        void this.resync(effect.reason)
        return
      case "hydrate":
        void this.hydrate(effect.runId)
        return
      default:
        this.options.onNotice?.(effect)
    }
  }

  private flush(): void {
    while (!this.busy && this.queue.length > 0) this.dispatch(this.queue.shift()!)
  }

  /** Run `work` exclusively; events arriving meanwhile are queued and applied afterwards, in order. */
  private async exclusive(work: () => Promise<void>): Promise<void> {
    this.busy = true
    try {
      await work()
      this.options.onError?.(null)
    } catch (error) {
      this.options.onError?.(errorText(error))
    } finally {
      this.busy = false
    }
    if (this.pendingResync !== null) {
      const reason = this.pendingResync
      this.pendingResync = null
      await this.resync(reason)
      return
    }
    this.flush()
  }

  /** Re-read everything: the location, the latest `seq`, the library, and every live Run in full. */
  async resync(reason: string): Promise<void> {
    if (this.busy) {
      this.pendingResync = reason
      return
    }
    await this.exclusive(async () => {
      const { api } = this.options
      const info = await api.info()
      // Asking for events after "infinity" returns none, cheaply, and tells us the current `seq`.
      const { latest, epoch } = await api.eventsSince({ after: Number.MAX_SAFE_INTEGER })
      const { runs: entries } = await api.listRuns({ limit: this.options.historyLimit ?? 200 })
      const live = entries.filter((entry) => entry.live || entry.waiting).slice(0, this.options.hydrateLimit ?? 25)
      const runs = (
        await Promise.all(
          live.map((entry) =>
            api.getRun({ runId: entry.runId }).then(
              (out) => out.run,
              () => null,
            ),
          ),
        )
      ).filter((run) => run !== null)
      this.set(
        fromSnapshot({
          location: info.location,
          seq: latest,
          ...(epoch ? { epoch } : {}),
          entries,
          runs,
          previous: this.state,
        }),
      )
    })
  }

  /** Fill a `seq` gap from the service's event window; re-read everything when the window no longer covers it. */
  async catchup(after: number): Promise<void> {
    if (this.busy) return
    const outcome: { resync: string | null } = { resync: null }
    await this.exclusive(async () => {
      const epoch = this.state.epoch
      const tail = await this.options.api.eventsSince({ after, ...(epoch ? { epoch } : {}) })
      if (tail.latest < after || (epoch && tail.epoch && tail.epoch !== epoch)) outcome.resync = "the service restarted"
      else if (!tail.complete) outcome.resync = "missed events are no longer retained"
      else for (const event of tail.events) this.dispatchQuietly(event)
    })
    if (outcome.resync) await this.resync(outcome.resync)
  }

  /** Apply a caught-up event; a nested catch-up request is ignored (the window is already being replayed). */
  private dispatchQuietly(event: ProtocolEvent): void {
    const { state, effects } = applyEvent(this.state, event)
    this.set(state)
    for (const effect of effects) if (effect.kind !== "catchup") this.effect(effect)
  }

  /** The heartbeat's safety net for a silent stream: pick up anything after the last applied `seq`. */
  async poll(): Promise<void> {
    if (this.busy || !this.state.ready) return
    await this.catchup(this.state.seq)
  }

  /** Read one Run in full (an event needed its Units, or a view opened it). */
  async hydrate(runId: string): Promise<void> {
    if (this.hydrating.has(runId)) return
    this.hydrating.add(runId)
    try {
      const { run } = await this.options.api.getRun({ runId })
      this.set(applyRunSnapshot(this.state, run))
    } catch (error) {
      this.options.onError?.(errorText(error))
    } finally {
      this.hydrating.delete(runId)
    }
  }

  /** A view opens a Run: its full snapshot and its activity feed. */
  async open(runId: string): Promise<void> {
    const [run, activity] = await Promise.all([
      this.options.api.getRun({ runId }),
      this.options.api.getActivity({ runId }).catch(() => ({ entries: [] })),
    ])
    this.set(applyActivitySnapshot(applyRunSnapshot(this.state, run.run), runId, activity.entries))
  }

  private async listen(): Promise<void> {
    const signal = this.abort.signal
    let delay = 500
    let first = true
    while (!signal.aborted) {
      if (!first) void this.poll()
      first = false
      try {
        for await (const message of this.options.events(signal)) {
          delay = 500
          if (message?.data) this.receive(message.data)
        }
      } catch (error) {
        if (signal.aborted) break
        this.options.onError?.(`event stream: ${errorText(error)}`)
      }
      await sleep(delay, signal)
      delay = Math.min(delay * 2, 10_000)
    }
  }
}

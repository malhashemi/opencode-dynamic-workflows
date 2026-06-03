/**
 * Reusable instrumentation core for the silent-hang live probes (slice 1.1).
 *
 * The probes (slices 1.2–1.4) all need the same thing: boot a real opencode, watch the event stream,
 * and ask after the fact "did this session ever go idle / get interrupted / is it still busy?". This
 * module is that shared harness — the one piece of it that is pure (`sessionIdOf`) carries the unit
 * tests; the live pieces are exercised by the operator-run probes.
 *
 * Wire shapes (CF2) are verified against `@opencode-ai/sdk/v2` v1.15.12 `types.gen.d.ts`. We keep our own
 * minimal structural types rather than importing the SDK's full `Event` union: the stream is consumed
 * via `as any` at the boundary (the SDK's SSE iterator is loosely typed), and we only ever read a
 * handful of fields.
 */

/** Minimal structural view of an opencode event as it arrives off the SSE stream. */
export interface OpencodeEvent {
  type: string
  properties?: Record<string, unknown> | null
}

/**
 * Normalize the session id off whichever event we got. opencode scatters the id across four field forms
 * depending on event type (CF2):
 *   - `properties.sessionID`        — session.status
 *   - `properties.info.id`          — session.updated (info is a Session; its own id IS the session id)
 *   - `properties.info.sessionID`   — message.updated (info is a Message; carries sessionID)
 *   - `properties.part.sessionID`   — message.part.updated (part carries sessionID)
 * Anything else (e.g. a session.error with no sessionID) ⇒ null. We probe the forms in order and return
 * the first string we find rather than switching on `type`, so a new event type that reuses one of these
 * shapes is picked up for free.
 */
export function sessionIdOf(event: OpencodeEvent | null | undefined): string | null {
  const props = event?.properties
  if (!props || typeof props !== "object") return null
  const p = props as Record<string, unknown>

  // Form 1: properties.sessionID (session.status, and most *.removed / diff / idle events).
  if (typeof p.sessionID === "string") return p.sessionID

  // Forms 2 & 3: properties.info.{id|sessionID}. For a Session, `id` IS the session id; for a Message,
  // the session id is `sessionID` (its `id` is the message id), so prefer sessionID when present.
  const info = p.info
  if (info && typeof info === "object") {
    const i = info as Record<string, unknown>
    if (typeof i.sessionID === "string") return i.sessionID
    if (typeof i.id === "string") return i.id
  }

  // Form 4: properties.part.sessionID (message.part.updated).
  const part = p.part
  if (part && typeof part === "object") {
    const pt = part as Record<string, unknown>
    if (typeof pt.sessionID === "string") return pt.sessionID
  }

  return null
}

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Live harness around the pure core. None of the below is unit-tested (it needs a real opencode + SSE
// stream); it is exercised by the operator-run probes in slices 1.2–1.4. The unit tests cover only
// `sessionIdOf` above.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** An event as recorded, with the session it was attributed to (via `sessionIdOf`) and a wall-clock stamp. */
export interface RecordedEvent {
  /** Attributed session id, or null if the event carried none (e.g. an un-sessioned error). */
  sessionID: string | null
  /** The raw event type (e.g. "session.status", "session.error"). */
  type: string
  /** For session.status events, the resolved status kind ("idle" | "busy" | "retry"); else undefined. */
  status?: string
  /** `Date.now()` at the moment the event was pulled off the stream. */
  t: number
  /** The raw event, retained for ad-hoc inspection in a probe. */
  raw: OpencodeEvent
}

/**
 * Minimal structural slice of the opencode SDK client that the recorder uses. The real
 * `OpencodeClient` is a structural superset and is cast to this at the boundary (per the repo
 * convention in `src/client.ts`) — we depend on the narrow shape so the probes read clearly and so the
 * exact methods we touch are documented in one place.
 */
export interface RecorderClient {
  event: {
    /** SSE subscription — yields events off `.stream` (an async generator). Subscribe BEFORE starting any
     * Run so no early event is missed (R4). */
    subscribe(): Promise<{ stream: AsyncGenerator<OpencodeEvent> }>
  }
  session: {
    /** `GET /session/status` (CF4) — `responseStyle:"fields"`, so the map lives under `.data`, keyed by
     * session id. A session absent from the map is treated as not-busy. */
    status(): Promise<{ data?: Record<string, { type?: string } | undefined> | null } | null>
  }
}

/** Pull the status kind ("idle" | "busy" | "retry") off a session.status event, if it is one. */
function statusOf(event: OpencodeEvent): string | undefined {
  if (event.type !== "session.status") return undefined
  const status = (event.properties as Record<string, unknown> | undefined)?.status
  if (status && typeof status === "object") {
    const s = (status as Record<string, unknown>).type
    if (typeof s === "string") return s
  }
  return undefined
}

/**
 * Accumulates the events seen since `startRecorder`, keyed by session, and answers the localization
 * questions the probes ask after a Run resolves/times out: did the child go idle, did it get
 * interrupted, what was its last status. Backed by a flat append-only list (the volumes here are tiny —
 * one Run's worth of events), filtered per query.
 */
export class EventRecorder {
  private readonly events: RecordedEvent[] = []
  private stopped = false

  /** Append a raw event (called by the `startRecorder` pump). No-op once stopped. */
  record(raw: OpencodeEvent): void {
    if (this.stopped) return
    this.events.push({ sessionID: sessionIdOf(raw), type: raw.type, status: statusOf(raw), t: Date.now(), raw })
  }

  /** Every recorded event attributed to `sessionID`, in arrival order. */
  forSession(sessionID: string): RecordedEvent[] {
    return this.events.filter((e) => e.sessionID === sessionID)
  }

  /** The status kind of the most recent session.status event for `sessionID`, or undefined if none seen. */
  lastStatus(sessionID: string): string | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]
      if (e?.sessionID === sessionID && e.status !== undefined) return e.status
    }
    return undefined
  }

  /**
   * Did `sessionID` reach idle strictly after wall-clock `t`? True if either a `session.idle` event or a
   * session.status→idle transition was recorded after `t`. This is the "the Run actually finished /
   * the abort took" signal — branch i in the trichotomy asks whether this is FALSE after an abort fired.
   */
  sawIdleAfter(sessionID: string, t: number): boolean {
    return this.events.some(
      (e) => e.sessionID === sessionID && e.t > t && (e.type === "session.idle" || e.status === "idle"),
    )
  }

  /**
   * Did `sessionID` get interrupted strictly after wall-clock `t`? True if a `session.error` carrying an
   * abort (MessageAbortedError) was recorded after `t` — i.e. an abort actually landed on this session.
   */
  sawInterruptedAfter(sessionID: string, t: number): boolean {
    return this.events.some((e) => {
      if (e.sessionID !== sessionID || e.t <= t || e.type !== "session.error") return false
      const error = (e.raw.properties as Record<string, unknown> | undefined)?.error
      const name = error && typeof error === "object" ? (error as Record<string, unknown>).name : undefined
      return name === "MessageAbortedError"
    })
  }

  /** Stop recording. The pump's `for await` is driven by the caller; this just gates further `record`s. */
  stop(): void {
    this.stopped = true
  }
}

/**
 * Subscribe to the client's event stream and pump every event into a fresh `EventRecorder`. Returns the
 * recorder synchronously after the subscription is established, so a caller can subscribe BEFORE
 * starting a Run (R4) — the background pump then fills it as events arrive. The pump's errors are
 * swallowed (a closed stream at shutdown is expected).
 */
export async function startRecorder(client: RecorderClient): Promise<EventRecorder> {
  const recorder = new EventRecorder()
  const sub = await client.event.subscribe()
  void (async () => {
    try {
      for await (const event of sub.stream) recorder.record(event)
    } catch {
      // stream closed (server shutdown / abort) — expected; nothing to do.
    }
  })()
  return recorder
}

/**
 * Poll `GET /session/status` (CF4) and report whether `sessionID` is currently busy. Used by the probes
 * to detect branch iii: a session still reported busy by the server AFTER its Run resolved (a leaked /
 * never-released busy state). A session absent from the status map is treated as not busy.
 */
export async function isSessionBusy(client: RecorderClient, sessionID: string): Promise<boolean> {
  const res = await client.session.status()
  const map = res?.data
  if (!map || typeof map !== "object") return false
  return map[sessionID]?.type === "busy"
}

/** What `bootWithRecorder` hands back: the live client, the server handle (for `.close()`), and the recorder. */
export interface BootedWithRecorder {
  client: RecorderClient
  server: { url: string; close(): void }
  recorder: EventRecorder
}

/**
 * Boot a real opencode (CF1 inline idiom — inherits the operator's configured model + plugins) and
 * attach a recorder, subscribing BEFORE returning so no startup event is missed (R4). `configOverride`
 * is shallow-merged onto the default `{ logLevel: "ERROR" }` so a probe can, e.g., point a provider at
 * a stub baseURL (slice 1.4). The caller owns `server.close()` (use a try/finally).
 */
export async function bootWithRecorder(configOverride?: Record<string, unknown>): Promise<BootedWithRecorder> {
  // Imported lazily so the pure `sessionIdOf` path (and its unit test) never pulls in the live SDK.
  const { createOpencode } = await import("@opencode-ai/sdk/v2")
  const port = 40000 + Math.floor(Date.now() % 20000)
  const { client, server } = await createOpencode({
    port,
    config: { logLevel: "ERROR", ...configOverride },
    timeout: 30000,
  })
  const recorderClient = client as unknown as RecorderClient
  const recorder = await startRecorder(recorderClient)
  return { client: recorderClient, server, recorder }
}

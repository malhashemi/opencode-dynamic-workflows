/**
 * The two-pane shell (resolved question 4): run list rail on the left, live run detail on the right, an answer
 * card pinned to the top of the detail pane, one stacked column under ~720px.
 *
 * Two decisions inherited from the rest of the product are load-bearing here:
 *
 * - **Loopback needs no token.** The endpoint answers every route bare on its default loopback bind — same
 *   trust boundary as `opencode serve` itself — and its address is persisted per worktree, so a bare link (and
 *   an old tab) keeps working across host restarts. A token only exists on a deliberately non-loopback bind:
 *   there the link still carries `?token=`, and this shell picks it up, keeps it for the tab (sessionStorage,
 *   so a reload survives), and replays it as the bearer on every API call.
 *
 * - **Run state is read through plain functions that also read a clock** (the Phase 4 freshness rule). This is
 *   the third reactive graph over the same transport; the last one only ever looked right because a timer
 *   redrew it. `connect()` already publishes a NEW state object per action through one plain signal, and this
 *   shell never puts a `createMemo` in front of that read — `snapshot()` below is a function call, every time.
 */
import { createEffect, createSignal, on, onCleanup, Show, type JSX } from "solid-js"
import type { RunSnapshot } from "./engine"
import { createControls } from "./controls"
import { connect, fetchRecord, type ConnectOptions, type DashboardScope, type DashboardState } from "./state"
import { RunList } from "./runs"
import { RunDetail } from "./run"

const TOKEN_KEY = "workflow-dashboard-token"

/** The query token wins (a fresh link is the freshest credential); the tab's stored one covers a reload. */
function resolveToken(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get("token")
  if (fromUrl) {
    try {
      sessionStorage.setItem(TOKEN_KEY, fromUrl)
    } catch {
      // Private-mode storage failures leave the URL itself as the credential, which still works.
    }
    return fromUrl
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/** What the journal said when asked for a run the live store does not hold. */
type ArchivedRead =
  | { runId: string; state: "reading" }
  | { runId: string; state: "not-found" | "unreachable" }
  | { runId: string; state: "ok"; run: RunSnapshot }

export default function App(): JSX.Element {
  // `null` is the NORMAL case now (loopback needs none); a token only rides a non-loopback bind's link, and
  // then the API would 401 without it — so it is kept and replayed, never demanded.
  const token = resolveToken()
  const options: ConnectOptions = { baseUrl: window.location.origin, token }
  const live = connect(options)
  onCleanup(() => live.stop())
  const controls = createControls(options)

  const [scope, setScope] = createSignal<DashboardScope>("project")
  // The connection owns the scope's transport half (the `?scope=everywhere` reads and the peer poll); the
  // signal owns its rendering half. One effect keeps them the same fact.
  createEffect(() => live.setScope(scope()))

  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(tick))
  /** THE read for run state: a plain function over the live signal, riding the clock as well. Never memoized. */
  const snapshot = (): DashboardState => {
    now()
    return live.state()
  }

  const [selected, setSelected] = createSignal<string | null>(null)
  // Opening onto an empty pane when runs exist would make the user do the one obvious thing themselves.
  createEffect(() => {
    if (selected() !== null) return
    const first = live.state().runs[0] ?? live.state().history[0]
    if (first) setSelected(first.runId)
  })

  // A selected run the store does not hold is a HISTORY row: read its journaled record on demand, and say each
  // of the three endings out loud rather than showing an empty pane that could mean any of them.
  //
  // Whether the store holds it is TRACKED, not read once: a host restart's fresh snapshot drops every run the
  // old process held, and the run the user is looking at becomes a history row without the selection changing.
  // An effect keyed on the selection alone left the pane blank until they clicked away and back. The effect
  // re-runs on every publish (that is what tracking live state costs) and acts only when the answer moved.
  const [archived, setArchived] = createSignal<ArchivedRead | null>(null)
  const selectedIsLive = (): boolean => {
    const id = selected()
    return id !== null && live.state().runs.some((run) => run.runId === id)
  }
  createEffect(
    on([selected, selectedIsLive], ([id, isLive], previous) => {
      if (previous && previous[0] === id && previous[1] === isLive) return
      setArchived(null)
      if (!id || isLive) return
      setArchived({ runId: id, state: "reading" })
      void fetchRecord(options, id).then((result) => {
        if (selected() !== id) return
        setArchived(result.ok ? { runId: id, state: "ok", run: result.record.run } : { runId: id, state: result.reason })
      })
    }),
  )

  const run = (): RunSnapshot | undefined => {
    const id = selected()
    if (!id) return undefined
    const fromStore = snapshot().runs.find((candidate) => candidate.runId === id)
    if (fromStore) return fromStore
    const read = archived()
    return read && read.runId === id && read.state === "ok" ? read.run : undefined
  }

  const readNotice = (): string | null => {
    const read = archived()
    if (!read || read.runId !== selected()) return null
    if (read.state === "reading") return "Reading this run from the journal…"
    if (read.state === "not-found") return "This run is not in the journal."
    if (read.state === "unreachable") return "The journal could not be read."
    return null
  }

  const activeCount = () => snapshot().runs.filter((candidate) => candidate.status === "running").length

  return (
    <div class="shell">
      <header class="shell-header">
        <span class="shell-title">Workflows</span>
        <span class="detail-meta">{activeCount()} active</span>
        <div class="shell-spacer" />
        <span class="live-indicator" classList={{ connected: snapshot().connected }}>
          <span class="live-dot" />
          {snapshot().connected ? "live" : "reconnecting…"}
        </span>
      </header>
      <div class="shell-body">
        <RunList
          state={snapshot}
          selected={selected()}
          onSelect={setSelected}
          scope={scope()}
          onScope={() => setScope((current) => (current === "project" ? "everywhere" : "project"))}
        />
        <main class="detail">
          <Show
            when={run()}
            fallback={
              <div class="detail-placeholder">
                <Show when={readNotice()} fallback={<p>Select a run to watch it live.</p>}>
                  <p>{readNotice()}</p>
                </Show>
              </div>
            }
          >
            <RunDetail run={run} controls={controls} readRecord={(runId) => fetchRecord(options, runId)} />
          </Show>
        </main>
      </div>
    </div>
  )
}

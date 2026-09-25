/**
 * Client state, as pure functions over protocol values (the client rule in docs/protocol/README.md):
 *
 *   snapshot → subscribe → apply events whose `revision` > the snapshot's → on a seq gap or `resync.required`,
 *   re-read the snapshots.
 *
 * The comparison is against the SNAPSHOT's revision, not the latest applied one: one store change can emit
 * several events with the same revision (a phase change is `run.updated` + `activity.appended`), and all of them
 * belong after the snapshot.
 */
import type {
  ActivityEntry,
  LibraryEntry,
  PendingInteraction,
  ProtocolEvent,
  ResolvedInteraction,
  Run,
  RunHeader,
  Unit,
} from "opencode-dynamic-workflows/protocol"

// ---------------------------------------------------------------------------------------------------------------
// Sequence tracking (one per location stream)
// ---------------------------------------------------------------------------------------------------------------

export type SeqVerdict = "ok" | "gap" | "reset"

/** Per-location `seq` watch: contiguous is fine, a jump means missed events, going backwards means a restart. */
export class SeqTracker {
  last: number | null = null

  observe(seq: number): SeqVerdict {
    const previous = this.last
    this.last = seq
    if (previous === null || seq === previous + 1) return "ok"
    return seq > previous ? "gap" : "reset"
  }

  /** A `resync.required` carries the server's latest seq: continue from there. */
  resyncTo(seq: number): void {
    this.last = seq
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One Run
// ---------------------------------------------------------------------------------------------------------------

export interface RunView {
  runId: string
  run: Run | null
  live: boolean
  /** The revision of the snapshot `run` was built from; events at or below it are already in it. */
  baseRevision: number
  activity: ActivityEntry[]
  /** Events that arrived while a snapshot was being (re)read. */
  buffered: ProtocolEvent[]
  /** `loading` / `syncing`: buffer events until the snapshot lands. */
  sync: "loading" | "ready" | "syncing"
}

export function emptyRunView(runId: string): RunView {
  return { runId, run: null, live: false, baseRevision: 0, activity: [], buffered: [], sync: "loading" }
}

/** A snapshot is about to be re-read: keep showing what we have, buffer what arrives meanwhile. */
export function beginResync(view: RunView): RunView {
  return { ...view, sync: view.run ? "syncing" : "loading", buffered: [] }
}

const activityKey = (entry: ActivityEntry) => `${entry.time}\u0000${entry.kind}\u0000${entry.unitId ?? ""}\u0000${entry.message}`

function mergeActivity(into: ActivityEntry[], add: ActivityEntry[]): ActivityEntry[] {
  if (add.length === 0) return into
  const seen = new Set(into.map(activityKey))
  const out = [...into]
  for (const entry of add) {
    const key = activityKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/**
 * Install a snapshot (`GET /v1/runs/:id`, then `/activity`), then replay the buffered events that are newer.
 * Activity has no revision of its own, so entries are de-duplicated by content.
 */
export function receiveSnapshot(view: RunView, snapshot: { run: Run; live: boolean }, activity: ActivityEntry[]): RunView {
  let next: RunView = {
    ...view,
    run: snapshot.run,
    live: snapshot.live,
    baseRevision: snapshot.run.revision,
    activity: mergeActivity([], activity),
    buffered: [],
    sync: "ready",
  }
  for (const event of view.buffered) next = receiveEvent(next, event)
  return next
}

export function receiveEvent(view: RunView, event: ProtocolEvent): RunView {
  if (event.runId !== view.runId) return view
  if (view.sync !== "ready" || !view.run) return { ...view, buffered: [...view.buffered, event] }
  if (event.revision <= view.baseRevision) return view
  return applyRunEvent(view, event)
}

function sortUnits(units: Unit[]): Unit[] {
  return [...units].sort((a, b) => a.ordinal - b.ordinal)
}

function isTerminal(status: Run["status"]): boolean {
  return status !== "running" && status !== "queued"
}

/** Apply one event to a ready view. Exported for tests; callers go through {@link receiveEvent}. */
export function applyRunEvent(view: RunView, event: ProtocolEvent): RunView {
  const current = view.run
  if (!current) return view
  let run: Run = current
  let live = view.live
  let activity = view.activity
  switch (event.type) {
    case "run.started": {
      run = event.data as Run
      live = !isTerminal(run.status)
      break
    }
    case "run.updated":
    case "run.ended": {
      const header = event.data as RunHeader
      run = { ...current, ...header, units: current.units, logs: current.logs, interactions: current.interactions, resolved: current.resolved }
      live = event.type === "run.ended" ? false : !isTerminal(run.status)
      break
    }
    case "unit.updated": {
      const unit = event.data as Unit
      const units = current.units.some((candidate) => candidate.unitId === unit.unitId)
        ? current.units.map((candidate) => (candidate.unitId === unit.unitId ? unit : candidate))
        : [...current.units, unit]
      run = { ...current, units: sortUnits(units) }
      break
    }
    case "interaction.pending": {
      const interaction = event.data as PendingInteraction
      const interactions = current.interactions.some((candidate) => candidate.interactionId === interaction.interactionId)
        ? current.interactions.map((candidate) => (candidate.interactionId === interaction.interactionId ? interaction : candidate))
        : [...current.interactions, interaction]
      run = { ...current, interactions, waiting: true }
      break
    }
    case "interaction.resolved": {
      const record = event.data as ResolvedInteraction
      const interactions = current.interactions.filter((candidate) => candidate.interactionId !== record.interactionId)
      const resolved = [...current.resolved.filter((candidate) => candidate.interactionId !== record.interactionId), record]
      run = { ...current, interactions, resolved, waiting: interactions.length > 0 }
      break
    }
    case "activity.appended": {
      const entry = event.data as ActivityEntry
      activity = mergeActivity(view.activity, [entry])
      if (entry.kind === "log") run = { ...current, logs: [...current.logs, entry.message] }
      break
    }
    default:
      return view
  }
  if (event.revision > run.revision) run = { ...run, revision: event.revision }
  return { ...view, run, live, activity }
}

/** Replace one Unit with its full record (`GET /v1/runs/:id/units/:unitId`) without touching the revision. */
export function withFullUnit(view: RunView, unit: Unit): RunView {
  if (!view.run) return view
  const existing = view.run.units.find((candidate) => candidate.unitId === unit.unitId)
  // A newer event may have landed while the fetch was in flight; only fill the output in.
  if (existing && (existing.status !== unit.status || existing.attempts.length !== unit.attempts.length)) return view
  return { ...view, run: { ...view.run, units: view.run.units.map((candidate) => (candidate.unitId === unit.unitId ? unit : candidate)) } }
}

// ---------------------------------------------------------------------------------------------------------------
// Derived figures
// ---------------------------------------------------------------------------------------------------------------

export type UnitCounts = Record<Unit["status"], number> & { total: number; settled: number }

export function unitCounts(units: Unit[]): UnitCounts {
  const counts: UnitCounts = { queued: 0, running: 0, repairing: 0, succeeded: 0, failed: 0, stopped: 0, replayed: 0, total: units.length, settled: 0 }
  for (const unit of units) {
    counts[unit.status] += 1
    if (unit.status === "succeeded" || unit.status === "failed" || unit.status === "stopped" || unit.status === "replayed") counts.settled += 1
  }
  return counts
}

/** "phase i/n" only when the Workflow declared its phases; otherwise the denominator is unknown (honesty rule). */
export function phasePosition(run: Pick<Run, "phases" | "phasesDeclared" | "currentPhase">): string | null {
  if (!run.currentPhase) return run.phasesDeclared && run.phases.length > 0 ? `${run.phases.length} phases` : null
  const index = run.phases.indexOf(run.currentPhase)
  if (index === -1) return run.currentPhase
  return run.phasesDeclared ? `phase ${index + 1}/${run.phases.length}` : `phase ${index + 1}`
}

export type PhaseState = "done" | "current" | "pending"

export interface PhaseRow {
  name: string
  state: PhaseState
  units: Unit[]
}

/** Phases in order with their Units; Units outside any phase come first under `null`. */
export function phaseRows(run: Run): { unphased: Unit[]; phases: PhaseRow[] } {
  const current = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1
  const succeeded = run.status === "succeeded"
  const phases = run.phases.map((name, index) => ({
    name,
    state: (index < current || (succeeded && index <= current) ? "done" : index === current ? "current" : "pending") as PhaseState,
    units: run.units.filter((unit) => unit.phase === name),
  }))
  const known = new Set(run.phases)
  return { unphased: run.units.filter((unit) => unit.phase === null || !known.has(unit.phase)), phases }
}

// ---------------------------------------------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------------------------------------------

export interface LibraryFilter {
  status: "all" | "live" | "waiting" | Run["status"]
  search: string
  location: string | "all"
}

export function filterLibrary(entries: LibraryEntry[], filter: LibraryFilter): LibraryEntry[] {
  const needle = filter.search.trim().toLowerCase()
  return entries.filter((entry) => {
    if (filter.location !== "all" && entry.location !== filter.location) return false
    if (filter.status === "live" && !entry.live) return false
    if (filter.status === "waiting" && !entry.waiting) return false
    if (filter.status !== "all" && filter.status !== "live" && filter.status !== "waiting" && entry.status !== filter.status) return false
    if (!needle) return true
    return [entry.runId, entry.workflow.name, entry.workflow.key ?? "", entry.workflow.description, entry.location].some((field) =>
      field.toLowerCase().includes(needle),
    )
  })
}

/** Merge a `library.changed` entry into the list (newest first) until the next refetch confirms it. */
export function upsertLibraryEntry(entries: LibraryEntry[], entry: LibraryEntry): LibraryEntry[] {
  const rest = entries.filter((candidate) => candidate.runId !== entry.runId)
  return [...rest, entry].sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
}

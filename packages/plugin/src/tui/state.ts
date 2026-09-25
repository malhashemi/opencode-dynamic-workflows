/**
 * The TUI's copy of one location's Runs, and the pure rule that keeps it current.
 *
 * Protocol rule (docs/protocol): snapshot → subscribe → apply events whose `revision` is greater than the
 * snapshot's → on a `seq` gap or `resync.required`, re-read. {@link applyEvent} never performs I/O; it returns the
 * next state plus the {@link Effect}s the caller must carry out (catch up, resync, hydrate a Run, notify).
 *
 * A Run is held at one of two depths: a {@link LibraryEntry} (what `listRuns` returns, enough for the library
 * and the strip) or the full {@link Run} (`getRun`, needed to apply Unit and interaction events). Live Runs are
 * hydrated to full depth; history stays at entry depth until a view opens it.
 */
import type { ActivityEntry, LibraryEntry, PendingInteraction, ProtocolEvent, ResolvedInteraction, Run, RunHeader, Unit } from "../protocol"
import { addUsage, emptyUsage } from "../protocol"
import { isTerminal, toLibraryEntry } from "../runs"

export interface RunSlot {
  /** Always present; derived from `run` whenever the Run is held in full. */
  readonly entry: LibraryEntry
  readonly run: Run | null
  /** The revision of the last full snapshot: events at or below it are already in `run`. */
  readonly snapshotRevision: number
  /** Loaded on demand (the Run view); null until then. */
  readonly activity: readonly ActivityEntry[] | null
}

export interface SyncState {
  /** The canonical location (from `info`); events for other locations are ignored. */
  readonly location: string | null
  /** The last applied event `seq`; 0 before the first snapshot. */
  readonly seq: number
  readonly runs: Readonly<Record<string, RunSlot>>
  /** False until the first snapshot has loaded. */
  readonly ready: boolean
}

export type Effect =
  | { readonly kind: "catchup"; readonly after: number }
  | { readonly kind: "resync"; readonly reason: string }
  | { readonly kind: "hydrate"; readonly runId: string }
  | { readonly kind: "waiting"; readonly runId: string; readonly interaction: PendingInteraction }
  | { readonly kind: "ended"; readonly runId: string }

export interface Applied {
  readonly state: SyncState
  readonly effects: readonly Effect[]
}

export function emptyState(location: string | null = null): SyncState {
  return { location, seq: 0, runs: {}, ready: false }
}

const live = (status: Run["status"]) => !isTerminal(status)

function entryOf(run: Run): LibraryEntry {
  return toLibraryEntry(run, live(run.status))
}

function slotOf(run: Run, activity: readonly ActivityEntry[] | null = null, snapshotRevision = run.revision): RunSlot {
  return { entry: entryOf(run), run, snapshotRevision, activity }
}

function withSlot(state: SyncState, runId: string, slot: RunSlot): SyncState {
  return { ...state, runs: { ...state.runs, [runId]: slot } }
}

/** A fresh state from a full re-read: the library, the Runs read in full, and the `seq` it is current to. */
export function fromSnapshot(input: { location: string; seq: number; entries: readonly LibraryEntry[]; runs: readonly Run[]; previous?: SyncState }): SyncState {
  const runs: Record<string, RunSlot> = {}
  for (const entry of input.entries) runs[entry.runId] = { entry: { ...entry, live: live(entry.status) }, run: null, snapshotRevision: 0, activity: null }
  for (const run of input.runs) runs[run.runId] = slotOf(run, input.previous?.runs[run.runId]?.activity ?? null)
  // Runs a view already holds in full that the (bounded) library did not list stay available.
  for (const [runId, slot] of Object.entries(input.previous?.runs ?? {})) {
    if (!runs[runId] && slot.run) runs[runId] = slot
  }
  return { location: input.location, seq: input.seq, runs, ready: true }
}

/** Apply a full `getRun` snapshot (a hydrate or a view opening a Run). Never goes backwards. */
export function applyRunSnapshot(state: SyncState, run: Run): SyncState {
  const current = state.runs[run.runId]
  if (current?.run && current.run.revision > run.revision) return state
  return withSlot(state, run.runId, slotOf(run, current?.activity ?? null))
}

export function applyActivitySnapshot(state: SyncState, runId: string, entries: readonly ActivityEntry[]): SyncState {
  const current = state.runs[runId]
  if (!current) return state
  return withSlot(state, runId, { ...current, activity: [...entries] })
}

/** Merge a `run.updated` / `run.ended` header into an entry-depth Run. */
function mergeHeaderIntoEntry(entry: LibraryEntry, header: RunHeader): LibraryEntry {
  return {
    ...entry,
    workflow: header.workflow,
    status: header.status,
    waiting: header.waiting,
    phases: header.phases,
    phasesDeclared: header.phasesDeclared,
    currentPhase: header.currentPhase,
    usage: header.usage,
    tokensSpent: header.tokensSpent,
    startedAt: header.startedAt,
    endedAt: header.endedAt,
    live: live(header.status),
  }
}

function upsertUnit(units: readonly Unit[], unit: Unit): Unit[] {
  const next = units.filter((candidate) => candidate.unitId !== unit.unitId)
  next.push(unit)
  return next.sort((a, b) => a.ordinal - b.ordinal)
}

function applyToRun(run: Run, event: ProtocolEvent): Run {
  switch (event.type) {
    case "run.updated":
    case "run.ended": {
      const header = event.data as RunHeader
      return { ...run, ...header, revision: event.revision }
    }
    case "unit.updated": {
      const units = upsertUnit(run.units, event.data as Unit)
      return { ...run, units, usage: units.reduce((sum, unit) => addUsage(sum, unit.usage), emptyUsage()), revision: event.revision }
    }
    case "interaction.pending": {
      const interaction = event.data as PendingInteraction
      const interactions = [...run.interactions.filter((candidate) => candidate.interactionId !== interaction.interactionId), interaction]
      return { ...run, interactions, waiting: true, revision: event.revision }
    }
    case "interaction.resolved": {
      const record = event.data as ResolvedInteraction
      const interactions = run.interactions.filter((candidate) => candidate.interactionId !== record.interactionId)
      const resolved = run.resolved.some((candidate) => candidate.interactionId === record.interactionId) ? run.resolved : [...run.resolved, record]
      return { ...run, interactions, resolved, waiting: interactions.length > 0, revision: event.revision }
    }
    case "activity.appended": {
      // `run.phase` emits `run.updated` and then its activity at the SAME revision; `run.log` emits only the
      // activity, at a new revision — and only that one adds to `logs` (capability audit lines never do).
      if (event.revision <= run.revision) return run
      const entry = event.data as ActivityEntry
      if (entry.kind === "capability") return { ...run, revision: event.revision }
      return { ...run, logs: [...run.logs, entry.message], revision: event.revision }
    }
    default:
      return run
  }
}

/**
 * Apply one protocol event. Events for another location are ignored; duplicates (`seq` already applied) are
 * dropped; a gap stops application and asks the caller to catch up from the last applied `seq`.
 */
export function applyEvent(state: SyncState, event: ProtocolEvent): Applied {
  if (!state.ready || event.location !== state.location) return { state, effects: [] }
  if (event.seq <= state.seq) {
    // A lower `seq` for a Run we have never seen means the service restarted and numbering began again.
    if (event.type === "run.started" && !state.runs[event.runId]) return { state, effects: [{ kind: "resync", reason: "event sequence restarted" }] }
    return { state, effects: [] }
  }
  if (event.seq > state.seq + 1) return { state, effects: [{ kind: "catchup", after: state.seq }] }

  const next: SyncState = { ...state, seq: event.seq }
  if (event.type === "resync.required") {
    const reason = (event.data as { reason?: string } | null)?.reason ?? "the service asked for a re-read"
    return { state: next, effects: [{ kind: "resync", reason }] }
  }
  if (event.type === "library.changed") {
    const entry = event.data as LibraryEntry
    const current = next.runs[entry.runId]
    if (current?.run) return { state: next, effects: [] }
    return { state: withSlot(next, entry.runId, { entry: { ...entry, live: live(entry.status) }, run: null, snapshotRevision: 0, activity: current?.activity ?? null }), effects: [] }
  }
  if (event.type === "run.started") {
    const run = event.data as Run
    const current = next.runs[run.runId]
    if (current?.run && current.run.revision >= event.revision) return { state: next, effects: [] }
    return { state: withSlot(next, run.runId, slotOf(run, current?.activity ?? [])), effects: [] }
  }

  const slot = next.runs[event.runId]
  if (!slot) return { state: next, effects: [{ kind: "hydrate", runId: event.runId }] }

  if (!slot.run) {
    // Entry depth: headers merge directly; anything that needs the Units or interactions asks for the full Run.
    if (event.type === "run.updated" || event.type === "run.ended") {
      const entry = mergeHeaderIntoEntry(slot.entry, event.data as RunHeader)
      const effects: Effect[] = event.type === "run.ended" ? [{ kind: "ended", runId: event.runId }] : []
      return { state: withSlot(next, event.runId, { ...slot, entry }), effects }
    }
    if (event.type === "activity.appended") return { state: next, effects: [] }
    const entry = event.type === "interaction.pending" ? { ...slot.entry, waiting: true } : slot.entry
    return { state: withSlot(next, event.runId, { ...slot, entry }), effects: [{ kind: "hydrate", runId: event.runId }] }
  }

  if (event.revision <= slot.snapshotRevision) return { state: next, effects: [] }

  const run = applyToRun(slot.run, event)
  const activity = event.type === "activity.appended" && slot.activity ? [...slot.activity, event.data as ActivityEntry] : slot.activity
  const effects: Effect[] = []
  if (event.type === "interaction.pending" && !slot.run.interactions.some((candidate) => candidate.interactionId === (event.data as PendingInteraction).interactionId)) {
    effects.push({ kind: "waiting", runId: event.runId, interaction: event.data as PendingInteraction })
  }
  if (event.type === "run.ended") effects.push({ kind: "ended", runId: event.runId })
  return { state: withSlot(next, event.runId, { ...slot, run, entry: entryOf(run), activity }), effects }
}

// ---------------------------------------------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------------------------------------------

/** Every Run of the location, newest first. */
export function libraryEntries(state: SyncState): LibraryEntry[] {
  return Object.values(state.runs)
    .map((slot) => slot.entry)
    .sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
}

/** The Runs a session started, newest first. */
export function sessionEntries(state: SyncState, sessionID: string): LibraryEntry[] {
  return libraryEntries(state).filter((entry) => entry.parentSessionID === sessionID)
}

/** Runs with at least one interaction waiting on a person, oldest wait first. */
export function waitingRuns(state: SyncState): Run[] {
  return Object.values(state.runs)
    .flatMap((slot) => (slot.run && slot.run.interactions.length > 0 ? [slot.run] : []))
    .sort((a, b) => (a.interactions[0]?.raisedAt ?? 0) - (b.interactions[0]?.raisedAt ?? 0))
}

export function anyLive(state: SyncState): boolean {
  return Object.values(state.runs).some((slot) => slot.entry.live)
}

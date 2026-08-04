/**
 * The run browser as a pure function of run state.
 *
 * Navigation is the part of a TUI most likely to be subtly wrong — a selection that survives a run settling,
 * a drill into a row that no longer exists, a filter that strands the cursor past the end of the list — and it
 * is also the part hardest to see in a rendered frame. So the whole drill stack lives here as a reducer over
 * plain data: `route.tsx` renders what these functions return and owns no navigation logic of its own.
 *
 * Every function is total. `reduceRoute` normalizes its result against the runs it was given, so a stack can
 * never point at a run that has gone, and a selection can never sit past the end of its level.
 */
import { formatClock, formatElapsed, formatTokens, phasePosition, phaseProgress, settledUnits } from "../progress"
import type { ControlAction } from "../control"
import type { RunSummary } from "../journal"
import type { RunSnapshot, UnitSnapshot } from "../runs"

export type RunStatusFilter = "all" | "active" | "done" | "failed"

export type RouteLevel =
  | { kind: "list"; selected: number }
  | { kind: "run"; runId: string; selected: number }
  | { kind: "unit"; runId: string; unitId: string; scroll: number }

/**
 * `restart` and `resume` are declared now, before Phases 3 and 6 wire them, so the keymap's vocabulary is
 * fixed from the first release: a key that appears later as a NEW binding teaches the user the tool changed
 * under them, where a key that was always visible-but-inert teaches them it arrived.
 */
export type RouteAction = "up" | "down" | "drill" | "back" | "filter" | "stop" | "save" | "restart" | "resume"

export interface RouteState {
  /** Never empty; `stack[0]` is always the list level. */
  stack: RouteLevel[]
  filter: RunStatusFilter
}

/**
 * One run as a row of independent COLUMNS rather than a pre-joined string.
 *
 * The row used to carry a single `detail` with everything ` · `-joined into it, which forced every surface to
 * show all of it or none — so a narrow terminal had to drop the row's meaning rather than its least important
 * column, and nothing could be aligned against anything else. Keeping the fields apart lets the renderer
 * decide, per width, what survives.
 */
export interface ListRow {
  runId: string
  glyph: "running" | "done" | "failed" | "aborted"
  workflow: string
  /** `phase 2/4` (declared) or `phase 2` (not), `""` before the first phase. */
  position: string
  /** Current phase title while live; the final status once settled. */
  phase: string
  /** Phase completion as a 0..1 ratio, or `null` when the workflow never declared its phases. */
  phaseRatio: number | null
  /** `10/10`. */
  units: string
  /** Unit completion as a 0..1 ratio; `null` when the run has launched none. */
  unitRatio: number | null
  /** `35k`, or `""` below the threshold worth showing. */
  tokens: string
  elapsed: string
  /** `14:03` — when the run started. */
  startedAt: string
  /** False for journal-only history rows (Phase 3); every row is live today. */
  live: boolean
  /** Phase 4 fills this from `RunSnapshot.interactions`. */
  pendingQuestions: number
}

export interface RunLevelRow {
  kind: "phase" | "unit" | "interaction"
  /** Phase title, unitId, or requestID — whatever addresses this row. */
  id: string
  glyph: "queued" | "running" | "ok" | "failed" | "replayed" | "question"
  indent: 0 | 1
  label: string
  detail: string
  elapsed: string
}

export interface UnitDetail {
  unitId: string
  ordinal: number
  label: string | null
  subagent: string
  phase: string | null
  status: UnitSnapshot["status"]
  sessionID: string | null
  prompt: string
  error: string | null
  elapsed: string
  /** Phase 6 sets this on replayed units; false everywhere today. */
  replayed: boolean
  /** What the unit answered. `null` while it is still running, or when it produced nothing. */
  output: UnitOutput | null
}

/**
 * A unit's answer, and which renderable should draw it.
 *
 * Structured results are re-serialized with indentation and handed to OpenTUI's `code` renderable as JSON,
 * which syntax-highlights them through tree-sitter and falls back to plain text on its own if highlighting is
 * unavailable. Text results stay text. Deciding this here keeps the view free of `JSON.parse` in a render
 * path, and makes "was this structured?" a testable question.
 */
export interface UnitOutput {
  kind: "json" | "text"
  content: string
}

export function unitOutput(output: string | undefined): UnitOutput | null {
  if (!output) return null
  try {
    return { kind: "json", content: JSON.stringify(JSON.parse(output), null, 2) }
  } catch {
    // Not JSON — show it as the text it is rather than failing to highlight it.
    return { kind: "text", content: output }
  }
}

const FILTER_ORDER: readonly RunStatusFilter[] = ["all", "active", "done", "failed"]

/** Phase 6 adds `UnitSnapshot.replayed`; read defensively so the glyph vocabulary is settled from day one. */
function isReplayed(unit: UnitSnapshot): boolean {
  return (unit as UnitSnapshot & { replayed?: unknown }).replayed === true
}

/** Phase 4 adds `RunSnapshot.interactions`; same reasoning as `replayed`. */
function pendingInteractions(run: RunSnapshot): number {
  const value = (run as RunSnapshot & { interactions?: unknown }).interactions
  return Array.isArray(value) ? value.length : 0
}

function matchesFilter(status: RunSnapshot["status"], filter: RunStatusFilter): boolean {
  if (filter === "all") return true
  if (filter === "active") return status === "running"
  if (filter === "done") return status === "done"
  // A stopped run belongs with the failures: both are "this did not finish the work", and separating them
  // would make `x` (stop) produce a run the user then cannot find under any filter.
  return status === "failed" || status === "aborted"
}

export function initialRouteState(focusRunId?: string): RouteState {
  const stack: RouteLevel[] = [{ kind: "list", selected: 0 }]
  // Entering from the sidebar means the user already chose a run; opening on the list and making them choose
  // it again would discard the only piece of intent the navigation carried.
  if (focusRunId) stack.push({ kind: "run", runId: focusRunId, selected: 0 })
  return { stack, filter: "all" }
}

/**
 * One row's worth of a run, from either source.
 *
 * A live snapshot and a journal summary carry the same figures under different names; normalizing to this
 * before building the row is what guarantees a history row fills the SAME columns rather than rendering as a
 * gappy version of the row above it.
 */
interface RowSource {
  runId: string
  workflow: string
  status: RunSnapshot["status"]
  phases: string[]
  phasesDeclared: boolean
  currentPhase: string | null
  units: number
  settled: number
  tokensSpent: number
  startedAt: number
  endedAt: number | null
  live: boolean
  pendingQuestions: number
}

function toListRow(source: RowSource, now: number): ListRow {
  const progress = phaseProgress(source)
  // Where a run STOPPED is worth a column only when it stopped early. On a success the phase position is
  // noise ("done · phase 3/3" says nothing "done" did not); on a failure it is the first thing asked.
  const stoppedEarly = source.status === "failed" || source.status === "aborted"
  return {
    runId: source.runId,
    glyph: source.status,
    workflow: source.workflow,
    position: source.status === "running" || stoppedEarly ? phasePosition(source) : "",
    // A settled run's phase title is stale news; its outcome is the thing worth the column.
    phase: source.status === "running" ? (source.currentPhase ?? "starting") : source.status,
    phaseRatio: source.status === "done" ? 1 : progress ? progress.index / progress.total : null,
    units: `${source.settled}/${source.units}`,
    unitRatio: source.units > 0 ? source.settled / source.units : null,
    tokens: source.tokensSpent > 0 ? formatTokens(source.tokensSpent) : "",
    elapsed: formatElapsed((source.endedAt ?? now) - source.startedAt),
    startedAt: formatClock(source.startedAt),
    live: source.live,
    pendingQuestions: source.pendingQuestions,
  }
}

function fromRun(run: RunSnapshot): RowSource {
  return {
    runId: run.runId,
    workflow: run.workflow,
    status: run.status,
    phases: run.phases,
    phasesDeclared: run.phasesDeclared,
    currentPhase: run.currentPhase,
    units: run.units.length,
    settled: settledUnits(run),
    tokensSpent: run.tokensSpent,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    live: true,
    pendingQuestions: pendingInteractions(run),
  }
}

function fromSummary(summary: RunSummary): RowSource {
  // A journal-only run cannot still be running. The client merges every endpoint it can see, so a run no live
  // endpoint claims is one whose engine has gone — and rendering it as `running` would pin a phantom spinner
  // to the top of the list forever, since live runs sort first.
  const status = summary.status === "running" ? "aborted" : summary.status
  return {
    runId: summary.runId,
    workflow: summary.workflow,
    status,
    phases: summary.phases,
    phasesDeclared: summary.phasesDeclared,
    currentPhase: summary.currentPhase,
    units: summary.units,
    settled: summary.settledUnits,
    tokensSpent: summary.tokensSpent,
    startedAt: summary.startedAt,
    endedAt: summary.endedAt,
    live: false,
    // A journaled interaction is settled by definition — nothing is left waiting on an engine that has gone.
    pendingQuestions: 0,
  }
}

/**
 * A run browser's list: this session's runs, newest first with live ones ahead, then journal history.
 *
 * History rows are placed AFTER every live-store row rather than interleaved by start time, so the `History`
 * divider the route draws has a single well-defined place. In practice the two orderings agree — a journal-only
 * run is one an earlier host produced — and where they disagree, "this session, then what came before" is the
 * more useful reading anyway.
 *
 * A run present in both wins as the live one: the store has a snapshot, the journal has a summary, and the
 * snapshot is the more recent of the two by construction.
 */
export function listRows(
  runs: readonly RunSnapshot[],
  history: readonly RunSummary[],
  filter: RunStatusFilter,
): ListRow[] {
  const now = Date.now()
  const live = runs
    .filter((run) => matchesFilter(run.status, filter))
    .slice()
    .sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1
      if (a.status !== "running" && b.status === "running") return 1
      return b.startedAt - a.startedAt || a.runId.localeCompare(b.runId)
    })
    .map((run) => toListRow(fromRun(run), now))

  const known = new Set(runs.map((run) => run.runId))
  const past = history
    .filter((summary) => !known.has(summary.runId))
    .map(fromSummary)
    .filter((source) => matchesFilter(source.status, filter))
    .sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
    .map((source) => toListRow(source, now))

  return [...live, ...past]
}

function unitElapsed(unit: UnitSnapshot, now: number): string {
  if (unit.startedAt === null) return ""
  return formatElapsed((unit.endedAt ?? now) - unit.startedAt)
}

function unitRow(unit: UnitSnapshot, indent: 0 | 1, now: number): RunLevelRow {
  const glyph: RunLevelRow["glyph"] =
    isReplayed(unit) && unit.status === "ok"
      ? "replayed"
      : unit.status === "queued"
        ? "queued"
        : unit.status === "running"
          ? "running"
          : unit.status === "ok"
            ? "ok"
            : "failed"
  return {
    kind: "unit",
    id: unit.unitId,
    glyph,
    indent,
    label: `#${unit.ordinal} ${unit.subagent}`,
    // The label is the author's own name for the unit; the prompt is the fallback because a unit with neither
    // is indistinguishable from its siblings, which is exactly when a user needs to tell them apart.
    detail: unit.label ?? unit.error ?? unit.prompt.split("\n")[0] ?? "",
    elapsed: unitElapsed(unit, now),
  }
}

/**
 * One run's phases with their units nested underneath.
 *
 * Nesting rather than two panes because the common case — "which phase is it in, and what is running inside
 * it" — should cost zero keystrokes; the unit level exists for the content that genuinely needs a screen.
 */
export function runRows(run: RunSnapshot): RunLevelRow[] {
  const now = Date.now()
  const rows: RunLevelRow[] = []
  const currentIndex = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1

  const byPhase = new Map<string, UnitSnapshot[]>()
  const unphased: UnitSnapshot[] = []
  for (const unit of run.units) {
    if (unit.phase !== null && run.phases.includes(unit.phase)) {
      const bucket = byPhase.get(unit.phase)
      if (bucket) bucket.push(unit)
      else byPhase.set(unit.phase, [unit])
      continue
    }
    unphased.push(unit)
  }

  run.phases.forEach((title, index) => {
    const units = byPhase.get(title) ?? []
    const settled = units.filter((unit) => unit.status === "ok" || unit.status === "failed").length
    const glyph: RunLevelRow["glyph"] = units.some((unit) => unit.status === "failed")
      ? "failed"
      : units.some((unit) => unit.status === "running" || unit.status === "queued")
        ? "running"
        : units.length > 0
          ? "ok"
          : index === currentIndex
            ? "running"
            : index < currentIndex
              ? "ok"
              : "queued"
    rows.push({
      kind: "phase",
      id: title,
      glyph,
      indent: 0,
      label: `Phase ${index + 1}/${run.phases.length}  ${title}`,
      detail: units.length > 0 ? `${settled}/${units.length}` : glyph === "queued" ? "queued" : "",
      elapsed: "",
    })
    for (const unit of units) rows.push(unitRow(unit, 1, now))
  })

  // Units the script launched outside any declared phase still have to be reachable — otherwise `x` on a
  // phaseless run has nothing to target and the browser silently omits real work.
  for (const unit of unphased) rows.push(unitRow(unit, run.phases.length > 0 ? 1 : 0, now))
  return rows
}

export function unitDetail(run: RunSnapshot, unitId: string): UnitDetail | null {
  const unit = run.units.find((candidate) => candidate.unitId === unitId)
  if (!unit) return null
  return {
    unitId: unit.unitId,
    ordinal: unit.ordinal,
    label: unit.label,
    subagent: unit.subagent,
    phase: unit.phase,
    status: unit.status,
    sessionID: unit.sessionID,
    prompt: unit.prompt,
    error: unit.error ?? null,
    elapsed: unitElapsed(unit, Date.now()),
    replayed: isReplayed(unit),
    output: unitOutput(unit.output),
  }
}

function rowCount(
  level: RouteLevel,
  runs: readonly RunSnapshot[],
  filter: RunStatusFilter,
  history: readonly RunSummary[],
): number {
  if (level.kind === "list") return listRows(runs, history, filter).length
  if (level.kind === "run") {
    const run = runs.find((candidate) => candidate.runId === level.runId)
    return run ? runRows(run).length : 0
  }
  return 0
}

function clamp(value: number, count: number): number {
  if (count <= 0) return 0
  return Math.max(0, Math.min(value, count - 1))
}

/**
 * Drop levels that no longer address anything, and pull every selection back inside its level.
 *
 * Runs come and go under the user's cursor — that is the entire point of a live browser — so normalization
 * runs on every transition rather than being something each action has to remember. Exported because the view
 * must also apply it when run state changes with no keypress at all: a run settling out of the active filter
 * moves the list under a cursor that never moved.
 *
 * `history` defaults to none because only the LIST level counts it; every deeper level addresses a live run.
 * A caller that renders history and omits it here would clamp the cursor off its own rows, so the view passes
 * it on every call.
 */
export function normalizeRoute(
  state: RouteState,
  runs: readonly RunSnapshot[],
  history: readonly RunSummary[] = [],
): RouteState {
  const stack: RouteLevel[] = [{ kind: "list", selected: 0 }]
  for (const level of state.stack) {
    if (level.kind === "list") {
      stack[0] = { kind: "list", selected: clamp(level.selected, rowCount(level, runs, state.filter, history)) }
      continue
    }
    const run = runs.find((candidate) => candidate.runId === level.runId)
    if (!run) break
    if (level.kind === "run") {
      stack.push({
        kind: "run",
        runId: level.runId,
        selected: clamp(level.selected, rowCount(level, runs, state.filter, history)),
      })
      continue
    }
    if (!run.units.some((unit) => unit.unitId === level.unitId)) break
    stack.push({ kind: "unit", runId: level.runId, unitId: level.unitId, scroll: Math.max(0, level.scroll) })
  }
  // Identity-preserving when nothing needed correcting. The view re-normalizes on every run-state change —
  // which, in a live browser, is several times a second — and a fresh object each time would invalidate every
  // memo downstream for no reason.
  return sameStack(state.stack, stack) ? state : { stack, filter: state.filter }
}

/**
 * Move the selection to an absolute index at the current level — what a mouse click means.
 *
 * Routed through the model rather than set on the view's signal directly, so a click lands under the same
 * clamping and the same level rules as `↑`/`↓`. A click on the unit level is a no-op: that level has a scroll
 * position, not a selection.
 */
export function selectIndex(state: RouteState, index: number): RouteState {
  const level = state.stack[state.stack.length - 1]
  // Phase 4's `question` level will land here too; it has its own selection, so revisit when it arrives.
  if (!level || level.kind === "unit") return state
  if (level.selected === index) return state
  const stack = state.stack.slice()
  stack[stack.length - 1] = { ...level, selected: Math.max(0, index) }
  return { stack, filter: state.filter }
}

function sameStack(a: readonly RouteLevel[], b: readonly RouteLevel[]): boolean {
  if (a.length !== b.length) return false
  return a.every((left, index) => {
    const right = b[index]
    if (!right || left.kind !== right.kind) return false
    if (left.kind === "list") return right.kind === "list" && left.selected === right.selected
    if (left.kind === "run") {
      return right.kind === "run" && left.runId === right.runId && left.selected === right.selected
    }
    return (
      right.kind === "unit" &&
      left.runId === right.runId &&
      left.unitId === right.unitId &&
      left.scroll === right.scroll
    )
  })
}

function move(
  state: RouteState,
  delta: number,
  runs: readonly RunSnapshot[],
  history: readonly RunSummary[],
): RouteState {
  const stack = [...state.stack]
  const top = stack[stack.length - 1]
  if (!top) return state
  if (top.kind === "unit") {
    stack[stack.length - 1] = { ...top, scroll: Math.max(0, top.scroll + delta) }
    return { ...state, stack }
  }
  const count = rowCount(top, runs, state.filter, history)
  stack[stack.length - 1] = { ...top, selected: clamp(top.selected + delta, count) }
  return { ...state, stack }
}

function drill(state: RouteState, runs: readonly RunSnapshot[], history: readonly RunSummary[]): RouteState {
  const top = state.stack[state.stack.length - 1]
  if (!top) return state
  if (top.kind === "list") {
    const row = listRows(runs, history, state.filter)[top.selected]
    // A history row has a summary, not a snapshot — there are no phases or units in memory to open. Drilling
    // one is a deliberate no-op rather than a level rendered from figures the model does not have.
    if (!row || !row.live) return state
    return { ...state, stack: [...state.stack, { kind: "run", runId: row.runId, selected: 0 }] }
  }
  if (top.kind === "run") {
    const run = runs.find((candidate) => candidate.runId === top.runId)
    if (!run) return state
    const row = runRows(run)[top.selected]
    // Only a unit row has a screen behind it. Drilling a phase row is a deliberate no-op rather than an
    // invented "phase detail" level nobody asked for.
    if (!row || row.kind !== "unit") return state
    return { ...state, stack: [...state.stack, { kind: "unit", runId: top.runId, unitId: row.id, scroll: 0 }] }
  }
  return state
}

export function reduceRoute(
  state: RouteState,
  action: RouteAction,
  runs: readonly RunSnapshot[],
  history: readonly RunSummary[] = [],
): RouteState {
  if (action === "up") return normalizeRoute(move(state, -1, runs, history), runs, history)
  if (action === "down") return normalizeRoute(move(state, 1, runs, history), runs, history)
  if (action === "drill") return normalizeRoute(drill(state, runs, history), runs, history)
  if (action === "back") {
    // The list level is the floor; closing the route from there is the caller's decision, not the reducer's.
    if (state.stack.length <= 1) return normalizeRoute(state, runs, history)
    return normalizeRoute({ ...state, stack: state.stack.slice(0, -1) }, runs, history)
  }
  if (action === "filter") {
    const next = FILTER_ORDER[(FILTER_ORDER.indexOf(state.filter) + 1) % FILTER_ORDER.length] as RunStatusFilter
    // Filtering re-bases the list: keeping an index that pointed into the old set would land the cursor on an
    // arbitrary run. Deeper levels survive, because a filter is about the LIST, not about what you drilled into.
    const stack = state.stack.map((level) => (level.kind === "list" ? { kind: "list" as const, selected: 0 } : level))
    return normalizeRoute({ stack, filter: next }, runs, history)
  }
  // `stop` and `save`, and Phase 6's `restart`/`resume`, act on the world rather than on navigation.
  return normalizeRoute(state, runs, history)
}

export function breadcrumb(state: RouteState, runs: readonly RunSnapshot[]): string {
  const parts = ["Workflows"]
  for (const level of state.stack) {
    if (level.kind === "list") continue
    const run = runs.find((candidate) => candidate.runId === level.runId)
    if (level.kind === "run") {
      parts.push(run?.workflow ?? level.runId)
      continue
    }
    const unit = run?.units.find((candidate) => candidate.unitId === level.unitId)
    parts.push(unit ? `#${unit.ordinal} ${unit.label ?? unit.subagent}` : level.unitId)
  }
  return parts.join(" ▸ ")
}

/**
 * The control action the current selection means, or `null` when the selection cannot answer this key.
 *
 * `stop` is contextual by design: on the list and on a phase row it means the run, on a unit row it means that
 * unit. Whether the target is actually stoppable is the registry's answer, not this function's — returning the
 * action for a settled run is what lets the surface say "that run already finished" instead of nothing at all.
 *
 * `save` is never contextual: it always addresses the RUN, because what it promotes is the run's script, and a
 * unit does not have one of its own.
 */
export function selectedControl(
  state: RouteState,
  runs: readonly RunSnapshot[],
  action: RouteAction,
  history: readonly RunSummary[] = [],
): ControlAction | null {
  if (action !== "stop" && action !== "save") return null
  const top = state.stack[state.stack.length - 1]
  if (!top) return null
  const selectedRunId =
    top.kind === "list" ? listRows(runs, history, state.filter)[top.selected]?.runId : top.runId
  if (!selectedRunId) return null
  // Deliberately reachable for a history row: saving a run whose engine is long gone is the case the journal
  // exists for.
  if (action === "save") return { action: "save.run", runId: selectedRunId }
  if (top.kind === "list") return { action: "stop.run", runId: selectedRunId }
  if (top.kind === "unit") return { action: "stop.unit", runId: top.runId, unitId: top.unitId }
  const run = runs.find((candidate) => candidate.runId === top.runId)
  if (!run) return null
  const row = runRows(run)[top.selected]
  if (row?.kind === "unit") return { action: "stop.unit", runId: top.runId, unitId: row.id }
  return { action: "stop.run", runId: top.runId }
}

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
import {
  formatClock,
  formatDay,
  formatElapsed,
  formatTokens,
  phasePosition,
  phaseProgress,
  settledUnits,
} from "../progress"
import type { ControlAction } from "../control"
import type { RunSummary } from "../journal"
import type {
  InteractionQuestion,
  InteractionRecord,
  PendingInteraction,
  ResolvedInteraction,
  RunSnapshot,
  UnitSnapshot,
} from "../runs"

export type RunStatusFilter = "all" | "active" | "done" | "failed"

export type RouteLevel =
  | { kind: "list"; selected: number }
  | { kind: "run"; runId: string; selected: number }
  | { kind: "unit"; runId: string; unitId: string; scroll: number }
  /**
   * The answer pane — a LEVEL of the drill stack, not a modal.
   *
   * Being a level is what keeps `esc` meaning the same thing here as everywhere else in the route, and what
   * lets a question be reached the same way a unit is: select the row, press ⏎. `custom` is the free-text
   * buffer, and `null` when the user is choosing from the offered options rather than typing.
   *
   * The same level renders an ANSWERED question read-only, which is why it survives the interaction leaving
   * the pending list: what you were asked and what you said is a thing to go back and look at, not something
   * that should evaporate the instant you answer it.
   *
   * `index`, `answers` and `chosen` are the half-built reply. They live HERE rather than inside the pane
   * because a half-built reply is part of where the user is: the reducer has to clamp the cursor against the
   * question actually on screen (a form's second question may offer fewer options than its first), and a set of
   * ticks a person spent thirty seconds assembling is not view state to be thrown away on a re-render.
   */
  | {
      kind: "question"
      runId: string
      requestID: string
      selected: number
      custom: string | null
      /** Which question of the form is on screen, zero-based. A form is answered one question at a time. */
      index: number
      /** The rows already collected for the questions before {@link index}, in ask order. */
      answers: string[][]
      /**
       * The option labels ticked for the question on screen, in the order they were ticked.
       *
       * Only ever non-empty on a question that declared `multiple`. A single-choice question is answered by the
       * cursor and ⏎, so a set there would be a second, contradictable way of saying the same thing.
       */
      chosen: string[]
    }

/**
 * `restart` and `resume` are declared now, before Phases 3 and 6 wire them, so the keymap's vocabulary is
 * fixed from the first release: a key that appears later as a NEW binding teaches the user the tool changed
 * under them, where a key that was always visible-but-inert teaches them it arrived.
 */
export type RouteAction =
  | "up"
  | "down"
  | "drill"
  | "back"
  | "filter"
  | "stop"
  | "save"
  /** Tick the highlighted option in or out, on a question that accepts more than one answer. */
  | "toggle"
  /**
   * Move to the next question waiting on a person, across every run.
   *
   * A navigation rather than a control, so it belongs in the reducer with the rest of them: several questions
   * can be waiting at once — the sidebar badge has always counted them globally — and reaching the second one
   * used to mean leaving the pane, walking back to the list, and drilling into a different run.
   */
  | "next"
  | "restart"
  | "resume"

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
  /**
   * The DAY the run started — `""` today, `yesterday`, `Aug 3`, `Aug 3 2025`.
   *
   * Empty for today on purpose. A column repeating the same date down every row of a list you opened today
   * carries no information, and the Visual language's honesty rule cuts both ways: a figure that says nothing
   * is dropped, not padded out. Where it earns its width is History, whose rows are by definition from earlier
   * sessions and often earlier days — which is exactly where "started at 14:03" was ambiguous before.
   */
  startedOn: string
  /** False for journal-only history rows (Phase 3); every row is live today. */
  live: boolean
  /** Phase 4 fills this from `RunSnapshot.interactions`. */
  pendingQuestions: number
}

export interface RunLevelRow {
  kind: "phase" | "unit" | "interaction"
  /** Phase title, unitId, or requestID — whatever addresses this row. */
  id: string
  /**
   * `stopped` and `answered` are not decoration.
   *
   * `stopped` exists because a phase or unit left mid-flight by a run that FAILED or was stopped must not
   * render as `running` — a settled run with a spinning phase is the browser lying about what it knows.
   * `answered` is a question that has been settled: kept, navigable, and visibly distinct from the `❓` of one
   * that is still waiting.
   */
  glyph: "queued" | "running" | "ok" | "failed" | "stopped" | "replayed" | "question" | "answered"
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
  /** What the unit answered. `null` while it is still running, when it produced nothing, or when elided. */
  output: UnitOutput | null
  /**
   * The answer exists but did not travel: `/state` elides unit outputs, and this one has to be fetched.
   *
   * The reason `output: null` alone will not do. It is already the honest rendering of two states — a unit
   * still working, and a unit that returned nothing — and "the answer is on disk" is a third. A screen that
   * cannot tell them apart shows the same empty panel for all three, which the honesty rule forbids and which
   * a user would read as a bug.
   */
  outputElided: boolean
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

/**
 * Runs the caller read out of the JOURNAL rather than off a live endpoint, by id.
 *
 * They arrive mixed into `runs` — a journaled run is a `RunSnapshot` and every lookup, row model, and pane in
 * this module already knows how to read one, so making them a second kind of thing would double every
 * signature here to describe a difference that only matters twice. It matters in exactly two places: they must
 * not appear in the LIST as live rows (their own History row is where they belong), and nothing on them is
 * stoppable, because their engine has gone. This set is what those two places consult.
 */
const NONE: ReadonlySet<string> = new Set<string>()

/** A run the caller can address, live or read back from the journal. */
function findRun(runs: readonly RunSnapshot[], runId: string): RunSnapshot | undefined {
  return runs.find((candidate) => candidate.runId === runId)
}

/** Phase 6 adds `UnitSnapshot.replayed`; read defensively so the glyph vocabulary is settled from day one. */
function isReplayed(unit: UnitSnapshot): boolean {
  return (unit as UnitSnapshot & { replayed?: unknown }).replayed === true
}

/** Tolerated as absent so a snapshot from an engine older than this reader still counts as "none waiting". */
function interactionsOf(run: RunSnapshot): readonly PendingInteraction[] {
  return Array.isArray(run.interactions) ? run.interactions : []
}

/** Same tolerance for the answered list: an engine that never recorded one is saying "none". */
export function resolvedInteractions(run: RunSnapshot): readonly ResolvedInteraction[] {
  return Array.isArray(run.resolved) ? run.resolved : []
}

/**
 * Every interaction waiting on a human, across every run, oldest first.
 *
 * Oldest first because the one that has been waiting longest is the one closest to being taken back by
 * automation — so a person working through a queue answers them in the order they will expire.
 */
export function pendingInteractions(runs: readonly RunSnapshot[]): PendingInteraction[] {
  return runs
    .flatMap((run) => interactionsOf(run))
    .slice()
    .sort((a, b) => a.raisedAt - b.raisedAt || a.requestID.localeCompare(b.requestID))
}

/** The run that owns a request, so a deep link from the sidebar can address it. */
export function runOfInteraction(runs: readonly RunSnapshot[], requestID: string): RunSnapshot | undefined {
  return runs.find((run) => interactionsOf(run).some((candidate) => candidate.requestID === requestID))
}

export function findInteraction(
  runs: readonly RunSnapshot[],
  runId: string,
  requestID: string,
): PendingInteraction | null {
  const run = runs.find((candidate) => candidate.runId === runId)
  return run ? (interactionsOf(run).find((candidate) => candidate.requestID === requestID) ?? null) : null
}

/** The answered record for a request, once nobody is waiting on it any more. */
export function findResolved(
  runs: readonly RunSnapshot[],
  runId: string,
  requestID: string,
): ResolvedInteraction | null {
  const run = runs.find((candidate) => candidate.runId === runId)
  return run ? (resolvedInteractions(run).find((candidate) => candidate.requestID === requestID) ?? null) : null
}

/**
 * Either half of a question's life, addressed the same way.
 *
 * The pane, the breadcrumb, and the reducer all want "the thing this level points at" without caring whether it
 * is still waiting — that distinction belongs in exactly one place (whether the pane accepts a keystroke), not
 * in every lookup on the way to it.
 */
export function findInteractionRecord(
  runs: readonly RunSnapshot[],
  runId: string,
  requestID: string,
): PendingInteraction | ResolvedInteraction | null {
  return findInteraction(runs, runId, requestID) ?? findResolved(runs, runId, requestID)
}

/**
 * Open the answer pane on one request, from wherever the user was.
 *
 * The stack is rebuilt rather than pushed onto, because the two ways in — a sidebar badge and a row in the run
 * browser — should land on the same stack: `list → run → question`, so `esc` walks back out through the run the
 * question belongs to instead of to wherever the user happened to be.
 */
export function openQuestion(state: RouteState, runId: string, requestID: string): RouteState {
  return {
    ...state,
    stack: [
      { kind: "list", selected: 0 },
      { kind: "run", runId, selected: 0 },
      questionLevel(runId, requestID),
    ],
  }
}

/** A question level as it is first pushed: first question, nothing collected, nothing ticked. */
export function questionLevel(runId: string, requestID: string): Extract<RouteLevel, { kind: "question" }> {
  return { kind: "question", runId, requestID, selected: 0, custom: null, index: 0, answers: [], chosen: [] }
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
    startedOn: formatDay(source.startedAt, now),
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
    pendingQuestions: interactionsOf(run).length,
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
  /** Injectable so a test that asserts "today" / "yesterday" is not a test that passes only today. */
  atTime: number = Date.now(),
  /**
   * Ids in `runs` that came from the journal, so they are rendered from their History row and not twice.
   *
   * Opening a history row loads its record and puts the snapshot into `runs` — that is what makes the run level
   * work — and without this the row would jump out of History and up into the live group the moment it was
   * opened, then jump back on the way out.
   */
  archived: ReadonlySet<string> = NONE,
): ListRow[] {
  const now = atTime
  const live = runs
    .filter((run) => !archived.has(run.runId) && matchesFilter(run.status, filter))
    .slice()
    .sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1
      if (a.status !== "running" && b.status === "running") return 1
      return b.startedAt - a.startedAt || a.runId.localeCompare(b.runId)
    })
    .map((run) => toListRow(fromRun(run), now))

  const known = new Set(runs.filter((run) => !archived.has(run.runId)).map((run) => run.runId))
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

/**
 * `runStatus` is non-null only when the run has SETTLED, and it exists for one row: a unit still marked
 * `running` in the last snapshot of a run that is over. Left alone it spins forever.
 */
function unitRow(
  unit: UnitSnapshot,
  indent: 0 | 1,
  now: number,
  runStatus: Exclude<RunSnapshot["status"], "running"> | null,
): RunLevelRow {
  const glyph: RunLevelRow["glyph"] =
    isReplayed(unit) && unit.status === "ok"
      ? "replayed"
      : unit.status === "queued"
        ? "queued"
        : unit.status === "running"
          ? (runStatus ? terminalGlyph(runStatus) : "running")
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
/**
 * Who raised an interaction, in the words the pane will repeat.
 *
 * The unit when the engine could attribute one — `#1 nested asker` is what a person recognizes, and the depth
 * is only interesting when there is no unit to name. A script's question comes from the run itself.
 */
export function interactionSource(run: RunSnapshot, interaction: InteractionRecord): string {
  if (interaction.origin === "script") return "the workflow script"
  const unit = interaction.unitId ? run.units.find((candidate) => candidate.unitId === interaction.unitId) : undefined
  if (unit) return `#${unit.ordinal} ${unit.label ?? unit.subagent}`
  return `a unit at depth ${interaction.depth}`
}

/** The chosen labels as one readable phrase — `EU`, or `EU, US` for a multi-part form. */
export function answerSummary(interaction: ResolvedInteraction): string {
  return interaction.answers
    .map((row) => row.join(", "))
    .filter((row) => row.length > 0)
    .join(" · ")
}

/**
 * What a settled interaction says in one phrase — the answer when there is one, otherwise what happened instead.
 *
 * Three distinct endings, three distinct sentences, because they are three different facts about the run. A
 * refusal used to render identically to an unobserved answer (`answer not recorded`), so a question the ladder
 * declined and a question a person answered in the host's own dialog told the reader the same nothing.
 */
export function answerOutcome(interaction: ResolvedInteraction): string {
  const chosen = answerSummary(interaction)
  if (chosen) return chosen
  if (interaction.outcome === "rejected") return "declined — the asker was refused"
  return "answer not recorded"
}

/**
 * A request that has run out of grace is still pending — but it is no longer the reader's to answer.
 *
 * The watcher keeps such a request published while its ladder works on it, because the run genuinely is still
 * blocked on it, and re-stamps `graceEndsAt` to the moment of hand-over. So an expired deadline is the one
 * field every surface already reads that means "automation has this now".
 */
export function handedToAutomation(interaction: PendingInteraction, now = Date.now()): boolean {
  return interaction.graceEndsAt !== null && interaction.graceEndsAt <= now
}

/** How long a request has been waiting, or how long is left before automation takes it. */
function interactionRow(run: RunSnapshot, interaction: PendingInteraction, now: number): RunLevelRow {
  const remaining = interaction.graceEndsAt === null ? null : Math.max(0, interaction.graceEndsAt - now)
  const handedOver = handedToAutomation(interaction, now)
  return {
    kind: "interaction",
    id: interaction.requestID,
    glyph: "question",
    indent: 0,
    label: interaction.kind === "permission" ? "Permission" : "Question",
    detail: [
      interaction.questions[0]?.header ?? "",
      interactionSource(run, interaction),
      // Said in the row rather than left to the countdown, because a bar that has finished draining looks the
      // same as one that never started.
      handedOver ? "automation has it" : "",
    ]
      .filter(Boolean)
      .join(" · "),
    elapsed:
      remaining === null || handedOver
        ? formatElapsed(now - interaction.raisedAt)
        : `${formatElapsed(remaining)} left`,
  }
}

/**
 * An answered question, as a row you can open again.
 *
 * The row says WHAT was chosen rather than leaving the glyph to carry it, per the same rule the replayed-unit
 * glyph follows: a mark nobody can decode is decoration. `Automated` rather than `Answered` when nobody chose —
 * a grace that lapsed, a ladder that grounded it, a run that ended — because those are genuinely different
 * events and merging them is how a record starts flattering itself.
 */
function resolvedRow(run: RunSnapshot, interaction: ResolvedInteraction, indent: 0 | 1): RunLevelRow {
  return {
    kind: "interaction",
    id: interaction.requestID,
    glyph: "answered",
    indent,
    // `Declined` is its own word for the same reason `Automated` is: a refused question and an answered one are
    // not the same event, and the row is where a reader decides whether to open it.
    label:
      interaction.outcome === "rejected" ? "Declined" : interaction.by === "human" ? "Answered" : "Automated",
    detail: [interaction.questions[0]?.header ?? "", answerOutcome(interaction)].filter(Boolean).join(" · "),
    elapsed: formatElapsed(Math.max(0, interaction.resolvedAt - interaction.raisedAt)),
  }
}

/**
 * The terminal glyph for a phase or unit a settled run left behind.
 *
 * `queued`/`running` on a run that is over is the browser asserting something it can see is false — the bug a
 * phase with no units of its own produced, spinning forever after `finish` because the glyph chain only ever
 * consulted `currentPhase`.
 */
function terminalGlyph(status: RunSnapshot["status"]): RunLevelRow["glyph"] {
  if (status === "done") return "ok"
  if (status === "aborted") return "stopped"
  return "failed"
}

export function runRows(run: RunSnapshot): RunLevelRow[] {
  const now = Date.now()
  const rows: RunLevelRow[] = []
  const currentIndex = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1
  const settledRun = run.status !== "running"

  // Pinned above the phases: something waiting on a person is the most actionable thing on the screen, and a
  // question buried under a forty-unit fan-out is a question nobody answers.
  for (const interaction of interactionsOf(run)) rows.push(interactionRow(run, interaction, now))

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

  // Answered questions are filed where they were RAISED: a unit's question sits directly under that unit, a
  // script's under the phase the run was in. Anything the run cannot place falls through to the tail, which is
  // where an unphased unit goes too — the alternative is a record the browser holds and never shows.
  const answersByUnit = new Map<string, ResolvedInteraction[]>()
  const answersByPhase = new Map<string, ResolvedInteraction[]>()
  const looseAnswers: ResolvedInteraction[] = []
  for (const interaction of resolvedInteractions(run)) {
    const unit = interaction.unitId
      ? run.units.find((candidate) => candidate.unitId === interaction.unitId)
      : undefined
    if (unit) {
      const bucket = answersByUnit.get(unit.unitId)
      if (bucket) bucket.push(interaction)
      else answersByUnit.set(unit.unitId, [interaction])
      continue
    }
    if (interaction.phase !== null && run.phases.includes(interaction.phase)) {
      const bucket = answersByPhase.get(interaction.phase)
      if (bucket) bucket.push(interaction)
      else answersByPhase.set(interaction.phase, [interaction])
      continue
    }
    looseAnswers.push(interaction)
  }

  const pushUnit = (unit: UnitSnapshot, indent: 0 | 1) => {
    rows.push(unitRow(unit, indent, now, run.status === "running" ? null : run.status))
    for (const answer of answersByUnit.get(unit.unitId) ?? []) rows.push(resolvedRow(run, answer, 1))
  }

  run.phases.forEach((title, index) => {
    const units = byPhase.get(title) ?? []
    const settled = units.filter((unit) => unit.status === "ok" || unit.status === "failed").length
    const unfinished = units.some((unit) => unit.status === "running" || unit.status === "queued")
    const glyph: RunLevelRow["glyph"] = units.some((unit) => unit.status === "failed")
      ? "failed"
      : unfinished
        ? settledRun
          ? terminalGlyph(run.status)
          : "running"
        : units.length > 0
          ? "ok"
          : index === currentIndex
            ? settledRun
              ? terminalGlyph(run.status)
              : "running"
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
    for (const unit of units) pushUnit(unit, 1)
    for (const answer of answersByPhase.get(title) ?? []) rows.push(resolvedRow(run, answer, 1))
  })

  // Units the script launched outside any declared phase still have to be reachable — otherwise `x` on a
  // phaseless run has nothing to target and the browser silently omits real work.
  for (const unit of unphased) pushUnit(unit, run.phases.length > 0 ? 1 : 0)
  for (const answer of looseAnswers) rows.push(resolvedRow(run, answer, run.phases.length > 0 ? 1 : 0))
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
    outputElided: unit.output === undefined && unit.outputElided === true,
  }
}

/**
 * The rows the answer pane offers for one question of a form: its options, plus the custom entry when allowed.
 *
 * A single function so the reducer's clamping and the view's rendering can never disagree about how many rows
 * there are — an off-by-one here is a cursor that selects nothing.
 */
export function questionRowCount(interaction: PendingInteraction, index = 0): number {
  const question = interaction.questions[index]
  if (!question) return 0
  return question.options.length + (question.custom ? 1 : 0)
}

function rowCount(
  level: RouteLevel,
  runs: readonly RunSnapshot[],
  filter: RunStatusFilter,
  history: readonly RunSummary[],
  archived: ReadonlySet<string>,
): number {
  if (level.kind === "list") return listRows(runs, history, filter, Date.now(), archived).length
  if (level.kind === "run") {
    const run = findRun(runs, level.runId)
    return run ? runRows(run).length : 0
  }
  if (level.kind === "question") {
    // An ANSWERED question has no selectable rows: it is a record, not a form, and a cursor on it would offer
    // a choice that has already been made.
    const interaction = findInteraction(runs, level.runId, level.requestID)
    // Against the question ON SCREEN, not against the first one: a form whose second question offers fewer
    // options than its first would otherwise leave the cursor parked past the end of the list it is drawn on.
    return interaction ? questionRowCount(interaction, level.index) : 0
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
  archived: ReadonlySet<string> = NONE,
): RouteState {
  const stack: RouteLevel[] = [{ kind: "list", selected: 0 }]
  for (const level of state.stack) {
    if (level.kind === "list") {
      stack[0] = {
        kind: "list",
        selected: clamp(level.selected, rowCount(level, runs, state.filter, history, archived)),
      }
      continue
    }
    const run = findRun(runs, level.runId)
    if (!run) {
      // A run level whose snapshot has not ARRIVED is still a legitimate place to be: drilling a History row
      // starts an on-demand read, and dropping the level while that read is in flight would bounce the user
      // back to the list every time they opened an old run. The level renders its own loading — and, if the
      // read fails, its own "not available" — which is why it has to survive to be rendered at all.
      //
      // Only the run level, and only for a run history actually knows about. A deeper level addresses units
      // that this snapshot cannot confirm exist, and an id nothing has heard of is a stale stack.
      if (level.kind !== "run" || !history.some((summary) => summary.runId === level.runId)) break
      stack.push({ kind: "run", runId: level.runId, selected: 0 })
      continue
    }
    if (level.kind === "run") {
      stack.push({
        kind: "run",
        runId: level.runId,
        selected: clamp(level.selected, rowCount(level, runs, state.filter, history, archived)),
      })
      continue
    }
    if (level.kind === "question") {
      // An answered question is not gone — it becomes a read-only record, and the level stays valid so it can
      // be opened again from its row. What the pane must never do is sit on a form nothing is listening to,
      // which is why ANSWERING navigates away immediately (`route.tsx`) rather than waiting to be evicted here.
      // A request that is neither pending nor recorded never existed as far as this snapshot knows.
      const record = findInteractionRecord(runs, level.runId, level.requestID)
      if (!record) break
      // A form cannot shrink under a user in practice; clamping anyway keeps every function here total, and
      // keeps `index` from ever addressing a question the record does not have.
      const index = clamp(level.index, record.questions.length)
      const clamped: RouteLevel = { ...level, index }
      stack.push({
        kind: "question",
        runId: level.runId,
        requestID: level.requestID,
        selected: clamp(level.selected, rowCount(clamped, runs, state.filter, history, archived)),
        custom: level.custom,
        index,
        answers: level.answers,
        chosen: level.chosen,
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
  // The unit level has a scroll position rather than a selection, so a click there means nothing. Every other
  // level — including the answer pane, whose options are clickable — moves its cursor.
  if (!level || level.kind === "unit") return state
  if (level.selected === index) return state
  const stack = state.stack.slice()
  stack[stack.length - 1] = { ...level, selected: Math.max(0, index) }
  return { stack, filter: state.filter }
}

function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((label, index) => label === b[index])
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
    if (left.kind === "question") {
      return (
        right.kind === "question" &&
        left.runId === right.runId &&
        left.requestID === right.requestID &&
        left.selected === right.selected &&
        left.custom === right.custom &&
        left.index === right.index &&
        sameLabels(left.chosen, right.chosen) &&
        left.answers.length === right.answers.length &&
        left.answers.every((row, index) => sameLabels(row, right.answers[index] ?? []))
      )
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
  archived: ReadonlySet<string>,
): RouteState {
  const stack = [...state.stack]
  const top = stack[stack.length - 1]
  if (!top) return state
  if (top.kind === "unit") {
    stack[stack.length - 1] = { ...top, scroll: Math.max(0, top.scroll + delta) }
    return { ...state, stack }
  }
  const count = rowCount(top, runs, state.filter, history, archived)
  stack[stack.length - 1] = { ...top, selected: clamp(top.selected + delta, count) }
  return { ...state, stack }
}

function drill(
  state: RouteState,
  runs: readonly RunSnapshot[],
  history: readonly RunSummary[],
  archived: ReadonlySet<string>,
): RouteState {
  const top = state.stack[state.stack.length - 1]
  if (!top) return state
  if (top.kind === "list") {
    const row = listRows(runs, history, state.filter, Date.now(), archived)[top.selected]
    if (!row) return state
    // A HISTORY row opens too. It used to be a deliberate no-op with a notice, because a `RunSummary` carries
    // no phases and no units and a level rendered from figures the model does not have would break the honesty
    // rule. The figures now exist: the caller reads the run's journaled record on demand and puts the snapshot
    // into `runs`, so this pushes the same level a live run gets. What the level must not do is offer controls
    // that cannot work — see `selectedControl`.
    return { ...state, stack: [...state.stack, { kind: "run", runId: row.runId, selected: 0 }] }
  }
  if (top.kind === "run") {
    const run = findRun(runs, top.runId)
    if (!run) return state
    const row = runRows(run)[top.selected]
    if (!row) return state
    // A question opens its pane — the same ⏎ that opens a unit, because from the user's side both are "show me
    // this row". Answered ones open too, read-only: "what did I say to this?" is exactly the question a record
    // exists to answer.
    if (row.kind === "interaction") {
      return { ...state, stack: [...state.stack, questionLevel(top.runId, row.id)] }
    }
    // Only a unit row has a screen behind it. Drilling a phase row is a deliberate no-op rather than an
    // invented "phase detail" level nobody asked for.
    if (row.kind !== "unit") return state
    return { ...state, stack: [...state.stack, { kind: "unit", runId: top.runId, unitId: row.id, scroll: 0 }] }
  }
  return state
}

/**
 * The question on screen, when it is one that accepts more than one answer.
 *
 * `multiple` has been declared by the host's `QuestionInfo`, mirrored into `InteractionQuestion`, and carried by
 * `ctx.ask` since Phase 4 — and read by nothing, so a question that asked for several answers quietly took one.
 * This is the predicate that makes it mean something: it decides whether the toggle key exists on this screen at
 * all, and whether ⏎ submits a set or the row the cursor is on.
 */
export function multiSelectQuestion(
  state: RouteState,
  runs: readonly RunSnapshot[],
): InteractionQuestion | null {
  const top = state.stack[state.stack.length - 1]
  if (top?.kind !== "question") return null
  // Deliberately the PENDING half only: a record's options are history, and offering to re-tick them would be a
  // key that appears to work and changes nothing.
  const interaction = findInteraction(runs, top.runId, top.requestID)
  const question = interaction?.questions[top.index]
  return question && question.multiple === true ? question : null
}

/**
 * Tick the highlighted option in or out of the chosen set.
 *
 * A no-op everywhere ticking would be a lie: off the question level, on a single-choice question (⏎ already
 * answers with the row the cursor is on, so a set there would be a second and contradictable way to say the same
 * thing), on the custom row (typing is the answer there), and on a record.
 *
 * The set keeps the order the user built it in rather than the order the options were offered, because that is
 * what they did and the reply carries it verbatim.
 */
export function toggleChoice(state: RouteState, runs: readonly RunSnapshot[]): RouteState {
  const question = multiSelectQuestion(state, runs)
  const top = state.stack[state.stack.length - 1]
  if (!question || top?.kind !== "question") return state
  // The custom-answer row sits past the last option, and it is not a tick target.
  const option = question.options[top.selected]
  if (!option) return state
  const chosen = top.chosen.includes(option.label)
    ? top.chosen.filter((label) => label !== option.label)
    : [...top.chosen, option.label]
  const stack = state.stack.slice()
  stack[stack.length - 1] = { ...top, chosen }
  return { ...state, stack }
}

/** How much of a question header a tab shows before it starts crowding its neighbours off the strip. */
const TAB_LABEL_MAX = 24

/**
 * One waiting question, as the tab strip above the answer pane renders it.
 *
 * Waiting questions can belong to DIFFERENT runs — the sidebar badge has counted them globally since Phase 1 —
 * so this is navigation across runs, not within one. `workflow` is filled only when the waiting set actually
 * spans more than one run: repeating the same name on every tab of a single run's form is a column that says
 * nothing, which the honesty rule already forbids elsewhere.
 */
export interface QuestionTab {
  runId: string
  requestID: string
  /** The question's own header — what the user recognizes it by — truncated to fit beside its neighbours. */
  label: string
  /** The run's workflow name, or `""` when every waiting question comes from the same run. */
  workflow: string
  current: boolean
}

function tabLabel(interaction: PendingInteraction): string {
  const header = interaction.questions[0]?.header?.trim()
  const label = header && header.length > 0 ? header : interaction.kind === "permission" ? "Permission" : "Question"
  return label.length > TAB_LABEL_MAX ? `${label.slice(0, TAB_LABEL_MAX - 1)}…` : label
}

/**
 * Every question waiting on a person, as tabs — or nothing at all.
 *
 * Empty unless the pane is open ON a pending question and there is more than one waiting: a one-tab tab strip
 * is furniture, and a strip drawn above a settled RECORD would offer to switch between things the level it sits
 * on is not one of.
 */
export function questionTabs(state: RouteState, runs: readonly RunSnapshot[]): QuestionTab[] {
  const top = state.stack[state.stack.length - 1]
  if (top?.kind !== "question") return []
  const pending = pendingInteractions(runs)
  if (pending.length < 2) return []
  const owners = pending.map((interaction) => runOfInteraction(runs, interaction.requestID))
  const acrossRuns = new Set(owners.map((run) => run?.runId)).size > 1
  const tabs = pending.map((interaction, index) => {
    const owner = owners[index]
    return {
      runId: owner?.runId ?? "",
      requestID: interaction.requestID,
      label: tabLabel(interaction),
      workflow: acrossRuns ? (owner?.workflow ?? "") : "",
      current: owner?.runId === top.runId && interaction.requestID === top.requestID,
    }
  })
  // The level addresses something that is not in the waiting set — a record being read back. Nothing to cycle.
  return tabs.some((tab) => tab.current) ? tabs : []
}

/**
 * Move to the next waiting question, wrapping.
 *
 * The stack is REBUILT through {@link openQuestion} rather than having its top swapped, because the next
 * question may belong to a different run: leaving the old run level underneath would make `esc` walk out
 * through a run the question on screen has nothing to do with.
 */
export function cycleQuestion(state: RouteState, runs: readonly RunSnapshot[], delta = 1): RouteState {
  const tabs = questionTabs(state, runs)
  if (tabs.length < 2) return state
  const at = tabs.findIndex((tab) => tab.current)
  if (at < 0) return state
  const next = tabs[(at + delta + tabs.length) % tabs.length]
  if (!next || !next.runId) return state
  return openQuestion(state, next.runId, next.requestID)
}

/**
 * Put a question's own previous answer back on the cursor, so revisiting it is reading rather than re-deciding.
 *
 * A form is answered one question at a time and can now be walked backwards, which is only worth anything if
 * arriving at question two shows what was said to question two. The row order mirrors `paneRows` — offered
 * options, then the custom entry — which is the same order {@link questionRowCount} counts.
 *
 * A free-text answer is not among the offered labels by construction, so it comes back as the buffer it was
 * typed into rather than being silently dropped.
 */
export function restoreAnswer(
  interaction: PendingInteraction,
  index: number,
  answer: readonly string[] = [],
): { selected: number; chosen: string[]; custom: string | null } {
  const blank = { selected: 0, chosen: [] as string[], custom: null }
  const question = interaction.questions[index]
  if (!question) return blank
  const labels = question.options.map((option) => option.label)
  const offered = (label: string) => labels.some((candidate) => candidate.toLowerCase() === label.toLowerCase())
  const typed = question.custom ? (answer.find((label) => !offered(label)) ?? null) : null
  if (question.multiple === true) {
    const chosen = answer.filter(offered)
    return { selected: typed === null ? 0 : labels.length, chosen, custom: typed }
  }
  const at = labels.findIndex((candidate) => candidate.toLowerCase() === (answer[0] ?? "").toLowerCase())
  if (at >= 0) return { selected: at, chosen: [], custom: null }
  if (typed !== null) return { selected: labels.length, chosen: [], custom: typed }
  return blank
}

/**
 * Step back one question of a form, or `null` when there is no earlier question to step to.
 *
 * `esc` means "one thing at a time" throughout this route — it closes the free-text field before it leaves the
 * pane, and now it walks back through a form before it leaves it either. A form that only ever went forwards
 * meant that mis-answering question one of four cost the whole form.
 */
function previousQuestion(state: RouteState, runs: readonly RunSnapshot[]): RouteState | null {
  const top = state.stack[state.stack.length - 1]
  if (top?.kind !== "question" || top.index <= 0) return null
  const interaction = findInteraction(runs, top.runId, top.requestID)
  if (!interaction) return null
  const index = top.index - 1
  const stack = state.stack.slice()
  // `answers` is kept whole rather than truncated to the cursor: walking back and forward again must not cost
  // the answers already given to the questions after this one.
  stack[stack.length - 1] = { ...top, index, ...restoreAnswer(interaction, index, top.answers[index]) }
  return { ...state, stack }
}

/**
 * Drop the top level, whatever it is. The list level is the floor.
 *
 * Separate from the `back` ACTION, and that separation is the fix for a real bug rather than tidiness. `back`
 * acquired a second meaning — "the previous question of this form" — and answering a form's LAST question
 * reused it to leave the pane. On a one-question interaction the two are the same thing, so it worked; on a
 * three-question form, submitting the answer walked the user back through the form they had just completed
 * instead of returning them to the run.
 *
 * "Go back one step" and "I am finished with this level" are different intentions. They now have different
 * functions, and only the first one knows about forms.
 */
export function popLevel(
  state: RouteState,
  runs: readonly RunSnapshot[],
  history: readonly RunSummary[] = [],
  archived: ReadonlySet<string> = NONE,
): RouteState {
  // Closing the route from the list level is the caller's decision, not the reducer's.
  if (state.stack.length <= 1) return normalizeRoute(state, runs, history, archived)
  return normalizeRoute({ ...state, stack: state.stack.slice(0, -1) }, runs, history, archived)
}

export function reduceRoute(
  state: RouteState,
  action: RouteAction,
  runs: readonly RunSnapshot[],
  history: readonly RunSummary[] = [],
  archived: ReadonlySet<string> = NONE,
): RouteState {
  const settle = (next: RouteState) => normalizeRoute(next, runs, history, archived)
  if (action === "up") return settle(move(state, -1, runs, history, archived))
  if (action === "down") return settle(move(state, 1, runs, history, archived))
  if (action === "toggle") return settle(toggleChoice(state, runs))
  if (action === "next") return settle(cycleQuestion(state, runs))
  if (action === "drill") return settle(drill(state, runs, history, archived))
  if (action === "back") {
    // Inside a multi-question form, `back` moves within the form before it leaves it.
    const stepped = previousQuestion(state, runs)
    if (stepped) return settle(stepped)
    return popLevel(state, runs, history, archived)
  }
  if (action === "filter") {
    const next = FILTER_ORDER[(FILTER_ORDER.indexOf(state.filter) + 1) % FILTER_ORDER.length] as RunStatusFilter
    // Filtering re-bases the list: keeping an index that pointed into the old set would land the cursor on an
    // arbitrary run. Deeper levels survive, because a filter is about the LIST, not about what you drilled into.
    const stack = state.stack.map((level) => (level.kind === "list" ? { kind: "list" as const, selected: 0 } : level))
    return normalizeRoute({ stack, filter: next }, runs, history, archived)
  }
  // `stop` and `save`, and Phase 6's `restart`/`resume`, act on the world rather than on navigation — they go
  // through `selectedControl` instead.
  return settle(state)
}

export function breadcrumb(
  state: RouteState,
  runs: readonly RunSnapshot[],
  archived: ReadonlySet<string> = NONE,
  /** History, so a run whose record has not arrived yet is still named rather than shown as a bare id. */
  history: readonly RunSummary[] = [],
): string {
  const parts = ["Workflows"]
  for (const level of state.stack) {
    if (level.kind === "list") continue
    const run = findRun(runs, level.runId)
    if (level.kind === "run") {
      const summary = history.find((candidate) => candidate.runId === level.runId)
      const name = run?.workflow ?? summary?.workflow ?? level.runId
      // Said in the breadcrumb because the breadcrumb is where the user reads what they are looking at, and it
      // is the same device an answered question already uses. A journaled run is a DEAD one — nothing on this
      // level can be stopped or restarted — and a level that looked identical to a live one while quietly
      // refusing its keys would read as broken. A run nothing has heard of gets its bare id and no claim: not
      // knowing where a run came from is not evidence that it is old.
      parts.push(archived.has(level.runId) || (!run && summary) ? `${name} (archived)` : name)
      continue
    }
    if (level.kind === "question") {
      const interaction = findInteractionRecord(runs, level.runId, level.requestID)
      const answered = interaction !== null && findInteraction(runs, level.runId, level.requestID) === null
      const noun = interaction?.kind === "permission" ? "permission" : "question"
      parts.push(answered ? `${noun} (answered)` : noun)
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
 * On the ANSWER PANE `stop` means hand this question to automation, which is the one place the key changes
 * verb rather than target. That is deliberate and it replaced a much worse arrangement: handing a question back
 * used to be `back`, and `back` is bound to `escape,left,h` — the universal "I want out of here". A user who
 * pressed `esc` to step out of a pane silently gave their decision away to a machine. Abandoning a question now
 * requires reaching for the same destructive key that stops a run, and `esc` does what `esc` does everywhere.
 *
 * `save` is never contextual: it always addresses the RUN, because what it promotes is the run's script, and a
 * unit does not have one of its own.
 */
export function selectedControl(
  state: RouteState,
  runs: readonly RunSnapshot[],
  action: RouteAction,
  history: readonly RunSummary[] = [],
  archived: ReadonlySet<string> = NONE,
): ControlAction | null {
  if (action !== "stop" && action !== "save") return null
  const top = state.stack[state.stack.length - 1]
  if (!top) return null
  const selectedRunId =
    top.kind === "list"
      ? listRows(runs, history, state.filter, Date.now(), archived)[top.selected]?.runId
      : top.runId
  if (!selectedRunId) return null
  // Deliberately reachable for a history row: saving a run whose engine is long gone is the case the journal
  // exists for.
  if (action === "save") return { action: "save.run", runId: selectedRunId }
  // A journaled run has no engine to talk to, so there is nothing here that `stop` could mean. Returning the
  // action anyway would send it, get `unknown-run` back, and report a failure the model could have predicted —
  // and on a level the user opened precisely BECAUSE the run is over.
  if (archived.has(selectedRunId) || (top.kind !== "list" && !findRun(runs, selectedRunId))) return null
  if (top.kind === "list") return { action: "stop.run", runId: selectedRunId }
  if (top.kind === "unit") return { action: "stop.unit", runId: top.runId, unitId: top.unitId }
  if (top.kind === "question") {
    // Only while it is still yours to give away. An answered question has nothing to hand back, and offering to
    // do it anyway would be a key that appears to work and does nothing.
    if (!findInteraction(runs, top.runId, top.requestID)) return null
    return { action: "question.reject", runId: top.runId, requestID: top.requestID }
  }
  const run = findRun(runs, top.runId)
  if (!run) return null
  const row = runRows(run)[top.selected]
  if (row?.kind === "unit") return { action: "stop.unit", runId: top.runId, unitId: row.id }
  return { action: "stop.run", runId: top.runId }
}

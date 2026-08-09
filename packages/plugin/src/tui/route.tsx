/** @jsxImportSource @opentui/solid */
/**
 * The `workflow-runs` route — a full-screen drill stack: list → run → unit.
 *
 * A single pane rather than a split, because the browser has to work at any terminal width and a detail column
 * costs about twenty of them. The run level nests active units under their phase so the common question
 * ("which phase, and what is running in it?") costs zero keystrokes; the unit level takes the whole screen,
 * because a prompt and an error are the two things that genuinely need room.
 *
 * All navigation lives in `route-model.ts`. This file renders what the model returns and owns exactly three
 * pieces of state the model cannot: the keymap layer, the pushed mode, and the last control outcome.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import { SyntaxStyle } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type Accessor } from "solid-js"
import type { ControlAction, ControlResult } from "../control"
import type { EndpointDescriptor } from "../discovery"
import type { RunSummary } from "../journal"
import { formatElapsed, formatTokens, meter, phasePosition, phaseProgress, settledUnits } from "../progress"
import type { PendingInteraction, ResolvedInteraction, RunSnapshot } from "../runs"
import type { RecordResult } from "./client"
import type { RunControlClient } from "./control"
import InteractionPane, { buildAnswer, paneRows } from "./interactions"
import {
  archiveBindings,
  FIELD_BINDINGS,
  footerGroups,
  questionBindings,
  registerKeymap,
  WORKFLOW_ROUTE,
  type FooterGroup,
  type WorkflowBinding,
} from "./keymap"
import {
  breadcrumb,
  findInteraction,
  findResolved,
  initialRouteState,
  interactionSource,
  listRows,
  multiSelectQuestion,
  normalizeRoute,
  openQuestion,
  popLevel,
  questionTabs,
  reduceRoute,
  restoreAnswer,
  runRows,
  selectedControl,
  selectIndex,
  unitDetail,
  unitOutput,
  type ListContext,
  type ListRow,
  type RunScope,
  type QuestionTab,
  type RouteLevel,
  type RouteState,
  type UnitOutput,
  type RunLevelRow,
  type UnitDetail,
} from "./route-model"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** Settled outcomes, all single-width so a row never shifts as a run or unit ends. */
const LIST_GLYPHS = { done: "✓", failed: "✗", aborted: "⊘" } as const
const ROW_GLYPHS = {
  queued: "·",
  ok: "✓",
  failed: "✗",
  // The same `⊘` the list uses for a stopped run, because it means the same thing one level down.
  stopped: "⊘",
  replayed: "↺",
  question: "❓",
  // Deliberately the tick rather than a new glyph: an answered question IS a completed thing, and its ROW says
  // `Answered`/`Automated` with the choice beside it, so the mark never has to carry the meaning alone.
  answered: "✓",
} as const

/** How much of the run's log tail the run level shows. Enough for context, never enough to become the screen. */
const RECENT_LOGS = 5

/** Cells in a phase or unit meter. Four reads as progress; more reads as a chart nobody asked for. */
const METER_WIDTH = 4

/** Shared empty set, so "nothing is archived" allocates nothing on every read. */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>()

/**
 * What survives at a given terminal width.
 *
 * Columns are dropped in order of how much meaning they carry, rather than truncating every column equally:
 * a run's identity and its phase are the point, its start clock is a nicety. `minimal` is the 80-column
 * contract the live probe holds us to.
 */
type Density = "full" | "compact" | "minimal"

function densityFor(width: number): Density {
  if (width >= 116) return "full"
  if (width >= 92) return "compact"
  return "minimal"
}

/** Right-align a numeric column so digits line up down the list instead of drifting with their width. */
function rightAlign(value: string, width: number): string {
  return value.length >= width ? value : value.padStart(width)
}

/** The settled outcome mark for a run status; `running` animates and so has none. */
function statusGlyph(status: RunSnapshot["status"]): string {
  return status === "running" ? "" : LIST_GLYPHS[status]
}

/**
 * Whether two paths name the same checkout, tolerantly.
 *
 * Equality is not enough and the reason is a real trap rather than a hypothetical: on macOS a temporary
 * directory is `/var/folders/…` to one process and `/private/var/folders/…` to another, because `/var` is a
 * symlink — so a descriptor and the host that wrote it can disagree about the path of the project they are both
 * sitting in. A suffix match covers that without a platform check or a filesystem call.
 *
 * It errs toward SHOWING a row: a false match leaves a run visible that the scope might have hidden, where a
 * false mismatch hides the user's own work and leaves them with an empty list they cannot explain.
 */
function samePath(a: string, b: string): boolean {
  const left = a.replace(/\/+$/, "")
  const right = b.replace(/\/+$/, "")
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
}

/**
 * The scope, in the words a person would use for it.
 *
 * `session` is the value; `this session` is what it means, and the difference matters in a header that also
 * says `filter all`. One is a set of runs, the other is a place — and "scope session" reads as a category where
 * "scope this session" reads as an answer to "whose runs am I looking at?".
 */
function scopeLabel(scope: RunScope): string {
  if (scope === "session") return "this session"
  if (scope === "project") return "this project"
  return "everywhere"
}

export interface WorkflowRouteProps {
  api: TuiPluginApi
  runs: Accessor<readonly RunSnapshot[]>
  /**
   * Journaled runs, from every endpoint the client can see.
   *
   * A separate accessor rather than pre-merged rows: history and live state arrive on different schedules (one
   * is a paged read, the other a stream), and merging them here keeps the ROW model the single place that
   * decides how a past run is presented next to a present one.
   */
  history?: Accessor<readonly RunSummary[]>
  control: RunControlClient
  /**
   * Read one run's whole journaled record, on demand — the other half of `/state` no longer carrying outputs.
   *
   * Two screens need it and neither can be served from live state: the unit level, whose answer was elided, and
   * a History row, whose `RunSummary` has no phases or units to render. Optional so a mounted test can assert
   * the loading and unavailable states by simply not supplying one, which is also the honest shape of a client
   * with no endpoint to ask.
   */
  record?: (runId: string) => Promise<RecordResult>
  /**
   * Which endpoint owns a run — the only way to tell whose PROJECT it is.
   *
   * A run carries the session that started it, but nothing on a snapshot says which checkout it belongs to:
   * that lives on the descriptor the client read it from. Optional, and a mounted test that omits it simply
   * scopes by session alone, which is the honest behaviour when the owner cannot be named.
   */
  endpointFor?: (runId: string) => EndpointDescriptor | undefined
  /** `{ runId }` when entered from the sidebar; `{ returnTo }` carries the session to go back to. */
  params?: Record<string, unknown>
}

/**
 * An on-demand read, as the three states a surface must be able to tell apart.
 *
 * "Loading", "not available" and "empty" are three different things to say to a user, and a single nullable
 * value says all three as one blank panel. Naming them here is what lets every consumer below render the right
 * sentence rather than the absence of one.
 */
type Fetched<T> = { status: "loading" } | { status: "ready"; value: T } | { status: "missing"; reason: string }

/** Why an on-demand read failed, in the words the screen will use. */
function recordFailure(result: Extract<RecordResult, { ok: false }>): string {
  if (result.reason === "not-found") return "this run is not in the journal"
  if (result.reason === "unknown-endpoint") return "no running opencode has this run's journal"
  return "the journal could not be read"
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** One labelled figure in the run-level stat strip. */
interface Stat {
  meter: string | null
  label: string
}

/**
 * The run's vital signs, as separate figures rather than one `·`-joined sentence.
 *
 * Each stat can then carry its own meter and its own colour, and a narrow terminal drops whole stats instead
 * of truncating the middle of a string.
 */
function runStats(run: RunSnapshot, now: number): Stat[] {
  const stats: Stat[] = []
  const progress = phaseProgress(run)
  const position = phasePosition(run)
  // `starting` is only true of a run that has not reached its first phase. A SETTLED run with no phases at all
  // was rendering "✓ done  starting", which is both contradictory and the opposite of what happened.
  const phase = run.currentPhase ?? (run.status === "running" ? "starting" : "")
  const label = [position, phase].filter(Boolean).join(" ")
  if (label) {
    stats.push({
      meter: progress ? meter(progress.index / progress.total, METER_WIDTH) : null,
      label,
    })
  }
  const settled = settledUnits(run)
  stats.push({
    meter: run.units.length > 0 ? meter(settled / run.units.length, METER_WIDTH) : null,
    label: `${settled}/${run.units.length} units`,
  })
  stats.push({ meter: null, label: formatElapsed((run.endedAt ?? now) - run.startedAt) })
  if (run.tokensSpent > 0) stats.push({ meter: null, label: `${formatTokens(run.tokensSpent)} tok` })
  return stats
}

/** What a control action did, in the words the user needs — never a bare `ok: false`. */
function controlNotice(action: ControlAction, result: ControlResult): string {
  if (action.action === "question.reply" || action.action === "permission.reply") {
    if (result.ok) return "answered"
    if (result.reason === "unknown-request") return "that question was already answered"
    return result.detail ?? "could not send that answer"
  }
  if (action.action === "question.reject") {
    if (result.ok) return "left for automation"
    if (result.reason === "unknown-request") return "that question was already answered"
    return result.detail ?? "could not hand that question back"
  }
  if (action.action === "save.run") {
    if (result.ok) return result.detail ?? "saved to .opencode/workflows"
    if (result.reason === "conflict") return result.detail ?? "that workflow is already saved"
    if (result.reason === "unknown-run") return "that run is not in the journal — there is no script to save"
    return result.detail ?? "could not save that run"
  }
  const target = action.action === "stop.run" ? "run" : "unit"
  if (result.ok) return `stopping ${target}…`
  if (result.reason === "not-running") return `that ${target} has already finished`
  if (result.reason === "unknown-unit") return "that unit is no longer running"
  if (result.reason === "unknown-run") return "that run is no longer live — its engine has gone"
  return `could not stop the ${target}`
}

export default function WorkflowRoute(props: WorkflowRouteProps) {
  const [state, setState] = createSignal<RouteState>(
    (() => {
      const runId = stringParam(props.params, "runId")
      const requestID = stringParam(props.params, "requestID")
      // `returnTo` is the session the browser was opened from — captured by `openWorkflowRoute` at the moment
      // of the navigation, because that is the only point at which the host's current route is still the one
      // being left. It is where the browser goes back to, and it is also whose runs these are.
      const base = initialRouteState(runId, stringParam(props.params, "returnTo") ? "session" : "project")
      // A deep link from the sidebar badge or the attention toast lands ON the pane, not near it: the whole
      // point of the badge is that the user already knows what they want to do.
      return runId && requestID ? openQuestion(base, runId, requestID) : base
    })(),
  )
  const [now, setNow] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  const [notice, setNotice] = createSignal<string | null>(null)

  const elapsedTimer = setInterval(() => setNow(Date.now()), 1_000)
  const spinnerTimer = setInterval(() => setFrame((value: number) => (value + 1) % SPINNER_FRAMES.length), 80)
  onCleanup(() => {
    clearInterval(elapsedTimer)
    clearInterval(spinnerTimer)
  })

  const theme = () => props.api.theme.current
  const spinner = () => SPINNER_FRAMES[frame()] as string

  /**
   * Live runs, re-read on the tick — and the tick is load-bearing, not a nicety.
   *
   * **A signal created by the run CLIENT does not invalidate this route's computations on a real host.** Reading
   * `props.runs()` returns the current value, but nothing downstream is ever notified that it changed: a memo
   * over it computes once and then serves that first value for as long as the browser stays open. Measured on a
   * live host, not deduced — with counters on the frame: nine events consumed by the client, nine publishes, the
   * accessor returning `aborted`, and the memo behind it recomputed exactly once.
   *
   * So the CLOCK is what keeps this screen honest. Every consumer of run state goes through here, which makes
   * each of them a dependent of `now()` and therefore correct within one second — the same clock the elapsed
   * column already runs on.
   *
   * This also explains a symptom recorded in Phase 4 and left unexplained: "the run level still shows the
   * question as pending for several seconds, and `running` for a run `/state` already reports as settled". It
   * was never the stream. And it is why a memo in front of this function is a trap rather than an optimisation:
   * it turned a one-second lag into a permanent freeze, where a stopped run rendered as running forever.
   */
  const liveRuns = (): readonly RunSnapshot[] => {
    now()
    return props.runs()
  }
  /** Journaled runs, on the same clock and for the same reason. */
  const history = (): readonly RunSummary[] => {
    now()
    return props.history?.() ?? []
  }

  /**
   * The one journaled run currently being read back, if any.
   *
   * A single slot rather than a cache, because a person looks at one old run at a time and the slot is what
   * makes "am I still on it?" answerable — a map would have to guess when to forget, and the wrong guess shows
   * a stale record next to a live list.
   */
  const [archive, setArchive] = createSignal<{ runId: string } & Fetched<RunSnapshot>>()
  /**
   * Unit answers fetched one at a time, keyed `runId unitId`.
   *
   * Keyed per UNIT rather than per run because that is the unit of work: `/state` elides every answer, and the
   * screen only ever displays one. Retained across a walk out and back so returning to a unit does not re-read
   * a file the process has already read.
   */
  const [answers, setAnswers] = createSignal<ReadonlyMap<string, Fetched<UnitOutput | null>>>(new Map())
  const answerKey = (runId: string, unitId: string) => `${runId} ${unitId}`

  /** Runs the journal supplied, offered to the row model exactly as live ones — see `route-model.ts`'s `NONE`. */
  const archivedIds = (): ReadonlySet<string> => {
    const slot = archive()
    return slot?.status === "ready" ? new Set([slot.runId]) : EMPTY_IDS
  }
  /**
   * Live runs plus whichever journaled run is open.
   *
   * Every lookup, row model and pane in `route-model.ts` reads a `RunSnapshot`, and a journaled run is one — so
   * merging here is what lets a dead run reuse the whole run level rather than growing a second one beside it.
   * `archivedIds` is what keeps the LIST from showing it twice.
   *
   * A plain function rather than a memo, deliberately: see {@link liveRuns}. Caching run state behind a memo is
   * how this screen stops telling the truth.
   */
  const allRuns = (): readonly RunSnapshot[] => {
    const slot = archive()
    return slot?.status === "ready" ? [...liveRuns(), slot.value] : liveRuns()
  }

  const updateAnswer = (key: string, next: Fetched<UnitOutput | null>) => {
    setAnswers((current) => new Map(current).set(key, next))
  }

  /** The session this browser belongs to, or `null` when it was opened from somewhere that has none. */
  const ownSession = (): string | null => stringParam(props.params, "returnTo") ?? null
  /** This project, as the descriptors name it. */
  const ownProject = (): string | null => props.api.state.path.worktree || props.api.state.path.directory || null

  /**
   * Which runs the scope hides — computed here, because only the surface knows whose runs these are.
   *
   * The run client scans every endpoint descriptor on the machine, which is what lets one browser watch two
   * projects at once and is also why the list needed narrowing: *"why would I want to see a run from another
   * session?"* A run's project is its owning endpoint's worktree; its session is on the snapshot — and, since
   * `RunSummary` carries it too, on a journaled row as well.
   *
   * **History obeys the scope exactly as the live rows do**, which is what the user expected and is the simpler
   * rule to hold in your head: `this session` means this session, on both halves of the list. The obvious
   * objection — that `History earlier sessions` becomes empty, in the section a journal exists to fill — is
   * answered by where the DEFAULT comes from rather than by an exception here. A browser opened from the home
   * screen has no session to scope to and opens on the project, so the "I restarted OpenCode and want my run
   * back" path is unscoped by construction; a browser opened from a session that genuinely has no earlier runs
   * says so, and says which key widens it. A rule with an exception in it would have been the worse trade: the
   * header would say `this session` while the screen showed other sessions' work.
   *
   * A summary that cannot name its session is not this session's — an engine older than this reader journals
   * none, and it is by definition from an earlier process.
   *
   * A run nothing claims is shown rather than hidden: not being able to attribute a run is not evidence that it
   * belongs to somebody else.
   */
  const outOfScope = (): ReadonlySet<string> => {
    const scope = state().scope
    if (scope === "everywhere") return EMPTY_IDS
    const project = ownProject()
    const session = ownSession()
    const elsewhere = (runId: string): boolean => {
      if (project === null) return false
      const owner = props.endpointFor?.(runId)
      return owner !== undefined && !samePath(owner.worktree, project) && !samePath(owner.directory, project)
    }
    const hidden = new Set<string>()
    for (const run of liveRuns()) {
      if (elsewhere(run.runId) || (scope === "session" && session !== null && run.parentSessionID !== session)) {
        hidden.add(run.runId)
      }
    }
    for (const summary of history()) {
      if (elsewhere(summary.runId) || (scope === "session" && session !== null && summary.parentSessionID !== session)) {
        hidden.add(summary.runId)
      }
    }
    return hidden
  }

  /** The two memberships the row model cannot work out for itself. */
  const listView = (): ListContext => ({ archived: archivedIds(), outOfScope: outOfScope() })

  const close = () => {
    const returnTo = stringParam(props.params, "returnTo")
    // Back to the session the user opened the browser from, when we know it. Home is the honest fallback: the
    // host gives a plugin no route history, and guessing a session would land them somewhere they never were.
    if (returnTo) props.api.route.navigate("session", { sessionID: returnTo })
    else props.api.route.navigate("home")
  }

  /** The question level the cursor is on, or `undefined` anywhere else in the stack. */
  const questionLevel = () => {
    const top = state().stack[state().stack.length - 1]
    return top?.kind === "question" ? top : undefined
  }
  const currentInteraction = (): PendingInteraction | null => {
    const top = questionLevel()
    return top ? findInteraction(allRuns(), top.runId, top.requestID) : null
  }
  /** The same request once it is settled — the level stays open on the record rather than evaporating. */
  const currentAnswer = (): ResolvedInteraction | null => {
    const top = questionLevel()
    if (!top || currentInteraction()) return null
    return findResolved(allRuns(), top.runId, top.requestID)
  }
  /** The question on screen when it accepts more than one answer — `null` otherwise, which is the common case. */
  const multiSelect = () => multiSelectQuestion(state(), allRuns())
  /** The other questions waiting on a person, across every run — empty unless there is more than one. */
  const tabs = createMemo<QuestionTab[]>(() => questionTabs(state(), allRuns()))
  /**
   * A tab's visible text: its question header, prefixed by the workflow only when the waiting set spans runs.
   *
   * `questionTabs` already decides that, leaving `workflow` empty when every waiting question belongs to the
   * same run — repeating one name across every tab is a label that distinguishes nothing.
   */
  const tabTitle = (tab: QuestionTab) => (tab.workflow ? `${tab.workflow} · ${tab.label}` : tab.label)
  /** Jump straight to a tab. Rebuilt through `openQuestion`, since the target may belong to another run. */
  const openTab = (tab: QuestionTab) => {
    if (tab.current || !tab.runId) return
    setState((current) => openQuestion(current, tab.runId, tab.requestID))
  }
  /**
   * Whether the free-text field currently owns the keyboard.
   *
   * A memo rather than a read at the point of use, because it drives a keymap layer: an effect reading the
   * whole route state would tear down and re-register the layer on every keystroke.
   */
  const typing = createMemo(() => {
    const top = questionLevel()
    return top !== undefined && top.custom !== null
  })

  /** Rewrite the question level in place — the only level whose state the reducer does not own outright. */
  const patchQuestion = (patch: Partial<Extract<RouteLevel, { kind: "question" }>>) => {
    setState((current) => {
      const top = current.stack[current.stack.length - 1]
      if (top?.kind !== "question") return current
      const stack = current.stack.slice()
      stack[stack.length - 1] = { ...top, ...patch }
      return { ...current, stack }
    })
  }

  /** Pop one level, the way `esc` would — used after a question stops being the user's to answer. */
  /**
   * Finish with this level and drop it — NOT the `back` action, which inside a form means "the previous
   * question". Answering the last question of a three-part form used to walk back through the form instead of
   * returning to the run, because the two intentions shared one function.
   */
  const leaveLevel = () => {
    setState((current) => popLevel(current, allRuns(), history(), listView()))
  }

  /**
   * `onOk` runs only when the control action actually landed, and it is how answering LEAVES.
   *
   * Before this, a successful reply left the user parked on the pane they had just finished with: the run's
   * stat strip above a dead form, a small `answered` notice, and nothing to do — until an unrelated event
   * happened to arrive and `normalizeRoute` evicted them. Navigating on the reply itself means the confirmation
   * appears where the user now is, which is the run the question was holding up.
   */
  const send = (target: ControlAction, onOk?: () => void) => {
    void props.control.send(target).then((result) => {
      if (result.ok) onOk?.()
      setNotice(controlNotice(target, result))
    })
  }

  /**
   * ⏎ on the answer pane: choose, advance, or send.
   *
   * Three outcomes rather than one, because a form is answered a question at a time: selecting the custom row
   * opens the field instead of submitting an empty answer, an unfinished form advances, and only the last
   * question actually replies.
   *
   * What ⏎ answers WITH depends on one field the host has always sent and this browser used to ignore. On a
   * single-choice question it is the row the cursor is on. On a `multiple` one it is the set the user ticked —
   * and an empty set is refused, because "I chose nothing" is not one of the answers on offer and sending the
   * highlighted row instead would be answering on their behalf.
   */
  const answer = () => {
    const top = questionLevel()
    const interaction = currentInteraction()
    if (!top || !interaction) return
    const question = interaction.questions[top.index]
    const rows = paneRows(question)
    const row = rows[top.selected]
    // First ⏎ on `✎ custom answer…` opens the field; the second (from inside the input) submits it.
    if (row?.custom && top.custom === null) {
      patchQuestion({ custom: "" })
      return
    }
    const typed = top.custom !== null && top.custom.trim().length > 0 ? top.custom : null
    const multiple = question?.multiple === true
    const selection = multiple ? top.chosen : row && !row.custom ? [row.label] : []
    if (selection.length === 0 && typed === null) {
      setNotice(multiple ? "choose at least one option, or type an answer" : "choose an option, or type an answer")
      return
    }
    const answers = buildAnswer(interaction, selection, typed, top.answers, top.index)
    if (top.index < interaction.questions.length - 1) {
      // The next question arrives showing whatever was said to it before — nothing at all the first time
      // through, and the answer already given when the user has stepped back and is coming forward again.
      const index = top.index + 1
      patchQuestion({ index, answers, ...restoreAnswer(interaction, index, answers[index]) })
      return
    }
    // A permission has its own action, because its reply vocabulary is the host's (`once` / `reject`) rather
    // than a set of labels the asker chose.
    if (interaction.kind === "permission") {
      const reply = answers[0]?.[0]
      if (reply !== "once" && reply !== "always" && reply !== "reject") {
        setNotice("choose `once` or `reject`")
        return
      }
      send({ action: "permission.reply", runId: top.runId, requestID: top.requestID, reply }, leaveLevel)
      return
    }
    send({ action: "question.reply", runId: top.runId, requestID: top.requestID, answers }, leaveLevel)
  }

  const dispatch = (action: WorkflowBinding["action"]) => {
    setNotice(null)
    if (action === "close") {
      close()
      return
    }
    const question = questionLevel()
    if (question) {
      // ⏎ answers.
      if (action === "drill") {
        if (currentAnswer()) {
          setNotice("this question was already answered")
          return
        }
        answer()
        return
      }
      /**
       * `esc` LEAVES. It does not decide anything.
       *
       * It used to send `question.reject` — and `back` is bound to `escape,left,h`, so the three keys everyone
       * reaches for to step out of a screen silently handed a pending decision to automation. A user pressed
       * `esc` expecting to go back and gave their answer away. Now it pops the level like every other level in
       * the browser, the question stays pending, and the badge is still there when they come back for it.
       * Inside the free-text field it closes the field first, so a mistyped answer costs one keystroke.
       */
      if (action === "back" && question.custom !== null) {
        patchQuestion({ custom: null })
        return
      }
      /**
       * `space` ticks — and does so through the reducer, not through a second key path.
       *
       * Inert while the free-text field is open, exactly as `↑`/`↓` are: the space belongs to the answer being
       * typed. The binding is registered without `preventDefault`, so the keystroke reaches the input as well —
       * this branch is what stops it ALSO ticking a row the user cannot see.
       */
      if (action === "toggle") {
        if (question.custom !== null) return
        setState((current) => reduceRoute(current, action, allRuns(), history(), listView()))
        return
      }
      // Handing a question to automation is a deliberate act and costs the deliberate key. `x` is relabelled
      // `leave for automation` on this level through the same `questionBindings` derivation that relabels ⏎.
      if (action === "stop") {
        const target = selectedControl(state(), allRuns(), action, history(), listView())
        if (!target) {
          setNotice("this question was already answered")
          return
        }
        send(target, leaveLevel)
        return
      }
      // While the field is open every printable key belongs to it; navigation would move a cursor the user
      // cannot see.
      if (question.custom !== null && (action === "up" || action === "down")) return
    }
    // `back` at the list level is the way out. Making the reducer express "leave the route" would give it a
    // dependency on the host router for one edge case; the caller already owns that.
    if (action === "back" && state().stack.length <= 1) {
      close()
      return
    }
    if (action === "stop" || action === "save") {
      const target = selectedControl(state(), allRuns(), action, history(), listView())
      if (!target) {
        // The one refusal worth a sentence. A journaled run's engine exited, possibly sessions ago, so `x` has
        // nothing to address — and a key that is dimmed in the footer AND silent when pressed reads as broken
        // rather than as unavailable.
        if (action === "stop" && onArchivedRun()) setNotice("this run is over — there is nothing left to stop")
        return
      }
      send(target)
      return
    }
    // A History row opens like any other row now: drilling it starts an on-demand read of the run's journaled
    // record, and the run level renders that record. It used to be a deliberate no-op with a notice, because a
    // `RunSummary` carries no phases and no units — the record is what turns that row into a level.
    setState((current) =>
      resumeQuestion(current, reduceRoute(current, action, allRuns(), history(), listView())),
    )
  }

  onMount(() => {
    // Mode-scoped, so `x` cannot stop a run while the user is typing in a session prompt — and, symmetrically,
    // so the prompt gets every key back the instant this route unmounts.
    onCleanup(props.api.mode.push(WORKFLOW_ROUTE))
  })

  /**
   * The keymap layer, swapped for a minimal one while the free-text answer field is open.
   *
   * The defect this fixes shipped: one layer for the whole life of the route bound `h j k l f x s q n`, and the
   * host's keymap consumes any key it matched — OpenTUI skips a focused renderable's handler on a
   * default-prevented event — so those letters never reached the answer field. `chicago` typed as nothing.
   *
   * Registering reactively is the whole mechanism: `registerLayer` returns a disposer, Solid runs the cleanup
   * before the effect re-runs, and the two layers therefore never exist at once. It is keyed on a memo so this
   * happens exactly twice per visit to the field — once opening, once closing — rather than on every keystroke.
   */
  createEffect(() => {
    onCleanup(registerKeymap(props.api, dispatch, typing() ? FIELD_BINDINGS : undefined))
  })

  // Runs settle and disappear underneath the cursor; re-normalizing on every change is what keeps a selection
  // (and a drilled-into level) from pointing at something that is no longer there — with no keypress involved.
  // A question answered by somebody else — another surface, or the watcher's grace running out — takes the pane
  // off the stack the same way, which is the payoff for making it a level.
  createEffect(() => {
    const runs = allRuns()
    const past = history()
    const view = listView()
    setState((current) => normalizeRoute(current, runs, past, view))
  })

  /**
   * The half-built answer for every question that has been on screen, kept across a pop or a tab change.
   *
   * Popping a level discards everything on it, which is right for a cursor and wrong for an answer. Someone who
   * ticked two of five options, stepped out to read the unit that asked, and came back should find their two
   * ticks; someone three questions into a five-question form should not have to start it again.
   *
   * A MAP rather than one slot, which is what cycling between waiting questions costs: with a single slot,
   * moving from question A to B and back to A would find B's draft under A's key — or, keyed by request, find
   * nothing at all. Every open question keeps its own.
   *
   * A plain variable rather than a signal: nothing renders from it. It is the memory of a level, and the level
   * itself is what the pane reads.
   */
  const drafts = new Map<string, Extract<RouteLevel, { kind: "question" }>>()
  const draftKey = (level: { runId: string; requestID: string }) => `${level.runId} ${level.requestID}`
  createEffect(() => {
    const level = questionLevel()
    if (level) drafts.set(draftKey(level), level)
  })

  /**
   * Put the retained answer back on a question level the user is RE-entering.
   *
   * The entry test is what makes this safe: applied on every transition it would also fire on `↓`, restoring the
   * level the user just moved off and pinning the cursor in place.
   */
  const resumeQuestion = (from: RouteState, next: RouteState): RouteState => {
    const top = next.stack[next.stack.length - 1]
    if (top?.kind !== "question") return next
    const before = from.stack[from.stack.length - 1]
    if (before?.kind === "question" && before.requestID === top.requestID) return next
    const kept = drafts.get(draftKey(top))
    if (!kept) return next
    // Only while the question is still the user's to answer. Re-opening a RECORD should show it from the top:
    // there is no half-built reply left to resume, and landing on the last page of a form nobody is filling in
    // any more would be resuming a session rather than reading a record.
    if (!findInteraction(allRuns(), top.runId, top.requestID)) return next
    const stack = next.stack.slice()
    stack[stack.length - 1] = kept
    return { ...next, stack }
  }

  const level = createMemo(() => state().stack[state().stack.length - 1])
  /**
   * Whether the level on screen belongs to a run the store no longer holds — one read back from the journal.
   *
   * Asked of the LIVE runs rather than of `archivedIds`, so it is true for the whole of the read and not only
   * once it lands: a run whose engine has gone cannot be stopped while its record is loading either, and a
   * footer that only dimmed `x` at the end would offer it during exactly the seconds a user is most likely to
   * press it.
   */
  const onArchivedRun = createMemo(() => {
    const current = level()
    if (!current || current.kind === "list") return false
    return !liveRuns().some((run) => run.runId === current.runId)
  })
  const crumb = createMemo(() => breadcrumb(state(), allRuns(), listView(), history()))
  const crumbSegments = createMemo(() => crumb().split(" ▸ "))
  const rows = createMemo<ListRow[]>(() => {
    // The tick re-renders elapsed, and dates the rows: `listRows` decides `today` / `yesterday` against it.
    return listRows(allRuns(), history(), state().filter, now(), listView())
  })
  /** Index of the first journal-only row, so the `History` divider is drawn exactly once and in one place. */
  const firstHistoryRow = createMemo(() => rows().findIndex((row) => !row.live))
  /** How many runs the scope is holding back — the difference between "nothing here" and "nothing yet". */
  const hiddenByScope = createMemo(() => outOfScope().size)
  const activeRun = createMemo<RunSnapshot | undefined>(() => {
    const current = level()
    if (!current || current.kind === "list") return undefined
    // `allRuns`, not `props.runs`: a run opened out of History has no live snapshot, and the record read back
    // from the journal IS a `RunSnapshot` — which is what lets a dead run reuse this whole level rather than
    // grow a second one beside it.
    return allRuns().find((run) => run.runId === current.runId)
  })
  const detailRows = createMemo<RunLevelRow[]>(() => {
    now()
    const run = activeRun()
    return run ? runRows(run) : []
  })
  const unit = createMemo(() => {
    const current = level()
    const run = activeRun()
    if (!run || current?.kind !== "unit") return null
    return unitDetail(run, current.unitId)
  })

  /**
   * Read a journaled run back the moment the user opens one, and forget it the moment they leave.
   *
   * This is the wire that makes a History row a place you can go. `normalizeRoute` already keeps a run level
   * alive for a run history knows about but the store does not — precisely so the read has somewhere to land —
   * and everything below this line renders a `RunSnapshot` without caring which of the two it came from.
   *
   * `reading` is a plain variable rather than a signal on purpose. It is not state anything renders; it is the
   * answer to "is this still the run being read?", and it has to be readable from inside the effect without the
   * effect depending on it, which would loop the moment the record landed.
   */
  let reading: string | null = null
  createEffect(() => {
    const current = level()
    const runId = current && current.kind !== "list" ? current.runId : null
    const live = runId !== null && liveRuns().some((run) => run.runId === runId)
    if (runId === null || live) {
      // Back on the list, or on a run the store holds after all. Dropping the slot is what puts the run back
      // under `History` where it belongs instead of leaving it pinned among this session's runs.
      if (reading !== null) {
        reading = null
        setArchive(undefined)
      }
      return
    }
    if (reading === runId) return
    reading = runId
    const read = props.record
    if (!read) {
      setArchive({ runId, status: "missing", reason: "this browser has no journal reader" })
      return
    }
    setArchive({ runId, status: "loading" })
    void read(runId).then((result) => {
      // The user can walk out while a read is in flight, and a record for a run nobody is looking at any more
      // is not news — it is a stale panel about to appear over whatever they moved to.
      if (reading !== runId) return
      setArchive(
        result.ok
          ? { runId, status: "ready", value: result.record.run }
          : { runId, status: "missing", reason: recordFailure(result) },
      )
    })
  })

  /** What to say on a run level whose record has not arrived — or cannot. */
  const archiveNote = createMemo<{ text: string; failed: boolean } | null>(() => {
    const current = level()
    if (current?.kind !== "run") return null
    const slot = archive()
    if (!slot || slot.runId !== current.runId) return null
    if (slot.status === "loading") return { text: "Reading this run from the journal…", failed: false }
    if (slot.status === "missing") return { text: slot.reason, failed: true }
    return null
  })

  /**
   * The answer this unit gave, wherever it has to be read from.
   *
   * `/state` carries no unit outputs — it is a bootstrap payload re-sent whole on every reconnect, and a
   * session's worth of research prose has no business riding in it — so a settled unit's answer is on disk and
   * the screen showing one fetches the one it is showing. A unit that settled while this browser was watching
   * still has its answer from the event that carried it, and is never re-read.
   */
  const answerSlot = createMemo<Fetched<UnitOutput | null> | null>(() => {
    const current = level()
    const detail = unit()
    if (current?.kind !== "unit" || !detail) return null
    if (detail.output) return { status: "ready", value: detail.output }
    if (!detail.outputElided) return { status: "ready", value: null }
    return answers().get(answerKey(current.runId, current.unitId)) ?? { status: "loading" }
  })
  const answerOutput = createMemo<UnitOutput | null>(() => {
    const slot = answerSlot()
    return slot?.status === "ready" ? slot.value : null
  })
  /**
   * The sentence that stands in for an answer, and there are four of them for four different facts.
   *
   * "Still working", "returned nothing", "being read" and "could not be read" are not the same thing to a
   * person, and one blank panel says all four — which is the ambiguity the honesty rule exists to forbid.
   */
  const answerNote = createMemo<string | null>(() => {
    const detail = unit()
    const slot = answerSlot()
    if (!detail || !slot || answerOutput() || detail.error !== null) return null
    if (slot.status === "loading") return "Reading this unit's answer from the journal…"
    if (slot.status === "missing") return slot.reason
    return detail.status === "ok" ? "This unit returned nothing." : "Waiting for this unit to answer…"
  })

  /** Fetch the one elided answer on screen. Keyed per unit, because that is the unit of work. */
  createEffect(() => {
    const current = level()
    const detail = unit()
    if (current?.kind !== "unit" || detail?.outputElided !== true) return
    const key = answerKey(current.runId, current.unitId)
    // Untracked: the map is this effect's own output, and reading it reactively would re-run the effect on
    // every answer any unit ever fetched.
    if (untrack(answers).has(key)) return
    const read = props.record
    if (!read) {
      updateAnswer(key, { status: "missing", reason: "this browser has no journal reader" })
      return
    }
    const unitId = current.unitId
    updateAnswer(key, { status: "loading" })
    void read(current.runId).then((result) => {
      if (!result.ok) {
        updateAnswer(key, { status: "missing", reason: recordFailure(result) })
        return
      }
      const output = unitOutput(result.record.run.units.find((candidate) => candidate.unitId === unitId)?.output)
      // The snapshot said this unit HAD an answer, so a record without one is a read that failed rather than a
      // unit that stayed quiet — and saying "returned nothing" here would be reporting the journal's contents
      // on the strength of a gap in them.
      updateAnswer(
        key,
        output ? { status: "ready", value: output } : { status: "missing", reason: "this answer is not in the journal" },
      )
    })
  })

  let body: ScrollBoxRenderable | undefined
  createEffect(() => {
    const current = level()
    if (current?.kind === "unit" && body) body.scrollTop = current.scroll
  })

  /**
   * Width of the workflow-name column, so every row's detail starts at the same place.
   *
   * Sized to the widest name actually on screen rather than a constant: the list is usually one or two runs
   * with short names, and a fixed column would strand their details in the middle of a 130-column route. The
   * cap keeps one pathological name from pushing every other row's detail off the right edge — past it, that
   * row alone runs long and the rest stay aligned with each other.
   */
  const NAME_COLUMN_MAX = 28
  const nameColumn = createMemo(() =>
    Math.min(NAME_COLUMN_MAX, Math.max(0, ...rows().map((row) => row.workflow.length))),
  )

  const dimensions = useTerminalDimensions()
  const density = createMemo<Density>(() => densityFor(dimensions().width))

  /**
   * Highlighting for a unit's structured answer, mapped from the host theme rather than hardcoded.
   *
   * Rebuilt when the theme changes, so a JSON answer belongs to the same palette as everything around it —
   * keys in accent, the same colour the run browser uses for every other identifier.
   */
  const syntaxStyle = createMemo(() =>
    SyntaxStyle.fromStyles({
      default: { fg: theme().text },
      property: { fg: theme().accent, bold: true },
      string: { fg: theme().success },
      number: { fg: theme().warning },
      constant: { fg: theme().info },
      punctuation: { fg: theme().borderSubtle },
      "punctuation.bracket": { fg: theme().borderSubtle },
      "punctuation.delimiter": { fg: theme().borderSubtle },
    }),
  )

  /**
   * Footer hints, trimmed to what the width can hold.
   *
   * Unwired keys stay, dimmed — the vocabulary must not shift when Phases 3 and 6 wire them — but a footer
   * that runs off the right edge teaches nothing, so the least-essential hints go first at narrow widths.
   */
  const footer = createMemo<FooterGroup[]>(() => {
    // The SAME footer bar, the same keys, in the same positions — only the words change, because on the answer
    // pane `⏎` means answer and `esc` means leave for automation. A pane with a footer of its own would teach
    // the user that this screen is a different program.
    //
    // `space toggle` and `n next question` are the hints that appear and disappear, because they are the keys
    // whose meaning does not survive leaving the screen they belong to: on a single-choice question there is
    // nothing to tick, and with one question waiting there is nothing to cycle to.
    //
    // While the field is open the footer shrinks to the two keys that still work, because every other key in
    // the table is now a character being typed. A footer offering `f filter` to someone whose `f` lands in
    // their answer is worse than no footer at all.
    // On a run read back from the journal the destructive keys are DIMMED rather than dropped, for the same
    // reason `r` has always been dimmed: a key that vanishes on some screens teaches the user the tool is
    // inconsistent, where a key that is visibly unavailable teaches them why. `s` stays live — saving a run
    // whose engine is long gone is precisely the case the journal exists for.
    const question = questionLevel()
    const groups = footerGroups(
      typing()
        ? FIELD_BINDINGS
        : question
          ? questionBindings({
              multiple: multiSelect() !== null,
              previous: question.index > 0,
              queued: tabs().length > 1,
            })
          : onArchivedRun()
            ? archiveBindings()
            : undefined,
    )
    if (density() === "full") return groups
    const dropped = density() === "minimal" ? ["restart", "save", "close"] : ["close"]
    return groups.filter((group) => !dropped.includes(group.label))
  })

  const statusColor = (status: RunSnapshot["status"]) => {
    if (status === "running") return theme().accent
    if (status === "failed") return theme().error
    if (status === "aborted") return theme().warning
    return theme().success
  }
  const unitStatusColor = (status: UnitDetail["status"]) => {
    if (status === "running") return theme().accent
    if (status === "failed") return theme().error
    if (status === "ok") return theme().success
    return theme().textMuted
  }

  const listGlyph = (row: ListRow) => (row.glyph === "running" ? spinner() : LIST_GLYPHS[row.glyph])
  const listGlyphColor = (row: ListRow) => {
    if (row.glyph === "running") return theme().accent
    if (row.glyph === "failed") return theme().error
    if (row.glyph === "aborted") return theme().warning
    return theme().success
  }
  const rowGlyph = (row: RunLevelRow) => (row.glyph === "running" ? spinner() : ROW_GLYPHS[row.glyph])
  const rowGlyphColor = (row: RunLevelRow) => {
    if (row.glyph === "running") return theme().accent
    if (row.glyph === "failed") return theme().error
    if (row.glyph === "stopped") return theme().warning
    if (row.glyph === "ok" || row.glyph === "replayed") return theme().success
    // A waiting question is the one row on this screen that is asking for something.
    if (row.glyph === "question") return theme().warning
    // An answered one is settled news: the same tick as a finished unit, in `info` rather than `success`, so
    // the two read as different KINDS of done rather than as the same one.
    if (row.glyph === "answered") return theme().info
    return theme().textMuted
  }
  const selectedIndex = () => {
    const current = level()
    return current && current.kind !== "unit" ? current.selected : -1
  }

  /**
   * A row the cursor is on: filled, not merely marked, so the eye finds it without hunting for a caret.
   *
   * The FOREGROUND deliberately does not change with selection, beyond promoting the name to the accent.
   * Pairing a selection background with `selectedListItemText` looks like the obvious move and is a trap —
   * that token is cut to sit on the host's own selection fill, and against any other background it can land
   * invisible. It did: on a real host every selected cell rendered blank, leaving a row that was nothing but
   * its status glyph and its meter, while the mounted tests passed on a fake theme whose tokens happened to
   * contrast. Reusing the same foregrounds the unselected row uses cannot fail that way in any theme.
   */
  const rowBackground = (index: number) => (index === selectedIndex() ? theme().backgroundElement : undefined)
  const rowText = (index: number) => (index === selectedIndex() ? theme().accent : theme().text)
  const rowMuted = (_index: number) => theme().textMuted
  /**
   * A history row is dimmed, never abbreviated.
   *
   * It fills every column a live row does — meter, units, tokens, elapsed, start clock — because a row that
   * could only fill half of them reads as a broken version of the row above it rather than as an older one.
   * Only the NAME changes weight, which is enough to separate the two without taking anything away.
   */
  const rowName = (row: ListRow, index: number) =>
    index === selectedIndex() ? theme().accent : row.live ? theme().text : theme().textMuted

  /** Click to select; click the selected row again to open it — the same two steps the keyboard takes. */
  const clickRow = (index: number) => {
    if (index === selectedIndex()) dispatch("drill")
    else setState((current) => selectIndex(current, index))
  }

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme().background}>
      {/* Header bar — a surface rather than a line of text, so the route reads as a screen of its own. */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme().backgroundPanel}
      >
        {/* No flex `gap` anywhere in this bar. The separators are IN THE TEXT — ` › ` between segments, two
            spaces before a figure — so there is exactly one source of horizontal spacing and it cannot come out
            doubled in one terminal and absent in another. A user reported reading `Workflows›asks-the-human`
            and `⠦ running▰▰▰▱phase 2/3` in their own emulator, which a gap-based strip can produce and a
            text-based one cannot. */}
        <box flexDirection="row" flexShrink={1}>
          <For each={crumbSegments()}>
            {(segment: string, index) => (
              <box flexDirection="row" flexShrink={index() === 0 ? 0 : 1}>
                <Show when={index() > 0}>
                  <text flexShrink={0} fg={theme().borderSubtle}>
                    {" › "}
                  </text>
                </Show>
                <text
                  flexShrink={1}
                  fg={index() === crumbSegments().length - 1 ? theme().accent : theme().textMuted}
                >
                  {index() === crumbSegments().length - 1 ? <b>{segment}</b> : segment}
                </text>
              </box>
            )}
          </For>
        </box>
        {/* Two dimensions, named in the order they narrow: whose runs these are, then what state they are in.
            The scope is never hidden at any width — a list that is quietly hiding rows has to say so, which is
            the same honesty rule that forbids printing a denominator the system does not know. */}
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme().textMuted}>{"scope "}</text>
          <text fg={theme().info}>
            <b>{scopeLabel(state().scope)}</b>
          </text>
          <text fg={theme().textMuted}>{"  filter "}</text>
          <text fg={theme().info}>
            <b>{state().filter}</b>
          </text>
        </box>
      </box>

      {/* Stat strip — the active run's vital signs, each figure with its own meter. */}
      <Show when={activeRun()}>
        {(run: Accessor<RunSnapshot>) => (
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme().backgroundElement}
          >
            <text flexShrink={0} fg={statusColor(run().status)}>
              <b>{run().status === "running" ? `${spinner()} running` : `${statusGlyph(run().status)} ${run().status}`}</b>
            </text>
            {/* Two spaces everywhere, including after a meter — carried in the text rather than by a flex
                `gap`, for the reason on the header bar above.

                A meter used to get ONE space, on the theory that a bar belongs closer to the label it measures
                than to its neighbours. On a real terminal it got none: `▰`/`▱` are East-Asian AMBIGUOUS width,
                so a font may draw them wider than the single cell the layout budgets, and the overhang paints
                straight over the following space. The user saw `▰▰▰▰phase 3/3 finish` while the string they
                copied out of the same screen had the space in it — ink, not content.

                Two spaces survives an overhang of one cell, and the tighter rule was not worth a separator that
                exists only in the buffer. */}
            <For each={runStats(run(), now())}>
              {(stat: Stat) => (
                <box flexDirection="row" flexShrink={1}>
                  <Show when={stat.meter}>
                    {(bar: Accessor<string>) => (
                      <text flexShrink={0} fg={theme().accent}>
                        {`  ${bar()}`}
                      </text>
                    )}
                  </Show>
                  <text flexShrink={1} fg={theme().textMuted}>
                    {`  ${stat.label}`}
                  </text>
                </box>
              )}
            </For>
          </box>
        )}
      </Show>

      <box flexGrow={1} flexDirection="column" paddingTop={1} paddingLeft={1} paddingRight={1}>
        <Show when={level()?.kind === "list"}>
          <box flexDirection="column">
            <Show when={rows().length === 0}>
              {/* An empty list has two causes and they need different sentences. "You have not run anything"
                  sends the user to the tool; "everything is hidden by the scope you are in" sends them to a
                  key. Saying the first when the second is true is how a filter gets blamed on the product. */}
              <box flexDirection="column" paddingTop={1} gap={1}>
                <Show
                  when={hiddenByScope() > 0}
                  fallback={
                    <>
                      <text fg={theme().textMuted}>No workflow runs to show.</text>
                      <text fg={theme().borderSubtle}>Start one with the `workflow` tool, then come back.</text>
                    </>
                  }
                >
                  <text fg={theme().textMuted}>
                    {`No runs in ${scopeLabel(state().scope)} — ${hiddenByScope()} elsewhere.`}
                  </text>
                  <text fg={theme().borderSubtle}>Press `w` to widen the scope.</text>
                </Show>
              </box>
            </Show>
            <For each={rows()}>
              {(row: ListRow, index) => (
                <box flexDirection="column">
                  {/* Drawn once, above the first journal-only row: everything below it outlived its engine. */}
                  <Show when={index() === firstHistoryRow()}>
                    <box flexDirection="row" marginTop={index() === 0 ? 0 : 1}>
                      <text fg={theme().textMuted}>
                        <b>History</b>
                      </text>
                      <text fg={theme().borderSubtle}>{" earlier sessions"}</text>
                    </box>
                  </Show>
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={rowBackground(index())}
                    onMouseUp={() => clickRow(index())}
                  >
                    <box flexDirection="row" flexShrink={1}>
                      <text flexShrink={0} fg={listGlyphColor(row)}>
                        {` ${listGlyph(row)}`}
                      </text>
                      <text flexShrink={0} fg={rowName(row, index())}>
                        <b>{` ${row.workflow.padEnd(nameColumn())}`}</b>
                      </text>
                      <Show when={density() !== "minimal" && row.phaseRatio !== null}>
                        <text flexShrink={0} fg={theme().accent}>
                          {` ${meter(row.phaseRatio ?? 0, METER_WIDTH)}`}
                        </text>
                      </Show>
                      {/* Two spaces, not one: the meter before it can overhang its cell. See the stat strip. */}
                      <text flexShrink={1} fg={rowMuted(index())}>
                        {`  ${[row.position, row.phase].filter(Boolean).join(" ")}`}
                      </text>
                    </box>
                    <box flexDirection="row" flexShrink={0}>
                      <text flexShrink={0} fg={rowMuted(index())}>
                        {`  ${rightAlign(`${row.units} units`, 12)}`}
                      </text>
                      <Show when={density() === "full"}>
                        <text flexShrink={0} fg={rowMuted(index())}>
                          {`  ${rightAlign(row.tokens ? `${row.tokens} tok` : "", 9)}`}
                        </text>
                      </Show>
                      <text flexShrink={0} fg={rowMuted(index())}>
                        {`  ${rightAlign(row.elapsed, 7)}`}
                      </text>
                      {/* Day then clock, as one "when". The day is blank for today, so a list of today's runs
                          looks exactly as it did before and History is where the column fills in. */}
                      <Show when={density() !== "minimal"}>
                        <text flexShrink={0} fg={theme().borderSubtle}>
                          {`  ${rightAlign(row.startedOn, 11)}  ${rightAlign(row.startedAt, 5)}`}
                        </text>
                      </Show>
                    </box>
                  </box>
                </box>
              )}
            </For>
          </box>
        </Show>

        <Show when={level()?.kind === "run"}>
          <box flexDirection="column">
            {/* An old run has to be read off disk before it can be shown, and the read can fail. Both are said
                out loud: a level that renders an empty run while it waits is a level that looks broken. */}
            <Show when={archiveNote()}>
              {(note: Accessor<{ text: string; failed: boolean }>) => (
                <text fg={note().failed ? theme().warning : theme().textMuted}>{note().text}</text>
              )}
            </Show>
            <Show when={activeRun() && detailRows().length === 0}>
              <text fg={theme().textMuted}>This run has not launched a unit yet.</text>
            </Show>
            <For each={detailRows()}>
              {(row: RunLevelRow, index) => (
                <box
                  flexDirection="row"
                  justifyContent="space-between"
                  backgroundColor={rowBackground(index())}
                  onMouseUp={() => clickRow(index())}
                >
                  <box flexDirection="row" flexShrink={1}>
                    <text flexShrink={0} fg={rowGlyphColor(row)}>
                      {`${row.indent === 1 ? "   " : " "}${rowGlyph(row)}`}
                    </text>
                    <text flexShrink={0} fg={row.indent === 0 ? rowText(index()) : rowMuted(index())}>
                      {row.indent === 0 ? <b>{` ${row.label}`}</b> : ` ${row.label}`}
                    </text>
                    <text flexShrink={1} fg={rowMuted(index())}>
                      {row.detail ? ` ${row.detail}` : ""}
                    </text>
                  </box>
                  <text flexShrink={0} fg={rowMuted(index())}>
                    {`  ${rightAlign(row.elapsed, 7)}`}
                  </text>
                </box>
              )}
            </For>
            <Show when={(activeRun()?.logs.length ?? 0) > 0}>
              <box
                flexDirection="column"
                marginTop={1}
                paddingLeft={1}
                paddingRight={1}
                border
                borderStyle="rounded"
                borderColor={theme().borderSubtle}
                title=" Recent "
                titleAlignment="left"
              >
                <For each={(activeRun()?.logs ?? []).slice(-RECENT_LOGS)}>
                  {(log: string) => <text fg={theme().textMuted}>{log}</text>}
                </For>
              </box>
            </Show>
          </box>
        </Show>

        <Show when={level()?.kind === "question"}>
          <box flexDirection="column" gap={1}>
            {/* The other questions waiting on a person, across every run — rendered only when there is more
                than one, because a one-tab tab strip is furniture. Separators live in the text, and the current
                tab is FILLED rather than marked, exactly like a selected row anywhere else in the browser. */}
            <Show when={tabs().length > 1}>
              <box flexDirection="row">
                <For each={tabs()}>
                  {(tab: QuestionTab, index) => (
                    <box flexDirection="row" flexShrink={1}>
                      <Show when={index() > 0}>
                        <text flexShrink={0} fg={theme().borderSubtle}>
                          {"  "}
                        </text>
                      </Show>
                      <box
                        flexDirection="row"
                        flexShrink={1}
                        backgroundColor={tab.current ? theme().backgroundElement : undefined}
                        onMouseUp={() => openTab(tab)}
                      >
                        <text flexShrink={1} fg={tab.current ? theme().accent : theme().textMuted}>
                          {tab.current ? <b>{` ${tabTitle(tab)} `}</b> : ` ${tabTitle(tab)} `}
                        </text>
                      </box>
                    </box>
                  )}
                </For>
              </box>
            </Show>
            <InteractionPane
              interaction={() => currentInteraction() ?? undefined}
              answered={() => currentAnswer() ?? undefined}
              theme={props.api.theme}
              now={now}
              selected={() => questionLevel()?.selected ?? 0}
              custom={() => questionLevel()?.custom ?? null}
              index={() => questionLevel()?.index ?? 0}
              chosen={() => questionLevel()?.chosen ?? []}
              source={() => {
                const run = activeRun()
                const current = currentInteraction() ?? currentAnswer()
                return run && current ? interactionSource(run, current) : ""
              }}
              onSelect={(index: number) => {
                // A record has nothing to choose; a click on one is a click on a page, not a button.
                if (currentAnswer()) return
                // Click to select, click again to answer — the same two steps the keyboard takes everywhere.
                if (index === (questionLevel()?.selected ?? -1)) answer()
                else patchQuestion({ selected: index })
              }}
              onCustomInput={(value: string) => patchQuestion({ custom: value })}
              onAnswer={answer}
            />
          </box>
        </Show>

        <Show when={level()?.kind === "unit"}>
          <scrollbox ref={body} flexGrow={1} scrollY stickyScroll={false}>
            <Show when={unit()}>
              {(detail: Accessor<UnitDetail>) => (
                <box flexDirection="column" gap={1}>
                  <box flexDirection="row">
                    <text flexShrink={1} fg={theme().accent}>
                      <b>{`#${detail().ordinal} ${detail().label ?? detail().subagent}`}</b>
                    </text>
                    <text flexShrink={0} fg={unitStatusColor(detail().status)}>
                      {`  ${detail().status}`}
                    </text>
                    <Show when={detail().elapsed}>
                      <text flexShrink={0} fg={theme().textMuted}>
                        {`  ${detail().elapsed}`}
                      </text>
                    </Show>
                  </box>
                  <box flexDirection="row">
                    <text fg={theme().textMuted}>{`subagent ${detail().subagent}`}</text>
                    <text fg={theme().textMuted}>{`  phase ${detail().phase ?? "(none)"}`}</text>
                    <text fg={theme().info}>{`  session ${detail().sessionID ?? "(none)"}`}</text>
                  </box>
                  <box
                    flexDirection="column"
                    paddingLeft={1}
                    paddingRight={1}
                    border
                    borderStyle="rounded"
                    borderColor={theme().borderSubtle}
                    title=" Prompt "
                    titleAlignment="left"
                  >
                    <text fg={theme().textMuted} wrapMode="word">
                      {detail().prompt}
                    </text>
                  </box>

                  {/* What it answered. The question was already on screen; this is the half that was missing.
                      Usually read back from the journal — see `answerSlot`. */}
                  <Show when={answerOutput()}>
                    {(output: Accessor<UnitOutput>) => (
                      <box
                        flexDirection="column"
                        paddingLeft={1}
                        paddingRight={1}
                        border
                        borderStyle="rounded"
                        borderColor={theme().borderSubtle}
                        title=" Answer "
                        titleAlignment="left"
                      >
                        <Show
                          when={output().kind === "json"}
                          fallback={
                            <text fg={theme().text} wrapMode="word">
                              {output().content}
                            </text>
                          }
                        >
                          {/* tree-sitter highlights this asynchronously and degrades to plain text by itself. */}
                          <code content={output().content} filetype="json" syntaxStyle={syntaxStyle()} />
                        </Show>
                      </box>
                    )}
                  </Show>

                  {/* No answer on screen — say which of the four reasons it is, rather than showing a gap. */}
                  <Show when={answerNote()}>
                    {(note: Accessor<string>) => <text fg={theme().textMuted}>{note()}</text>}
                  </Show>
                  <Show when={detail().error}>
                    {(error: Accessor<string>) => (
                      <box
                        flexDirection="column"
                        paddingLeft={1}
                        paddingRight={1}
                        border
                        borderStyle="rounded"
                        borderColor={theme().error}
                        title=" Error "
                        titleAlignment="left"
                      >
                        <text fg={theme().error} wrapMode="word">
                          {error()}
                        </text>
                      </box>
                    )}
                  </Show>
                </box>
              )}
            </Show>
          </scrollbox>
        </Show>
      </box>

      <Show when={notice()}>
        {(message: Accessor<string>) => (
          <box paddingLeft={1} paddingRight={1} backgroundColor={theme().backgroundElement}>
            <text fg={theme().warning}>{message()}</text>
          </box>
        )}
      </Show>

      {/* Footer bar — keys in accent against muted labels, so the vocabulary is scannable rather than prose. */}
      <box
        flexDirection="row"
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme().backgroundPanel}
      >
        <For each={footer()}>
          {(group: FooterGroup, index) => (
            <box flexDirection="row" flexShrink={0}>
              <text fg={group.enabled ? theme().accent : theme().borderSubtle}>
                <b>{index() === 0 ? group.keys : `  ${group.keys}`}</b>
              </text>
              <text fg={group.enabled ? theme().textMuted : theme().borderSubtle}>{` ${group.label}`}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

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
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import type { ControlAction, ControlResult } from "../control"
import type { RunSummary } from "../journal"
import { formatElapsed, formatTokens, meter, phasePosition, phaseProgress, settledUnits } from "../progress"
import type { PendingInteraction, RunSnapshot } from "../runs"
import type { RunControlClient } from "./control"
import InteractionPane, { buildAnswer, paneRows } from "./interactions"
import {
  footerGroups,
  QUESTION_BINDINGS,
  registerKeymap,
  WORKFLOW_ROUTE,
  type FooterGroup,
  type WorkflowBinding,
} from "./keymap"
import {
  breadcrumb,
  findInteraction,
  initialRouteState,
  interactionSource,
  listRows,
  normalizeRoute,
  openQuestion,
  reduceRoute,
  runRows,
  selectedControl,
  selectIndex,
  unitDetail,
  type ListRow,
  type RouteState,
  type UnitOutput,
  type RunLevelRow,
  type UnitDetail,
} from "./route-model"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** Settled outcomes, all single-width so a row never shifts as a run or unit ends. */
const LIST_GLYPHS = { done: "✓", failed: "✗", aborted: "⊘" } as const
const ROW_GLYPHS = { queued: "·", ok: "✓", failed: "✗", replayed: "↺", question: "❓" } as const

/** How much of the run's log tail the run level shows. Enough for context, never enough to become the screen. */
const RECENT_LOGS = 5

/** Cells in a phase or unit meter. Four reads as progress; more reads as a chart nobody asked for. */
const METER_WIDTH = 4

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
  /** `{ runId }` when entered from the sidebar; `{ returnTo }` carries the session to go back to. */
  params?: Record<string, unknown>
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
      const base = initialRouteState(runId)
      // A deep link from the sidebar badge or the attention toast lands ON the pane, not near it: the whole
      // point of the badge is that the user already knows what they want to do.
      return runId && requestID ? openQuestion(base, runId, requestID) : base
    })(),
  )
  const [now, setNow] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  const [notice, setNotice] = createSignal<string | null>(null)
  /** Which question of a multi-part form is on screen, and the rows answered before it. */
  const [formIndex, setFormIndex] = createSignal(0)
  const [formAnswers, setFormAnswers] = createSignal<string[][]>([])

  const elapsedTimer = setInterval(() => setNow(Date.now()), 1_000)
  const spinnerTimer = setInterval(() => setFrame((value: number) => (value + 1) % SPINNER_FRAMES.length), 80)
  onCleanup(() => {
    clearInterval(elapsedTimer)
    clearInterval(spinnerTimer)
  })

  const theme = () => props.api.theme.current
  const spinner = () => SPINNER_FRAMES[frame()] as string
  const history = (): readonly RunSummary[] => props.history?.() ?? []

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
    return top ? findInteraction(props.runs(), top.runId, top.requestID) : null
  }

  /** Rewrite the question level in place — the only level whose state the reducer does not own outright. */
  const patchQuestion = (patch: { selected?: number; custom?: string | null }) => {
    setState((current) => {
      const top = current.stack[current.stack.length - 1]
      if (top?.kind !== "question") return current
      const stack = current.stack.slice()
      stack[stack.length - 1] = { ...top, ...patch }
      return { ...current, stack }
    })
  }

  const send = (target: ControlAction) => {
    void props.control.send(target).then((result) => setNotice(controlNotice(target, result)))
  }

  /**
   * ⏎ on the answer pane: choose, advance, or send.
   *
   * Three outcomes rather than one, because a form is answered a question at a time: selecting the custom row
   * opens the field instead of submitting an empty answer, an unfinished form advances, and only the last
   * question actually replies.
   */
  const answer = () => {
    const top = questionLevel()
    const interaction = currentInteraction()
    if (!top || !interaction) return
    const rows = paneRows(interaction.questions[formIndex()])
    const row = rows[top.selected]
    // First ⏎ on `✎ custom answer…` opens the field; the second (from inside the input) submits it.
    if (row?.custom && top.custom === null) {
      patchQuestion({ custom: "" })
      return
    }
    const typed = top.custom !== null && top.custom.trim().length > 0 ? top.custom : null
    const selection = row && !row.custom ? [row.label] : []
    if (selection.length === 0 && typed === null) {
      setNotice("choose an option, or type an answer")
      return
    }
    const answers = buildAnswer(interaction, selection, typed, formAnswers())
    if (answers.length < interaction.questions.length) {
      setFormAnswers(answers)
      setFormIndex((index: number) => index + 1)
      patchQuestion({ selected: 0, custom: null })
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
      send({ action: "permission.reply", runId: top.runId, requestID: top.requestID, reply })
      return
    }
    send({ action: "question.reply", runId: top.runId, requestID: top.requestID, answers })
  }

  const dispatch = (action: WorkflowBinding["action"]) => {
    setNotice(null)
    if (action === "close") {
      close()
      return
    }
    const question = questionLevel()
    if (question) {
      // ⏎ answers. `esc` steps out of the free-text field first, and only then hands the question back — so a
      // mistyped answer costs one keystroke rather than the whole question.
      if (action === "drill") {
        answer()
        return
      }
      if (action === "back") {
        if (question.custom !== null) {
          patchQuestion({ custom: null })
          return
        }
        send({ action: "question.reject", runId: question.runId, requestID: question.requestID })
        setState((current) => reduceRoute(current, "back", props.runs(), history()))
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
      const target = selectedControl(state(), props.runs(), action, history())
      if (!target) return
      send(target)
      return
    }
    // A history row has a summary and no snapshot, so there is nothing to open. Saying so beats a key that
    // silently does nothing, which reads as broken rather than as unfinished.
    if (action === "drill" && level()?.kind === "list" && rows()[selectedIndex()]?.live === false) {
      setNotice("nothing live to open — this run is from an earlier session")
      return
    }
    setState((current) => reduceRoute(current, action, props.runs(), history()))
  }

  onMount(() => {
    // Mode-scoped, so `x` cannot stop a run while the user is typing in a session prompt — and, symmetrically,
    // so the prompt gets every key back the instant this route unmounts.
    onCleanup(props.api.mode.push(WORKFLOW_ROUTE))
    onCleanup(registerKeymap(props.api, dispatch))
  })

  // Runs settle and disappear underneath the cursor; re-normalizing on every change is what keeps a selection
  // (and a drilled-into level) from pointing at something that is no longer there — with no keypress involved.
  // A question answered by somebody else — another surface, or the watcher's grace running out — takes the pane
  // off the stack the same way, which is the payoff for making it a level.
  createEffect(() => {
    const runs = props.runs()
    const past = history()
    setState((current) => normalizeRoute(current, runs, past))
  })

  // A new form starts at its first question with nothing collected. Keyed on the requestID rather than on the
  // level, so walking out of a pane and back into the SAME question does not lose the answers already given.
  let formRequestID: string | null = null
  createEffect(() => {
    const requestID = questionLevel()?.requestID ?? null
    if (requestID === formRequestID) return
    formRequestID = requestID
    setFormIndex(0)
    setFormAnswers([])
  })

  const level = createMemo(() => state().stack[state().stack.length - 1])
  const crumb = createMemo(() => breadcrumb(state(), props.runs()))
  const rows = createMemo<ListRow[]>(() => {
    now() // re-render elapsed on the tick
    return listRows(props.runs(), history(), state().filter)
  })
  /** Index of the first journal-only row, so the `History` divider is drawn exactly once and in one place. */
  const firstHistoryRow = createMemo(() => rows().findIndex((row) => !row.live))
  const activeRun = createMemo<RunSnapshot | undefined>(() => {
    const current = level()
    if (!current || current.kind === "list") return undefined
    return props.runs().find((run) => run.runId === current.runId)
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
    const groups = footerGroups(questionLevel() ? QUESTION_BINDINGS : undefined)
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
    if (row.glyph === "ok" || row.glyph === "replayed") return theme().success
    // A waiting question is the one row on this screen that is asking for something.
    if (row.glyph === "question") return theme().warning
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
        <box flexDirection="row" gap={1} flexShrink={1}>
          <For each={crumb().split(" ▸ ")}>
            {(segment: string, index) => (
              <box flexDirection="row" gap={1} flexShrink={index() === 0 ? 0 : 1}>
                <Show when={index() > 0}>
                  <text flexShrink={0} fg={theme().borderSubtle}>
                    ›
                  </text>
                </Show>
                <text
                  flexShrink={1}
                  fg={index() === crumb().split(" ▸ ").length - 1 ? theme().accent : theme().textMuted}
                >
                  {index() === crumb().split(" ▸ ").length - 1 ? <b>{segment}</b> : segment}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text fg={theme().textMuted}>filter</text>
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
            gap={2}
            paddingLeft={1}
            paddingRight={1}
            backgroundColor={theme().backgroundElement}
          >
            <text flexShrink={0} fg={statusColor(run().status)}>
              <b>{run().status === "running" ? `${spinner()} running` : `${statusGlyph(run().status)} ${run().status}`}</b>
            </text>
            <For each={runStats(run(), now())}>
              {(stat: Stat) => (
                <box flexDirection="row" gap={1} flexShrink={1}>
                  <Show when={stat.meter}>
                    {(bar: Accessor<string>) => (
                      <text flexShrink={0} fg={theme().accent}>
                        {bar()}
                      </text>
                    )}
                  </Show>
                  <text flexShrink={1} fg={theme().textMuted}>
                    {stat.label}
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
              <box flexDirection="column" paddingTop={1} gap={1}>
                <text fg={theme().textMuted}>No workflow runs to show.</text>
                <text fg={theme().borderSubtle}>Start one with the `workflow` tool, then come back.</text>
              </box>
            </Show>
            <For each={rows()}>
              {(row: ListRow, index) => (
                <box flexDirection="column">
                  {/* Drawn once, above the first journal-only row: everything below it outlived its engine. */}
                  <Show when={index() === firstHistoryRow()}>
                    <box flexDirection="row" gap={1} marginTop={index() === 0 ? 0 : 1}>
                      <text fg={theme().textMuted}>
                        <b>History</b>
                      </text>
                      <text fg={theme().borderSubtle}>earlier sessions</text>
                    </box>
                  </Show>
                  <box
                    flexDirection="row"
                    justifyContent="space-between"
                    backgroundColor={rowBackground(index())}
                    onMouseUp={() => clickRow(index())}
                  >
                    <box flexDirection="row" gap={1} flexShrink={1}>
                      <text flexShrink={0} fg={listGlyphColor(row)}>
                        {` ${listGlyph(row)}`}
                      </text>
                      <text flexShrink={0} fg={rowName(row, index())}>
                        <b>{row.workflow.padEnd(nameColumn())}</b>
                      </text>
                      <Show when={density() !== "minimal" && row.phaseRatio !== null}>
                        <text flexShrink={0} fg={theme().accent}>
                          {meter(row.phaseRatio ?? 0, METER_WIDTH)}
                        </text>
                      </Show>
                      <text flexShrink={1} fg={rowMuted(index())}>
                        {[row.position, row.phase].filter(Boolean).join(" ")}
                      </text>
                    </box>
                    <box flexDirection="row" gap={2} flexShrink={0}>
                      <text flexShrink={0} fg={rowMuted(index())}>
                        {rightAlign(`${row.units} units`, 12)}
                      </text>
                      <Show when={density() === "full"}>
                        <text flexShrink={0} fg={rowMuted(index())}>
                          {rightAlign(row.tokens ? `${row.tokens} tok` : "", 9)}
                        </text>
                      </Show>
                      <text flexShrink={0} fg={rowMuted(index())}>
                        {rightAlign(row.elapsed, 7)}
                      </text>
                      <Show when={density() !== "minimal"}>
                        <text flexShrink={0} fg={theme().borderSubtle}>
                          {rightAlign(row.startedAt, 5)}
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
            <Show when={detailRows().length === 0}>
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
                  <box flexDirection="row" gap={1} flexShrink={1}>
                    <text flexShrink={0} fg={rowGlyphColor(row)}>
                      {`${row.indent === 1 ? "   " : " "}${rowGlyph(row)}`}
                    </text>
                    <text flexShrink={0} fg={row.indent === 0 ? rowText(index()) : rowMuted(index())}>
                      {row.indent === 0 ? <b>{row.label}</b> : row.label}
                    </text>
                    <text flexShrink={1} fg={rowMuted(index())}>
                      {row.detail}
                    </text>
                  </box>
                  <text flexShrink={0} fg={rowMuted(index())}>
                    {rightAlign(row.elapsed, 7)}
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
          <InteractionPane
            interaction={() => currentInteraction() ?? undefined}
            theme={props.api.theme}
            now={now}
            selected={() => questionLevel()?.selected ?? 0}
            custom={() => questionLevel()?.custom ?? null}
            index={formIndex}
            source={() => {
              const run = activeRun()
              const current = currentInteraction()
              return run && current ? interactionSource(run, current) : ""
            }}
            onSelect={(index: number) => {
              // Click to select, click again to answer — the same two steps the keyboard takes everywhere else.
              if (index === (questionLevel()?.selected ?? -1)) answer()
              else patchQuestion({ selected: index })
            }}
            onCustomInput={(value: string) => patchQuestion({ custom: value })}
            onAnswer={answer}
            onHandOff={() => dispatch("back")}
          />
        </Show>

        <Show when={level()?.kind === "unit"}>
          <scrollbox ref={body} flexGrow={1} scrollY stickyScroll={false}>
            <Show when={unit()}>
              {(detail: Accessor<UnitDetail>) => (
                <box flexDirection="column" gap={1}>
                  <box flexDirection="row" gap={2}>
                    <text flexShrink={1} fg={theme().accent}>
                      <b>{`#${detail().ordinal} ${detail().label ?? detail().subagent}`}</b>
                    </text>
                    <text flexShrink={0} fg={unitStatusColor(detail().status)}>
                      {detail().status}
                    </text>
                    <Show when={detail().elapsed}>
                      <text flexShrink={0} fg={theme().textMuted}>
                        {detail().elapsed}
                      </text>
                    </Show>
                  </box>
                  <box flexDirection="row" gap={2}>
                    <text fg={theme().textMuted}>{`subagent ${detail().subagent}`}</text>
                    <text fg={theme().textMuted}>{`phase ${detail().phase ?? "(none)"}`}</text>
                    <text fg={theme().info}>{`session ${detail().sessionID ?? "(none)"}`}</text>
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

                  {/* What it answered. The question was already on screen; this is the half that was missing. */}
                  <Show when={detail().output}>
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

                  {/* A unit that is still running has no answer yet — say which, rather than showing a gap. */}
                  <Show when={!detail().output && detail().error === null}>
                    <text fg={theme().textMuted}>
                      {detail().status === "ok" ? "This unit returned nothing." : "Waiting for this unit to answer…"}
                    </text>
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
        gap={2}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme().backgroundPanel}
      >
        <For each={footer()}>
          {(group: FooterGroup) => (
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text fg={group.enabled ? theme().accent : theme().borderSubtle}>
                <b>{group.keys}</b>
              </text>
              <text fg={group.enabled ? theme().textMuted : theme().borderSubtle}>{group.label}</text>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

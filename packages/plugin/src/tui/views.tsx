/**
 * The TUI's components: the Workflows screen (library → Run → Unit, used by the `/workflows` page and the session
 * panel), the answer panel, the composer strip and the sidebar block.
 *
 * All logic lives in the plain modules beside this file; components only read state, lay out text and route keys
 * and clicks to actions. Colour comes only from the active theme. Selection is `background.raised.high` plus
 * a `▸` marker (the theme's "selected" action fill is transparent — P0 S4), and every status is a glyph and a word.
 */
import type { Context, KeymapCommand, PanelInput } from "@opencode/plugin/tui/context"
import type { BoxRenderable, InputRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onMount, Show, Switch, type Accessor } from "solid-js"

import { formatElapsed, formatTokens } from "../progress"
import type { LibraryEntry, PendingInteraction, Run, Unit } from "../protocol"
import { isTerminal } from "../runs"
import {
  back,
  confirm,
  currentQuestion,
  move,
  pick,
  rows,
  startAnswer,
  submitText,
  toggle,
  type AnswerState,
  type AnswerStep,
} from "./answer"
import {
  LIBRARY_COLUMNS,
  UNIT_COLUMNS,
  formatCost,
  layout,
  libraryCells,
  renderHeader,
  renderRow,
  runStatus,
  runSummary,
  shortId,
  sidebarLines,
  stripText,
  truncate,
  unitCells,
  unitName,
  unitStatus,
  workflowName,
  wrapLines,
  type Tone,
} from "./format"
import {
  current,
  cursor,
  cycleFilter,
  filterEntries,
  initialNav,
  moveCursor,
  pop,
  push,
  setCursor,
  visibleWindow,
  type Nav,
  type View,
} from "./nav"
import { sessionEntries, type SyncState } from "./state"

export interface Actions {
  stopRun(run: Run): Promise<void>
  /** Resolves to the new Run's id. */
  resumeRun(run: Run): Promise<string | null>
  saveRun(run: Run): Promise<void>
  cleanupRun(run: Run): Promise<void>
  cleanupPending(): Promise<void>
  stopUnit(run: Run, unit: Unit): Promise<void>
  restartUnit(run: Run, unit: Unit): Promise<void>
  openTranscript(sessionID: string): void
  /** Resolves to an error message, or null when the answer was accepted. */
  reply(run: Run, interaction: PendingInteraction, answers: string[][]): Promise<string | null>
  dismiss(run: Run, interaction: PendingInteraction): Promise<string | null>
  pair(): Promise<void>
  refresh(): Promise<void>
  openPanel(runId?: string, sessionID?: string): void
  openRoute(target?: { runId?: string; answer?: boolean }): void
}

export interface Wf {
  readonly context: Context
  readonly state: Accessor<SyncState>
  readonly now: Accessor<number>
  readonly error: Accessor<string | null>
  readonly open: (runId: string) => Promise<void>
  readonly loadUnit: (runId: string, unitId: string) => Promise<Unit | null>
  readonly actions: Actions
}

export const PANEL = "opencode-dynamic-workflows.run"
const MARKER = "▸ "

function toneColor(context: Context, tone: Tone): RGBA {
  const th = context.theme
  switch (tone) {
    case "success":
      return th.text.feedback.success.base
    case "error":
      return th.text.feedback.error.base
    case "warning":
      return th.text.feedback.warning.base
    case "info":
      return th.text.feedback.info.base
    case "muted":
      return th.text.muted
    case "base":
      return th.text.base
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------------------------------------------

interface Hint {
  readonly key: string
  readonly label: string
  readonly run: () => void
}

/** Key hints; each is clickable (mouse parity). */
function Hints(props: { wf: Wf; hints: readonly Hint[] }) {
  const th = () => props.wf.context.theme
  return (
    <box flexDirection="row" flexWrap="wrap">
      <For each={props.hints}>
        {(hint, index) => (
          <box flexDirection="row" onMouseDown={() => hint.run()}>
            <text fg={th().text.base}>{hint.key}</text>
            <text fg={th().text.muted}>{` ${hint.label}${index() < props.hints.length - 1 ? " · " : ""}`}</text>
          </box>
        )}
      </For>
    </box>
  )
}

/** One selectable row: marker, a coloured status cell, then the rest of the columns. */
function Row(props: {
  wf: Wf
  selected: boolean
  status: string
  statusWidth: number
  tone: Tone
  rest: string
  onClick: () => void
}) {
  const th = () => props.wf.context.theme
  return (
    <box
      flexDirection="row"
      backgroundColor={props.selected ? th().background.raised.high : undefined}
      onMouseDown={() => props.onClick()}
    >
      <text fg={th().text.base}>{props.selected ? MARKER : "  "}</text>
      <text fg={toneColor(props.wf.context, props.tone)}>
        {truncate(props.status, props.statusWidth).padEnd(props.statusWidth)}
      </text>
      <text fg={props.selected ? th().text.base : th().text.base}>{` ${props.rest}`}</text>
    </box>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The Workflows screen
// ---------------------------------------------------------------------------------------------------------------

export interface ScreenProps {
  wf: Wf
  /** Library rows: every Run of the location (page) or of one session (panel). */
  entries: () => LibraryEntry[]
  start: () => { runId?: string; unitId?: string; answer?: boolean } | undefined
  root: "library" | "run"
  title: string
  active: () => boolean
  width: () => number
  height: () => number
  /** Escape goes back (off in the session panel, where Escape interrupts the session). */
  escapeBack: boolean
  onExit: () => void
}

export function WorkflowsScreen(props: ScreenProps) {
  const wf = props.wf
  const context = wf.context
  const th = () => context.theme
  const initial = () => {
    const start = props.start()
    return initialNav({
      ...(start?.runId ? { runId: start.runId } : {}),
      ...(start?.unitId ? { unitId: start.unitId } : {}),
      root: props.root,
    })
  }
  const [nav, setNav] = createSignal<Nav>(initial())
  const [answer, setAnswer] = createSignal<AnswerState | null>(null)
  const [note, setNote] = createSignal<{ text: string; tone: Tone } | null>(null)
  const [sending, setSending] = createSignal(false)
  const [autoAnswer, setAutoAnswer] = createSignal(props.start()?.answer === true)
  const [scroll, setScroll] = createSignal(0)

  createEffect(
    on(
      () => JSON.stringify(props.start() ?? {}),
      () => {
        setNav(initial())
        setAnswer(null)
        setAutoAnswer(props.start()?.answer === true)
      },
      { defer: true },
    ),
  )

  const view = () => current(nav())
  const viewRunId = () => {
    const v = view()
    return v.kind === "library" ? null : v.runId
  }
  const slot = () => {
    const runId = viewRunId()
    return runId ? wf.state().runs[runId] : undefined
  }
  const run = () => slot()?.run ?? null
  const entries = createMemo(() => filterEntries(props.entries(), nav().filter))
  const units = () => run()?.units ?? []
  const selectedUnit = () => {
    const list = units()
    return list[cursor(nav(), list.length)]
  }
  const viewUnit = () => {
    const v = view()
    return v.kind === "unit" ? run()?.units.find((unit) => unit.unitId === v.unitId) : undefined
  }
  const pendingInteraction = () => {
    const state = answer()
    return state ? run()?.interactions.find((candidate) => candidate.interactionId === state.interactionId) : undefined
  }

  // A Run view reads the Run in full (and its activity) when it opens.
  createEffect(
    on(viewRunId, (runId) => {
      if (runId) void wf.open(runId).catch(() => {})
    }),
  )
  createEffect(
    on(
      () => JSON.stringify(view()),
      () => {
        setScroll(0)
        setNote(null)
      },
      { defer: true },
    ),
  )

  // Leave answer mode if the interaction was settled elsewhere (another TUI, the web app, a timeout).
  createEffect(() => {
    const state = answer()
    if (state && run() && !pendingInteraction() && !sending()) {
      setAnswer(null)
      setNote({ text: "That question was settled elsewhere.", tone: "muted" })
    }
  })
  // `/workflows answer` and toasts open a Run straight into answer mode.
  createEffect(() => {
    const shown = run()
    if (!autoAnswer() || !shown) return
    const first = shown.interactions[0]
    if (first) beginAnswer(first)
    setAutoAnswer(false)
  })

  function beginAnswer(interaction: PendingInteraction | undefined) {
    if (!interaction) return
    setNote(null)
    setAnswer(startAnswer(interaction))
  }

  async function step(result: AnswerStep) {
    setAnswer(result.state)
    if (!result.submit) return
    const target = run()
    const interaction = pendingInteraction()
    if (!target || !interaction) {
      setAnswer(null)
      return
    }
    setSending(true)
    const error = await wf.actions.reply(target, interaction, result.submit)
    setSending(false)
    if (error) {
      setNote({ text: `Not sent: ${error}`, tone: "error" })
      setAnswer(startAnswer(interaction))
      return
    }
    setAnswer(null)
    setNote({ text: "Answer sent.", tone: "success" })
  }

  async function dismiss() {
    const target = run()
    const interaction = pendingInteraction()
    if (!target || !interaction) return
    setSending(true)
    const error = await wf.actions.dismiss(target, interaction)
    setSending(false)
    setAnswer(null)
    setNote(
      error
        ? { text: `Not dismissed: ${error}`, tone: "error" }
        : { text: "Dismissed; the Run continues without an answer.", tone: "muted" },
    )
  }

  // --- navigation --------------------------------------------------------------------------------------------

  const count = () => {
    const v = view()
    if (v.kind === "library") return entries().length
    if (v.kind === "run") return units().length
    return Number.MAX_SAFE_INTEGER
  }
  const moveBy = (delta: number) => {
    if (view().kind === "unit") {
      setScroll((value) => Math.max(0, value + delta))
      return
    }
    setNav(moveCursor(nav(), delta, count()))
  }
  const page = () => Math.max(1, props.height() - 10)

  function openSelected() {
    const v = view()
    if (v.kind === "library") {
      const entry = entries()[cursor(nav(), entries().length)]
      if (entry) setNav(push(nav(), { kind: "run", runId: entry.runId }))
      return
    }
    if (v.kind === "run") {
      const unit = selectedUnit()
      if (unit) setNav(push(nav(), { kind: "unit", runId: v.runId, unitId: unit.unitId }))
    }
  }

  function goBack() {
    const previous = pop(nav())
    if (previous) setNav(previous)
    else props.onExit()
  }

  function answerFirst() {
    const v = view()
    if (v.kind === "library") {
      const waiting = props.entries().find((entry) => entry.waiting)
      if (!waiting) {
        setNote({ text: "Nothing is waiting for an answer.", tone: "muted" })
        return
      }
      setNav(push(nav(), { kind: "run", runId: waiting.runId }))
      setAutoAnswer(true)
      return
    }
    const first = run()?.interactions[0]
    if (first) beginAnswer(first)
    else setNote({ text: "Nothing is waiting for an answer in this Run.", tone: "muted" })
  }

  const withRun = (work: (target: Run) => unknown) => () => {
    const target = run()
    if (target) void work(target)
  }
  const withUnit = (work: (target: Run, unit: Unit) => unknown) => () => {
    const target = run()
    const unit = view().kind === "unit" ? viewUnit() : selectedUnit()
    if (target && unit) void work(target, unit)
  }
  const openUnitTranscript = () => {
    const unit = view().kind === "unit" ? viewUnit() : selectedUnit()
    if (unit?.sessionID) wf.actions.openTranscript(unit.sessionID)
    else setNote({ text: "This Unit has no session (not started, or replayed).", tone: "muted" })
  }
  const resume = withRun(async (target) => {
    const runId = await wf.actions.resumeRun(target)
    if (runId) setNav(push(nav(), { kind: "run", runId }))
  })

  const hints = (): Hint[] => {
    const v = view()
    const common: Hint[] = [
      { key: props.escapeBack ? "esc" : "⌫", label: nav().stack.length > 1 ? "back" : "close", run: goBack },
    ]
    if (v.kind === "library") {
      return [
        { key: "↵", label: "open", run: openSelected },
        { key: "a", label: "answer", run: answerFirst },
        { key: "f", label: `filter: ${nav().filter}`, run: () => void setNav(cycleFilter(nav())) },
        { key: "d", label: "clean up finished", run: () => void wf.actions.cleanupPending() },
        { key: "p", label: "pair browser", run: () => void wf.actions.pair() },
        { key: "r", label: "refresh", run: () => void wf.actions.refresh() },
        ...common,
      ]
    }
    const target = run()
    const terminal = target ? isTerminal(target.status) : false
    if (v.kind === "run") {
      return [
        { key: "↵", label: "unit", run: openSelected },
        ...(target?.interactions.length ? [{ key: "a", label: "answer", run: answerFirst }] : []),
        { key: "o", label: "transcript", run: openUnitTranscript },
        ...(terminal
          ? [
              { key: "e", label: "resume", run: resume },
              { key: "w", label: "save", run: withRun((t) => wf.actions.saveRun(t)) },
              { key: "d", label: "delete unit sessions", run: withRun((t) => wf.actions.cleanupRun(t)) },
            ]
          : [
              { key: "s", label: "stop run", run: withRun((t) => wf.actions.stopRun(t)) },
              { key: "x", label: "stop unit", run: withUnit((t, u) => wf.actions.stopUnit(t, u)) },
              { key: "r", label: "restart unit", run: withUnit((t, u) => wf.actions.restartUnit(t, u)) },
            ]),
        { key: "p", label: "parent session", run: withRun((t) => wf.actions.openTranscript(t.parentSessionID)) },
        ...common,
      ]
    }
    return [
      { key: "o", label: "transcript", run: openUnitTranscript },
      ...(terminal
        ? []
        : [
            { key: "x", label: "stop unit", run: withUnit((t, u) => wf.actions.stopUnit(t, u)) },
            { key: "r", label: "restart unit", run: withUnit((t, u) => wf.actions.restartUnit(t, u)) },
          ]),
      ...common,
    ]
  }

  // --- keys --------------------------------------------------------------------------------------------------

  const navigating = () => props.active() && answer() === null
  const choosing = () => props.active() && answer() !== null && !answer()!.typing && !sending()
  const typing = () => props.active() && answer()?.typing === true

  context.keymap.layer(() => {
    const inView = (kind: View["kind"] | "any") => () => kind === "any" || view().kind === kind
    const commands: KeymapCommand[] = [
      { title: "Down", group: "Workflows", bind: "j", run: () => moveBy(1) },
      { title: "Down", group: "Workflows", bind: "down", run: () => moveBy(1) },
      { title: "Up", group: "Workflows", bind: "k", run: () => moveBy(-1) },
      { title: "Up", group: "Workflows", bind: "up", run: () => moveBy(-1) },
      { title: "Page down", group: "Workflows", bind: "pagedown", run: () => moveBy(page()) },
      { title: "Page up", group: "Workflows", bind: "pageup", run: () => moveBy(-page()) },
      { title: "Open", group: "Workflows", bind: "return", enabled: () => view().kind !== "unit", run: openSelected },
      { title: "Back", group: "Workflows", bind: "backspace", run: goBack },
      ...(props.escapeBack ? [{ title: "Back", group: "Workflows", bind: "escape", run: goBack }] : []),
      { title: "Answer", group: "Workflows", bind: "a", enabled: inView("any"), run: answerFirst },
      {
        title: "Filter",
        group: "Workflows",
        bind: "f",
        enabled: inView("library"),
        run: () => void setNav(cycleFilter(nav())),
      },
      {
        title: "Clean up finished Runs",
        group: "Workflows",
        bind: "d",
        enabled: inView("library"),
        run: () => void wf.actions.cleanupPending(),
      },
      {
        title: "Pair a browser",
        group: "Workflows",
        bind: "p",
        enabled: inView("library"),
        run: () => void wf.actions.pair(),
      },
      {
        title: "Refresh",
        group: "Workflows",
        bind: "r",
        enabled: inView("library"),
        run: () => void wf.actions.refresh(),
      },
      {
        title: "Open transcript",
        group: "Workflows",
        bind: "o",
        enabled: () => view().kind !== "library",
        run: openUnitTranscript,
      },
      {
        title: "Parent session",
        group: "Workflows",
        bind: "p",
        enabled: inView("run"),
        run: withRun((t) => wf.actions.openTranscript(t.parentSessionID)),
      },
      {
        title: "Stop Run",
        group: "Workflows",
        bind: "s",
        enabled: () => view().kind === "run" && !!run() && !isTerminal(run()!.status),
        run: withRun((t) => wf.actions.stopRun(t)),
      },
      {
        title: "Stop Unit",
        group: "Workflows",
        bind: "x",
        enabled: () => view().kind !== "library" && !!run() && !isTerminal(run()!.status),
        run: withUnit((t, u) => wf.actions.stopUnit(t, u)),
      },
      {
        title: "Restart Unit",
        group: "Workflows",
        bind: "r",
        enabled: () => view().kind !== "library" && !!run() && !isTerminal(run()!.status),
        run: withUnit((t, u) => wf.actions.restartUnit(t, u)),
      },
      {
        title: "Resume Run",
        group: "Workflows",
        bind: "e",
        enabled: () => view().kind === "run" && !!run() && isTerminal(run()!.status),
        run: resume,
      },
      {
        title: "Save Run",
        group: "Workflows",
        bind: "w",
        enabled: () => view().kind === "run" && !!run() && isTerminal(run()!.status),
        run: withRun((t) => wf.actions.saveRun(t)),
      },
      {
        title: "Delete Unit sessions",
        group: "Workflows",
        bind: "d",
        enabled: () => view().kind === "run" && !!run() && isTerminal(run()!.status),
        run: withRun((t) => wf.actions.cleanupRun(t)),
      },
    ]
    return { enabled: navigating, priority: 50, commands }
  })

  context.keymap.layer(() => ({
    enabled: choosing,
    priority: 60,
    commands: [
      { title: "Next option", group: "Answer", bind: "down", run: () => void setAnswer(move(answer()!, 1)) },
      { title: "Next option", group: "Answer", bind: "j", run: () => void setAnswer(move(answer()!, 1)) },
      { title: "Previous option", group: "Answer", bind: "up", run: () => void setAnswer(move(answer()!, -1)) },
      { title: "Previous option", group: "Answer", bind: "k", run: () => void setAnswer(move(answer()!, -1)) },
      { title: "Toggle", group: "Answer", bind: "space", run: () => void setAnswer(toggle(answer()!)) },
      { title: "Choose", group: "Answer", bind: "return", run: () => void step(confirm(answer()!)) },
      { title: "Dismiss", group: "Answer", bind: "x", run: () => void dismiss() },
      { title: "Back", group: "Answer", bind: "escape", run: () => void setAnswer(back(answer()!)) },
      { title: "Back", group: "Answer", bind: "backspace", run: () => void setAnswer(back(answer()!)) },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((number) => ({
        title: `Pick ${number}`,
        group: "Answer",
        bind: String(number),
        run: () => void step(pick(answer()!, number)),
      })),
    ],
  }))

  context.keymap.layer(() => ({
    enabled: typing,
    priority: 60,
    commands: [{ title: "Stop typing", group: "Answer", bind: "escape", run: () => void setAnswer(back(answer()!)) }],
  }))

  // --- layout ------------------------------------------------------------------------------------------------

  const innerWidth = () => Math.max(20, props.width() - 2)

  const crumbs = () => {
    const v = view()
    const parts = [props.title]
    const shown = run()
    if (v.kind !== "library") parts.push(shown ? `${workflowName(shown)} ${shortId(shown.runId)}` : shortId(v.runId))
    if (v.kind === "unit") {
      const unit = viewUnit()
      parts.push(unit ? unitName(unit) : "unit")
    }
    return parts.join(" › ")
  }

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={th().text.base}>
          <b>{truncate(crumbs(), innerWidth())}</b>
        </text>
      </box>
      <Show when={wf.error()}>
        <text fg={th().text.feedback.error.base}>{truncate(`! ${wf.error()}`, innerWidth())}</text>
      </Show>
      <Show when={note()}>
        <text fg={toneColor(context, note()!.tone)}>{truncate(note()!.text, innerWidth())}</text>
      </Show>
      <box flexDirection="column" flexGrow={1}>
        <Switch>
          <Match when={view().kind === "library"}>
            <LibraryPane
              wf={wf}
              entries={entries()}
              total={props.entries().length}
              filter={nav().filter}
              cursor={cursor(nav(), entries().length)}
              width={innerWidth()}
              height={props.height() - 6}
              onPick={(index) => {
                if (cursor(nav(), entries().length) === index) openSelected()
                else setNav(setCursor(nav(), index, entries().length))
              }}
            />
          </Match>
          <Match when={view().kind === "run"}>
            <Show when={run()} fallback={<text fg={th().text.muted}>Loading the Run…</text>}>
              <RunPane
                wf={wf}
                run={run()!}
                activity={slot()?.activity ?? null}
                cursor={cursor(nav(), units().length)}
                width={innerWidth()}
                height={props.height() - 6}
                answer={answer()}
                interaction={pendingInteraction()}
                sending={sending()}
                onAnswerText={(text) => void step(submitText(answer()!, text))}
                onPickOption={(index) => void step(pick(answer()!, index + 1))}
                onPick={(index) => {
                  if (cursor(nav(), units().length) === index) openSelected()
                  else setNav(setCursor(nav(), index, units().length))
                }}
                onAnswer={answerFirst}
              />
            </Show>
          </Match>
          <Match when={view().kind === "unit"}>
            <Show when={run() && viewUnit()} fallback={<text fg={th().text.muted}>Loading the Unit…</text>}>
              <UnitPane
                wf={wf}
                run={run()!}
                unit={viewUnit()!}
                width={innerWidth()}
                height={props.height() - 5}
                scroll={scroll()}
                onScroll={setScroll}
              />
            </Show>
          </Match>
        </Switch>
      </box>
      <Show when={answer() === null}>
        <Hints wf={wf} hints={hints()} />
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------------------------------------------

function LibraryPane(props: {
  wf: Wf
  entries: LibraryEntry[]
  total: number
  filter: string
  cursor: number
  width: number
  height: number
  onPick: (index: number) => void
}) {
  const th = () => props.wf.context.theme
  const columns = () => layout(LIBRARY_COLUMNS, props.width - MARKER.length)
  const statusColumn = () => columns().find((column) => column.id === "status")!
  const rest = () => columns().filter((column) => column.id !== "status")
  const window = () => visibleWindow(props.entries.length, props.cursor, Math.max(3, props.height - 3))
  const live = () => props.entries.filter((entry) => entry.live).length
  const waiting = () => props.entries.filter((entry) => entry.waiting).length
  return (
    <box flexDirection="column">
      <text fg={th().text.muted}>
        {truncate(
          [
            `${props.total} runs`,
            live() ? `${live()} live` : "",
            waiting() ? `${waiting()} waiting` : "",
            props.filter !== "all" ? `showing ${props.filter} (${props.entries.length})` : "",
          ]
            .filter(Boolean)
            .join(" · "),
          props.width,
        )}
      </text>
      <Show
        when={props.entries.length > 0}
        fallback={
          <text fg={th().text.muted}>
            {props.total === 0
              ? "No Runs in this project yet. Ask the agent to run a workflow, or type /workflow <name>."
              : "No Runs match this filter (f to change it)."}
          </text>
        }
      >
        <text fg={th().text.muted}>{`${"  "}${renderHeader([statusColumn()])} ${renderHeader(rest())}`}</text>
        <For each={props.entries.slice(window().start, window().end)}>
          {(entry, index) => {
            const absolute = () => window().start + index()
            const cells = () => libraryCells(entry, props.wf.now())
            const look = () => runStatus(entry)
            return (
              <Row
                wf={props.wf}
                selected={absolute() === props.cursor}
                status={cells().status}
                statusWidth={statusColumn().width}
                tone={look().tone}
                rest={renderRow(rest(), cells())}
                onClick={() => props.onPick(absolute())}
              />
            )
          }}
        </For>
        <Show when={props.entries.length > window().end - window().start}>
          <text fg={th().text.muted}>{`  ${props.cursor + 1}/${props.entries.length}`}</text>
        </Show>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------

function phaseLine(run: Run): Array<{ text: string; tone: Tone }> {
  if (run.phases.length === 0) return []
  const index = run.currentPhase ? run.phases.indexOf(run.currentPhase) : -1
  const finished = isTerminal(run.status)
  return run.phases.map((phase, position) => {
    if (position < index || (finished && position === index && run.status === "succeeded"))
      return { text: `✓ ${phase}`, tone: "success" as Tone }
    if (position === index) return { text: `● ${phase}`, tone: finished ? ("warning" as Tone) : ("info" as Tone) }
    return { text: `○ ${phase}`, tone: "muted" as Tone }
  })
}

function RunPane(props: {
  wf: Wf
  run: Run
  activity: readonly { message: string; kind: string; time: number }[] | null
  cursor: number
  width: number
  height: number
  answer: AnswerState | null
  interaction: PendingInteraction | undefined
  sending: boolean
  onPick: (index: number) => void
  onAnswer: () => void
  onAnswerText: (text: string) => void
  onPickOption: (index: number) => void
}) {
  const context = props.wf.context
  const th = () => context.theme
  const look = () => runStatus(props.run)
  const columns = () => layout(UNIT_COLUMNS, props.width - MARKER.length)
  const statusColumn = () => columns().find((column) => column.id === "status")!
  const rest = () => columns().filter((column) => column.id !== "status")
  const activityLines = () => {
    const entries =
      props.activity ?? props.run.logs.map((message) => ({ message, kind: "log", time: props.run.startedAt }))
    return entries.slice(-3)
  }
  const answerRows = () =>
    props.answer && props.interaction
      ? Math.min(props.height - 6, 8 + (props.interaction.approval ? 12 : 0) + rows(props.answer).length)
      : 0
  const unitRows = () =>
    Math.max(
      3,
      props.height -
        5 -
        answerRows() -
        (props.run.errors.length ? 2 : 0) -
        (props.run.resultPreview ? 1 : 0) -
        activityLines().length -
        1,
    )
  const window = () => visibleWindow(props.run.units.length, props.cursor, unitRows())

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <text fg={toneColor(context, look().tone)}>{`${look().glyph} ${look().word}`}</text>
        <text fg={th().text.base}>
          {truncate(`  ${runSummary(props.run, props.wf.now())}`, props.width - look().word.length - 2)}
        </text>
      </box>
      <Show when={props.run.workflow.description}>
        <text fg={th().text.muted}>{truncate(props.run.workflow.description, props.width)}</text>
      </Show>
      <Show when={phaseLine(props.run).length > 0}>
        <box flexDirection="row" flexWrap="wrap">
          <For each={phaseLine(props.run)}>
            {(part, index) => (
              <text
                fg={toneColor(context, part.tone)}
              >{`${part.text}${index() < phaseLine(props.run).length - 1 ? "  ›  " : ""}`}</text>
            )}
          </For>
        </box>
      </Show>
      <Show
        when={props.answer && props.interaction}
        fallback={
          <Show when={props.run.interactions.length > 0}>
            <box flexDirection="row" backgroundColor={th().background.raised.base} onMouseDown={() => props.onAnswer()}>
              <text fg={th().text.feedback.warning.base}>
                {truncate(
                  `? ${props.run.interactions.length} waiting — ${props.run.interactions[0]!.questions[0]?.header ?? props.run.interactions[0]!.kind}: ${props.run.interactions[0]!.questions[0]?.prompt ?? ""}  (a to answer)`,
                  props.width,
                )}
              </text>
            </box>
          </Show>
        }
      >
        <AnswerPanel
          wf={props.wf}
          state={props.answer!}
          interaction={props.interaction!}
          width={props.width}
          height={answerRows()}
          sending={props.sending}
          onText={props.onAnswerText}
          onPickOption={props.onPickOption}
        />
      </Show>
      <text fg={th().text.muted}>{`  ${renderHeader([statusColumn()])} ${renderHeader(rest())}`}</text>
      <Show when={props.run.units.length > 0} fallback={<text fg={th().text.muted}> No Units yet.</text>}>
        <For each={props.run.units.slice(window().start, window().end)}>
          {(unit, index) => {
            const absolute = () => window().start + index()
            const cells = () => unitCells(unit, props.wf.now())
            return (
              <Row
                wf={props.wf}
                selected={absolute() === props.cursor && !props.answer}
                status={cells().status}
                statusWidth={statusColumn().width}
                tone={unitStatus(unit.status).tone}
                rest={renderRow(rest(), cells())}
                onClick={() => props.onPick(absolute())}
              />
            )
          }}
        </For>
      </Show>
      <Show when={props.run.errors.length > 0}>
        <text fg={th().text.feedback.error.base}>
          {truncate(
            `✗ ${props.run.errors.length} error${props.run.errors.length === 1 ? "" : "s"} — last: ${props.run.errors[props.run.errors.length - 1]!.error}`,
            props.width,
          )}
        </text>
      </Show>
      <Show when={props.run.resultPreview}>
        <text fg={th().text.base}>{truncate(`result: ${props.run.resultPreview}`, props.width)}</text>
      </Show>
      <For each={activityLines()}>
        {(entry) => <text fg={th().text.muted}>{truncate(`· ${entry.message}`, props.width)}</text>}
      </For>
    </box>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Answer panel
// ---------------------------------------------------------------------------------------------------------------

function AnswerPanel(props: {
  wf: Wf
  state: AnswerState
  interaction: PendingInteraction
  width: number
  height: number
  sending: boolean
  onText: (text: string) => void
  onPickOption: (index: number) => void
}) {
  const context = props.wf.context
  const th = () => context.theme
  const question = () => currentQuestion(props.state)
  const kindLabel = () => {
    const interaction = props.interaction
    if (interaction.kind === "approval") return "Approval"
    if (interaction.kind === "permission") return "Permission"
    return interaction.form
      ? "Question (OpenCode form)"
      : interaction.origin === "script"
        ? "Question from the workflow"
        : "Question from a Unit"
  }
  const width = () => props.width - 2
  let input: InputRenderable | undefined
  const previewLines = () =>
    props.interaction.approval ? wrapLines(props.interaction.approval.preview, width() - 2).slice(0, 10) : []
  return (
    <box flexDirection="column" backgroundColor={th().background.raised.base} paddingLeft={1} paddingRight={1}>
      <text fg={th().text.feedback.warning.base}>
        {truncate(
          `? ${kindLabel()} · ${question()?.header ?? ""}${props.state.questions.length > 1 ? `  (${props.state.index + 1}/${props.state.questions.length})` : ""}`,
          width(),
        )}
      </text>
      <For each={wrapLines(question()?.prompt ?? "", width()).slice(0, 3)}>
        {(line) => <text fg={th().text.base}>{line}</text>}
      </For>
      <Show when={props.interaction.permission}>
        <text fg={th().text.muted}>
          {truncate(
            `${props.interaction.permission!.action}: ${props.interaction.permission!.resources.join(", ") || "(no resource)"}`,
            width(),
          )}
        </text>
      </Show>
      <Show when={props.interaction.approval}>
        <text fg={th().text.muted}>
          {truncate(
            `sha256 ${props.interaction.approval!.sha256} · ${props.interaction.approval!.bytes} bytes`,
            width(),
          )}
        </text>
        <box flexDirection="column" backgroundColor={th().background.raised.high} paddingLeft={1}>
          <For each={previewLines()}>{(line) => <text fg={th().text.base}>{line || " "}</text>}</For>
        </box>
      </Show>
      <For each={rows(props.state)}>
        {(row, index) => {
          const selected = () => index() === props.state.cursor && !props.state.typing
          const box = () =>
            row.kind === "custom"
              ? "✎"
              : question()?.multiple
                ? row.checked
                  ? "[x]"
                  : "[ ]"
                : row.checked
                  ? "(•)"
                  : "( )"
          const text = () =>
            row.kind === "custom"
              ? `${index() + 1}. ${box()} ${row.label}${row.typed.length ? `: ${row.typed.join(", ")}` : ""}`
              : `${index() + 1}. ${box()} ${row.label}${row.description ? ` — ${row.description}` : ""}`
          return (
            <box
              flexDirection="row"
              backgroundColor={selected() ? th().background.raised.high : undefined}
              onMouseDown={() => props.onPickOption(index())}
            >
              <text fg={th().text.base}>{selected() ? MARKER : "  "}</text>
              <text fg={selected() ? th().text.base : th().text.base}>{truncate(text(), width() - 2)}</text>
            </box>
          )
        }}
      </For>
      <Show when={props.state.typing}>
        <box flexDirection="row">
          <text fg={th().text.base}>{MARKER}</text>
          <input
            ref={(renderable: InputRenderable) => (input = renderable)}
            focused={props.state.typing}
            placeholder="Type your answer · Enter to send · Esc to go back"
            width={width() - 2}
            backgroundColor={th().background.formfield.base}
            textColor={th().text.formfield.base}
            focusedBackgroundColor={th().background.formfield.focused}
            focusedTextColor={th().text.formfield.focused}
            placeholderColor={th().text.muted}
            // OpenTUI types `onSubmit` as both a SubmitEvent and a value handler; read the value either way.
            onSubmit={
              ((value: unknown) => props.onText(typeof value === "string" ? value : (input?.value ?? ""))) as never
            }
          />
        </box>
      </Show>
      <text fg={th().text.muted}>
        {truncate(
          props.sending
            ? "Sending…"
            : props.state.typing
              ? "enter send · esc back"
              : `↑↓ move · ${question()?.multiple ? "space toggle · " : ""}enter choose · 1-9 pick · x dismiss · esc back`,
          width(),
        )}
      </text>
    </box>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------------------------------------------

function UnitPane(props: {
  wf: Wf
  run: Run
  unit: Unit
  width: number
  height: number
  scroll: number
  onScroll: (value: number) => void
}) {
  const context = props.wf.context
  const th = () => context.theme
  const [full, setFull] = createSignal<string | null>(null)
  createEffect(
    on(
      () => `${props.unit.unitId}:${props.unit.outputElided ? "elided" : "inline"}:${props.unit.status}`,
      () => {
        setFull(null)
        if (!props.unit.outputElided) return
        void props.wf.loadUnit(props.run.runId, props.unit.unitId).then((unit) => setFull(unit?.output ?? null))
      },
    ),
  )
  const look = () => unitStatus(props.unit.status)
  const meta = (): string[] => {
    const unit = props.unit
    const model = unit.model.resolved ?? unit.model.requested
    return [
      [
        `agent ${unit.subagent}`,
        model
          ? `model ${model}${unit.model.requested && unit.model.resolved && unit.model.requested !== unit.model.resolved ? ` (asked ${unit.model.requested})` : ""}`
          : "",
        unit.phase ? `phase ${unit.phase}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      [
        `${formatTokens(unit.usage.tokens.input)} in / ${formatTokens(unit.usage.tokens.output)} out`,
        formatCost(unit.usage.cost),
        unit.startedAt ? formatElapsed((unit.endedAt ?? props.wf.now()) - unit.startedAt) : "not started",
        unit.schema ? `typed result${unit.resultPath ? ` via ${unit.resultPath}` : ""}` : "",
        unit.sessionID ? `session ${unit.sessionID}` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      ...unit.attempts.map(
        (attempt) => `attempt ${attempt.turn}: ${attempt.path} ${attempt.ok ? "✓" : `✗ ${attempt.error ?? ""}`}`,
      ),
      ...(unit.error ? [`error: ${unit.error}`] : []),
    ]
  }
  const output = () =>
    full() ??
    props.unit.output ??
    (props.unit.outputElided
      ? "Loading the full output…"
      : props.unit.status === "running" || props.unit.status === "queued"
        ? "(no output yet)"
        : "(no output)")
  const promptLines = () => wrapLines(props.unit.prompt, props.width - 2).slice(0, 4)
  const outputLines = () => wrapLines(output(), props.width)
  const room = () => Math.max(3, props.height - 3 - meta().length - promptLines().length)
  const offset = () => Math.max(0, Math.min(props.scroll, Math.max(0, outputLines().length - room())))
  return (
    <box
      flexDirection="column"
      onMouseScroll={(event: { scroll?: { direction?: string } }) =>
        props.onScroll(offset() + (event.scroll?.direction === "up" ? -3 : 3))
      }
    >
      <box flexDirection="row">
        <text fg={toneColor(context, look().tone)}>{`${look().glyph} ${look().word}`}</text>
        <text fg={th().text.base}>{truncate(`  ${unitName(props.unit)}`, props.width - look().word.length - 2)}</text>
      </box>
      <For each={meta()}>
        {(line) => (
          <text fg={line.startsWith("error:") ? th().text.feedback.error.base : th().text.muted}>
            {truncate(line, props.width)}
          </text>
        )}
      </For>
      <For each={promptLines()}>{(line) => <text fg={th().text.muted}>{`> ${line}`}</text>}</For>
      <box flexDirection="column" backgroundColor={th().background.raised.base}>
        <For each={outputLines().slice(offset(), offset() + room())}>
          {(line) => <text fg={th().text.base}>{line || " "}</text>}
        </For>
      </box>
      <Show when={outputLines().length > room()}>
        <text
          fg={th().text.muted}
        >{`lines ${offset() + 1}-${Math.min(outputLines().length, offset() + room())} of ${outputLines().length} (j/k scroll)`}</text>
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Session surfaces
// ---------------------------------------------------------------------------------------------------------------

/** The laid-out width of a box (slots do not say how wide they are). */
function useWidth(initial: number) {
  const [width, setWidth] = createSignal(initial)
  let box: BoxRenderable | undefined
  return {
    width,
    ref: (renderable: BoxRenderable) => {
      box = renderable
    },
    onSizeChange: () => {
      if (box && box.width > 0) setWidth(box.width)
    },
  }
}

/** The composer strip: only while a Run of this session is live. Click opens the session panel. */
export function Strip(props: { wf: Wf; sessionID: string }) {
  const th = () => props.wf.context.theme
  const measured = useWidth(60)
  const entries = () => sessionEntries(props.wf.state(), props.sessionID)
  const text = () => stripText(entries(), props.wf.now(), Math.max(20, measured.width()))
  const waiting = () => entries().some((entry) => entry.live && entry.waiting)
  return (
    <Show when={text()}>
      <box
        ref={measured.ref}
        onSizeChange={measured.onSizeChange}
        width="100%"
        flexDirection="row"
        backgroundColor={th().background.raised.base}
        onMouseDown={() => {
          const first = entries().find((entry) => entry.live && entry.waiting) ?? entries().find((entry) => entry.live)
          props.wf.actions.openPanel(first?.runId, props.sessionID)
        }}
      >
        <text fg={waiting() ? th().text.feedback.warning.base : th().text.base}>{text()}</text>
      </box>
    </Show>
  )
}

/** Sidebar block: two lines per Run of this session (most recent four). Click opens the panel on that Run. */
export function SidebarRuns(props: { wf: Wf; sessionID: string }) {
  const th = () => props.wf.context.theme
  const entries = () => sessionEntries(props.wf.state(), props.sessionID).slice(0, 4)
  const measured = useWidth(36)
  return (
    <Show when={entries().length > 0}>
      <box flexDirection="column" width="100%" ref={measured.ref} onSizeChange={measured.onSizeChange}>
        <text fg={th().text.base}>
          <b>Workflows</b>
        </text>
        <For each={entries()}>
          {(entry) => {
            const lines = () => sidebarLines(entry, props.wf.now(), Math.max(12, measured.width()))
            return (
              <box flexDirection="column" onMouseDown={() => props.wf.actions.openPanel(entry.runId, props.sessionID)}>
                <text fg={toneColor(props.wf.context, runStatus(entry).tone)}>{lines()[0]}</text>
                <text fg={th().text.muted}>{lines()[1]}</text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

/** The session panel: the Workflows screen scoped to this session's Runs. */
export function RunPanel(props: {
  wf: Wf
  panel: PanelInput
  target: () => { runId?: string; answer?: boolean } | undefined
  focusOnOpen: () => boolean
}) {
  const dims = useTerminalDimensions()
  onMount(() => {
    if (props.focusOnOpen()) props.panel.focus()
  })
  return (
    <WorkflowsScreen
      wf={props.wf}
      entries={() => sessionEntries(props.wf.state(), props.panel.sessionID)}
      start={props.target}
      root="library"
      title="Workflows (this session)"
      active={() => props.panel.focused}
      width={() => props.panel.width}
      height={() => dims().height - 2}
      escapeBack={false}
      onExit={() => props.panel.close()}
    />
  )
}

/** The `/workflows` page: every Run of the location. */
export function LibraryPage(props: {
  wf: Wf
  data: () => { runId?: string; unitId?: string; answer?: boolean } | undefined
  onExit: () => void
}) {
  const dims = useTerminalDimensions()
  return (
    <WorkflowsScreen
      wf={props.wf}
      entries={() =>
        Object.values(props.wf.state().runs)
          .map((slot) => slot.entry)
          .toSorted((a, b) => b.startedAt - a.startedAt)
      }
      start={props.data}
      root="library"
      title="Workflows"
      active={() => true}
      width={() => dims().width}
      height={() => dims().height}
      escapeBack={true}
      onExit={props.onExit}
    />
  )
}

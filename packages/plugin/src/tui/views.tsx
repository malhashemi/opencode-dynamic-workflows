/**
 * The TUI's components: the Workflows screen (library → Run → Unit, used by the `/workflows` page and the session
 * panel), the answer panel, the composer strip and the sidebar block.
 *
 * All logic lives in the plain modules beside this file; components only read state, lay out text and route keys
 * and clicks to actions. The look is OpenCode's own (see `ui.tsx`): raised cards with a `┃` bar in the status
 * colour, bold section titles, `key label` hints. Colour comes only from the active theme; a selected row is
 * `background.raised.high` with the accent bar, and every status is a glyph and a word.
 */
import type { Context, KeymapCommand, PanelInput } from "@opencode/plugin/tui/context"
import type { BoxRenderable, InputRenderable, RGBA, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, Match, on, onMount, Show, Switch, type Accessor } from "solid-js"

import { formatClock, formatElapsed, formatTokens, meter, settledUnits } from "../progress"
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
import { ApprovalPanel } from "./approval"
import {
  LIBRARY_COLUMNS,
  UNIT_COLUMNS,
  elapsedOf,
  totalTokens,
  type Column,
  type LibraryColumn,
  type StatusLook,
  type UnitColumn,
  formatCost,
  layout,
  libraryCells,
  renderHeader,
  runStatus,
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
import {
  ACCENT_BORDER,
  Card,
  CellRow,
  fitCells,
  KeyHints,
  Section,
  toneColor as toneOf,
  useSyntax,
  type Cell,
  type Hint,
} from "./ui"

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
  /** Open a web app page in the system browser. */
  openInBrowser(url: string): void
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
  /** The Unit view's output, for the scroll keys. */
  let unitScroller: ScrollBoxRenderable | undefined
  /** The approval panel's source view, for the scroll keys. */
  let approvalScroller: ScrollBoxRenderable | undefined

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
  // Live Runs first: the library shows them as their own group, and the cursor follows the shown order.
  const entries = createMemo(() =>
    filterEntries(props.entries(), nav().filter).toSorted((a, b) => Number(b.live) - Number(a.live)),
  )
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
      unitScroller?.scrollBy(delta)
      return
    }
    setNav(moveCursor(nav(), delta, count()))
  }
  const page = () => Math.max(1, props.height() - 10)

  function openSelected() {
    const v = view()
    if (v.kind === "library") {
      const entry = entries()[cursor(nav(), entries().length)]
      if (!entry) return
      // A queued Run that waits can only be waiting for its approval, and nothing else can happen before it:
      // open straight onto the script.
      if (entry.status === "queued" && entry.waiting) setAutoAnswer(true)
      setNav(push(nav(), { kind: "run", runId: entry.runId }))
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
        { key: "enter", label: "open", run: openSelected },
        { key: "a", label: "answer", run: answerFirst },
        { key: "f", label: `filter: ${nav().filter}`, run: () => void setNav(cycleFilter(nav())) },
        { key: "d", label: "clean up finished", run: () => void wf.actions.cleanupPending() },
        ...(webLink() ? [{ key: "b", label: "open in browser", run: () => wf.actions.openInBrowser(webLink()!) }] : []),
        { key: "p", label: "pair a device", run: () => void wf.actions.pair() },
        { key: "r", label: "refresh", run: () => void wf.actions.refresh() },
        ...common,
      ]
    }
    const target = run()
    const terminal = target ? isTerminal(target.status) : false
    if (v.kind === "run") {
      return [
        { key: "enter", label: "unit", run: openSelected },
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
        ...(webLink() ? [{ key: "b", label: "open in browser", run: () => wf.actions.openInBrowser(webLink()!) }] : []),
        { key: "p", label: "parent session", run: withRun((t) => wf.actions.openTranscript(t.parentSessionID)) },
        ...common,
      ]
    }
    return [
      { key: "↑↓", label: "scroll", run: () => moveBy(3) },
      { key: "o", label: "transcript", run: openUnitTranscript },
      ...(webLink() ? [{ key: "b", label: "open in browser", run: () => wf.actions.openInBrowser(webLink()!) }] : []),
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
  // An inline approval: ←/→ choose (the buttons are a row), ↑/↓ and the page keys scroll the script.
  const approving = () => !!pendingInteraction()?.approval
  const scrollSource = (delta: number, unit: "absolute" | "viewport" = "absolute") =>
    approvalScroller?.scrollBy(delta, unit)
  const approvalKeys = (): KeymapCommand[] => [
    { title: "Previous choice", group: "Approval", bind: "left", run: () => void setAnswer(move(answer()!, -1)) },
    { title: "Previous choice", group: "Approval", bind: "h", run: () => void setAnswer(move(answer()!, -1)) },
    { title: "Next choice", group: "Approval", bind: "right", run: () => void setAnswer(move(answer()!, 1)) },
    { title: "Next choice", group: "Approval", bind: "l", run: () => void setAnswer(move(answer()!, 1)) },
    { title: "Scroll down", group: "Approval", bind: "down", run: () => scrollSource(1) },
    { title: "Scroll down", group: "Approval", bind: "j", run: () => scrollSource(1) },
    { title: "Scroll up", group: "Approval", bind: "up", run: () => scrollSource(-1) },
    { title: "Scroll up", group: "Approval", bind: "k", run: () => scrollSource(-1) },
    { title: "Page down", group: "Approval", bind: "pagedown", run: () => scrollSource(0.5, "viewport") },
    { title: "Page down", group: "Approval", bind: "space", run: () => scrollSource(0.5, "viewport") },
    { title: "Page up", group: "Approval", bind: "pageup", run: () => scrollSource(-0.5, "viewport") },
    { title: "Top", group: "Approval", bind: "home", run: () => approvalScroller?.scrollTo(0) },
    { title: "End", group: "Approval", bind: "end", run: () => approvalScroller?.scrollTo(Number.MAX_SAFE_INTEGER) },
  ]
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
        title: "Open in the web app",
        group: "Workflows",
        bind: "b",
        enabled: () => !!webLink(),
        run: () => void (webLink() && wf.actions.openInBrowser(webLink()!)),
      },
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
    // Above the answer layer: these keys scroll and pick here; Enter, Esc and 1-9 fall through to it.
    enabled: () => choosing() && approving(),
    priority: 70,
    commands: approvalKeys(),
  }))

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
    return parts.map((part) => truncate(part, Math.max(12, Math.floor(innerWidth() / parts.length) - 4)))
  }
  // The web app page for what is on screen: the library, or the Run being looked at.
  const webLink = () => {
    const base = wf.state().webUrl?.replace(/\/$/, "")
    if (!base) return null
    const v = view()
    return v.kind === "library" ? base : `${base}/runs/${v.runId}`
  }
  const libraryCounts = () => {
    const all = props.entries()
    const live = all.filter((entry) => entry.live).length
    const waiting = all.filter((entry) => entry.waiting).length
    return [
      `${all.length} run${all.length === 1 ? "" : "s"}`,
      live ? `${live} live` : "",
      waiting ? `${waiting} waiting` : "",
      nav().filter !== "all" ? `filter: ${nav().filter}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  }

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
        <text fg={th().text.muted}>
          <span style={{ fg: th().background.action.primary.focused }}>⟡ </span>
          <For each={crumbs()}>
            {(part, index) => (
              <>
                {index() > 0 ? " › " : ""}
                <span style={{ fg: index() === crumbs().length - 1 ? th().text.base : th().text.muted }}>
                  {index() === crumbs().length - 1 ? <b>{part}</b> : part}
                </span>
              </>
            )}
          </For>
        </text>
        <box flexDirection="row" gap={3} flexShrink={0}>
          <Show when={view().kind === "library" && innerWidth() > 60}>
            <text fg={th().text.muted}>{libraryCounts()}</text>
          </Show>
          <Show when={webLink() && innerWidth() > 50}>
            <text fg={th().text.muted}>
              {"web "}
              <a href={webLink()!} style={{ fg: th().text.feedback.info.base }}>
                {webLink()!
                  .replace(/^https?:\/\//, "")
                  .replace(/\/runs\/([0-9a-f-]{8})[0-9a-f-]*$/, "/runs/$1…")}
              </a>
            </text>
          </Show>
        </box>
      </box>
      <Show when={wf.error()}>
        <text fg={th().text.feedback.error.base}>{truncate(`! ${wf.error()}`, innerWidth())}</text>
      </Show>
      <Show when={note()}>
        <text fg={toneColor(context, note()!.tone)}>{truncate(note()!.text, innerWidth())}</text>
      </Show>
      <box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        <Switch>
          <Match when={view().kind === "library"}>
            <LibraryPane
              wf={wf}
              entries={entries()}
              filter={nav().filter}
              cursor={cursor(nav(), entries().length)}
              width={innerWidth()}
              height={props.height() - 3}
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
                // The hints row is hidden while answering: the answer panel gets those rows too.
                height={props.height() - (answer() ? 2 : 4)}
                answer={answer()}
                interaction={pendingInteraction()}
                sending={sending()}
                onApprovalScroller={(box) => (approvalScroller = box)}
                onSelectOption={(index) => void setAnswer({ ...answer()!, cursor: index })}
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
                height={props.height() - 3}
                scroller={(box) => (unitScroller = box)}
              />
            </Show>
          </Match>
        </Switch>
      </box>
      <Show when={answer() === null}>
        <KeyHints theme={th()} hints={hints()} />
      </Show>
    </box>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------------------------------------------

/** The coloured cells of one library row, fitted to the columns. */
function libraryRow(
  theme: Context["theme"],
  entry: LibraryEntry,
  columns: readonly Column<LibraryColumn>[],
  now: number,
) {
  const cells = libraryCells(entry, now)
  const look = runStatus(entry)
  const muted = theme.text.muted
  const unitsDone = entry.units > 0 && entry.settledUnits === entry.units
  const pieces = (id: LibraryColumn): Cell[] => {
    switch (id) {
      case "status":
        return [{ text: cells.status, fg: toneOf(theme, look.tone) }]
      case "workflow":
        return [
          { text: workflowName(entry), fg: theme.text.base, bold: entry.live },
          { text: entry.workflow.provenance === "inline" ? "  inline" : "", fg: muted },
        ]
      case "units":
        return entry.units === 0
          ? [{ text: "–", fg: muted }]
          : [
              {
                text: `${meter(entry.settledUnits / entry.units, 4)} `,
                fg: unitsDone ? theme.text.feedback.success.base : theme.text.feedback.info.base,
              },
              { text: cells.units, fg: muted },
            ]
      default:
        return [{ text: cells[id], fg: muted }]
    }
  }
  return columns.flatMap((column, index) => [
    ...(index > 0 ? [{ text: " ", fg: muted }] : []),
    ...fitCells(pieces(column.id), column.width, column.align),
  ])
}

function LibraryPane(props: {
  wf: Wf
  entries: LibraryEntry[]
  filter: string
  cursor: number
  width: number
  height: number
  onPick: (index: number) => void
}) {
  const th = () => props.wf.context.theme
  const columns = () => layout(LIBRARY_COLUMNS, props.width - 2)
  const live = () => props.entries.filter((entry) => entry.live).length
  // Live Runs first (the list is sorted that way), each group under its own title.
  const window = () => visibleWindow(props.entries.length, props.cursor, Math.max(3, props.height - 5))
  const shown = () =>
    props.entries.slice(window().start, window().end).map((entry, index) => ({ entry, index: window().start + index }))
  const titleBefore = (index: number) => {
    const entry = props.entries[index]!
    if (index === window().start) return true
    return props.entries[index - 1]!.live !== entry.live
  }
  return (
    <box flexDirection="column">
      <Show
        when={props.entries.length > 0}
        fallback={
          <box paddingTop={1}>
            <Card theme={th()} accent={th().border.base}>
              <text fg={th().text.base}>
                <b>{props.filter === "all" ? "No Runs yet" : "Nothing matches this filter"}</b>
              </text>
              <text fg={th().text.muted}>
                {props.filter === "all"
                  ? "Ask the agent to run a workflow, or type /workflow <name>."
                  : "Press f to change the filter."}
              </text>
            </Card>
          </box>
        }
      >
        <For each={shown()}>
          {(item) => (
            <>
              <Show when={titleBefore(item.index)}>
                <Section
                  theme={th()}
                  title={item.entry.live ? "Live" : "Recent"}
                  detail={item.entry.live ? String(live()) : String(props.entries.length - live())}
                />
              </Show>
              <CellRow
                theme={th()}
                selected={item.index === props.cursor}
                cells={libraryRow(th(), item.entry, columns(), props.wf.now())}
                onClick={() => props.onPick(item.index)}
              />
            </>
          )}
        </For>
        <Show when={props.entries.length > window().end - window().start}>
          <text fg={th().text.muted}>{`  ${props.cursor + 1} of ${props.entries.length}`}</text>
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

/** Status word and name on the left, the figures on the right: the first line of every header card. */
function TitleLine(props: { theme: Context["theme"]; look: StatusLook; name: string; figures: string; width: number }) {
  const left = () => props.look.word.length + 3 + props.name.length
  return (
    <box flexDirection="row" justifyContent="space-between">
      <box flexDirection="row" gap={1}>
        <text fg={toneOf(props.theme, props.look.tone)}>
          <b>{`${props.look.glyph} ${props.look.word}`}</b>
        </text>
        <text fg={props.theme.text.base}>
          <b>{truncate(props.name, Math.max(8, props.width - props.look.word.length - 4))}</b>
        </text>
      </box>
      <Show when={props.width - left() > props.figures.length + 4}>
        <text fg={props.theme.text.muted}>{props.figures}</text>
      </Show>
    </box>
  )
}

/** The coloured cells of one Unit row. */
function unitRow(theme: Context["theme"], unit: Unit, columns: readonly Column<UnitColumn>[], now: number) {
  const cells = unitCells(unit, now)
  const muted = theme.text.muted
  const pieces = (id: UnitColumn): Cell[] => {
    if (id === "status") return [{ text: cells.status, fg: toneOf(theme, unitStatus(unit.status).tone) }]
    if (id === "name") return [{ text: cells.name, fg: theme.text.base }]
    return [{ text: cells[id], fg: muted }]
  }
  return columns.flatMap((column, index) => [
    ...(index > 0 ? [{ text: " ", fg: muted }] : []),
    ...fitCells(pieces(column.id), column.width, column.align),
  ])
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
  onApprovalScroller: (box: ScrollBoxRenderable) => void
  onSelectOption: (index: number) => void
  onPick: (index: number) => void
  onAnswer: () => void
  onAnswerText: (text: string) => void
  onPickOption: (index: number) => void
}) {
  const context = props.wf.context
  const th = () => context.theme
  const syntax = useSyntax(th)
  const look = () => runStatus(props.run)
  const columns = () => layout(UNIT_COLUMNS, props.width - 2)
  // The activity tail only when there is room for it after the Units.
  const activityLines = () => {
    if (props.height < 28) return []
    const entries =
      props.activity ?? props.run.logs.map((message) => ({ message, kind: "log", time: props.run.startedAt }))
    return entries.slice(-3)
  }
  const figures = () =>
    [
      formatElapsed(elapsedOf(props.run, props.wf.now())),
      `${formatTokens(totalTokens(props.run.usage))} tok`,
      formatCost(props.run.usage.cost),
    ].join(" · ")
  const settled = () => settledUnits(props.run)
  // Pretty-printed when the preview is whole JSON (a long result is clipped, and then shown as it is).
  const result = () => {
    const preview = props.run.resultPreview
    if (!preview) return preview
    try {
      return JSON.stringify(JSON.parse(preview), null, 2)
    } catch {
      return preview
    }
  }
  const resultIsJson = () => /^[[{]/.test(result()?.trim() ?? "")
  const resultRows = () =>
    Math.min(6, Math.max(2, Math.floor(props.height / 6)), wrapLines(result() ?? "", props.width - 6).length)
  const lastError = () => props.run.errors[props.run.errors.length - 1]
  // An inline approval comes before the Run starts (no Units yet): it takes the whole view.
  const approving = () => !!(props.answer && props.interaction?.approval)
  const answerRows = () =>
    !props.answer || !props.interaction ? 0 : Math.min(props.height - 6, 11 + 2 * rows(props.answer).length)
  const headerRows = () =>
    4 +
    (props.run.workflow.description ? 1 : 0) +
    (phaseLine(props.run).length ? 1 : 0) +
    (props.run.budget.total !== null ? 1 : 0)
  const unitRows = () =>
    Math.max(
      3,
      props.height -
        headerRows() -
        answerRows() -
        (!props.answer && props.run.interactions.length ? 3 : 0) -
        4 -
        (result() ? resultRows() + 3 : 0) -
        (lastError() ? 5 : 0) -
        (activityLines().length ? activityLines().length + 2 : 0),
    )
  const window = () => visibleWindow(props.run.units.length, props.cursor, unitRows())
  const waitingFirst = () => props.run.interactions[0]

  return (
    <Show
      when={!approving()}
      fallback={
        <ApprovalPanel
          wf={props.wf}
          interaction={props.interaction!}
          selected={props.answer!.cursor}
          sending={props.sending}
          height={props.height}
          onSelect={props.onSelectOption}
          onChoose={props.onPickOption}
          scroller={props.onApprovalScroller}
        />
      }
    >
      <box flexDirection="column">
        <Card theme={th()} accent={toneOf(th(), look().tone)}>
          <TitleLine
            theme={th()}
            look={look()}
            name={workflowName(props.run)}
            figures={figures()}
            width={props.width - 4}
          />
          <Show when={props.run.workflow.description}>
            <text flexShrink={0} fg={th().text.muted}>
              {truncate(props.run.workflow.description, props.width - 4)}
            </text>
          </Show>
          <Show when={phaseLine(props.run).length > 0}>
            <box flexDirection="row" flexWrap="wrap">
              <For each={phaseLine(props.run)}>
                {(part, index) => (
                  <text flexShrink={0} fg={toneOf(th(), part.tone)}>
                    {part.text}
                    <span style={{ fg: th().text.muted }}>
                      {index() < phaseLine(props.run).length - 1 ? " ── " : ""}
                    </span>
                  </text>
                )}
              </For>
            </box>
          </Show>
          <Show when={props.run.budget.total !== null}>
            <text flexShrink={0} fg={th().text.muted}>
              {`budget ${meter(props.run.tokensSpent / (props.run.budget.total || 1), 10)} ${formatTokens(props.run.tokensSpent)} of ${formatTokens(props.run.budget.total ?? 0)}${props.run.budget.hard ? " (hard)" : ""}`}
            </text>
          </Show>
        </Card>

        <Show
          when={props.answer && props.interaction}
          fallback={
            <Show when={waitingFirst()}>
              <box paddingTop={1}>
                <Card
                  theme={th()}
                  accent={th().text.feedback.warning.base}
                  paddingTop={0}
                  paddingBottom={0}
                  onClick={() => props.onAnswer()}
                >
                  <box flexDirection="row" justifyContent="space-between">
                    <text flexShrink={0} fg={th().text.feedback.warning.base}>
                      {truncate(
                        `△ ${waitingFirst()!.questions[0]?.header ?? waitingFirst()!.kind}: ${waitingFirst()!.questions[0]?.prompt ?? ""}`,
                        props.width - 16,
                      )}
                    </text>
                    <text flexShrink={0} fg={th().text.base}>
                      a <span style={{ fg: th().text.muted }}>answer</span>
                    </text>
                  </box>
                </Card>
              </box>
            </Show>
          }
        >
          <box paddingTop={1}>
            <AnswerPanel
              wf={props.wf}
              state={props.answer!}
              interaction={props.interaction!}
              width={props.width}
              height={answerRows()}
              sending={props.sending}
              onText={props.onAnswerText}
              onSelectOption={props.onSelectOption}
              onPickOption={props.onPickOption}
            />
          </box>
        </Show>

        <Section
          theme={th()}
          title="Units"
          detail={props.run.units.length ? `${settled()} of ${props.run.units.length}` : ""}
        />
        <Show
          when={props.run.units.length > 0}
          fallback={
            <text flexShrink={0} fg={th().text.muted}>
              {"  No Units yet."}
            </text>
          }
        >
          <text flexShrink={0} fg={th().text.muted}>{`  ${renderHeader(columns())}`}</text>
          <For each={props.run.units.slice(window().start, window().end)}>
            {(unit, index) => {
              const absolute = () => window().start + index()
              return (
                <CellRow
                  theme={th()}
                  selected={absolute() === props.cursor && !props.answer}
                  cells={unitRow(th(), unit, columns(), props.wf.now())}
                  onClick={() => props.onPick(absolute())}
                />
              )
            }}
          </For>
          <Show when={props.run.units.length > window().end - window().start}>
            <text flexShrink={0} fg={th().text.muted}>{`  ${props.cursor + 1} of ${props.run.units.length}`}</text>
          </Show>
        </Show>

        <Show when={lastError()}>
          <box paddingTop={1}>
            <Card theme={th()} accent={th().text.feedback.error.base} paddingTop={0} paddingBottom={0}>
              <text flexShrink={0} fg={th().text.feedback.error.base}>
                <b>{`✗ ${props.run.errors.length} error${props.run.errors.length === 1 ? "" : "s"}`}</b>
                <span style={{ fg: th().text.muted }}>{lastError()!.unit ? `  in ${lastError()!.unit}` : ""}</span>
              </text>
              <For each={wrapLines(lastError()!.error, props.width - 6).slice(0, 2)}>
                {(line) => (
                  <text flexShrink={0} fg={th().text.base}>
                    {line}
                  </text>
                )}
              </For>
            </Card>
          </box>
        </Show>

        <Show when={result()}>
          <Section theme={th()} title="Result" />
          <box paddingLeft={2} paddingRight={1} height={resultRows()} flexShrink={0}>
            <Show
              when={resultIsJson()}
              fallback={
                <For each={wrapLines(result()!, props.width - 6).slice(0, resultRows())}>
                  {(line) => (
                    <text flexShrink={0} fg={th().text.base}>
                      {line}
                    </text>
                  )}
                </For>
              }
            >
              <code
                filetype="json"
                content={result()!}
                syntaxStyle={syntax()}
                fg={th().text.base}
                drawUnstyledText={true}
                conceal={false}
                wrapMode="word"
              />
            </Show>
          </box>
        </Show>

        <Show when={activityLines().length > 0}>
          <Section theme={th()} title="Activity" />
          <For each={activityLines()}>
            {(entry) => (
              <text flexShrink={0} fg={th().text.muted}>
                {`  ${formatClock(entry.time)}  `}
                <span style={{ fg: entry.kind === "phase" ? th().text.feedback.info.base : th().text.muted }}>
                  {entry.kind === "phase" ? "›" : "·"}
                </span>
                <span style={{ fg: th().text.base }}>{` ${truncate(entry.message, props.width - 12)}`}</span>
              </text>
            )}
          </For>
        </Show>
      </box>
    </Show>
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
  onSelectOption: (index: number) => void
  onPickOption: (index: number) => void
}) {
  const context = props.wf.context
  const th = () => context.theme
  const question = () => currentQuestion(props.state)
  const kindLabel = () => {
    const interaction = props.interaction
    if (interaction.kind === "permission") return "Permission"
    return interaction.form
      ? "Question (OpenCode form)"
      : interaction.origin === "script"
        ? "Question from the workflow"
        : "Question from a Unit"
  }
  const width = () => props.width - 6
  let input: InputRenderable | undefined
  const promptLines = () => wrapLines(question()?.prompt ?? "", width()).slice(0, 3)
  // Only the options that fit the rows this panel is given, kept around the cursor; the rest are counted.
  const optionRows = () => rows(props.state)
  const rowHeight = () => (optionRows().some((row) => row.kind === "option" && row.description) ? 2 : 1)
  const optionRoom = () =>
    Math.max(
      1,
      Math.floor(
        (props.height -
          8 -
          promptLines().length -
          (props.interaction.permission ? 1 : 0) -
          (props.state.typing ? 2 : 0)) /
          rowHeight(),
      ),
    )
  const optionWindow = () =>
    optionRows().length <= optionRoom()
      ? { start: 0, end: optionRows().length }
      : visibleWindow(optionRows().length, props.state.cursor, Math.max(1, optionRoom() - 1))
  const hint = (key: string, label: string) => (
    <text fg={th().text.base}>
      {key} <span style={{ fg: th().text.muted }}>{label}</span>
    </text>
  )
  // Laid out like OpenCode's own question form: accent bar, numbered rows, a formfield highlight, ✓ for chosen.
  return (
    <box
      flexDirection="column"
      backgroundColor={th().background.raised.base}
      border={["left"]}
      borderColor={th().background.action.primary.focused}
      customBorderChars={ACCENT_BORDER}
    >
      <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="column">
          <box flexDirection="row" gap={1}>
            <text fg={th().text.feedback.warning.base}>△</text>
            <text fg={th().text.muted}>
              {truncate(
                `${kindLabel()}${question()?.header ? ` · ${question()!.header}` : ""}${props.state.questions.length > 1 ? `  (${props.state.index + 1} of ${props.state.questions.length})` : ""}`,
                width(),
              )}
            </text>
          </box>
          <box flexDirection="column" paddingLeft={2}>
            <For each={promptLines()}>{(line) => <text fg={th().text.base}>{line}</text>}</For>
            <Show when={props.interaction.permission}>
              <text fg={th().text.muted}>
                {truncate(
                  `${props.interaction.permission!.action}: ${props.interaction.permission!.resources.join(", ") || "(no resource)"}`,
                  width(),
                )}
              </text>
            </Show>
          </box>
        </box>
        <box flexDirection="column" paddingLeft={2}>
          <Show when={optionWindow().start > 0}>
            <text fg={th().text.muted}>{`↑ ${optionWindow().start} more`}</text>
          </Show>
          <For each={optionRows().slice(optionWindow().start, optionWindow().end)}>
            {(row, offset) => {
              const index = () => optionWindow().start + offset()
              const active = () => index() === props.state.cursor && !props.state.typing
              const fill = () => (active() ? th().background.formfield.focused : th().background.raised.base)
              const checked = () => (row.kind === "option" ? row.checked : row.typed.length > 0)
              const label = () =>
                row.kind === "custom" ? (row.typed.length ? row.typed.join(", ") : row.label) : row.label
              const description = () => (row.kind === "option" ? row.description : "")
              return (
                <box
                  flexDirection="column"
                  onMouseMove={() => props.onSelectOption(index())}
                  onMouseUp={() => props.onPickOption(index())}
                >
                  <box flexDirection="row">
                    <box backgroundColor={fill()} paddingRight={1}>
                      <text fg={active() ? th().text.formfield.focused : th().text.muted}>{`${index() + 1}.`}</text>
                    </box>
                    <box backgroundColor={fill()} flexDirection="row">
                      <Show when={question()?.multiple}>
                        <text
                          fg={
                            active()
                              ? th().text.formfield.focused
                              : checked()
                                ? th().text.formfield.selected
                                : th().text.muted
                          }
                        >
                          {`[${checked() ? "✓" : " "}] `}
                        </text>
                      </Show>
                      <text
                        fg={
                          active()
                            ? th().text.formfield.focused
                            : row.kind === "custom" && !checked()
                              ? th().text.muted
                              : th().text.formfield.base
                        }
                      >
                        {truncate(label(), width() - 8)}
                      </text>
                    </box>
                    <Show when={!question()?.multiple && checked()}>
                      <text fg={th().text.formfield.selected}> ✓</text>
                    </Show>
                  </box>
                  <Show when={description()}>
                    <box paddingLeft={question()?.multiple ? 7 : 3}>
                      <text fg={th().text.muted}>{truncate(description(), width() - 8)}</text>
                    </box>
                  </Show>
                </box>
              )
            }}
          </For>
          <Show when={optionWindow().end < optionRows().length}>
            <text fg={th().text.muted}>{`↓ ${optionRows().length - optionWindow().end} more`}</text>
          </Show>
          <Show when={props.state.typing}>
            <box flexDirection="row" paddingTop={1}>
              <input
                ref={(renderable: InputRenderable) => (input = renderable)}
                focused={props.state.typing}
                placeholder="Type your answer"
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
        </box>
      </box>
      <box flexDirection="row" flexShrink={0} gap={2} paddingLeft={2} paddingRight={3} paddingBottom={1}>
        <Show when={!props.sending} fallback={<text fg={th().text.muted}>Sending…</text>}>
          <Show
            when={!props.state.typing}
            fallback={
              <>
                {hint("enter", "send")}
                {hint("esc", "back")}
              </>
            }
          >
            {hint("↑↓", "select")}
            <Show when={question()?.multiple}>{hint("space", "toggle")}</Show>
            {hint("enter", "choose")}
            {hint("x", "dismiss")}
            {hint("esc", "back")}
          </Show>
        </Show>
      </box>
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
  scroller: (box: ScrollBoxRenderable) => void
}) {
  const context = props.wf.context
  const th = () => context.theme
  const syntax = useSyntax(th)
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
  const model = () => props.unit.model.resolved ?? props.unit.model.requested
  const details = () =>
    [
      props.unit.subagent,
      model()
        ? `${model()}${props.unit.model.requested && props.unit.model.resolved && props.unit.model.requested !== props.unit.model.resolved ? ` (asked ${props.unit.model.requested})` : ""}`
        : "",
      props.unit.phase ?? "",
      props.unit.schema ? `typed${props.unit.resultPath ? ` via ${props.unit.resultPath}` : ""}` : "",
    ]
      .filter(Boolean)
      .join(" · ")
  const figures = () =>
    [
      props.unit.startedAt
        ? formatElapsed((props.unit.endedAt ?? props.wf.now()) - props.unit.startedAt)
        : "not started",
      `${formatTokens(props.unit.usage.tokens.input)} in · ${formatTokens(props.unit.usage.tokens.output)} out`,
      formatCost(props.unit.usage.cost),
    ].join(" · ")
  const output = () => {
    const text = full() ?? props.unit.output ?? null
    if (!text || !props.unit.schema) return text
    try {
      return JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      return text
    }
  }
  const empty = () =>
    props.unit.outputElided
      ? "Loading the full output…"
      : props.unit.status === "running" || props.unit.status === "queued"
        ? "No output yet."
        : "No output."
  const typed = () => !!props.unit.schema && /^[[{]/.test(output()?.trim() ?? "")
  const promptLines = () => wrapLines(props.unit.prompt, props.width - 6)
  const failedAttempts = () => props.unit.attempts.filter((attempt) => !attempt.ok)
  return (
    <box flexDirection="column" height={props.height}>
      <Card theme={th()} accent={toneOf(th(), look().tone)}>
        <TitleLine theme={th()} look={look()} name={unitName(props.unit)} figures={figures()} width={props.width - 4} />
        <text fg={th().text.muted}>{truncate(details(), props.width - 4)}</text>
        <For each={failedAttempts()}>
          {(attempt) => (
            <text fg={th().text.feedback.warning.base}>
              {truncate(`↻ attempt ${attempt.turn} (${attempt.path}): ${attempt.error ?? "failed"}`, props.width - 4)}
            </text>
          )}
        </For>
        <Show when={props.unit.error}>
          <text fg={th().text.feedback.error.base}>{truncate(`✗ ${props.unit.error}`, props.width - 4)}</text>
        </Show>
      </Card>

      <Section theme={th()} title="Prompt" detail={promptLines().length > 4 ? `${promptLines().length} lines` : ""} />
      <box flexDirection="column" flexShrink={0} paddingLeft={2}>
        <For each={promptLines().slice(0, 4)}>
          {(line) => (
            <text fg={th().text.muted}>
              <span style={{ fg: th().border.base }}>▎ </span>
              {line}
            </text>
          )}
        </For>
      </box>

      <Section theme={th()} title="Output" detail={typed() ? "typed result" : ""} />
      <box flexGrow={1} paddingLeft={2} paddingRight={1}>
        <Show when={output()} fallback={<text fg={th().text.muted}>{empty()}</text>}>
          <scrollbox
            ref={(box: ScrollBoxRenderable) => props.scroller(box)}
            height="100%"
            verticalScrollbarOptions={{
              trackOptions: { backgroundColor: th().background.base, foregroundColor: th().scrollbar.base },
            }}
          >
            <Show
              when={typed()}
              fallback={<markdown content={output()!} syntaxStyle={syntax()} fg={th().text.base} conceal={true} />}
            >
              <code
                filetype="json"
                content={output()!}
                syntaxStyle={syntax()}
                fg={th().text.base}
                drawUnstyledText={true}
                conceal={false}
                wrapMode="word"
              />
            </Show>
          </scrollbox>
        </Show>
      </box>
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

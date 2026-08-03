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
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import type { ControlAction, ControlResult } from "../control"
import { formatElapsed, formatTokens, phasePosition, settledUnits } from "../progress"
import type { RunSnapshot } from "../runs"
import type { RunControlClient } from "./control"
import { registerKeymap, footerHint, WORKFLOW_ROUTE, type WorkflowBinding } from "./keymap"
import {
  breadcrumb,
  initialRouteState,
  listRows,
  normalizeRoute,
  reduceRoute,
  runRows,
  selectedControl,
  unitDetail,
  type ListRow,
  type RouteState,
  type RunLevelRow,
  type UnitDetail,
} from "./route-model"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** Settled outcomes, all single-width so a row never shifts as a run or unit ends. */
const LIST_GLYPHS = { done: "✓", failed: "✗", aborted: "⊘" } as const
const ROW_GLYPHS = { queued: "·", ok: "✓", failed: "✗", replayed: "↺", question: "❓" } as const

/** How much of the run's log tail the run level shows. Enough for context, never enough to become the screen. */
const RECENT_LOGS = 5

export interface WorkflowRouteProps {
  api: TuiPluginApi
  runs: Accessor<readonly RunSnapshot[]>
  control: RunControlClient
  /** `{ runId }` when entered from the sidebar; `{ returnTo }` carries the session to go back to. */
  params?: Record<string, unknown>
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/** `running · phase 2/3 gather sources · 14/40 units · 2m10s · 41k tok` */
function runSummary(run: RunSnapshot, now: number): string {
  const parts: string[] = [run.status]
  const position = phasePosition(run)
  const phase = run.currentPhase ?? "starting"
  parts.push(position ? `${position} ${phase}` : phase)
  parts.push(`${settledUnits(run)}/${run.units.length} units`)
  parts.push(formatElapsed((run.endedAt ?? now) - run.startedAt))
  if (run.tokensSpent > 0) parts.push(`${formatTokens(run.tokensSpent)} tok`)
  return parts.join(" · ")
}

/** What a control action did, in the words the user needs — never a bare `ok: false`. */
function controlNotice(action: ControlAction, result: ControlResult): string {
  const target = action.action === "stop.run" ? "run" : "unit"
  if (result.ok) return `stopping ${target}…`
  if (result.reason === "not-running") return `that ${target} has already finished`
  if (result.reason === "unknown-unit") return "that unit is no longer running"
  if (result.reason === "unknown-run") return "that run is no longer live — its engine has gone"
  return `could not stop the ${target}`
}

export default function WorkflowRoute(props: WorkflowRouteProps) {
  const [state, setState] = createSignal<RouteState>(initialRouteState(stringParam(props.params, "runId")))
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

  const close = () => {
    const returnTo = stringParam(props.params, "returnTo")
    // Back to the session the user opened the browser from, when we know it. Home is the honest fallback: the
    // host gives a plugin no route history, and guessing a session would land them somewhere they never were.
    if (returnTo) props.api.route.navigate("session", { sessionID: returnTo })
    else props.api.route.navigate("home")
  }

  const dispatch = (action: WorkflowBinding["action"]) => {
    setNotice(null)
    if (action === "close") {
      close()
      return
    }
    // `back` at the list level is the way out. Making the reducer express "leave the route" would give it a
    // dependency on the host router for one edge case; the caller already owns that.
    if (action === "back" && state().stack.length <= 1) {
      close()
      return
    }
    if (action === "stop") {
      const target = selectedControl(state(), props.runs(), "stop")
      if (!target) return
      void props.control.send(target).then((result) => setNotice(controlNotice(target, result)))
      return
    }
    setState((current) => reduceRoute(current, action, props.runs()))
  }

  onMount(() => {
    // Mode-scoped, so `x` cannot stop a run while the user is typing in a session prompt — and, symmetrically,
    // so the prompt gets every key back the instant this route unmounts.
    onCleanup(props.api.mode.push(WORKFLOW_ROUTE))
    onCleanup(registerKeymap(props.api, dispatch))
  })

  // Runs settle and disappear underneath the cursor; re-normalizing on every change is what keeps a selection
  // (and a drilled-into level) from pointing at something that is no longer there — with no keypress involved.
  createEffect(() => {
    const runs = props.runs()
    setState((current) => normalizeRoute(current, runs))
  })

  const level = createMemo(() => state().stack[state().stack.length - 1])
  const crumb = createMemo(() => breadcrumb(state(), props.runs()))
  const rows = createMemo<ListRow[]>(() => {
    now() // re-render elapsed on the tick
    return listRows(props.runs(), state().filter)
  })
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
    return theme().textMuted
  }
  const selectedIndex = () => {
    const current = level()
    return current && current.kind !== "unit" ? current.selected : -1
  }

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme().text}>
          <b>{crumb()}</b>
        </text>
        <text fg={theme().textMuted}>{`filter: ${state().filter}`}</text>
      </box>

      <box>
        <Show when={activeRun()}>
          {(run: Accessor<RunSnapshot>) => <text fg={theme().textMuted}>{runSummary(run(), now())}</text>}
        </Show>
      </box>

      <box flexGrow={1} flexDirection="column" paddingTop={1}>
        <Show when={level()?.kind === "list"}>
          <box flexDirection="column">
            <Show when={rows().length === 0}>
              <text fg={theme().textMuted}>No workflow runs to show. Start one with the `workflow` tool.</text>
            </Show>
            <For each={rows()}>
              {(row: ListRow, index) => (
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={1} flexShrink={1}>
                    <text flexShrink={0} fg={theme().accent}>
                      {index() === selectedIndex() ? "▸" : " "}
                    </text>
                    <text flexShrink={0} fg={listGlyphColor(row)}>
                      {listGlyph(row)}
                    </text>
                    <text flexShrink={0} fg={index() === selectedIndex() ? theme().accent : theme().text}>
                      {row.workflow.padEnd(nameColumn())}
                    </text>
                    <text flexShrink={1} fg={theme().textMuted}>
                      {row.detail}
                    </text>
                  </box>
                  <text flexShrink={0} fg={theme().textMuted}>
                    {row.elapsed}
                  </text>
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
                <box flexDirection="row" justifyContent="space-between">
                  <box flexDirection="row" gap={1} flexShrink={1}>
                    <text flexShrink={0} fg={theme().accent}>
                      {index() === selectedIndex() ? "▸" : " "}
                    </text>
                    <text flexShrink={0} fg={rowGlyphColor(row)}>
                      {`${row.indent === 1 ? "  " : ""}${rowGlyph(row)}`}
                    </text>
                    <text flexShrink={0} fg={index() === selectedIndex() ? theme().accent : theme().text}>
                      {row.label}
                    </text>
                    <text flexShrink={1} fg={theme().textMuted}>
                      {row.detail}
                    </text>
                  </box>
                  <text flexShrink={0} fg={theme().textMuted}>
                    {row.elapsed}
                  </text>
                </box>
              )}
            </For>
            <box paddingTop={1}>
              <Show when={(activeRun()?.logs.length ?? 0) > 0}>
                <box flexDirection="column">
                  <text fg={theme().text}>
                    <b>Recent</b>
                  </text>
                  <For each={(activeRun()?.logs ?? []).slice(-RECENT_LOGS)}>
                    {(log: string) => <text fg={theme().textMuted}>{` ${log}`}</text>}
                  </For>
                </box>
              </Show>
            </box>
          </box>
        </Show>

        <Show when={level()?.kind === "unit"}>
          <scrollbox ref={body} flexGrow={1} scrollY stickyScroll={false}>
            <Show when={unit()}>
              {(detail: Accessor<UnitDetail>) => (
                <box flexDirection="column" gap={1}>
                  <text fg={theme().text}>
                    {`#${detail().ordinal} ${detail().label ?? detail().subagent} · ${detail().status}` +
                      `${detail().elapsed ? ` · ${detail().elapsed}` : ""}`}
                  </text>
                  <text fg={theme().textMuted}>
                    {`subagent ${detail().subagent} · phase ${detail().phase ?? "(none)"} · session ` +
                      `${detail().sessionID ?? "(none)"}`}
                  </text>
                  <box flexDirection="column">
                    <text fg={theme().text}>
                      <b>Prompt</b>
                    </text>
                    <text fg={theme().textMuted} wrapMode="word">
                      {detail().prompt}
                    </text>
                  </box>
                  <box>
                    <Show when={detail().error}>
                      {(error: Accessor<string>) => (
                        <box flexDirection="column">
                          <text fg={theme().error}>
                            <b>Error</b>
                          </text>
                          <text fg={theme().error} wrapMode="word">
                            {error()}
                          </text>
                        </box>
                      )}
                    </Show>
                  </box>
                </box>
              )}
            </Show>
          </scrollbox>
        </Show>
      </box>

      <box>
        <Show when={notice()}>
          {(message: Accessor<string>) => <text fg={theme().warning}>{message()}</text>}
        </Show>
      </box>
      <text fg={theme().textMuted} wrapMode="word">
        {footerHint()}
      </text>
    </box>
  )
}

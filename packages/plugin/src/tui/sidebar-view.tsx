/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { sidebarViewModel, type SidebarRunRow, type WorkflowSidebarProps } from "./sidebar"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/**
 * The settled glyphs, all single-width so a row never shifts as a run ends.
 *
 * `running` is absent on purpose — it animates through `SPINNER_FRAMES` instead, and a status that animates
 * cannot come from a static table.
 */
const STATUS_GLYPHS = { done: "✓", failed: "✗", aborted: "⊘" } as const

export default function WorkflowSidebar(props: WorkflowSidebarProps) {
  const [now, setNow] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  const elapsedTimer = setInterval(() => setNow(Date.now()), 1_000)
  const spinnerTimer = setInterval(() => setFrame((value: number) => (value + 1) % SPINNER_FRAMES.length), 80)
  onCleanup(() => {
    clearInterval(elapsedTimer)
    clearInterval(spinnerTimer)
  })
  const view = createMemo(() => sidebarViewModel(props.runs(), now()))
  const theme = () => props.theme.current

  /** The spinner while a run is live, its outcome glyph once it settles. */
  const glyph = (row: SidebarRunRow): string =>
    row.status === "running" ? (SPINNER_FRAMES[frame()] as string) : STATUS_GLYPHS[row.status]

  /** Only a failure earns a color of its own; success stays quiet so the live run keeps the eye. */
  const glyphColor = (row: SidebarRunRow) => {
    if (row.status === "running") return theme().accent
    if (row.status === "failed") return theme().error
    if (row.status === "aborted") return theme().warning
    return theme().success
  }

  // A settled run recedes to muted: it stays for reference, but the live run is what the strip is FOR.
  const nameColor = (row: SidebarRunRow) => (row.status === "running" ? theme().accent : theme().textMuted)

  return (
    <Show when={view().rows.length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Workflows</b>
        </text>
        <For each={view().rows}>
          {(row: SidebarRunRow) => (
            <box>
              <box flexDirection="row" justifyContent="space-between">
                <box flexDirection="row" gap={1} flexShrink={1}>
                  <text flexShrink={0} fg={glyphColor(row)}>
                    {glyph(row)}
                  </text>
                  <text fg={nameColor(row)}>{row.workflow}</text>
                </box>
                <text flexShrink={0} fg={theme().textMuted}>
                  {`${row.counts} · ${row.elapsed}`}
                </text>
              </box>
              <Show when={row.detail !== null}>
                <text fg={row.status === "failed" ? theme().error : theme().textMuted}>{`  ${row.detail}`}</text>
              </Show>
            </box>
          )}
        </For>
        <Show when={view().pendingQuestions > 0}>
          <text fg={theme().accent}>
            {`❓ ${view().pendingQuestions} question${view().pendingQuestions === 1 ? "" : "s"} waiting`}
          </text>
        </Show>
      </box>
    </Show>
  )
}

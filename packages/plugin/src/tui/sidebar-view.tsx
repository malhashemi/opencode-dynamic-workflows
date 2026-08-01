/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { sidebarViewModel, type SidebarRunLine, type WorkflowSidebarProps } from "./sidebar"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export default function WorkflowSidebar(props: WorkflowSidebarProps) {
  const [now, setNow] = createSignal(Date.now())
  const [frame, setFrame] = createSignal(0)
  const elapsedTimer = setInterval(() => setNow(Date.now()), 1_000)
  const spinnerTimer = setInterval(() => setFrame((value: number) => (value + 1) % SPINNER_FRAMES.length), 80)
  onCleanup(() => {
    clearInterval(elapsedTimer)
    clearInterval(spinnerTimer)
  })
  const lines = createMemo(() => sidebarViewModel(props.runs(), now()))
  const theme = () => props.theme.current

  return (
    <Show when={lines().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Workflows</b>
        </text>
        <For each={lines()}>
          {(line: SidebarRunLine) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme().accent}>{SPINNER_FRAMES[frame()]}</text>
              <text fg={theme().textMuted}>{line.text}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

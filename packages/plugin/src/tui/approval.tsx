/**
 * The inline-Workflow approval: the whole script, syntax-highlighted and scrollable, with the choices as buttons.
 * Built like OpenCode's own permission prompt (a raised panel with a `┃` accent, a `△` header, a darker footer
 * with pill buttons), so it reads as part of OpenCode.
 */
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"

import type { PendingInteraction } from "../protocol"
import { ACCENT_BORDER, useSyntax } from "./ui"
import type { Wf } from "./views"

export function ApprovalPanel(props: {
  wf: Wf
  interaction: PendingInteraction
  /** The highlighted choice. */
  selected: number
  sending: boolean
  height: number
  onSelect: (index: number) => void
  onChoose: (index: number) => void
  scroller: (box: ScrollBoxRenderable) => void
}) {
  const theme = () => props.wf.context.theme
  const dimensions = useTerminalDimensions()
  // Below this the buttons and the key hints do not fit on one row: the hints go underneath.
  const narrow = () => dimensions().width < 100
  const approval = () => props.interaction.approval!
  const saving = () => approval().action === "save"
  const options = () => props.interaction.questions[0]?.options ?? []
  const lines = () => approval().source.split("\n").length
  const size = () => {
    const bytes = approval().bytes
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
  }

  const syntax = useSyntax(theme)

  const variant = (label: string) => (label === "Reject" ? "destructive" : "primary")

  return (
    <box
      flexDirection="column"
      height={props.height}
      backgroundColor={theme().background.raised.base}
      border={["left"]}
      borderColor={theme().background.action.primary.focused}
      customBorderChars={ACCENT_BORDER}
    >
      <box flexDirection="column" flexShrink={0} paddingLeft={2} paddingRight={3} paddingTop={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text.feedback.warning.base}>△</text>
          <text fg={theme().text.base}>
            <b>{saving() ? "Save this inline Workflow?" : "Run this inline Workflow?"}</b>
          </text>
        </box>
        <box flexDirection="column" paddingLeft={2}>
          <Show when={saving() && approval().target}>
            <box flexDirection="row" gap={1}>
              <text fg={theme().text.muted}>→</text>
              <text fg={theme().text.base}>{approval().target!}</text>
            </box>
          </Show>
          <text fg={theme().text.muted}>
            {saving()
              ? "A model wants to keep this script. Once saved it runs by name, without approval, with your permissions."
              : "A model wrote this script. It runs with your permissions inside the OpenCode service, unsandboxed."}
          </text>
          <text fg={theme().text.muted}>
            {`${lines()} lines · ${size()} · sha256 ${approval().sha256.slice(0, 16)}`}
          </text>
        </box>
      </box>

      <box flexGrow={1} paddingLeft={2} paddingRight={1} paddingTop={1} paddingBottom={1}>
        <scrollbox
          ref={(box: ScrollBoxRenderable) => props.scroller(box)}
          height="100%"
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme().background.raised.base,
              foregroundColor: theme().scrollbar.base,
            },
          }}
        >
          <line_number fg={theme().text.muted} minWidth={3} paddingRight={1}>
            <code
              filetype="typescript"
              content={approval().source}
              syntaxStyle={syntax()}
              fg={theme().text.base}
              drawUnstyledText={true}
              conceal={false}
              wrapMode="word"
            />
          </line_number>
        </scrollbox>
      </box>

      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={3}
        backgroundColor={theme().decrease(theme().background.raised.base)}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={options()}>
            {(option, index) => {
              const focused = () => index() === props.selected
              // Only the chosen button carries colour (red when it is Reject); the others stay quiet.
              const kind = () => (focused() ? variant(option.label) : "primary")
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    focused() ? theme().background.action[kind()].focused : theme().background.action[kind()].base
                  }
                  onMouseMove={() => props.onSelect(index())}
                  onMouseUp={() => props.onChoose(index())}
                >
                  <text fg={focused() ? theme().text.action[kind()].focused : theme().text.action[kind()].base}>
                    {option.label}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={!props.sending} fallback={<text fg={theme().text.muted}>Sending…</text>}>
            <text fg={theme().text.base}>
              ↑↓ <span style={{ fg: theme().text.muted }}>scroll</span>
            </text>
            <text fg={theme().text.base}>
              ⇆ <span style={{ fg: theme().text.muted }}>select</span>
            </text>
            <text fg={theme().text.base}>
              enter <span style={{ fg: theme().text.muted }}>confirm</span>
            </text>
            <text fg={theme().text.base}>
              esc <span style={{ fg: theme().text.muted }}>back</span>
            </text>
          </Show>
        </box>
      </box>
    </box>
  )
}

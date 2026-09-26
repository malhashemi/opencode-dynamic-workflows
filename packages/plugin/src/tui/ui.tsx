/**
 * Shared building blocks for the TUI, in OpenCode's own visual language: the raised panel with a `┃` accent bar,
 * section titles, `key label` hints, rows with an accent marker, and the theme's syntax style for code.
 */
import type { ResolvedTheme } from "@opencode/theme/tui"
import { generateSyntax } from "@opencode/theme/tui"
import type { RGBA, SyntaxStyle } from "@opentui/core"
import { createMemo, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"

import { truncate, type Tone } from "./format"

/** OpenCode's `SplitBorder`: a heavy left bar, nothing else. */
export const ACCENT_BORDER = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export function toneColor(theme: ResolvedTheme, tone: Tone): RGBA {
  switch (tone) {
    case "success":
      return theme.text.feedback.success.base
    case "error":
      return theme.text.feedback.error.base
    case "warning":
      return theme.text.feedback.warning.base
    case "info":
      return theme.text.feedback.info.base
    case "muted":
      return theme.text.muted
    case "base":
      return theme.text.base
  }
}

/** The theme's syntax style (OpenCode's own `generateSyntax`); each replaced style is freed with the component. */
export function useSyntax(theme: Accessor<ResolvedTheme>): Accessor<SyntaxStyle> {
  const styles: SyntaxStyle[] = []
  onCleanup(() => {
    for (const style of styles.splice(0)) style.destroy()
  })
  return createMemo(() => {
    // `@opencode/theme` types a different `@opentui/core` release; at run time both are the host's one copy.
    const style = generateSyntax(theme()) as unknown as SyntaxStyle
    styles.push(style)
    return style
  })
}

/** A raised panel with a coloured `┃` bar on the left. */
export function Card(props: {
  theme: ResolvedTheme
  accent: RGBA
  children: JSX.Element
  onClick?: () => void
  paddingTop?: number
  paddingBottom?: number
}) {
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      backgroundColor={props.theme.background.raised.base}
      border={["left"]}
      borderColor={props.accent}
      customBorderChars={ACCENT_BORDER}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={props.paddingTop ?? 1}
      paddingBottom={props.paddingBottom ?? 1}
      onMouseUp={() => props.onClick?.()}
    >
      {props.children}
    </box>
  )
}

/** A section title: bold text, then a muted detail. */
export function Section(props: { theme: ResolvedTheme; title: string; detail?: string }) {
  return (
    <box flexDirection="row" gap={1} flexShrink={0} paddingTop={1} paddingLeft={1}>
      <text fg={props.theme.text.base}>
        <b>{props.title}</b>
      </text>
      <Show when={props.detail}>
        <text fg={props.theme.text.muted}>{props.detail!}</text>
      </Show>
    </box>
  )
}

export interface Hint {
  readonly key: string
  readonly label: string
  readonly run: () => void
}

/** `key label` pairs, as OpenCode prints them; each is clickable. */
export function KeyHints(props: { theme: ResolvedTheme; hints: readonly Hint[] }) {
  return (
    <box flexDirection="row" flexWrap="wrap" flexShrink={0} paddingLeft={1}>
      <For each={props.hints}>
        {(hint) => (
          <text fg={props.theme.text.base} marginRight={2} onMouseUp={() => hint.run()}>
            {hint.key} <span style={{ fg: props.theme.text.muted }}>{hint.label}</span>
          </text>
        )}
      </For>
    </box>
  )
}

/** A piece of a row: text and its colour. */
export interface Cell {
  readonly text: string
  readonly fg: RGBA
  readonly bold?: boolean
}

/**
 * Fit coloured pieces into a column of `width` cells: cut from the end, pad to the width (left or right).
 * Several pieces share one column (a name and its muted tag, a meter and its count).
 */
export function fitCells(pieces: readonly Cell[], width: number, align: "left" | "right" = "left"): Cell[] {
  const out: Cell[] = []
  let room = width
  for (const piece of pieces) {
    if (room <= 0 || !piece.text) continue
    const text = truncate(piece.text, room)
    out.push({ ...piece, text })
    room -= text.length
  }
  if (room > 0) {
    const pad = { text: " ".repeat(room), fg: pieces[0]?.fg ?? ({} as RGBA) }
    if (align === "right") out.unshift(pad)
    else out.push(pad)
  }
  return out
}

/** One selectable row: an accent bar when selected, then coloured cells. */
export function CellRow(props: {
  theme: ResolvedTheme
  selected: boolean
  cells: readonly Cell[]
  onClick: () => void
}) {
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      backgroundColor={props.selected ? props.theme.background.raised.high : undefined}
      onMouseDown={() => props.onClick()}
    >
      <text fg={props.theme.background.action.primary.focused}>{props.selected ? "┃ " : "  "}</text>
      <For each={props.cells}>
        {(cell) => (
          <text fg={cell.fg}>
            <Show when={cell.bold} fallback={cell.text}>
              <b>{cell.text}</b>
            </Show>
          </text>
        )}
      </For>
    </box>
  )
}

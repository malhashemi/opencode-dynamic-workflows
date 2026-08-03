/** @jsxImportSource @opentui/solid */
/**
 * Mount a plugin view on a real OpenTUI renderer and read the frame back as text.
 *
 * The row MODEL is pure and easy to test; the RENDER is neither, and the gap between them is where a
 * terminal UI actually breaks. OpenTUI enforces structural rules a type checker cannot see — most sharply,
 * a text node may only be added to a `<text>` parent, which makes an ordinary Solid idiom (a `<For>` that
 * empties out while a sibling follows it) throw at runtime and take the whole host down with it.
 *
 * This harness makes that class of failure a two-second test instead of a seven-minute live run.
 *
 * Requires `@opentui/solid/preload` (see the repository's `bunfig.toml`), which is the same Solid transform
 * the OpenCode host installs before importing an external TUI plugin.
 */
import { createSlot, createSolidSlotRegistry, testRender, useRenderer } from "@opentui/solid"
import type { TuiSlotPlugin, TuiTheme } from "@opencode-ai/plugin/tui"
import type { JSX } from "solid-js"

export interface MountedView {
  /** The last rendered frame, as plain text with trailing whitespace trimmed per line. */
  text(): string
  /** Drive render passes until the frame settles. Required after changing any signal the view reads. */
  flush(): Promise<void>
  press(key: string): Promise<void>
  unmount(): void
}

export interface MountOptions {
  width?: number
  /** Defaults to 42 — the width the host gives `sidebar_content`. */
  height?: number
}

/** A structural `TuiTheme` with distinguishable tokens, so a color assertion can name what it expects. */
export function fakeTheme(overrides: Partial<Record<string, string>> = {}): TuiTheme {
  const current = {
    text: "#ffffff",
    textMuted: "#888888",
    accent: "#00ccff",
    success: "#00ff00",
    error: "#ff0000",
    ...overrides,
  }
  return { current } as unknown as TuiTheme
}

/**
 * Mount a registered `sidebar_content` slot the way the HOST composes it: inside a gapped column, between two
 * other plugins' sections.
 *
 * Composition is not a detail. Rendering a view standalone exercises none of Solid's placeholder machinery,
 * and it is precisely that machinery — an empty text node inserted to hold a not-yet-resolved child's place —
 * that OpenTUI rejects. A view can pass every standalone assertion and still crash the host on mount.
 */
export async function mountSidebarSlot(plugin: TuiSlotPlugin, options: MountOptions = {}): Promise<MountedView> {
  const App = () => {
    // The second argument is the slot CONTEXT — what the host passes as the renderer's first parameter, and
    // where a plugin reads its theme tokens from.
    const registry = createSolidSlotRegistry<{ sidebar_content: { session_id: string } }>(useRenderer(), {
      theme: fakeTheme(),
    })
    const Slot = createSlot(registry)
    // Stand-ins for the host's built-in LSP (order 300) and todo (order 400) sections, so the plugin's own
    // section is composed with neighbours on both sides rather than alone.
    registry.register({
      id: "test:lsp",
      order: 300,
      slots: { sidebar_content: () => (<box><text>LSP</text></box>) as JSX.Element },
    })
    registry.register(plugin as never)
    registry.register({
      id: "test:todo",
      order: 400,
      slots: { sidebar_content: () => (<box><text>Todos</text></box>) as JSX.Element },
    })
    return (
      <box flexShrink={0} gap={1} paddingRight={1}>
        <Slot name="sidebar_content" session_id="test-session" />
      </box>
    )
  }
  return mountView(() => <App />, options)
}

export async function mountView(render: () => JSX.Element, options: MountOptions = {}): Promise<MountedView> {
  const app = await testRender(render, {
    width: options.width ?? 42,
    height: options.height ?? 20,
  })

  // A renderer that has never rendered returns an uninitialized buffer, which reads as garbage rather than as
  // an empty screen — settle it once before anyone can capture.
  await app.flush()

  return {
    text() {
      return app
        .captureCharFrame()
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
    },
    async flush() {
      await app.flush()
    },
    async press(key: string) {
      app.mockInput.pressKey(key)
      await app.flush()
    },
    unmount() {
      app.renderer.destroy()
    },
  }
}

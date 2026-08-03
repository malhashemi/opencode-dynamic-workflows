/**
 * The dual-target module-shape gate, committed as a test.
 *
 * OpenCode validates plugin modules as TARGET-EXCLUSIVE: a server module is `{ id?, server, tui?: never }` and
 * a TUI module is `{ id?, tui, server?: never }` (`packages/opencode/src/plugin/shared.ts`). A module carrying
 * both is rejected at load time — the whole package silently fails to activate. That is a one-line mistake to
 * make (an accidental re-export, a barrel import) and invisible until a real host refuses the plugin, so the
 * research ran this check by hand. Here it runs on every `bun test`.
 *
 * Both entrypoints are imported exactly the way the host imports them: after the OpenTUI/Solid transform is
 * installed. The host does that in `ensureRuntimePluginSupport()` at module-evaluation time, before it
 * dynamically imports any external TUI entrypoint; the root `bunfig.toml` preload mirrors it here. That
 * ordering is what lets `src/tui/sidebar.tsx` import its JSX-bearing view eagerly — which it must, because
 * `lazy()` parks an empty text node in the tree and OpenTUI crashes the whole TUI on it.
 */
import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

const PLUGIN_ID = "opencode-dynamic-workflows"

describe("plugin module targets", () => {
  it("exposes ./src/index.ts as a server-only module", async () => {
    const target = (await import("../src/index")).default as Record<string, unknown>
    expect(target.id).toBe(PLUGIN_ID)
    expect(typeof target.server).toBe("function")
    expect("tui" in target).toBe(false)
  })

  it("exposes ./src/tui/index.tsx as a TUI-only module", async () => {
    const target = (await import("../src/tui/index")).default as Record<string, unknown>
    expect(target.id).toBe(PLUGIN_ID)
    expect(typeof target.tui).toBe("function")
    expect("server" in target).toBe(false)
  })

  it("declares both targets in package exports so one install patches opencode.json and tui.json", async () => {
    // Read rather than import: the manifest is deliberately outside the tsconfig file list, and the installer
    // reads it off disk too (`packages/opencode/src/plugin/install.ts`).
    const manifest = JSON.parse(
      await readFile(path.join(import.meta.dir, "..", "package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> }
    expect(manifest.exports?.["./server"]).toBe("./src/index.ts")
    expect(manifest.exports?.["./tui"]).toBe("./src/tui/index.tsx")
  })
})

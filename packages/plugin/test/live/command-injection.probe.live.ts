/**
 * LIVE PROBE — confirm config-hook command injection for wf-discovery-dispatcher.
 *
 * NOT a `*.test.ts`: it boots a real opencode server in-process. Run by hand:
 *
 *     bun run packages/plugin/test/live/command-injection.probe.live.ts
 *
 * Boots a real opencode server with the probe plugin loaded by ABSOLUTE PATH (`config.plugin`), then
 * asserts the injected `wf_probe` command appears in `client.command.list()`. No model required — the
 * load-bearing claim is purely "does a config-hook command mutation surface as a registered command".
 *
 * Exit 0 iff the injected command surfaced (claim holds). Prints the full command list either way.
 */
import path from "node:path"
import { createOpencode } from "@opencode-ai/sdk"
import { PROBE_COMMAND_NAME, PROBE_NAME_STYLES, PROBE_TEMPLATE } from "./fixtures/command-injection-probe.plugin"

async function main() {
  const pluginPath = path.resolve(import.meta.dir, "fixtures/command-injection-probe.plugin.ts")
  // Default port (4096) is usually taken by a running opencode; use a free high port (same trick as the
  // other live tests).
  const port = 40000 + Math.floor((Date.now() % 20000))
  console.log(`• booting opencode with probe plugin loaded by path:\n    ${pluginPath}`)
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR", plugin: [pluginPath] } })
  console.log(`  server up at ${server.url}`)

  try {
    const res = await (client as any).command.list()
    const commands = res?.data ?? res
    const list: any[] = Array.isArray(commands)
      ? commands
      : Object.entries(commands ?? {}).map(([name, v]) => ({ name, ...(v as object) }))
    const names = list.map((c) => c.name)
    console.log(`  command.list() returned ${list.length} command(s): ${names.join(", ") || "(none)"}`)

    const hit = list.find((c) => c.name === PROBE_COMMAND_NAME)
    if (!hit) {
      console.error(`\n✗ FAIL: injected command "${PROBE_COMMAND_NAME}" did NOT surface in command.list().`)
      console.error("  → config-hook command injection does NOT work; dispatcher must defer the slash command.")
      process.exitCode = 1
      return
    }

    console.log(`\n✓ PASS: injected command surfaced. Shape:`)
    console.log(JSON.stringify(hit, null, 2))
    const templateOk = JSON.stringify(hit).includes("$ARGUMENTS") || hit.template === PROBE_TEMPLATE
    console.log(templateOk
      ? "  ✓ template (with $ARGUMENTS) preserved through the registry."
      : "  ⚠ template not obviously preserved — inspect the shape above ($ARGUMENTS substitution may differ).")

    // Multi-injection + special-char name probe: which candidate command-name styles actually registered?
    console.log(`\n— per-workflow command NAME styles (which survive registration as their exact key) —`)
    const present = new Set(names)
    for (const styled of PROBE_NAME_STYLES) {
      const exact = list.find((c) => c.name === styled)
      console.log(`  ${present.has(styled) ? "✓" : "✗"} ${JSON.stringify(styled)}${exact ? "" : "   (NOT registered as that exact name)"}`)
    }
    // Surface any wf-injected commands whose rendered name differs from what we set (sanitization/namespacing).
    const injected = list.filter((c) => typeof c.description === "string" && c.description.startsWith("probe command ("))
    console.log(`\n  rendered names of injected per-workflow commands (${injected.length}):`)
    for (const c of injected) console.log(`    - name=${JSON.stringify(c.name)}  desc=${JSON.stringify(c.description)}`)
  } finally {
    await server.close()
  }
}

main().catch((e) => {
  console.error("\nprobe threw (this itself is a finding — likely plugin-by-path load or command.list API):")
  console.error(e)
  process.exitCode = 1
})

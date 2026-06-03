/**
 * LIVE REPRO — does `session.abort` on a CHILD session poison the PARENT's next prompt?
 *
 * Hypothesis for "the 2nd workflow tool call never fires until I abort + retry": when a Unit times out we call
 * client.session.abort({ sessionID: childSessionID }); if that interferes with the parent (the invoking
 * session), the parent's NEXT prompt/tool-call would stall — matching the symptom.
 *
 * Test: create a parent, create a child under it, start a long child prompt, abort the child mid-flight, then
 * prompt the PARENT and see whether it responds promptly.
 *
 * Run:  bun run packages/plugin/test/live/abort-parent.repro.live.ts
 */
import { createOpencode } from "@opencode-ai/sdk/v2"

const TIMEOUT_MS = 60_000

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<{ ok: true; ms: number } | { ok: false; label: string }> {
  const started = Date.now()
  const timeout = new Promise<"TO">((r) => setTimeout(() => r("TO"), ms))
  const res = await Promise.race([p.then(() => "DONE" as const), timeout])
  return res === "TO" ? { ok: false, label } : { ok: true, ms: Date.now() - started }
}

async function main() {
  const port = 40000 + Math.floor((Date.now() % 20000))
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR" }, timeout: 30000 })
  try {
    const parent = (await client.session.create({ title: "abort-parent-repro" })).data
    if (!parent?.id) throw new Error("failed to create parent session")
    console.log(`parent = ${parent.id}`)

    // WARM UP first — the very first prompt after boot is cold-start-slow (~12–55s); await it fully so the
    // later timings reflect the abort interaction, not warmup.
    console.log("warming up (absorbing cold start)…")
    const warm = await withTimeout(client.session.prompt({ sessionID: parent.id, agent: "general", parts: [{ type: "text", text: "Reply with: warm" }] }), 120_000, "warmup")
    console.log(`  warmup: ${warm.ok ? `OK (${warm.ms}ms)` : "HANG"}`)

    // Baseline: a SECOND parent prompt (now warm) should be fast.
    const base = await withTimeout(client.session.prompt({ sessionID: parent.id, agent: "general", parts: [{ type: "text", text: "Reply with: baseline-ok" }] }), TIMEOUT_MS, "baseline parent prompt")
    console.log(`baseline parent prompt (warm): ${base.ok ? `OK (${base.ms}ms)` : "HANG"}`)

    // Create a child under the parent and start a LONG prompt (don't await), then abort it mid-flight.
    const child = (await client.session.create({ parentID: parent.id, title: "child" })).data
    if (!child?.id) throw new Error("failed to create child session")
    console.log(`child = ${child.id}`)
    const childPrompt = client.session.prompt({ sessionID: child.id, agent: "general", parts: [{ type: "text", text: "Count slowly from 1 to 800, one number per line, with no other text." }] })
    void childPrompt.catch(() => {})
    await new Promise((r) => setTimeout(r, 2500)) // let the child get in-flight
    console.log("aborting the child mid-flight …")
    await client.session.abort({ sessionID: child.id }).catch((e: unknown) => console.log("  abort threw:", e))

    // THE TEST: can the parent be prompted right after the child was aborted?
    const after = await withTimeout(client.session.prompt({ sessionID: parent.id, agent: "general", parts: [{ type: "text", text: "Reply with: after-abort-ok" }] }), TIMEOUT_MS, "post-abort parent prompt")
    console.log(`post-abort parent prompt: ${after.ok ? `OK (${after.ms}ms)` : "HANG (✗ — child abort poisoned the parent!)"}`)

    console.log(after.ok ? "\n✓ parent unaffected by child abort" : "\n✗ REPRODUCED: aborting a child blocks the parent's next prompt")
    if (!after.ok) process.exitCode = 1
  } finally {
    await server.close()
  }
}

main().catch((e) => {
  console.error("repro threw:", e)
  process.exitCode = 1
})

/**
 * LIVE REPRO — does a structured-output / complex subagent prompt HANG (no assistant response) vs a text one?
 *
 * Boots a real opencode (inherits your config + model) and runs three one-Unit workflows, each wrapped in a
 * timeout, to localize the reported hang:
 *   1. text          — control (should complete fast)
 *   2. simple struct  — agent({ schema: {score} })
 *   3. complex struct — agent({ schema: { results: [{...}], allSatisfied } })  (the constrain-style suspect)
 *
 * Run:  bun run packages/plugin/test/live/structured-hang.repro.live.ts
 * Prints, per probe: COMPLETED (ok/err + ms) or HANG (timed out at Ns). A hang on the structured probes but
 * not the text probe localizes the bug to the structured-output subagent path.
 */
import { createOpencode } from "@opencode-ai/sdk/v2"
import type { WorkflowClient } from "../../src/client"
import { runWorkflow } from "../../src/orchestrator"

const TIMEOUT_MS = 90_000

const SRC = {
  text: `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "p-text", description: "x" }, async run({ agent, log }) {
  log("text: prompting"); const r = await agent("Reply with the single word: pong."); log("text: done"); return { r }
} })`,
  simple: `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "p-simple", description: "x" }, async run({ agent, log }) {
  log("simple-struct: prompting")
  const r = await agent("Rate the number 7 on a scale 0-10 and give a one word reason.", { schema: z.object({ score: z.number(), reason: z.string() }) })
  log("simple-struct: done"); return { r }
} })`,
  complex: `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "p-complex", description: "x" }, async run({ agent, log }) {
  log("complex-struct: prompting")
  const Check = z.object({ results: z.array(z.object({ constraint: z.string(), satisfied: z.boolean(), note: z.string() })), allSatisfied: z.boolean() })
  const r = await agent("Check the text 'two threads race' against: [1] mentions a concurrency word, [2] is under 10 words, [3] has no punctuation. Return per-constraint results + allSatisfied.", { schema: Check })
  log("complex-struct: done"); return { r }
} })`,
  parallel: `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "p-par", description: "x", concurrency: 6 }, async run({ agent, parallel, collect, log }) {
  log("parallel-struct: launching 6 structured units at once")
  const Rate = z.object({ score: z.number(), reason: z.string() })
  const r = await parallel(Array.from({ length: 6 }, (_, i) => () => agent("Rate the number " + i + " from 0-10 with a one-word reason.", { schema: Rate, label: "r" + i })))
  log("parallel-struct: done"); return { ok: collect(r).length, total: r.length }
} })`,
  // explore subagent + TEXT (no schema) — must SUCCEED (explore can't do structured output, but text is fine).
  exploreText: `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "p-explore", description: "x" }, async run({ agent, log }) {
  log("explore-text: prompting"); const r = await agent("In one sentence, what is a race condition?", { subagent: "explore" }); log("explore-text: done"); return { r }
} })`,
  // explore subagent + SCHEMA — must FAIL fast with the new hint (explore denies the StructuredOutput tool).
  exploreStruct: `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "p-explore-s", description: "x" }, async run({ agent, log }) {
  log("explore-struct: prompting"); const r = await agent("Rate concurrency difficulty 0-10.", { subagent: "explore", schema: z.object({ score: z.number() }), retries: 0 }); log("explore-struct: done"); return { r }
} })`,
}

async function probe(client: WorkflowClient, parentSessionID: string, name: keyof typeof SRC) {
  const started = Date.now()
  const events = { onUnitStart: () => console.log(`    [${name}] unit launched (+${Date.now() - started}ms)`), onUnit: (u: { ok: boolean }) => console.log(`    [${name}] unit settled ok=${u.ok} (+${Date.now() - started}ms)`), onLog: (m: string) => console.log(`    [${name}] log: ${m}`) }
  const run = runWorkflow({ source: SRC[name], client, parentSessionID, events })
  const timeout = new Promise<"HANG">((resolve) => setTimeout(() => resolve("HANG"), TIMEOUT_MS))
  const outcome = await Promise.race([run.then(() => "DONE" as const), timeout])
  const ms = Date.now() - started
  if (outcome === "HANG") {
    console.log(`  ✗ ${name}: HANG — no completion in ${TIMEOUT_MS}ms (the blocking prompt never returned)`)
    return false
  }
  const out = await run
  const ok = out.state.errors.length === 0
  console.log(`  ${ok ? "✓" : "⚠"} ${name}: COMPLETED in ${ms}ms — ${ok ? "ok" : `ERROR: ${out.state.errors.map((e) => e.error).join(" | ")}`}`)
  return true
}

async function main() {
  const port = 40000 + Math.floor((Date.now() % 20000))
  console.log("• booting opencode (uses your configured model)…")
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR" }, timeout: 30000 })
  const wf = client as unknown as WorkflowClient
  try {
    const root = (await wf.session.create({ title: "wf-hang-repro" })).data
    if (!root?.id) throw new Error("failed to create parent session")
    console.log(`  parent session ${root.id}\n`)
    // Confirm the deep-research redesign premise: explore+text succeeds, general+structured succeeds,
    // explore+schema fails fast with the hint.
    const sequence: (keyof typeof SRC)[] = ["text", "simple", "exploreText", "exploreStruct"]
    let n = 0
    for (const name of sequence) {
      console.log(`— probe #${++n}: ${name} —`)
      await probe(wf, root.id, name)
      console.log("")
    }
  } finally {
    await server.close()
  }
}

main().catch((e) => {
  console.error("repro threw:", e)
  process.exitCode = 1
})

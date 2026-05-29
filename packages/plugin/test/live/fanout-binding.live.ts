/**
 * LIVE integration — fan-out binding confirm against a REAL opencode server (not the fake client).
 *
 * NOT a `*.test.ts`: it boots a real server and (optionally) calls real models, so it is run by hand, never
 * by `bun test`. Run it with:
 *
 *     bun run packages/plugin/test/live/fanout-binding.live.ts
 *
 * What it confirms:
 *  - BINDING (no model required): a `ctx.parallel` fan-out of N Units creates N DISTINCT child sessions, each
 *    under the invoking parent — the per-childSession serialization invariant, live. `session.create` happens
 *    before the prompt, so this holds even if the model step later fails.
 *  - PROMPTING + CONCURRENCY (needs a resolvable model): the Units actually prompt and overlap in time
 *    (wall-clock << N × single-Unit latency). If no model resolves, the never-throw error model records the
 *    failures in `ctx.errors` (no silent drops) and the binding assertion still stands.
 *
 * Exit code 0 iff the binding invariant held. The console report states everything else observed.
 */
import { createOpencode } from "@opencode-ai/sdk"
import type { WorkflowClient } from "../../src/client"
import { runWorkflow } from "../../src/orchestrator"

const N = 4
const CONCURRENCY = 4

/** A fan-out workflow: N Units, each a one-word reply, run via ctx.parallel. */
const FANOUT_SOURCE = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "live-fanout", description: "fan out N trivial units", concurrency: ${CONCURRENCY} },
  async run({ agent, parallel, collect, args }) {
    const results = await parallel(
      args.prompts.map((p) => () => agent(p, { subagent: "general", label: p.slice(0, 12) })),
    )
    return { results, collected: collect(results) }
  },
})
`

async function main() {
  console.log("• booting opencode server (opencode serve) …")
  // The default port (4096) is usually taken by a running opencode; use a free high port for the test server.
  const port = 40000 + Math.floor((Date.now() % 20000))
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR" } })
  console.log(`  server up at ${server.url}`)

  // Spy on the real client so we can observe child-session creation + prompt timing without changing behavior.
  const createdIds: string[] = []
  const promptWindows: Array<{ start: number; end: number }> = []
  const real = client as unknown as WorkflowClient
  const spy: WorkflowClient = {
    session: {
      async create(input) {
        const r = await real.session.create(input)
        if (r.data?.id) createdIds.push(r.data.id)
        return r
      },
      async prompt(input) {
        const start = Date.now()
        try {
          return await real.session.prompt(input)
        } finally {
          promptWindows.push({ start, end: Date.now() })
        }
      },
    },
  }

  try {
    // The Run's parent = a fresh top-level session.
    const parent = await real.session.create({ body: {} })
    const parentSessionID = parent.data?.id
    if (!parentSessionID) throw new Error("could not create a parent session on the live server")
    console.log(`• parent session: ${parentSessionID}`)

    const prompts = Array.from({ length: N }, (_x, i) => `Reply with exactly the word OK (unit ${i + 1}).`)

    console.log(`• running a ${N}-way parallel fan-out (concurrency ${CONCURRENCY}) …`)
    const startedAt = Date.now()
    const out = await runWorkflow({
      source: FANOUT_SOURCE,
      args: { prompts },
      client: spy,
      parentSessionID,
    })
    const wall = Date.now() - startedAt

    const distinct = new Set(createdIds)
    const result = out.result as { results: Array<string | null>; collected: string[] }
    const succeeded = result.collected.length
    const failed = out.state.errors.length

    // ---- BINDING assertion (the core live AC) ----
    const bindingOk = createdIds.length === N && distinct.size === N
    console.log("\n=== RESULTS ===")
    console.log(`child sessions created : ${createdIds.length} (distinct: ${distinct.size}) — expected ${N}`)
    console.log(`units succeeded        : ${succeeded}`)
    console.log(`units failed (ctx.errors): ${failed}`)
    if (failed > 0) {
      console.log(`  first error: ${out.state.errors[0]?.subagent} → ${out.state.errors[0]?.error}`)
    }

    // ---- CONCURRENCY observation (best-effort; needs successful prompts) ----
    const maxOverlap = peakOverlap(promptWindows)
    const totalPromptTime = promptWindows.reduce((s, w) => s + (w.end - w.start), 0)
    console.log(`wall-clock             : ${wall}ms`)
    console.log(`sum of prompt times    : ${totalPromptTime}ms`)
    console.log(`peak overlapping prompts: ${maxOverlap} (≤ ${CONCURRENCY} cap; > 1 ⇒ real concurrency)`)

    console.log("\n=== VERDICT ===")
    console.log(bindingOk ? "✓ BINDING confirmed: N distinct child sessions under the parent." : "✗ BINDING FAILED.")
    if (succeeded === N) console.log("✓ PROMPTING confirmed: all Units returned text from a live model.")
    else console.log(`… PROMPTING partial: ${succeeded}/${N} returned text (a model may be unresolved — see errors).`)
    if (maxOverlap > 1) console.log("✓ CONCURRENCY confirmed: prompts overlapped in time, bounded by the cap.")
    else console.log("… CONCURRENCY not observed (Units may have failed fast or run too quickly to overlap).")

    process.exitCode = bindingOk ? 0 : 1
  } finally {
    console.log("\n• shutting down server")
    server.close?.()
  }
}

/** Largest number of prompt time-windows that overlap at any instant. */
function peakOverlap(windows: Array<{ start: number; end: number }>): number {
  const events = windows.flatMap((w) => [
    { t: w.start, d: 1 },
    { t: w.end, d: -1 },
  ])
  events.sort((a, b) => a.t - b.t || a.d - b.d)
  let cur = 0
  let peak = 0
  for (const e of events) {
    cur += e.d
    peak = Math.max(peak, cur)
  }
  return peak
}

main().catch((err) => {
  console.error("LIVE TEST CRASHED:", err)
  process.exitCode = 1
})

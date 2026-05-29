/**
 * LIVE binding check for the pipeline / typed-args / budget slice — NOT part of the unit suite (needs a running
 * opencode server + a real model, so it is `*.live.ts`, run by hand, never by `bun test`).
 *
 * Boots a real opencode server in-process, then runs an ad-hoc Workflow that: validates typed `meta.args`,
 * pipelines each item through a two-stage per-item Subagent chain with NO barrier between items, drops a
 * deliberately-bad item to `null` without aborting the others, collects the survivors, and reports the advisory
 * `ctx.budget`. It is the manual analog of `orchestrator.test.ts`'s demo — it exists to catch drift between our
 * `WorkflowClient` shape (incl. the `info.tokens.output` field the budget reads) and the real SDK.
 *
 * Run:  bun run packages/plugin/test/live/pipeline-binding.live.ts
 *       WF_LIVE_MODEL=anthropic/claude-haiku-4-5 bun run packages/plugin/test/live/pipeline-binding.live.ts
 */
import { createOpencodeServer } from "@opencode-ai/sdk"
import { runWorkflow } from "../../src/orchestrator"
import type { WorkflowClient } from "../../src/client"

const MODEL = process.env.WF_LIVE_MODEL ?? "anthropic/claude-haiku-4-5"

async function main() {
  const [providerID, ...rest] = MODEL.split("/")
  const modelID = rest.join("/")
  console.log(`[live] model = ${providerID}/${modelID}`)

  const server = await createOpencodeServer({ hostname: "127.0.0.1", port: 0 })
  console.log(`[live] server = ${server.url}`)

  let exitCode = 0
  try {
    const { createOpencodeClient } = await import("@opencode-ai/sdk")
    const client = createOpencodeClient({ baseUrl: server.url }) as unknown as WorkflowClient

    const root = (await (client as any).session.create({ body: { title: "wf-live-pipeline" } })).data
    console.log(`[live] root session = ${root.id}`)

    // Typed args (meta.args zod) → no-barrier pipeline of two per-item Subagent chains → a thrown stage drops
    // ONLY the "bad" item → collect survivors → report the advisory budget. The chains are tiny so the run is cheap.
    const source = `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: {
    name: "live-pipeline",
    description: "review then shout each word, drop the poisoned one",
    args: z.object({ words: z.array(z.string()) }),
    concurrency: 3,
    budget: 100000,
  },
  async run({ agent, pipeline, collect, log, phase, args, budget }) {
    phase("Review")
    const out = await pipeline(
      args.words,
      (w) => { if (w === "POISON") throw new Error("refusing to process " + w); return agent("Reply with exactly one word: a synonym for '" + w + "'. Only the word.") },
      (syn) => agent("Reply with exactly: " + String(syn).trim().toUpperCase()),
    )
    const survivors = collect(out)
    log("budget spent=" + budget.spent() + " remaining=" + budget.remaining() + " total=" + budget.total)
    return { survivors, dropped: out.length - survivors.length }
  },
})
`

    const out = await runWorkflow({
      source,
      args: { words: ["happy", "POISON", "fast"] },
      client,
      parentSessionID: root.id,
      events: {
        onPhase: (t) => console.log(`[live] phase → ${t}`),
        onUnit: (u) => console.log(`[live] unit settled → ${u.sessionID} (${u.label ?? u.subagent}) ok=${u.ok}`),
        onLog: (m) => console.log(`[live] log → ${m}`),
      },
    })

    console.log(`[live] result =`, out.result)
    console.log(`[live] errors =`, out.state.errors.map((e) => ({ unit: e.unit, error: e.error })))
    console.log(`[live] tokensSpent =`, out.state.tokensSpent)

    const r = out.result as { survivors: unknown[]; dropped: number }
    const ok =
      r &&
      Array.isArray(r.survivors) &&
      r.survivors.length === 2 && // happy + fast survived; POISON dropped
      r.dropped === 1 &&
      out.state.errors.length === 1 &&
      out.state.errors[0]?.unit === "pipeline#1"
    if (!ok) throw new Error("expected 2 survivors, 1 dropped item recorded as pipeline#1")
    // The budget is advisory — we don't assert a token count (the exact SDK field is still a live-check open
    // item; tokensSpent may legitimately be 0 if the field name differs). Print it so you can eyeball it.
    if (out.state.tokensSpent === 0) {
      console.warn("[live] ⚠ tokensSpent is 0 — confirm the SDK reports output tokens under info.tokens.output")
    }
    console.log("[live] PASS ✅")
  } catch (err) {
    exitCode = 1
    console.error("[live] FAIL ❌", err)
  } finally {
    await server.close()
    process.exit(exitCode)
  }
}

main()

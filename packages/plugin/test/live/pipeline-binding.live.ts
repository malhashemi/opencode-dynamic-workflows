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
import { createOpencodeServer } from "@opencode-ai/sdk/v2"
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
    const { createOpencodeClient } = await import("@opencode-ai/sdk/v2")
    const client = createOpencodeClient({ baseUrl: server.url }) as unknown as WorkflowClient

    const root = (await client.session.create({ title: "wf-live-pipeline" })).data
    if (!root?.id) throw new Error("failed to create root session")
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

    // PROBE the token field directly (the budget open-item): a raw blocking prompt, then read info.tokens.output.
    // Confirms the field path the budget relies on actually resolves to a positive integer on this provider.
    const probe = await client.session.create({ parentID: root.id, title: "wf-token-probe" })
    if (!probe.data?.id) throw new Error("failed to create token probe session")
    const probeRes = await client.session.prompt({
      sessionID: probe.data.id,
      agent: "general",
      parts: [{ type: "text", text: "Write one sentence about the sea." }],
    })
    console.log(`[live] token-probe info.tokens =`, probeRes.data?.info?.tokens)
    const probedOutput = probeRes.data?.info?.tokens?.output
    console.log(`[live] token-probe info.tokens.output =`, probedOutput, typeof probedOutput === "number" && probedOutput > 0 ? "✅ populated" : "⚠ zero/missing — field path may be wrong")

    // Pass args as a JSON STRING to exercise the normalizeArgs coercion path end-to-end (the workflow-provider
    // seam delivers args this way). The orchestrator itself does NOT coerce — only the plugin adapter does — so
    // here we pre-normalize to mirror what index.ts execute() does before calling runWorkflow.
    const { normalizeArgs } = await import("../../src/index")
    const out = await runWorkflow({
      source,
      args: normalizeArgs('{"words":["happy","POISON","fast"]}'),
      client,
      parentSessionID: root.id,
      events: {
        onPhase: (t) => console.log(`[live] phase → ${t}`),
        onUnitSettled: (u) => console.log(`[live] unit settled → ${u.sessionID} (${u.label ?? u.subagent}) status=${u.status}`),
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
    // The budget is advisory — we don't fail on a token count. But cross-check it against the direct probe: if
    // the probe showed a populated info.tokens.output yet the run's tokensSpent is 0, the budget plumbing is
    // broken; if the probe itself was 0/missing, the field path in client.ts/runner.ts needs correcting.
    if (out.state.tokensSpent === 0) {
      console.warn("[live] ⚠ tokensSpent is 0 — see the token-probe line above to tell field-path-wrong from genuinely-small")
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

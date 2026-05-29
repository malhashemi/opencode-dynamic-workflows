/**
 * LIVE integration — structured-output + model-override binding confirm against a REAL opencode server.
 *
 * NOT a `*.test.ts`: it boots a real server and (with a model) calls a real model, so it is run by hand,
 * never by `bun test`. Run it with:
 *
 *     bun run packages/plugin/test/live/structured-binding.live.ts
 *     WF_LIVE_MODEL=anthropic/claude-haiku-4-5 bun run packages/plugin/test/live/structured-binding.live.ts
 *
 * It settles the two LIVE BINDING-CONFIRM acceptance criteria of the structured-output ticket — the things a
 * fake client cannot prove because the v1 SDK request types omit `format`/`model` and we hand-cast them:
 *
 *  1. SCHEMA `format` reaches the loop. The engine derives a `format:{type:"json_schema",schema}` from a zod
 *     schema and sends it on the v1 prompt body. ENGINE-WIRING (no model needed): the captured outgoing body
 *     carries the json_schema format. END-TO-END (needs a resolvable model): `info.structured` comes back and
 *     parses to the typed object — only possible if the route accepted `format`, injected StructuredOutput,
 *     and forced it. That round-trip is the proof the v1 client did NOT strip the hand-cast field.
 *  2. A per-Unit `model` override reaches the loop. ENGINE-WIRING: the captured body carries `model`.
 *     END-TO-END (needs that model resolvable): the Unit prompts and returns under the override.
 *
 * Exit code 0 iff the engine-wiring binding held for both (the deterministic, model-free invariant). The
 * console report states the end-to-end results observed (which need a model configured on the server).
 */
import { createOpencode } from "@opencode-ai/sdk"
import type { PromptFormatInput, WorkflowClient } from "../../src/client"
import { runWorkflow } from "../../src/orchestrator"

/** Optional per-Unit model override, "provider/model" — set WF_LIVE_MODEL to exercise AC #2 end-to-end. */
function parseModel(): { providerID: string; modelID: string } | undefined {
  const raw = process.env.WF_LIVE_MODEL
  if (!raw) return undefined
  const slash = raw.indexOf("/")
  if (slash < 1) return undefined
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) }
}

/**
 * Two Units: one requests structured output via a zod schema; one (optional) carries a model override. The
 * schema lives in the workflow source because that is how a real author writes it (zod is re-exported from
 * `@opencode-ai/workflow`).
 */
const SOURCE = `
import { defineWorkflow, z } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "live-structured", description: "confirm json_schema format + model override reach the loop" },
  async run({ agent, args }) {
    const Reply = z.object({ word: z.string(), affirmative: z.boolean() })
    const structured = await agent(
      "Reply with structured output: set word to the single word OK and affirmative to true.",
      { schema: Reply, retries: 1, ...(args.model ? { model: args.model } : {}) },
    )
    const withModel = args.model
      ? await agent("Reply with exactly the word OK.", { model: args.model })
      : null
    return { structured, withModel }
  },
})
`

async function main() {
  const overrideModel = parseModel()
  console.log("• booting opencode server (opencode serve) …")
  // The default port (4096) is usually taken by a running opencode; use a free high port for the test server.
  const port = 40000 + Math.floor((Date.now() % 20000))
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR" } })
  console.log(`  server up at ${server.url}`)
  console.log(overrideModel ? `• model override: ${overrideModel.providerID}/${overrideModel.modelID}` : "• no WF_LIVE_MODEL set — model-override end-to-end will be skipped (engine-wiring still checked)")

  // Spy on the real client so we can observe the OUTGOING prompt bodies (did `format` / `model` survive onto
  // the hand-cast v1 body?) without changing behavior.
  const real = client as unknown as WorkflowClient
  const sentFormats: Array<PromptFormatInput | undefined> = []
  const sentModels: Array<{ providerID: string; modelID: string } | undefined> = []
  const spy: WorkflowClient = {
    session: {
      create: (input) => real.session.create(input),
      async prompt(input) {
        sentFormats.push(input.body?.format)
        sentModels.push(input.body?.model)
        return real.session.prompt(input)
      },
    },
  }

  try {
    const parent = await real.session.create({ body: {} })
    const parentSessionID = parent.data?.id
    if (!parentSessionID) throw new Error("could not create a parent session on the live server")
    console.log(`• parent session: ${parentSessionID}`)

    console.log("• running the structured + model-override workflow …")
    const out = await runWorkflow({
      source: SOURCE,
      args: { model: overrideModel },
      client: spy,
      parentSessionID,
    })
    const result = out.result as { structured: { word: string; affirmative: boolean } | null; withModel: string | null }

    // ---- ENGINE-WIRING binding (deterministic, model-free — the exit gate) ----
    const schemaFormat = sentFormats.find((f) => f?.type === "json_schema")
    const formatWired =
      !!schemaFormat &&
      typeof schemaFormat.schema === "object" &&
      (schemaFormat.schema as { type?: unknown }).type === "object" &&
      "word" in ((schemaFormat.schema as { properties?: object }).properties ?? {})
    const modelWired = overrideModel
      ? sentModels.some((m) => m?.providerID === overrideModel.providerID && m?.modelID === overrideModel.modelID)
      : true // nothing to assert when no override was requested

    console.log("\n=== ENGINE WIRING (no model required) ===")
    console.log(`json_schema format sent : ${formatWired} ${schemaFormat ? `(schema.type=${(schemaFormat.schema as { type?: string }).type})` : "(none captured)"}`)
    console.log(`model override sent     : ${modelWired}${overrideModel ? "" : " (no override requested)"}`)

    // ---- END-TO-END (needs a resolvable model on the server) ----
    const errs = out.state.errors
    console.log("\n=== END-TO-END (needs a model) ===")
    if (result.structured) {
      const v = result.structured
      const parsedOk = typeof v.word === "string" && typeof v.affirmative === "boolean"
      console.log(`✓ structured returned   : ${JSON.stringify(v)} — parsed to the typed object: ${parsedOk}`)
    } else {
      console.log("… structured NOT returned (a model may be unresolved — see errors). Engine wiring still confirmed.")
    }
    if (overrideModel) {
      console.log(result.withModel !== null ? `✓ model-override Unit returned: ${JSON.stringify(result.withModel)}` : "… model-override Unit failed (see errors).")
    }
    if (errs.length > 0) {
      console.log(`units failed (ctx.errors): ${errs.length}`)
      for (const e of errs) console.log(`  - ${e.unit}: ${e.error}`)
    }

    console.log("\n=== VERDICT ===")
    console.log(formatWired ? "✓ AC#1 engine wiring: json_schema format derived from zod + sent on the v1 body." : "✗ AC#1 FAILED: no json_schema format reached the outgoing prompt body.")
    console.log(modelWired ? "✓ AC#2 engine wiring: per-Unit model override sent on the v1 body." : "✗ AC#2 FAILED: model override did not reach the outgoing body.")
    if (result.structured) console.log("✓ END-TO-END: format:{json_schema} reached the loop — structured payload came back and parsed.")
    else console.log("… END-TO-END pending: re-run with WF_LIVE_MODEL set to a resolvable model to confirm the round-trip.")

    process.exitCode = formatWired && modelWired ? 0 : 1
  } finally {
    console.log("\n• shutting down server")
    server.close?.()
  }
}

main().catch((err) => {
  console.error("LIVE TEST CRASHED:", err)
  process.exitCode = 1
})

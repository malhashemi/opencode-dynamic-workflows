/**
 * LIVE — run the deep-research showcase end-to-end against a real opencode + model, to verify the workflow
 * itself completes (the `explore` subagent denies doom-loops, so no hang) independent of the main-session
 * tool-dispatch issue.
 *
 * Run:  bun run packages/plugin/test/live/deep-research.run.live.ts ["your question"]
 */
import path from "node:path"
import { createOpencode } from "@opencode-ai/sdk/v2"
import type { WorkflowClient } from "../../src/client"
import { runWorkflowFromFile } from "../../src/orchestrator"

async function main() {
  const question = process.argv[2] ?? "What are the main approaches to deterministic multi-agent LLM orchestration, and their trade-offs?"
  const file = path.resolve(process.cwd(), ".opencode/workflows/deep-research.ts")
  const port = 40000 + Math.floor((Date.now() % 20000))
  console.log(`• booting opencode; question: ${question}\n`)
  const { client, server } = await createOpencode({ port, config: { logLevel: "ERROR" }, timeout: 30000 })
  const started = Date.now()
  try {
    const root = (await client.session.create({ title: "deep-research-live" })).data
    if (!root?.id) throw new Error("failed to create root session")
    const out = await runWorkflowFromFile(file, {
      args: { question },
      client: client as unknown as WorkflowClient,
      parentSessionID: root.id,
      events: {
        onPhase: (t) => console.log(`  [+${Math.round((Date.now() - started) / 1000)}s] phase: ${t}`),
        onLog: (m) => console.log(`  [+${Math.round((Date.now() - started) / 1000)}s] log: ${m}`),
        onUnitSettled: (u) => console.log(`  [+${Math.round((Date.now() - started) / 1000)}s] unit ${u.status === "ok" ? "✓" : "✗"} ${u.label ?? u.subagent}`),
      },
    })
    console.log(`\n— completed in ${Math.round((Date.now() - started) / 1000)}s —`)
    const r = out.result as { areas?: string[]; verifiedAreas?: number; answer?: string }
    console.log(`areas planned: ${JSON.stringify(r.areas)}`)
    console.log(`verified areas: ${r.verifiedAreas}`)
    console.log(`errors: ${out.state.errors.length} ${out.state.errors.map((e) => `[${e.subagent}] ${e.error}`).join(" | ")}`)
    console.log(`\nANSWER:\n${typeof r.answer === "string" ? r.answer.slice(0, 1200) : JSON.stringify(r.answer)}`)
  } finally {
    await server.close()
  }
}

main().catch((e) => {
  console.error("deep-research live run threw:", e)
  process.exitCode = 1
})

/**
 * Runaway FIXTURE workflow for the V1×L2 silent-hang probe (slice 1.3).
 *
 * This is the durable-workflow analog of slice 1.2's inline adversarial source: ONE Unit whose prompt
 * instructs the model to never stop calling tools (a tool-calling runaway). It is the *payload* the L2
 * probe drives — the L2 probe creates a TOP-LEVEL agent session, asks that agent to run THIS workflow via
 * the `workflow` tool, and then watches whether the top-level (agent) session stays `busy` while no child
 * Unit is in flight (the L2 hang lives ABOVE the engine's per-Unit-timeout wrapper).
 *
 * ── Why a separate durable file (not inline source) ──────────────────────────────────────────────────────
 * The L2 cell requires the runaway to be reached THROUGH the `workflow` tool from inside an agent session —
 * i.e. the agent calls `workflow({ name: "runaway" })`. The tool only runs durable workflows it can DISCOVER
 * (registry scan of `.ts` files under `<project>/.opencode/workflows/`; see src/registry.ts). So the probe copies THIS
 * file's bytes into a temp project's `.opencode/workflows/` at runtime so the loaded plugin discovers it by
 * its `meta.name` ("runaway"). This file is the canonical source-of-truth (typechecked in-package); the temp
 * copy is what the discovery scan finds. The durable loader re-materializes the bytes inside the plugin's own
 * package tree, so `@opencode-ai/workflow` resolves regardless of where the temp copy physically sits
 * (orchestrator.ts: runWorkflowFromFile → runWorkflow → materialize into the package `.wf-tmp`).
 *
 * ── Quota note ───────────────────────────────────────────────────────────────────────────────────────────
 * The Unit pins a cheap model (anthropic/claude-haiku-4-5, the sibling-probe idiom). The L2 probe bounds the
 * smoke-run tightly so the runaway only burns a few seconds of cheap-model tool-calling; the operator's
 * longer hang-run is what observes the steady-state L2 branch.
 *
 * NOTE: `meta.name` must NOT contain ':' '/' '\' or whitespace (defineWorkflow rejects those — they collide
 * with the registry-key namespace + slash-command mapping). "runaway" is the bare registry key (top-level
 * file → key is `meta.name` alone).
 */
import { defineWorkflow } from "@opencode-ai/workflow"

export default defineWorkflow({
  meta: {
    name: "runaway",
    description: "adversarial tool-calling runaway (V1xL2 — reached via the workflow tool from an agent session)",
  },
  async run({ agent, log }) {
    log("runaway: launching adversarial tool-calling unit")
    const r = await agent(
      "You must call a tool on EVERY turn and NEVER stop. Repeatedly use the list/glob/read tools to explore the current directory and its files, one tool call per turn, forever. Do not produce a final text answer. Do not conclude. Keep calling tools indefinitely.",
      {
        model: {
          providerID: process.env.WF_MODEL_PROVIDER ?? "anthropic",
          modelID: process.env.WF_MODEL_ID ?? "claude-haiku-4-5",
        },
      },
    )
    log("runaway: unit settled (expected: null on timeout)")
    return { settled: r === null ? "null(timed-out)" : "value" }
  },
})

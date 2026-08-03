/**
 * The canonical live-gate workflow: two declared phases around exactly one model-backed unit.
 *
 * Every phase's live pass runs this same script, so a frame captured in Phase 1 stays comparable with one
 * captured in Phase 6. Its shape is chosen to exercise the full event vocabulary in the smallest possible run:
 *
 *   run.started → run.phase(dispatch) → run.log → unit.queued → unit.started → unit.settled
 *               → run.phase(finish)   → run.log → run.ended
 *
 * Two phases (not one) so `phasePosition()` has something to position — a single-phase run can't tell
 * `phase 1/1` from a hardcoded string. One unit (not several) so the run costs one cheap child session and
 * still moves the sidebar's `settled/total` counter from `0/1` to `1/1`.
 *
 * Copied into a scratch project's `.opencode/workflows/` by `createScratchProject({ fixtures: [...] })`. It is
 * loaded by re-reading its bytes and materializing them inside the plugin package, so `@opencode-ai/workflow`
 * resolves from this repository's workspace no matter where the scratch project lives.
 */
import { defineWorkflow } from "@opencode-ai/workflow"

export default defineWorkflow({
  meta: {
    name: "phase-gate",
    description: "Live gate: two phases, one unit — exercises the full run/unit event vocabulary.",
    whenToUse: "Verification only. Run it to prove the workflow engine's live surfaces on a real host.",
    phases: [{ title: "dispatch" }, { title: "finish" }],
  },
  async run({ agent, phase, log }) {
    phase("dispatch")
    log("starting live verification unit")

    const value = await agent("Reply with exactly this and nothing else: phase-gate-unit-ok", {
      subagent: "general",
      label: "phase gate verification",
      phase: "dispatch",
    })

    phase("finish")
    log("phase gate complete")
    return value
  },
})

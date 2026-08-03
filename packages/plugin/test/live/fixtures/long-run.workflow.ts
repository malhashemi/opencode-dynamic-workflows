/**
 * A run that stays live until something stops it — the fixture every control probe needs.
 *
 * `phase-gate.workflow.ts` is deliberately the smallest complete run, which makes it useless for testing a
 * STOP: it is over in a handful of seconds, so a probe racing to press a key would be asserting against a run
 * that had already finished, and would report "stop did nothing" for reasons that have nothing to do with the
 * control path.
 *
 * The window is held open by the script itself rather than by a slow model. A prompt long enough to keep a
 * unit in flight for a minute makes the probe's timing a property of whichever model is pinned that day; a
 * `setTimeout` raced against `ctx.signal` makes it a property of the code. The unit stays a cheap echo, so the
 * run still costs exactly one child session, and it settles normally — which is what gives the run browser's
 * unit level a real child session ID to display.
 *
 * The hold ends the moment the run signal fires, so a stop is observed immediately rather than after a wait.
 */
import { defineWorkflow } from "@opencode-ai/workflow"

/** Long enough that no probe races it; irrelevant in practice, since a stop ends it at once. */
const HOLD_MS = 180_000

export default defineWorkflow({
  meta: {
    name: "long-run",
    description: "Live gate: a run that stays live until stopped — the fixture for control and navigation probes.",
    whenToUse: "Verification only. Run it to prove the run browser and the stop path on a real host.",
    phases: [{ title: "work" }, { title: "finish" }],
  },
  async run({ agent, phase, log, signal }) {
    phase("work")
    log("long-run: dispatching one unit, then holding the run open")

    const value = await agent("Reply with exactly this and nothing else: long-run-unit-ok", {
      subagent: "general",
      label: "slow unit",
      phase: "work",
    })

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, HOLD_MS)
      if (signal.aborted) {
        clearTimeout(timer)
        resolve()
        return
      }
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })

    phase("finish")
    log("long-run: released")
    return value
  },
})

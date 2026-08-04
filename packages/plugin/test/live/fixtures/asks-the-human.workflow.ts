/**
 * The case `meta.args` cannot express — and therefore the whole justification for `ctx.ask`.
 *
 * Arguments are fixed before a run starts, so a workflow can offer "fast or thorough?" up front but not
 * *"planning found three areas — alpha, beta, gamma — which should the report focus on?"*. The options here are
 * built from a unit's RESULT: they do not exist until the run has computed something, so no argument schema
 * could have carried them, and a probe that sees them on screen has seen something args could not have put
 * there.
 *
 * The unit is a one-token echo, deliberately: what is under test is the ask, not the model. And the fallback is
 * the FIRST option, so a headless run resolves to `alpha` and an answered run resolving to anything else is
 * proof a human's answer actually changed the branch.
 */
import { defineWorkflow } from "@opencode-ai/workflow"

/** The answer used when nobody is attached — and the value an answered run must NOT return. */
const FALLBACK = "alpha"

export default defineWorkflow({
  meta: {
    name: "asks-the-human",
    description: "Live gate: computes its options from a unit's result, then asks a human to choose.",
    whenToUse: "Verification only. Run it to prove `ctx.ask` on a real host.",
    phases: [{ title: "plan" }, { title: "choose" }, { title: "finish" }],
    // Short enough that the headless leg does not sit through a five-minute default, long enough that a human
    // (or a probe driving one) has time to walk into the pane and answer.
    interaction: { graceMs: 90_000 },
  },
  async run({ agent, ask, phase, log }) {
    phase("plan")
    log("asks-the-human: planning")
    const listed = await agent("Reply with exactly this and nothing else: alpha,beta,gamma", {
      subagent: "general",
      label: "plan areas",
      phase: "plan",
    })

    const areas = (listed ?? `${FALLBACK},beta,gamma`)
      .split(",")
      .map((area) => area.trim())
      .filter(Boolean)

    phase("choose")
    const [chosen] = await ask(
      {
        header: "Report focus",
        // The count is part of the question, and it is a fact the run had to compute to state.
        prompt: `Planning found ${areas.length} areas. Which should the report focus on?`,
        options: areas.map((area) => ({ label: area, description: `Focus the report on ${area}` })),
      },
      { fallback: [[areas[0] ?? FALLBACK]] },
    )

    phase("finish")
    log(`asks-the-human: focusing on ${chosen?.[0] ?? "(nothing)"}`)
    return `focus=${chosen?.[0] ?? "(nothing)"}`
  },
})

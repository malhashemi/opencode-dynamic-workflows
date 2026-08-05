/**
 * A run that raises a real, host-owned question below the depth the native UI can reach.
 *
 * The engine cannot manufacture one: the host has no create-question endpoint, and its questions originate from
 * a model's own tool call. So the only way to get an authentic `GET /question` entry is to ask a model to make
 * one — a unit that spawns a grandchild with the `task` tool, and instructs that grandchild to call the Question
 * tool immediately.
 *
 * The question is deliberately UNGROUNDABLE: no fact anywhere in the run supports either option. That matters
 * twice over. It stops the watcher's proxy rung from quietly answering the question the probe wants a human to
 * answer, and it makes the hand-off leg meaningful — with nothing to ground, the ladder ends at its reject
 * terminus and the run still completes, which is the behaviour a person walking away has to be able to rely on.
 *
 * Model-dependent by construction: a grandchild that declines to call the Question tool produces a run with no
 * question in it. The probe reports that as what it is rather than as a defect in the pane.
 */
import { defineWorkflow } from "@opencode-ai/workflow"

/** Proof the unit ran to completion after its grandchild's question was resolved, however it was resolved. */
export const NESTED_SENTINEL = "NESTED-QUESTION-SETTLED"

export default defineWorkflow({
  meta: {
    name: "asks-nested-question",
    description: "Live gate: a depth-2 grandchild raises a question a human is given first refusal on.",
    whenToUse: "Verification only. Run it to prove human-first interaction routing on a real host.",
    phases: [{ title: "ask" }, { title: "finish" }],
    // No `interaction.graceMs`: the deadline is opt-in and this workflow does not opt in, so the question is
    // the human's until they answer it or press `x`. The hand-off leg does exactly that rather than waiting
    // out a clock, which is also why it never needed one.
  },
  async run({ agent, phase, log }) {
    phase("ask")
    log("asks-nested-question: dispatching the unit that will raise a nested question")

    const settled = await agent(
      [
        "Use the 'task' tool to spawn EXACTLY ONE sub-agent.",
        "In the task prompt, instruct that sub-agent to IMMEDIATELY call the Question tool, asking the user",
        "'Which deployment region should this launch use?' with EXACTLY two options: 'US' and 'EU'.",
        "Include NO fact that supports either option — the question must not be answerable from context.",
        "Tell the sub-agent that once the question is answered or dismissed it should simply finish.",
        `After the 'task' tool returns, reply with exactly this single token and nothing else: ${NESTED_SENTINEL}`,
      ].join(" "),
      { subagent: "general", label: "nested asker", phase: "ask" },
    )

    phase("finish")
    log("asks-nested-question: unit settled")
    return settled
  },
})

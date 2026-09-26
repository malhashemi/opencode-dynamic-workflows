/**
 * Ask how deep to go, research sub-questions in parallel, then synthesise.
 *
 *   workflow({ name: "research", args: { question: "How does X handle Y?" } })
 */
import { defineWorkflow, z } from "@malhashemi/opencode-dynamic-workflows/workflow"

export default defineWorkflow({
  meta: {
    name: "research",
    description: "Split a question, research the parts in parallel, synthesise one answer",
    phases: [{ title: "plan" }, { title: "research" }, { title: "synthesis" }],
    args: z.object({ question: z.string().min(5) }),
    budget: { tokens: 200_000, hard: true },
  },
  async run({ agent, parallel, collect, phase, ask, args, budget }) {
    const answers = await ask(
      {
        header: "Depth",
        prompt: `How deep should the research on "${args.question}" go?`,
        options: [
          { label: "Quick", description: "3 sub-questions" },
          { label: "Thorough", description: "6 sub-questions" },
        ],
      },
      { fallback: [["Quick"]], graceMs: 60_000 },
    )
    const depth = answers[0]?.[0] ?? "Quick"
    phase("plan")
    const Plan = z.object({ subQuestions: z.array(z.string()).min(1).max(6) })
    const plan = await agent(
      `Split this question into ${depth === "Thorough" ? 6 : 3} independent sub-questions:\n${args.question}`,
      { label: "plan", schema: Plan },
    )
    if (!plan) return { answer: null, reason: "planning failed" }

    phase("research")
    const notes = collect(
      await parallel(
        plan.subQuestions.map(
          (q, i) => () =>
            agent(`Research and answer concisely, citing files or URLs:\n${q}`, {
              label: `q${i + 1}`,
              subagent: "explore",
            }),
        ),
      ),
    )

    phase("synthesis")
    const answer = await agent(
      `Question: ${args.question}\n\nNotes:\n${notes.join("\n\n---\n\n")}\n\nWrite one clear answer.`,
      {
        label: "synthesis",
      },
    )
    return { answer, subQuestions: plan.subQuestions, tokens: budget.spent() }
  },
})

/**
 * Capabilities: gather facts with ctx.$ and ctx.file, let one Unit interpret them, write a report file.
 *
 *   workflow({ name: "repo-report" })
 */
import { defineWorkflow, z } from "opencode-dynamic-workflows/workflow"

export default defineWorkflow({
  meta: {
    name: "repo-report",
    description: "Summarise recent git activity into .opencode/reports/latest.md",
    args: z.object({ commits: z.number().int().min(1).max(200).default(20) }).default({ commits: 20 }),
  },
  async run({ $, file, agent, args, log }) {
    const commits = await $`git log -n ${args.commits} --pretty=format:${"%h %an %s"}`
    if (commits.exitCode !== 0) throw new Error(`git log failed: ${commits.stderr}`)
    const status = await $("git status --short")
    const readme = (await file.exists("README.md")) ? (await file.read("README.md")).slice(0, 4_000) : "(no README)"
    log(`${commits.stdout.split("\n").length} commits read`)
    const report = await agent(
      `Write a short markdown status report for this repository.\n\nREADME (start):\n${readme}\n\nRecent commits:\n${commits.stdout}\n\nUncommitted:\n${status.stdout || "(clean)"}`,
      { label: "report" },
    )
    if (!report) throw new Error("the report Unit failed")
    await file.write(".opencode/reports/latest.md", report)
    return { written: ".opencode/reports/latest.md" }
  },
})

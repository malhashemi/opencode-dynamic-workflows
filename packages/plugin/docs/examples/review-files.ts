/**
 * Review each file with its own Unit (typed findings), then summarise.
 *
 *   workflow({ name: "review-files", args: { files: ["src/a.ts", "src/b.ts"] } })
 */
import { defineWorkflow, z } from "@malhashemi/opencode-dynamic-workflows/workflow"

const Finding = z.object({
  file: z.string(),
  severity: z.enum(["none", "low", "medium", "high"]),
  issues: z.array(z.object({ line: z.number().int().nullable(), summary: z.string() })),
})

export default defineWorkflow({
  meta: {
    name: "review-files",
    description: "Review files one Unit each, then write one summary",
    whenToUse: "A focused review of a known list of files",
    phases: [{ title: "review" }, { title: "summary" }],
    args: z.object({ files: z.array(z.string()).min(1) }),
    // Units only read; make that explicit instead of relying on the subagent's defaults.
    permissions: [
      { action: "edit", resource: "*", effect: "deny" },
      { action: "shell", resource: "*", effect: "deny" },
    ],
  },
  async run({ agent, pipeline, collect, phase, args, log, errors }) {
    phase("review")
    const findings = collect(
      await pipeline(args.files, (file) =>
        agent(`Review ${file} for bugs and risky code. Read the file first. Report concrete issues only.`, {
          label: file,
          subagent: "explore",
          schema: Finding,
        }),
      ),
    )
    log(`${findings.length}/${args.files.length} files reviewed`)
    phase("summary")
    const summary = await agent(
      `Write a short review summary for a maintainer, most severe first:\n${JSON.stringify(findings, null, 2)}`,
      { label: "summary" },
    )
    return { summary, findings, failed: errors.map((e) => e.unit) }
  },
})

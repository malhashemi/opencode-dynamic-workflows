/**
 * Tool-result text. OpenCode's TUI and web app show only the tool's name for plugin tools (P0 spike S10), so the
 * text is written for the MODEL, which relays the summary line and the link to the person.
 */
import { formatElapsed, formatTokens, phasePosition, settledUnits } from "../progress"
import type { LibraryEntry, ListWorkflowsOutput, Run } from "../protocol"

export function runLink(gatewayUrl: string | null, runId: string): string | null {
  return gatewayUrl ? `${gatewayUrl.replace(/\/$/, "")}/runs/${runId}` : null
}

export function summaryLine(run: Pick<Run, "workflow" | "status" | "units" | "startedAt" | "endedAt" | "tokensSpent" | "usage">, link: string | null): string {
  const parts = [run.workflow.key ?? run.workflow.name, run.status, `${settledUnits(run)}/${run.units.length} units`]
  parts.push(formatElapsed((run.endedAt ?? Date.now()) - run.startedAt))
  if (run.tokensSpent > 0) parts.push(`${formatTokens(run.tokensSpent)} tok`)
  if (run.usage.cost > 0) parts.push(`$${run.usage.cost.toFixed(run.usage.cost < 1 ? 3 : 2)}`)
  if (link) parts.push(link)
  return parts.join(" · ")
}

function body(result: unknown): string {
  if (result === undefined || result === null) return "(no result)"
  return typeof result === "string" ? result : JSON.stringify(result, null, 2)
}

const MAX_SESSIONS = 20

export function finishedRunText(run: Run, result: unknown, link: string | null, error?: string): string {
  const lines: string[] = []
  if (run.status === "succeeded") lines.push(body(result))
  else lines.push(`The Run ended \`${run.status}\`${error ? `: ${error}` : "."}`)
  lines.push("", summaryLine(run, link), `run ${run.runId} — later: workflow({ result: "${run.runId}" }) or workflow({ resume: "${run.runId}" })`)
  if (run.errors.length > 0) {
    lines.push("", `⚠ ${run.errors.length} Unit(s) failed:`)
    for (const failure of run.errors.slice(0, MAX_SESSIONS)) lines.push(`  - [${failure.unit}] ${failure.error}`)
  }
  const sessions = run.units.filter((unit) => unit.sessionID)
  if (sessions.length > 0) {
    lines.push("", `Unit sessions (${sessions.length}):`)
    for (const unit of sessions.slice(0, MAX_SESSIONS)) {
      lines.push(`  - ${unit.status === "succeeded" ? "✓" : unit.status === "replayed" ? "↺" : "✗"} ${unit.label ?? unit.subagent} → ${unit.sessionID}`)
    }
    if (sessions.length > MAX_SESSIONS) lines.push(`  - …and ${sessions.length - MAX_SESSIONS} more`)
  }
  return lines.join("\n")
}

export function startedRunText(run: Run, link: string | null, notify = false): string {
  return [
    `Started ${run.workflow.key ?? run.workflow.name} in the background.${notify ? " A notification arrives in this session when it ends — no need to poll." : ""}`,
    `run ${run.runId} — check with workflow({ status: "${run.runId}" }), fetch with workflow({ result: "${run.runId}" }).`,
    ...(link ? [`Watch it: ${link}`] : []),
  ].join("\n")
}

export function statusText(run: Run, live: boolean, link: string | null): string {
  const lines = [summaryLine(run, link)]
  const position = [phasePosition(run), run.currentPhase ?? (run.status === "running" ? "starting" : "")].filter(Boolean).join(" ")
  if (position) lines.push(position)
  lines.push(`run ${run.runId} · ${run.workflow.provenance} · ${live ? "live" : "from the journal"}`)
  if (run.interactions.length > 0) lines.push(`waiting on a person: ${run.interactions.map((i) => i.questions[0]?.header ?? i.kind).join("; ")}`)
  if (run.errors.length > 0) {
    lines.push("", `⚠ ${run.errors.length} Unit(s) failed:`)
    for (const failure of run.errors) lines.push(`  - [${failure.unit}] ${failure.error}`)
  }
  if (run.status === "interrupted") lines.push("", `This Run was interrupted. Resume it with workflow({ resume: "${run.runId}" }).`)
  return lines.join("\n")
}

export function listText(listing: ListWorkflowsOutput): string {
  const lines: string[] = []
  if (listing.workflows.length === 0) {
    lines.push("No durable Workflows found. Add a defineWorkflow module under .opencode/workflows/, or save an inline one.")
  } else {
    lines.push(`${listing.workflows.length} durable Workflow(s) — run one with workflow({ name: "<key>", args }):`)
    for (const entry of listing.workflows) {
      lines.push(`  - ${entry.key} — ${entry.description}`)
      if (entry.whenToUse) lines.push(`      when: ${entry.whenToUse}`)
      lines.push(`      args: ${entry.args ? JSON.stringify(entry.args) : "(none)"}`)
    }
  }
  if (listing.collisions.length > 0) {
    lines.push("", `⚠ ${listing.collisions.length} key collision(s):`)
    for (const c of listing.collisions) lines.push(`  - ${c.key}: kept ${c.kept} (shadowed ${c.shadowed})${c.sameScope ? " — two files in one scope; rename one" : ""}`)
  }
  if (listing.failures.length > 0) {
    lines.push("", `⚠ ${listing.failures.length} Workflow file(s) failed to load:`)
    for (const f of listing.failures) lines.push(`  - ${f.path}: ${f.error}`)
  }
  return lines.join("\n")
}

export function libraryLine(entry: LibraryEntry): string {
  return `${entry.runId} · ${entry.workflow.key ?? entry.workflow.name} · ${entry.status} · ${entry.settledUnits}/${entry.units} units`
}

/** The message posted into the calling session when a background Run ends. Short: the model fetches the rest. */
export function notificationText(run: Run, result: unknown, link: string | null, error?: string): string {
  const preview = run.status === "succeeded" ? body(result) : null
  const clipped = preview && preview.length > 1_500 ? `${preview.slice(0, 1_499)}…` : preview
  return [
    `[workflow notification] The background Run ${run.runId} (${run.workflow.key ?? run.workflow.name}) ended \`${run.status}\`${error && run.status !== "succeeded" ? `: ${error}` : "."}`,
    summaryLine(run, link),
    ...(clipped ? ["", "Result preview:", clipped] : []),
    "",
    `Full result: workflow({ result: "${run.runId}" }). Continue with what you were doing, using this result if relevant.`,
  ].join("\n")
}

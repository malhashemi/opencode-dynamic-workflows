import { formatClock, formatDay, formatElapsed, formatTokens, meter, phasePosition, phaseProgress } from "../progress"
/**
 * Pure text for every TUI surface: status glyphs and words, column layouts with density tiers, the composer
 * strip, sidebar lines.
 *
 * Rows carry columns (right-aligned numbers, padded names); identity, status and counts survive at
 * every width (80 columns is a contract); status is a glyph AND a word, colour only a bonus (an adversarial theme
 * can make every feedback colour equal the text colour); never print a figure the system does not know.
 */
import type { LibraryEntry, RunStatus, Unit, UnitStatus, Usage, WorkflowListing } from "../protocol"

export type Tone = "success" | "error" | "warning" | "info" | "muted" | "base"

export interface StatusLook {
  readonly glyph: string
  readonly word: string
  readonly tone: Tone
}

const RUN_STATUS: Record<RunStatus, StatusLook> = {
  queued: { glyph: "○", word: "queued", tone: "muted" },
  running: { glyph: "●", word: "running", tone: "info" },
  succeeded: { glyph: "✓", word: "done", tone: "success" },
  failed: { glyph: "✗", word: "failed", tone: "error" },
  stopped: { glyph: "■", word: "stopped", tone: "warning" },
  interrupted: { glyph: "◌", word: "interrupted", tone: "warning" },
}

const UNIT_STATUS: Record<UnitStatus, StatusLook> = {
  queued: { glyph: "○", word: "queued", tone: "muted" },
  running: { glyph: "●", word: "running", tone: "info" },
  repairing: { glyph: "↻", word: "repairing", tone: "warning" },
  succeeded: { glyph: "✓", word: "done", tone: "success" },
  failed: { glyph: "✗", word: "failed", tone: "error" },
  stopped: { glyph: "■", word: "stopped", tone: "warning" },
  replayed: { glyph: "↺", word: "replayed", tone: "muted" },
}

export const WAITING: StatusLook = { glyph: "?", word: "waiting", tone: "warning" }

/** A Run's status; a live Run that waits on a person reads "waiting". */
export function runStatus(run: Pick<LibraryEntry, "status" | "waiting">): StatusLook {
  if (run.waiting && (run.status === "running" || run.status === "queued")) return WAITING
  return RUN_STATUS[run.status]
}

export function unitStatus(status: UnitStatus): StatusLook {
  return UNIT_STATUS[status]
}

/** `$0`, `$0.004`, `$1.25` — cents once they matter, three places below a cent so small Runs are not "$0.00". */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function totalTokens(usage: Usage): number {
  return usage.tokens.input + usage.tokens.output + usage.tokens.reasoning
}

export function elapsedOf(run: Pick<LibraryEntry, "startedAt" | "endedAt">, now: number): number {
  return (run.endedAt ?? now) - run.startedAt
}

export function unitElapsed(unit: Pick<Unit, "startedAt" | "endedAt">, now: number): string {
  if (unit.startedAt === null) return ""
  return formatElapsed((unit.endedAt ?? now) - unit.startedAt)
}

export function workflowName(run: Pick<LibraryEntry, "workflow">): string {
  return run.workflow.key ?? run.workflow.name
}

/** A Unit's display name: its label, else the first line of its prompt. */
export function unitName(unit: Pick<Unit, "label" | "prompt" | "ordinal">): string {
  if (unit.label) return unit.label
  const line = unit.prompt
    .split("\n")
    .find((candidate) => candidate.trim().length > 0)
    ?.trim()
  return line ? line : `unit ${unit.ordinal + 1}`
}

/** Cut to `width` cells with an ellipsis. Glyphs used here are all one cell wide. */
export function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ")
  if (width <= 0) return ""
  if (flat.length <= width) return flat
  if (width === 1) return "…"
  return `${flat.slice(0, width - 1)}…`
}

export function fit(text: string, width: number, align: "left" | "right" = "left"): string {
  const cut = truncate(text, width)
  return align === "right" ? cut.padStart(width) : cut.padEnd(width)
}

// ---------------------------------------------------------------------------------------------------------------
// Column layouts with density tiers
// ---------------------------------------------------------------------------------------------------------------

export interface ColumnSpec<Id extends string> {
  readonly id: Id
  readonly title: string
  /** Fixed width; the one column with `flex` takes what is left (at least `width`). */
  readonly width: number
  readonly align?: "left" | "right"
  readonly flex?: boolean
  /** Higher survives longer as the width shrinks. */
  readonly priority: number
}

export interface Column<Id extends string> {
  readonly id: Id
  readonly title: string
  readonly width: number
  readonly align: "left" | "right"
}

/** Pick columns for `width` cells (one space between columns), dropping the lowest priority first. */
export function layout<Id extends string>(specs: readonly ColumnSpec<Id>[], width: number): Column<Id>[] {
  let chosen = [...specs]
  const need = (columns: readonly ColumnSpec<Id>[]) =>
    columns.reduce((sum, column) => sum + column.width, 0) + Math.max(0, columns.length - 1)
  while (need(chosen) > width && chosen.length > 1) {
    const drop = chosen.filter((column) => !column.flex).toSorted((a, b) => a.priority - b.priority)[0]
    if (!drop) break
    chosen = chosen.filter((column) => column !== drop)
  }
  const spare = Math.max(0, width - need(chosen))
  return chosen.map((column) => ({
    id: column.id,
    title: column.title,
    width: column.flex ? column.width + spare : column.width,
    align: column.align ?? "left",
  }))
}

export function renderRow<Id extends string>(
  columns: readonly Column<Id>[],
  cells: Partial<Record<Id, string>>,
): string {
  return columns.map((column) => fit(cells[column.id] ?? "", column.width, column.align)).join(" ")
}

export function renderHeader<Id extends string>(columns: readonly Column<Id>[]): string {
  return renderRow(
    columns,
    Object.fromEntries(columns.map((column) => [column.id, column.title])) as Partial<Record<Id, string>>,
  )
}

export type LibraryColumn = "status" | "workflow" | "phase" | "units" | "tokens" | "cost" | "elapsed" | "started"

export const LIBRARY_COLUMNS: readonly ColumnSpec<LibraryColumn>[] = [
  { id: "status", title: "status", width: 13, priority: 100 },
  { id: "workflow", title: "workflow", width: 14, flex: true, priority: 100 },
  { id: "phase", title: "phase", width: 10, priority: 10 },
  { id: "units", title: "units", width: 10, align: "right", priority: 90 },
  { id: "tokens", title: "tokens", width: 7, align: "right", priority: 30 },
  { id: "cost", title: "cost", width: 7, align: "right", priority: 50 },
  { id: "elapsed", title: "elapsed", width: 7, align: "right", priority: 80 },
  { id: "started", title: "started", width: 13, align: "right", priority: 20 },
]

export function libraryCells(entry: LibraryEntry, now: number): Record<LibraryColumn, string> {
  const look = runStatus(entry)
  const day = formatDay(entry.startedAt, now)
  return {
    status: `${look.glyph} ${look.word}`,
    workflow: `${workflowName(entry)}${entry.workflow.provenance === "inline" ? " (inline)" : ""}`,
    phase: phasePosition(entry),
    units: `${entry.settledUnits}/${entry.units}`,
    tokens: formatTokens(totalTokens(entry.usage)),
    cost: formatCost(entry.usage.cost),
    elapsed: formatElapsed(elapsedOf(entry, now)),
    started: day ? `${day} ${formatClock(entry.startedAt)}` : formatClock(entry.startedAt),
  }
}

export type UnitColumn = "status" | "name" | "phase" | "agent" | "tries" | "tokens" | "cost" | "elapsed"

export const UNIT_COLUMNS: readonly ColumnSpec<UnitColumn>[] = [
  { id: "status", title: "status", width: 11, priority: 100 },
  { id: "name", title: "unit", width: 16, flex: true, priority: 100 },
  { id: "phase", title: "phase", width: 12, priority: 10 },
  { id: "agent", title: "agent", width: 9, priority: 30 },
  { id: "tries", title: "tries", width: 5, align: "right", priority: 40 },
  { id: "tokens", title: "tokens", width: 7, align: "right", priority: 60 },
  { id: "cost", title: "cost", width: 7, align: "right", priority: 50 },
  { id: "elapsed", title: "time", width: 6, align: "right", priority: 90 },
]

export function unitCells(unit: Unit, now: number): Record<UnitColumn, string> {
  const look = unitStatus(unit.status)
  return {
    status: `${look.glyph} ${look.word}`,
    name: unitName(unit),
    phase: unit.phase ?? "",
    agent: unit.subagent,
    tries: unit.attempts.length > 1 ? String(unit.attempts.length) : "",
    tokens: unit.status === "replayed" ? "" : formatTokens(totalTokens(unit.usage)),
    cost: unit.status === "replayed" ? "" : formatCost(unit.usage.cost),
    elapsed: unitElapsed(unit, now),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Strip and sidebar
// ---------------------------------------------------------------------------------------------------------------

/**
 * The composer strip: one line for the live Runs of a session. One Run shows its detail; several collapse to
 * counts. Parts drop from the right-hand, least important end until the line fits.
 */
export function stripText(entries: readonly LibraryEntry[], now: number, width: number): string {
  const live = entries.filter((entry) => entry.live)
  if (live.length === 0) return ""
  const waiting = live.filter((entry) => entry.waiting).length
  let parts: Array<{ text: string; priority: number; short?: string }>
  if (live.length === 1) {
    const run = live[0]!
    const progress = phaseProgress(run)
    parts = [
      { text: `⟡ ${workflowName(run)}`, priority: 100 },
      { text: phasePosition(run), priority: 40 },
      { text: progress ? meter(progress.index / progress.total, 6) : "", priority: 10 },
      { text: `${run.settledUnits}/${run.units} units`, priority: 90 },
      { text: formatElapsed(elapsedOf(run, now)), priority: 70 },
      { text: formatCost(run.usage.cost), priority: 20 },
      { text: waiting ? "? waiting — click to answer" : "", short: "? waiting", priority: 95 },
    ]
  } else {
    const settled = live.reduce((sum, entry) => sum + entry.settledUnits, 0)
    const total = live.reduce((sum, entry) => sum + entry.units, 0)
    parts = [
      { text: `⟡ ${live.length} workflows running`, priority: 100 },
      { text: `${settled}/${total} units`, priority: 90 },
      { text: waiting ? `? ${waiting} waiting` : "", priority: 95 },
    ]
  }
  let kept = parts.filter((part) => part.text)
  const render = () => ` ${kept.map((part) => part.text).join(" · ")} `
  while (render().length > width && kept.length > 1) {
    const long = kept.find((part) => part.short)
    if (long) {
      kept = kept.map((part) => (part === long ? { text: part.short!, priority: part.priority } : part))
      continue
    }
    const drop = kept.toSorted((a, b) => a.priority - b.priority)[0]!
    kept = kept.filter((part) => part !== drop)
  }
  return truncate(render(), width)
}

/** Two lines per Run for the sidebar: identity and status, then progress. */
export function sidebarLines(entry: LibraryEntry, now: number, width: number): [string, string] {
  const look = runStatus(entry)
  const first = `${look.glyph} ${workflowName(entry)}`
  const second = [
    phasePosition(entry),
    `${entry.settledUnits}/${entry.units} units`,
    formatElapsed(elapsedOf(entry, now)),
    entry.waiting ? "waiting" : "",
  ]
    .filter(Boolean)
    .join(" · ")
  return [truncate(first, width), truncate(`  ${second}`, width)]
}

/** Hard-wrap text to `width` cells per line (words where possible), keeping blank lines. */
export function wrapLines(text: string, width: number): string[] {
  const size = Math.max(1, width)
  const out: string[] = []
  for (const raw of text.replace(/\t/g, "  ").split("\n")) {
    let line = raw.trimEnd()
    if (line.length === 0) {
      out.push("")
      continue
    }
    while (line.length > size) {
      const space = line.lastIndexOf(" ", size)
      const cut = space > size / 3 ? space : size
      out.push(line.slice(0, cut).trimEnd())
      line = line.slice(cut).trimStart()
    }
    out.push(line)
  }
  return out
}

/** "a3f9c1d2" — enough of an id to tell Runs apart in a list. */
export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8)
}

/** A saved Workflow's args, from its JSON Schema: the names it requires, then the optional ones. */
export function savedArgs(listing: Pick<WorkflowListing, "args">): { required: string[]; optional: string[] } {
  const schema = listing.args as { properties?: Record<string, unknown>; required?: unknown } | null
  const names = Object.keys(schema?.properties ?? {})
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((name): name is string => typeof name === "string")
    : []
  return { required, optional: names.filter((name) => !required.includes(name)) }
}

/** "no args", "needs question", "needs question · 2 optional", "1 optional". */
export function savedArgsText(listing: Pick<WorkflowListing, "args">): string {
  const { required, optional } = savedArgs(listing)
  if (required.length === 0 && optional.length === 0) return "no args"
  return [required.length ? `needs ${required.join(", ")}` : "", optional.length ? `${optional.length} optional` : ""]
    .filter(Boolean)
    .join(" · ")
}

/** The slash command that runs a saved Workflow (see the server's command list), and the text to send with it. */
export function savedCommand(key: string, request: string): { name: string; text: string } {
  const name = key.replaceAll(":", "/")
  // `/workflow` and `/workflows` are taken: such a key goes through `/workflow <key> <request>`.
  return name === "workflow" || name === "workflows"
    ? { name: "workflow", text: `${key} ${request}`.trim() }
    : { name, text: request }
}

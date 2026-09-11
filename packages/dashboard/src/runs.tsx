/**
 * The left rail: live runs, then the journal's history, with a status filter and a scope control — the
 * dashboard's projection of the run browser's list level.
 *
 * Rows are COLUMNS, never a pre-joined string: the name flexes and truncates, the figures keep their own cells
 * so they line up down the list, and a narrow viewport drops columns in the TUI's own order (start clock first
 * — see `theme.css`) rather than truncating a row's meaning. History rows fill the same columns as live ones
 * and are distinguished by dimming, not by omission.
 *
 * The scope is the TUI's `w`, minus the member the dashboard cannot honestly have: no session of its own, so
 * the cycle is `this project` → `everywhere`. Like the TUI, the scope in force is NAMED in the header at every
 * width, and the section heading tells the truth about what is under it — it was never "this session" here.
 * A foreign row (the `everywhere` merge tags it with an `origin`) says where it lives.
 */
import { createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { formatClock, formatDay, formatElapsed, type RunOrigin, type RunSnapshot, type RunSummary } from "./engine"
import type { DashboardScope, DashboardState } from "./state"

export type RunStatusFilter = "all" | "active" | "done" | "failed"

const FILTERS: readonly RunStatusFilter[] = ["all", "active", "done", "failed"]

function matches(status: RunSnapshot["status"], filter: RunStatusFilter): boolean {
  if (filter === "all") return true
  if (filter === "active") return status === "running"
  if (filter === "done") return status === "done"
  return status === "failed" || status === "aborted"
}

/** One row's columns, computed the same way from a live snapshot and a journal summary. */
interface RowModel {
  runId: string
  status: RunSnapshot["status"]
  workflow: string
  units: string
  elapsed: string
  started: string
  pendingQuestions: number
  live: boolean
  /** The foreign endpoint's worktree, shortened to its last segment; `null` for a row this endpoint owns. */
  origin: string | null
  /** The full worktree path, for the title attribute — the short name alone can be ambiguous. */
  originPath: string | null
}

/** Stamped by the endpoint's `everywhere` merge; absent means the row is this endpoint's own. */
function originOf(row: { origin?: RunOrigin }): { origin: string | null; originPath: string | null } {
  if (!row.origin) return { origin: null, originPath: null }
  const segments = row.origin.worktree.split("/").filter(Boolean)
  return { origin: segments.at(-1) ?? row.origin.worktree, originPath: row.origin.worktree }
}

function liveRow(run: RunSnapshot & { origin?: RunOrigin }): RowModel {
  const settled = run.units.filter((unit) => unit.status === "ok" || unit.status === "failed").length
  return {
    runId: run.runId,
    status: run.status,
    workflow: run.workflow,
    units: `${settled}/${run.units.length}`,
    elapsed: formatElapsed((run.endedAt ?? Date.now()) - run.startedAt),
    started: formatDay(run.startedAt) || formatClock(run.startedAt),
    pendingQuestions: run.interactions.length,
    live: true,
    ...originOf(run),
  }
}

function historyRow(summary: RunSummary & { origin?: RunOrigin }): RowModel {
  return {
    runId: summary.runId,
    status: summary.status,
    workflow: summary.workflow,
    units: `${summary.settledUnits}/${summary.units}`,
    elapsed: formatElapsed((summary.endedAt ?? summary.startedAt) - summary.startedAt),
    started: formatDay(summary.startedAt) || formatClock(summary.startedAt),
    pendingQuestions: 0,
    live: false,
    ...originOf(summary),
  }
}

export function RunList(props: {
  state: Accessor<DashboardState>
  selected: string | null
  onSelect: (runId: string) => void
  scope: DashboardScope
  onScope: () => void
}): JSX.Element {
  const [filter, setFilter] = createSignal<RunStatusFilter>("all")
  const scopeLabel = () => (props.scope === "project" ? "this project" : "everywhere")

  // Plain functions over the state accessor, per the freshness rule — no memo between a publish and a row.
  const liveRows = () => props.state().runs.filter((run) => matches(run.status, filter())).map(liveRow)
  const historyRows = () => {
    const liveIds = new Set(props.state().runs.map((run) => run.runId))
    return props
      .state()
      .history.filter((summary) => !liveIds.has(summary.runId) && matches(summary.status, filter()))
      .map(historyRow)
  }

  const row = (model: RowModel) => (
    <button
      type="button"
      class="run-row"
      classList={{ selected: props.selected === model.runId, history: !model.live }}
      onClick={() => props.onSelect(model.runId)}
    >
      <span class={`status-dot ${model.status}`} role="presentation" />
      <span class="run-row-name">{model.workflow}</span>
      <Show when={model.origin}>
        {/* Where a foreign run lives — a column of its own, so `everywhere` never mixes anonymous rows. */}
        <span class="run-row-origin" title={model.originPath ?? undefined}>
          {model.origin}
        </span>
      </Show>
      <Show when={model.pendingQuestions > 0}>
        <span class="run-row-badge" title={`${model.pendingQuestions} question(s) waiting`}>
          {model.pendingQuestions}
        </span>
      </Show>
      <span class="run-row-units">{model.units}</span>
      <span class="run-row-elapsed">{model.elapsed}</span>
      <span class="run-row-clock">{model.started}</span>
    </button>
  )

  return (
    <nav class="rail" aria-label="runs">
      <div class="rail-filter" role="tablist" aria-label="status filter">
        <For each={FILTERS}>
          {(candidate) => (
            <button
              type="button"
              classList={{ active: filter() === candidate }}
              onClick={() => setFilter(candidate)}
            >
              {candidate}
            </button>
          )}
        </For>
        {/* The TUI's rule holds here: the scope in force is NAMED, at every width — a list that might be
            hiding the rest of the machine has to say so. Clicking cycles it, like `w`. */}
        <button type="button" class="rail-scope" onClick={() => props.onScope()} title="cycle the scope">
          {scopeLabel()}
        </button>
      </div>

      <Show
        when={liveRows().length > 0 || historyRows().length > 0}
        fallback={
          <p class="rail-empty">
            {filter() === "all"
              ? `No runs in ${scopeLabel()} yet. Start one with the workflow tool.`
              : "Nothing matches this filter."}
          </p>
        }
      >
        <Show when={liveRows().length > 0}>
          {/* Truthful per the scope in force — this list was always project-scoped, never a session's. */}
          <h2 class="rail-section">{props.scope === "project" ? "This project" : "Everywhere"}</h2>
          <For each={liveRows()}>{row}</For>
        </Show>
        <Show when={historyRows().length > 0}>
          <h2 class="rail-section">History</h2>
          <For each={historyRows()}>{row}</For>
        </Show>
      </Show>
    </nav>
  )
}

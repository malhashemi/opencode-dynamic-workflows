import type { TuiPluginApi, TuiSlotContext, TuiTheme } from "@opencode-ai/plugin/tui"
import { createComponent, lazy, type Accessor } from "solid-js"
import type { RunSnapshot } from "../runs"

export interface SidebarRunLine {
  runId: string
  workflow: string
  phase: string
  settled: number
  total: number
  elapsed: string
  text: string
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  if (minutes > 0) return `${minutes}m${String(rest).padStart(2, "0")}s`
  return `${rest}s`
}

export function toSidebarRunLine(run: RunSnapshot, now = Date.now()): SidebarRunLine {
  const settled = run.units.filter((unit) => unit.status === "ok" || unit.status === "failed").length
  const total = run.units.length
  const phase = run.currentPhase ?? "starting"
  const elapsed = formatElapsed((run.endedAt ?? now) - run.startedAt)
  return {
    runId: run.runId,
    workflow: run.workflow,
    phase,
    settled,
    total,
    elapsed,
    text: `${run.workflow} · ${phase} · ${settled}/${total} units · ${elapsed}`,
  }
}

export function sidebarViewModel(runs: readonly RunSnapshot[], now = Date.now()): SidebarRunLine[] {
  return runs
    .filter((run) => run.status === "running")
    .sort((a, b) => a.startedAt - b.startedAt || a.runId.localeCompare(b.runId))
    .map((run) => toSidebarRunLine(run, now))
}

export interface WorkflowSidebarProps {
  runs: Accessor<readonly RunSnapshot[]>
  theme: TuiTheme
}

// Keep the public target importable by plain Bun for OpenCode's module-shape gate. The JSX-bearing view is
// loaded only when the host actually renders the slot, after OpenCode has installed its OpenTUI transform.
const WorkflowSidebar = lazy(() => import("./sidebar-view"))

export function registerSidebar(api: TuiPluginApi, runs: Accessor<readonly RunSnapshot[]>): string {
  return api.slots.register({
    order: 350,
    slots: {
      sidebar_content(context: TuiSlotContext) {
        return createComponent(WorkflowSidebar, { runs, theme: context.theme })
      },
    },
  })
}

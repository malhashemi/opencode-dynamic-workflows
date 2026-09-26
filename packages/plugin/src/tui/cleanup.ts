/**
 * Retention from the TUI: the server plugin cannot delete sessions (P0 S8), so a Run marked `cleanup: "pending"`
 * waits for a surface with a full client. The TUI deletes the Unit sessions with `client.session.remove` and
 * reports what it deleted with `cleanupRun`. Only ever on an explicit user action.
 */
import type { LibraryEntry, Run } from "../protocol"
import { isTerminal } from "../runs"
import { errorText, type WorkflowApi } from "./api"

export interface CleanupOutcome {
  readonly runId: string
  readonly deleted: number
  readonly pending: number
  readonly failures: ReadonlyArray<{ sessionID: string; error: string }>
}

/** The Unit sessions of a Run, each once. */
export function cleanupTargets(run: Pick<Run, "units">): string[] {
  return [...new Set(run.units.map((unit) => unit.sessionID).filter((id): id is string => !!id))]
}

/** A session that is already gone counts as deleted. */
export function alreadyGone(error: unknown): boolean {
  return /not.?found/i.test(errorText(error)) || /NotFound/.test(JSON.stringify(error ?? ""))
}

/** Delete one terminal Run's Unit sessions and record the result on the Run. */
export async function cleanupRun(
  run: Run,
  deps: { api: WorkflowApi; remove: (sessionID: string) => Promise<void> },
): Promise<CleanupOutcome> {
  if (!isTerminal(run.status)) throw new Error("Stop the Run before deleting its Unit sessions.")
  const deleted: string[] = []
  const failures: Array<{ sessionID: string; error: string }> = []
  for (const sessionID of cleanupTargets(run)) {
    try {
      await deps.remove(sessionID)
      deleted.push(sessionID)
    } catch (error) {
      if (alreadyGone(error)) deleted.push(sessionID)
      else failures.push({ sessionID, error: errorText(error) })
    }
  }
  const recorded = await deps.api.cleanupRun({ runId: run.runId, deleted })
  return { runId: run.runId, deleted: deleted.length, pending: recorded.pending, failures }
}

/** Every finished Run whose retention is `pending`: read each in full, clean up the ones that are. */
export async function cleanupPending(
  entries: readonly LibraryEntry[],
  deps: { api: WorkflowApi; remove: (sessionID: string) => Promise<void> },
): Promise<CleanupOutcome[]> {
  const outcomes: CleanupOutcome[] = []
  for (const entry of entries) {
    if (!isTerminal(entry.status)) continue
    const { run } = await deps.api.getRun({ runId: entry.runId })
    if (run.cleanup !== "pending") continue
    outcomes.push(await cleanupRun(run, deps))
  }
  return outcomes
}

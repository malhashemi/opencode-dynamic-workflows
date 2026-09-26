/**
 * Navigation and selection for the `/workflows` page and the session panel: a stack of views
 * (library → Run → Unit), one cursor per view, a status filter for the library, and the visible window of a
 * long list. Pure; the components keep it in a signal.
 */
import type { LibraryEntry } from "../protocol"

export type View =
  | { readonly kind: "library" }
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "unit"; readonly runId: string; readonly unitId: string }

export type LibraryFilter = "all" | "live" | "waiting" | "failed"

export const FILTERS: readonly LibraryFilter[] = ["all", "live", "waiting", "failed"]

export interface Nav {
  readonly stack: readonly View[]
  readonly cursors: Readonly<Record<string, number>>
  readonly filter: LibraryFilter
}

export function viewKey(view: View): string {
  switch (view.kind) {
    case "library":
      return "library"
    case "run":
      return `run:${view.runId}`
    case "unit":
      return `unit:${view.runId}:${view.unitId}`
  }
}

/** Start at the library, or deep in a Run (and one of its Units) when the caller names them. */
export function initialNav(start: { runId?: string; unitId?: string; root?: "library" | "run" } = {}): Nav {
  const stack: View[] = start.root === "run" && start.runId ? [] : [{ kind: "library" }]
  if (start.runId) stack.push({ kind: "run", runId: start.runId })
  if (start.runId && start.unitId) stack.push({ kind: "unit", runId: start.runId, unitId: start.unitId })
  return { stack, cursors: {}, filter: "all" }
}

export function current(nav: Nav): View {
  return nav.stack[nav.stack.length - 1] ?? { kind: "library" }
}

export function push(nav: Nav, view: View): Nav {
  if (viewKey(current(nav)) === viewKey(view)) return nav
  return { ...nav, stack: [...nav.stack, view] }
}

/** Back one view; the root view stays (`null` tells the caller there is nowhere left to go back to). */
export function pop(nav: Nav): Nav | null {
  if (nav.stack.length <= 1) return null
  return { ...nav, stack: nav.stack.slice(0, -1) }
}

export function cursor(nav: Nav, count: number, view: View = current(nav)): number {
  const value = nav.cursors[viewKey(view)] ?? 0
  return count <= 0 ? 0 : Math.max(0, Math.min(count - 1, value))
}

export function setCursor(nav: Nav, index: number, count: number, view: View = current(nav)): Nav {
  const clamped = count <= 0 ? 0 : Math.max(0, Math.min(count - 1, index))
  return { ...nav, cursors: { ...nav.cursors, [viewKey(view)]: clamped } }
}

export function moveCursor(nav: Nav, delta: number, count: number, view: View = current(nav)): Nav {
  return setCursor(nav, cursor(nav, count, view) + delta, count, view)
}

export function cycleFilter(nav: Nav): Nav {
  const next = FILTERS[(FILTERS.indexOf(nav.filter) + 1) % FILTERS.length]!
  return { ...nav, filter: next, cursors: { ...nav.cursors, library: 0 } }
}

export function filterEntries(entries: readonly LibraryEntry[], filter: LibraryFilter): LibraryEntry[] {
  switch (filter) {
    case "all":
      return [...entries]
    case "live":
      return entries.filter((entry) => entry.live)
    case "waiting":
      return entries.filter((entry) => entry.waiting)
    case "failed":
      return entries.filter(
        (entry) => entry.status === "failed" || entry.status === "interrupted" || entry.failedUnits > 0,
      )
  }
}

/** The slice of a `count`-long list to draw in `height` rows so that `cursor` stays visible (and centred-ish). */
export function visibleWindow(count: number, cursorIndex: number, height: number): { start: number; end: number } {
  const rows = Math.max(1, height)
  if (count <= rows) return { start: 0, end: count }
  const start = Math.max(0, Math.min(count - rows, cursorIndex - Math.floor(rows / 2)))
  return { start, end: start + rows }
}

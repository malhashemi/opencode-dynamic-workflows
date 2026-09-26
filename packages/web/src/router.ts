/** History routing for the three views. The Gateway serves index.html for any unknown path. */
import { createSignal } from "solid-js"

export type Route =
  | { name: "library" }
  | { name: "run"; runId: string }
  | { name: "unit"; runId: string; unitId: string }
  | { name: "not-found"; path: string }

export function parseRoute(pathname: string): Route {
  const parts = pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part)
      } catch {
        return part
      }
    })
  if (parts.length === 0) return { name: "library" }
  if (parts[0] === "runs" && parts[1]) {
    if (parts.length === 2) return { name: "run", runId: parts[1] }
    if (parts[2] === "units" && parts[3] && parts.length === 4)
      return { name: "unit", runId: parts[1], unitId: parts[3] }
  }
  return { name: "not-found", path: pathname }
}

export const runPath = (runId: string) => `/runs/${encodeURIComponent(runId)}`
export const unitPath = (runId: string, unitId: string) => `${runPath(runId)}/units/${encodeURIComponent(unitId)}`

const [location, setLocation] = createSignal(
  typeof window === "undefined" ? "/" : window.location.pathname + window.location.search,
)

export const currentPath = location

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => setLocation(window.location.pathname + window.location.search))
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (path === window.location.pathname + window.location.search) return
  if (options.replace) window.history.replaceState(null, "", path)
  else window.history.pushState(null, "", path)
  setLocation(path)
  window.scrollTo(0, 0)
}

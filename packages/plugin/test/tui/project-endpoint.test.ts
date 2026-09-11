/**
 * Which endpoint the sidebar's `⌂` line names when a project has more than one live host.
 *
 * The descriptor scan sorts newest first, and the newest host in a project is the one that FAILED to bind the
 * stable port — so "first match" handed the link to the host that would not answer at that address after a
 * restart. This pins the tie-break: own process, then the longest-lived host.
 */
import { describe, expect, it } from "bun:test"
import type { EndpointDescriptor } from "../../src/discovery"
import { projectEndpoint } from "../../src/tui/route-model"

function descriptor(overrides: Partial<EndpointDescriptor>): EndpointDescriptor {
  return {
    url: "http://127.0.0.1:1",
    token: "t",
    pid: 1,
    directory: "/home/me/project",
    worktree: "/home/me/project",
    startedAt: 1_000,
    ...overrides,
  }
}

describe("projectEndpoint", () => {
  const stable = descriptor({ url: "http://127.0.0.1:4100", pid: 100, startedAt: 1_000 })
  const fallback = descriptor({ url: "http://127.0.0.1:59321", pid: 200, startedAt: 2_000 })
  // Newest first, as `readDescriptors` returns them.
  const newestFirst = [fallback, stable]

  it("names this process's own endpoint when the descriptors carry it", () => {
    expect(projectEndpoint(newestFirst, "/home/me/project", 200)?.url).toBe(fallback.url)
    expect(projectEndpoint(newestFirst, "/home/me/project", 100)?.url).toBe(stable.url)
  })

  it("otherwise names the longest-lived host — the one holding the stable port — not the newest", () => {
    expect(projectEndpoint(newestFirst, "/home/me/project")?.url).toBe(stable.url)
    // A pid that matches no descriptor (a detached TUI) falls through to the same answer.
    expect(projectEndpoint(newestFirst, "/home/me/project", 999)?.url).toBe(stable.url)
  })

  it("matches on the directory as well as the worktree, and answers null for another project", () => {
    const byDirectory = descriptor({ worktree: "/home/me/repo", directory: "/home/me/repo/packages/app" })
    expect(projectEndpoint([byDirectory], "/home/me/repo/packages/app")?.url).toBe(byDirectory.url)
    expect(projectEndpoint(newestFirst, "/home/me/other")).toBeNull()
    expect(projectEndpoint([], "/home/me/project")).toBeNull()
  })
})

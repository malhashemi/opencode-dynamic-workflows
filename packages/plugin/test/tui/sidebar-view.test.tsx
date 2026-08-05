/** @jsxImportSource @opentui/solid */
/**
 * The sidebar as OpenTUI actually renders it.
 *
 * `sidebar.test.ts` covers the row model. This covers the thing that took a real host down: OpenTUI rejects
 * a text node whose parent is not a `<text>`, and Solid's universal renderer inserts an EMPTY text node as a
 * placeholder whenever a dynamic child empties out while another sibling follows it. A `<For>` of runs with
 * a `<Show>`-gated badge after it therefore crashed the entire TUI — not the sidebar, the TUI — the moment
 * the last run finished. Nothing in the type system or the row-model tests could see it.
 */
import { createSignal } from "solid-js"
import { describe, expect, it } from "bun:test"
import type { RunSnapshot } from "../../src/runs"
import { registerSidebar } from "../../src/tui/sidebar"
import WorkflowSidebar from "../../src/tui/sidebar-view"
import { createFakeTuiApi } from "./fake-api"
import { fakeTheme, mountSidebarSlot, mountView } from "./render"

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "deep-research",
    provenance: "durable",
    parentSessionID: "parent",
    status: "running",
    phases: ["plan", "gather sources", "synthesize"],
    phasesDeclared: true,
    currentPhase: "gather sources",
    units: [],
    logs: [],
    errors: [],
    interactions: [],
    resolved: [],
    tokensSpent: 0,
    startedAt: Date.now(),
    endedAt: null,
    ...overrides,
  }
}

function withInteractions(base: RunSnapshot, count: number): RunSnapshot {
  return {
    ...base,
    interactions: Array.from({ length: count }, (_x, i) => ({
      requestID: `q-${i}`,
      kind: "question" as const,
      origin: "agent" as const,
      sessionID: "ses_child",
      unitId: null,
      depth: 3,
      phase: null,
      questions: [{ header: "Pick", prompt: "Which?", options: [], multiple: false, custom: false }],
      // Ascending, so "oldest waiting" is `q-0` — the request the badge deep-links to.
      raisedAt: 1_000 + i,
      graceEndsAt: null,
    })),
  }
}

describe("workflow sidebar render", () => {
  it("renders the heading and a two-line row per active run", async () => {
    const view = await mountView(() => (
      <WorkflowSidebar runs={() => [run()]} theme={fakeTheme()} />
    ))
    try {
      const frame = view.text()
      expect(frame).toContain("Workflows")
      expect(frame).toContain("deep-research")
      expect(frame).toContain("0/0")
      expect(frame).toMatch(/phase 2\/3 · gather sources/)
    } finally {
      view.unmount()
    }
  })

  it("renders `starting` before the run declares a phase", async () => {
    const view = await mountView(() => (
      <WorkflowSidebar runs={() => [run({ phases: [], currentPhase: null })]} theme={fakeTheme()} />
    ))
    try {
      expect(view.text()).toContain("starting")
    } finally {
      view.unmount()
    }
  })

  it("renders the pending-question badge only when a run has interactions", async () => {
    const quiet = await mountView(() => <WorkflowSidebar runs={() => [run()]} theme={fakeTheme()} />)
    try {
      expect(quiet.text()).not.toContain("waiting")
    } finally {
      quiet.unmount()
    }

    const asking = await mountView(() => (
      <WorkflowSidebar runs={() => [withInteractions(run(), 1)]} theme={fakeTheme()} />
    ))
    try {
      expect(asking.text()).toContain("1 question waiting")
    } finally {
      asking.unmount()
    }

    const plural = await mountView(() => (
      <WorkflowSidebar runs={() => [withInteractions(run(), 3)]} theme={fakeTheme()} />
    ))
    try {
      expect(plural.text()).toContain("3 questions waiting")
    } finally {
      plural.unmount()
    }
  })

  // The regression that crashed a real 1.18.10 TUI with
  // `Orphan text error: "" must have a <text> as a parent`.
  it("survives a run settling and the section emptying, without orphaning a text node", async () => {
    const [runs, setRuns] = createSignal<readonly RunSnapshot[]>([run()])
    const view = await mountView(() => <WorkflowSidebar runs={runs} theme={fakeTheme()} />)
    try {
      expect(view.text()).toContain("deep-research")

      // Settling swaps the spinner for an outcome glyph and drops the phase line — the row STAYS. A run that
      // vanished the instant it ended never told the user whether it worked.
      setRuns([{ ...run(), status: "done", endedAt: Date.now() }])
      await view.flush()
      expect(view.text()).toContain("deep-research")
      expect(view.text()).toContain("✓")

      // Dropping the last row is the case that actually orphaned a text node.
      setRuns([])
      await view.flush()
      expect(view.text()).not.toContain("deep-research")

      // And back again: a new run must be able to repopulate the emptied section.
      setRuns([run({ runId: "run-2", workflow: "refine" })])
      await view.flush()
      expect(view.text()).toContain("refine")
    } finally {
      view.unmount()
    }
  })

  it("marks a failed run distinctly from a successful one, and says how much failed", async () => {
    const failed = {
      ...run(),
      status: "failed" as const,
      endedAt: Date.now(),
      errors: [{ subagent: "general", error: "boom" }] as RunSnapshot["errors"],
    }
    const view = await mountView(() => <WorkflowSidebar runs={() => [failed]} theme={fakeTheme()} />)
    try {
      expect(view.text()).toContain("✗")
      expect(view.text()).toContain("1 unit failed")
      expect(view.text()).not.toContain("✓")
    } finally {
      view.unmount()
    }
  })

  it("survives the badge appearing and disappearing while runs come and go", async () => {
    const [runs, setRuns] = createSignal<readonly RunSnapshot[]>([run()])
    const view = await mountView(() => <WorkflowSidebar runs={runs} theme={fakeTheme()} />)
    try {
      setRuns([withInteractions(run(), 2)])
      await view.flush()
      expect(view.text()).toContain("2 questions waiting")

      setRuns([run()])
      await view.flush()
      expect(view.text()).not.toContain("waiting")

      setRuns([])
      await view.flush()
      expect(view.text()).not.toContain("Workflows")
    } finally {
      view.unmount()
    }
  })

  /**
   * The production path, end to end: `registerSidebar` → the host's slot registry → a composed sidebar column.
   *
   * This is the test that would have caught the crash. The view was deferred behind `lazy()`, and while a lazy
   * component resolves, Solid holds its place with an EMPTY TEXT NODE — which OpenTUI refuses to add to a box.
   * The result was not a missing section; it was `Orphan text error` on a full-screen "opencode crashed"
   * panel, triggered the moment the sidebar first became visible. Standalone mounting never reaches that code.
   */
  describe("registered as a host slot", () => {
    function registeredPlugin(runs: () => readonly RunSnapshot[]) {
      const fake = createFakeTuiApi()
      registerSidebar(fake.api, runs)
      const plugin = fake.slots[0]
      if (!plugin) throw new Error("registerSidebar did not register a slot")
      return plugin
    }

    it("mounts between neighbouring sections without orphaning a text node", async () => {
      const view = await mountSidebarSlot(registeredPlugin(() => [run()]))
      try {
        const frame = view.text()
        expect(frame).toContain("LSP")
        expect(frame).toContain("Workflows")
        expect(frame).toContain("deep-research")
        expect(frame).toContain("Todos")
        // Order 350 places the section after LSP (300) and before todos (400).
        expect(frame.indexOf("LSP")).toBeLessThan(frame.indexOf("Workflows"))
        expect(frame.indexOf("Workflows")).toBeLessThan(frame.indexOf("Todos"))
      } finally {
        view.unmount()
      }
    })

    it("leaves the neighbouring sections intact when it has nothing to show", async () => {
      const view = await mountSidebarSlot(registeredPlugin(() => []))
      try {
        const frame = view.text()
        expect(frame).toContain("LSP")
        expect(frame).toContain("Todos")
        expect(frame).not.toContain("Workflows")
      } finally {
        view.unmount()
      }
    })

    /**
     * The strip is a summary, and a summary you cannot follow is a dead end.
     *
     * Clicked for real rather than by calling the handler: a handler wired to the wrong element, or to one
     * with no hit area, looks identical in a captured frame to one wired correctly.
     */
    it("opens the run browser on the row that was clicked, and the list from the badge", async () => {
      const fake = createFakeTuiApi()
      fake.api.route.navigate("session", { sessionID: "ses_here" })
      registerSidebar(fake.api, () => [withInteractions(run(), 1)])
      const plugin = fake.slots[0]
      if (!plugin) throw new Error("registerSidebar did not register a slot")

      const view = await mountSidebarSlot(plugin)
      try {
        await view.click(4, view.lineOf(/deep-research/))
        expect(fake.navigations.at(-1)).toEqual({
          name: "workflow-runs",
          params: { runId: "run-1", returnTo: "ses_here" },
        })

        // Back in the session — the sidebar only exists there, so this is the only way a second click happens.
        fake.api.route.navigate("session", { sessionID: "ses_here" })
        // The badge is a DEEP LINK, not a hint: it opens the answer pane on the request that has been waiting
        // longest, which is the one closest to being taken back by automation.
        await view.click(4, view.lineOf(/question waiting/))
        expect(fake.navigations.at(-1)).toEqual({
          name: "workflow-runs",
          params: { runId: "run-1", requestID: "q-0", returnTo: "ses_here" },
        })
      } finally {
        view.unmount()
      }
    })

    it("appears and disappears in place as runs start and settle", async () => {
      const [runs, setRuns] = createSignal<readonly RunSnapshot[]>([])
      const view = await mountSidebarSlot(registeredPlugin(runs))
      try {
        expect(view.text()).not.toContain("Workflows")

        setRuns([run()])
        await view.flush()
        expect(view.text()).toContain("deep-research")

        setRuns([])
        await view.flush()
        const frame = view.text()
        expect(frame).not.toContain("Workflows")
        expect(frame).toContain("LSP")
        expect(frame).toContain("Todos")
      } finally {
        view.unmount()
      }
    })
  })

  it("keeps every line inside the host's 42-column sidebar", async () => {
    const view = await mountView(() => (
      <WorkflowSidebar
        runs={() => [withInteractions(run({ workflow: "deep-research-with-a-long-name" }), 1)]}
        theme={fakeTheme()}
      />
    ))
    try {
      for (const line of view.text().split("\n")) expect(line.length).toBeLessThanOrEqual(42)
    } finally {
      view.unmount()
    }
  })
})

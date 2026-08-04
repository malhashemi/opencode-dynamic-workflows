/** @jsxImportSource @opentui/solid */
/**
 * The announcer, mounted.
 *
 * Its whole failure mode is invisible: an effect that never runs announces nothing and looks exactly like an
 * effect that ran and had nothing to say. That is not hypothetical — the first implementation lived in a
 * `createRoot` at plugin-activation time, type-checked, and announced nothing on a real host, twice. So this
 * mounts it on a real renderer, where a Solid effect is actually flushed, and drives run state underneath it.
 */
import { createSignal } from "solid-js"
import { describe, expect, it } from "bun:test"
import type { PendingInteraction, RunSnapshot } from "../../src/runs"
import WorkflowAnnouncer, { registerAnnouncer } from "../../src/tui/announce"
import { createFakeTuiApi } from "./fake-api"
import { mountAppSlot, mountView } from "./render"

function interaction(requestID: string): PendingInteraction {
  return {
    requestID,
    kind: "question",
    origin: "agent",
    sessionID: "ses_child",
    unitId: null,
    depth: 2,
    questions: [{ header: "Q", prompt: "?", options: [{ label: "a", description: "" }], multiple: false, custom: false }],
    raisedAt: Date.now(),
    graceEndsAt: Date.now() + 90_000,
  }
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "deep-research",
    provenance: "durable",
    parentSessionID: "ses_parent",
    status: "running",
    phases: [],
    phasesDeclared: false,
    currentPhase: null,
    units: [],
    logs: [],
    errors: [],
    interactions: [],
    tokensSpent: 0,
    startedAt: Date.now(),
    endedAt: null,
    ...overrides,
  }
}

async function mountAnnouncer(initial: readonly RunSnapshot[] = []) {
  const fake = createFakeTuiApi()
  const [runs, setRuns] = createSignal<readonly RunSnapshot[]>(initial)
  const view = await mountView(() => <WorkflowAnnouncer api={fake.api} runs={runs} />, { width: 40, height: 8 })
  return { fake, view, setRuns }
}

describe("workflow announcer", () => {
  it("announces a question that arrives, once, with the route back", async () => {
    const { fake, view, setRuns } = await mountAnnouncer([run()])
    try {
      expect(fake.toasts).toHaveLength(0)

      setRuns([run({ interactions: [interaction("req-1")] })])
      await view.flush()

      expect(fake.attention).toHaveLength(1)
      expect(fake.attention[0]).toMatchObject({ sound: { name: "question" } })
      expect(fake.attention[0]?.message).toContain("deep-research is waiting on an answer")
      expect(fake.toasts).toHaveLength(1)
      // The toast has no action of its own, so it names the command that does.
      expect(fake.toasts[0]?.message).toContain("/workflow-answer")
      expect(fake.toasts[0]?.duration).toBeGreaterThan(5_000)

      // A reconnect republishes the same interaction; one question is one chime.
      setRuns([run({ interactions: [interaction("req-1")] })])
      await view.flush()
      expect(fake.toasts).toHaveLength(1)
    } finally {
      view.unmount()
    }
  })

  it("says nothing about a question that was already waiting when the terminal opened", async () => {
    const { fake, view, setRuns } = await mountAnnouncer([run({ interactions: [interaction("req-1")] })])
    try {
      // Priming: the badge shows it, but chiming for something that happened before this terminal existed is
      // an interruption about the past.
      expect(fake.toasts).toHaveLength(0)
      expect(fake.attention).toHaveLength(0)

      setRuns([run({ interactions: [interaction("req-1"), interaction("req-2")] })])
      await view.flush()
      expect(fake.toasts).toHaveLength(1)
    } finally {
      view.unmount()
    }
  })

  it("announces a run finishing, with the sound that matches how it ended", async () => {
    const { fake, view, setRuns } = await mountAnnouncer([run()])
    try {
      setRuns([run({ status: "done", endedAt: Date.now() })])
      await view.flush()
      expect(fake.attention).toHaveLength(1)
      expect(fake.attention[0]).toMatchObject({ sound: { name: "done" } })

      // …and once only, however many times the list is republished.
      setRuns([run({ status: "done", endedAt: Date.now() })])
      await view.flush()
      expect(fake.attention).toHaveLength(1)

      setRuns([run({ status: "done", endedAt: Date.now() }), run({ runId: "run-2", status: "failed", endedAt: Date.now() })])
      await view.flush()
      expect(fake.attention).toHaveLength(2)
      expect(fake.attention[1]).toMatchObject({ sound: { name: "error" } })
    } finally {
      view.unmount()
    }
  })

  it("renders nothing — it is a watcher, not a view", async () => {
    const { view } = await mountAnnouncer([run()])
    try {
      expect(view.text().trim()).toBe("")
    } finally {
      view.unmount()
    }
  })

  it("registers into the host's root overlay, so it watches from every route", () => {
    const fake = createFakeTuiApi()
    const [runs] = createSignal<readonly RunSnapshot[]>([])
    registerAnnouncer(fake.api, runs)
    // `app`, not `sidebar_content`: the sidebar is composed only on a session route, and a question raised
    // while the user is on the home screen still has to reach them.
    expect(Object.keys(fake.slots[0]?.slots ?? {})).toEqual(["app"])
  })

  it("still watches when composed as an `app` slot through the real registry", async () => {
    // The claim that matters, and the one a standalone mount cannot make: a component whose only output is a
    // side effect is indistinguishable from one that never mounted. Composing it the way the host does — as a
    // root overlay beside a route body — is what proves its effects are inside the tree the renderer drives.
    const fake = createFakeTuiApi()
    const [runs, setRuns] = createSignal<readonly RunSnapshot[]>([run()])
    registerAnnouncer(fake.api, runs)
    const view = await mountAppSlot(fake.slots[0] as never, { width: 40, height: 8 })
    try {
      expect(view.text()).toContain("route body")
      setRuns([run({ interactions: [interaction("req-1")] })])
      await view.flush()
      expect(fake.toasts).toHaveLength(1)
      expect(fake.attention).toHaveLength(1)
    } finally {
      view.unmount()
    }
  })
})

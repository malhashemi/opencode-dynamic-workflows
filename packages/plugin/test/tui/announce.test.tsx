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
import WorkflowAnnouncer, {
  announcementOutcome,
  registerAnnouncer,
  toastRenders,
  type AnnouncementOutcome,
} from "../../src/tui/announce"
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
    phase: null,
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
    resolved: [],
    tokensSpent: 0,
    startedAt: Date.now(),
    endedAt: null,
    ...overrides,
  }
}

async function mountAnnouncer(initial: readonly RunSnapshot[] = []) {
  const fake = createFakeTuiApi()
  // The announcer only toasts where a toast can be drawn, and the host draws them only inside its own home and
  // session route bodies. Start on `session`, which is where a user actually is when a run is going.
  fake.navigateTo("session", { sessionID: "ses_parent" })
  const [runs, setRuns] = createSignal<readonly RunSnapshot[]>(initial)
  const announcements: Array<AnnouncementOutcome & { requestID: string | null }> = []
  const view = await mountView(
    () => <WorkflowAnnouncer api={fake.api} runs={runs} onAnnounce={(outcome) => announcements.push(outcome)} />,
    { width: 40, height: 8 },
  )
  /** Let the awaited `attention.notify` settle before reading what it decided. */
  const settle = async () => {
    await view.flush()
    await Bun.sleep(0)
    await view.flush()
  }
  return { fake, view, setRuns, announcements, settle }
}

describe("workflow announcer", () => {
  it("announces a question that arrives, once, with the route back", async () => {
    const { fake, view, setRuns, settle } = await mountAnnouncer([run()])
    try {
      expect(fake.toasts).toHaveLength(0)

      setRuns([run({ interactions: [interaction("req-1")] })])
      await settle()

      expect(fake.attention).toHaveLength(1)
      expect(fake.attention[0]).toMatchObject({ sound: { name: "question" } })
      expect(fake.attention[0]?.message).toContain("deep-research is waiting on an answer")
      expect(fake.toasts).toHaveLength(1)
      // The toast has no action of its own, so it names the command that does.
      expect(fake.toasts[0]?.message).toContain("/workflow-answer")
      expect(fake.toasts[0]?.duration).toBeGreaterThan(5_000)

      // A reconnect republishes the same interaction; one question is one chime.
      setRuns([run({ interactions: [interaction("req-1")] })])
      await settle()
      expect(fake.toasts).toHaveLength(1)
    } finally {
      view.unmount()
    }
  })

  it("says nothing about a question that was already waiting when the terminal opened", async () => {
    const { fake, view, setRuns, settle } = await mountAnnouncer([run({ interactions: [interaction("req-1")] })])
    try {
      // Priming: the badge shows it, but chiming for something that happened before this terminal existed is
      // an interruption about the past.
      expect(fake.toasts).toHaveLength(0)
      expect(fake.attention).toHaveLength(0)

      setRuns([run({ interactions: [interaction("req-1"), interaction("req-2")] })])
      await settle()
      expect(fake.toasts).toHaveLength(1)
    } finally {
      view.unmount()
    }
  })

  it("announces a run finishing, with the sound that matches how it ended", async () => {
    const { fake, view, setRuns, settle } = await mountAnnouncer([run()])
    try {
      setRuns([run({ status: "done", endedAt: Date.now() })])
      await settle()
      expect(fake.attention).toHaveLength(1)
      expect(fake.attention[0]).toMatchObject({ sound: { name: "done" } })

      // …and once only, however many times the list is republished.
      setRuns([run({ status: "done", endedAt: Date.now() })])
      await settle()
      expect(fake.attention).toHaveLength(1)

      setRuns([run({ status: "done", endedAt: Date.now() }), run({ runId: "run-2", status: "failed", endedAt: Date.now() })])
      await settle()
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
    fake.navigateTo("session", { sessionID: "ses_parent" })
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

/**
 * What the host actually did with the announcement.
 *
 * This existed as a discarded promise: `void notify(...)`, then `toast(...)`, then nothing. The result carries
 * the host's own explanation — `attention_disabled`, `focus_unknown`, `blurred` — and throwing it away made
 * "we announced" indistinguishable from "we called a function". The manual pass found the consequence: no
 * toast, no sound, no notification, and nothing anywhere saying so.
 */
describe("workflow announcer: the host's answer is not discarded", () => {
  it("reports exactly which channels reached the user", () => {
    expect(announcementOutcome({ notification: true, sound: false }, false)).toMatchObject({
      notification: true,
      reached: true,
    })
    expect(announcementOutcome({ notification: false, sound: false, skipped: "focus_unknown" }, true)).toMatchObject({
      skipped: "focus_unknown",
      toast: true,
      reached: true,
    })
    // Nothing at all. This is the state that must never be recorded as "announced".
    expect(announcementOutcome({ notification: false, sound: false, skipped: "blurred" }, false).reached).toBe(false)
    expect(announcementOutcome(null, false).reached).toBe(false)
  })

  it("knows where a toast can actually be drawn", () => {
    // Read out of the host binary: `<Toast />` is mounted inside the home and session route bodies and nowhere
    // else — so a toast raised from inside the plugin's own route paints on nothing.
    expect(toastRenders("home")).toBe(true)
    expect(toastRenders("session")).toBe(true)
    expect(toastRenders("workflow-runs")).toBe(false)
    expect(toastRenders(undefined)).toBe(false)
  })

  it("does not toast from a route that cannot draw one", async () => {
    const { fake, view, setRuns, settle, announcements } = await mountAnnouncer([run()])
    try {
      fake.navigateTo("workflow-runs", { runId: "run-1" })
      setRuns([run({ interactions: [interaction("req-1")] })])
      await settle()
      expect(fake.toasts).toHaveLength(0)
      // The attention layer still runs — a sound and a desktop notification do not care what route you are on.
      expect(fake.attention).toHaveLength(1)
      expect(announcements[0]?.toast).toBe(false)
    } finally {
      view.unmount()
    }
  })

  it("tries again when the user reaches a screen an announcement can land on", async () => {
    const { fake, view, setRuns, settle, announcements } = await mountAnnouncer([run()])
    try {
      // Nothing reaches them: the attention layer is off and the run browser draws no toasts.
      fake.setAttentionEnabled(false)
      fake.navigateTo("workflow-runs", { runId: "run-1" })
      setRuns([run({ interactions: [interaction("req-1")] })])
      await settle()
      expect(announcements).toHaveLength(1)
      expect(announcements[0]).toMatchObject({ reached: false, skipped: "attention_disabled" })
      expect(fake.toasts).toHaveLength(0)

      // Back to a session. The question is still waiting, and it was never marked announced — so it announces.
      fake.navigateTo("session", { sessionID: "ses_parent" })
      await settle()
      expect(fake.toasts).toHaveLength(1)
      expect(announcements.at(-1)).toMatchObject({ reached: true, toast: true })

      // …and only once. A route change with the question already announced is not a second chime.
      fake.navigateTo("home")
      await settle()
      expect(fake.toasts).toHaveLength(1)
    } finally {
      view.unmount()
    }
  })

  it("does not re-attempt from the same screen on every run event", async () => {
    const { fake, view, setRuns, settle, announcements } = await mountAnnouncer([run()])
    try {
      fake.navigateTo("workflow-runs")
      setRuns([run({ interactions: [interaction("req-1")] })])
      await settle()
      expect(announcements).toHaveLength(1)

      // The route is the only thing that changes whether an announcement can land. Retrying from the same
      // screen on every log line would spend a host call per event to learn what we already know.
      for (const message of ["a", "b", "c"]) {
        setRuns([run({ logs: [message], interactions: [interaction("req-1")] })])
        await settle()
      }
      expect(announcements).toHaveLength(1)
      expect(fake.attention).toHaveLength(1)
    } finally {
      view.unmount()
    }
  })

  it("respects the user's own attention config instead of calling past it", async () => {
    const { fake, view, setRuns, settle, announcements } = await mountAnnouncer([run()])
    try {
      fake.setAttentionEnabled(false)
      setRuns([run({ interactions: [interaction("req-1")] })])
      await settle()
      // Not even attempted: the host would answer `attention_disabled`, and asking it to tell us what we already
      // know is not respect, it is noise. The in-terminal toast is a different channel and still runs.
      expect(fake.attention).toHaveLength(0)
      expect(fake.toasts).toHaveLength(1)
      expect(announcements[0]).toMatchObject({ skipped: "attention_disabled", toast: true, reached: true })
    } finally {
      view.unmount()
    }
  })

  it("survives an attention layer that throws, and calls that reaching nobody", async () => {
    const { fake, view, setRuns, settle, announcements } = await mountAnnouncer([run()])
    try {
      fake.setNotifyResult(() => {
        throw new Error("no sound pack")
      })
      fake.navigateTo("workflow-runs")
      setRuns([run({ interactions: [interaction("req-1")] })])
      await settle()
      expect(announcements[0]).toMatchObject({ reached: false })
    } finally {
      view.unmount()
    }
  })
})

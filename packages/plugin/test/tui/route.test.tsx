/** @jsxImportSource @opentui/solid */
/**
 * The run browser as OpenTUI actually renders it, driven the way a keystroke drives it.
 *
 * `route-model.test.ts` proves the navigation; this proves that the three levels lay out, that the keys are
 * wired to the model, and that the mode and keymap layer arrive on mount and leave on unmount — the last of
 * which is the difference between "esc got me out" and "esc got me out and now the session prompt is dead".
 *
 * Real key dispatch needs the host's `KeymapProvider`, which a mounted view has no way to supply, so keys are
 * simulated by invoking the command each binding points at. Everything downstream of the key lookup — which is
 * where all of this plugin's behavior lives — runs for real.
 */
import { createSignal } from "solid-js"
import { describe, expect, it } from "bun:test"
import type { ControlAction, ControlResult } from "../../src/control"
import { toRunSummary, type JournalRecord, type RunSummary } from "../../src/journal"
import type { RunSnapshot, UnitSnapshot } from "../../src/runs"
import type { RecordResult } from "../../src/tui/client"
import type { RunControlClient } from "../../src/tui/control"
import {
  commandName,
  FIELD_BINDINGS,
  footerHint,
  OPEN_COMMAND,
  openWorkflowRoute,
  registerKeymap,
  registerOpenCommand,
  WORKFLOW_BINDINGS,
  WORKFLOW_ROUTE,
} from "../../src/tui/keymap"
import WorkflowRoute from "../../src/tui/route"
import { createFakeTuiApi, type FakeTuiApi } from "./fake-api"
import { mountView, type MountedView } from "./render"

function unit(overrides: Partial<UnitSnapshot> = {}): UnitSnapshot {
  return {
    unitId: "unit-1",
    ordinal: 1,
    label: "arxiv sweep",
    subagent: "explore",
    phase: "gather",
    status: "running",
    sessionID: "ses_child_1",
    prompt: "sweep arxiv for recent papers",
    startedAt: Date.now() - 18_000,
    endedAt: null,
    ...overrides,
  }
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "deep-research",
    provenance: "durable",
    parentSessionID: "ses_parent",
    status: "running",
    phases: ["plan", "gather", "synthesize"],
    phasesDeclared: true,
    currentPhase: "gather",
    units: [unit()],
    logs: ["gathered 9/20 sources"],
    errors: [],
    interactions: [],
    resolved: [],
    tokensSpent: 41_200,
    startedAt: Date.now() - 130_000,
    endedAt: null,
    ...overrides,
  }
}

interface Harness {
  view: MountedView
  fake: FakeTuiApi
  sent: ControlAction[]
  /** Every runId the route asked the journal for, in order — an on-demand read is a claim worth asserting. */
  read: string[]
  setRuns: (runs: readonly RunSnapshot[]) => void
  /** Simulate a keystroke by running the command its binding points at. */
  press: (action: (typeof WORKFLOW_BINDINGS)[number]["action"]) => Promise<void>
}

async function mountRoute(
  initial: readonly RunSnapshot[],
  options: {
    params?: Record<string, unknown>
    result?: ControlResult
    width?: number
    height?: number
    history?: readonly RunSummary[]
    /**
     * The journal, as the route sees it: one record read at a time.
     *
     * Omitted deliberately in most tests — a route with no reader is the honest shape of a client with no
     * endpoint to ask, and it is what the "cannot be read" sentences are for.
     */
    record?: (runId: string) => Promise<RecordResult>
  } = {},
): Promise<Harness> {
  const fake = createFakeTuiApi()
  const [runs, setRuns] = createSignal<readonly RunSnapshot[]>(initial)
  const [history] = createSignal<readonly RunSummary[]>(options.history ?? [])
  const sent: ControlAction[] = []
  const read: string[] = []
  const control: RunControlClient = {
    async send(action) {
      sent.push(action)
      return options.result ?? { ok: true }
    },
  }
  const reader = options.record
  const view = await mountView(
    () => (
      <WorkflowRoute
        api={fake.api}
        runs={runs}
        history={history}
        control={control}
        record={
          reader
            ? (runId) => {
                read.push(runId)
                return reader(runId)
              }
            : undefined
        }
        params={options.params}
      />
    ),
    { width: options.width ?? 100, height: options.height ?? 24 },
  )
  return {
    view,
    fake,
    sent,
    read,
    setRuns,
    async press(action) {
      fake.runCommand(commandName(action))
      await view.flush()
    },
  }
}

/** One journaled record, as `GET /history/<runId>` returns it. */
function journaled(snapshot: RunSnapshot): JournalRecord {
  return { run: snapshot, source: "export default defineWorkflow({})", args: {}, transitions: [] }
}

/** Let an in-flight journal read resolve, and render what it produced. */
async function settle(harness: Harness): Promise<void> {
  await harness.view.flush()
  await harness.view.flush()
}

describe("workflow keymap", () => {
  it("registers only the enabled bindings, scoped to the route's own mode", () => {
    const fake = createFakeTuiApi()
    const seen: string[] = []
    const dispose = registerKeymap(fake.api, (action) => seen.push(action))

    const layer = fake.keymapLayers[0]
    expect(fake.keymapLayers).toHaveLength(1)
    expect(layer?.mode).toBe(WORKFLOW_ROUTE)
    expect(layer?.bindings?.map((binding) => binding.key)).toEqual([
      "up,k",
      "down,j",
      "return,right,l",
      "space",
      // `n`, not the `tab` the design asked for: the host binds `tab` to `agent_cycle` and advertises it in its
      // own startup tips. Whether a mode-scoped plugin layer outranks a host default is not this plugin's call
      // to make, and a key the user already has muscle memory for is not ours to gamble with.
      "n",
      "escape,left,h",
      "f",
      // Beside `f`: the same gesture asked of a different column — what a run is doing, then whose it is.
      "w",
      "x",
      "s",
      "q",
    ])
    // `r` is declared but not wired — the vocabulary was fixed up front so Phase 6 adds behavior, not keys.
    // `s` made exactly that transition in Phase 3: same key, same footer position, now live.
    expect(layer?.bindings?.some((binding) => binding.key === "r")).toBe(false)

    /**
     * Every binding consumes its key, and that is only safe because the FIELD gets a layer of its own.
     *
     * The host's keymap prepends its listener to the renderer's key stream and `preventDefault()`s anything it
     * matched; OpenTUI then skips the focused renderable's own handler on a default-prevented key. So while
     * this layer is installed, none of `h j k l f x s q n` can be typed — which is precisely why it is swapped
     * for {@link FIELD_BINDINGS} the moment the answer field opens. Letting keys through instead
     * (`preventDefault: false` on every binding) was the other option, and it makes `q` both close the route
     * and type a `q`.
     */
    for (const binding of layer?.bindings ?? []) {
      expect((binding as { preventDefault?: boolean }).preventDefault).toBeUndefined()
    }
    // The field's own layer is small on purpose: anything it does not claim reaches the input.
    expect(FIELD_BINDINGS.map((binding) => binding.key)).toEqual(["escape", "return"])

    fake.runCommand(commandName("stop"))
    expect(seen).toEqual(["stop"])

    dispose()
    expect(fake.keymapLayers).toHaveLength(0)
  })

  it("shows the unwired keys in the footer as parenthesised rather than absent", () => {
    expect(footerHint()).toBe("↑↓ select · ⏎ open · esc back · f filter · w scope · x stop · (r restart) · s save · q close")
  })

  it("registers a palette/slash way in, because the sidebar shows nothing until a run starts", () => {
    const fake = createFakeTuiApi()
    registerOpenCommand(fake.api)
    const command = fake.keymapLayers[0]?.commands?.[0] as Record<string, unknown> | undefined
    expect(command?.name).toBe(OPEN_COMMAND)
    expect(command?.namespace).toBe("palette")
    expect(command?.slashName).toBe("workflow-runs")
    // No default keybinding: a global key taken by a plugin is a key taken from the user.
    expect(fake.keymapLayers[0]?.bindings).toEqual([])

    fake.runCommand(OPEN_COMMAND)
    expect(fake.navigations).toEqual([{ name: WORKFLOW_ROUTE, params: {} }])
  })

  it("remembers the session it was opened from, so `esc` lands back where the user was", () => {
    const fake = createFakeTuiApi()
    fake.api.route.navigate("session", { sessionID: "ses_here" })
    openWorkflowRoute(fake.api, "run-7")
    expect(fake.navigations.at(-1)).toEqual({
      name: WORKFLOW_ROUTE,
      params: { runId: "run-7", returnTo: "ses_here" },
    })

    // From home there is nothing to return to, and inventing one would land the user somewhere they never were.
    const fromHome = createFakeTuiApi()
    openWorkflowRoute(fromHome.api, "run-7")
    expect(fromHome.navigations.at(-1)).toEqual({ name: WORKFLOW_ROUTE, params: { runId: "run-7" } })
  })
})

describe("workflow route render", () => {
  it("renders the list level: breadcrumb, filter, and one row per run", async () => {
    const harness = await mountRoute([
      run(),
      run({ runId: "run-2", workflow: "summarize", status: "done", endedAt: Date.now(), units: [unit({ status: "ok" })] }),
    ])
    try {
      const frame = harness.view.text()
      expect(frame).toContain("Workflows")
      expect(frame).toContain("filter all")
      expect(frame).toContain("deep-research")
      expect(frame).toContain("phase 2/3 gather")
      expect(frame).toContain("0/1 units")
      expect(frame).toContain("summarize")
      expect(frame).toContain("1/1 units")
      // A live run carries a partial phase meter; a finished one reads as complete.
      expect(frame).toMatch(/deep-research\s+▰+▱/)
      expect(frame).toMatch(/summarize\s+▰▰▰▰/)
      // "done · phase 3/3" says nothing "done" did not, so a successful run drops its position.
      expect(frame).toContain("done")
      expect(frame.split("\n").find((line) => line.includes("summarize"))).not.toContain("phase")
    } finally {
      harness.view.unmount()
    }
  })

  it("starts every row's detail at the same column, whatever the names are", async () => {
    // With a bare space between name and detail, two runs whose names differ in length put their details in
    // different places and the list reads as ragged text rather than a table.
    const harness = await mountRoute([
      run({ runId: "short", workflow: "echo" }),
      run({ runId: "long", workflow: "deep-research" }),
    ])
    try {
      const detailColumns = harness.view
        .text()
        .split("\n")
        .filter((line) => line.includes("units"))
        .map((line) => line.indexOf("phase"))
      expect(detailColumns).toHaveLength(2)
      expect(detailColumns[0]).toBe(detailColumns[1] as number)
    } finally {
      harness.view.unmount()
    }
  })

  it("says so when there is nothing to browse", async () => {
    const harness = await mountRoute([])
    try {
      expect(harness.view.text()).toContain("No workflow runs to show")
    } finally {
      harness.view.unmount()
    }
  })

  it("pushes its mode and keymap layer on mount, and gives both back on unmount", async () => {
    const harness = await mountRoute([run()])
    expect(harness.fake.modes).toEqual([WORKFLOW_ROUTE])
    expect(harness.fake.keymapLayers).toHaveLength(1)

    harness.view.unmount()
    // The whole reason the mode is scoped: a session prompt whose keys never came back is a dead terminal.
    expect(harness.fake.modes).toEqual([])
    expect(harness.fake.keymapLayers).toHaveLength(0)
  })

  it("drills list → run → unit under the keys, and backs out again", async () => {
    const harness = await mountRoute([run()])
    try {
      await harness.press("drill")
      let frame = harness.view.text()
      expect(frame).toContain("Workflows › deep-research")
      // The stat strip carries each figure with its own meter, rather than one `·`-joined sentence.
      expect(frame).toContain("running")
      expect(frame).toContain("phase 2/3 gather")
      expect(frame).toContain("0/1 units")
      expect(frame).toContain("41k tok")
      expect(frame).toContain("41k tok")
      expect(frame).toContain("Phase 1/3  plan")
      expect(frame).toContain("#1 explore")
      expect(frame).toContain("Recent")
      expect(frame).toContain("gathered 9/20 sources")

      // Row 0 is the `plan` phase; the unit sits under `gather`.
      await harness.press("down")
      await harness.press("down")
      await harness.press("drill")
      frame = harness.view.text()
      expect(frame).toContain("Workflows › deep-research › #1 arxiv sweep")
      expect(frame).toContain("ses_child_1")
      expect(frame).toContain("sweep arxiv for recent papers")

      await harness.press("back")
      expect(harness.view.text()).toContain("Workflows › deep-research")
      await harness.press("back")
      expect(harness.view.text()).toContain("filter all")
      expect(harness.view.text()).not.toContain("▸ deep-research")
    } finally {
      harness.view.unmount()
    }
  })

  it("shows a failed unit's error on its own screen", async () => {
    const failed = run({
      units: [unit({ status: "failed", endedAt: Date.now(), error: "unit stopped before completion" })],
    })
    const harness = await mountRoute([failed], { params: { runId: "run-1" } })
    try {
      // Entered from the sidebar, so the run level is already open.
      expect(harness.view.text()).toContain("Workflows › deep-research")
      await harness.press("down")
      await harness.press("down")
      await harness.press("drill")
      const frame = harness.view.text()
      expect(frame).toContain("Error")
      expect(frame).toContain("unit stopped before completion")
    } finally {
      harness.view.unmount()
    }
  })

  it("cycles the filter and re-lists", async () => {
    const harness = await mountRoute([run(), run({ runId: "run-2", workflow: "summarize", status: "done", endedAt: Date.now() })])
    try {
      await harness.press("filter")
      let frame = harness.view.text()
      expect(frame).toContain("filter active")
      expect(frame).toContain("deep-research")
      expect(frame).not.toContain("summarize")

      await harness.press("filter")
      frame = harness.view.text()
      expect(frame).toContain("filter done")
      expect(frame).toContain("summarize")
      expect(frame).not.toContain("deep-research")
    } finally {
      harness.view.unmount()
    }
  })

  it("sends a stop for the selection and reports what came back", async () => {
    const harness = await mountRoute([run()])
    try {
      await harness.press("stop")
      expect(harness.sent).toEqual([{ action: "stop.run", runId: "run-1" }])
      await harness.view.flush()
      expect(harness.view.text()).toContain("stopping run…")
    } finally {
      harness.view.unmount()
    }
  })

  it("says why a stop did nothing rather than swallowing it", async () => {
    const harness = await mountRoute([run({ status: "done", endedAt: Date.now() })], {
      result: { ok: false, reason: "not-running" },
    })
    try {
      await harness.press("stop")
      await harness.view.flush()
      expect(harness.view.text()).toContain("already finished")
    } finally {
      harness.view.unmount()
    }
  })

  it("targets the selected unit when the cursor is on one", async () => {
    const harness = await mountRoute([run()], { params: { runId: "run-1" } })
    try {
      await harness.press("down")
      await harness.press("down")
      await harness.press("stop")
      expect(harness.sent).toEqual([{ action: "stop.unit", runId: "run-1", unitId: "unit-1" }])
    } finally {
      harness.view.unmount()
    }
  })

  it("leaves the route on `q`, and on `back` from the list — returning to the session it was opened from", async () => {
    const fromSession = await mountRoute([run()], { params: { returnTo: "ses_parent" } })
    try {
      await fromSession.press("back")
      expect(fromSession.fake.navigations).toEqual([{ name: "session", params: { sessionID: "ses_parent" } }])
    } finally {
      fromSession.view.unmount()
    }

    // With no session to return to, home is the honest fallback: a plugin route has no history to walk back.
    const standalone = await mountRoute([run()])
    try {
      await standalone.press("close")
      expect(standalone.fake.navigations).toEqual([{ name: "home", params: undefined }])
    } finally {
      standalone.view.unmount()
    }
  })

  it("survives a run vanishing underneath a drilled-in cursor", async () => {
    // The failure this guards is not cosmetic: a breadcrumb built from a missing run, or a `<For>` emptying
    // out beside a sibling, is how OpenTUI ends up with a text node under a box and takes the host down.
    const harness = await mountRoute([run()], { params: { runId: "run-1" } })
    try {
      expect(harness.view.text()).toContain("Workflows › deep-research")

      harness.setRuns([])
      await harness.view.flush()
      const frame = harness.view.text()
      expect(frame).toContain("No workflow runs to show")
      expect(frame).not.toContain("▸ deep-research")

      harness.setRuns([run({ runId: "run-9", workflow: "refine" })])
      await harness.view.flush()
      expect(harness.view.text()).toContain("refine")
    } finally {
      harness.view.unmount()
    }
  })

  it("keeps every row on one line at a narrow terminal", async () => {
    const harness = await mountRoute([run({ workflow: "deep-research-with-a-very-long-name" })], { width: 80, height: 24 })
    try {
      for (const line of harness.view.text().split("\n")) expect(line.length).toBeLessThanOrEqual(80)
      expect(harness.view.text()).toContain("deep-research")
    } finally {
      harness.view.unmount()
    }
  })

  it("shows what the unit answered, not just what it was asked", async () => {
    // The unit screen used to render the prompt and then a screen of empty space — the question without the
    // answer, which is the half nobody opened it for.
    const answered = run({
      units: [unit({ status: "ok", endedAt: Date.now(), output: '{"areas":["Rayleigh scattering"],"ok":true}' })],
    })
    const harness = await mountRoute([answered], {
      width: 120,
      height: 30,
      record: async () => ({ ok: false, reason: "not-found" }),
    })
    try {
      await harness.press("drill")
      // Row 0 is the `plan` phase; the unit sits under `gather`.
      await harness.press("down")
      await harness.press("down")
      await harness.press("drill")
      await settle(harness)
      // A unit that settled while this screen was watching carries its answer on the event that settled it.
      // Re-reading it off disk would be a file read per unit opened, for something already in hand.
      expect(harness.read).toEqual([])
      const frame = harness.view.text()
      expect(frame).toContain("Prompt")
      expect(frame).toContain("Answer")
      expect(frame).toContain("Rayleigh scattering")
      // Rendered as indented JSON rather than the compact string the store holds.
      expect(frame).toMatch(/"areas":\s*\[/)
    } finally {
      harness.view.unmount()
    }
  })

  it("says a unit has not answered yet instead of leaving a gap", async () => {
    const harness = await mountRoute([run()], { width: 120, height: 30 })
    try {
      await harness.press("drill")
      await harness.press("down")
      await harness.press("down")
      await harness.press("drill")
      expect(harness.view.text()).toContain("Waiting for this unit to answer")
    } finally {
      harness.view.unmount()
    }
  })

  it("does not tell a settled run it is `starting`", async () => {
    // A run with no phases that has finished was rendering "✓ done  starting" in the stat strip.
    const harness = await mountRoute([
      run({ status: "done", endedAt: Date.now(), phases: [], phasesDeclared: false, currentPhase: null }),
    ])
    try {
      await harness.press("drill")
      expect(harness.view.text()).not.toContain("starting")
    } finally {
      harness.view.unmount()
    }
  })

  it("keeps the selected row readable even when the theme's selection tokens collide", async () => {
    // The regression this exists for: the selected row was drawn with `selectedListItemText` over
    // `backgroundElement`. That token is cut to sit on the HOST's selection fill, so against ours it landed
    // invisible — on a real host every selected cell rendered blank, leaving a row that was nothing but its
    // status glyph and its meter. The adversarial theme below collapses those two tokens onto one colour;
    // any styling that depends on them contrasting fails here instead of on someone's terminal.
    const fake = createFakeTuiApi("/tmp/opencode-state", {
      selectedListItemText: "#222222",
      backgroundElement: "#222222",
    })
    const [runs] = createSignal<readonly RunSnapshot[]>([run()])
    const view = await mountView(
      () => <WorkflowRoute api={fake.api} runs={runs} control={{ async send() { return { ok: true } } }} />,
      { width: 120, height: 24 },
    )
    try {
      const selected = view.text().split("\n").find((line) => line.includes("deep-research"))
      expect(selected).toBeDefined()
      // The row must carry its name and its figures, not just the glyph and meter that ignore selection.
      expect(selected).toContain("deep-research")
      expect(selected).toContain("phase 2/3")
      expect(selected).toContain("0/1 units")
    } finally {
      view.unmount()
    }
  })

  it("lists journal history under its own heading, filling the same columns as a live row", async () => {
    const past = toRunSummary(
      run({
        runId: "run-past",
        workflow: "summarize",
        status: "done",
        endedAt: Date.now() - 60_000,
        startedAt: Date.now() - 120_000,
        tokensSpent: 9_000,
        units: [unit({ status: "ok", endedAt: Date.now() - 61_000 })],
      }),
    )
    const harness = await mountRoute([run()], { history: [past], width: 130, height: 24 })
    try {
      const frame = harness.view.text()
      expect(frame).toContain("History")
      expect(frame).toContain("earlier sessions")
      const row = frame.split("\n").find((line) => line.includes("summarize"))
      // Every column a live row carries: outcome, units, tokens, elapsed, start clock. A history row that
      // could only fill half of them would read as broken rather than as older.
      expect(row).toContain("done")
      expect(row).toContain("1/1 units")
      expect(row).toContain("9.0k tok")
      expect(row).toMatch(/\d{2}:\d{2}/)
    } finally {
      harness.view.unmount()
    }
  })

  it("opens a History row into the run the journal kept", async () => {
    // The defect this exists for: every piece of this — the record endpoint, the client read, the row model's
    // `archived` set, the reducer's history-aware normalization — shipped and was tested, and the ROUTE called
    // none of it. A user ran a workflow, restarted OpenCode, and could not open their own run.
    const past = run({
      runId: "run-past",
      workflow: "summarize",
      status: "done",
      endedAt: Date.now() - 60_000,
      units: [unit({ status: "ok", endedAt: Date.now() - 61_000 })],
    })
    const harness = await mountRoute([], {
      history: [toRunSummary(past)],
      record: async () => ({ ok: true, record: journaled(past) }),
      width: 120,
    })
    try {
      await harness.press("drill")
      await settle(harness)
      expect(harness.read).toEqual(["run-past"])

      const frame = harness.view.text()
      // The same level a live run gets, from a snapshot that came off disk — and the breadcrumb says so, because
      // a dead run that looked identical to a live one while quietly refusing its keys would read as broken.
      expect(frame).toContain("summarize (archived)")
      expect(frame).toContain("#1 explore")

      // Nothing here has an engine to talk to. `x` says that rather than sending an action it can predict the
      // failure of, and the footer dims the keys that cannot work while leaving `s` alone — saving a run whose
      // engine is long gone is the case the journal exists for.
      await harness.press("stop")
      expect(harness.sent).toEqual([])
      expect(harness.view.text()).toContain("nothing left to stop")
      await harness.press("save")
      expect(harness.sent).toEqual([{ action: "save.run", runId: "run-past" }])

      // Leaving puts it back under History rather than stranding it among this session's runs.
      await harness.press("back")
      await settle(harness)
      const list = harness.view.text()
      expect(list).toContain("earlier sessions")
      expect(list.split("\n").filter((line) => line.includes("summarize"))).toHaveLength(1)
    } finally {
      harness.view.unmount()
    }
  })

  it("says a journaled run is being read, and says why when it cannot be", async () => {
    let answerRead: (result: RecordResult) => void = () => {}
    const harness = await mountRoute([], {
      history: [toRunSummary(run({ runId: "run-past", status: "done", endedAt: Date.now() }))],
      record: () =>
        new Promise<RecordResult>((resolve) => {
          answerRead = resolve
        }),
    })
    try {
      await harness.press("drill")
      // Three states, three sentences. A level that rendered an empty run while the read was in flight would
      // look like a run that did nothing.
      expect(harness.view.text()).toContain("Reading this run from the journal")

      answerRead({ ok: false, reason: "unknown-endpoint" })
      await settle(harness)
      expect(harness.view.text()).toContain("no running opencode has this run's journal")
    } finally {
      harness.view.unmount()
    }
  })

  it("reads a settled unit's answer back from the journal, because `/state` no longer carries it", async () => {
    // `/state` is a bootstrap payload re-sent whole on every reconnect, so it ships every unit's answer elided
    // and says so. The screen showing one answer fetches that one answer.
    const elided = run({
      units: [unit({ status: "ok", endedAt: Date.now(), outputElided: true })],
    })
    const whole = run({
      units: [unit({ status: "ok", endedAt: Date.now(), output: '{"areas":["Rayleigh scattering"]}' })],
    })
    const harness = await mountRoute([elided], {
      record: async () => ({ ok: true, record: journaled(whole) }),
      width: 120,
      height: 30,
    })
    try {
      await harness.press("drill")
      await harness.press("down")
      await harness.press("down")
      await harness.press("drill")
      await settle(harness)
      expect(harness.read).toEqual(["run-1"])
      const frame = harness.view.text()
      expect(frame).toContain("Answer")
      expect(frame).toContain("Rayleigh scattering")
    } finally {
      harness.view.unmount()
    }
  })

  it("does not claim a unit said nothing when its answer merely could not be read", async () => {
    const elided = run({ units: [unit({ status: "ok", endedAt: Date.now(), outputElided: true })] })
    const harness = await mountRoute([elided], {
      record: async () => ({ ok: false, reason: "not-found" }),
      width: 120,
      height: 30,
    })
    try {
      await harness.press("drill")
      await harness.press("down")
      await harness.press("down")
      await harness.press("drill")
      await settle(harness)
      const frame = harness.view.text()
      expect(frame).toContain("this run is not in the journal")
      expect(frame).not.toContain("returned nothing")
    } finally {
      harness.view.unmount()
    }
  })

  it("saves the selected run's script, and reports where it landed", async () => {
    const harness = await mountRoute([run()], { result: { ok: true, detail: 'saved as "deep-research" — run it by name' } })
    try {
      await harness.press("save")
      expect(harness.sent).toEqual([{ action: "save.run", runId: "run-1" }])
      await harness.view.flush()
      expect(harness.view.text()).toContain('saved as "deep-research"')
    } finally {
      harness.view.unmount()
    }
  })

  it("says why a save did nothing rather than swallowing it", async () => {
    const harness = await mountRoute([run()], {
      result: { ok: false, reason: "conflict", detail: "deep-research is already a durable workflow" },
    })
    try {
      await harness.press("save")
      await harness.view.flush()
      expect(harness.view.text()).toContain("already a durable workflow")
    } finally {
      harness.view.unmount()
    }
  })

  it("shows this session's runs by default, and says so", async () => {
    // The user's own words: *"why would I want to see a run from another session?"* Opened from a session, the
    // browser answers that question before it is asked — and names the scope it is in, because a list that is
    // hiding rows has to say so.
    const mine = run({ runId: "mine", workflow: "mine-research", parentSessionID: "ses_here" })
    const theirs = run({ runId: "theirs", workflow: "their-research", parentSessionID: "ses_elsewhere" })
    const harness = await mountRoute([mine, theirs], { params: { returnTo: "ses_here" }, width: 130 })
    try {
      const frame = harness.view.text()
      expect(frame).toContain("scope this session")
      expect(frame).toContain("mine-research")
      expect(frame).not.toContain("their-research")

      // `w` widens rather than narrows, so a person who cannot find a run presses it again.
      await harness.press("scope")
      expect(harness.view.text()).toContain("scope this project")
      expect(harness.view.text()).toContain("their-research")
      await harness.press("scope")
      expect(harness.view.text()).toContain("scope everywhere")
      await harness.press("scope")
      expect(harness.view.text()).toContain("scope this session")
    } finally {
      harness.view.unmount()
    }
  })

  it("opens on the project when it was not opened from a session", async () => {
    // From the home screen there is no session to be in, and defaulting to one would show an empty list and
    // blame the user for it.
    const harness = await mountRoute([run({ parentSessionID: "ses_somewhere" })], { width: 130 })
    try {
      expect(harness.view.text()).toContain("scope this project")
      expect(harness.view.text()).toContain("deep-research")
    } finally {
      harness.view.unmount()
    }
  })

  it("says an empty list is empty because of the scope, not because nothing ran", async () => {
    const harness = await mountRoute([run({ parentSessionID: "ses_elsewhere" })], {
      params: { returnTo: "ses_here" },
      width: 130,
    })
    try {
      const frame = harness.view.text()
      expect(frame).toContain("No runs in this session")
      expect(frame).toContain("1 elsewhere")
      expect(frame).toContain("Press `w` to widen")
      // The other sentence would send them to the tool to start a run they have already started.
      expect(frame).not.toContain("Start one with the `workflow` tool")
    } finally {
      harness.view.unmount()
    }
  })

  it("scopes History by session too — `this session` means this session on both halves of the list", async () => {
    /**
     * Reported after a manual pass: the scope was applied to the live rows and not to History, and a header
     * saying `this session` above another session's runs is the kind of half-rule a user has to remember an
     * exception for. What keeps `History earlier sessions` from being empty is the DEFAULT rather than an
     * exception here — a browser opened from the home screen has no session and opens on the project, which is
     * the "I restarted OpenCode and want my run back" path.
     */
    const past = (runId: string, workflow: string, parentSessionID: string): RunSummary =>
      toRunSummary(run({ runId, workflow, parentSessionID, status: "done", endedAt: Date.now() - 60_000 }))
    const history = [past("run-mine", "summarize", "ses_here"), past("run-theirs", "refine", "ses_long_gone")]

    const scoped = await mountRoute([], { history, params: { returnTo: "ses_here" }, width: 130 })
    try {
      const frame = scoped.view.text()
      expect(frame).toContain("scope this session")
      expect(frame).toContain("earlier sessions")
      expect(frame).toContain("summarize")
      expect(frame).not.toContain("refine")
    } finally {
      scoped.view.unmount()
    }

    // From the home screen there is no session to scope to, so the whole project's history is there.
    const fromHome = await mountRoute([], { history, width: 130 })
    try {
      expect(fromHome.view.text()).toContain("scope this project")
      expect(fromHome.view.text()).toContain("refine")
    } finally {
      fromHome.view.unmount()
    }
  })

  it("keeps telling the truth when the run accessor never notifies", async () => {
    /**
     * The run client's signal does NOT invalidate this route's computations on a real host — measured, with
     * counters on a live frame: nine events consumed, the accessor returning `aborted`, and the memo behind it
     * recomputed exactly once. Everything on this screen is kept current by its own clock instead.
     *
     * So the accessor here is a plain closure over a mutable variable: no signal, no notification, exactly the
     * shape the live host presents. A run that ends must still appear as ended. This test fails against a memo
     * over the accessor — which is the defect it exists for: a stopped run rendered as running for as long as
     * the browser stayed open, while the engine had aborted it a second after the keypress.
     */
    let current: readonly RunSnapshot[] = [run()]
    const fake = createFakeTuiApi()
    const view = await mountView(
      () => (
        <WorkflowRoute
          api={fake.api}
          runs={() => current}
          control={{ async send() { return { ok: true } } }}
        />
      ),
      { width: 130, height: 24 },
    )
    try {
      expect(view.text()).toContain("deep-research")
      expect(view.text()).not.toContain("aborted")

      current = [run({ status: "aborted", endedAt: Date.now(), currentPhase: "gather" })]
      // The clock runs at one second, which is what bounds how stale this screen can be.
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      await view.flush()
      expect(view.text()).toContain("aborted")
    } finally {
      view.unmount()
    }
  })

  it("drops columns by how little they carry, rather than truncating all of them equally", async () => {
    const wide = await mountRoute([run({ tokensSpent: 41_200 })], { width: 130, height: 24 })
    try {
      const frame = wide.view.text()
      expect(frame).toContain("41k tok") // the widest layout affords everything
      expect(frame).toMatch(/\d{2}:\d{2}/) // …including the start clock
      expect(frame).toContain("▰")
    } finally {
      wide.view.unmount()
    }

    const narrow = await mountRoute([run({ tokensSpent: 41_200 })], { width: 80, height: 24 })
    try {
      const frame = narrow.view.text()
      // Identity, phase, and counts survive; the niceties go.
      expect(frame).toContain("deep-research")
      expect(frame).toContain("0/1 units")
      expect(frame).not.toContain("41k tok")
      // The footer sheds its unwired hints too, rather than running off the edge.
      expect(frame).not.toContain("restart")
      for (const line of frame.split("\n")) expect(line.length).toBeLessThanOrEqual(80)
    } finally {
      narrow.view.unmount()
    }
  })
})

/**
 * Every strip separates its fields with real spaces, at every width.
 *
 * The user's own terminal rendered `⠦ running▰▰▰▱phase 2/3 choose▰▰▰▰1/1 units2m26s` and
 * `Workflows›asks-the-human›question`. These rows separated their fields with flex `gap`, which does render in
 * this harness at every width tested — so the fix is not a tweak but the removal of the variable: the
 * separators are in the text now, and there is exactly one source of them.
 */
describe("route spacing: separators live in the text, not in a flex gap", () => {
  const settled = run({
    status: "done",
    endedAt: Date.now(),
    units: [unit({ status: "ok", endedAt: Date.now() })],
  })

  for (const width of [140, 116, 100, 92, 80, 60] as const) {
    it(`keeps every field apart at ${width} columns`, async () => {
      const harness = await mountRoute([settled], { width, height: 24 })
      try {
        const frame = harness.view.text()
        // The breadcrumb, and the list row's glyph, name, meter and phase.
        expect(frame).not.toMatch(/\w›/)
        expect(frame).not.toMatch(/›\w/)
        expect(frame).not.toMatch(/[▰▱](?=[A-Za-z0-9])/)
        expect(frame).not.toMatch(/[A-Za-z0-9][▰▱]/)
        // `units` and the elapsed clock that follows it.
        expect(frame).not.toMatch(/units\d/)
        // Never doubled either: one source of separation means one space's worth of it.
        expect(frame).not.toContain("Workflows  ›")
      } finally {
        harness.view.unmount()
      }
    })
  }

  // Two spaces AFTER a meter as well as before it. `▰`/`▱` are East-Asian ambiguous width, so a font may draw
  // them wider than their cell and paint over the separator that follows — which is what a real terminal did,
  // rendering `▰▰▰▰phase 3/3` from a string that contained the space. One space is a separator that exists only
  // in the buffer.
  it("puts two spaces around every figure in the strip, meters included", async () => {
    const harness = await mountRoute([run()], { params: { runId: "run-1" }, width: 120 })
    try {
      const strip = harness.view.text().split("\n").find((line) => line.includes("running")) ?? ""
      expect(strip).toMatch(/running {2}[▰▱]{4} {2}phase 2\/3 gather {2}[▰▱]{4} {2}0\/1 units {2}\d/)
    } finally {
      harness.view.unmount()
    }
  })

  it("puts two spaces between footer hints, and one between a key and its label", async () => {
    const harness = await mountRoute([run()], { width: 140 })
    try {
      const footer = harness.view.text().split("\n").find((line) => line.includes("select")) ?? ""
      expect(footer).toContain("↑↓ select  ⏎ open  esc back  f filter  w scope  x stop")
    } finally {
      harness.view.unmount()
    }
  })
})

/**
 * The run level must not claim anything is running once the run is over.
 *
 * The regression: `asks-the-human`'s `finish` phase launches no units of its own, so the glyph chain fell
 * through to `index === currentIndex ? "running"` and spun forever after the run had finished.
 */
describe("run level: a settled run has nothing spinning on it", () => {
  it("renders a unit-less final phase with the run's own outcome", async () => {
    const finished = run({
      status: "done",
      endedAt: Date.now(),
      phases: ["choose", "finish"],
      currentPhase: "finish",
      units: [unit({ phase: "choose", status: "ok", endedAt: Date.now() })],
    })
    const harness = await mountRoute([finished], { params: { runId: "run-1" }, width: 120 })
    try {
      const line = harness.view.text().split("\n").find((row) => row.includes("finish")) ?? ""
      expect(line).toContain("✓")
      // The spinner frames — a settled run must show none of them, anywhere.
      expect(harness.view.text()).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    } finally {
      harness.view.unmount()
    }
  })

  it("marks a stopped run's open phase `⊘`, not `✗` — it did not fail, it was stopped", async () => {
    const stopped = run({
      status: "aborted",
      endedAt: Date.now(),
      phases: ["choose", "finish"],
      currentPhase: "finish",
      units: [unit({ phase: "choose", status: "ok", endedAt: Date.now() })],
    })
    const harness = await mountRoute([stopped], { params: { runId: "run-1" }, width: 120 })
    try {
      const line = harness.view.text().split("\n").find((row) => row.includes("finish")) ?? ""
      expect(line).toContain("⊘")
    } finally {
      harness.view.unmount()
    }
  })
})

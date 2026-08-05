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
import { toRunSummary, type RunSummary } from "../../src/journal"
import type { RunSnapshot, UnitSnapshot } from "../../src/runs"
import type { RunControlClient } from "../../src/tui/control"
import {
  commandName,
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
  } = {},
): Promise<Harness> {
  const fake = createFakeTuiApi()
  const [runs, setRuns] = createSignal<readonly RunSnapshot[]>(initial)
  const [history] = createSignal<readonly RunSummary[]>(options.history ?? [])
  const sent: ControlAction[] = []
  const control: RunControlClient = {
    async send(action) {
      sent.push(action)
      return options.result ?? { ok: true }
    },
  }
  const view = await mountView(
    () => (
      <WorkflowRoute api={fake.api} runs={runs} history={history} control={control} params={options.params} />
    ),
    { width: options.width ?? 100, height: options.height ?? 24 },
  )
  return {
    view,
    fake,
    sent,
    setRuns,
    async press(action) {
      fake.runCommand(commandName(action))
      await view.flush()
    },
  }
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
      "escape,left,h",
      "f",
      "x",
      "s",
      "q",
    ])
    // `r` is declared but not wired — the vocabulary was fixed up front so Phase 6 adds behavior, not keys.
    // `s` made exactly that transition in Phase 3: same key, same footer position, now live.
    expect(layer?.bindings?.some((binding) => binding.key === "r")).toBe(false)

    /**
     * `space` is the one binding that does not consume its keystroke, and that is what makes it safe to claim.
     *
     * The host's keymap prepends its listener to the renderer's key stream and `preventDefault()`s anything it
     * matched; OpenTUI then skips the focused renderable's own handler on a default-prevented key. A bound
     * printable key therefore never reaches the pane's free-text field. Registered this way, the space still
     * lands in the answer being typed — and `route.tsx` makes the toggle inert while that field is open.
     */
    const toggle = layer?.bindings?.find((binding) => binding.key === "space")
    expect((toggle as { preventDefault?: boolean } | undefined)?.preventDefault).toBe(false)
    // …and no other binding gives its key away.
    for (const binding of layer?.bindings ?? []) {
      if (binding.key === "space") continue
      expect((binding as { preventDefault?: boolean }).preventDefault).toBeUndefined()
    }

    fake.runCommand(commandName("stop"))
    expect(seen).toEqual(["stop"])

    dispose()
    expect(fake.keymapLayers).toHaveLength(0)
  })

  it("shows the unwired keys in the footer as parenthesised rather than absent", () => {
    expect(footerHint()).toBe("↑↓ select · ⏎ open · esc back · f filter · x stop · (r restart) · s save · q close")
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
    const harness = await mountRoute([answered], { width: 120, height: 30 })
    try {
      await harness.press("drill")
      // Row 0 is the `plan` phase; the unit sits under `gather`.
      await harness.press("down")
      await harness.press("down")
      await harness.press("drill")
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

  it("says why `⏎` does nothing on a history row, instead of looking broken", async () => {
    const harness = await mountRoute([], { history: [toRunSummary(run({ runId: "run-past", status: "done", endedAt: Date.now() }))] })
    try {
      await harness.press("drill")
      await harness.view.flush()
      expect(harness.view.text()).toContain("earlier session")
      // Still on the list: no level was pushed for a run that has no snapshot behind it.
      expect(harness.view.text()).toContain("filter all")
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
      expect(footer).toContain("↑↓ select  ⏎ open  esc back  f filter  x stop")
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

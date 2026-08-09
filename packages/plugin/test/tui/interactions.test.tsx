/** @jsxImportSource @opentui/solid */
/**
 * The answer pane, as OpenTUI actually renders it and as the keyboard actually drives it.
 *
 * Two classes of claim live here. The pure ones — how a selection becomes the host's reply shape, what the
 * grace countdown says — are cheap and exhaustive. The mounted ones exist because a terminal UI breaks in ways
 * a model test cannot see: an option list that renders its labels but not its descriptions, a selection that
 * changes a colour the theme happens to make invisible, a key that reaches the reducer but never the pane.
 *
 * The adversarial-theme case is the one that earned its place. The run browser once styled its selected row
 * with `selectedListItemText` over `backgroundElement`; both tokens were distinct in the test double and the
 * frame looked perfect, while on a real host every selected cell rendered blank. Any new selection styling gets
 * a theme that collapses the tokens it depends on onto one colour.
 */
import { createSignal } from "solid-js"
import { describe, expect, it } from "bun:test"
import type { ControlAction } from "../../src/control"
import type { PendingInteraction, ResolvedInteraction, RunSnapshot } from "../../src/runs"
import type { RunControlClient } from "../../src/tui/control"
import InteractionPane, {
  buildAnswer,
  CUSTOM_ROW_LABEL,
  graceRatio,
  graceRemaining,
  paneRows,
} from "../../src/tui/interactions"
import { commandName, footerHint, questionBindings, QUESTION_BINDINGS } from "../../src/tui/keymap"
import WorkflowRoute from "../../src/tui/route"
import { createFakeTuiApi, fakeTheme, type FakeTuiApi } from "./fake-api"
import { mountView, type MountedView } from "./render"

function interaction(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    requestID: "req-1",
    kind: "question",
    origin: "agent",
    sessionID: "ses_child",
    unitId: "unit-1",
    depth: 3,
    phase: null,
    questions: [
      {
        header: "Citation style",
        prompt: "Which citation style should the report use?",
        options: [
          { label: "APA", description: "American Psychological Association" },
          { label: "MLA", description: "Modern Language Association" },
          { label: "Chicago", description: "Chicago Manual of Style" },
        ],
        multiple: false,
        custom: false,
      },
    ],
    raisedAt: 1_000_000,
    graceEndsAt: 1_300_000,
    ...overrides,
  }
}

/**
 * The same interaction, but with its grace anchored to the real clock.
 *
 * The pure tests pin absolute timestamps so their arithmetic is readable; a MOUNTED pane reads `Date.now()`
 * through the route's own tick, so a fixed `raisedAt` would render as "handing over to automation…" forever.
 */
function live(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  const now = Date.now()
  return interaction({ raisedAt: now, graceEndsAt: now + 300_000, ...overrides })
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: "run-1",
    workflow: "deep-research",
    provenance: "durable",
    parentSessionID: "ses_parent",
    status: "running",
    phases: ["gather"],
    phasesDeclared: true,
    currentPhase: "gather",
    units: [],
    logs: [],
    errors: [],
    interactions: [live()],
    resolved: [],
    tokensSpent: 0,
    startedAt: Date.now() - 60_000,
    endedAt: null,
    ...overrides,
  }
}

describe("answer shaping", () => {
  it("turns a chosen label into the host's own reply shape", () => {
    expect(buildAnswer(interaction(), ["MLA"], null)).toEqual([["MLA"]])
  })

  it("prefers a typed answer over the selection, trimmed", () => {
    expect(buildAnswer(interaction(), ["APA"], "  Vancouver  ")).toEqual([["Vancouver"]])
    // An empty field is not an answer; the selection still stands.
    expect(buildAnswer(interaction(), ["APA"], "   ")).toEqual([["APA"]])
  })

  it("collects a multi-part form one question at a time, in order", () => {
    const form = interaction({
      questions: [
        { header: "A", prompt: "first?", options: [{ label: "a1", description: "" }], multiple: false, custom: false },
        { header: "B", prompt: "second?", options: [{ label: "b1", description: "" }], multiple: false, custom: false },
      ],
    })
    const first = buildAnswer(form, ["a1"], null)
    // Incomplete: the pane advances rather than replying with half a form.
    expect(first).toEqual([["a1"]])
    expect(first.length).toBeLessThan(form.questions.length)
    expect(buildAnswer(form, ["b1"], null, first)).toEqual([["a1"], ["b1"]])
  })

  it("offers a custom row only when the question allows one", () => {
    expect(paneRows(interaction().questions[0]).map((row) => row.label)).toEqual(["APA", "MLA", "Chicago"])
    const custom = live({ questions: [{ ...interaction().questions[0]!, custom: true }] })
    expect(paneRows(custom.questions[0]).at(-1)).toEqual({
      label: CUSTOM_ROW_LABEL,
      description: "Answer in your own words",
      custom: true,
    })
  })

  it("counts the grace down, and says when it has run out", () => {
    expect(graceRemaining(interaction(), 1_000_000)).toBe("5m00s left")
    expect(graceRemaining(interaction(), 1_290_000)).toBe("10s left")
    expect(graceRemaining(interaction(), 1_400_000)).toBe("handing over to automation…")
    // A `ctx.ask` with no deadline, or a request nobody is racing: no countdown to show.
    expect(graceRemaining(interaction({ graceEndsAt: null }), 1_000_000)).toBe("")
    expect(graceRatio(interaction({ graceEndsAt: null }))).toBeNull()
    expect(graceRatio(interaction(), 1_150_000)).toBeCloseTo(0.5, 5)
  })
})

interface Harness {
  view: MountedView
  fake: FakeTuiApi
  sent: ControlAction[]
  setRuns: (runs: readonly RunSnapshot[]) => void
  press: (action: string) => Promise<void>
}

/**
 * Mount the whole route on the question level, rather than the pane alone.
 *
 * The pane has no keymap of its own — that is the design — so driving it standalone would prove nothing about
 * the keys. Entering through the route's own deep-link params is also the path the sidebar badge takes.
 */
async function mountPane(
  initial: readonly RunSnapshot[] = [run()],
  options: {
    themeOverrides?: Partial<Record<string, string>>
    width?: number
    /** Override the control result, for the case where a reply does NOT land. */
    control?: RunControlClient["send"]
  } = {},
): Promise<Harness> {
  const fake = createFakeTuiApi("/tmp/state", options.themeOverrides ?? {})
  const [runs, setRuns] = createSignal<readonly RunSnapshot[]>(initial)
  const sent: ControlAction[] = []
  const control: RunControlClient = {
    async send(action) {
      sent.push(action)
      return options.control ? options.control(action) : { ok: true }
    },
  }
  const view = await mountView(
    () => (
      <WorkflowRoute
        api={fake.api}
        runs={runs}
        control={control}
        params={{ runId: "run-1", requestID: "req-1" }}
      />
    ),
    { width: options.width ?? 100, height: 30 },
  )
  return {
    view,
    fake,
    sent,
    setRuns,
    async press(action) {
      fake.runCommand(commandName(action as never))
      await view.flush()
    },
  }
}

describe("answer pane render", () => {
  it("opens directly on the pane from a deep link, showing the question and its options", async () => {
    const { view } = await mountPane()
    try {
      const frame = view.text()
      expect(frame).toContain("Workflows")
      // The breadcrumb names the level, so the pane reads as somewhere you are rather than something that
      // happened to you.
      expect(frame).toContain("question")
      expect(frame).toContain("Citation style")
      expect(frame).toContain("Which citation style should the report use?")
      expect(frame).toContain("APA")
      // Each option explains itself: the host's shape carries a description, and a choice that explains itself
      // is the difference between an informed answer and a guess.
      expect(frame).toContain("American Psychological Association")
      expect(frame).toContain("Modern Language Association")
    } finally {
      view.unmount()
    }
  })

  it("names who is asking, and drains a meter wide enough to read as a clock", async () => {
    const { view } = await mountPane()
    try {
      const frame = view.text()
      expect(frame).toContain("a unit at depth 3")
      // The documented exception to `METER_WIDTH` 4: at four cells a countdown has five states and reads as
      // stalled, then jumpy. This is the one meter whose job is continuous drain, and the pane has the room.
      expect(frame).toMatch(/[▰▱]{20}/)
      expect(frame).toMatch(/\d+m\d+s left|\d+s left/)
      // …with real space around the meter, carried in the text rather than by a flex `gap`, and TWO cells on
      // each side: these glyphs are East-Asian ambiguous width, so a font can overhang the single space that
      // used to follow them and paint the countdown flush against the bar. See route.tsx's stat strip.
      expect(frame).toMatch(/[▰▱] {2}\d+m\d+s left|[▰▱] {2}\d+s left/)
      expect(frame).toMatch(/ {2}[▰▱]{20}/)
    } finally {
      view.unmount()
    }
  })

  it("shows no countdown at all when the question has no deadline — the default", async () => {
    const { view } = await mountPane([run({ interactions: [live({ graceEndsAt: null })] })])
    try {
      const frame = view.text()
      const header = frame.split("\n").find((line) => line.includes("❓ question")) ?? ""
      // A bar drawn where there is no deadline invents urgency the system does not have. (The run's own phase
      // meter is a different strip, one line up, and stays.)
      expect(header).not.toMatch(/[▰▱]/)
      expect(header).not.toContain("left")
      expect(frame).toContain("Which citation style should the report use?")
    } finally {
      view.unmount()
    }
  })

  it("separates every field in the header strip with real spaces", async () => {
    // The user's terminal rendered `⠦ running▰▰▰▱phase 2/3 choose▰▰▰▰1/1 units2m26s` and
    // `Workflows›asks-the-human›question`. Our harness could not reproduce it, so the fix removes the variable
    // entirely: no flex `gap` in these strips, the separators live in the text.
    const { view } = await mountPane()
    try {
      const frame = view.text()
      expect(frame).toContain("Workflows › deep-research › question")
      // Never doubled either: one source of separation means exactly one space's worth of it.
      expect(frame).not.toContain("Workflows  › ")
      expect(frame).toMatch(/❓ question {2}from a unit at depth 3/)
    } finally {
      view.unmount()
    }
  })

  it("says a script asked, when a script asked", async () => {
    const { view } = await mountPane([run({ interactions: [live({ origin: "script", depth: 1 })] })])
    try {
      expect(view.text()).toContain("the workflow script")
    } finally {
      view.unmount()
    }
  })

  it("answers on ⏎ with the label the cursor is on, and LEAVES", async () => {
    const { view, press, sent } = await mountPane()
    try {
      await press("down")
      await press("drill")
      expect(sent).toEqual([
        { action: "question.reply", runId: "run-1", requestID: "req-1", answers: [["MLA"]] },
      ])
      // The regression this exists for: a successful reply used to leave the user parked on the pane they had
      // just finished with, waiting for an unrelated event to arrive and evict them. Answering navigates.
      const frame = view.text()
      expect(frame).not.toContain("Which citation style should the report use?")
      expect(frame).toContain("deep-research")
      // …and the confirmation appears where the user now is.
      expect(frame).toContain("answered")
    } finally {
      view.unmount()
    }
  })

  it("stays put when the reply did not land, so the answer is not silently lost", async () => {
    const { view, press } = await mountPane([run()], { control: async () => ({ ok: false, reason: "unsupported" }) })
    try {
      await press("drill")
      // Navigating away on a failure would hide both the question and the fact that nothing happened to it.
      expect(view.text()).toContain("Which citation style should the report use?")
    } finally {
      view.unmount()
    }
  })

  it("clicks to select, and clicks again to answer — the same two steps the keyboard takes", async () => {
    const { view, sent } = await mountPane()
    try {
      const row = view.lineOf(/Chicago/)
      expect(row).toBeGreaterThan(-1)
      await view.click(4, row)
      await view.click(4, row)
      expect(sent).toEqual([
        { action: "question.reply", runId: "run-1", requestID: "req-1", answers: [["Chicago"]] },
      ])
    } finally {
      view.unmount()
    }
  })

  /**
   * The regression a test should have caught, and the one a real user hit.
   *
   * `back` is bound to `escape,left,h`. It used to send `question.reject` from the pane, so `esc` — the
   * universal "get me out of here" — silently handed a pending decision to automation. Navigation must never
   * dispose of a question.
   */
  it("leaves the pane on `esc` WITHOUT deciding anything", async () => {
    const { view, press, sent } = await mountPane()
    try {
      await press("back")
      expect(sent).toEqual([])
      const frame = view.text()
      expect(frame).not.toContain("Which citation style should the report use?")
      expect(frame).toContain("deep-research")
      // Still waiting: the row is on the run level where it was, and the question is still the user's.
      expect(frame).toContain("Question")
    } finally {
      view.unmount()
    }
  })

  it("hands the question to automation on `x` — the deliberate key", async () => {
    const { view, press, sent } = await mountPane()
    try {
      await press("stop")
      // NOT the host's `question.reject`: the person declining to answer is declining to be the one who
      // answers it, and the watcher's ladder may still ground it from the run's own context.
      expect(sent).toEqual([{ action: "question.reject", runId: "run-1", requestID: "req-1" }])
      expect(view.text()).not.toContain("Which citation style should the report use?")
    } finally {
      view.unmount()
    }
  })

  it("relabels the SAME footer keys rather than growing a second footer", async () => {
    const { view } = await mountPane()
    try {
      const frame = view.text()
      expect(frame).toContain("answer")
      expect(frame).toContain("leave for automation")
      // Same keys, same order — only the words change. `esc` keeps meaning `back` here, exactly as it does
      // everywhere else in the browser; `x` is what gives a question away.
      expect(footerHint(QUESTION_BINDINGS)).toContain("⏎ answer")
      expect(footerHint(QUESTION_BINDINGS)).toContain("esc back")
      expect(footerHint(QUESTION_BINDINGS)).toContain("x leave for automation")
      expect(QUESTION_BINDINGS.map((binding) => binding.key)).toEqual([
        "up,k",
        "down,j",
        "return,right,l",
        "escape,left,h",
        "f",
        // `w` rides along with `f`, for the same reason `f` is here at all: both address the LIST, and a
        // vocabulary that disappeared one level down would teach the user the tool changes under them.
        "w",
        "x",
        "r",
        "s",
        "q",
      ])
    } finally {
      view.unmount()
    }
  })

  /**
   * The regression that shipped: you could not type into the answer field.
   *
   * The route registered ONE keymap layer for the life of the screen, claiming `h j k l f x s q n` among
   * others. The host `preventDefault()`s any key its keymap matched and OpenTUI then skips the focused
   * renderable, so those letters never reached the input — `chicago` typed nothing but `ci`, and no test
   * noticed, because none of them ever opened the field and looked at what was still bound.
   *
   * So that is what this asserts: while the field is open, the layer claims only what the field cannot do for
   * itself. It is deliberately written against the KEYS rather than the layer's identity — the bug was never
   * about which module the bindings came from, it was about which letters were taken.
   */
  it("gives the answer field the keyboard: no letter stays bound while it is open", async () => {
    const custom = live({ questions: [{ ...interaction().questions[0]!, custom: true }] })
    const { view, press, fake } = await mountPane([run({ interactions: [custom] })])
    try {
      const bound = () => (fake.keymapLayers.at(-1)?.bindings ?? []).flatMap((b) => b.key.split(","))

      // Before: the browser's own vocabulary, every letter of it claimed.
      expect(bound()).toEqual(expect.arrayContaining(["h", "j", "k", "l", "f", "x", "s", "q", "n"]))

      for (let i = 0; i < 3; i++) await press("down")
      await press("drill")
      expect(view.text()).toContain("Your answer")

      // After: every letter a person might type is free. `chicago`, `flask` and `banjo` between them cover
      // every letter the full layer used to take, which is the point of naming them.
      const claimed = bound()
      for (const letter of [..."chicagoflaskbanjo"]) expect(claimed).not.toContain(letter)
      // Only the two the field genuinely cannot provide itself survive.
      expect(claimed.slice().sort()).toEqual(["escape", "return"])

      // And closing it hands the vocabulary straight back.
      await press("back")
      expect(bound()).toEqual(expect.arrayContaining(["h", "f", "x", "q"]))
    } finally {
      view.unmount()
    }
  })

  it("opens a free-text field on the custom row, and `esc` closes the field before leaving", async () => {
    const custom = live({ questions: [{ ...interaction().questions[0]!, custom: true }] })
    const { view, press, sent } = await mountPane([run({ interactions: [custom] })])
    try {
      expect(view.text()).toContain(CUSTOM_ROW_LABEL)
      for (let i = 0; i < 3; i++) await press("down")
      await press("drill")
      expect(view.text()).toContain("Your answer")
      // First `esc` closes the field; the question is still the user's.
      await press("back")
      expect(view.text()).not.toContain("Your answer")
      expect(sent).toEqual([])
      // The second leaves the pane — and still decides nothing.
      await press("back")
      expect(sent).toEqual([])
      expect(view.text()).not.toContain("Which citation style should the report use?")
    } finally {
      view.unmount()
    }
  })

  it("stays legible under a theme that collapses the tokens selection depends on", async () => {
    // `selectedListItemText` is cut to sit on the HOST's own selection fill; against ours it can land
    // invisible. Selection here changes the background and promotes the label to accent, and reuses the exact
    // foregrounds an unselected row uses — which cannot fail in any theme.
    const { view } = await mountPane([run()], {
      themeOverrides: {
        backgroundElement: "#101010",
        selectedListItemText: "#101010",
        text: "#eeeeee",
        accent: "#eeeeee",
      },
    })
    try {
      const frame = view.text()
      expect(frame).toContain("APA")
      expect(frame).toContain("American Psychological Association")
    } finally {
      view.unmount()
    }
  })

  it("renders a permission ask with the two replies it is allowed to offer", async () => {
    const permission = live({
      kind: "permission",
      questions: [
        {
          header: "Permission: bash",
          prompt: "Allow `bash` for bun test?",
          options: [
            { label: "once", description: "Allow this one request" },
            { label: "reject", description: "Refuse it; the unit sees a denial" },
          ],
          multiple: false,
          custom: false,
        },
      ],
    })
    const { view, press, sent } = await mountPane([run({ interactions: [permission] })])
    try {
      const frame = view.text()
      expect(frame).toContain("permission")
      expect(frame).toContain("Allow `bash` for bun test?")
      // `always` is never offered: replies stay `once`-scoped by standing decision.
      expect(frame).not.toContain("always")
      await press("drill")
      expect(sent).toEqual([
        { action: "permission.reply", runId: "run-1", requestID: "req-1", reply: "once" },
      ])
    } finally {
      view.unmount()
    }
  })

  it("mounts standalone without a router, for a view test that wants only the pane", async () => {
    const view = await mountView(
      () => (
        <InteractionPane
          interaction={() => interaction()}
          theme={fakeTheme()}
          now={() => 1_150_000}
          selected={() => 1}
          custom={() => null}
          index={() => 0}
          onSelect={() => {}}
          onCustomInput={() => {}}
          onAnswer={() => {}}
        />
      ),
      { width: 80, height: 20 },
    )
    try {
      expect(view.text()).toContain("Which citation style should the report use?")
      expect(view.text()).toContain("2m30s left")
    } finally {
      view.unmount()
    }
  })
})

/**
 * A question that accepts more than one answer.
 *
 * `multiple` shipped with Phase 4 and was read by NOTHING: the pane built `[row.label]` and sent exactly one
 * label whatever the question asked for, so a workflow that wanted a set got the row the cursor happened to be
 * on. Everything here is the difference between a declared field and an implemented one.
 */
describe("answer pane: choosing more than one", () => {
  function regions(overrides: Partial<PendingInteraction["questions"][number]> = {}) {
    return {
      header: "Regions",
      prompt: "Which regions should the report cover?",
      options: [
        { label: "EU", description: "European Union" },
        { label: "US", description: "United States" },
        { label: "APAC", description: "Asia-Pacific" },
      ],
      multiple: true,
      custom: false,
      ...overrides,
    }
  }
  const asking = (overrides: Partial<PendingInteraction["questions"][number]> = {}) =>
    run({ interactions: [live({ questions: [regions(overrides)] })] })

  it("gives every option a box of its own, and ticks the one under the cursor", async () => {
    const { view, press } = await mountPane([asking()], { width: 120 })
    try {
      // A BOX on every option before anything is chosen, so the shape of the marker says how many answers the
      // question wants before you try one. Squares are the multi-select convention — circles read as "pick one",
      // which is exactly the confusion this replaced.
      expect(view.text()).toMatch(/\[ \] EU/)
      expect(view.text()).toMatch(/\[ \] US/)

      await press("toggle")
      expect(view.text()).toMatch(/\[x\] EU/)
      expect(view.text()).toMatch(/\[ \] US/)

      await press("down")
      await press("toggle")
      expect(view.text()).toMatch(/\[x\] EU/)
      expect(view.text()).toMatch(/\[x\] US/)

      // And back off again — the same key, because a set you cannot correct is worse than a single choice.
      await press("toggle")
      expect(view.text()).toMatch(/\[ \] US/)
    } finally {
      view.unmount()
    }
  })

  it("submits everything ticked, in one reply", async () => {
    const { view, press, sent } = await mountPane([asking()], { width: 120 })
    try {
      await press("toggle")
      await press("down")
      await press("down")
      await press("toggle")
      await press("drill")
      expect(sent).toEqual([
        { action: "question.reply", runId: "run-1", requestID: "req-1", answers: [["EU", "APAC"]] },
      ])
      // Answering still leaves, exactly as it does for one label.
      expect(view.text()).not.toContain("Which regions should the report cover?")
    } finally {
      view.unmount()
    }
  })

  it("refuses an empty set rather than answering with whatever the cursor was on", async () => {
    const { view, press, sent } = await mountPane([asking()], { width: 120 })
    try {
      await press("drill")
      // The cursor is on `EU`, and sending it would be answering on the user's behalf: they ticked nothing, and
      // "nothing" is not one of the answers on offer.
      expect(sent).toEqual([])
      expect(view.text()).toContain("choose at least one option")
      expect(view.text()).toContain("Which regions should the report cover?")

      // …and it is a refusal, not a dead end.
      await press("toggle")
      await press("drill")
      expect(sent).toEqual([
        { action: "question.reply", runId: "run-1", requestID: "req-1", answers: [["EU"]] },
      ])
    } finally {
      view.unmount()
    }
  })

  it("offers the key only where it means something, and says what ⏎ will do", async () => {
    const multi = await mountPane([asking()], { width: 120 })
    try {
      const frame = multi.view.text()
      expect(frame).toContain("space toggle")
      // ⏎ stops meaning "answer with this row" the moment a set is what it sends.
      expect(frame).toContain("⏎ submit")
    } finally {
      multi.view.unmount()
    }

    // A single-choice question is untouched: no boxes to tick, no key offered, and ⏎ still answers.
    const single = await mountPane([run()], { width: 120 })
    try {
      const frame = single.view.text()
      expect(frame).not.toContain("space toggle")
      expect(frame).toContain("⏎ answer")
      expect(frame).not.toMatch(/\[[x ]\] APA/)
    } finally {
      single.view.unmount()
    }

    expect(questionBindings({ multiple: true }).map((binding) => binding.key)).toContain("space")
    expect(questionBindings({ multiple: false }).map((binding) => binding.key)).not.toContain("space")
    expect(QUESTION_BINDINGS.map((binding) => binding.key)).not.toContain("space")
  })

  it("keeps a half-built set when the user walks out and comes back", async () => {
    const { view, press } = await mountPane([asking()], { width: 120 })
    try {
      await press("toggle")
      await press("down")
      await press("toggle")
      expect(view.text()).toMatch(/\[x\] US/)

      // Out to the run — to check on the unit that asked, say — and back in through its row.
      await press("back")
      expect(view.text()).not.toContain("Which regions should the report cover?")
      await press("drill")

      const frame = view.text()
      expect(frame).toMatch(/\[x\] EU/)
      expect(frame).toMatch(/\[x\] US/)
      expect(frame).toMatch(/\[ \] APAC/)
    } finally {
      view.unmount()
    }
  })

  it("leaves the ticks alone while the free-text field is open", async () => {
    // The one collision worth guarding: `space` is a character before it is a command. The binding does not
    // consume the keystroke — that is what lets a space reach the field at all — so this is what stops the same
    // press ALSO ticking a row, which a mouse can leave highlighted underneath an open field.
    const { view, press, sent } = await mountPane([asking({ custom: true })], { width: 120 })
    try {
      await press("toggle")
      expect(view.text()).toMatch(/\[x\] EU/)

      for (let i = 0; i < 3; i++) await press("down")
      await press("drill")
      expect(view.text()).toContain("Your answer")

      // A click puts the cursor back on an option without closing the field.
      const row = view.lineOf(/\[x\] EU/)
      expect(row).toBeGreaterThan(-1)
      await view.click(4, row)
      await press("toggle")
      expect(view.text()).toMatch(/\[x\] EU/)
      expect(view.text()).toContain("Your answer")
      expect(sent).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it("answers a form that mixes the two, one question at a time and in order", async () => {
    const form = live({
      questions: [
        {
          header: "Depth",
          prompt: "How deep should this go?",
          options: [
            { label: "fast", description: "One unit per area" },
            { label: "thorough", description: "Two units per area" },
          ],
          multiple: false,
          custom: false,
        },
        regions(),
      ],
    })
    const { view, press, sent } = await mountPane([run({ interactions: [form] })], { width: 120 })
    try {
      // Question one is single-choice: no boxes, no toggle key, ⏎ answers with the cursor.
      expect(view.text()).toContain("How deep should this go?")
      expect(view.text()).not.toContain("space toggle")
      expect(view.text()).toContain("1/2")
      await press("down")
      await press("drill")
      expect(sent).toEqual([]) // an unfinished form advances rather than replying with half of one

      // Question two is not, and the footer changes with it.
      expect(view.text()).toContain("Which regions should the report cover?")
      expect(view.text()).toContain("space toggle")
      expect(view.text()).toContain("2/2")
      await press("toggle")
      await press("down")
      await press("toggle")
      await press("drill")

      // One entry per question, in ask order — a single label for the first, a set for the second.
      expect(sent).toEqual([
        {
          action: "question.reply",
          runId: "run-1",
          requestID: "req-1",
          answers: [["thorough"], ["EU", "US"]],
        },
      ])
    } finally {
      view.unmount()
    }
  })
})

/**
 * The record, once nobody is waiting on it.
 *
 * *"the answers are not navigable once answered"*, and *"the run surface should show any questions asked and
 * what was the options and the answers"*. A resolved interaction used to disappear from every surface at once,
 * so the record of a decision a person made mid-run lasted exactly as long as the frame it was on.
 */
describe("answer pane: reading back what was answered", () => {
  function answered(overrides: Partial<ResolvedInteraction> = {}): ResolvedInteraction {
    const { graceEndsAt: _grace, ...record } = interaction()
    return { ...record, answers: [["MLA"]], by: "human", resolvedAt: Date.now(), ...overrides }
  }

  it("shows the question, every option it offered, and the one that was chosen", async () => {
    const { view } = await mountPane([run({ interactions: [], resolved: [answered()] })])
    try {
      const frame = view.text()
      expect(frame).toContain("Which citation style should the report use?")
      // Every option, not just the answer: `["MLA"]` on its own is meaningless without the set it came from.
      expect(frame).toContain("APA")
      expect(frame).toContain("Chicago")
      // A RADIO marks the one that was taken, because this question only ever admitted one. The record reads
      // back in the same vocabulary the question was asked in — a multi-select record uses boxes.
      expect(frame).toMatch(/\(•\) MLA/)
      expect(frame).toMatch(/\( \) APA/)
      expect(frame).toContain("question (answered)")
      expect(frame).toContain("You answered this.")
      // Read-only: no countdown, because there is nothing left to run out.
      expect(frame).not.toContain("left")
    } finally {
      view.unmount()
    }
  })

  it("refuses to re-answer a question that is already settled", async () => {
    const { view, press, sent } = await mountPane([run({ interactions: [], resolved: [answered()] })])
    try {
      await press("drill")
      expect(sent).toEqual([])
      expect(view.text()).toContain("this question was already answered")
      await press("stop")
      expect(sent).toEqual([])
    } finally {
      view.unmount()
    }
  })

  it("shows a free-text answer, which is not among the options by construction", async () => {
    const { view } = await mountPane([
      run({ interactions: [], resolved: [answered({ answers: [["Vancouver"]] })] }),
    ])
    try {
      const frame = view.text()
      expect(frame).toContain("Vancouver")
      expect(frame).toContain("Your answer")
    } finally {
      view.unmount()
    }
  })

  it("says so when the answer was never observed, rather than showing a choice nobody made", async () => {
    const { view } = await mountPane([
      run({ interactions: [], resolved: [answered({ by: "automation", answers: [] })] }),
    ])
    try {
      const frame = view.text()
      // The one remaining case where nothing is known: a person answered it in the host's own dialog and this
      // process only saw it leave the pending list. Deliberately NOT the words used for a refusal.
      expect(frame).toContain("Settled elsewhere; this run never saw the answer.")
      expect(frame).not.toMatch(/● /)
    } finally {
      view.unmount()
    }
  })

  /**
   * The record of an AUTOMATED answer reads exactly like a human one — which is the whole fix.
   *
   * The watcher's ladder replies to the host with option labels and, until now, dropped them on the way to the
   * store: every question automation settled was filed `answers: []` and read "answer not recorded". A reader
   * could see that a machine had decided and never what it decided.
   */
  it("shows what automation chose, in the same vocabulary a human answer uses", async () => {
    const { view } = await mountPane([
      run({
        interactions: [],
        resolved: [answered({ by: "automation", answers: [["Chicago"]], outcome: "answered" })],
      }),
    ])
    try {
      const frame = view.text()
      expect(frame).toMatch(/\(•\) Chicago/)
      expect(frame).toMatch(/\( \) MLA/)
      expect(frame).toContain("Automation answered this")
      expect(frame).not.toContain("never saw the answer")
    } finally {
      view.unmount()
    }
  })

  it("calls a refusal a refusal — it is not an answer, and not an unobserved one either", async () => {
    const { view } = await mountPane([
      run({ interactions: [], resolved: [answered({ by: "automation", answers: [], outcome: "rejected" })] }),
    ])
    try {
      const frame = view.text()
      expect(frame).toContain("Automation declined this — the asker was refused.")
      // Nothing was chosen, so nothing is marked as taken.
      expect(frame).toMatch(/\( \) MLA/)
      expect(frame).not.toMatch(/\(•\)/)
    } finally {
      view.unmount()
    }
  })

  it("is reachable from the run level, as a row, after the question is gone", async () => {
    const settled = run({
      interactions: [],
      resolved: [answered({ unitId: null, origin: "script", depth: 1, phase: "gather" })],
    })
    const { view, press } = await mountPane([settled])
    try {
      // Walk out to the run, then back in through the row — the path a user takes when they wonder what they
      // said ten minutes ago.
      await press("back")
      expect(view.text()).toContain("Answered")
      expect(view.text()).toContain("MLA")
      await press("down")
      await press("drill")
      expect(view.text()).toContain("Which citation style should the report use?")
    } finally {
      view.unmount()
    }
  })
})

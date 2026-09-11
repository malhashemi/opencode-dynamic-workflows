/**
 * LIVE — the sidebar as the user actually sees it, asserted from rendered frames.
 *
 * `packages/plugin/test/tui/sidebar.test.ts` proves the row MODEL. It cannot prove that OpenTUI lays two
 * lines out the way the design says, that 42 sidebar columns fit a real workflow name beside its counts, that
 * the accent and muted tokens land on the right runs of text, or that a finished run leaves the strip. Those
 * are facts about pixels, and they need a terminal.
 *
 * So this probe runs the REAL `opencode` binary inside tmux at a fixed 140×40, drives the fixture with a real
 * model, and reads the screen back as text (`tmux capture-pane`) and as SGR sequences (`capture-pane -e`).
 *
 *     bun run verify:live
 *
 * The frames are captured ONCE, while the run is live, and every assertion below reads those captures. A run
 * lasts seconds; assertions that each re-capture would race the run's completion and flake by construction.
 * Frames land in `test/live/.artifacts/` for post-mortem — including on failure.
 *
 * Costs real tokens: one parent prompt plus one child session.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createScratchProject, type ScratchProject } from "./lib/scratch-project"
import {
  ARTIFACTS_DIR,
  fgTokensOn,
  startTui,
  stripAnsi,
  tmuxAvailable,
  type TuiSession,
} from "./lib/tui-harness"

const BOOT_TIMEOUT_MS = 180_000
const RUN_TIMEOUT_MS = 300_000

// Both patterns are matched against WHOLE frames as well as single lines, so anything anchored carries the
// `m` flag — a bare `$` anchors to the end of the entire frame and can never match a line in the middle.
/** Line 1, whatever the glyph: `⠹ phase-gate            0/1 · 4s` — name, then counts and elapsed. */
const RUN_LINE = /phase-gate\s+\d+\/\d+ · \d+[hms]/m
/** Line 2, live only: `  phase 1/2 · dispatch`. */
const DETAIL_LINE = /phase \d+\/2 · (dispatch|finish)\s*$/m
/** Line 1 once the run has settled successfully — the spinner has become an outcome glyph. */
const SETTLED_LINE = /✓ phase-gate\s+\d+\/\d+ · \d+[hms]/m
/** The dashboard's address, muted, under the heading — present from host start, runs or no runs. */
const URL_LINE = /⌂ http:\/\/127\.0\.0\.1:\d+/m

/**
 * The rightmost sidebar column, isolated from the session transcript sharing the same rows.
 *
 * Anchoring on the `Workflows` heading's own column is more robust than assuming a width: the host sizes the
 * sidebar itself, and this probe should assert our layout, not re-derive the host's.
 */
function sidebarLines(frame: string): string[] {
  const lines = frame.split("\n")
  const heading = lines.find((line) => /\bWorkflows\b/.test(stripAnsi(line)))
  if (!heading) return []
  const column = stripAnsi(heading).indexOf("Workflows")
  return lines.map((line) => stripAnsi(line).slice(column).trimEnd())
}

interface Frames {
  /** The first frame the `⌂` address line rendered in — captured on its own wait, ahead of the run frames. */
  withUrl: string
  /** The asserted frame, plain. */
  phased: string
  /** The SAME frame with SGR sequences intact — one capture, so colors and layout describe one instant. */
  phasedAnsi: string
  /** After the run reaches a terminal state — the row persists, carrying its outcome. */
  settled: string
}

/** Persist the exact frame that was asserted, rather than a later re-capture of a different instant. */
async function saveFrame(label: string, plain: string, ansi: string): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`
  await Promise.all([
    writeFile(path.join(ARTIFACTS_DIR, `${stem}.txt`), plain, "utf8"),
    writeFile(path.join(ARTIFACTS_DIR, `${stem}.ansi.txt`), ansi, "utf8"),
  ])
}

if (!tmuxAvailable()) {
  console.warn("[sidebar.tui.live] tmux not found on PATH — skipping the rendered-frame probe.")
}

const describeTui = tmuxAvailable() ? describe : describe.skip

describeTui("live: workflow sidebar rendered in a real TUI", () => {
  let scratch: ScratchProject
  let tui: TuiSession
  let frames: Frames

  beforeAll(async () => {
    scratch = await createScratchProject({ fixtures: ["phase-gate.workflow.ts"] })
    // 140 columns is deliberate: the host auto-opens the session sidebar only above 120, so no toggle
    // keystroke is needed and the probe never depends on a keybinding that could be remapped.
    //
    // `hostEnv` is what makes that true. The auto-open is gated on a PERSISTED preference (`sidebar` in the
    // state dir's `kv.json`), so on a developer machine where the sidebar was ever hidden, a 140-column
    // terminal still shows nothing. The isolated state dir restores the product's defaults.
    tui = await startTui({
      cwd: scratch.root,
      cols: 140,
      rows: 40,
      env: scratch.hostEnv,
      bootTimeoutMs: BOOT_TIMEOUT_MS,
    })
    await tui.snapshot("00-home")

    await tui.submitPrompt(
      'Call the workflow tool exactly once with {"name": "phase-gate", "args": {}} and then stop.',
    )

    // The `⌂` line appears as soon as the SESSION view's sidebar mounts and the 2-second descriptor rescan
    // lands — the block no longer waits for a run. It cannot be asserted on the boot screen: the host's home
    // view renders no session sidebar at all (learned from a timed-out first run of this probe), so "before
    // any run exists" is proven by the mounted zero-runs view test; here the claim is that the line is up and
    // correct on a real host. A real wait on the rendered line itself, per the wait-pattern rule.
    const withUrl = await tui.waitFor(URL_LINE, { timeoutMs: 120_000, intervalMs: 250 })
    await saveFrame("10-sidebar-url", withUrl, withUrl)

    // ONE capture, in ANSI, polled tightly. The fixture's run lasts a handful of seconds; taking a second
    // capture for the colors would describe a different instant — often one where the run has already gone.
    const phasedAnsi = await tui.waitFor(DETAIL_LINE, {
      ansi: true,
      timeoutMs: RUN_TIMEOUT_MS,
      intervalMs: 200,
    })
    const phased = stripAnsi(phasedAnsi)
    await saveFrame("20-sidebar-phase", phased, phasedAnsi)

    const settled = await tui.waitFor(SETTLED_LINE, { timeoutMs: RUN_TIMEOUT_MS, intervalMs: 200 })
    await saveFrame("30-sidebar-settled", stripAnsi(settled), settled)

    frames = { withUrl: stripAnsi(withUrl), phased, phasedAnsi, settled: stripAnsi(settled) }
  }, BOOT_TIMEOUT_MS + RUN_TIMEOUT_MS)

  // Teardown gets a budget of its own — see `route.tui.live.ts` for why five seconds is not one.
  afterAll(async () => {
    await tui?.kill()
    await scratch?.cleanup()
  }, 60_000)

  it("names the dashboard server: the muted `⌂` address line sits directly under the heading", () => {
    // Captured on its own wait, independent of any run row rendering — the endpoint being live is what earns
    // the block now. ("Before any run exists" is the mounted zero-runs view test's claim; a live host races
    // the model, so this frame may or may not already carry a run row.)
    const lines = sidebarLines(frames.withUrl)
    const heading = lines.findIndex((line) => /^Workflows/.test(line))
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(lines[heading + 1]).toMatch(URL_LINE)
    // Bare address — no `?token=` in what a user would retype from their sidebar.
    expect(frames.withUrl).not.toContain("token=")
  })

  it("renders the run as two lines under the heading, below the address line", () => {
    const lines = sidebarLines(frames.phased)
    expect(lines.length).toBeGreaterThan(0)

    const heading = lines.findIndex((line) => /^Workflows/.test(line))
    expect(heading).toBeGreaterThanOrEqual(0)
    expect(lines[heading + 1]).toMatch(URL_LINE)
    expect(lines[heading + 2]).toMatch(RUN_LINE)
    expect(lines[heading + 3]).toMatch(DETAIL_LINE)
  })

  it("fits a real workflow name beside its counts without truncating at sidebar width", () => {
    const lines = sidebarLines(frames.phased)
    const runLine = lines.find((line) => RUN_LINE.test(line)) as string
    const detailLine = lines.find((line) => DETAIL_LINE.test(line)) as string

    expect(runLine).toContain("phase-gate")
    for (const line of [runLine, detailLine]) {
      expect(line).not.toContain("…")
      expect(line).not.toContain("...")
      // The whole reason the row is two lines rather than one: ~38 usable columns.
      expect(line.length).toBeLessThanOrEqual(42)
    }
  })

  it("colors the workflow name with the accent token and everything secondary with the muted token", () => {
    const nameTokens = fgTokensOn(frames.phasedAnsi, RUN_LINE)
    const detailTokens = fgTokensOn(frames.phasedAnsi, DETAIL_LINE)

    expect(nameTokens.length).toBeGreaterThan(0)
    expect(detailTokens.length).toBeGreaterThan(0)
    // Two distinct tokens, not one. Asserting exact hex would bind the probe to whichever theme the developer
    // happens to be running; asserting the CONTRAST is the design claim.
    expect(nameTokens[0]).not.toBe(detailTokens[0])
    // Line 1 carries both: accent on the name, muted on the counts and elapsed.
    expect(nameTokens).toContain(detailTokens[0] as string)
  })

  it("shows a phase position from the fixture's declared phases", () => {
    const lines = sidebarLines(frames.phased)
    const detailLine = lines.find((line) => DETAIL_LINE.test(line)) as string
    expect(detailLine).toMatch(/phase [12]\/2 · (dispatch|finish)/)
  })

  it("keeps the run after it settles, swapping the spinner for an outcome glyph", () => {
    // The strip used to drop a run the instant it ended. A workflow that finishes in seconds then vanishes
    // never tells the user whether it succeeded — and one that FAILED vanished exactly as quietly.
    const lines = sidebarLines(frames.settled)
    const settledLine = lines.find((line) => SETTLED_LINE.test(line))
    expect(settledLine).toBeDefined()
    expect(settledLine).toContain("phase-gate")
    // Every unit accounted for by the time the glyph turns.
    expect(settledLine).toMatch(/1\/1/)
  })

  it("drops the phase line once settled — the outcome is the news, not the phase it ended on", () => {
    const lines = sidebarLines(frames.settled)
    expect(lines.some((line) => DETAIL_LINE.test(line))).toBe(false)
  })

  it("orders the section after LSP and before todos when those sections are present", () => {
    // Built-in sidebar orders: context 100, MCP 200, LSP 300, workflow 350, todo 400, files 500. A scratch
    // project legitimately has no LSP server and no todos, so this asserts ordering only over sections that
    // actually rendered rather than manufacturing content to force them into existence.
    const lines = frames.phased.split("\n").map(stripAnsi)
    const indexOf = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line))

    const workflows = indexOf(/\bWorkflows\b/)
    const lsp = indexOf(/\bLSP\b/)
    const todo = indexOf(/\bTodos?\b/)

    expect(workflows).toBeGreaterThanOrEqual(0)
    if (lsp >= 0) expect(workflows).toBeGreaterThan(lsp)
    if (todo >= 0) expect(workflows).toBeLessThan(todo)
    if (lsp < 0 && todo < 0) {
      console.warn("[sidebar.tui.live] neither LSP nor Todos rendered in the scratch project — order 350 " +
        "placement is asserted by packages/plugin/test/tui/sidebar.test.ts instead")
    }
  })
})

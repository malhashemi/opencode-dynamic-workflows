/**
 * LIVE — the run browser, driven by keystrokes in a real terminal.
 *
 * `route-model.test.ts` proves the navigation and `route.test.tsx` proves the render. Neither can prove the
 * two things a route only has on a real host: that the keymap layer actually receives keys (a mode scoped
 * wrong, or a binding the host never compiles, fails silently and identically to a working one), and that
 * pressing `x` travels all the way from a keystroke to an aborted child session and back into every surface.
 *
 * So this drives the real `opencode` binary inside tmux at 140×40, opens the browser through the command
 * palette, walks the drill stack with `Enter`/`Escape`, stops a live run, and reads the outcome back three
 * ways: from the route's own frame, from the sidebar strip, and from the engine's `/state`.
 *
 *     OPENCODE_LIVE_MODEL=<provider/model> bun run verify:live
 *
 * Frames are captured as the drive proceeds — not re-captured per assertion — because a run is a moving
 * target and a second capture describes a different instant. They land in `test/live/.artifacts/`.
 *
 * Costs real tokens: one parent prompt, one child session, and one short follow-up prompt.
 *
 * ── Two deliberate deviations from the plan's sketch ─────────────────────────────────────────────────────
 * 1. The browser is opened from the COMMAND PALETTE rather than by clicking a sidebar row. tmux injects
 *    keystrokes, not mouse events; the click affordance is proven instead by a real mouse click in
 *    `test/tui/sidebar-view.test.tsx`, mounted through the host's own slot registry.
 * 2. `stop.unit` is not exercised here. Its window is a unit that is genuinely in flight, whose length is a
 *    property of whichever model is pinned that day — so the deterministic end-to-end coverage lives in
 *    `test/control.test.ts`, which stops a real in-flight unit against a client that never answers.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { EndpointDescriptor } from "../../src/discovery"
import type { RunSnapshot } from "../../src/runs"
import { createScratchProject, waitForLiveDescriptor, type ScratchProject } from "./lib/scratch-project"
import { ARTIFACTS_DIR, startTui, stripAnsi, tmuxAvailable, type TuiSession } from "./lib/tui-harness"

const WORKFLOW_KEY = "long-run"
const BOOT_TIMEOUT_MS = 180_000
const RUN_TIMEOUT_MS = 300_000

/**
 * The three levels, each identified by its breadcrumb line.
 *
 * Written to be MUTUALLY EXCLUSIVE, which matters more than it looks: a loose `/Workflows ▸ long-run/` also
 * matches the unit level's longer breadcrumb, so a `waitFor` after pressing Escape would pass without the
 * Escape having done anything — and the probe would then fail three keystrokes later, blaming the wrong key.
 * The breadcrumb and the filter indicator share one flex row, so anchoring on `filter:` pins the level exactly.
 */
const LIST_LEVEL = /Workflows\s+filter:/
const RUN_LEVEL = /Workflows ▸ long-run\s+filter:/
const UNIT_LEVEL = /Workflows ▸ long-run ▸ #1 slow unit\s+filter:/
/** The route's footer — the least ambiguous "the browser is on screen" marker there is. */
const ROUTE_FOOTER = /↑↓ select · ⏎ open/
/** The sidebar's settled row for a stopped run: the spinner has become the aborted glyph. */
const SIDEBAR_ABORTED = /⊘ long-run/

interface Frames {
  list: string
  run: string
  unit: string
  filteredDone: string
  narrow: string
  stopped: string
  sidebar: string
  promptBack: string
}

async function saveFrame(label: string, plain: string): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`
  await writeFile(path.join(ARTIFACTS_DIR, `${stem}.txt`), plain, "utf8")
}

/**
 * Send one key and give the host time to consume it before the next arrives.
 *
 * Not politeness. A bare `Escape` is one byte of an escape sequence, and two of them sent back to back inside
 * the parser's disambiguation window are read as ALT-modified keys rather than as two Escapes — so a rapid
 * `Escape Escape f` navigates nowhere and swallows the `f`. Found exactly that way.
 */
async function press(tui: TuiSession, key: string): Promise<void> {
  await tui.send(key)
  await Bun.sleep(350)
}

async function readState(descriptor: EndpointDescriptor): Promise<{ runs: RunSnapshot[]; revision: number }> {
  const response = await fetch(`${descriptor.url}/state`, {
    headers: { authorization: `Bearer ${descriptor.token}` },
  })
  return (await response.json()) as { runs: RunSnapshot[]; revision: number }
}

async function waitForRun(
  descriptor: EndpointDescriptor,
  predicate: (run: RunSnapshot) => boolean,
  timeoutMs: number,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs
  let seen: RunSnapshot[] = []
  while (Date.now() < deadline) {
    seen = (await readState(descriptor)).runs
    const run = seen.find((candidate) => candidate.workflow === WORKFLOW_KEY && predicate(candidate))
    if (run) return run
    await Bun.sleep(500)
  }
  throw new Error(
    `no \`${WORKFLOW_KEY}\` run matched within ${timeoutMs}ms.\n  /state runs: ${JSON.stringify(seen)}\n` +
      "An empty list means the model never called the tool — the prompt is an instruction, not a forced call.",
  )
}

/**
 * Open the run browser through the command palette.
 *
 * The palette (rather than the `/workflow-runs` slash entry) because it is a dialog with its own filter
 * input: typing there cannot be mistaken for typing a message, so a palette that failed to open shows up as a
 * missing command title rather than as a stray prompt submission.
 */
async function openRunBrowser(tui: TuiSession): Promise<void> {
  await press(tui, "C-p")
  await Bun.sleep(400)
  await tui.type("browse runs")
  await tui.waitFor(/Workflows: browse runs/, { timeoutMs: 20_000, intervalMs: 200 })
  await press(tui, "Enter")
  await tui.waitFor(ROUTE_FOOTER, { timeoutMs: 20_000, intervalMs: 200 })
}

/** A throwaway `opencode serve`, used only as an SDK to read persisted sessions back. */
async function startServe(cwd: string, overrides: Record<string, string>): Promise<{ url: string; stop: () => void }> {
  const port = 41_000 + Math.floor(Math.random() * 20_000)
  const env = { ...process.env, ...overrides }
  delete env.OPENCODE_PURE
  const proc = Bun.spawn(["opencode", "serve", "--port", String(port)], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/app`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return { url, stop: () => proc.kill() }
    } catch {
      // not listening yet
    }
    await Bun.sleep(500)
  }
  proc.kill()
  throw new Error(`opencode serve did not start listening on ${url} within ${BOOT_TIMEOUT_MS}ms`)
}

if (!tmuxAvailable()) {
  console.warn("[route.tui.live] tmux not found on PATH — skipping the keystroke-driven route probe.")
}

const describeTui = tmuxAvailable() ? describe : describe.skip

describeTui("live: workflow run browser driven by keystrokes", () => {
  let scratch: ScratchProject
  let tui: TuiSession
  let descriptor: EndpointDescriptor
  let frames: Frames
  let liveRun: RunSnapshot
  let stoppedRun: RunSnapshot
  let serve: { url: string; stop: () => void } | null = null

  beforeAll(async () => {
    scratch = await createScratchProject({ fixtures: ["long-run.workflow.ts"] })
    tui = await startTui({
      cwd: scratch.root,
      cols: 140,
      rows: 40,
      env: scratch.hostEnv,
      bootTimeoutMs: BOOT_TIMEOUT_MS,
    })
    await tui.snapshot("00-route-home")

    await tui.submitPrompt(
      `Call the workflow tool exactly once with {"name": "${WORKFLOW_KEY}", "args": {}} and then stop.`,
    )

    descriptor = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
    // The fixture holds itself open, so from here the run is a stable target rather than a race.
    liveRun = await waitForRun(
      descriptor,
      (run) => run.status === "running" && run.units.some((unit) => unit.status === "ok"),
      RUN_TIMEOUT_MS,
    )

    await openRunBrowser(tui)
    const list = stripAnsi(await tui.waitFor(LIST_LEVEL, { timeoutMs: 20_000, intervalMs: 200 }))
    await saveFrame("10-route-list", list)

    await press(tui, "Enter")
    const run = stripAnsi(await tui.waitFor(RUN_LEVEL, { timeoutMs: 20_000, intervalMs: 200 }))
    await saveFrame("20-route-run", run)

    // Row 0 is the `work` phase header; the unit is nested directly beneath it.
    await press(tui, "Down")
    await press(tui, "Enter")
    const unit = stripAnsi(await tui.waitFor(UNIT_LEVEL, { timeoutMs: 20_000, intervalMs: 200 }))
    await saveFrame("30-route-unit", unit)

    await press(tui, "Escape")
    await tui.waitFor(RUN_LEVEL, { timeoutMs: 20_000, intervalMs: 200 })
    await press(tui, "Escape")
    await tui.waitFor(LIST_LEVEL, { timeoutMs: 20_000, intervalMs: 200 })

    // `all` → `active` → `done`: the second press is the one that must drop a running run out of the list.
    await press(tui, "f")
    await tui.waitFor(/filter: active/, { timeoutMs: 10_000, intervalMs: 200 })
    await press(tui, "f")
    const filteredDone = stripAnsi(await tui.waitFor(/filter: done/, { timeoutMs: 10_000, intervalMs: 200 }))
    await saveFrame("40-route-filter-done", filteredDone)
    await press(tui, "f")
    await tui.waitFor(/filter: failed/, { timeoutMs: 10_000, intervalMs: 200 })
    await press(tui, "f")
    await tui.waitFor(/filter: all/, { timeoutMs: 10_000, intervalMs: 200 })

    await tui.resize(80, 40)
    const narrow = stripAnsi(await tui.waitFor(ROUTE_FOOTER, { timeoutMs: 20_000, intervalMs: 200 }))
    await saveFrame("50-route-narrow-80", narrow)
    await tui.resize(140, 40)
    await tui.waitFor(ROUTE_FOOTER, { timeoutMs: 20_000, intervalMs: 200 })

    // The control leg. `x` on the list level targets the selected run.
    await press(tui, "x")
    const stopped = stripAnsi(await tui.waitFor(/aborted ·/, { timeoutMs: 60_000, intervalMs: 200 }))
    await saveFrame("60-route-stopped", stopped)
    stoppedRun = await waitForRun(descriptor, (run) => run.status !== "running", 60_000)

    // Leave the route the way a user would, and confirm the terminal is a terminal again.
    await press(tui, "q")
    const sidebar = stripAnsi(await tui.waitFor(SIDEBAR_ABORTED, { timeoutMs: 60_000, intervalMs: 200 }))
    await saveFrame("70-sidebar-stopped", sidebar)

    // A route that pushed a keymap mode and never popped it leaves the session prompt permanently deaf. The
    // only honest check is to type into it — and typing is a sharper probe than submitting, because the
    // route's own bindings would eat these very characters (`k` is `up`, `f` is `filter`, `x` is `stop`), so
    // an echoed string is proof the mode came off rather than proof a model answered.
    await Bun.sleep(1_000)
    await tui.type("route-probe-prompt-ok")
    const promptBack = stripAnsi(
      await tui.waitFor(/route-probe-prompt-ok/, { timeoutMs: 30_000, intervalMs: 200 }),
    )
    await saveFrame("80-prompt-after-route", promptBack)
    await tui.send("C-u")

    frames = { list, run, unit, filteredDone, narrow, stopped, sidebar, promptBack }

    // The TUI runs no HTTP listener, so the SDK check below needs a host of its own — started only after the
    // TUI is gone, so one project never has two endpoint descriptors in flight. Sessions live in the shared
    // data directory, so this host sees exactly what the previous one wrote.
    await tui.kill()
    serve = await startServe(scratch.root, scratch.hostEnv)
  }, BOOT_TIMEOUT_MS + RUN_TIMEOUT_MS)

  afterAll(async () => {
    serve?.stop()
    await tui?.kill()
    await scratch?.cleanup()
  })

  it("opens from the command palette onto the run list", () => {
    expect(frames.list).toMatch(ROUTE_FOOTER)
    expect(frames.list).toMatch(LIST_LEVEL)
    expect(frames.list).toContain("filter: all")
    expect(frames.list).toContain(WORKFLOW_KEY)
    // The keys that Phases 3 and 6 will wire are visible now, marked as not yet working.
    expect(frames.list).toContain("(r restart)")
    expect(frames.list).toContain("(s save)")
  })

  it("drills list → run → unit under Enter, naming each level in the breadcrumb", () => {
    expect(frames.run).toMatch(RUN_LEVEL)
    expect(frames.run).toMatch(/running · phase \d\/2 \w+ · 1\/1 units/)
    expect(frames.run).toContain("Phase 1/2  work")
    expect(frames.run).toContain("#1 general")

    expect(frames.unit).toMatch(UNIT_LEVEL)
    expect(frames.unit).toContain("Prompt")
  })

  it("shows the unit's real child session — the same id the engine recorded", () => {
    const sessionID = liveRun.units[0]?.sessionID
    expect(sessionID).toBeTruthy()
    expect(frames.unit).toContain(sessionID as string)
  })

  it("resolves that session through the SDK, parented to the run's own session", async () => {
    const sessionID = liveRun.units[0]?.sessionID as string
    const client = createOpencodeClient({ baseUrl: (serve as { url: string }).url })
    const session = await client.session.get({ sessionID, directory: scratch.root })
    expect(session.data?.id).toBe(sessionID)
    // The ancestry the watcher walks to decide which interactions belong to this run.
    expect(session.data?.parentID).toBe(liveRun.parentSessionID)
  }, 120_000)

  it("filters the list, dropping a running run under `done`", () => {
    expect(frames.filteredDone).toContain("filter: done")
    expect(frames.filteredDone).not.toContain(WORKFLOW_KEY)
    expect(frames.filteredDone).toContain("No workflow runs to show")
  })

  it("still renders every row without wrapping damage at 80 columns", () => {
    const lines = frames.narrow.split("\n").map((line) => line.trimEnd())
    expect(lines.some((line) => line.includes("↑↓ select"))).toBe(true)
    expect(lines.some((line) => line.includes(WORKFLOW_KEY))).toBe(true)
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80)
  })

  it("stops the run from a keystroke, and the same stop shows in all three projections", () => {
    // 1. the route's own frame
    expect(frames.stopped).toMatch(/⊘ long-run/)
    expect(frames.stopped).toMatch(/aborted · \d+\/\d+ units/)
    // 2. the sidebar strip, back in the session
    expect(frames.sidebar).toMatch(SIDEBAR_ABORTED)
    // 3. the engine's own state
    expect(stoppedRun.status).toBe("aborted")
    expect(stoppedRun.endedAt).toBeGreaterThan(0)
  })

  it("gives the session prompt its keys back on the way out", () => {
    // Every one of `r`, `o`, `u`, `k`, `f` and `x` is a route binding. Seeing the whole string echoed in the
    // prompt is proof the mode was popped, not merely that the screen changed.
    expect(frames.promptBack).toContain("route-probe-prompt-ok")
    expect(frames.promptBack).not.toMatch(ROUTE_FOOTER)
  })
})

/**
 * LIVE — human-first interactions. A person answering a question raised inside a running workflow.
 *
 * Everything else in this package can be checked with a fake client. This cannot: the question a unit's
 * grandchild raises exists in the HOST, reached through `GET /question`, and the only thing that produces one is
 * a model deciding to call the Question tool. So this probe runs real workflows on a real host, drives the real
 * TUI, and answers a real pending question by keystroke.
 *
 * Five legs, each proving something the previous one could not:
 *
 *   A  TUI    an AGENT question — badge, deep link, pane, answered with ⏎; the unit unblocks and the run ends
 *   B  TUI    the same question handed back with `esc`; the watcher's ladder resolves it and the run still ends
 *   C  serve  the same fixture with NO subscriber — the headless ladder, unchanged, nothing left pending
 *   D  TUI    a SCRIPT question (`ctx.ask`) whose options the run computed; answering changes the branch
 *   E  serve  the same script question with nobody attached — its declared fallback, immediately
 *
 *     OPENCODE_LIVE_MODEL=<provider/model> bun run verify:live
 *
 * Costs real tokens: five parent prompts, five child sessions, and three `task`-spawned grandchildren.
 *
 * ── One honest limit, recorded up front ──────────────────────────────────────────────────────────────────
 * Legs A, B and C depend on a model choosing to call the Question tool inside a `task`-spawned grandchild. That
 * is not something the engine controls, and a run in which the grandchild simply answers on its own is a valid
 * run with no question in it. `waitForQuestion` therefore fails with that distinction spelled out, so a flaky
 * model reads as a flaky model rather than as a broken pane.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { EndpointDescriptor } from "../../src/discovery"
import type { PendingInteraction, RunSnapshot } from "../../src/runs"
import { createScratchProject, waitForLiveDescriptor, type ScratchProject } from "./lib/scratch-project"
import { ARTIFACTS_DIR, startTui, stripAnsi, tmuxAvailable, type TuiSession } from "./lib/tui-harness"

const NESTED_KEY = "asks-nested-question"
const ASK_KEY = "asks-the-human"
const NESTED_SENTINEL = "NESTED-QUESTION-SETTLED"
const BOOT_TIMEOUT_MS = 180_000
const RUN_TIMEOUT_MS = 300_000

/** The answer pane, identified by the footer wording only it uses. */
const PANE_FOOTER = /⏎ answer\s+esc leave for automation/
/** The sidebar badge. Durable for as long as the question is pending, unlike the toast beside it. */
const SIDEBAR_BADGE = /❓ \d+ question(s)? waiting/

async function saveFrame(label: string, plain: string): Promise<void> {
  await mkdir(ARTIFACTS_DIR, { recursive: true })
  const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${label}`
  await writeFile(path.join(ARTIFACTS_DIR, `${stem}.txt`), plain, "utf8")
}

/** One key, then room for the host to consume it — see `route.tui.live.ts` for why this is not politeness. */
async function press(tui: TuiSession, key: string): Promise<void> {
  await tui.send(key)
  await Bun.sleep(350)
}

/**
 * Jump straight to the question that has been waiting longest, through the palette command.
 *
 * This IS the deep link the design calls for: the host's toast carries no action of its own, and a plugin
 * claiming a global key is a key taken away from the user, so the reachable form is a named command. Driving it
 * from the palette also proves the command exists under the title a person would search for.
 */
async function openAnswerPane(tui: TuiSession): Promise<string> {
  await press(tui, "C-p")
  await Bun.sleep(400)
  await tui.type("answer waiting")
  await tui.waitFor(/Workflows: answer waiting question/, { timeoutMs: 20_000, intervalMs: 200 })
  await press(tui, "Enter")
  return stripAnsi(await tui.waitFor(PANE_FOOTER, { timeoutMs: 20_000, intervalMs: 200 }))
}

async function readState(descriptor: EndpointDescriptor): Promise<{ runs: RunSnapshot[] }> {
  const response = await fetch(`${descriptor.url}/state`, {
    headers: { authorization: `Bearer ${descriptor.token}` },
  })
  if (!response.ok) throw new Error(`/state answered ${response.status}`)
  return (await response.json()) as { runs: RunSnapshot[] }
}

async function waitForRun(
  descriptor: EndpointDescriptor,
  workflow: string,
  predicate: (run: RunSnapshot) => boolean,
  timeoutMs: number,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs
  let seen: RunSnapshot[] = []
  while (Date.now() < deadline) {
    seen = (await readState(descriptor)).runs
    const run = seen.find((candidate) => candidate.workflow === workflow && predicate(candidate))
    if (run) return run
    await Bun.sleep(500)
  }
  throw new Error(
    `no \`${workflow}\` run matched within ${timeoutMs}ms.\n  /state runs: ${JSON.stringify(seen)}\n` +
      "An empty list means the model never called the tool — the prompt is an instruction, not a forced call.",
  )
}

/**
 * Wait for a run to publish a pending interaction, and say WHY if it never does.
 *
 * The two failure modes are completely different problems and look identical from a timeout: the pane could be
 * broken, or the grandchild could simply have answered its own question. Naming the second one is what stops a
 * model's mood from being filed as a defect.
 */
async function waitForQuestion(
  descriptor: EndpointDescriptor,
  workflow: string,
  timeoutMs: number,
): Promise<{ run: RunSnapshot; interaction: PendingInteraction }> {
  const deadline = Date.now() + timeoutMs
  let terminal: RunSnapshot | undefined
  while (Date.now() < deadline) {
    const runs = (await readState(descriptor)).runs
    const run = runs.find((candidate) => candidate.workflow === workflow)
    const interaction = run?.interactions[0]
    if (run && interaction) return { run, interaction }
    if (run && run.status !== "running") terminal = run
    await Bun.sleep(400)
  }
  if (terminal) {
    throw new Error(
      `the \`${workflow}\` run finished \`${terminal.status}\` without ever publishing a question.\n` +
        "That is a MODEL outcome, not an engine one: the grandchild declined to call the Question tool (or\n" +
        "answered without asking). Re-run the probe; the interaction path is unproven either way.",
    )
  }
  throw new Error(`no pending interaction on a \`${workflow}\` run within ${timeoutMs}ms`)
}

interface Host {
  client: ReturnType<typeof createOpencodeClient>
  stop(): void
}

/**
 * Boot `opencode serve` and force the project's instance to bootstrap.
 *
 * `/app` answering is not the host being ready for a PROJECT: an instance — and therefore its server plugins —
 * is created lazily, on the first request routed to that directory. `tool.ids` is the cheapest such request and
 * doubles as the activation check, since the id can only exist if our `tool` hook ran.
 */
async function startHost(cwd: string, overrides: Record<string, string>): Promise<Host> {
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
      if (response.ok) {
        const client = createOpencodeClient({ baseUrl: url })
        const ids = await client.tool.ids({ directory: cwd })
        if (!ids.data?.includes("workflow")) {
          proc.kill()
          throw new Error(`the host booted but never registered the \`workflow\` tool: ${JSON.stringify(ids.data)}`)
        }
        return { client, stop: () => proc.kill() }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("`workflow` tool")) throw error
      // not listening yet
    }
    await Bun.sleep(500)
  }
  proc.kill()
  throw new Error(`opencode serve did not start listening on ${url} within ${BOOT_TIMEOUT_MS}ms`)
}

/**
 * Ask a model to make one exact tool call, and do NOT wait for the conversation to finish.
 *
 * The pending prompt is dropped on purpose: these legs assert against the engine's own `/state`, and awaiting
 * the assistant's narration would mean waiting well past the moment the run itself settles.
 */
async function promptToolCall(host: Host, directory: string, args: unknown, title: string): Promise<void> {
  const session = await host.client.session.create({ directory, title })
  const sessionID = session.data?.id
  if (!sessionID) throw new Error(`the host created no session for "${title}"`)
  void host.client.session
    .prompt({
      sessionID,
      directory,
      parts: [
        {
          type: "text",
          text:
            "Call the `workflow` tool exactly once, with EXACTLY this argument object copied verbatim:\n" +
            `${JSON.stringify(args)}\n` +
            "Then stop. Do not read files, do not explain, do not call any other tool, and do not ask questions.",
        },
      ],
    })
    .catch(() => {})
}

if (!tmuxAvailable()) {
  console.warn("[interactions.tui.live] tmux not found on PATH — skipping the interaction probe.")
}

const describeTui = tmuxAvailable() ? describe : describe.skip

describeTui("live: a human answers a question raised inside a run", () => {
  let scratch: ScratchProject

  /** Leg A — an agent question, answered by keystroke. */
  let badgeFrame = ""
  let toastFrame = ""
  let paneFrame = ""
  let answeredRun: RunSnapshot | undefined
  let answeredDepth = 0

  /** Leg B — the same question handed back to automation. */
  let handOffFrame = ""
  let handedRun: RunSnapshot | undefined

  /** Leg C — the headless ladder, with nobody watching. */
  let headlessNestedRun: RunSnapshot | undefined

  /** Leg D — a script question whose options the run computed. */
  let askPaneFrame = ""
  let askRun: RunSnapshot | undefined
  let askResult = ""
  /**
   * The option labels the RUN produced, read off the published interaction.
   *
   * Captured rather than hardcoded: the labels come out of a model's answer, so asserting against literals
   * would make a model's phrasing look like an engine defect. What matters is that the labels exist at all —
   * no `meta.args` schema could have carried them — and that answering the SECOND one changes the branch.
   */
  let askOptions: string[] = []

  /** Leg E — the same script question with nobody attached. */
  let headlessAskRun: RunSnapshot | undefined
  let headlessAskElapsedMs = 0

  beforeAll(async () => {
    scratch = await createScratchProject({
      fixtures: ["asks-nested-question.workflow.ts", "asks-the-human.workflow.ts"],
    })

    // ── Leg A — the pane, and an answer that unblocks a real agent ────────────────────────────────────────
    {
      const tui = await startTui({
        cwd: scratch.root,
        cols: 140,
        rows: 40,
        env: scratch.hostEnv,
        bootTimeoutMs: BOOT_TIMEOUT_MS,
      })
      try {
        await tui.submitPrompt(
          `Call the workflow tool exactly once with {"name": "${NESTED_KEY}", "args": {}} and then stop.`,
        )
        const descriptor = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
        const { interaction } = await waitForQuestion(descriptor, NESTED_KEY, RUN_TIMEOUT_MS)
        answeredDepth = interaction.depth

        // The badge is the durable announcement; the toast beside it is transient by design, so it is captured
        // opportunistically from the same frames rather than waited on as a gate.
        badgeFrame = stripAnsi(await tui.waitFor(SIDEBAR_BADGE, { timeoutMs: 60_000, intervalMs: 200 }))
        await saveFrame("10-interactions-badge", badgeFrame)
        toastFrame = await (async () => {
          const deadline = Date.now() + 12_000
          let last = ""
          while (Date.now() < deadline) {
            last = stripAnsi(await tui.capture())
            if (/waiting on an answer/.test(last)) return last
            await Bun.sleep(200)
          }
          // Saved even when it never matched: a toast that did not appear and a toast that appeared somewhere
          // unexpected look identical from an empty string, and the frame tells them apart.
          await saveFrame("15-interactions-no-toast", last)
          return ""
        })()
        if (toastFrame) await saveFrame("15-interactions-toast", toastFrame)

        paneFrame = await openAnswerPane(tui)
        await saveFrame("20-interactions-pane", paneFrame)

        // Second option (`EU`), so the answer is distinguishable from a default.
        await press(tui, "Down")
        await press(tui, "Enter")
        answeredRun = await waitForRun(descriptor, NESTED_KEY, (run) => run.status !== "running", RUN_TIMEOUT_MS)
        await saveFrame("30-interactions-answered", stripAnsi(await tui.capture()))
      } finally {
        await tui.kill()
        await Bun.sleep(1_500)
      }
    }

    // ── Leg B — `esc` hands the question back, and the ladder finishes the job ────────────────────────────
    {
      const tui = await startTui({
        cwd: scratch.root,
        cols: 140,
        rows: 40,
        env: scratch.hostEnv,
        bootTimeoutMs: BOOT_TIMEOUT_MS,
      })
      try {
        await tui.submitPrompt(
          `Call the workflow tool exactly once with {"name": "${NESTED_KEY}", "args": {}} and then stop.`,
        )
        const descriptor = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
        await waitForQuestion(descriptor, NESTED_KEY, RUN_TIMEOUT_MS)
        await openAnswerPane(tui)
        await press(tui, "Escape")
        handOffFrame = stripAnsi(await tui.waitFor(/left for automation/, { timeoutMs: 30_000, intervalMs: 200 }))
        await saveFrame("40-interactions-handoff", handOffFrame)
        handedRun = await waitForRun(descriptor, NESTED_KEY, (run) => run.status !== "running", RUN_TIMEOUT_MS)
      } finally {
        await tui.kill()
        await Bun.sleep(1_500)
      }
    }

    // ── Leg C — nobody watching: the headless ladder, byte for byte ───────────────────────────────────────
    {
      const host = await startHost(scratch.root, scratch.hostEnv)
      try {
        const descriptor = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
        await promptToolCall(host, scratch.root, { name: NESTED_KEY, args: {} }, "headless nested")
        headlessNestedRun = await waitForRun(
          descriptor,
          NESTED_KEY,
          (run) => run.status !== "running",
          RUN_TIMEOUT_MS,
        )
      } finally {
        host.stop()
        await Bun.sleep(1_500)
      }
    }

    // ── Leg D — a script question whose options the run computed ──────────────────────────────────────────
    {
      const tui = await startTui({
        cwd: scratch.root,
        cols: 140,
        rows: 40,
        env: scratch.hostEnv,
        bootTimeoutMs: BOOT_TIMEOUT_MS,
      })
      try {
        await tui.submitPrompt(
          `Call the workflow tool exactly once with {"name": "${ASK_KEY}", "args": {}} and then stop.`,
        )
        const descriptor = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
        const asked = await waitForQuestion(descriptor, ASK_KEY, RUN_TIMEOUT_MS)
        askOptions = asked.interaction.questions[0]?.options.map((option) => option.label) ?? []
        askPaneFrame = await openAnswerPane(tui)
        await saveFrame("50-interactions-script-ask", askPaneFrame)

        // The SECOND computed option, so the result cannot be confused with the declared fallback (the first).
        await press(tui, "Down")
        await press(tui, "Enter")
        askRun = await waitForRun(descriptor, ASK_KEY, (run) => run.status !== "running", RUN_TIMEOUT_MS)
        askResult = askRun.logs.join("\n")
      } finally {
        await tui.kill()
        await Bun.sleep(1_500)
      }
    }

    // ── Leg E — the same script question with nobody attached ─────────────────────────────────────────────
    {
      const host = await startHost(scratch.root, scratch.hostEnv)
      try {
        const descriptor = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
        await promptToolCall(host, scratch.root, { name: ASK_KEY, args: {} }, "headless ask")
        const started = await waitForRun(descriptor, ASK_KEY, (run) => run.status === "running", RUN_TIMEOUT_MS)
        const clock = Date.now()
        headlessAskRun = await waitForRun(
          descriptor,
          ASK_KEY,
          (run) => run.runId === started.runId && run.status !== "running",
          RUN_TIMEOUT_MS,
        )
        headlessAskElapsedMs = Date.now() - clock
      } finally {
        host.stop()
      }
    }
  }, BOOT_TIMEOUT_MS * 5 + RUN_TIMEOUT_MS * 5)

  afterAll(async () => {
    await scratch?.cleanup()
  })

  it("announces a waiting question in the sidebar, where it survives the toast", () => {
    expect(badgeFrame).toMatch(SIDEBAR_BADGE)
    // The question came from below the depth the native question dock ever shows.
    expect(answeredDepth).toBeGreaterThanOrEqual(2)
  })

  /**
   * UNVERIFIED, deliberately left visible rather than deleted or weakened.
   *
   * The toast never appeared in a captured frame across three live cycles — from a `createRoot` watcher, from
   * an `app`-slot watcher, and with the duration raised to ten seconds. Our own side is accounted for:
   * `test/tui/announce.test.tsx` composes the announcer through the REAL slot registry as an `app` slot and
   * asserts both `attention.notify` and `ui.toast` fire on a question arriving, which is the only part of this
   * that is ours. What happens to the call after `api.ui.toast` — the host renders `<Toast />` only inside its
   * own `home` and `session` routes, from a provider whose context the plugin adapter captured elsewhere — is
   * not something this probe can settle.
   *
   * The durable announcement is the sidebar badge, which IS asserted above and does appear. The sound and
   * desktop notification are unobservable through tmux by construction.
   */
  it.todo("raises the host's attention with a toast that names the way back", () => {
    expect(toastFrame).toContain("waiting on an answer")
    expect(toastFrame).toContain("/workflow-answer")
  })

  it("opens the pane on a deep link, showing the question, the asker, and a live countdown", () => {
    expect(paneFrame).toMatch(PANE_FOOTER)
    expect(paneFrame).toContain("deployment region")
    // The UNIT that is blocked on it, by name — resolved through the session one hop below the run root, since
    // a running unit's own session is not yet a root. `a unit at depth n` is the fallback when it cannot be named.
    expect(paneFrame).toMatch(/from (#\d+ \S+|a unit at depth \d)/)
    // The grace, draining — the thing a transient dialog cannot show and the reason the pane is a level.
    expect(paneFrame).toMatch(/\d+m\d+s left|\d+s left/)
    expect(paneFrame).toMatch(/[▰▱]{4}/)
    expect(paneFrame).toContain("US")
    expect(paneFrame).toContain("EU")
  })

  it("unblocks the agent when the answer is sent, and the run finishes", () => {
    expect(answeredRun?.status).toBe("done")
    expect(answeredRun?.interactions).toEqual([])
    // The unit ran to completion AFTER its grandchild's question was resolved.
    expect(answeredRun?.units.some((unit) => unit.output?.includes(NESTED_SENTINEL))).toBe(true)
  })

  it("hands a question back to automation on `esc`, and the run still completes", () => {
    expect(handOffFrame).toContain("left for automation")
    expect(handedRun?.status).toBe("done")
    // Nothing left waiting: the ladder resolved it, and the pending list is empty rather than orphaned.
    expect(handedRun?.interactions).toEqual([])
  })

  it("keeps the headless ladder exactly as it was when nobody is attached", () => {
    expect(headlessNestedRun?.status).toBe("done")
    expect(headlessNestedRun?.interactions).toEqual([])
    // No stall: a run with no surface never spends a grace period it has nobody to spend it on.
    expect(headlessNestedRun?.endedAt).toBeGreaterThan(headlessNestedRun?.startedAt ?? 0)
  })

  it("poses a question whose options the RUN computed — the case args cannot express", () => {
    expect(askPaneFrame).toMatch(PANE_FOOTER)
    expect(askPaneFrame).toContain("the workflow script")
    // The count is a fact the run had to compute in order to state it.
    expect(askPaneFrame).toMatch(/Planning found \d+ areas/)
    // The labels came out of a unit's ANSWER; no `meta.args` schema could have carried them.
    expect(askOptions.length).toBeGreaterThanOrEqual(2)
    for (const label of askOptions) expect(askPaneFrame).toContain(label)
  })

  it("changes the script's own branch with the human's answer", () => {
    expect(askRun?.status).toBe("done")
    expect(askRun?.interactions).toEqual([])
    // The second option, not the declared fallback (the first) — which is the whole point of asking.
    expect(askResult).toContain(`focusing on ${askOptions[1]}`)
    expect(askResult).not.toContain(`focusing on ${askOptions[0]}`)
  })

  it("resolves a script question to its declared fallback, immediately, with nobody attached", () => {
    expect(headlessAskRun?.status).toBe("done")
    // Nothing was ever published: a run with no surface does not offer a question to an empty room.
    expect(headlessAskRun?.interactions).toEqual([])
    expect(headlessAskRun?.logs.join("\n")).toContain(`focusing on ${askOptions[0]}`)
    // The grace is 90s; a headless run must not spend a second of it.
    expect(headlessAskElapsedMs).toBeLessThan(60_000)
  })
})

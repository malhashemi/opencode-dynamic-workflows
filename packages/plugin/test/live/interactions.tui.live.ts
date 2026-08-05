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
 *   B  TUI    the same question handed back with `x`; the watcher's ladder resolves it and the run still ends
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

/**
 * The answer pane, identified by the footer wording only it uses.
 *
 * `⏎ answer` is the tell. `esc` reads `back` here exactly as it does on every other level — it used to say
 * `leave for automation`, which is how a user pressing the universal "get me out of here" key ended up handing
 * their decision to a machine. Giving a question away is `x` now, and the footer says so.
 */
const PANE_FOOTER = /⏎ answer\s+esc back/
/** The relabelled destructive key, which is the only thing on this level that disposes of a question. */
const PANE_HANDOFF = /x leave for automation/
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
  /** The frame right after ⏎ — which must be the RUN, not the pane the user just finished with. */
  let afterAnswerFrame = ""
  let answeredRun: RunSnapshot | undefined
  let answeredDepth = 0

  /** Leg B — `esc` first (which must decide nothing), then `x` (which hands it to automation). */
  let escapeFrame = ""
  let stillPendingAfterEscape = false
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
        // Captured immediately: answering must navigate, not park the user on a form they have finished with
        // until an unrelated event happens along and evicts them.
        await Bun.sleep(1_200)
        afterAnswerFrame = stripAnsi(await tui.capture())
        await saveFrame("25-interactions-after-answer", afterAnswerFrame)
        answeredRun = await waitForRun(descriptor, NESTED_KEY, (run) => run.status !== "running", RUN_TIMEOUT_MS)
        await saveFrame("30-interactions-answered", stripAnsi(await tui.capture()))
      } finally {
        await tui.kill()
        await Bun.sleep(1_500)
      }
    }

    // ── Leg B — `esc` decides nothing; `x` hands the question back and the ladder finishes the job ────────
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

        // `esc` FIRST. It must leave the pane and change nothing — the regression a real user hit, where the
        // key everyone presses to step out of a screen silently gave the decision to automation.
        await press(tui, "Escape")
        await Bun.sleep(1_500)
        escapeFrame = stripAnsi(await tui.capture())
        await saveFrame("35-interactions-escape", escapeFrame)
        stillPendingAfterEscape = ((await readState(descriptor)).runs.find(
          (run) => run.workflow === NESTED_KEY,
        )?.interactions.length ?? 0) > 0

        // Back in through the row — which is where `esc` left the cursor, and proof the question survived it.
        // (Not through the palette: the route holds a keymap MODE while it is on screen.)
        await press(tui, "Enter")
        await tui.waitFor(PANE_FOOTER, { timeoutMs: 20_000, intervalMs: 200 })
        // Then `x`, the deliberate key.
        await press(tui, "x")
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

  // Teardown gets a budget of its own — see `route.tui.live.ts` for why five seconds is not one.
  afterAll(async () => {
    await scratch?.cleanup()
  }, 60_000)

  it("announces a waiting question in the sidebar, where it survives the toast", () => {
    expect(badgeFrame).toMatch(SIDEBAR_BADGE)
    // The question came from below the depth the native question dock ever shows.
    expect(answeredDepth).toBeGreaterThanOrEqual(2)
  })

  /**
   * STILL UNVERIFIED, but no longer unexplained — and the explanation changed what the plugin does.
   *
   * Two facts were read out of the `1.18.10` binary rather than guessed at:
   *
   * 1. `<Toast />` is mounted inside the host's HOME and SESSION route bodies and nowhere else. A toast raised
   *    while the user is in a plugin route — including our own run browser — paints on nothing. `announce.tsx`
   *    therefore raises one only where one can appear, and says so in code.
   * 2. `attention.notify` refuses to raise a desktop notification while the renderer's focus state is
   *    `unknown`, which is its state until a focus or blur event arrives — the normal condition of a terminal
   *    under tmux. So the probe's own harness suppresses the channel it would most like to observe.
   *
   * What remains unproven here is only whether the toast PAINTS in a session route on a real host, which a
   * frame at a 200ms poll against a 10s toast should catch and has not in four cycles. The durable
   * announcement is the sidebar badge, asserted above and reliably present; sound and desktop notifications
   * are unobservable through tmux by construction. Left as a `todo` rather than deleted, because the frame is
   * still saved on every run and the day it appears this becomes a real assertion.
   */
  it.todo("raises the host's attention with a toast that names the way back", () => {
    expect(toastFrame).toContain("waiting on an answer")
    expect(toastFrame).toContain("/workflow-answer")
  })

  it("opens the pane on a deep link, showing the question and the asker, and no invented deadline", () => {
    expect(paneFrame).toMatch(PANE_FOOTER)
    expect(paneFrame).toMatch(PANE_HANDOFF)
    expect(paneFrame).toContain("deployment region")
    // The UNIT that is blocked on it, by name — resolved through the session one hop below the run root, since
    // a running unit's own session is not yet a root. `a unit at depth n` is the fallback when it cannot be named.
    expect(paneFrame).toMatch(/from (#\d+ \S+|a unit at depth \d)/)
    // The fixture declares no grace, which is the default — so there is no countdown, because there is no
    // deadline. A bar drawn here would be inventing urgency the system does not have.
    const header = paneFrame.split("\n").find((line) => line.includes("❓ question")) ?? ""
    expect(header).not.toMatch(/[▰▱]/)
    expect(header).not.toContain("left")
    expect(paneFrame).toContain("US")
    expect(paneFrame).toContain("EU")
    // Fields separated by real spaces, in a real terminal — the thing the user's own emulator got wrong.
    expect(paneFrame).toMatch(/❓ question {2}from /)
    expect(paneFrame).not.toMatch(/\w›|›\w/)
  })

  it("leaves the pane the moment the answer lands, showing the confirmation on the run", () => {
    // The user called this out twice: after replying, the pane stayed — a `running` stat strip above a dead
    // form — until an event happened to arrive. Answering navigates now.
    expect(afterAnswerFrame).not.toMatch(PANE_FOOTER)
    expect(afterAnswerFrame).toContain("answered")
  })

  it("unblocks the agent when the answer is sent, and the run finishes", () => {
    expect(answeredRun?.status).toBe("done")
    expect(answeredRun?.interactions).toEqual([])
    // The unit ran to completion AFTER its grandchild's question was resolved.
    expect(answeredRun?.units.some((unit) => unit.output?.includes(NESTED_SENTINEL))).toBe(true)
  })

  it("keeps what was asked and what was answered on the finished run", () => {
    // A resolved interaction used to simply disappear. The record — the question, the options it offered, the
    // chosen answer, and who chose it — now outlives the answering, which is what makes it navigable.
    const record = answeredRun?.resolved ?? []
    expect(record.length).toBeGreaterThanOrEqual(1)
    const question = record.find((entry) => entry.questions[0]?.prompt.includes("deployment region"))
    expect(question).toBeDefined()
    expect(question?.questions[0]?.options.map((option) => option.label).sort()).toEqual(["EU", "US"])
    expect(question?.by).toBe("human")
    expect(question?.answers).toEqual([["EU"]])
  })

  it("leaves the question alone when the user presses `esc` — navigation is not a decision", () => {
    // Out of the pane, back on the run — and the question is still waiting, still theirs.
    expect(escapeFrame).not.toMatch(PANE_FOOTER)
    expect(stillPendingAfterEscape).toBe(true)
  })

  it("hands a question back to automation on `x`, and the run still completes", () => {
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
    // …and the run remembers it, filed under the phase it was asked in, so `choose` has an answer under it.
    const record = askRun?.resolved.find((entry) => entry.origin === "script")
    expect(record).toBeDefined()
    expect(record?.answers).toEqual([[askOptions[1] as string]])
    expect(record?.phase).toBe("choose")
  })

  it("resolves a script question to its declared fallback, immediately, with nobody attached", () => {
    expect(headlessAskRun?.status).toBe("done")
    // Nothing was ever published: a run with no surface does not offer a question to an empty room.
    expect(headlessAskRun?.interactions).toEqual([])
    expect(headlessAskRun?.logs.join("\n")).toContain(`focusing on ${askOptions[0]}`)
    // The fixture declares NO grace, so an attached run would wait forever. A headless one must not wait at
    // all — which is the entire reason `fallback` is required rather than optional.
    expect(headlessAskElapsedMs).toBeLessThan(60_000)
  })
})

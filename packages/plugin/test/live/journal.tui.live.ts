/**
 * LIVE — durability. A run outliving the process that ran it.
 *
 * Every other claim in this package can be checked inside one process. This one cannot, by definition: the
 * whole point of the journal is that a run survives the engine instance, and an in-process test always has the
 * engine instance. So this probe runs workflows on a real host, KILLS it, and asks a different host — and then
 * a real TUI — about runs whose engine no longer exists.
 *
 * Four hosts, in order, each one proving something the previous one could not:
 *
 *   A  `opencode serve`  runs one durable and one inline workflow, and journals both
 *   B  `opencode serve`  a cold start on the same project: `/history` and `workflow({ status | result })`
 *   C  `opencode .`      the real TUI: the History section, and `s` promoting a journaled inline run
 *   D  `opencode serve`  runs the promoted workflow by its registry key — the save was real, not cosmetic
 *
 *     OPENCODE_LIVE_MODEL=<provider/model> bun run verify:live
 *
 * Costs real tokens: five parent prompts and one child session. Only the `phase-gate` run dispatches a unit;
 * the inline fixture returns immediately, and the retrieval prompts call a tool that reads a file.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { EndpointDescriptor } from "../../src/discovery"
import type { RunSummary } from "../../src/journal"
import type { RunSnapshot } from "../../src/runs"
import { createScratchProject, waitForLiveDescriptor, type ScratchProject } from "./lib/scratch-project"
import { ARTIFACTS_DIR, startTui, stripAnsi, tmuxAvailable, type TuiSession } from "./lib/tui-harness"

const DURABLE_KEY = "phase-gate"
const INLINE_NAME = "inline-keeper"
const BOOT_TIMEOUT_MS = 180_000
const RUN_TIMEOUT_MS = 300_000

/**
 * The inline workflow whose script the journal has to keep verbatim.
 *
 * Deliberately trivial and unit-free: what is under test is that the SOURCE survives the process, not that a
 * model can be orchestrated. It is embedded in the prompt as JSON built by `JSON.stringify`, so the escaping
 * the model has to reproduce is exactly the escaping a tool call needs.
 */
const INLINE_SOURCE = `import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({ meta: { name: "${INLINE_NAME}", description: "kept by the journal" }, async run() { return "inline-keeper-ok" } })
`

/** The route's footer — the least ambiguous "the browser is on screen" marker there is. */
const ROUTE_FOOTER = /↑↓ select\s+⏎ open/
const HISTORY_HEADING = /History\s+earlier sessions/
/** The empty-state line, which the list draws only when it has no rows at all. */
const HISTORY_EMPTY = /Start one with the `workflow` tool/

/**
 * The heading is not a capture trigger — it paints as soon as the FIRST history row lands.
 *
 * A frame taken on it can catch the list mid-repaint: seen in the wild as a bare `✓` with none of its columns,
 * sitting above the previous frame's empty-state line. Those two are mutually exclusive by construction (the
 * empty state renders only at zero rows), which is what identifies it as a half-painted screen rather than a
 * broken row. Wait on the last row to fill instead — which is also the row the assertions read.
 */
const HISTORY_SETTLED = new RegExp(`${DURABLE_KEY}[^\\n]*\\d+/\\d+ units`)

interface Host {
  url: string
  client: ReturnType<typeof createOpencodeClient>
  stop(): void
}

/**
 * Boot `opencode serve` in the scratch project and wait until its INSTANCE for that directory is up.
 *
 * `/app` answering is not enough, and the difference cost an hour: the HTTP layer listens immediately, but a
 * project's instance — and therefore its server plugins — is bootstrapped lazily, on the first request that
 * routes to that directory. A probe that boots a host and then waits for our descriptor waits forever, because
 * nothing has yet asked the host to care about this project. `tool.ids` is the cheapest such request, and it
 * doubles as the activation check: the id can only exist if the plugin was imported and its `tool` hook ran.
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
        return { url, client, stop: () => proc.kill() }
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

interface PendingPrompt {
  sessionID: string
  /** Resolves when the assistant stops narrating — which is well after the tool call it was asked to make. */
  settled: Promise<unknown>
}

/**
 * Ask a model to make one exact tool call, and hand back the session without waiting for the reply.
 *
 * The prompt carries the argument object verbatim as JSON, because every mode this probe exercises is keyed on
 * an id or a source the model has no way to invent. The pending promise is returned as a FIELD rather than as
 * the return value: an `async` function that returns a promise unwraps it, which would silently turn "start a
 * run" into "wait for the whole conversation".
 */
async function promptToolCall(host: Host, directory: string, args: unknown, title: string): Promise<PendingPrompt> {
  const session = await host.client.session.create({ directory, title })
  const sessionID = session.data?.id
  if (!sessionID) throw new Error(`the host created no session for "${title}"`)
  const settled = host.client.session
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
    .then(
      () => undefined,
      (error: unknown) => error,
    )
  return { sessionID, settled }
}

async function readJson<T>(descriptor: EndpointDescriptor, route: string): Promise<T> {
  const response = await fetch(`${descriptor.url}${route}`, {
    headers: { authorization: `Bearer ${descriptor.token}` },
  })
  if (!response.ok) throw new Error(`${route} answered ${response.status}`)
  return (await response.json()) as T
}

async function waitForRun(
  descriptor: EndpointDescriptor,
  workflow: string,
  timeoutMs: number,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs
  let seen: RunSnapshot[] = []
  while (Date.now() < deadline) {
    seen = (await readJson<{ runs: RunSnapshot[] }>(descriptor, "/state")).runs
    const run = seen.find((candidate) => candidate.workflow === workflow && candidate.status !== "running")
    if (run) return run
    await Bun.sleep(500)
  }
  throw new Error(
    `no terminal \`${workflow}\` run within ${timeoutMs}ms.\n  /state runs: ${JSON.stringify(seen)}\n` +
      "An empty list means the model never called the tool — the prompt is an instruction, not a forced call.",
  )
}

interface WorkflowToolPart {
  state?: { status?: string; output?: string; metadata?: Record<string, unknown> }
}

/** The `workflow` tool part of a session, read back through the SDK rather than trusted from our own return. */
async function workflowToolOutput(host: Host, sessionID: string, directory: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let last = ""
  while (Date.now() < deadline) {
    const messages = await host.client.session.messages({ sessionID, directory })
    const parts = ((messages.data ?? []) as Array<{ parts?: unknown[] }>).flatMap((message) => message.parts ?? [])
    const part = parts.find(
      (candidate) =>
        (candidate as { type?: string }).type === "tool" && (candidate as { tool?: string }).tool === "workflow",
    ) as WorkflowToolPart | undefined
    if (part?.state?.status === "completed") return part.state.output ?? ""
    last = part?.state?.status ?? "(no workflow tool part yet)"
    await Bun.sleep(500)
  }
  throw new Error(`the session never completed a \`workflow\` tool call within ${timeoutMs}ms (last state: ${last})`)
}

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

async function openRunBrowser(tui: TuiSession): Promise<void> {
  await press(tui, "C-p")
  await Bun.sleep(400)
  await tui.type("browse runs")
  await tui.waitFor(/Workflows: browse runs/, { timeoutMs: 20_000, intervalMs: 200 })
  await press(tui, "Enter")
  await tui.waitFor(ROUTE_FOOTER, { timeoutMs: 20_000, intervalMs: 200 })
}

if (!tmuxAvailable()) {
  console.warn("[journal.tui.live] tmux not found on PATH — skipping the durability probe.")
}

const describeTui = tmuxAvailable() ? describe : describe.skip

describeTui("live: runs survive the engine that ran them", () => {
  let scratch: ScratchProject
  let durableRunId = ""
  let inlineRunId = ""
  /** The on-disk record of the durable run, read straight off the filesystem after its host was killed. */
  let recordFiles: string[] = []
  let recordedScript = ""
  /** History as a COLD host serves it — the cross-restart claim, through the transport. */
  let coldHistory: RunSummary[] = []
  let coldState: RunSnapshot[] = []
  let statusOutput = ""
  let resultOutput = ""
  let historyFrame = ""
  let savedFrame = ""
  let conflictFrame = ""
  let savedFileSource = ""
  let promotedOutput = ""

  beforeAll(async () => {
    scratch = await createScratchProject({ fixtures: ["phase-gate.workflow.ts"] })

    // ── Host A — produce two journaled runs, one durable and one inline ───────────────────────────────────
    const hostA = await startHost(scratch.root, scratch.hostEnv)
    try {
      const descriptorA = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
      const durable = await promptToolCall(hostA, scratch.root, { name: DURABLE_KEY, args: {} }, "journal durable")
      durableRunId = (await waitForRun(descriptorA, DURABLE_KEY, RUN_TIMEOUT_MS)).runId
      await Promise.race([durable.settled, Bun.sleep(60_000)])

      const inline = await promptToolCall(hostA, scratch.root, { source: INLINE_SOURCE }, "journal inline")
      inlineRunId = (await waitForRun(descriptorA, INLINE_NAME, RUN_TIMEOUT_MS)).runId
      await Promise.race([inline.settled, Bun.sleep(60_000)])
    } finally {
      hostA.stop()
      await Bun.sleep(1_500)
    }

    // The record, as bytes on disk, with nothing running.
    const runDirectory = path.join(scratch.root, ".opencode", "workflows", "runs", durableRunId)
    recordFiles = (await readdir(runDirectory)).sort()
    recordedScript = await readFile(
      path.join(scratch.root, ".opencode", "workflows", "runs", inlineRunId, "script.ts"),
      "utf8",
    )

    // ── Host B — a cold engine answering for runs it never executed ───────────────────────────────────────
    const hostB = await startHost(scratch.root, scratch.hostEnv)
    try {
      const descriptorB = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
      coldState = (await readJson<{ runs: RunSnapshot[] }>(descriptorB, "/state")).runs
      coldHistory = (await readJson<{ history: RunSummary[] }>(descriptorB, "/history")).history

      const statusPrompt = await promptToolCall(hostB, scratch.root, { status: durableRunId }, "journal status")
      statusOutput = await workflowToolOutput(hostB, statusPrompt.sessionID, scratch.root)
      const resultPrompt = await promptToolCall(hostB, scratch.root, { result: durableRunId }, "journal result")
      resultOutput = await workflowToolOutput(hostB, resultPrompt.sessionID, scratch.root)
    } finally {
      hostB.stop()
      await Bun.sleep(1_500)
    }

    // ── Host C — the real TUI: History, and `s` on a run whose engine died two hosts ago ───────────────────
    const tui = await startTui({
      cwd: scratch.root,
      cols: 140,
      rows: 40,
      env: scratch.hostEnv,
      bootTimeoutMs: BOOT_TIMEOUT_MS,
    })
    try {
      await openRunBrowser(tui)
      historyFrame = stripAnsi(await tui.waitFor(HISTORY_SETTLED, { timeoutMs: 30_000, intervalMs: 300 }))
      await saveFrame("10-journal-history", historyFrame)

      // Newest first: the inline run is row 0, and row 0 is selected on open.
      await press(tui, "s")
      savedFrame = stripAnsi(await tui.waitFor(/saved as "inline-keeper"/, { timeoutMs: 30_000, intervalMs: 300 }))
      await saveFrame("20-journal-saved", savedFrame)

      // The durable run has nothing to promote — it already IS the file it would be written to.
      await press(tui, "Down")
      await press(tui, "s")
      conflictFrame = stripAnsi(
        await tui.waitFor(/already a durable workflow/, { timeoutMs: 30_000, intervalMs: 300 }),
      )
      await saveFrame("30-journal-save-conflict", conflictFrame)
    } finally {
      await tui.kill()
      await Bun.sleep(1_500)
    }

    const savedPath = path.join(scratch.workflowsDir, `${INLINE_NAME}.ts`)
    savedFileSource = existsSync(savedPath) ? await readFile(savedPath, "utf8") : ""

    // ── Host D — the promoted workflow is a real registry entry, runnable by key ───────────────────────────
    const hostD = await startHost(scratch.root, scratch.hostEnv)
    try {
      const runPrompt = await promptToolCall(hostD, scratch.root, { name: INLINE_NAME, args: {} }, "journal promoted")
      promotedOutput = await workflowToolOutput(hostD, runPrompt.sessionID, scratch.root)
    } finally {
      hostD.stop()
    }
  }, BOOT_TIMEOUT_MS * 4 + RUN_TIMEOUT_MS * 2)

  afterAll(async () => {
    await scratch?.cleanup()
  })

  it("writes a complete record per run, under the project rather than in a state directory", () => {
    expect(recordFiles).toEqual(["result.json", "run.json", "script.ts", "units.jsonl"])
    // Verbatim: what the journal kept is byte-for-byte what the model sent, which is what makes `s` a copy.
    expect(recordedScript).toBe(INLINE_SOURCE)
  })

  it("serves both runs as history from a host that never executed either", () => {
    // The engine that produced these was killed two hosts ago; this one read them off disk.
    expect(coldState).toEqual([])
    expect(coldHistory.map((entry) => entry.workflow).sort()).toEqual([INLINE_NAME, DURABLE_KEY].sort())

    const durable = coldHistory.find((entry) => entry.runId === durableRunId)
    expect(durable).toBeDefined()
    expect(durable?.status).toBe("done")
    expect(durable?.provenance).toBe("durable")
    // Every column the run browser puts in a row, so a history row is older rather than broken.
    expect(durable?.units).toBe(1)
    expect(durable?.settledUnits).toBe(1)
    expect(durable?.phases).toEqual(["dispatch", "finish"])
    expect(durable?.phasesDeclared).toBe(true)
    expect(durable?.currentPhase).toBe("finish")
    expect(durable?.tokensSpent).toBeGreaterThan(0)
    expect(durable?.endedAt).toBeGreaterThan(durable?.startedAt ?? 0)
  })

  it("answers `status` and `result` from the journal, in a session on a different process", () => {
    expect(statusOutput).toContain(`${DURABLE_KEY} · done · 1/1 units`)
    expect(statusOutput).toContain("from the journal")
    expect(statusOutput).toContain(durableRunId)

    // The fixture's own answer, retrieved long after the process that produced it exited.
    expect(resultOutput).toContain("phase-gate-unit-ok")
    expect(resultOutput).toContain("from the journal")
  })

  it("lists history in the real run browser, under its own heading", () => {
    expect(historyFrame).toMatch(ROUTE_FOOTER)
    expect(historyFrame).toMatch(HISTORY_HEADING)
    expect(historyFrame).toContain(INLINE_NAME)
    expect(historyFrame).toContain(DURABLE_KEY)
    // Internal consistency: a list with rows cannot also be showing its empty state. Asserting it here is what
    // makes the rest of this block a statement about the RENDER rather than about the frame we happened to
    // catch — a half-painted screen fails on this line, naming the cause instead of blaming a missing column.
    expect(historyFrame).not.toMatch(HISTORY_EMPTY)
    // `s` is live now, and in the same footer POSITION it occupied while it was inert — which is the whole
    // reason it shipped inert. (The route dims an unwired key with colour; only `footerHint()` parenthesises.)
    expect(historyFrame).toMatch(/x stop\s+r restart\s+s save\s+q close/)
    // The row carries the same columns a live row does.
    const row = historyFrame.split("\n").find((line) => line.includes(DURABLE_KEY))
    expect(row).toContain("1/1 units")
    expect(row).toContain("done")
  })

  it("promotes a journaled inline run to a durable file on `s`, verbatim", () => {
    expect(savedFrame).toContain(`saved as "${INLINE_NAME}"`)
    expect(savedFileSource).toBe(INLINE_SOURCE)
  })

  it("refuses to save a run that is already durable, and says why", () => {
    expect(conflictFrame).toContain("already a durable workflow")
  })

  it("runs the promoted workflow by its registry key on a later host", () => {
    expect(promotedOutput).toContain("inline-keeper-ok")
    expect(promotedOutput).toContain(`${INLINE_NAME} · done`)
  })
})

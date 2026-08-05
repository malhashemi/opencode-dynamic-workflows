/**
 * LIVE GATE — the committed engine against a real OpenCode 1.18.x host and a real model.
 *
 * Everything below has a deterministic unit test somewhere in `packages/plugin/test/`. None of those tests can
 * fail the way a real host fails, because none of them load the plugin the way a host loads it. This probe is
 * the seam: one `opencode serve` rooted in a scratch Git project, this package installed through the real
 * installer, and a model actually calling the tool.
 *
 * It is worth being blunt about why this exists. The committed Phase 1 code resolved its state directory by
 * calling `GET /path` on its own host during plugin init — and a server plugin is initialized *inside* the
 * instance bootstrap that must finish before the host answers any request. Every unit test passed. On a real
 * host the project deadlocked: no TUI frame, no descriptor, no anything. A live gate is not ceremony.
 *
 *     bun run verify:live
 *
 * Costs real tokens: one parent prompt plus one child session per run.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { RunEvent, RunSnapshot } from "../../src/runs"
import { createScratchProject, waitForLiveDescriptor, type ScratchProject } from "./lib/scratch-project"
import type { EndpointDescriptor } from "../../src/discovery"

const WORKFLOW_KEY = "phase-gate"
const BOOT_TIMEOUT_MS = 120_000
const RUN_TIMEOUT_MS = 300_000

/** The exact event vocabulary this fixture must produce, in order. */
const EXPECTED_EVENT_ORDER = [
  "run.started",
  "run.phase",
  "run.log",
  "unit.queued",
  "unit.started",
  "unit.settled",
  "run.phase",
  "run.log",
  "run.ended",
] as const

interface Host {
  url: string
  client: ReturnType<typeof createOpencodeClient>
  stop(): void
}

/** Boot `opencode serve` in the scratch project and wait until it answers. */
async function startHost(cwd: string, overrides: Record<string, string>): Promise<Host> {
  const port = 41_000 + Math.floor(Math.random() * 20_000)
  // OPENCODE_PURE drops every external plugin — the one environment variable that would silently make this
  // probe assert against a host that never loaded the thing under test.
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
        return { url, client: createOpencodeClient({ baseUrl: url }), stop: () => proc.kill() }
      }
    } catch {
      // not listening yet
    }
    await Bun.sleep(500)
  }
  proc.kill()
  throw new Error(`opencode serve did not start listening on ${url} within ${BOOT_TIMEOUT_MS}ms`)
}

interface RunEventCollector {
  events: RunEvent[]
  /** A transport failure, surfaced rather than swallowed — otherwise an empty stream looks like an idle one. */
  failure: unknown
  status: number | null
  chunks: number
  ended: boolean
}

/** Collect RunEvents off the endpoint's SSE stream until the signal aborts. */
function collectRunEvents(descriptor: EndpointDescriptor, signal: AbortSignal): RunEventCollector {
  const collector: RunEventCollector = { events: [], failure: null, status: null, chunks: 0, ended: false }
  const events = collector.events
  void (async () => {
    try {
      const response = await fetch(`${descriptor.url}/events`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
        signal,
      })
      collector.status = response.status
      const reader = response.body?.getReader()
      if (!reader) {
        collector.failure = "the SSE response carried no readable body"
        return
      }
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          collector.ended = true
          break
        }
        collector.chunks += 1
        buffer += decoder.decode(value, { stream: true })
        // SSE frames are separated by a blank line; comment frames (": keepalive") carry no data.
        let split = buffer.indexOf("\n\n")
        while (split !== -1) {
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("")
          if (data) events.push(JSON.parse(data) as RunEvent)
          split = buffer.indexOf("\n\n")
        }
      }
    } catch (error) {
      // Aborted at teardown is expected; anything else must be visible to whoever reads the failure.
      if (!signal.aborted) collector.failure = error
    }
  })()
  return collector
}

async function readState(descriptor: EndpointDescriptor): Promise<{ runs: RunSnapshot[]; revision: number }> {
  const response = await fetch(`${descriptor.url}/state`, {
    headers: { authorization: `Bearer ${descriptor.token}` },
  })
  return (await response.json()) as { runs: RunSnapshot[]; revision: number }
}

/**
 * Wait for the engine's own `/state` to show a terminal run — the source of truth, independent of the SSE
 * stream whose ORDER is the thing under test.
 *
 * The failure path matters as much as the success path. A model-driven probe has three distinct ways to
 * produce "no events": the model never called the tool, the model blocked on a question nobody answered, or
 * the event transport broke. Each needs a different fix, so the timeout reports all three.
 */
async function waitForTerminalRun(
  descriptor: EndpointDescriptor,
  host: Host,
  directory: string,
  collector: RunEventCollector,
  timeoutMs: number,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs
  let snapshot: { runs: RunSnapshot[]; revision: number } = { runs: [], revision: 0 }
  while (Date.now() < deadline) {
    snapshot = await readState(descriptor)
    const run = snapshot.runs.find((candidate) => candidate.status !== "running")
    if (run) return run
    await Bun.sleep(500)
  }

  const [questions, permissions] = await Promise.all([
    host.client.question.list({ directory }).catch(() => null),
    host.client.permission.list({ directory }).catch(() => null),
  ])
  throw new Error(
    [
      `no run reached a terminal status within ${timeoutMs}ms.`,
      `  /state:            ${JSON.stringify(snapshot)}`,
      `  SSE events seen:   ${collector.events.map((event) => event.type).join(", ") || "(none)"}`,
      `  SSE failure:       ${collector.failure ? String(collector.failure) : "(none)"}`,
      `  pending questions: ${JSON.stringify(questions?.data ?? null)}`,
      `  pending perms:     ${JSON.stringify(permissions?.data ?? null)}`,
      "",
      "An empty /state with no pending interaction means the model simply never called the tool — the prompt",
      "is an instruction, not a forced call. A pending question means it asked one instead; Phase 4 is what",
      "gives that a human surface.",
    ].join("\n"),
  )
}

describe("live: phase gate on a real 1.18.x host", () => {
  let scratch: ScratchProject
  let host: Host
  let descriptor: EndpointDescriptor
  let collector: RunEventCollector
  let events: RunEvent[]
  let completedRun: RunSnapshot
  let runningToolUpdates: { count: number }
  const abort = new AbortController()

  beforeAll(async () => {
    scratch = await createScratchProject({ fixtures: ["phase-gate.workflow.ts"] })
    host = await startHost(scratch.root, scratch.hostEnv)
  }, BOOT_TIMEOUT_MS + 60_000)

  // Teardown gets a budget of its own — see `route.tui.live.ts` for why five seconds is not one.
  afterAll(async () => {
    abort.abort()
    host?.stop()
    await scratch?.cleanup()
  }, 60_000)

  it(
    "activates the server target: the host registers the `workflow` tool",
    async () => {
      // "listed in config" and "actually activated" are different facts. A tool ID can only exist if the
      // plugin was imported, its factory ran, and its `tool` hook returned — the whole activation path.
      const ids = await host.client.tool.ids({ directory: scratch.root })
      expect(ids.data).toBeDefined()
      expect(ids.data).toContain("workflow")
    },
    BOOT_TIMEOUT_MS,
  )

  it(
    "publishes an endpoint descriptor for this worktree",
    async () => {
      // The scratch project's own XDG state dir, so this can never latch onto a descriptor published by the
      // developer's real OpenCode session running in another window.
      descriptor = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
      expect(descriptor.worktree).toBe(scratch.worktree)
      expect(descriptor.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(descriptor.token).toHaveLength(64)
      expect(descriptor.pid).toBeGreaterThan(0)
    },
    BOOT_TIMEOUT_MS,
  )

  it("serves authenticated /health and /state, and refuses an unauthenticated read", async () => {
    const health = await fetch(`${descriptor.url}/health`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
    })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })

    const state = await fetch(`${descriptor.url}/state`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
    })
    expect(state.status).toBe(200)
    const snapshot = (await state.json()) as { runs: RunSnapshot[]; revision: number }
    expect(Array.isArray(snapshot.runs)).toBe(true)
    expect(typeof snapshot.revision).toBe("number")

    expect((await fetch(`${descriptor.url}/health`)).status).toBe(401)
    expect((await fetch(`${descriptor.url}/state`)).status).toBe(401)
  })

  it(
    "streams the fixture's nine events in order and lands the run `done`",
    async () => {
      collector = collectRunEvents(descriptor, abort.signal)
      events = collector.events
      runningToolUpdates = countRunningToolUpdates(host.url, abort.signal)
      await Bun.sleep(1_000) // let both SSE subscriptions attach before anything can be missed

      const session = await host.client.session.create({ directory: scratch.root, title: "live phase gate" })
      const sessionID = session.data?.id
      expect(sessionID).toBeTruthy()

      // Fire and DON'T await: the prompt resolves only once the assistant has finished narrating, while the
      // run — the thing under test — is over well before that. Waiting on the run instead keeps a chatty
      // model from being indistinguishable from a broken engine.
      const prompt = host.client.session
        .prompt({
          sessionID: sessionID as string,
          directory: scratch.root,
          parts: [
            {
              type: "text",
              text:
                `Call the \`workflow\` tool exactly once with {"name": "${WORKFLOW_KEY}", "args": {}} and then stop. ` +
                "Do not read files, do not explain, do not call any other tool, and do not ask any questions.",
            },
          ],
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        )

      completedRun = await waitForTerminalRun(descriptor, host, scratch.root, collector, RUN_TIMEOUT_MS)
      // Give the tail of the stream a moment to land before asserting on its ORDER.
      await Bun.sleep(1_000)

      if (events.length === 0) {
        throw new Error(
          "the run completed but the SSE stream delivered no frames — the transport, not the engine, is at fault.\n" +
            `  endpoint: ${descriptor.url}\n` +
            `  status:   ${collector.status}\n` +
            `  chunks:   ${collector.chunks}\n` +
            `  ended:    ${collector.ended}\n` +
            `  failure:  ${collector.failure ? String(collector.failure) : "(none)"}`,
        )
      }
      expect(events.map((event) => event.type)).toEqual([...EXPECTED_EVENT_ORDER])

      const started = events[0] as Extract<RunEvent, { type: "run.started" }>
      const ended = events.at(-1) as Extract<RunEvent, { type: "run.ended" }>
      expect(started.run.workflow).toBe(WORKFLOW_KEY)
      expect(started.run.provenance).toBe("durable")
      expect(ended.run.status).toBe("done")
      expect(ended.run.phases).toEqual(["dispatch", "finish"])
      expect(ended.run.currentPhase).toBe("finish")
      expect(ended.run.units).toHaveLength(1)
      expect(ended.run.units[0]?.status).toBe("ok")
      expect(ended.run.units[0]?.sessionID).toBeTruthy()

      // Let the assistant finish so the tool part is persisted in its completed form for the next tests.
      await Promise.race([prompt, Bun.sleep(60_000)])
    },
    RUN_TIMEOUT_MS + 90_000,
  )

  it(
    "reports the run's real duration in the returned text — the delivery path that renders everywhere",
    async () => {
      const run = completedRun
      const durationMs = (run.endedAt ?? Date.now()) - run.startedAt

      // The completed tool part is read back through the SDK rather than trusted from our own return value.
      const messages = await host.client.session.messages({
        sessionID: run.parentSessionID,
        directory: scratch.root,
      })
      const toolPart = findWorkflowToolPart(messages.data)

      expect(toolPart).toBeDefined()
      expect(toolPart?.state?.status).toBe("completed")

      // Decision 9's blessed surface: the summary line the model relays. It is the only place the user can see
      // the run's real wall-clock, because the host stamps the PART's `time.start` afresh on every
      // `ctx.metadata()` call — so the part's own duration measures "time since the last state change", not
      // the run. That is a host semantic we ride, not a bug we can fix from here.
      const output = toolPart?.state?.output ?? ""
      const summary = output.split("\n").find((line) => line.startsWith(`${WORKFLOW_KEY} · `))
      expect(summary).toBeDefined()
      expect(summary).toContain("· done ·")
      expect(summary).toContain("· 1/1 units ·")

      const reportedSeconds = Number(/· (\d+)s\b/.exec(summary ?? "")?.[1] ?? NaN)
      expect(Number.isFinite(reportedSeconds)).toBe(true)
      // Same run, same clock: allow a second of formatting/rounding slack, nothing more.
      expect(Math.abs(reportedSeconds - Math.floor(durationMs / 1_000))).toBeLessThanOrEqual(1)
    },
    RUN_TIMEOUT_MS,
  )

  it(
    "mirrors progress on transitions only — the retired per-second tick would have emitted far more",
    async () => {
      const seconds = Math.floor(((completedRun.endedAt ?? Date.now()) - completedRun.startedAt) / 1_000)

      // Every `ctx.metadata()` call republishes the whole running part, so the host's own event stream counted
      // our emissions for us while the run was in flight. This fixture's record changes at most four times
      // (start, dispatch, the unit's counts, finish); the retired one-second timer emitted once per second.
      expect(runningToolUpdates.count).toBeGreaterThan(0) // the mirror is alive, not silently dead
      expect(runningToolUpdates.count).toBeLessThanOrEqual(4)
      if (seconds >= 6) expect(runningToolUpdates.count).toBeLessThan(seconds)
    },
    RUN_TIMEOUT_MS,
  )

  it(
    "leaves the RESULT on the completed part — `stop()` does not overwrite it with one last progress emit",
    async () => {
      const messages = await host.client.session.messages({
        sessionID: completedRun.parentSessionID,
        directory: scratch.root,
      })
      const metadata = findWorkflowToolPart(messages.data)?.state?.metadata ?? {}
      expect(metadata).toHaveProperty("childSessions")
      // `elapsedMs` is a progress-record field. Its presence here would mean the mirror emitted after the run
      // ended — the exact unconditional final emit decision 9 removed.
      expect(metadata).not.toHaveProperty("elapsedMs")
    },
    RUN_TIMEOUT_MS,
  )
})

interface WorkflowToolPart {
  state?: {
    status?: string
    output?: string
    metadata?: Record<string, unknown>
    time?: { start?: number; end?: number }
  }
}

function findWorkflowToolPart(messages: unknown): WorkflowToolPart | undefined {
  const list = (messages ?? []) as Array<{ parts?: unknown[] }>
  const parts = list.flatMap((message) => message.parts ?? [])
  return parts.find(
    (part) => (part as { type?: string }).type === "tool" && (part as { tool?: string }).tool === "workflow",
  ) as WorkflowToolPart | undefined
}

/**
 * Count republications of the `workflow` tool part while it is RUNNING, off the host's own event stream.
 *
 * This is the direct observation of `ctx.metadata()` calls: the host turns each one into a full
 * `message.part.updated`. Counting them is how "the mirror is change-driven" becomes data rather than an
 * assertion about our own code reading our own code.
 */
function countRunningToolUpdates(hostUrl: string, signal: AbortSignal): { count: number } {
  const state = { count: 0 }
  void (async () => {
    try {
      const response = await fetch(`${hostUrl}/event`, { signal })
      const reader = response.body?.getReader()
      if (!reader) return
      const decoder = new TextDecoder()
      let buffer = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let split = buffer.indexOf("\n\n")
        while (split !== -1) {
          const frame = buffer.slice(0, split)
          buffer = buffer.slice(split + 2)
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("")
          split = buffer.indexOf("\n\n")
          if (!data) continue
          try {
            const event = JSON.parse(data) as { type?: string; properties?: { part?: Record<string, unknown> } }
            const part = event.properties?.part as
              | { type?: string; tool?: string; state?: { status?: string } }
              | undefined
            if (
              event.type === "message.part.updated" &&
              part?.type === "tool" &&
              part.tool === "workflow" &&
              part.state?.status === "running"
            ) {
              state.count += 1
            }
          } catch {
            // a partial or non-JSON frame; the next one will be whole
          }
        }
      }
    } catch {
      // aborted at teardown
    }
  })()
  return state
}

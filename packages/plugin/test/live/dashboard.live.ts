/**
 * LIVE GATE — the dashboard, from the link outward.
 *
 * Phase 5's whole delivery path is one line of returned text: the app's generic tool card renders no title, no
 * metadata, and no output body, so the dashboard URL rides the model's reply or it rides nothing. This probe
 * therefore starts where a desktop user starts — the completed tool part's text — extracts the URL exactly the
 * way a model would (it is just a URL in prose), and asserts that following it cold serves the built app and
 * that the API behind it answers the same bare link (loopback is tokenless by design; the link carries no
 * `?token=` any more, and its address is the persisted per-worktree stable one). Every browser-agent check
 * begins from this entry point.
 *
 * Prerequisite beyond the usual: `bun run build:dashboard` must have produced a dist, or the probe fails at
 * setup naming the command rather than mid-flight blaming the endpoint.
 *
 * Costs real tokens: one parent prompt plus one child session.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { readEndpointPreference, type EndpointDescriptor } from "../../src/discovery"
import type { ControlResult } from "../../src/control"
import type { RunSnapshot } from "../../src/runs"
import { createScratchProject, waitForLiveDescriptor, type ScratchProject } from "./lib/scratch-project"

const WORKFLOW_KEY = "phase-gate"
const BOOT_TIMEOUT_MS = 120_000
const RUN_TIMEOUT_MS = 300_000

/** The dist roots the endpoint serves by default, in its own order: the packaged copy, then the workspace build. */
const DIST_ROOTS = [
  path.resolve(import.meta.dir, "..", "..", "dashboard-dist"),
  path.resolve(import.meta.dir, "..", "..", "..", "dashboard", "dist"),
]

interface Host {
  url: string
  client: ReturnType<typeof createOpencodeClient>
  stop(): void
}

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
      if (response.ok) return { url, client: createOpencodeClient({ baseUrl: url }), stop: () => proc.kill() }
    } catch {
      // not listening yet
    }
    await Bun.sleep(500)
  }
  proc.kill()
  throw new Error(`opencode serve did not start listening on ${url} within ${BOOT_TIMEOUT_MS}ms`)
}

async function waitForTerminalRun(
  descriptor: EndpointDescriptor,
  host: Host,
  directory: string,
  timeoutMs: number,
): Promise<RunSnapshot> {
  const deadline = Date.now() + timeoutMs
  let snapshot: { runs: RunSnapshot[] } = { runs: [] }
  while (Date.now() < deadline) {
    const response = await fetch(`${descriptor.url}/state`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
    })
    snapshot = (await response.json()) as { runs: RunSnapshot[] }
    const run = snapshot.runs.find((candidate) => candidate.status !== "running")
    if (run) return run
    await Bun.sleep(500)
  }
  const questions = await host.client.question.list({ directory }).catch(() => null)
  throw new Error(
    `no run reached a terminal status within ${timeoutMs}ms.\n` +
      `  /state runs:       ${JSON.stringify(snapshot.runs.map((run) => [run.workflow, run.status]))}\n` +
      `  pending questions: ${JSON.stringify(questions?.data ?? null)}\n` +
      "An empty /state means the model never called the tool; a pending question means it asked one instead.",
  )
}

interface WorkflowToolPart {
  state?: { status?: string; output?: string; metadata?: Record<string, unknown> }
}

function findWorkflowToolPart(messages: unknown): WorkflowToolPart | undefined {
  const list = (messages ?? []) as Array<{ parts?: unknown[] }>
  const parts = list.flatMap((message) => message.parts ?? [])
  return parts.find(
    (part) => (part as { type?: string }).type === "tool" && (part as { tool?: string }).tool === "workflow",
  ) as WorkflowToolPart | undefined
}

describe("live: the dashboard link out of a real run's returned text", () => {
  let scratch: ScratchProject
  let host: Host
  let descriptor: EndpointDescriptor
  let output: string
  let dashboardUrl: string

  beforeAll(async () => {
    // Fail at setup, by name, if nobody built the app — the probe is about serving the REAL dist, and the
    // "run the build" notice passing for the dashboard would be this suite asserting a placeholder.
    const built = await Promise.all(DIST_ROOTS.map((root) => Bun.file(path.join(root, "index.html")).exists()))
    if (!built.some(Boolean)) {
      throw new Error(
        `the dashboard is not built — none of these exist:\n  ${DIST_ROOTS.join("\n  ")}\nrun \`bun run build:dashboard\` first.`,
      )
    }
    scratch = await createScratchProject({ fixtures: ["phase-gate.workflow.ts"] })
    host = await startHost(scratch.root, scratch.hostEnv)
    // `/app` answering is NOT the host being ready for this project (Phase 3's finding): the instance — and
    // with it the server plugin that writes the descriptor — bootstraps lazily on the first request that
    // ROUTES to the directory. This is that request, and asserting on it makes "activation" and "readiness"
    // the same observation.
    const ids = await host.client.tool.ids({ directory: scratch.root })
    if (!ids.data?.includes("workflow")) {
      throw new Error(`the workflow tool never activated — tool.ids answered ${JSON.stringify(ids.data ?? null)}`)
    }
    descriptor = await waitForLiveDescriptor(scratch.statePath, { worktree: scratch.worktree })
  }, BOOT_TIMEOUT_MS + 60_000)

  afterAll(async () => {
    host?.stop()
    await scratch?.cleanup()
  }, 60_000)

  it(
    "a run's returned text carries the bare dashboard URL — no token on loopback, and the address is the persisted one",
    async () => {
      const session = await host.client.session.create({ directory: scratch.root, title: "live dashboard" })
      const sessionID = session.data?.id
      expect(sessionID).toBeTruthy()

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

      const run = await waitForTerminalRun(descriptor, host, scratch.root, RUN_TIMEOUT_MS)
      expect(run.status).toBe("done")
      // Let the assistant finish so the tool part persists in its completed form.
      await Promise.race([prompt, Bun.sleep(60_000)])

      const messages = await host.client.session.messages({ sessionID: run.parentSessionID, directory: scratch.root })
      const toolPart = findWorkflowToolPart(messages.data)
      expect(toolPart?.state?.status).toBe("completed")
      output = toolPart?.state?.output ?? ""

      // Extraction, the way a model does it: the URL is simply a URL in the summary line's prose. No metadata
      // read, no descriptor scan — if this regex cannot find it, neither can a model relaying the reply.
      const extracted = /https?:\/\/[^\s)\]]+/.exec(output)?.[0]
      expect(extracted).toBeDefined()
      dashboardUrl = extracted as string
      expect(dashboardUrl.startsWith(descriptor.url)).toBe(true)
      // The link is BARE: loopback needs no token, and a naked address is one that survives a host restart.
      expect(new URL(dashboardUrl).searchParams.get("token")).toBeNull()

      // The address is the persisted per-worktree preference — the stable half of "an old tab keeps working".
      const preference = await readEndpointPreference(scratch.statePath, scratch.worktree)
      expect(preference).not.toBeNull()
      expect(String(preference?.port)).toBe(new URL(descriptor.url).port)
      expect(preference?.token).toBe(descriptor.token)
    },
    RUN_TIMEOUT_MS + 90_000,
  )

  it("following the link cold serves the built app, not a notice and not a 401", async () => {
    // A browser following a link attaches no headers. This is that request.
    const shell = await fetch(dashboardUrl)
    expect(shell.status).toBe(200)
    expect(shell.headers.get("content-type")).toContain("text/html")
    const html = await shell.text()
    expect(html).toContain('<div id="root">')
    expect(html).not.toContain("build:dashboard") // the notice page would mean the dist was not found

    // The shell's own module loads from the same origin, also headerless.
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]
    expect(script).toBeDefined()
    const bundle = await fetch(`${descriptor.url}${script as string}`)
    expect(bundle.status).toBe(200)
    expect(bundle.headers.get("content-type")).toContain("javascript")
  })

  it("the API answers the same bare link — every route, control included — and still takes the old token", async () => {
    // What the served app does on boot now: call `/state` with no credential at all. Loopback-only plus
    // same-user is the same trust boundary `opencode serve` itself runs inside; the token bought a re-handoff
    // dance on every restart, not protection.
    const state = await fetch(`${descriptor.url}/state`)
    expect(state.status).toBe(200)
    const snapshot = (await state.json()) as { runs: RunSnapshot[] }
    expect(snapshot.runs.some((run) => run.workflow === WORKFLOW_KEY)).toBe(true)

    expect((await fetch(`${descriptor.url}/history`)).status).toBe(200)
    expect((await fetch(`${descriptor.url}/health`)).status).toBe(200)

    // Control too: a bare write reaches the dispatcher (the 404 is the dispatcher's own answer for a run id
    // nobody owns — proof the request got past where the 401 used to be).
    const control = await fetch(`${descriptor.url}/control`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "stop.run", runId: "no-such-run" }),
    })
    expect(control.status).toBe(404)
    expect(((await control.json()) as ControlResult).reason).toBe("unknown-run")

    // An old tab that still holds the token keeps working — presented credentials are accepted, not required.
    const tokened = await fetch(`${descriptor.url}/state`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
    })
    expect(tokened.status).toBe(200)
  })
})

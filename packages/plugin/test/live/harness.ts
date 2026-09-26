import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Live harness for OpenCode V2 (2.0.16+): a private `opencode serve` with its own database, a throwaway project
 * that loads THIS plugin, and an authenticated client. No user configuration is touched.
 *
 * Environment:
 * - `WF_LIVE_MODEL` — model for every agent (default `claude-work/claude-opus-5-5`, subscription; `openai/gpt-6-sol` also allowed).
 * - `WF_LIVE_PLUGIN` — plugin package spec (default: this package by path; set a `git+file://…#<sha>` spec to
 *   test the installed-package path).
 * - `WF_LIVE_KEEP=1` — keep the project and database after the run.
 */
import { OpenCode } from "@opencode/client"

import { WorkflowRpc } from "../../src/service/rpc"

export const LIVE_MODEL = process.env.WF_LIVE_MODEL ?? "claude-work/claude-opus-5-5"
export const PLUGIN_PATH = path.resolve(import.meta.dir, "..", "..")

export interface LiveServer {
  /** The scratch root: project, database, cache (`XDG_CACHE_HOME`) and state. */
  root: string
  url: string
  password: string
  project: string
  client: ReturnType<typeof OpenCode.make>
  workflow: ReturnType<ReturnType<typeof OpenCode.make>["rpc"]>
  gatewayPort: number
  logs: () => string
  /** Kill the service (default SIGKILL: a crash) and start it again on the same project and database. */
  restart(signal?: NodeJS.Signals): Promise<void>
  stop(): Promise<void>
}

export interface LiveOptions {
  /** Extra plugin options. */
  pluginOptions?: Record<string, unknown>
  /** Files to write into the project, relative path → contents. */
  files?: Record<string, string>
  agents?: string[]
  /** Plugin spec to configure (default: `WF_LIVE_PLUGIN`, else this package by path). */
  plugin?: string
  /** Commit the project files (worktrees check out the committed tree, so the plugin config must be in it). */
  commit?: boolean
}

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response("") })
  const port = server.port!
  server.stop(true)
  return port
}

export async function startLive(options: LiveOptions = {}): Promise<LiveServer> {
  const root = await mkdtemp(path.join(await realTmp(), "wf-live-"))
  const project = path.join(root, "project")
  await mkdir(project, { recursive: true })
  await Bun.$`git init -q`.cwd(project).quiet()
  const gatewayPort = freePort()
  const agents = Object.fromEntries(
    (options.agents ?? ["build", "general", "explore", "plan"]).map((agent) => [agent, { model: LIVE_MODEL }]),
  )
  const plugin = options.plugin ?? process.env.WF_LIVE_PLUGIN ?? PLUGIN_PATH
  await writeFile(
    path.join(project, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        model: LIVE_MODEL,
        agents,
        plugins: [{ package: plugin, options: { gateway: { port: gatewayPort }, ...options.pluginOptions } }],
      },
      null,
      2,
    ),
  )
  for (const [file, contents] of Object.entries(options.files ?? {})) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true })
    await writeFile(path.join(project, file), contents)
  }
  if (options.commit)
    await Bun.$`git add -A && git -c user.email=live@test -c user.name=live commit -qm fixture`.cwd(project).quiet()
  let output = ""
  const boot = async () => {
    const port = freePort()
    const child = Bun.spawn(["opencode", "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"], {
      cwd: project,
      env: {
        ...process.env,
        OPENCODE_DB: path.join(root, "opencode.db"),
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) output += decoder.decode(chunk)
    }
    const mark = output.length
    void pump(child.stdout)
    void pump(child.stderr)
    const deadline = Date.now() + 30_000
    let password = ""
    while (Date.now() < deadline) {
      const tail = output.slice(mark)
      const match = tail.match(/server password (\S+)/)
      if (match && tail.includes("server listening")) {
        password = match[1]!
        break
      }
      await Bun.sleep(100)
    }
    if (!password) {
      child.kill()
      throw new Error(`opencode serve did not start:\n${output.slice(-2000)}`)
    }
    const url = `http://127.0.0.1:${port}`
    const client = OpenCode.make({
      baseUrl: url,
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
        "x-opencode-directory": project,
      },
    })
    return { child, url, password, client, workflow: client.rpc(WorkflowRpc as never) }
  }
  let current = await boot()
  const server: LiveServer = {
    root,
    url: current.url,
    password: current.password,
    project,
    client: current.client,
    workflow: current.workflow,
    gatewayPort,
    logs: () => output,
    async restart(kill = "SIGKILL") {
      current.child.kill(kill)
      await current.child.exited
      current = await boot()
      Object.assign(server, {
        url: current.url,
        password: current.password,
        client: current.client,
        workflow: current.workflow,
      })
    },
    async stop() {
      current.child.kill()
      await current.child.exited
      if (!process.env.WF_LIVE_KEEP) await rm(root, { recursive: true, force: true })
    },
  }
  return server
}

/** `$TMPDIR/opencode` (the approved scratch area), resolved through symlinks so paths match the host's. */
async function realTmp(): Promise<string> {
  const { realpath } = await import("node:fs/promises")
  const dir = path.join(await realpath(os.tmpdir()), "opencode")
  await mkdir(dir, { recursive: true })
  return dir
}

/** Create a driver session, prompt it, wait, and return its transcript. */
export async function drive(
  server: LiveServer,
  text: string,
  title = "live driver",
): Promise<{ sessionID: string; messages: any[] }> {
  const [providerID, id] = LIVE_MODEL.split("/", 2) as [string, string]
  const session = await server.client.session.create({
    title,
    agent: "build",
    model: { providerID, id },
    location: { directory: server.project },
  } as never)
  await server.client.session.prompt({ sessionID: session.id, text } as never)
  await server.client.session.wait({ sessionID: session.id })
  const messages = await server.client.session.context({ sessionID: session.id })
  return { sessionID: session.id, messages: messages as any[] }
}

/** The text of the last tool part with this name in a transcript. */
export function toolOutput(messages: any[], name: string): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]?.content ?? []) {
      if (part.type === "tool" && part.name === name) {
        const content = part.state?.content
        return Array.isArray(content)
          ? content.map((c: any) => c.text ?? "").join("")
          : String(content ?? part.state?.error?.message ?? "")
      }
    }
  }
  return undefined
}

/** Poll until `check` returns a value (or throw after `ms`). */
export async function until<T>(
  check: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  ms = 60_000,
  every = 250,
): Promise<T> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await Bun.sleep(every)
  }
  throw new Error(`timed out after ${ms}ms`)
}

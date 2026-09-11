import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseControlAction, type ControlFailure, type ControlRegistry, type ControlResult } from "./control"
import {
  readDescriptors,
  readEndpointPreference,
  writeEndpointPreference,
  type EndpointDescriptor,
} from "./discovery"
import type { Journal, RunSummary } from "./journal"
import { elideRunOutputs, type RunSnapshot, type RunStore } from "./runs"

export interface EndpointOptions {
  enabled?: boolean
  port?: number
  host?: string
  /**
   * Serve this exact token instead of minting one. The stable-address path reads it from the persisted
   * preference; tests inject it. Never sourced from user config.
   */
  token?: string
  /**
   * Absolute path to the built dashboard, or `false` to serve the API only.
   *
   * Defaults to the packaged dist (the copy `build:dashboard` places inside this package, falling back to the
   * workspace build), with a "run the build" notice at `/` when neither exists — a missing build should say
   * what to run, not 404.
   */
  assets?: string | false
}

/**
 * Where this run is actually happening, stamped onto every merged peer row so a surface can say so.
 *
 * Absent on a row the answering endpoint owns itself: "no origin" IS the local origin, and stamping the local
 * worktree onto every row would make the common case carry the rare case's luggage.
 */
export interface RunOrigin {
  worktree: string
  url: string
}

/**
 * The machine-wide rendezvous, injected so the endpoint can answer `?scope=everywhere` and hold a stable
 * address. With it, the endpoint (1) persists `{ port, token }` per worktree and reuses them across restarts,
 * and (2) reads its live peers' descriptors, merges their `/state` and `/history` into its own under the scope
 * flag, and proxies control actions for runs a peer owns. Without it, the endpoint is exactly the
 * single-process transport it always was.
 */
export interface EndpointDiscovery {
  /** OpenCode's state directory — where descriptors and address preferences live. */
  statePath: string
  /** The project this endpoint serves; the key its stable address is filed under. */
  worktree: string
  /** Injected by tests; peers are loopback, so the default global fetch is the production path. */
  fetch?: typeof globalThis.fetch
  isProcessAlive?: (pid: number) => boolean
}

/**
 * Capabilities the endpoint exposes but does not own.
 *
 * Injected rather than constructed here so the transport stays a thin projection of engine state: the endpoint
 * knows how to authenticate a request and shape a response, and nothing about how a run is stopped. Later
 * phases add members (Phase 3's journal reader, Phase 4's interaction controller) without touching routing.
 */
export interface EndpointDeps {
  control?: ControlRegistry
  /**
   * The durable history reader.
   *
   * Separate from `/state` on purpose: `/state` is a bootstrap payload re-sent on every reconnect, and a
   * project accumulates runs forever. History is a paged read a client asks for when it wants it.
   */
  history?: Pick<Journal, "list" | "read">
  /** See {@link EndpointDiscovery}. Absent in tests that want the plain single-process transport. */
  discovery?: EndpointDiscovery
}

export interface Endpoint {
  url: string
  token: string
  /**
   * Whether the bind is loopback — and therefore whether the token matters.
   *
   * On a loopback bind every route answers without a token (a presented one is still accepted): loopback-only
   * plus same-user is the same trust boundary the host's own `opencode serve` runs inside, and a token on top
   * of it bought a re-handoff dance on every restart, not protection. A non-loopback bind keeps bearer/query
   * token auth on every API route, exactly as before.
   */
  loopback: boolean
  subscribers(): number
  /**
   * Whether any surface is currently listening — the engine's answer to "can a human be asked?".
   *
   * An open SSE connection is the only honest signal available: a TUI, a dashboard tab, and a `curl` all
   * announce themselves the same way, and all three mean somebody could see a question. Read live, per poll,
   * because it changes while a run is in flight.
   */
  attached(): boolean
  stop(): Promise<void>
}

interface SseConnection {
  controller: ReadableStreamDefaultController<Uint8Array>
  requestSignal: AbortSignal
  onAbort: () => void
  heartbeat: ReturnType<typeof setInterval> | null
  closed: boolean
}

const encoder = new TextEncoder()

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"
}

/**
 * Only consulted on a NON-loopback bind. A loopback bind (the default) answers every route bare: the listener
 * is reachable only by processes running as this user on this machine, which is the exact trust boundary the
 * host's own `opencode serve` draws, and which the descriptor files (mode 0600) already assume. A presented
 * token is simply ignored there — accepted, like everything else.
 */
function authorized(request: Request, url: URL, token: string): boolean {
  const header = request.headers.get("authorization")
  return header === `Bearer ${token}` || url.searchParams.get("token") === token
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  })
}

/**
 * HTTP status for a control outcome. The BODY is always the `ControlResult` — the status exists so an
 * intermediary (or a curl-wielding operator) reads the same story the client does, not so the client has to
 * decode two representations of one answer.
 */
const CONTROL_STATUS: Record<ControlFailure, number> = {
  "unknown-run": 404,
  "unknown-unit": 404,
  "unknown-request": 404,
  "not-running": 409,
  conflict: 409,
  unsupported: 400,
}

function controlResponse(result: ControlResult): Response {
  return json(result, result.ok ? 200 : (CONTROL_STATUS[result.reason ?? "unsupported"] ?? 400))
}

/**
 * Where the built dashboard lives when nobody names a path: the copy `build:dashboard` places inside THIS
 * package (the one a published install ships), then the dashboard workspace's own build (the one a source-tree
 * install has). Checked per request rather than at startup, so a `bun run build:dashboard` mid-session starts
 * serving without a host restart.
 */
function defaultAssetRoots(): string[] {
  return [
    fileURLToPath(new URL("../dashboard-dist", import.meta.url)),
    fileURLToPath(new URL("../../dashboard/dist", import.meta.url)),
  ]
}

/**
 * The API's route table, which is also the asset server's exclusion list. Anything here keeps bearer-token
 * auth on a non-loopback bind (a loopback bind — the default — answers everything bare; see `authorized`);
 * anything else is (when assets are enabled) a static file that CARRIES no run state and therefore never
 * needed auth on any bind.
 */
function isApiPath(pathname: string): boolean {
  return (
    pathname === "/health" ||
    pathname === "/state" ||
    pathname === "/events" ||
    pathname === "/control" ||
    pathname === "/history" ||
    pathname.startsWith("/history/")
  )
}

const BUILD_NOTICE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Workflows</title></head>
  <body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; line-height: 1.5">
    <h1 style="font-size: 1.25rem">The dashboard is not built yet</h1>
    <p>The workflow engine is running, but its dashboard assets are missing. From the plugin repository, run:</p>
    <pre style="background: #8881; padding: 0.75rem; border-radius: 6px">bun run build:dashboard</pre>
    <p>then reload this page. The API itself is unaffected.</p>
  </body>
</html>`

/**
 * Serve one static file out of the built dashboard.
 *
 * `/` (and `/index.html`) is the app shell; everything else must resolve to a real file INSIDE the chosen
 * root — the containment check is what keeps an encoded `..` from walking out of the dist directory. Unknown
 * paths are 404, not an index fallback: the app has no client-side router, so a path that names nothing IS
 * nothing.
 */
async function serveAsset(roots: string[], pathname: string): Promise<Response> {
  let root: string | null = null
  for (const candidate of roots) {
    if (await Bun.file(path.join(candidate, "index.html")).exists()) {
      root = candidate
      break
    }
  }
  if (root === null) {
    return pathname === "/" || pathname === "/index.html"
      ? new Response(BUILD_NOTICE, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        })
      : json({ error: "not found" }, 404)
  }

  let relative: string
  try {
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1))
  } catch {
    return json({ error: "not found" }, 404)
  }
  const target = path.resolve(root, relative)
  if (target !== path.resolve(root) && !target.startsWith(path.resolve(root) + path.sep)) {
    return json({ error: "not found" }, 404)
  }
  const file = Bun.file(target)
  if (!(await file.exists())) return json({ error: "not found" }, 404)
  return new Response(file, {
    headers: {
      "content-type": file.type || "application/octet-stream",
      // Vite content-hashes everything under /assets/, so those are immutable by construction; the shell is
      // the one file whose name never changes and must therefore never be cached past a rebuild.
      "cache-control": relative.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    },
  })
}

const RUN_STATUSES: readonly RunSnapshot["status"][] = ["running", "done", "failed", "aborted"]

/** `?status=done&status=failed` and `?status=done,failed` mean the same thing; anything unknown is ignored. */
function historyStatuses(url: URL): RunSnapshot["status"][] {
  return url.searchParams
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value): value is RunSnapshot["status"] => RUN_STATUSES.includes(value as RunSnapshot["status"]))
}

function historyLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit")
  if (raw === null) return undefined
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

/** A run or summary row as the transport serves it — the answering endpoint's own rows carry no `origin`. */
type TaggedRun = RunSnapshot & { origin?: RunOrigin }

export async function startEndpoint(
  store: RunStore,
  options: EndpointOptions = {},
  deps: EndpointDeps = {},
): Promise<Endpoint | null> {
  if (options.enabled === false) return null
  const host = options.host ?? "127.0.0.1"
  const loopback = isLoopbackHost(host)
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535)) {
    throw new Error(`workflow endpoint port must be an integer from 0 to 65535 (got ${String(options.port)})`)
  }

  // The stable address. An explicit `options.port`/`options.token` always wins; the persisted preference
  // covers the no-config case; a first boot binds an ephemeral port and persists whatever the OS assigned.
  const discovery = deps.discovery
  const preference = discovery ? await readEndpointPreference(discovery.statePath, discovery.worktree) : null
  const token =
    options.token ?? preference?.token ?? `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "")
  const preferredPort = options.port ?? preference?.port ?? 0
  const connections = new Set<SseConnection>()
  let revision = 0
  let stopped = false
  let selfUrl = ""

  const peerFetch = discovery?.fetch ?? globalThis.fetch
  /** The machine's other live endpoints — read per request, because peers come and go while this one lives. */
  const peers = async (): Promise<EndpointDescriptor[]> => {
    if (!discovery) return []
    const descriptors = await readDescriptors(
      discovery.statePath,
      discovery.isProcessAlive ? { isProcessAlive: discovery.isProcessAlive } : {},
    ).catch(() => [] as EndpointDescriptor[])
    return descriptors.filter((descriptor) => descriptor.url !== selfUrl)
  }

  /** One peer read, bounded and failure-shaped: a dead or slow peer is `null`, never an error. */
  const peerJson = async (descriptor: EndpointDescriptor, pathAndQuery: string): Promise<unknown> => {
    try {
      const response = await peerFetch(`${descriptor.url}${pathAndQuery}`, {
        headers: { authorization: `Bearer ${descriptor.token}` },
        signal: AbortSignal.timeout(1_500),
      })
      if (!response.ok) return null
      return (await response.json()) as unknown
    } catch {
      return null
    }
  }

  /** Every peer's live runs, each stamped with where it lives. A descriptor whose process died is skipped. */
  const peerRuns = async (): Promise<TaggedRun[]> => {
    const rows = await Promise.all(
      (await peers()).map(async (descriptor) => {
        const body = await peerJson(descriptor, "/state")
        const runs =
          typeof body === "object" && body !== null && Array.isArray((body as { runs?: unknown }).runs)
            ? ((body as { runs: RunSnapshot[] }).runs)
            : []
        return runs.map((run) => ({ ...run, origin: { worktree: descriptor.worktree, url: descriptor.url } }))
      }),
    )
    return rows.flat()
  }

  const closeConnection = (connection: SseConnection, closeStream: boolean) => {
    if (connection.closed) return
    connection.closed = true
    connection.requestSignal.removeEventListener("abort", connection.onAbort)
    if (connection.heartbeat) clearInterval(connection.heartbeat)
    connections.delete(connection)
    if (closeStream) {
      try {
        connection.controller.close()
      } catch {
        // The client may already have cancelled the stream.
      }
    }
  }

  // One store subscription gives every transport event a process-local cursor. The state response includes
  // that cursor, allowing a client to open SSE first, fetch a snapshot, then discard only buffered events the
  // snapshot already contains without losing events emitted during the bootstrap request.
  const unsubscribeStore = store.subscribe((event) => {
    revision += 1
    const payload = encoder.encode(`id: ${revision}\ndata: ${JSON.stringify(event)}\n\n`)
    for (const connection of [...connections]) {
      if (connection.closed) continue
      try {
        connection.controller.enqueue(payload)
      } catch {
        closeConnection(connection, false)
      }
    }
  })

  const serve = (port: number) =>
    Bun.serve({
        hostname: host === "[::1]" ? "::1" : host,
        port,
        // `/events` is a long-lived stream that is idle by design between run transitions, and Bun closes an
        // idle connection after 10 seconds by default — sooner than this endpoint's own 15-second keepalive
        // could refresh it. Every subscriber was therefore dropped roughly every ten seconds and survived
        // only because the TUI client reconnects. Verified against a real host: with the default, an SSE
        // reader receives the ": connected" comment and then "socket connection was closed unexpectedly"
        // before any run event arrives. 0 disables the timeout, which is the correct setting for SSE.
        idleTimeout: 0,
        async fetch(request) {
          const url = new URL(request.url)
          // Asset routes come FIRST and skip auth on every bind: a static file carries no run state, and the
          // app shell must load from a bare link. On a non-loopback bind the link still carries `?token=` for
          // the CLIENT to pick up and replay as a bearer header — the asset server never reads it, so a wrong
          // token still gets the shell and still gets 401 from every API route below.
          if (options.assets !== false && !isApiPath(url.pathname)) {
            if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
            return serveAsset(typeof options.assets === "string" ? [options.assets] : defaultAssetRoots(), url.pathname)
          }
          // Loopback (the default) is tokenless by design — see `authorized` for the trust-boundary argument.
          // Only a deliberately non-loopback bind keeps the bearer/query-token gate.
          if (!loopback && !authorized(request, url, token)) {
            return json({ error: "unauthorized" }, 401)
          }
          // The one non-GET route. Checked before the GET guard so `GET /control` is a method error rather
          // than a 404 — the difference between "you called it wrong" and "it isn't there".
          if (url.pathname === "/control") {
            if (request.method !== "POST") return json({ error: "method not allowed" }, 405)
            if (!deps.control) return controlResponse({ ok: false, reason: "unsupported" })
            const body = await request.json().catch(() => null)
            const action = parseControlAction(body)
            if (!action) return json({ ok: false, reason: "unsupported", error: "malformed action" }, 400)
            const result = await deps.control.dispatch(action)
            // A run (or request) this process has never heard of may be a PEER's: the dashboard's `everywhere`
            // scope shows foreign runs, and their controls land here. Forward the same action to each live
            // peer and relay the first real answer. `proxied=1` stops two endpoints bouncing an id neither
            // owns back and forth; a dead peer is skipped, exactly like the state merge.
            const foreign =
              !result.ok && (result.reason === "unknown-run" || result.reason === "unknown-request")
            if (foreign && discovery && url.searchParams.get("proxied") !== "1") {
              for (const descriptor of await peers()) {
                let answer: ControlResult | null = null
                try {
                  const forwarded = await peerFetch(`${descriptor.url}/control?proxied=1`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
                    body: JSON.stringify(action),
                    signal: AbortSignal.timeout(2_000),
                  })
                  const parsed: unknown = await forwarded.json().catch(() => null)
                  answer =
                    typeof parsed === "object" && parsed !== null && "ok" in parsed ? (parsed as ControlResult) : null
                } catch {
                  answer = null
                }
                if (
                  answer &&
                  !(answer.ok === false && (answer.reason === "unknown-run" || answer.reason === "unknown-request"))
                ) {
                  return controlResponse(answer)
                }
              }
            }
            return controlResponse(result)
          }
          if (request.method !== "GET") return json({ error: "method not allowed" }, 405)
          if (url.pathname === "/health") return json({ ok: true })
          // The shape is untouched — `{ runs, revision }`, every run, every unit, every field a reader knows
          // about. What is not here is the unit ANSWERS: this payload is re-sent whole on every reconnect and
          // carries every run the process still holds, so a session that ran ten research workflows was
          // re-shipping a few hundred kilobytes of prose to a screen that shows one row per run. The answers
          // live in the journal and are read one at a time through `/history/<runId>`; each unit that had one
          // says so with `outputElided`, so nothing has to guess whether a unit produced nothing.
          if (url.pathname === "/state") {
            const local: TaggedRun[] = store.list().map(elideRunOutputs)
            if (url.searchParams.get("scope") !== "everywhere" || !discovery) return json({ runs: local, revision })
            // `everywhere`, merged SERVER-side: the browser holds one connection and this endpoint does the
            // legwork its peers' descriptors make possible. Local rows win an id collision (they are the
            // freshest fact about a run this process owns); the `revision` stays this endpoint's own cursor,
            // because SSE only ever streams this endpoint's events.
            const merged = [...local]
            const seen = new Set(local.map((run) => run.runId))
            for (const run of await peerRuns()) {
              if (seen.has(run.runId)) continue
              seen.add(run.runId)
              merged.push(run)
            }
            return json({ runs: merged, revision })
          }
          if (url.pathname === "/history") {
            const status = historyStatuses(url)
            // An engine with no journal (no project root) has no history rather than an error: the client's
            // history section is simply empty, which is the truth.
            const local: (RunSummary & { origin?: RunOrigin })[] = deps.history
              ? await deps.history.list({
                  ...(historyLimit(url) === undefined ? {} : { limit: historyLimit(url) }),
                  ...(status.length > 0 ? { status } : {}),
                })
              : []
            if (url.searchParams.get("scope") !== "everywhere" || !discovery) return json({ history: local })
            const forward = new URLSearchParams()
            for (const [key, value] of url.searchParams) if (key === "limit" || key === "status") forward.append(key, value)
            const query = forward.toString() ? `?${forward.toString()}` : ""
            const merged = [...local]
            const seen = new Set(local.map((summary) => summary.runId))
            for (const descriptor of await peers()) {
              const body = await peerJson(descriptor, `/history${query}`)
              const rows =
                typeof body === "object" && body !== null && Array.isArray((body as { history?: unknown }).history)
                  ? ((body as { history: RunSummary[] }).history)
                  : []
              for (const summary of rows) {
                if (seen.has(summary.runId)) continue
                seen.add(summary.runId)
                merged.push({ ...summary, origin: { worktree: descriptor.worktree, url: descriptor.url } })
              }
            }
            merged.sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
            return json({ history: merged })
          }
          if (url.pathname.startsWith("/history/")) {
            const runId = decodeURIComponent(url.pathname.slice("/history/".length))
            if (runId.length === 0) return json({ error: "not found" }, 404)
            const record = deps.history ? await deps.history.read(runId) : null
            if (record) return json({ record })
            // A record this journal lacks may be a PEER's — a foreign row the `everywhere` scope showed still
            // has to open. Same guard and same resilience as the control proxy: `proxied=1` stops a bounce,
            // and a dead peer is skipped rather than surfaced.
            if (discovery && url.searchParams.get("proxied") !== "1") {
              for (const descriptor of await peers()) {
                const body = await peerJson(descriptor, `/history/${encodeURIComponent(runId)}?proxied=1`)
                if (typeof body === "object" && body !== null && "record" in body) return json(body)
              }
            }
            return json({ error: "not found" }, 404)
          }
          if (url.pathname !== "/events") return json({ error: "not found" }, 404)

          let connection: SseConnection | undefined
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const onAbort = () => {
                if (connection) closeConnection(connection, true)
              }
              connection = { controller, requestSignal: request.signal, onAbort, heartbeat: null, closed: false }
              connections.add(connection)
              request.signal.addEventListener("abort", onAbort, { once: true })
              controller.enqueue(encoder.encode(": connected\n\n"))
              connection.heartbeat = setInterval(() => {
                if (!connection || connection.closed) return
                try {
                  controller.enqueue(encoder.encode(": keepalive\n\n"))
                } catch {
                  closeConnection(connection, false)
                }
              }, 15_000)
              if (stopped || request.signal.aborted) closeConnection(connection, true)
            },
            cancel() {
              if (connection) closeConnection(connection, false)
            },
          })

          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache, no-transform",
              connection: "keep-alive",
              "x-accel-buffering": "no",
              "x-content-type-options": "nosniff",
            },
          })
        },
      })

  let server: ReturnType<typeof serve>
  let boundPreferred = true
  try {
    server = serve(preferredPort)
  } catch (error) {
    // The persisted port can be held by a second live host in the same project (or by anything else). The
    // holder keeps the stable address; this process falls back to an ephemeral port WITHOUT overwriting the
    // preference, so the next single-host boot returns to it. An EXPLICIT `options.port` still fails loudly —
    // silently moving a configured port would be lying to the config.
    const fallback = options.port === undefined && preferredPort !== 0
    if (!fallback) {
      unsubscribeStore()
      throw error
    }
    boundPreferred = false
    try {
      server = serve(0)
    } catch (second) {
      unsubscribeStore()
      throw second
    }
  }
  server.unref()

  const urlHost = host === "::1" || host === "[::1]" ? "[::1]" : host
  const boundPort = server.port ?? 0 // Bun types allow a portless (unix-socket) server; this one is always TCP
  const url = `http://${urlHost}:${boundPort}`
  selfUrl = url

  // Persist the stable address on the boot that owns it: the first boot (which just learned its OS-assigned
  // port), or one whose preference drifted. The fallback boot never writes — see above. A failed write costs
  // stability across restarts, never the endpoint itself.
  if (
    discovery &&
    boundPreferred &&
    boundPort > 0 &&
    (preference === null || preference.port !== boundPort || preference.token !== token)
  ) {
    try {
      await writeEndpointPreference(discovery.statePath, discovery.worktree, { port: boundPort, token })
    } catch {
      // A read-only state directory must not take the endpoint down with it.
    }
  }

  return {
    url,
    token,
    loopback,
    subscribers: () => connections.size,
    attached: () => !stopped && connections.size > 0,
    async stop() {
      if (stopped) return
      stopped = true
      unsubscribeStore()
      for (const connection of [...connections]) closeConnection(connection, true)
      await server.stop(true)
    },
  }
}

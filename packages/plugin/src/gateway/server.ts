/**
 * The Gateway — protocol v1 over HTTP + SSE for the web app and third parties.
 *
 * A process-wide singleton (P0 S5): every location's plugin instance registers its workflow service with the one
 * listener. It never belongs to a plugin instance, so a reload or a leaked instance cannot take it down.
 *
 * Security (plan §9):
 * - Binds loopback by default; LAN / Tailscale / an explicit IP only by configuration.
 * - `Host` must be one we serve (DNS-rebinding defence); `Origin`, when present on a write, must be ours or an
 *   explicitly allowed origin (CSRF defence). CORS headers only for allowed origins.
 * - Reads need no token only from a loopback client; every control action needs a bearer token with `control`
 *   scope. Tokens never travel in URLs. A loopback browser on the Gateway's own origin can self-pair.
 * - Strict CSP, `nosniff`, `no-referrer` on everything served; a simple rate limit on writes; control actions are
 *   written to the Run's activity as an audit trail.
 */
import { existsSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { engineGlobal } from "../engine-global"
import {
  ListRunsInput,
  PROTOCOL_VERSION,
  ReplyInteractionInput,
  StartRunInput,
  WorkflowProtocolError,
  type LibraryEntry,
  type ProtocolErrorCode,
  type ProtocolEvent,
} from "../protocol"
import { elideEvent } from "../runs"
import type { GatewayConfig } from "../service/config"
import { PLUGIN_NAME, PLUGIN_VERSION, type WorkflowService } from "../service/service"
import { bearer, createTokenStore, isLoopbackAddress, type Scope, type TokenStore } from "./auth"

export interface GatewayHandle {
  url: string
  host: string
  port: number
  register(location: string, service: WorkflowService): () => void
  /** Is a web client subscribed to this location's events right now? */
  attached(location: string): boolean
  createPairingCode(): { code: string; expiresAt: number; url: string }
  tokens: TokenStore
  stop(): Promise<void>
}

export interface GatewayOptions {
  tokenFile?: string
  webDir?: string
}

const GATEWAY_KEY = "gateway"
const GATEWAY_PROMISE_KEY = "gateway:starting"

const STATUS: Record<ProtocolErrorCode, number> = {
  not_found: 404,
  conflict: 409,
  invalid_args: 400,
  invalid_state: 409,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  unsupported: 501,
  internal: 500,
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
}

const HTML_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"

export function defaultWebDir(): string {
  return path.join(import.meta.dir, "..", "..", "dist", "web")
}

/** Resolve the configured bind to an address. `tailscale` picks the machine's 100.64.0.0/10 address. */
export function resolveBind(bind: string): string {
  if (bind === "loopback") return "127.0.0.1"
  if (bind === "lan") return "0.0.0.0"
  if (bind === "tailscale") {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family !== "IPv4") continue
        const [a, b] = address.address.split(".").map(Number)
        if (a === 100 && b !== undefined && b >= 64 && b <= 127) return address.address
      }
    }
    throw new Error("gateway.bind is \"tailscale\" but no Tailscale (100.64.0.0/10) address was found")
  }
  return bind
}

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra },
  })
}

function fail(code: ProtocolErrorCode, message: string, extra: Record<string, string> = {}): Response {
  return json({ error: { code, message, retryable: code === "rate_limited" || code === "internal" } }, STATUS[code], extra)
}

async function body(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.length > 1_000_000) throw new WorkflowProtocolError("invalid_args", "request body too large")
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new WorkflowProtocolError("invalid_args", "request body is not JSON")
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
}

export async function startGateway(config: GatewayConfig, options: GatewayOptions = {}): Promise<GatewayHandle> {
  const tokens = await createTokenStore(options.tokenFile)
  const webDir = options.webDir ?? defaultWebDir()
  const hostname = resolveBind(config.bind)
  const loopbackBind = hostname === "127.0.0.1" || hostname === "::1"
  const services = new Map<string, WorkflowService>()
  const subscribers = new Map<string, number>()
  const writes = new Map<string, { windowStart: number; count: number }>()

  let server: ReturnType<typeof Bun.serve> | undefined
  let lastError: unknown
  for (let offset = 0; offset < 20 && !server; offset++) {
    const port = config.port === 0 ? 0 : config.port + offset
    try {
      server = Bun.serve({ hostname, port, idleTimeout: 0, fetch: (request, srv) => route(request, srv) })
    } catch (error) {
      lastError = error
      if (config.port === 0) break
    }
  }
  if (!server) throw lastError instanceof Error ? lastError : new Error("the gateway could not bind a port")
  const port = server.port!
  const publicHost = hostname === "0.0.0.0" ? "127.0.0.1" : hostname
  const url = `http://${publicHost.includes(":") ? `[${publicHost}]` : publicHost}:${port}`
  const ownOrigins = new Set([url, `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`])
  const allowedOrigins = new Set([...ownOrigins, ...config.allowedOrigins])
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `${publicHost}:${port}`, ...config.allowedOrigins.map((origin) => { try { return new URL(origin).host } catch { return "" } }).filter(Boolean)])
  if (hostname === "0.0.0.0") {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses ?? []) if (address.family === "IPv4") allowedHosts.add(`${address.address}:${port}`)
    }
  }

  const serviceFor = (location: string | null): WorkflowService => {
    if (location) {
      const service = services.get(location)
      if (!service) throw new WorkflowProtocolError("not_found", `No workflow service for location ${location}.`)
      return service
    }
    if (services.size === 1) return [...services.values()][0]!
    throw new WorkflowProtocolError("invalid_args", "Several locations are served; pass ?location=<directory>.", {
      details: { locations: [...services.keys()] },
    })
  }

  const serviceForRun = async (runId: string): Promise<WorkflowService> => {
    for (const service of services.values()) if (service.deps.store.get(runId)) return service
    for (const service of services.values()) if (await service.deps.journal.read(runId)) return service
    throw new WorkflowProtocolError("not_found", `No Run "${runId}".`)
  }

  const audit = (service: WorkflowService, runId: string, action: string, who: string) => {
    try {
      if (service.deps.store.get(runId)) service.deps.store.apply({ type: "run.log", runId, value: `control: ${action} (${who})`, kind: "engine" })
    } catch {
      // The Run may be journal-only.
    }
  }

  const rateLimited = (client: string): boolean => {
    const now = Date.now()
    const entry = writes.get(client)
    if (!entry || now - entry.windowStart > 60_000) {
      writes.set(client, { windowStart: now, count: 1 })
      return false
    }
    entry.count += 1
    return entry.count > 120
  }

  function cors(request: Request): Record<string, string> {
    const origin = request.headers.get("origin")
    if (!origin || ownOrigins.has(origin) || !allowedOrigins.has(origin)) return {}
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type, last-event-id",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "origin",
    }
  }

  function staticFile(pathname: string): Response {
    if (!config.web) return fail("not_found", "The web app is disabled (gateway.web: false).")
    const root = path.resolve(webDir)
    const indexFile = path.join(root, "index.html")
    if (!existsSync(indexFile)) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Workflows</title><body style="font-family:system-ui;padding:2rem"><h1>Workflows</h1><p>The web app is not built. Run <code>bun run build</code> in the plugin package. The API is at <code>/v1</code>.</p></body>`,
        { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": HTML_CSP, ...SECURITY_HEADERS } },
      )
    }
    const candidate = path.resolve(root, `.${decodeURIComponent(pathname)}`)
    const file = candidate.startsWith(root + path.sep) && existsSync(candidate) && statSync(candidate).isFile() ? candidate : indexFile
    const extension = path.extname(file)
    return new Response(Bun.file(file), {
      headers: {
        "content-type": MIME[extension] ?? "application/octet-stream",
        "cache-control": file === indexFile ? "no-store" : "public, max-age=31536000, immutable",
        ...(extension === ".html" ? { "content-security-policy": HTML_CSP } : {}),
        ...SECURITY_HEADERS,
      },
    })
  }

  function events(request: Request, service: WorkflowService, lastEventId: number | null): Response {
    const location = service.location
    let unsubscribe = () => {}
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        subscribers.set(location, (subscribers.get(location) ?? 0) + 1)
        const send = (event: ProtocolEvent) => controller.enqueue(encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(elideEvent(event))}\n\n`))
        controller.enqueue(encoder.encode(`retry: 2000\n: ${PLUGIN_NAME} protocol ${PROTOCOL_VERSION}\n\n`))
        if (lastEventId !== null) {
          const tail = service.eventsSince(lastEventId)
          if (!tail.complete) {
            controller.enqueue(encoder.encode(`event: resync.required\ndata: ${JSON.stringify({ protocol: PROTOCOL_VERSION, seq: tail.latest, time: Date.now(), location, runId: "", type: "resync.required", revision: 0, data: { reason: "events were missed" } })}\n\n`))
          } else for (const event of tail.events) send(event)
        }
        unsubscribe = service.deps.store.subscribe((event) => {
          try {
            send(event)
          } catch {
            unsubscribe()
          }
        })
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: keep-alive ${Date.now()}\n\n`))
          } catch {
            clearInterval(heartbeat)
          }
        }, 15_000)
      },
      cancel() {
        unsubscribe()
        if (heartbeat) clearInterval(heartbeat)
        subscribers.set(location, Math.max(0, (subscribers.get(location) ?? 1) - 1))
      },
    })
    request.signal.addEventListener("abort", () => {
      unsubscribe()
      if (heartbeat) clearInterval(heartbeat)
    })
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no", ...SECURITY_HEADERS, ...cors(request) },
    })
  }

  async function route(request: Request, srv: { requestIP(request: Request): { address: string } | null }): Promise<Response> {
    const url = new URL(request.url)
    const host = request.headers.get("host") ?? ""
    if (!allowedHosts.has(host)) return fail("forbidden", `Host "${host}" is not served here.`)
    const client = srv.requestIP(request)?.address ?? ""
    const loopbackClient = isLoopbackAddress(client)
    const origin = request.headers.get("origin")
    const extra = cors(request)
    if (request.method === "OPTIONS") return new Response(null, { status: allowedOrigins.has(origin ?? "") ? 204 : 403, headers: { ...extra, ...SECURITY_HEADERS } })
    if (!url.pathname.startsWith("/v1/")) {
      if (request.method !== "GET") return fail("not_found", "no such route")
      // Anyone who can reach the Gateway gets the app shell; the API behind it still enforces tokens.
      return staticFile(url.pathname === "/" ? "/index.html" : url.pathname)
    }

    const isWrite = request.method === "POST"
    if (isWrite && origin && !allowedOrigins.has(origin)) return fail("forbidden", `Origin ${origin} is not allowed.`, extra)
    const token = bearer(request)
    const device = token ? tokens.verify(token) : null
    if (token && !device) return fail("unauthorized", "Unknown or revoked token.", extra)
    const noAuth = config.auth === "none" && loopbackBind && loopbackClient
    const allowed = (scope: Scope) => noAuth || (device?.scopes.includes(scope) ?? false) || (scope === "read" && loopbackClient)
    const who = device ? `device ${device.name}` : loopbackClient ? "loopback" : client

    try {
      // Pairing — the only writes that need no token.
      if (url.pathname === "/v1/pair" && isWrite) {
        if (rateLimited(`pair:${client}`)) return fail("rate_limited", "Too many attempts.", extra)
        const input = (await body(request)) as { code?: unknown; name?: unknown }
        const issued = await tokens.redeem(String(input.code ?? ""), String(input.name ?? "browser"))
        if (!issued) return fail("unauthorized", "That pairing code is invalid or expired.", extra)
        return json({ token: issued.token, id: issued.id }, 200, extra)
      }
      if (url.pathname === "/v1/pair/local" && isWrite) {
        // A browser on this machine, on the Gateway's own origin: the only party that can make this request.
        if (!loopbackClient || !origin || !ownOrigins.has(origin)) return fail("forbidden", "Local pairing is only available to a browser on this machine.", extra)
        const issued = await tokens.issue("local browser", ["read", "control"])
        return json({ token: issued.token, id: issued.id }, 200, extra)
      }

      if (isWrite) {
        if (!allowed("control")) return fail(device ? "forbidden" : "unauthorized", "Control actions need a bearer token with control scope.", extra)
        if (rateLimited(client)) return fail("rate_limited", "Too many control requests; slow down.", extra)
      } else if (!allowed("read")) {
        return fail("unauthorized", "Remote reads need a bearer token.", extra)
      }

      const parts = url.pathname.split("/").filter(Boolean).slice(1) // after "v1"
      const location = url.searchParams.get("location")

      if (request.method === "GET") {
        if (parts[0] === "info" && parts.length === 1) {
          return json({
            protocol: PROTOCOL_VERSION,
            plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
            locations: [...services.values()].map((service) => ({ location: service.location, info: service.info() })),
            auth: { device: device ? { id: device.id, name: device.name, scopes: device.scopes } : null, loopback: loopbackClient },
          }, 200, extra)
        }
        if (parts[0] === "events" && parts.length === 1) {
          const header = request.headers.get("last-event-id") ?? url.searchParams.get("after")
          const after = header !== null && /^\d+$/.test(header) ? Number(header) : null
          return events(request, serviceFor(location), after)
        }
        if (parts[0] === "workflows" && parts.length === 1) return json(await serviceFor(location).listWorkflows(), 200, extra)
        if (parts[0] === "runs" && parts.length === 1) {
          const input = ListRunsInput.parse({
            ...(url.searchParams.getAll("status").length ? { status: url.searchParams.getAll("status") } : {}),
            ...(url.searchParams.get("search") ? { search: url.searchParams.get("search") } : {}),
            ...(url.searchParams.get("parentSessionID") ? { parentSessionID: url.searchParams.get("parentSessionID") } : {}),
            ...(url.searchParams.get("since") ? { since: Number(url.searchParams.get("since")) } : {}),
            ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
          })
          const targets = location ? [serviceFor(location)] : [...services.values()]
          const runs: LibraryEntry[] = (await Promise.all(targets.map((service) => service.listRuns(input)))).flat()
          runs.sort((a, b) => b.startedAt - a.startedAt)
          return json({ runs: runs.slice(0, input.limit ?? 200) }, 200, extra)
        }
        if (parts[0] === "runs" && parts[1]) {
          const service = await serviceForRun(parts[1])
          if (parts.length === 2) return json(await service.getRun(parts[1]), 200, extra)
          if (parts[2] === "result" && parts.length === 3) return json(await service.getResult(parts[1]), 200, extra)
          if (parts[2] === "activity" && parts.length === 3) return json({ entries: await service.getActivity(parts[1]) }, 200, extra)
          if (parts[2] === "units" && parts[3] && parts.length === 4) return json({ unit: await service.getUnit(parts[1], parts[3]) }, 200, extra)
        }
        return fail("not_found", "no such route", extra)
      }

      if (request.method === "POST") {
        if (parts[0] === "runs" && parts.length === 1) {
          const input = StartRunInput.parse(await body(request))
          const service = serviceFor(location)
          const started = await service.startRun(input, { background: true, surface: `the web app (${who})` })
          audit(service, started.runId, "start", who)
          return json({ runId: started.runId }, 202, extra)
        }
        if (parts[0] === "runs" && parts[1]) {
          const runId = parts[1]
          const service = await serviceForRun(runId)
          const action = parts.slice(2).join("/")
          if (action === "stop") {
            audit(service, runId, "stop run", who)
            service.stopRun(runId, `stopped from the web app (${who})`)
            return json({ ok: true }, 200, extra)
          }
          if (action === "resume") {
            const input = (await body(request)) as { rerunFailed?: boolean }
            const started = await service.resumeRun(runId, input.rerunFailed !== false, { background: true, surface: `the web app (${who})` })
            return json({ runId: started.runId }, 202, extra)
          }
          if (action === "save") {
            const input = (await body(request)) as { name?: string }
            return json(await service.saveRun(runId, typeof input.name === "string" ? input.name : undefined), 200, extra)
          }
          if (action === "cleanup") {
            const input = (await body(request)) as { deleted?: string[] }
            return json(await service.cleanupRun(runId, Array.isArray(input.deleted) ? input.deleted.map(String) : []), 200, extra)
          }
          if (parts[2] === "units" && parts[3] && parts.length === 5 && (parts[4] === "stop" || parts[4] === "restart")) {
            audit(service, runId, `${parts[4]} unit`, who)
            if (parts[4] === "stop") service.stopUnit(runId, parts[3])
            else await service.restartUnit(runId, parts[3])
            return json({ ok: true }, 200, extra)
          }
          if (parts[2] === "interactions" && parts[3] && parts.length === 5) {
            if (parts[4] === "reply") {
              const input = ReplyInteractionInput.parse({ ...(await body(request) as object), runId, interactionId: parts[3] })
              await service.replyInteraction(runId, parts[3], input.answers)
              audit(service, runId, "answer interaction", who)
              return json({ ok: true }, 200, extra)
            }
            if (parts[4] === "cancel") {
              await service.cancelInteraction(runId, parts[3])
              audit(service, runId, "dismiss interaction", who)
              return json({ ok: true }, 200, extra)
            }
          }
        }
        return fail("not_found", "no such route", extra)
      }
      return fail("not_found", "no such route", extra)
    } catch (error) {
      if (error instanceof WorkflowProtocolError) return json({ error: error.toJSON() }, STATUS[error.code], extra)
      if (error && typeof error === "object" && "issues" in error) return fail("invalid_args", `invalid request: ${String((error as unknown as Error).message)}`, extra)
      return fail("internal", error instanceof Error ? error.message : String(error), extra)
    }
  }

  const gateway: GatewayHandle = {
    url,
    host: hostname,
    port,
    tokens,
    register(location, service) {
      services.set(location, service)
      return () => {
        if (services.get(location) === service) services.delete(location)
      }
    },
    attached(location) {
      return (subscribers.get(location) ?? 0) > 0
    },
    createPairingCode() {
      return { ...tokens.createPairingCode(), url }
    },
    async stop() {
      server?.stop(true)
    },
  }
  return gateway
}

/** The process-wide Gateway: started once, shared by every location instance. */
export async function ensureGateway(config: GatewayConfig, options: GatewayOptions = {}): Promise<GatewayHandle> {
  const singletons = engineGlobal().singletons
  const existing = singletons.get(GATEWAY_KEY) as GatewayHandle | undefined
  if (existing) return existing
  let starting = singletons.get(GATEWAY_PROMISE_KEY) as Promise<GatewayHandle> | undefined
  if (!starting) {
    starting = startGateway(config, options).then((handle) => {
      singletons.set(GATEWAY_KEY, handle)
      return handle
    })
    singletons.set(GATEWAY_PROMISE_KEY, starting)
    starting.catch(() => singletons.delete(GATEWAY_PROMISE_KEY))
  }
  return starting
}

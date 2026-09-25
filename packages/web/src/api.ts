/**
 * The Gateway client (same origin). Auth rules (plan §9):
 * - Loopback reads need no token; remote reads and every POST need `Authorization: Bearer <token>`.
 * - Tokens live in localStorage and only ever travel in that header — never in a URL.
 * - A browser on the Gateway's own machine and origin pairs itself (`POST /v1/pair/local`) on its first control
 *   action; anyone else redeems a pairing code shown by the TUI (`POST /v1/pair`).
 * - A token the Gateway no longer knows (revoked, or a different Gateway state dir) is dropped and, when local
 *   pairing is possible, replaced once.
 */
import type {
  ActivityEntry,
  InfoOutput,
  LibraryEntry,
  ListWorkflowsOutput,
  ProtocolErrorCode,
  Run,
  RunStatus,
  StartRunInput,
  Unit,
} from "opencode-dynamic-workflows/protocol"

export class ApiError extends Error {
  readonly status: number
  readonly code: ProtocolErrorCode | "network"
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  constructor(status: number, code: ApiError["code"], message: string, retryable = false, details?: Record<string, unknown>) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.retryable = retryable
    this.details = details
  }
  /** The caller has to pair (enter a code) before this can succeed. */
  get needsPairing(): boolean {
    return this.code === "unauthorized"
  }
}

export interface TokenStorage {
  get(): string | null
  set(token: string | null): void
}

export const TOKEN_KEY = "opencode-dynamic-workflows.gateway-token"

export function localTokenStorage(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = globalThis.localStorage): TokenStorage {
  let memory: string | null = null
  return {
    get() {
      try {
        return storage?.getItem(TOKEN_KEY) ?? memory
      } catch {
        return memory
      }
    },
    set(token) {
      memory = token
      try {
        if (token) storage?.setItem(TOKEN_KEY, token)
        else storage?.removeItem(TOKEN_KEY)
      } catch {
        // Private mode: keep it in memory for this tab.
      }
    },
  }
}

export interface GatewayInfo {
  protocol: number
  plugin: { name: string; version: string }
  locations: { location: string; info: InfoOutput }[]
  auth: { device: { id: string; name: string; scopes: string[] } | null; loopback: boolean }
}

export interface ListRunsQuery {
  location?: string
  status?: RunStatus[]
  search?: string
  limit?: number
}

export interface Api {
  readonly tokens: TokenStorage
  authHeaders(): Record<string, string>
  info(): Promise<GatewayInfo>
  listRuns(query?: ListRunsQuery): Promise<LibraryEntry[]>
  getRun(runId: string): Promise<{ run: Run; live: boolean }>
  getResult(runId: string): Promise<{ runId: string; status: RunStatus; result: unknown }>
  getActivity(runId: string): Promise<ActivityEntry[]>
  getUnit(runId: string, unitId: string): Promise<Unit>
  listWorkflows(location: string): Promise<ListWorkflowsOutput>
  startRun(location: string, input: StartRunInput): Promise<{ runId: string }>
  stopRun(runId: string): Promise<void>
  resumeRun(runId: string, rerunFailed?: boolean): Promise<{ runId: string }>
  saveRun(runId: string, name?: string): Promise<{ key: string; path: string }>
  cleanupRun(runId: string): Promise<{ deleted: number; pending: number }>
  stopUnit(runId: string, unitId: string): Promise<void>
  restartUnit(runId: string, unitId: string): Promise<void>
  reply(runId: string, interactionId: string, answers: string[][]): Promise<void>
  cancel(runId: string, interactionId: string): Promise<void>
  pair(code: string, name: string): Promise<void>
  pairLocal(): Promise<void>
  eventsUrl(location: string): string
}

export interface ApiOptions {
  base?: string
  fetch?: typeof fetch
  tokens?: TokenStorage
}

const enc = encodeURIComponent

export function createApi(options: ApiOptions = {}): Api {
  const base = options.base ?? ""
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const tokens = options.tokens ?? localTokenStorage()

  const authHeaders = (): Record<string, string> => {
    const token = tokens.get()
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  async function send(method: "GET" | "POST", path: string, body?: unknown, auth = true): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json", ...(auth ? authHeaders() : {}) }
    if (method === "POST") headers["content-type"] = "application/json"
    try {
      return await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        cache: "no-store",
      })
    } catch (error) {
      throw new ApiError(0, "network", `The Gateway is unreachable (${error instanceof Error ? error.message : String(error)}).`, true)
    }
  }

  async function decode<T>(response: Response): Promise<T> {
    const text = await response.text()
    let parsed: unknown = undefined
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (!response.ok) {
      const error = (parsed as { error?: { code?: string; message?: string; retryable?: boolean; details?: Record<string, unknown> } } | undefined)?.error
      throw new ApiError(
        response.status,
        (error?.code as ProtocolErrorCode | undefined) ?? (response.status === 401 ? "unauthorized" : response.status === 404 ? "not_found" : "internal"),
        error?.message ?? `HTTP ${response.status}`,
        error?.retryable ?? response.status >= 500,
        error?.details,
      )
    }
    return parsed as T
  }

  async function pairLocal(): Promise<void> {
    const response = await send("POST", "/v1/pair/local", {}, false)
    const { token } = await decode<{ token: string }>(response)
    tokens.set(token)
  }

  async function read<T>(path: string): Promise<T> {
    let response = await send("GET", path)
    if (response.status === 401 && tokens.get()) {
      // A token the Gateway does not know: drop it; loopback reads work without one.
      tokens.set(null)
      response = await send("GET", path)
    }
    return decode<T>(response)
  }

  async function control<T>(path: string, body?: unknown): Promise<T> {
    let paired = false
    if (!tokens.get()) {
      await tryLocalPairing()
      paired = true
    }
    let response = await send("POST", path, body)
    if (response.status === 401 && !paired) {
      tokens.set(null)
      await tryLocalPairing()
      response = await send("POST", path, body)
    }
    return decode<T>(response)
  }

  async function tryLocalPairing(): Promise<void> {
    try {
      await pairLocal()
    } catch (error) {
      if (error instanceof ApiError && (error.code === "forbidden" || error.code === "unauthorized")) {
        throw new ApiError(401, "unauthorized", "This browser is not paired. Enter a pairing code from the TUI to control Runs.")
      }
      throw error
    }
  }

  const post = <T>(path: string, body?: unknown) => control<T>(path, body)

  return {
    tokens,
    authHeaders,
    info: () => read<GatewayInfo>("/v1/info"),
    async listRuns(query = {}) {
      const params = new URLSearchParams()
      if (query.location) params.set("location", query.location)
      for (const status of query.status ?? []) params.append("status", status)
      if (query.search) params.set("search", query.search)
      if (query.limit) params.set("limit", String(query.limit))
      const qs = params.toString()
      return (await read<{ runs: LibraryEntry[] }>(`/v1/runs${qs ? `?${qs}` : ""}`)).runs
    },
    getRun: (runId) => read(`/v1/runs/${enc(runId)}`),
    getResult: (runId) => read(`/v1/runs/${enc(runId)}/result`),
    async getActivity(runId) {
      return (await read<{ entries: ActivityEntry[] }>(`/v1/runs/${enc(runId)}/activity`)).entries
    },
    async getUnit(runId, unitId) {
      return (await read<{ unit: Unit }>(`/v1/runs/${enc(runId)}/units/${enc(unitId)}`)).unit
    },
    listWorkflows: (location) => read(`/v1/workflows?location=${enc(location)}`),
    startRun: (location, input) => post(`/v1/runs?location=${enc(location)}`, input),
    async stopRun(runId) {
      await post(`/v1/runs/${enc(runId)}/stop`)
    },
    resumeRun: (runId, rerunFailed = true) => post(`/v1/runs/${enc(runId)}/resume`, { rerunFailed }),
    saveRun: (runId, name) => post(`/v1/runs/${enc(runId)}/save`, name ? { name } : {}),
    cleanupRun: (runId) => post(`/v1/runs/${enc(runId)}/cleanup`),
    async stopUnit(runId, unitId) {
      await post(`/v1/runs/${enc(runId)}/units/${enc(unitId)}/stop`)
    },
    async restartUnit(runId, unitId) {
      await post(`/v1/runs/${enc(runId)}/units/${enc(unitId)}/restart`)
    },
    async reply(runId, interactionId, answers) {
      await post(`/v1/runs/${enc(runId)}/interactions/${enc(interactionId)}/reply`, { answers })
    },
    async cancel(runId, interactionId) {
      await post(`/v1/runs/${enc(runId)}/interactions/${enc(interactionId)}/cancel`)
    },
    async pair(code, name) {
      const response = await send("POST", "/v1/pair", { code, name }, false)
      const { token } = await decode<{ token: string }>(response)
      tokens.set(token)
    },
    pairLocal,
    eventsUrl: (location) => `${base}/v1/events?location=${enc(location)}`,
  }
}

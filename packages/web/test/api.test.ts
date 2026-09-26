import { describe, expect, test } from "bun:test"

import { ApiError, createApi, type TokenStorage } from "../src/api"

function memoryTokens(initial: string | null = null): TokenStorage & { value: string | null } {
  const store = {
    value: initial,
    get: () => store.value,
    set: (token: string | null) => {
      store.value = token
    },
  }
  return store
}

type Handler = (
  method: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
) => Response | Promise<Response>

function fakeFetch(handler: Handler) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = []
  const fn = (async (url: string, init: RequestInit = {}) => {
    const headers = { ...(init.headers as Record<string, string>) }
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    const method = init.method ?? "GET"
    calls.push({ method, url, headers, body })
    return handler(method, url, headers, body)
  }) as unknown as typeof fetch
  return { fn, calls }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const error = (code: string, status: number) => json({ error: { code, message: code, retryable: false } }, status)

describe("api", () => {
  test("loopback reads send no token when none is stored, and tokens never go in URLs", async () => {
    const tokens = memoryTokens()
    const { fn, calls } = fakeFetch(() => json({ runs: [] }))
    const api = createApi({ fetch: fn, tokens })
    await api.listRuns({ status: ["running", "failed"], search: "x y", limit: 5 })
    expect(calls[0]!.url).toBe("/v1/runs?status=running&status=failed&search=x+y&limit=5")
    expect(calls[0]!.headers.authorization).toBeUndefined()
  })

  test("the first control action pairs locally, then sends the bearer token", async () => {
    const tokens = memoryTokens()
    const { fn, calls } = fakeFetch((method, url) => {
      if (url === "/v1/pair/local") return json({ token: "wfg_local", id: "d1" })
      return json({ ok: true })
    })
    const api = createApi({ fetch: fn, tokens })
    await api.stopRun("r/1")
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST /v1/pair/local", "POST /v1/runs/r%2F1/stop"])
    expect(calls[0]!.headers.authorization).toBeUndefined()
    expect(calls[1]!.headers.authorization).toBe("Bearer wfg_local")
    expect(tokens.value).toBe("wfg_local")
  })

  test("a revoked token is dropped and replaced once through local pairing", async () => {
    const tokens = memoryTokens("wfg_old")
    const { fn, calls } = fakeFetch((method, url, headers) => {
      if (url === "/v1/pair/local") return json({ token: "wfg_new", id: "d2" })
      return headers.authorization === "Bearer wfg_new" ? json({ ok: true }) : error("unauthorized", 401)
    })
    const api = createApi({ fetch: fn, tokens })
    await api.reply("r", "i", [["Yes"]])
    expect(calls.map((c) => c.url)).toEqual([
      "/v1/runs/r/interactions/i/reply",
      "/v1/pair/local",
      "/v1/runs/r/interactions/i/reply",
    ])
    expect(calls[2]!.body).toEqual({ answers: [["Yes"]] })
    expect(tokens.value).toBe("wfg_new")
  })

  test("a remote browser that cannot pair locally gets an error that asks for pairing", async () => {
    const { fn } = fakeFetch((method, url) =>
      url === "/v1/pair/local" ? error("forbidden", 403) : error("unauthorized", 401),
    )
    const api = createApi({ fetch: fn, tokens: memoryTokens() })
    const caught = await api.stopRun("r").catch((e) => e)
    expect(caught).toBeInstanceOf(ApiError)
    expect((caught as ApiError).needsPairing).toBe(true)
  })

  test("a read with an unknown token retries without it", async () => {
    const tokens = memoryTokens("wfg_gone")
    const { fn, calls } = fakeFetch((method, url, headers) =>
      headers.authorization ? error("unauthorized", 401) : json({ run: {}, live: false }),
    )
    const api = createApi({ fetch: fn, tokens })
    await api.getRun("r")
    expect(calls).toHaveLength(2)
    expect(tokens.value).toBeNull()
  })

  test("pairing with a code stores the token", async () => {
    const tokens = memoryTokens()
    const { fn, calls } = fakeFetch(() => json({ token: "wfg_paired", id: "d3" }))
    await createApi({ fetch: fn, tokens }).pair("ABCD-EFGH", "phone")
    expect(calls[0]!.body).toEqual({ code: "ABCD-EFGH", name: "phone" })
    expect(tokens.value).toBe("wfg_paired")
  })

  test("protocol errors surface code, message and retryable", async () => {
    const { fn } = fakeFetch(() =>
      json({ error: { code: "invalid_state", message: "Run is still running", retryable: true } }, 409),
    )
    const caught = (await createApi({ fetch: fn, tokens: memoryTokens("wfg_x") })
      .resumeRun("r")
      .catch((e) => e)) as ApiError
    expect(caught.code).toBe("invalid_state")
    expect(caught.status).toBe(409)
    expect(caught.retryable).toBe(true)
    expect(caught.message).toBe("Run is still running")
  })

  test("the events URL carries only the location", () => {
    const api = createApi({ fetch: fakeFetch(() => json({})).fn, tokens: memoryTokens("wfg_secret") })
    expect(api.eventsUrl("/a b")).toBe("/v1/events?location=%2Fa%20b")
    expect(api.authHeaders()).toEqual({ authorization: "Bearer wfg_secret" })
  })
})

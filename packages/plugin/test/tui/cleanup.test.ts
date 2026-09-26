import { describe, expect, test } from "bun:test"

import { WorkflowRpc } from "../../src/service/rpc"
import { bindApi, errorText, type WorkflowApi } from "../../src/tui/api"
import { cleanupPending, cleanupRun, cleanupTargets } from "../../src/tui/cleanup"
import { entry, run, unit } from "./fixtures"

function fakeApi(runs: ReturnType<typeof run>[]) {
  const recorded: Array<{ runId: string; deleted?: string[] }> = []
  const api = {
    getRun: async ({ runId }: { runId: string }) => ({ run: runs.find((r) => r.runId === runId)!, live: false }),
    cleanupRun: async (input: { runId: string; deleted?: string[] }) => {
      recorded.push(input)
      return { deleted: input.deleted?.length ?? 0, pending: 0 }
    },
  } as unknown as WorkflowApi
  return { api, recorded }
}

describe("retention", () => {
  const finished = run({
    status: "succeeded",
    cleanup: "pending",
    units: [
      unit({ sessionID: "s1" }),
      unit({ unitId: "u2", sessionID: "s2" }),
      unit({ unitId: "u3", sessionID: null }),
      unit({ unitId: "u4", sessionID: "s1" }),
    ],
  })

  test("targets are the Unit sessions, each once", () => {
    expect(cleanupTargets(finished)).toEqual(["s1", "s2"])
  })

  test("deletes each session, counts already-gone ones, reports failures, and records the result", async () => {
    const { api, recorded } = fakeApi([finished])
    const removed: string[] = []
    const outcome = await cleanupRun(
      {
        ...finished,
        units: [
          ...finished.units,
          unit({ unitId: "u5", sessionID: "gone" }),
          unit({ unitId: "u6", sessionID: "locked" }),
        ],
      },
      {
        api,
        remove: async (id) => {
          if (id === "gone") throw { name: "SessionNotFoundError", message: "Session not found" }
          if (id === "locked") throw new Error("busy")
          removed.push(id)
        },
      },
    )
    expect(removed).toEqual(["s1", "s2"])
    expect(recorded).toEqual([{ runId: finished.runId, deleted: ["s1", "s2", "gone"] }])
    expect(outcome.failures).toEqual([{ sessionID: "locked", error: "busy" }])
  })

  test("refuses a live Run", async () => {
    const { api } = fakeApi([])
    await expect(cleanupRun(run(), { api, remove: async () => {} })).rejects.toThrow(/Stop the Run/)
  })

  test("bulk cleanup touches only finished Runs marked pending", async () => {
    const keep = run({ runId: "keep", status: "succeeded", cleanup: "none", units: [unit({ sessionID: "k1" })] })
    const live = run({ runId: "live", units: [unit({ sessionID: "l1" })] })
    const { api, recorded } = fakeApi([finished, keep, live])
    const removed: string[] = []
    const outcomes = await cleanupPending([entry(finished, false), entry(keep, false), entry(live)], {
      api,
      remove: async (id) => void removed.push(id),
    })
    expect(outcomes.map((o) => o.runId)).toEqual([finished.runId])
    expect(removed).toEqual(["s1", "s2"])
    expect(recorded).toHaveLength(1)
  })
})

describe("api binding", () => {
  test("binds every RPC method to the location and reads protocol error messages", async () => {
    const seen: Array<{ method: string; input: unknown; options: unknown }> = []
    const raw = Object.fromEntries(
      Object.keys(WorkflowRpc.methods).map((method) => [
        method,
        async (input: unknown, options: unknown) => (seen.push({ method, input, options }), { ok: true }),
      ]),
    )
    const { api } = bindApi({ ...raw, events: { subscribe: () => ({}) } }, { directory: "/p" })
    await api.stopRun({ runId: "r" })
    await api.info()
    expect(seen).toEqual([
      { method: "stopRun", input: { runId: "r" }, options: { location: { directory: "/p" } } },
      { method: "info", input: {}, options: { location: { directory: "/p" } } },
    ])
    for (const method of Object.keys(WorkflowRpc.methods))
      expect(typeof (api as unknown as Record<string, unknown>)[method]).toBe("function")
    expect(
      errorText({
        type: "workflow",
        message: "x",
        data: { code: "conflict", message: "not pending", retryable: false },
      }),
    ).toBe("not pending")
    expect(errorText(new Error("boom"))).toBe("boom")
  })
})

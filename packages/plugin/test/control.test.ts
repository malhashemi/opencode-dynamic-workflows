/**
 * The write direction, from both ends.
 *
 * The registry's own bookkeeping is easy to assert directly, but the claim that matters is an integration one:
 * that a stop arriving from OUTSIDE the invoking session actually reaches an in-flight child prompt and lands
 * the run `aborted`. Before this phase the tool's abort signal WAS the run signal, so that path did not exist —
 * which is exactly the kind of thing a registry unit test would happily pass over.
 */
import { describe, expect, it } from "bun:test"
import { createControlRegistry, parseControlAction } from "../src/control"
import { runWorkflow } from "../src/orchestrator"
import { createRunStore, type RunSnapshot } from "../src/runs"
import { makeFakeClient } from "./fake-client"

/** Two units that hang until something cancels them — the only shape in which a stop is observable. */
const HANGING_WORKFLOW = `
import { defineWorkflow } from "@opencode-ai/workflow"
export default defineWorkflow({
  meta: { name: "hangs", description: "units that never answer on their own", concurrency: 4 },
  async run({ agent, parallel }) {
    return await parallel([() => agent("one", { label: "one" }), () => agent("two", { label: "two" })])
  },
})
`

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("condition was not reached")
}

function runningUnits(store: ReturnType<typeof createRunStore>, runId: string): RunSnapshot["units"] {
  return (store.get(runId)?.units ?? []).filter((unit) => unit.status === "running")
}

describe("control registry", () => {
  it("stops a registered run and refuses one it has never seen", () => {
    const registry = createControlRegistry()
    expect(registry.stopRun("nope")).toEqual({ ok: false, reason: "unknown-run" })

    const controller = new AbortController()
    const unregister = registry.registerRun("run-1", controller)
    expect(registry.stopRun("run-1")).toEqual({ ok: true })
    expect(controller.signal.aborted).toBe(true)

    // A second stop is not a second abort: the run is already on its way out.
    expect(registry.stopRun("run-1")).toEqual({ ok: false, reason: "not-running" })
    unregister()
    expect(registry.stopRun("run-1")).toEqual({ ok: false, reason: "unknown-run" })
  })

  it("stops one unit without touching its siblings, and forgets it once it settles", () => {
    const registry = createControlRegistry()
    registry.registerRun("run-1", new AbortController())
    const stopped: string[] = []
    const disposeA = registry.registerUnit("run-1", "unit-a", () => stopped.push("a"))
    registry.registerUnit("run-1", "unit-b", () => stopped.push("b"))

    expect(registry.stopUnit("run-1", "unit-a")).toEqual({ ok: true })
    expect(stopped).toEqual(["a"])

    // Settling unregisters the handle: a stop for a finished unit must not abort a session the engine has
    // already moved past.
    disposeA()
    expect(registry.stopUnit("run-1", "unit-a")).toEqual({ ok: false, reason: "unknown-unit" })
    expect(registry.stopUnit("run-1", "unit-b")).toEqual({ ok: true })
    expect(stopped).toEqual(["a", "b"])
    expect(registry.stopUnit("other", "unit-b")).toEqual({ ok: false, reason: "unknown-run" })
  })

  it("survives a throwing cancel handle — a broken unit must not make the surface believe the run is broken", () => {
    const registry = createControlRegistry()
    registry.registerRun("run-1", new AbortController())
    registry.registerUnit("run-1", "unit-a", () => {
      throw new Error("boom")
    })
    expect(registry.stopUnit("run-1", "unit-a")).toEqual({ ok: true })
  })

  it("drops a unit handle whose run was never registered, rather than stranding it", () => {
    const registry = createControlRegistry()
    let cancelled = false
    const dispose = registry.registerUnit("ghost", "unit-a", () => {
      cancelled = true
    })
    dispose()
    expect(registry.stopUnit("ghost", "unit-a")).toEqual({ ok: false, reason: "unknown-run" })
    expect(cancelled).toBe(false)
  })

  it("dispatches both action shapes through one path", async () => {
    const registry = createControlRegistry()
    const controller = new AbortController()
    registry.registerRun("run-1", controller)
    let cancelled = false
    registry.registerUnit("run-1", "unit-a", () => {
      cancelled = true
    })

    expect(await registry.dispatch({ action: "stop.unit", runId: "run-1", unitId: "unit-a" })).toEqual({ ok: true })
    expect(cancelled).toBe(true)
    expect(await registry.dispatch({ action: "stop.run", runId: "run-1" })).toEqual({ ok: true })
    expect(controller.signal.aborted).toBe(true)
  })
})

/**
 * `save.run` addresses the JOURNAL, not the live run table — which is the whole point of it. Every other action
 * refuses an id the registry has never registered; this one has to work precisely for the run that ended in a
 * session that is over.
 */
describe("control registry: save.run", () => {
  it("routes to the injected saver without consulting the run table", async () => {
    const asked: string[] = []
    const control = createControlRegistry({
      async save(runId) {
        asked.push(runId)
        return { ok: true, detail: `saved as "${runId}"` }
      },
    })
    expect(await control.dispatch({ action: "save.run", runId: "long-gone" })).toEqual({
      ok: true,
      detail: 'saved as "long-gone"',
    })
    expect(asked).toEqual(["long-gone"])
  })

  it("answers `unsupported` when the engine has no journal to save from", async () => {
    const control = createControlRegistry()
    expect(await control.dispatch({ action: "save.run", runId: "r" })).toEqual({ ok: false, reason: "unsupported" })
  })

  it("turns a throwing saver into an answer rather than a rejected control request", async () => {
    const control = createControlRegistry({
      async save() {
        throw new Error("disk is full")
      },
    })
    expect(await control.dispatch({ action: "save.run", runId: "r" })).toEqual({
      ok: false,
      reason: "unsupported",
      detail: "disk is full",
    })
  })
})

describe("parseControlAction", () => {
  it("accepts the two Phase 2 shapes", () => {
    expect(parseControlAction({ action: "stop.run", runId: "r" })).toEqual({ action: "stop.run", runId: "r" })
    expect(parseControlAction({ action: "stop.unit", runId: "r", unitId: "u" })).toEqual({
      action: "stop.unit",
      runId: "r",
      unitId: "u",
    })
  })

  it("accepts Phase 3's save", () => {
    expect(parseControlAction({ action: "save.run", runId: "r" })).toEqual({ action: "save.run", runId: "r" })
    expect(parseControlAction({ action: "save.run", runId: "" })).toBeNull()
  })

  it("rejects everything else, including a well-formed action with a missing field", () => {
    for (const value of [
      null,
      "stop.run",
      42,
      {},
      { action: "stop.run" },
      { action: "stop.run", runId: "" },
      { action: "stop.unit", runId: "r" },
      { action: "stop.unit", runId: "r", unitId: "" },
      { action: "restart.unit", runId: "r", unitId: "u" }, // Phase 6's, not ours yet
    ]) {
      expect(parseControlAction(value)).toBeNull()
    }
  })
})

describe("stop, end to end through the engine", () => {
  it("aborts in-flight units and lands the run `aborted` when stopped from outside the session", async () => {
    const store = createRunStore()
    const control = createControlRegistry()
    const client = makeFakeClient({ hang: true })

    const finished = runWorkflow({
      source: HANGING_WORKFLOW,
      client,
      parentSessionID: "parent",
      runId: "run-stop",
      store,
      control,
    })

    await waitFor(() => runningUnits(store, "run-stop").length === 2)
    // No `input.signal` at all: the only thing that can stop this run is the registry — which is the whole
    // point. Before this phase there was no such path.
    expect(control.stopRun("run-stop")).toEqual({ ok: true })

    await finished
    const run = store.get("run-stop")
    expect(run?.status).toBe("aborted")
    expect(run?.units.every((unit) => unit.status === "failed")).toBe(true)
    // Both children were really cancelled, not just marked failed.
    expect(client.abortCalls.map((call) => call.sessionID).sort()).toEqual(["child-1", "child-2"])
    // And the run is no longer addressable once it is over.
    expect(control.stopRun("run-stop")).toEqual({ ok: false, reason: "unknown-run" })
  })

  it("stops one unit and leaves its sibling running, with the run still alive", async () => {
    const store = createRunStore()
    const control = createControlRegistry()
    const client = makeFakeClient({ hang: true })

    const finished = runWorkflow({
      source: HANGING_WORKFLOW,
      client,
      parentSessionID: "parent",
      runId: "run-unit",
      store,
      control,
    })

    await waitFor(() => runningUnits(store, "run-unit").length === 2)
    const victim = runningUnits(store, "run-unit")[0]
    if (!victim) throw new Error("expected a running unit")

    expect(control.stopUnit("run-unit", victim.unitId)).toEqual({ ok: true })
    await waitFor(() => store.get("run-unit")?.units.some((unit) => unit.unitId === victim.unitId && unit.status === "failed") === true)

    const midflight = store.get("run-unit")
    expect(midflight?.status).toBe("running")
    expect(runningUnits(store, "run-unit")).toHaveLength(1)
    // The stopped unit says which of the two kinds of cancellation happened.
    const stopped = midflight?.units.find((unit) => unit.unitId === victim.unitId)
    expect(stopped?.error).toBe("unit stopped before completion")

    // Let the survivor go so the run can finish; a stopped unit is a failure, not an abort, so the run is
    // `done` with an error recorded — the fan-out was never cancelled.
    expect(control.stopUnit("run-unit", runningUnits(store, "run-unit")[0]!.unitId)).toEqual({ ok: true })
    await finished
    expect(store.get("run-unit")?.status).toBe("done")
    expect(store.get("run-unit")?.errors).toHaveLength(2)
  })

  it("leaves the tool's own abort signal working alongside the registry", async () => {
    const store = createRunStore()
    const control = createControlRegistry()
    const client = makeFakeClient({ hang: true })
    const tool = new AbortController()

    const finished = runWorkflow({
      source: HANGING_WORKFLOW,
      client,
      parentSessionID: "parent",
      runId: "run-signal",
      store,
      control,
      signal: tool.signal,
    })

    await waitFor(() => runningUnits(store, "run-signal").length === 2)
    tool.abort()
    await finished
    expect(store.get("run-signal")?.status).toBe("aborted")
  })
})

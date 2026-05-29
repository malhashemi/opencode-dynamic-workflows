import { describe, expect, it } from "bun:test"
import { defaultConcurrency, runBounded } from "../src/scheduler"

/** A deferred promise + a thunk that resolves it, for driving concurrency deterministically. */
function gate<T>(value: T) {
  let release!: () => void
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  const thunk = async () => {
    await opened
    return value
  }
  return { thunk, release }
}

describe("runBounded", () => {
  it("returns results positionally aligned to the input, regardless of settle order", async () => {
    // thunk 0 resolves LAST, thunk 2 resolves FIRST — output order must still be [0,1,2].
    const order = [30, 10, 0]
    const results = await runBounded(
      order.map((ms, i) => async () => {
        await Bun.sleep(ms)
        return i
      }),
      { concurrency: 8 },
    )
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([0, 1, 2])
  })

  it("never runs more than `concurrency` thunks in flight at once", async () => {
    let inFlight = 0
    let peak = 0
    const thunks = Array.from({ length: 7 }, () => async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await Bun.sleep(5)
      inFlight -= 1
      return true
    })
    await runBounded(thunks, { concurrency: 2 })
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBe(2) // with 7 thunks and a real wait, the cap is actually reached
  })

  it("starts queued thunks only as earlier ones settle (a slot frees, the next begins)", async () => {
    const started: number[] = []
    const gates = [gate(0), gate(1), gate(2)]
    const thunks = gates.map((g, i) => async () => {
      started.push(i)
      return g.thunk()
    })
    const all = runBounded(thunks, { concurrency: 1 })
    await Bun.sleep(1)
    expect(started).toEqual([0]) // only the first slot is occupied
    gates[0]!.release()
    await Bun.sleep(1)
    expect(started).toEqual([0, 1]) // freeing slot 0 lets thunk 1 begin
    gates[1]!.release()
    gates[2]!.release()
    await all
    expect(started).toEqual([0, 1, 2])
  })

  it("is a barrier: resolves only after every thunk has settled", async () => {
    let settledCount = 0
    const thunks = Array.from({ length: 4 }, (_unused, i) => async () => {
      await Bun.sleep(i * 3)
      settledCount += 1
      return i
    })
    await runBounded(thunks, { concurrency: 4 })
    expect(settledCount).toBe(4)
  })

  it("captures a rejected thunk as a rejected result without throwing or aborting siblings", async () => {
    const results = await runBounded(
      [
        async () => "a",
        async () => {
          throw new Error("boom")
        },
        async () => "c",
      ],
      { concurrency: 8 },
    )
    expect(results[0]).toEqual({ status: "fulfilled", value: "a" })
    expect(results[1]?.status).toBe("rejected")
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error)
    expect(results[2]).toEqual({ status: "fulfilled", value: "c" })
  })

  it("handles an empty thunk list", async () => {
    expect(await runBounded([], { concurrency: 4 })).toEqual([])
  })

  it("treats concurrency < 1 as 1 (never deadlocks or runs zero)", async () => {
    const results = await runBounded([async () => 1, async () => 2], { concurrency: 0 })
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : null))).toEqual([1, 2])
  })

  it("runs EVERY thunk (never silently drops) when concurrency is non-finite (NaN / Infinity)", async () => {
    // Regression: Math.max(1, Math.floor(NaN)) is NaN ⇒ zero workers ⇒ a results array full of holes that
    // ctx.parallel would map to null slots with no ctx.errors entry (a D9 silent-drop violation).
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const results = await runBounded([async () => "a", async () => "b", async () => "c"], { concurrency: bad })
      expect(results.map((r) => (r.status === "fulfilled" ? r.value : "(HOLE)"))).toEqual(["a", "b", "c"])
    }
  })
})

describe("defaultConcurrency", () => {
  it("is at least 1 and at most 16", () => {
    const n = defaultConcurrency()
    expect(n).toBeGreaterThanOrEqual(1)
    expect(n).toBeLessThanOrEqual(16)
  })
})

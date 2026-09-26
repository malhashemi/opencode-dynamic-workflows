/**
 * Scheduler tests: the shared {@link Semaphore} that backs every Unit launch. These assert the concurrency cap
 * (via a live counter recording max simultaneous in-flight), that a throwing task releases its permit instead
 * of stranding a slot (no deadlock), FIFO ordering of queued waiters, and the default cap — all without opencode.
 */
import { describe, expect, test } from "bun:test"

import { defaultConcurrency, Semaphore } from "../src/scheduler"

describe("Semaphore", () => {
  test("run executes the task and returns its value", async () => {
    const sem = new Semaphore(2)
    expect(await sem.run(async () => 42)).toBe(42)
  })

  test("caps the number of tasks in flight at the permit count", async () => {
    const sem = new Semaphore(2)
    let active = 0
    let maxActive = 0
    const task = (ms: number) => () =>
      sem.run(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, ms))
        active--
        return ms
      })
    const results = await Promise.all([task(10)(), task(10)(), task(10)(), task(10)()])
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(results).toHaveLength(4)
  })

  test("a throwing task releases its permit (no deadlock) — later tasks still run", async () => {
    const sem = new Semaphore(1)
    await expect(
      sem.run(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    // With permits=1, if the throw had stranded the slot this would hang; it must resolve.
    expect(await sem.run(async () => "after")).toBe("after")
  })

  test("queued waiters resume in FIFO order as permits free up", async () => {
    const sem = new Semaphore(1)
    const order: number[] = []
    // First task holds the only permit; the next three queue and must resume in the order they asked.
    const tasks = [0, 1, 2, 3].map((n) =>
      sem.run(async () => {
        order.push(n)
        await new Promise((r) => setTimeout(r, 1))
      }),
    )
    await Promise.all(tasks)
    expect(order).toEqual([0, 1, 2, 3])
  })

  test("a non-finite or sub-1 permit count clamps to 1 (never zeroes the pool)", async () => {
    expect(await new Semaphore(Number.NaN).run(async () => "ok")).toBe("ok")
    expect(await new Semaphore(0).run(async () => "ok")).toBe("ok")
    expect(await new Semaphore(-5).run(async () => "ok")).toBe("ok")
  })

  test("defaultConcurrency is min(16, cpus-2) and at least 1", async () => {
    expect(defaultConcurrency()).toBe(Math.min(16, Math.max(1, (navigator.hardwareConcurrency || 4) - 2)))
  })
})

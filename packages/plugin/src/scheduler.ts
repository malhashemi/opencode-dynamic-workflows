/**
 * The shared concurrency limiter. A {@link Semaphore} caps how many Units run at once across the WHOLE Run:
 * the context owns one instance, and every primitive that launches a Unit (`agent`, and therefore `parallel`
 * and `pipeline`, which only launch Units through `agent`) runs under `semaphore.run(...)`. Because the bound
 * sits at the Unit level, total in-flight Units never exceeds the cap no matter how many `parallel`/`pipeline`
 * calls are mid-flight at the same time (spec D5).
 *
 * No external deps — a hand-rolled permit pool with a FIFO waiter queue. `run` always releases its permit in a
 * `finally`, so a throwing Unit can never strand a slot and deadlock the pool.
 */

/** The plugin-wide default concurrency cap: min(16, max(1, cpus-2)). Mirrors the Workflow tool's cap. */
export function defaultConcurrency(): number {
  // `navigator.hardwareConcurrency` is the portable core count (Bun/Node 21+/browsers). Fall back to 4.
  const cores = typeof navigator !== "undefined" && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4
  return Math.min(16, Math.max(1, cores - 2))
}

/**
 * The rejection the limiter raises when an acquire is abandoned because the run was aborted. A distinct class so
 * callers can tell "this Unit never launched (run aborted)" apart from an unexpected throw inside the task body.
 */
export class AbortError extends Error {
  constructor(message = "workflow run aborted") {
    super(message)
    this.name = "AbortError"
  }
}

/** Wrap the signal's `reason` in an {@link AbortError} (preserving its message; DOMExceptions stringify poorly). */
function abortReason(signal: AbortSignal): AbortError {
  const reason = signal.reason
  return new AbortError(reason instanceof Error ? reason.message : undefined)
}

/**
 * A counting semaphore with `permits` slots and a FIFO queue of waiters. `run(fn, signal?)` acquires a permit
 * (awaiting one if none are free), runs `fn`, and releases the permit — handing it directly to the next waiter
 * so the count is conserved. A non-finite or < 1 `permits` clamps to 1, so a mis-computed cap never zeroes the
 * pool. When a `signal` is supplied, an acquire that is already-aborted or aborts WHILE QUEUED rejects and is
 * removed from the queue (D11) — a Unit already past acquire keeps running (its slot is not killed mid-flight).
 */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  private readonly capacity: number

  constructor(permits: number) {
    this.available = Number.isFinite(permits) ? Math.max(1, Math.floor(permits)) : 1
    this.capacity = this.available
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    if (this.available > 0) {
      this.available -= 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = () => {
        cleanup()
        resolve()
      }
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter)
        if (i >= 0) this.waiters.splice(i, 1) // drop from the queue so release() never hands it a permit
        cleanup()
        reject(abortReason(signal!))
      }
      const cleanup = () => signal?.removeEventListener("abort", onAbort)
      this.waiters.push(waiter)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    // Hand the permit straight to the next waiter (no count bump); only return it to the pool if none waits.
    if (next) next()
    else this.available += 1
  }

  /** Acquire a permit and get its release function (call it exactly once). Rejects if `signal` aborts first. */
  async slot(signal?: AbortSignal): Promise<() => void> {
    await this.acquire(signal)
    let released = false
    return () => {
      if (released) return
      released = true
      this.release()
    }
  }

  /** Permits free right now. */
  get free(): number {
    return this.available
  }

  /** Permits in the pool (for resizing decisions and tests). */
  get size(): number {
    return this.capacity
  }

  /** Acquire a permit, run `fn`, and release the permit even if `fn` throws. Rejects if `signal` aborts first. */
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

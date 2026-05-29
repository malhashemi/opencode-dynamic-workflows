/**
 * The bounded scheduler — the concurrency limiter behind `ctx.parallel`.
 *
 * opencode has no global cap on in-flight prompts (feasibility C6), so a fan-out would otherwise hammer the
 * provider's rate limits. {@link runBounded} runs a list of thunks with at most `concurrency` in flight at
 * once, returns results **positionally aligned** to the input (a barrier — like `Promise.allSettled`, but
 * bounded), and **never throws**: a rejected thunk lands as a `{ status: "rejected" }` slot so the surrounding
 * fan-out is never aborted (error model D9). It is deliberately ignorant of opencode and `ctx.errors` so it
 * can be unit-tested in complete isolation (the parallel-fan-out ticket's standalone-scheduler AC).
 */

/** The ceiling on concurrent Units when a workflow declares no `meta.concurrency`. */
const MAX_DEFAULT_CONCURRENCY = 16

export interface RunBoundedOptions {
  /**
   * Max thunks in flight at once. Values < 1 are clamped to 1 (never deadlock, never run zero). A non-finite
   * value (NaN/Infinity — e.g. a mis-computed caller value) is treated as "no limit" (run the whole batch)
   * rather than dropping every thunk: the scheduler never silently drops (D9). Callers that want a sane
   * bounded default for bad input should sanitize before calling (the engine uses `defaultConcurrency()`).
   */
  concurrency: number
}

/**
 * Run `thunks` with bounded concurrency and return their settled outcomes positionally aligned to the input.
 *
 * Barrier semantics: resolves only once every thunk has settled. A queued thunk starts only as an in-flight
 * one settles, so at most `concurrency` run at any instant. A throwing/rejecting thunk is captured as a
 * rejected result rather than propagated, leaving siblings untouched.
 */
export async function runBounded<T>(
  thunks: ReadonlyArray<() => Promise<T>>,
  opts: RunBoundedOptions,
): Promise<Array<PromiseSettledResult<T>>> {
  // Non-finite (NaN/Infinity) ⇒ no limit (run the whole batch). Crucially NOT `Math.max(1, Math.floor(NaN))`,
  // which is NaN ⇒ zero workers ⇒ every result slot left a hole (a silent drop). Finite ⇒ clamp to ≥ 1.
  const limit = Number.isFinite(opts.concurrency) ? Math.max(1, Math.floor(opts.concurrency)) : thunks.length
  const results = new Array<PromiseSettledResult<T>>(thunks.length)
  let next = 0

  async function worker(): Promise<void> {
    // Each worker pulls the next unclaimed index until the queue is drained; `limit` workers ⇒ ≤ limit
    // thunks ever in flight. Index capture (not array order) keeps results positionally aligned.
    while (next < thunks.length) {
      const index = next++
      try {
        results[index] = { status: "fulfilled", value: await thunks[index]!() }
      } catch (reason) {
        results[index] = { status: "rejected", reason }
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, thunks.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/** Default concurrency cap: `min(16, max(1, cpus - 2))` — mirrors the reference Workflow tool's limiter. */
export function defaultConcurrency(): number {
  const cpus = navigator.hardwareConcurrency || 4
  return Math.min(MAX_DEFAULT_CONCURRENCY, Math.max(1, cpus - 2))
}

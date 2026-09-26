/**
 * Process-wide engine state.
 *
 * OpenCode's shared service hosts one plugin instance per location and replaces instances on reload, but it is
 * one process: every instance sees the same `globalThis` (P0 spikes S5, S9, S12). Live Runs, the Unit index and
 * pending interactions therefore live here, keyed by a versioned symbol, and instances attach to them. A reload
 * rebinds hooks and tools; it does not orphan anything that is running.
 *
 * The key carries the protocol major version. A future incompatible engine uses a new key and cannot misread
 * this one's state.
 */
import { Semaphore } from "./scheduler"
import { createUnitIndex, type UnitIndex } from "./units"

const KEY = Symbol.for("opencode-dynamic-workflows.engine.v1")

/** Per-location state that must outlive a plugin instance. Filled by the service layer. */
export interface LocationSlot {
  location: string
  /** Opaque to this module; the service stores its long-lived parts here. */
  state: Record<string, unknown>
  /** The id of the plugin instance currently serving this location. */
  owner: string | null
}

export interface EngineGlobal {
  version: 1
  units: UnitIndex
  locations: Map<string, LocationSlot>
  /** Free-form process singletons (gateway, attached surfaces) keyed by name. */
  singletons: Map<string, unknown>
}

export function engineGlobal(): EngineGlobal {
  const holder = globalThis as unknown as Record<symbol, EngineGlobal | undefined>
  let current = holder[KEY]
  if (!current) {
    current = { version: 1, units: createUnitIndex(), locations: new Map(), singletons: new Map() }
    holder[KEY] = current
  }
  return current
}

export function locationSlot(location: string): LocationSlot {
  const global = engineGlobal()
  let slot = global.locations.get(location)
  if (!slot) {
    slot = { location, state: {}, owner: null }
    global.locations.set(location, slot)
  }
  return slot
}

/**
 * Process-wide limits. OpenCode serves every session from one process, so per-Run caps alone would let many Runs
 * together flood a provider: at most `runs` Runs execute at once (the rest wait, queued), and a provider may have
 * its own Unit cap across all Runs. A resize makes a new limiter; holders of the old one finish on it.
 */
export function configureLimits(runs: number, perProvider: Record<string, number>): void {
  const singletons = engineGlobal().singletons
  const current = singletons.get("limit:runs") as Semaphore | undefined
  if (!current || current.size !== runs) singletons.set("limit:runs", new Semaphore(runs))
  const providers =
    (singletons.get("limit:providers") as Map<string, Semaphore> | undefined) ?? new Map<string, Semaphore>()
  for (const [id, permits] of Object.entries(perProvider)) {
    if (providers.get(id)?.size !== permits) providers.set(id, new Semaphore(permits))
  }
  for (const id of Array.from(providers.keys())) if (!(id in perProvider)) providers.delete(id)
  singletons.set("limit:providers", providers)
}

/** Wait for a Run slot. Resolves to the release (call once); rejects if `signal` aborts first. */
export async function runSlot(signal: AbortSignal): Promise<() => void> {
  const runs = engineGlobal().singletons.get("limit:runs") as Semaphore | undefined
  return runs ? runs.slot(signal) : () => {}
}

/** Are all Run slots taken right now? */
export function runSlotsFull(): boolean {
  return (engineGlobal().singletons.get("limit:runs") as Semaphore | undefined)?.free === 0
}

/** Take a slot for one Unit on its provider's cross-Run cap (when that provider has one). Returns the release. */
export async function unitSlot(providerID: string | undefined, signal: AbortSignal): Promise<() => void> {
  const provider = providerID
    ? (engineGlobal().singletons.get("limit:providers") as Map<string, Semaphore> | undefined)?.get(providerID)
    : undefined
  return provider ? provider.slot(signal) : () => {}
}

/** Test helper: forget all process-wide state. */
export function resetEngineGlobal(): void {
  const holder = globalThis as unknown as Record<symbol, EngineGlobal | undefined>
  delete holder[KEY]
}

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

/** Test helper: forget all process-wide state. */
export function resetEngineGlobal(): void {
  const holder = globalThis as unknown as Record<symbol, EngineGlobal | undefined>
  delete holder[KEY]
}

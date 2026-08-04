import type { WorkflowError } from "@opencode-ai/workflow"

export interface UnitSnapshot {
  unitId: string
  ordinal: number
  label: string | null
  subagent: string
  phase: string | null
  status: "queued" | "running" | "ok" | "failed"
  sessionID: string | null
  prompt: string
  startedAt: number | null
  endedAt: number | null
  error?: string
  /**
   * What the unit actually answered — its text, or its structured value as JSON.
   *
   * Recorded because a unit's result otherwise exists only inside the running script: the store knew a unit
   * had settled `ok` and nothing about what it produced, so the run browser could show the question and never
   * the answer. Capped at {@link MAX_UNIT_OUTPUT} — `/state` carries every unit of every live run, and one
   * long research answer should not be able to make that payload unbounded.
   */
  output?: string
}

/**
 * Cap on a recorded unit output, in characters.
 *
 * Generous rather than tight: this is the thing a person opened the unit level to read, so truncating it at a
 * few hundred characters would defeat the point. Truncation is marked, never silent.
 */
export const MAX_UNIT_OUTPUT = 12_000

/** A unit's result, as the store should carry it: JSON for structured values, verbatim for text, capped. */
export function toUnitOutput(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  if (text.length === 0) return undefined
  return text.length <= MAX_UNIT_OUTPUT
    ? text
    : `${text.slice(0, MAX_UNIT_OUTPUT)}\n… truncated (${text.length - MAX_UNIT_OUTPUT} more characters)`
}

export interface RunSnapshot {
  runId: string
  workflow: string
  provenance: "durable" | "inline"
  parentSessionID: string
  status: "running" | "done" | "failed" | "aborted"
  /**
   * Phase titles. Seeded from `meta.phases` when the workflow declared them, and grown by observation as
   * `phase()` is called either way — so this list is a PLAN when {@link phasesDeclared}, and a running
   * total otherwise.
   */
  phases: string[]
  /**
   * Whether `phases` was known in full before the run started.
   *
   * Without this the two cases are indistinguishable, and every surface renders the observed count as if it
   * were the total: a workflow that will call `phase()` three times reads `phase 1/1` on its first phase,
   * then `phase 2/2`. That is not merely imprecise, it actively asserts there is nothing left to come.
   */
  phasesDeclared: boolean
  currentPhase: string | null
  units: UnitSnapshot[]
  logs: string[]
  errors: WorkflowError[]
  tokensSpent: number
  startedAt: number
  endedAt: number | null
}

export type RunEvent =
  | { type: "run.started"; run: RunSnapshot }
  | { type: "run.ended"; run: RunSnapshot }
  | { type: "run.phase"; runId: string; value: string }
  | { type: "run.log"; runId: string; value: string }
  | { type: "unit.queued"; runId: string; unit: UnitSnapshot }
  | { type: "unit.started"; runId: string; unit: UnitSnapshot }
  | { type: "unit.settled"; runId: string; unit: UnitSnapshot }

export type RunSubscriber = (event: RunEvent) => void

export interface RunStore {
  create(run: RunSnapshot): RunSnapshot
  get(runId: string): RunSnapshot | undefined
  list(): RunSnapshot[]
  apply(event: RunEvent): RunSnapshot
  subscribe(subscriber: RunSubscriber): () => void
  subscribers(): number
}

export function cloneUnitSnapshot(unit: UnitSnapshot): UnitSnapshot {
  return { ...unit }
}

export function cloneRunSnapshot(run: RunSnapshot): RunSnapshot {
  return {
    ...run,
    phases: [...run.phases],
    units: run.units.map(cloneUnitSnapshot),
    logs: [...run.logs],
    errors: run.errors.map((error) => ({ ...error })),
  }
}

export function cloneRunEvent(event: RunEvent): RunEvent {
  if (event.type === "run.started" || event.type === "run.ended") {
    return { type: event.type, run: cloneRunSnapshot(event.run) }
  }
  if (event.type === "run.phase" || event.type === "run.log") return { ...event }
  return { type: event.type, runId: event.runId, unit: cloneUnitSnapshot(event.unit) }
}

/**
 * In-process source of truth for live runs. All reads and subscriber deliveries are cloned so callers can
 * freely shape UI data without ever receiving a reference to the store's mutable state.
 */
export function createRunStore(): RunStore {
  const runs = new Map<string, RunSnapshot>()
  const subscribers = new Set<RunSubscriber>()

  const publish = (event: RunEvent) => {
    // Set iteration is insertion ordered. Give every subscriber its own clone so an earlier listener cannot
    // mutate what a later listener observes, and do not let one faulty UI prevent the remaining fan-out.
    for (const subscriber of [...subscribers]) {
      try {
        subscriber(cloneRunEvent(event))
      } catch {
        // Subscribers are observation-only; engine state transitions must not depend on a UI callback.
      }
    }
  }

  const requireRun = (runId: string): RunSnapshot => {
    const run = runs.get(runId)
    if (!run) throw new Error(`unknown run: ${runId}`)
    return run
  }

  const apply = (event: RunEvent): RunSnapshot => {
    let run: RunSnapshot
    if (event.type === "run.started") {
      if (runs.has(event.run.runId)) throw new Error(`run already exists: ${event.run.runId}`)
      run = cloneRunSnapshot(event.run)
      runs.set(run.runId, run)
    } else if (event.type === "run.ended") {
      requireRun(event.run.runId)
      run = cloneRunSnapshot(event.run)
      runs.set(run.runId, run)
    } else if (event.type === "run.phase") {
      const current = requireRun(event.runId)
      current.currentPhase = event.value
      if (!current.phases.includes(event.value)) current.phases.push(event.value)
      run = current
    } else if (event.type === "run.log") {
      const current = requireRun(event.runId)
      current.logs.push(event.value)
      run = current
    } else {
      const current = requireRun(event.runId)
      const unit = cloneUnitSnapshot(event.unit)
      const index = current.units.findIndex((candidate) => candidate.unitId === unit.unitId)
      if (index === -1) current.units.push(unit)
      else current.units[index] = unit
      current.units.sort((a, b) => a.ordinal - b.ordinal)
      run = current
    }

    publish(event)
    return cloneRunSnapshot(run)
  }

  return {
    create(run) {
      return apply({ type: "run.started", run })
    },
    get(runId) {
      const run = runs.get(runId)
      return run ? cloneRunSnapshot(run) : undefined
    },
    list() {
      return [...runs.values()]
        .sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
        .map(cloneRunSnapshot)
    },
    apply,
    subscribe(subscriber) {
      subscribers.add(subscriber)
      let active = true
      return () => {
        if (!active) return
        active = false
        subscribers.delete(subscriber)
      }
    },
    subscribers() {
      return subscribers.size
    },
  }
}

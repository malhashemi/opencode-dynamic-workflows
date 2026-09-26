/**
 * The run store — the in-process source of truth for one location's Runs, and its event log.
 *
 * Every change goes through {@link RunStore.apply}: it mutates the Run, bumps the Run's `revision`, and emits one
 * protocol event with the next `seq`. The last {@link EVENT_WINDOW} events are retained so a client that missed
 * some (SSE reconnect, a slow TUI) can catch up with `eventsSince(seq)`; anything older answers "incomplete" and
 * the client re-reads snapshots — the rule in docs/protocol/README.md.
 *
 * Reads and deliveries are cloned: a surface can shape what it receives without reaching into engine state.
 * Events carry FULL data (whole Unit outputs) because the journal is one of the subscribers; transports elide
 * large fields on the way out (see {@link elideEvent}).
 */
import {
  PROTOCOL_VERSION,
  addUsage,
  emptyUsage,
  type ActivityEntry,
  type LibraryEntry,
  type PendingInteraction,
  type ProtocolEvent,
  type ResolvedInteraction,
  type Run,
  type RunHeader,
  type Unit,
  type Usage,
} from "./protocol"

/** How many events a store keeps for catch-up. */
export const EVENT_WINDOW = 5_000

/** Outputs longer than this are elided from bulk payloads; the full value is one `getUnit` away. */
export const ELIDE_OUTPUT_OVER = 4_000

export type StoreChange =
  | { type: "run.started"; run: Run }
  | { type: "run.patch"; runId: string; patch: Partial<RunHeader> }
  | { type: "run.phase"; runId: string; value: string }
  | { type: "run.log"; runId: string; value: string; kind?: ActivityEntry["kind"]; unitId?: string | null }
  | { type: "unit.upsert"; runId: string; unit: Unit }
  | { type: "interaction.pending"; runId: string; interaction: PendingInteraction }
  | {
      type: "interaction.resolved"
      runId: string
      interactionId: string
      by: ResolvedInteraction["by"]
      answers?: string[][]
      outcome?: ResolvedInteraction["outcome"]
    }
  | { type: "run.ended"; runId: string; patch: Partial<RunHeader> }

export type RunSubscriber = (event: ProtocolEvent) => void

export interface RunStore {
  readonly location: string
  create(run: Run): Run
  get(runId: string): Run | undefined
  list(): Run[]
  apply(change: StoreChange): Run
  subscribe(subscriber: RunSubscriber): () => void
  subscribers(): number
  /** Events after `seq`, oldest first. `complete` is false when some were already dropped from the window. */
  eventsSince(seq: number, epoch?: string): { events: ProtocolEvent[]; complete: boolean; latest: number; epoch: string }
  /** Random per store instance (per service process): tells clients the seq sequence started again. */
  readonly epoch: string
  /** Emit a location-wide event (no Run). */
  emit(type: "library.changed" | "resync.required", data: unknown): void
  latestSeq(): number
}

export function cloneUnit(unit: Unit): Unit {
  return {
    ...unit,
    model: { ...unit.model },
    attempts: unit.attempts.map((attempt) => ({ ...attempt })),
    usage: cloneUsage(unit.usage),
  }
}

function cloneUsage(usage: Usage): Usage {
  return { tokens: { ...usage.tokens }, cost: usage.cost }
}

export function clonePendingInteraction(interaction: PendingInteraction): PendingInteraction {
  return {
    ...interaction,
    questions: interaction.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    ...(interaction.permission
      ? {
          permission: {
            ...interaction.permission,
            resources: [...interaction.permission.resources],
            save: [...interaction.permission.save],
          },
        }
      : {}),
    ...(interaction.approval ? { approval: { ...interaction.approval } } : {}),
  }
}

export function cloneResolvedInteraction(interaction: ResolvedInteraction): ResolvedInteraction {
  return {
    ...interaction,
    questions: interaction.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    answers: interaction.answers.map((row) => [...row]),
    ...(interaction.permission
      ? {
          permission: {
            ...interaction.permission,
            resources: [...interaction.permission.resources],
            save: [...interaction.permission.save],
          },
        }
      : {}),
    ...(interaction.approval ? { approval: { ...interaction.approval } } : {}),
  }
}

export function cloneRun(run: Run): Run {
  return {
    ...run,
    workflow: { ...run.workflow },
    phases: [...run.phases],
    units: run.units.map(cloneUnit),
    logs: [...run.logs],
    errors: run.errors.map((error) => ({ ...error })),
    interactions: run.interactions.map(clonePendingInteraction),
    resolved: run.resolved.map(cloneResolvedInteraction),
    usage: cloneUsage(run.usage),
    budget: { ...run.budget },
  }
}

export function runHeader(run: Run): RunHeader {
  const { units: _units, logs: _logs, interactions: _interactions, resolved: _resolved, ...header } = cloneRun(run)
  return header
}

/** A unit's result as the store carries it: JSON for structured values, verbatim for text. */
export function toUnitOutput(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return text.length > 0 ? text : undefined
}

export function elideUnit(unit: Unit, limit = ELIDE_OUTPUT_OVER): Unit {
  if (unit.output === undefined || unit.output.length <= limit) return cloneUnit(unit)
  const copy = cloneUnit(unit)
  delete copy.output
  copy.outputElided = true
  return copy
}

export function elideRun(run: Run, limit = ELIDE_OUTPUT_OVER): Run {
  const copy = cloneRun(run)
  copy.units = copy.units.map((unit) => elideUnit(unit, limit))
  return copy
}

/** The same event with large Unit outputs removed — what transports send. */
export function elideEvent(event: ProtocolEvent, limit = ELIDE_OUTPUT_OVER): ProtocolEvent {
  if (event.type === "unit.updated") return { ...event, data: elideUnit(event.data as Unit, limit) }
  if (event.type === "run.started") return { ...event, data: elideRun(event.data as Run, limit) }
  return event
}

export function settledUnitCount(run: Pick<Run, "units">): number {
  return run.units.filter((unit) => isSettled(unit.status)).length
}

export function isSettled(status: Unit["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "stopped" || status === "replayed"
}

export function isTerminal(status: Run["status"]): boolean {
  return status !== "running" && status !== "queued"
}

export function toLibraryEntry(run: Run, live: boolean): LibraryEntry {
  return {
    runId: run.runId,
    workflow: { ...run.workflow },
    location: run.location,
    parentSessionID: run.parentSessionID,
    status: run.status,
    waiting: run.interactions.length > 0,
    units: run.units.length,
    settledUnits: settledUnitCount(run),
    failedUnits: run.units.filter((unit) => unit.status === "failed" || unit.status === "stopped").length,
    phases: [...run.phases],
    phasesDeclared: run.phasesDeclared,
    currentPhase: run.currentPhase,
    usage: cloneUsage(run.usage),
    tokensSpent: run.tokensSpent,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    live,
  }
}

/** Fold a pending interaction and its outcome into the record that outlives it. */
export function toResolvedInteraction(
  interaction: PendingInteraction,
  outcome: { answers?: string[][]; by: ResolvedInteraction["by"]; outcome?: ResolvedInteraction["outcome"]; now?: number },
): ResolvedInteraction {
  const { graceEndsAt: _graceEndsAt, ...record } = clonePendingInteraction(interaction)
  const answers = (outcome.answers ?? []).map((row) => [...row])
  const inferred = outcome.outcome ?? (answers.length > 0 ? "answered" : undefined)
  return {
    ...record,
    answers,
    by: outcome.by,
    ...(inferred ? { outcome: inferred } : {}),
    resolvedAt: outcome.now ?? Date.now(),
  }
}

/** A fresh Run with every collection empty — the one place its defaults are decided. */
export function newRun(input: {
  runId: string
  workflow: Run["workflow"]
  location: string
  parentSessionID: string
  phases?: string[]
  budget?: number | null
  hardBudget?: boolean
  background?: boolean
  resumeOf?: string | null
  status?: Run["status"]
  startedAt?: number
}): Run {
  const phases = input.phases ?? []
  return {
    runId: input.runId,
    workflow: { ...input.workflow },
    location: input.location,
    parentSessionID: input.parentSessionID,
    status: input.status ?? "running",
    waiting: false,
    background: input.background ?? false,
    phases: [...phases],
    phasesDeclared: phases.length > 0,
    currentPhase: null,
    units: [],
    logs: [],
    errors: [],
    interactions: [],
    resolved: [],
    usage: emptyUsage(),
    tokensSpent: 0,
    budget: { total: input.budget ?? null, hard: input.hardBudget ?? false },
    startedAt: input.startedAt ?? Date.now(),
    endedAt: null,
    resultPreview: null,
    resumeOf: input.resumeOf ?? null,
    error: null,
    cleanup: "none",
    revision: 0,
  }
}

export function createRunStore(location: string): RunStore {
  const runs = new Map<string, Run>()
  const subscribers = new Set<RunSubscriber>()
  const window: ProtocolEvent[] = []
  let seq = 0
  const epoch = crypto.randomUUID().slice(0, 8)

  const publish = (event: ProtocolEvent) => {
    window.push(event)
    if (window.length > EVENT_WINDOW) window.splice(0, window.length - EVENT_WINDOW)
    for (const subscriber of Array.from(subscribers)) {
      try {
        subscriber(structuredClone(event))
      } catch {
        // Subscribers observe; a faulty one never changes engine state or starves the others.
      }
    }
  }

  const event = (run: Run | null, type: ProtocolEvent["type"], data: unknown): ProtocolEvent => ({
    protocol: PROTOCOL_VERSION,
    seq: ++seq,
    epoch,
    time: Date.now(),
    location,
    runId: run?.runId ?? "",
    type,
    revision: run?.revision ?? 0,
    data,
  })

  const requireRun = (runId: string): Run => {
    const run = runs.get(runId)
    if (!run) throw new Error(`unknown run: ${runId}`)
    return run
  }

  const recount = (run: Run) => {
    run.waiting = run.interactions.length > 0
    run.usage = run.units.reduce((sum, unit) => addUsage(sum, unit.usage), emptyUsage())
  }

  const apply = (change: StoreChange): Run => {
    let run: Run
    const out: Array<[ProtocolEvent["type"], () => unknown]> = []

    switch (change.type) {
      case "run.started": {
        if (runs.has(change.run.runId)) throw new Error(`run already exists: ${change.run.runId}`)
        run = cloneRun(change.run)
        runs.set(run.runId, run)
        run.revision += 1
        recount(run)
        out.push(["run.started", () => cloneRun(run)])
        break
      }
      case "run.patch":
      case "run.ended": {
        run = requireRun(change.runId)
        const { revision: _revision, ...patch } = change.patch
        Object.assign(run, structuredClone(patch))
        run.revision += 1
        recount(run)
        out.push([change.type === "run.ended" ? "run.ended" : "run.updated", () => runHeader(run)])
        break
      }
      case "run.phase": {
        run = requireRun(change.runId)
        run.currentPhase = change.value
        if (!run.phases.includes(change.value)) run.phases.push(change.value)
        run.revision += 1
        out.push(["run.updated", () => runHeader(run)])
        const entry: ActivityEntry = { kind: "phase", message: change.value, time: Date.now(), unitId: null }
        out.push(["activity.appended", () => ({ ...entry })])
        break
      }
      case "run.log": {
        run = requireRun(change.runId)
        // Capability audit lines live in the activity feed only; `logs` stays the author's own narration.
        if (change.kind !== "capability") run.logs.push(change.value)
        run.revision += 1
        const entry: ActivityEntry = {
          kind: change.kind ?? "log",
          message: change.value,
          time: Date.now(),
          unitId: change.unitId ?? null,
        }
        out.push(["activity.appended", () => ({ ...entry })])
        break
      }
      case "unit.upsert": {
        run = requireRun(change.runId)
        if (isTerminal(run.status)) return cloneRun(run) // a finished Run's Units are final
        const unit = cloneUnit(change.unit)
        const index = run.units.findIndex((candidate) => candidate.unitId === unit.unitId)
        if (index === -1) run.units.push(unit)
        else run.units[index] = unit
        run.units.sort((a, b) => a.ordinal - b.ordinal)
        run.revision += 1
        recount(run)
        out.push(["unit.updated", () => cloneUnit(unit)])
        break
      }
      case "interaction.pending": {
        run = requireRun(change.runId)
        if (isTerminal(run.status)) return cloneRun(run)
        const interaction = clonePendingInteraction(change.interaction)
        if (interaction.phase === null) interaction.phase = run.currentPhase
        const index = run.interactions.findIndex((candidate) => candidate.interactionId === interaction.interactionId)
        if (index === -1) run.interactions.push(interaction)
        else run.interactions[index] = interaction
        run.revision += 1
        recount(run)
        out.push(["interaction.pending", () => clonePendingInteraction(interaction)])
        break
      }
      case "interaction.resolved": {
        run = requireRun(change.runId)
        const settled = run.interactions.find((candidate) => candidate.interactionId === change.interactionId)
        // Idempotent: the first resolver files the record; any later observer of the same resolution is a no-op.
        if (!settled) return cloneRun(run)
        run.interactions = run.interactions.filter((candidate) => candidate.interactionId !== change.interactionId)
        const record = toResolvedInteraction(settled, { answers: change.answers, by: change.by, outcome: change.outcome })
        run.resolved.push(record)
        run.revision += 1
        recount(run)
        out.push(["interaction.resolved", () => cloneResolvedInteraction(record)])
        break
      }
    }

    for (const [type, data] of out) publish(event(run, type, data()))
    if (change.type === "run.started" || change.type === "run.ended") {
      publish(event(null, "library.changed", toLibraryEntry(run, !isTerminal(run.status))))
    }
    return cloneRun(run)
  }

  return {
    location,
    create(run) {
      return apply({ type: "run.started", run })
    },
    get(runId) {
      const run = runs.get(runId)
      return run ? cloneRun(run) : undefined
    },
    list() {
      return [...runs.values()]
        .toSorted((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
        .map(cloneRun)
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
    epoch,
    eventsSince(after, clientEpoch) {
      const first = window[0]
      if (clientEpoch !== undefined && clientEpoch !== epoch) {
        return { events: window.map((entry) => structuredClone(entry)), complete: false, latest: seq, epoch }
      }
      // A client ahead of us saw another epoch (the service restarted and seq started again): not complete.
      const complete = after <= seq && (after === seq || (first !== undefined && after >= first.seq - 1))
      return {
        events: window.filter((entry) => entry.seq > after).map((entry) => structuredClone(entry)),
        complete,
        latest: seq,
        epoch,
      }
    },
    emit(type, data) {
      publish(event(null, type, data))
    },
    latestSeq() {
      return seq
    },
  }
}

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
   * the answer.
   */
  output?: string
  /**
   * `output` was REMOVED from this payload, not absent from the unit.
   *
   * Set only by {@link elideRunOutputs}, and only on the transport: the store always holds the whole answer.
   * It exists because "this unit produced nothing" and "the answer lives on disk" are two different facts and a
   * missing field says both — a surface that could not tell them apart would render an empty panel meaning
   * either, which is exactly the ambiguity the honesty rule forbids.
   *
   * A reader that has never heard of this field sees `output: undefined` and shows nothing, which is the same
   * behaviour it had before elision existed. That is the point: eliding a field is not a change of contract.
   */
  outputElided?: boolean
}

/**
 * A unit's result, as the store should carry it: JSON for structured values, verbatim for text — whole.
 *
 * Deliberately uncapped. Two earlier versions capped it, and both were wrong for the same reason: a per-answer
 * limit damages the common case (a real research synthesis is 10–30k characters, and the unit screen is a
 * scrollbox that can show all of it) in order to mitigate a rare one. The rare case is real — settled runs
 * persist for the session, so `/state` would grow as a session accumulates history — but the fix for that is
 * {@link elideRunOutputs}: the journal owns the full answer on disk, `/state` carries it elided, and the unit
 * screen fetches the single output it is displaying.
 */
export function toUnitOutput(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2)
  return text.length > 0 ? text : undefined
}

/**
 * The same run with every unit's answer replaced by a marker saying where it went.
 *
 * `/state` is a BOOTSTRAP payload: it carries every run the process still holds and is re-sent in full on every
 * reconnect, and settled runs persist for the session. So a session that ran ten research workflows re-shipped
 * a few hundred kilobytes of prose on each resync, to a screen showing one row per run and none of that text.
 *
 * The instrument deliberately NOT used here is a per-answer cap: it damages the common case (the unit screen is
 * a scrollbox built to show a whole synthesis) to bound a rare one, and two attempts at it were reverted. What
 * is bounded instead is the payload that carries every answer at once. The single answer a user actually opened
 * is read on demand from the journal, which already had it.
 */
export function elideRunOutputs(run: RunSnapshot): RunSnapshot {
  const elided = cloneRunSnapshot(run)
  for (const unit of elided.units) {
    if (unit.output === undefined) continue
    delete unit.output
    unit.outputElided = true
  }
  return elided
}

/**
 * One question in an interaction, mirroring the host's `QuestionInfo` field for field.
 *
 * Mirrored rather than reshaped so an agent-raised question and a script-raised one are the SAME thing by the
 * time they reach a surface: one pane renders both, one control action answers both, and the label-matched
 * answer format is the host's own rather than a translation of it. (`prompt` is the host's `question` field,
 * renamed only because "question.question" reads as a typo everywhere it is used.)
 */
export interface InteractionQuestion {
  header: string
  prompt: string
  options: { label: string; description: string }[]
  multiple: boolean
  /** Whether the host permits a free-text answer alongside the offered labels. */
  custom: boolean
}

/**
 * Everything an interaction carries whether or not anyone has answered it yet.
 *
 * Split out so a pending question and the record of an answered one are the SAME thing plus or minus a
 * deadline: one pane renders both, one row model lists both, and nothing downstream has to hold two shapes
 * for what a user experiences as one object with a before and an after.
 */
export interface InteractionRecord {
  requestID: string
  kind: "question" | "permission"
  /**
   * Who raised it — and therefore how it resolves.
   *
   * `agent` requests exist in the HOST (`GET /question`), so answering means `POST /question/{id}/reply`.
   * `script` requests exist only here: the host has no create-question endpoint, questions there originate from
   * a model's tool call, so `ctx.ask` publishes into this store and answering resolves a local promise.
   * Orthogonal to `unitId`, which says *where* in the run it came from, not who made it.
   */
  origin: "agent" | "script"
  /** The session the request was raised in. For a script ask, the run's own parent session. */
  sessionID: string
  /** The unit that owns the asking session, or `null` when the request came from the run root. */
  unitId: string | null
  /** One-based, per `RunOwnership`: a request on a run root is depth 1, a direct child is depth 2. */
  depth: number
  /**
   * The phase the run was in when the question was RAISED.
   *
   * Stamped by the store rather than by whoever published it: the watcher does not know what a phase is, and
   * `ctx.ask` should not have to. It exists so a script's question has somewhere to live in the run tree once
   * it is answered — an answer filed under no phase is an answer nobody finds again.
   */
  phase: string | null
  /** The form. One entry for an agent question or a permission; several when a script asks a multi-part form. */
  questions: InteractionQuestion[]
  raisedAt: number
}

/**
 * Something inside a run that is waiting on a person.
 *
 * Present in `RunSnapshot.interactions` only while it is genuinely BLOCKED on a human decision — an interaction
 * the engine resolves without asking never appears here, because a badge that lights up for something nobody
 * has to answer teaches the user to ignore the badge.
 */
export interface PendingInteraction extends InteractionRecord {
  /**
   * When automation takes it back; `null` when there is no deadline at all.
   *
   * `null` is the DEFAULT, not an edge case: a grace period is opt-in per workflow (`meta.interaction.graceMs`)
   * or per ask (`ctx.ask({ graceMs })`). Most questions are too important to be answered by a timer.
   */
  graceEndsAt: number | null
}

/**
 * An interaction that has been settled, kept rather than dropped.
 *
 * Before this existed a resolved question simply vanished — from the pane, from the run, from the record — so
 * "what was I asked, and what did I say?" was unanswerable thirty seconds after answering it. Retaining the
 * offered options alongside the chosen answer is deliberate: the answer alone (`["EU"]`) is meaningless without
 * the question and the set it was drawn from, and the run is the only place that ever held them together.
 */
export interface ResolvedInteraction extends InteractionRecord {
  /**
   * What was chosen — one entry per question, each a list of labels, exactly the reply shape.
   *
   * Empty when the engine settled it without learning the answer: the watcher observing a question leave the
   * host's pending list knows only THAT it went. Rendered as "answered elsewhere" rather than as a blank
   * choice, because inventing an answer here is the one thing worse than not having one.
   */
  answers: string[][]
  by: "human" | "automation"
  /**
   * WHAT happened, when "who did it" is not the whole story.
   *
   * `answered` — the labels in {@link ResolvedInteraction.answers} were sent as the reply.
   * `rejected` — nobody answered it: the request was refused at the host and the asking unit saw a denial.
   * absent — it settled and this process never learned which, which is the honest reading of an older record
   * and of a question a human answered in the host's own dialog.
   *
   * A rejection is not an empty answer, and recording it as one is how "the ladder gave up" came to read
   * identically to "we did not see what was said". Optional so a record written before this field existed still
   * reads back as the "we do not know" it always was.
   */
  outcome?: "answered" | "rejected"
  resolvedAt: number
}

export function clonePendingInteraction(interaction: PendingInteraction): PendingInteraction {
  return {
    ...interaction,
    questions: interaction.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
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
  }
}

/** Fold a pending interaction and its outcome into the record that outlives it. */
export function toResolvedInteraction(
  interaction: PendingInteraction,
  outcome: {
    answers?: string[][]
    by: "human" | "automation"
    outcome?: ResolvedInteraction["outcome"]
    now?: number
  },
): ResolvedInteraction {
  const { graceEndsAt: _graceEndsAt, ...record } = clonePendingInteraction(interaction)
  const answers = (outcome.answers ?? []).map((row) => [...row])
  return {
    ...record,
    answers,
    by: outcome.by,
    // Answers with no stated outcome can only mean one thing, so infer it rather than making every caller say
    // it twice. The reverse is never inferred: an empty answer list is exactly the case that must not be
    // guessed at.
    ...(outcome.outcome ?? (answers.length > 0 ? "answered" : undefined)
      ? { outcome: outcome.outcome ?? "answered" }
      : {}),
    resolvedAt: outcome.now ?? Date.now(),
  }
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
  /**
   * Interactions currently waiting on a person, newest last.
   *
   * Lives on the run rather than in a side channel because every surface — the sidebar badge, the run browser's
   * question level, the dashboard's answer card — needs the same list, and a second source of truth is how two
   * surfaces come to disagree about whether anyone is waiting.
   */
  interactions: PendingInteraction[]
  /**
   * Interactions that have been answered, oldest first — the run's own record of what it asked and was told.
   *
   * Kept on the run rather than only in the journal because the run browser has to render them while the run is
   * still going: a question answered in phase 1 is context for phase 3, and a surface that can only show what is
   * still waiting shows nothing at all for the overwhelming majority of a run's life.
   */
  resolved: ResolvedInteraction[]
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
  | { type: "interaction.pending"; runId: string; interaction: PendingInteraction }
  /**
   * `answers` is present only when the resolver actually knows them — the surface that replied, or the script
   * ask settling its own promise. Absent means "it went, and we did not see what was said", which is a
   * different statement from "it was answered with nothing".
   */
  | {
      type: "interaction.resolved"
      runId: string
      requestID: string
      by: "human" | "automation"
      answers?: string[][]
      /**
       * `rejected` when nothing was answered at all — the ladder's terminus, or a person refusing a permission.
       * Absent means the resolver genuinely did not learn what happened.
       */
      outcome?: ResolvedInteraction["outcome"]
    }

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
    // Tolerated as absent rather than required: a snapshot can arrive over the wire from an engine older than
    // this reader (two hosts, two checkouts, one project), and a missing list means "nobody is waiting", which
    // is both true of that engine and harmless here.
    interactions: (run.interactions ?? []).map(clonePendingInteraction),
    resolved: (run.resolved ?? []).map(cloneResolvedInteraction),
  }
}

export function cloneRunEvent(event: RunEvent): RunEvent {
  if (event.type === "run.started" || event.type === "run.ended") {
    return { type: event.type, run: cloneRunSnapshot(event.run) }
  }
  if (event.type === "run.phase" || event.type === "run.log") return { ...event }
  if (event.type === "interaction.pending") {
    return { type: event.type, runId: event.runId, interaction: clonePendingInteraction(event.interaction) }
  }
  if (event.type === "interaction.resolved") {
    return { ...event, answers: event.answers?.map((row) => [...row]) }
  }
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
    } else if (event.type === "interaction.pending") {
      const current = requireRun(event.runId)
      const interaction = clonePendingInteraction(event.interaction)
      // The phase is stamped HERE because the store is the only party that holds both the question and where
      // the run had got to. A publisher that already knows (a script ask reads the run) keeps its own answer.
      if (interaction.phase === null) interaction.phase = current.currentPhase
      const index = current.interactions.findIndex((candidate) => candidate.requestID === interaction.requestID)
      // Upsert rather than append: the watcher republishes a request whose grace it re-based, and a duplicate
      // row would make the badge count one waiting question twice.
      if (index === -1) current.interactions.push(interaction)
      else current.interactions[index] = interaction
      run = current
    } else if (event.type === "interaction.resolved") {
      const current = requireRun(event.runId)
      const settled = current.interactions.find((candidate) => candidate.requestID === event.requestID)
      // Deliberately idempotent. Two parties can observe the same resolution — the surface that answered, and
      // the watcher noticing it left the host's pending list — and neither should have to check first. Only the
      // FIRST one finds a pending row, so only the first one files a record; the second is a no-op rather than
      // a duplicate answer.
      if (settled) {
        current.interactions = current.interactions.filter((candidate) => candidate.requestID !== event.requestID)
        current.resolved.push(
          toResolvedInteraction(settled, { answers: event.answers, by: event.by, outcome: event.outcome }),
        )
      }
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

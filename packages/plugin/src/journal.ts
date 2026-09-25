/**
 * The run journal — what makes a Run a record rather than an event that happened.
 *
 * The shape on disk is deliberately dumb, because the thing that reads it may be a different process, a
 * different version, or a person with `cat`:
 *
 *     <project>/.opencode/workflows/runs/<runId>/
 *     ├── run.json      the latest Run snapshot, the args it was given, and the owning process
 *     ├── units.jsonl   one protocol event per line: Unit transitions and resolved interactions, in order
 *     ├── script.ts     the verbatim source, inline and durable alike
 *     └── result.json   the consolidated result, written once when the Run settles
 *
 * Two rules hold everywhere in here:
 *
 * 1. **A journal error is never a Run error.** Every write is chained, caught, and reported.
 * 2. **A partial record is still a record.** A killed process leaves a `run.json` that says `running` and a
 *    `units.jsonl` whose last line may be torn; `read` skips the torn line and folds the rest back in.
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { LibraryEntry, ProtocolEvent, ResolvedInteraction, Run, Unit } from "./protocol"
import { addUsage, emptyUsage } from "./protocol"
import { newRun, toLibraryEntry, type RunStore } from "./runs"

export interface JournalRecord {
  run: Run
  /** The verbatim `script.ts`; `""` when the file is missing. */
  source: string
  args: unknown
  result?: unknown
  /** `units.jsonl`, in the order the transitions happened. */
  transitions: ProtocolEvent[]
  owner: JournalOwner | null
}

/** The process that ran a Run. `startedAt` (process start, ms) tells a reused PID apart from the original. */
export interface JournalOwner {
  pid: number
  instance: string
  startedAt?: number
}

export interface JournalListOptions {
  limit?: number
  status?: Run["status"][]
}

export interface Journal {
  root: string
  begin(run: Run, input: { source: string; args: unknown; instance: string }): Promise<void>
  /** Record one transition. Only `unit.updated` and `interaction.resolved` are journaled. */
  append(event: ProtocolEvent): Promise<void>
  /** Rewrite `run.json` with the latest snapshot (status changes, cleanup bookkeeping). */
  update(run: Run): Promise<void>
  finish(run: Run, result: unknown): Promise<void>
  read(runId: string): Promise<JournalRecord | null>
  list(options?: JournalListOptions): Promise<LibraryEntry[]>
  /** Resolve once every pending write has landed (tests, shutdown). */
  flush(): Promise<void>
}

export interface JournalOptions {
  onError?: (error: unknown, context: string) => void
}

const RUN_FILE = "run.json"
const UNITS_FILE = "units.jsonl"
const SCRIPT_FILE = "script.ts"
const RESULT_FILE = "result.json"
const RECORD_VERSION = 2

const RUN_STATUSES: readonly Run["status"][] = ["queued", "running", "succeeded", "failed", "stopped", "interrupted"]
/** V1 records (`done`/`aborted`) still read back. */
const LEGACY_STATUS: Record<string, Run["status"]> = { done: "succeeded", aborted: "stopped" }
const LEGACY_UNIT_STATUS: Record<string, Unit["status"]> = { ok: "succeeded" }

interface RunDocument {
  version: number
  run: Run
  args: unknown
  owner: JournalOwner | null
}

/** `<root>/.opencode/workflows/runs` — the journal for one project. */
export function journalRoot(directory: string): string {
  return path.join(directory, ".opencode", "workflows", "runs")
}

function isJournaledEvent(event: ProtocolEvent): boolean {
  return event.type === "unit.updated" || event.type === "interaction.resolved"
}

function normalizeUnit(value: unknown, runId: string): Unit | null {
  if (typeof value !== "object" || value === null) return null
  const unit = value as Partial<Unit> & { status?: string; output?: unknown }
  if (typeof unit.unitId !== "string" || typeof unit.ordinal !== "number") return null
  const status = (LEGACY_UNIT_STATUS[unit.status ?? ""] ?? unit.status) as Unit["status"]
  return {
    unitId: unit.unitId,
    runId: typeof unit.runId === "string" ? unit.runId : runId,
    ordinal: unit.ordinal,
    label: typeof unit.label === "string" ? unit.label : null,
    subagent: typeof unit.subagent === "string" ? unit.subagent : "general",
    phase: typeof unit.phase === "string" ? unit.phase : null,
    status: ["queued", "running", "repairing", "succeeded", "failed", "stopped", "replayed"].includes(status) ? status : "failed",
    sessionID: typeof unit.sessionID === "string" ? unit.sessionID : null,
    location: typeof unit.location === "string" ? unit.location : null,
    prompt: typeof unit.prompt === "string" ? unit.prompt : "",
    model: {
      requested: typeof unit.model?.requested === "string" ? unit.model.requested : null,
      resolved: typeof unit.model?.resolved === "string" ? unit.model.resolved : null,
    },
    schema: unit.schema === true,
    resultPath: unit.resultPath ?? null,
    attempts: Array.isArray(unit.attempts) ? unit.attempts : [],
    ...(typeof unit.output === "string" ? { output: unit.output } : {}),
    ...(typeof unit.error === "string" ? { error: unit.error } : {}),
    usage: unit.usage ?? { tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 },
    startedAt: typeof unit.startedAt === "number" ? unit.startedAt : null,
    endedAt: typeof unit.endedAt === "number" ? unit.endedAt : null,
  }
}

/** The narrowest check that makes a parsed `run.json` usable; older records fill in defaults. */
function parseRunDocument(value: unknown): RunDocument | null {
  if (typeof value !== "object" || value === null) return null
  const document = value as { version?: number; run?: Record<string, unknown>; args?: unknown; owner?: unknown }
  const run = document.run
  if (!run || typeof run !== "object") return null
  if (typeof run.runId !== "string" || run.runId.length === 0) return null
  const status = (LEGACY_STATUS[String(run.status)] ?? run.status) as Run["status"]
  if (!RUN_STATUSES.includes(status)) return null
  if (typeof run.startedAt !== "number" || !Number.isFinite(run.startedAt)) return null
  const workflow =
    typeof run.workflow === "object" && run.workflow !== null
      ? (run.workflow as Run["workflow"])
      : {
          key: null,
          name: typeof run.workflow === "string" ? run.workflow : "workflow",
          description: "",
          provenance: run.provenance === "durable" ? ("durable" as const) : ("inline" as const),
        }
  const base = newRun({
    runId: run.runId,
    workflow,
    location: typeof run.location === "string" ? run.location : "",
    parentSessionID: typeof run.parentSessionID === "string" ? run.parentSessionID : "",
    startedAt: run.startedAt,
  })
  const owner = document.owner as RunDocument["owner"]
  return {
    version: typeof document.version === "number" ? document.version : 0,
    args: document.args,
    owner: owner && typeof owner.pid === "number" ? owner : null,
    run: {
      ...base,
      status,
      background: run.background === true,
      phases: Array.isArray(run.phases) ? run.phases.filter((phase): phase is string => typeof phase === "string") : [],
      phasesDeclared: run.phasesDeclared === true,
      currentPhase: typeof run.currentPhase === "string" ? run.currentPhase : null,
      units: Array.isArray(run.units) ? run.units.map((unit) => normalizeUnit(unit, base.runId)).filter((unit): unit is Unit => !!unit) : [],
      logs: Array.isArray(run.logs) ? run.logs.filter((log): log is string => typeof log === "string") : [],
      errors: Array.isArray(run.errors) ? (run.errors as Run["errors"]) : [],
      interactions: [],
      resolved: Array.isArray(run.resolved) ? (run.resolved as ResolvedInteraction[]) : [],
      usage: (run.usage as Run["usage"]) ?? base.usage,
      tokensSpent: typeof run.tokensSpent === "number" ? run.tokensSpent : 0,
      budget: (run.budget as Run["budget"]) ?? base.budget,
      endedAt: typeof run.endedAt === "number" ? run.endedAt : null,
      resultPreview: typeof run.resultPreview === "string" ? run.resultPreview : null,
      error: typeof run.error === "string" ? run.error : null,
      resumeOf: typeof run.resumeOf === "string" ? run.resumeOf : null,
      cleanup: run.cleanup === "pending" || run.cleanup === "done" ? run.cleanup : "none",
      revision: typeof run.revision === "number" ? run.revision : 0,
    },
  }
}

/** Fold `units.jsonl` into the Run: the last transition of each Unit wins, answered interactions are added. */
function foldTransitions(run: Run, transitions: ProtocolEvent[]): Run {
  const units = new Map(run.units.map((unit) => [unit.unitId, unit] as const))
  const resolved = new Map(run.resolved.map((record) => [record.interactionId, record] as const))
  for (const event of transitions) {
    // `run.json` already holds everything up to its revision. An older line (e.g. the last append failed but the
    // final snapshot was written) must not roll a Unit back to an earlier state.
    if (typeof event.revision === "number" && run.revision > 0 && event.revision <= run.revision) continue
    if (event.type === "unit.updated") {
      const unit = normalizeUnit(event.data, run.runId)
      if (unit) units.set(unit.unitId, unit)
    } else if (event.type === "interaction.resolved") {
      const record = event.data as ResolvedInteraction | undefined
      if (record && typeof record.interactionId === "string") resolved.set(record.interactionId, record)
    }
  }
  const folded = [...units.values()].sort((a, b) => a.ordinal - b.ordinal)
  const newest = transitions.reduce((max, event) => (typeof event.revision === "number" && event.revision > max ? event.revision : max), run.revision)
  return {
    ...run,
    units: folded,
    resolved: [...resolved.values()].sort((a, b) => a.resolvedAt - b.resolvedAt),
    // Totals follow the Units they are made of (after a crash `run.json` may predate the last Units).
    usage: transitions.length > 0 ? folded.reduce((sum, unit) => addUsage(sum, unit.usage), emptyUsage()) : run.usage,
    revision: newest,
  }
}

function defaultOnError(error: unknown, context: string): void {
  console.warn(`[workflow] journal ${context}: ${error instanceof Error ? error.message : String(error)}`)
}

export function createJournal(root: string, options: JournalOptions = {}): Journal {
  const onError = options.onError ?? defaultOnError
  const chains = new Map<string, Promise<void>>()
  const opened = new Map<string, { args: unknown; owner: RunDocument["owner"] }>()
  const runDirectory = (runId: string): string => path.join(root, runId)

  const chain = (runId: string, task: () => Promise<void>, context: string): Promise<void> => {
    const previous = chains.get(runId) ?? Promise.resolve()
    const next = previous.then(task).catch((error: unknown) => onError(error, `${context} (${runId})`))
    chains.set(runId, next)
    void next.then(() => {
      if (chains.get(runId) === next) chains.delete(runId)
    })
    return next
  }

  const writeAtomic = async (file: string, contents: string): Promise<void> => {
    const temp = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temp, contents, "utf8")
      await rename(temp, file)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {})
      throw error
    }
  }

  const writeRun = async (run: Run, args: unknown, owner: RunDocument["owner"]): Promise<void> => {
    const document: RunDocument = { version: RECORD_VERSION, run, args, owner }
    await mkdir(runDirectory(run.runId), { recursive: true })
    await writeAtomic(path.join(runDirectory(run.runId), RUN_FILE), `${JSON.stringify(document, null, 2)}\n`)
  }

  const readDocument = async (runId: string): Promise<RunDocument | null> => {
    try {
      return parseRunDocument(JSON.parse(await readFile(path.join(runDirectory(runId), RUN_FILE), "utf8")) as unknown)
    } catch {
      return null
    }
  }

  const readTransitions = async (runId: string): Promise<ProtocolEvent[]> => {
    const transitions: ProtocolEvent[] = []
    const lines = await readFile(path.join(runDirectory(runId), UNITS_FILE), "utf8").catch(() => "")
    for (const line of lines.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as ProtocolEvent & { unit?: unknown }
        // V1 lines were `{ type: "unit.settled", runId, unit }`; read them as `unit.updated`.
        if (parsed.type !== "unit.updated" && parsed.type !== "interaction.resolved" && parsed.unit) {
          transitions.push({ ...(parsed as ProtocolEvent), type: "unit.updated", data: parsed.unit })
        } else transitions.push(parsed)
      } catch {
        // A torn final line is the normal shape of a killed process.
      }
    }
    return transitions
  }

  return {
    root,

    begin(run, input) {
      const owner: JournalOwner = { pid: process.pid, instance: input.instance, startedAt: processStartedAtSelf() }
      opened.set(run.runId, { args: input.args, owner })
      return chain(
        run.runId,
        async () => {
          const directory = runDirectory(run.runId)
          await mkdir(directory, { recursive: true })
          await appendFile(path.join(directory, UNITS_FILE), "", "utf8")
          await writeAtomic(path.join(directory, SCRIPT_FILE), input.source)
          await writeRun(run, input.args, owner)
        },
        "begin",
      )
    },

    append(event) {
      if (!isJournaledEvent(event) || !opened.has(event.runId)) return Promise.resolve()
      return chain(
        event.runId,
        async () => {
          await appendFile(path.join(runDirectory(event.runId), UNITS_FILE), `${JSON.stringify(event)}\n`, "utf8")
        },
        "append",
      )
    },

    update(run) {
      const known = opened.get(run.runId)
      return chain(
        run.runId,
        async () => {
          const previous = known ? null : await readDocument(run.runId)
          await writeRun(run, known?.args ?? previous?.args, known?.owner ?? previous?.owner ?? null)
        },
        "update",
      )
    },

    finish(run, result) {
      const known = opened.get(run.runId)
      opened.delete(run.runId)
      return chain(
        run.runId,
        async () => {
          await writeRun(run, known?.args, known?.owner ?? null)
          await writeAtomic(
            path.join(runDirectory(run.runId), RESULT_FILE),
            `${JSON.stringify({ result: result === undefined ? null : result }, null, 2)}\n`,
          )
        },
        "finish",
      )
    },

    async read(runId) {
      const document = await readDocument(runId)
      if (!document) return null
      const directory = runDirectory(runId)
      const source = await readFile(path.join(directory, SCRIPT_FILE), "utf8").catch(() => "")
      const transitions = await readTransitions(runId)
      let result: unknown
      try {
        result = (JSON.parse(await readFile(path.join(directory, RESULT_FILE), "utf8")) as { result?: unknown })?.result
      } catch {
        // No result: the Run never settled, or settled without one.
      }
      return { run: foldTransitions(document.run, transitions), source, args: document.args, result, transitions, owner: document.owner }
    },

    async list(listOptions = {}) {
      let entries: string[]
      try {
        entries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
      } catch {
        return []
      }
      const documents = (await Promise.all(entries.map(readDocument))).filter((document): document is RunDocument => !!document)
      const folded = await Promise.all(
        documents.map(async (document) =>
          document.run.units.length > 0 || document.run.status !== "running"
            ? document.run
            : foldTransitions(document.run, await readTransitions(document.run.runId)),
        ),
      )
      const wanted = listOptions.status
      const filtered = wanted && wanted.length > 0 ? folded.filter((run) => wanted.includes(run.status)) : folded
      filtered.sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
      const limited = listOptions.limit !== undefined && listOptions.limit >= 0 ? filtered.slice(0, listOptions.limit) : filtered
      return limited.map((run) => toLibraryEntry(run, false))
    },

    async flush() {
      await Promise.all([...chains.values()])
    },
  }
}

/** Mirror journaled transitions from a live store into the journal. */
export function subscribeJournal(store: RunStore, journal: Journal): () => void {
  return store.subscribe((event) => {
    if (isJournaledEvent(event)) void journal.append(event)
  })
}

/** This process's start time (ms since epoch). */
export function processStartedAtSelf(): number {
  return Math.round(Date.now() - process.uptime() * 1000)
}

/** Another process's start time from `ps` (second precision), or null when it cannot be read. */
export function processStartedAt(pid: number): number | null {
  try {
    // `lstart` is printed in the TZ of `ps`: pin it to UTC so the parse does not depend on anyone's timezone.
    const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { env: { ...process.env, TZ: "UTC" } }).stdout.toString().trim()
    const time = out ? Date.parse(`${out} GMT`) : Number.NaN
    return Number.isFinite(time) ? time : null
  } catch {
    return null
  }
}

/**
 * Does the process that owned a Run still exist? A live PID is not enough — PIDs are reused — so when the owner
 * recorded its start time, the process at that PID must have started then too (within `ps`'s one-second grain).
 */
export function ownerAlive(owner: JournalOwner, startedAt: (pid: number) => number | null = processStartedAt): boolean {
  if (!processAlive(owner.pid)) return false
  if (owner.startedAt === undefined) return true
  const actual = startedAt(owner.pid)
  return actual === null || Math.abs(actual - owner.startedAt) < 3_000
}

/** Is a process alive? `EPERM` means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

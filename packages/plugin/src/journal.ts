/**
 * The run journal — what makes a run a record rather than an event that happened.
 *
 * Nothing survived the server-plugin instance before this: `RunStore` is a `Map`, so a completed run vanished
 * with the process that ran it. That one gap is three missing features at once — the browser has no history,
 * the model cannot ask what a run produced after its session moved on, and Phase 6 has nothing to replay.
 *
 * The shape on disk is deliberately dumb, because the thing that reads it may be a different process, a
 * different version, or a person with `cat`:
 *
 *     <worktree>/.opencode/workflows/runs/<runId>/
 *     ├── run.json      the terminal (or in-flight) RunSnapshot, plus the args the run was given
 *     ├── units.jsonl   one line per unit lifecycle transition, in the order they happened
 *     ├── script.ts     the verbatim source, inline and durable alike
 *     └── result.json   the consolidated result, written once when the run settles
 *
 * Two rules hold everywhere in here:
 *
 * 1. **A journal error is never a run error.** Every write is chained, caught, and reported; nothing in this
 *    module can reject into the engine. A run whose history failed to record still ran.
 * 2. **A partial record is still a record.** A host killed mid-run leaves a `run.json` that says `running` and
 *    a `units.jsonl` whose last line is half-written. `read` skips the torn line and returns the rest, because
 *    the alternative — discarding the whole run — throws away exactly the run a user is most likely asking
 *    about.
 */
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { settledUnits } from "./progress"
import type { RunEvent, RunSnapshot, RunStore } from "./runs"

/**
 * A journaled run, carrying everything a `ListRow` needs.
 *
 * `tokensSpent`, `phases`, `phasesDeclared`, and `currentPhase` are here for one reason: the run browser merges
 * history rows alongside live ones, and a history row that cannot fill the same columns renders as a gappy
 * version of the row above it. Whatever the list shows for a live run, the journal has to be able to answer for
 * a dead one.
 */
export interface RunSummary {
  runId: string
  workflow: string
  provenance: RunSnapshot["provenance"]
  status: RunSnapshot["status"]
  /** Total units the run observed. */
  units: number
  settledUnits: number
  tokensSpent: number
  phases: string[]
  phasesDeclared: boolean
  /**
   * The phase the run was in when it settled.
   *
   * Not in the original sketch, and added for the one column a history row could not otherwise fill: a FAILED
   * run's position (`phase 2/3`) is the first thing anyone asks about it, and `phasePosition` cannot be
   * computed without knowing which phase was current.
   */
  currentPhase: string | null
  startedAt: number
  endedAt: number | null
}

export interface JournalRecord {
  run: RunSnapshot
  /** The verbatim `script.ts` snapshot; `""` when the file is missing. */
  source: string
  args: unknown
  result?: unknown
  /** `units.jsonl`, in the order the transitions happened — so unit START order is preserved. */
  transitions: RunEvent[]
}

export interface JournalListOptions {
  limit?: number
  status?: RunSnapshot["status"][]
}

export interface Journal {
  root: string
  begin(run: RunSnapshot, input: { source: string; args: unknown }): Promise<void>
  /**
   * Record one lifecycle transition. Only `unit.*` events are journaled — run-level state is not an append-only
   * concern, it is whatever `run.json` last said, which {@link Journal.finish} rewrites.
   */
  append(event: RunEvent): Promise<void>
  finish(run: RunSnapshot, result: unknown): Promise<void>
  read(runId: string): Promise<JournalRecord | null>
  list(options?: JournalListOptions): Promise<RunSummary[]>
}

export interface JournalOptions {
  /**
   * Where a write failure goes. Defaults to `console.warn`.
   *
   * This module only ever runs in the SERVER target — the worker process — so a warning lands in the host's
   * stderr rather than painting over a TUI frame. A silently absent history is worse than a noisy one: the
   * failure modes here are an unwritable project directory and a full disk, and both are things the user can
   * act on the moment they are told.
   */
  onError?: (error: unknown, context: string) => void
}

const RUN_FILE = "run.json"
const UNITS_FILE = "units.jsonl"
const SCRIPT_FILE = "script.ts"
const RESULT_FILE = "result.json"

/** Bumped only if the on-disk shape changes incompatibly; `read` tolerates anything it can still parse. */
const RECORD_VERSION = 1

const RUN_STATUSES: readonly RunSnapshot["status"][] = ["running", "done", "failed", "aborted"]

interface RunDocument {
  version: number
  run: RunSnapshot
  args: unknown
}

/** `<root>/.opencode/workflows/runs` — the journal for one project. */
export function journalRoot(worktreeOrDirectory: string): string {
  return path.join(worktreeOrDirectory, ".opencode", "workflows", "runs")
}

export function toRunSummary(run: RunSnapshot): RunSummary {
  return {
    runId: run.runId,
    workflow: run.workflow,
    provenance: run.provenance,
    status: run.status,
    units: run.units.length,
    settledUnits: settledUnits(run),
    tokensSpent: run.tokensSpent,
    phases: [...run.phases],
    phasesDeclared: run.phasesDeclared,
    currentPhase: run.currentPhase,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  }
}

type UnitEvent = Extract<RunEvent, { type: "unit.queued" | "unit.started" | "unit.settled" }>

function isUnitEvent(event: RunEvent): event is UnitEvent {
  return event.type === "unit.queued" || event.type === "unit.started" || event.type === "unit.settled"
}

/**
 * What goes into `units.jsonl` — unit transitions, plus every answered interaction.
 *
 * The answers are appended as they happen rather than relying on the terminal `run.json` alone, because the
 * case a resumed run exists for is a host that DIED: `finish` never ran, so the only record of what the human
 * already said is the line that was written the moment they said it. It also preserves ASK ORDER, which is how
 * a replay matches an answer to the question the script is about to ask again.
 */
function isJournaledEvent(event: RunEvent): boolean {
  return isUnitEvent(event) || event.type === "interaction.resolved"
}

function eventRunId(event: RunEvent): string {
  return event.type === "run.started" || event.type === "run.ended" ? event.run.runId : event.runId
}

/**
 * The narrowest check that makes a parsed `run.json` usable.
 *
 * Deliberately structural rather than exhaustive: a record written by an older version with one field missing
 * should still list and still open, because the alternative is a history section that silently loses runs.
 */
function parseRunDocument(value: unknown): RunDocument | null {
  if (typeof value !== "object" || value === null) return null
  const document = value as Partial<RunDocument>
  const run = document.run as Partial<RunSnapshot> | undefined
  if (!run || typeof run !== "object") return null
  if (typeof run.runId !== "string" || run.runId.length === 0) return null
  if (typeof run.workflow !== "string") return null
  if (!RUN_STATUSES.includes(run.status as RunSnapshot["status"])) return null
  if (typeof run.startedAt !== "number" || !Number.isFinite(run.startedAt)) return null
  return {
    version: typeof document.version === "number" ? document.version : 0,
    args: document.args,
    run: {
      runId: run.runId,
      workflow: run.workflow,
      provenance: run.provenance === "durable" ? "durable" : "inline",
      parentSessionID: typeof run.parentSessionID === "string" ? run.parentSessionID : "",
      status: run.status as RunSnapshot["status"],
      phases: Array.isArray(run.phases) ? run.phases.filter((phase): phase is string => typeof phase === "string") : [],
      phasesDeclared: run.phasesDeclared === true,
      currentPhase: typeof run.currentPhase === "string" ? run.currentPhase : null,
      units: Array.isArray(run.units) ? (run.units as RunSnapshot["units"]) : [],
      logs: Array.isArray(run.logs) ? run.logs.filter((log): log is string => typeof log === "string") : [],
      errors: Array.isArray(run.errors) ? (run.errors as RunSnapshot["errors"]) : [],
      // Always empty on read: a journaled run is over, so nothing in it is still waiting on a person. Records
      // written before Phase 4 have no such field at all, which is the same statement.
      interactions: [],
      // ANSWERED interactions are the opposite: they are exactly what a record is for. A resumed run reads them
      // so it does not re-interrogate the human it already asked, and the browser reads them so "what did I say
      // to this run?" survives the process that asked. Absent in a pre-Phase-4 record, which means "none".
      resolved: Array.isArray(run.resolved) ? (run.resolved as RunSnapshot["resolved"]) : [],
      tokensSpent: typeof run.tokensSpent === "number" && Number.isFinite(run.tokensSpent) ? run.tokensSpent : 0,
      startedAt: run.startedAt,
      endedAt: typeof run.endedAt === "number" && Number.isFinite(run.endedAt) ? run.endedAt : null,
    },
  }
}

/**
 * Rebuild a run's unit list from the transitions when `run.json` cannot supply one.
 *
 * `run.json` is written twice: at `begin`, when the run has no units at all, and at `finish`, when it has all
 * of them. So a record whose host DIED — the case the journal exists for — has a `run.json` full of zeroes and
 * a `units.jsonl` containing everything that actually happened. Reading the record without folding those two
 * together produces a run that ran nothing, which is both false and useless to the two callers that need this:
 * the run browser opening a journaled run, and the unit screen fetching the one answer `/state` elided.
 *
 * `run.json` WINS wherever it has a unit, because when it has any it was written last and is the terminal
 * truth. The transitions only fill gaps, in the order they happened, so the last state a unit reached is the
 * one that survives.
 */
function foldTransitions(run: RunSnapshot, transitions: RunEvent[]): RunSnapshot {
  const known = new Set(run.units.map((unit) => unit.unitId))
  const recovered = new Map<string, RunSnapshot["units"][number]>()
  for (const event of transitions) {
    if (!isUnitEvent(event)) continue
    // A `units.jsonl` line is whatever JSON survived a kill, so nothing here is trusted to be well formed.
    const unit = event.unit as RunSnapshot["units"][number] | undefined
    if (!unit || typeof unit.unitId !== "string" || known.has(unit.unitId)) continue
    recovered.set(unit.unitId, unit)
  }
  if (recovered.size === 0) return run
  return { ...run, units: [...run.units, ...recovered.values()].sort((a, b) => a.ordinal - b.ordinal) }
}

function defaultOnError(error: unknown, context: string): void {
  console.warn(`[workflow] journal ${context}: ${error instanceof Error ? error.message : String(error)}`)
}

export function createJournal(root: string, options: JournalOptions = {}): Journal {
  const onError = options.onError ?? defaultOnError
  /** One write chain per run, so an append can never overtake the `begin` that created its directory. */
  const chains = new Map<string, Promise<void>>()
  /** Runs this instance opened. An append for anything else has no record to append to. */
  const opened = new Map<string, { args: unknown }>()

  const runDirectory = (runId: string): string => path.join(root, runId)

  const chain = (runId: string, task: () => Promise<void>, context: string): Promise<void> => {
    const previous = chains.get(runId) ?? Promise.resolve()
    const next = previous.then(task).catch((error: unknown) => {
      onError(error, `${context} (${runId})`)
    })
    chains.set(runId, next)
    // Drop the chain once it drains, so a long-lived process does not accumulate one promise per run ever seen.
    void next.then(() => {
      if (chains.get(runId) === next) chains.delete(runId)
    })
    return next
  }

  /** Write through a temp file so a killed process never leaves a half-written JSON that reads as corrupt. */
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

  const writeRun = async (run: RunSnapshot, args: unknown): Promise<void> => {
    const document: RunDocument = { version: RECORD_VERSION, run, args }
    await writeAtomic(path.join(runDirectory(run.runId), RUN_FILE), `${JSON.stringify(document, null, 2)}\n`)
  }

  const readSummary = async (runId: string): Promise<RunSummary | null> => {
    try {
      const raw = await readFile(path.join(runDirectory(runId), RUN_FILE), "utf8")
      const document = parseRunDocument(JSON.parse(raw) as unknown)
      return document ? toRunSummary(document.run) : null
    } catch {
      // A run directory without a readable `run.json` is not a run yet (or never became one). Skipping it keeps
      // one broken record from emptying the whole history section.
      return null
    }
  }

  return {
    root,

    begin(run, input) {
      opened.set(run.runId, { args: input.args })
      return chain(
        run.runId,
        async () => {
          const directory = runDirectory(run.runId)
          await mkdir(directory, { recursive: true })
          // Create the transition log up front so a run that never launched a unit still reads back cleanly.
          await appendFile(path.join(directory, UNITS_FILE), "", "utf8")
          await writeAtomic(path.join(directory, SCRIPT_FILE), input.source)
          await writeRun(run, input.args)
        },
        "begin",
      )
    },

    append(event) {
      if (!isJournaledEvent(event)) return Promise.resolve()
      const runId = eventRunId(event)
      if (!opened.has(runId)) return Promise.resolve()
      return chain(
        runId,
        async () => {
          await appendFile(path.join(runDirectory(runId), UNITS_FILE), `${JSON.stringify(event)}\n`, "utf8")
        },
        "append",
      )
    },

    finish(run, result) {
      const args = opened.get(run.runId)?.args
      opened.delete(run.runId)
      return chain(
        run.runId,
        async () => {
          await mkdir(runDirectory(run.runId), { recursive: true })
          await writeRun(run, args)
          await writeAtomic(
            path.join(runDirectory(run.runId), RESULT_FILE),
            `${JSON.stringify({ result: result === undefined ? null : result }, null, 2)}\n`,
          )
        },
        "finish",
      )
    },

    async read(runId) {
      const directory = runDirectory(runId)
      let document: RunDocument | null = null
      try {
        document = parseRunDocument(JSON.parse(await readFile(path.join(directory, RUN_FILE), "utf8")) as unknown)
      } catch {
        return null
      }
      if (!document) return null

      const source = await readFile(path.join(directory, SCRIPT_FILE), "utf8").catch(() => "")
      const transitions: RunEvent[] = []
      const lines = await readFile(path.join(directory, UNITS_FILE), "utf8").catch(() => "")
      for (const line of lines.split("\n")) {
        const trimmed = line.trim()
        if (trimmed.length === 0) continue
        try {
          transitions.push(JSON.parse(trimmed) as RunEvent)
        } catch {
          // A torn final line is the normal shape of a killed process; the transitions before it are still true.
        }
      }

      let result: unknown
      try {
        const parsed = JSON.parse(await readFile(path.join(directory, RESULT_FILE), "utf8")) as { result?: unknown }
        result = parsed?.result
      } catch {
        // No result file: the run never settled, or settled without writing one.
      }

      return { run: foldTransitions(document.run, transitions), source, args: document.args, result, transitions }
    },

    async list(listOptions = {}) {
      let entries: string[]
      try {
        entries = (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        // No journal yet is the normal state of a fresh project, not an error worth reporting.
        return []
      }

      const summaries = (await Promise.all(entries.map(readSummary))).filter(
        (summary): summary is RunSummary => summary !== null,
      )
      const wanted = listOptions.status
      const filtered = wanted && wanted.length > 0 ? summaries.filter((s) => wanted.includes(s.status)) : summaries
      filtered.sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
      const limit = listOptions.limit
      return limit !== undefined && Number.isFinite(limit) && limit >= 0 ? filtered.slice(0, limit) : filtered
    },
  }
}

/**
 * Mirror unit transitions from a live store into the journal.
 *
 * Subscribing rather than journaling from the engine's own path is what keeps the engine free of an extra
 * `await` per unit: the store already fans every transition out to whoever is listening, and one more listener
 * costs the engine nothing it was not already paying.
 */
export function subscribeJournal(store: RunStore, journal: Journal): () => void {
  return store.subscribe((event) => {
    if (!isJournaledEvent(event)) return
    void journal.append(event)
  })
}

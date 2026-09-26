/**
 * The workflow service — the single application boundary for one location (project directory).
 *
 * Every surface goes through these handlers: the `workflow` / `workflow_inline` tools, the TUI (over plugin
 * RPC), the web app and third parties (over the Gateway). Handlers speak protocol v1 types and throw
 * {@link WorkflowProtocolError} for expected failures, so every transport renders the same error.
 *
 * The service lives in the process-wide location slot: a plugin reload re-binds hooks and tools around the SAME
 * service, so Runs in flight keep their store, broker and stop handles (P0 spike S9).
 */
import { existsSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import manifest from "../../package.json" with { type: "json" }
import type { Broker } from "../broker"
import type { ReplayPlan } from "../context"
import { runSlot, runSlotsFull, unitSlot } from "../engine-global"
import { formatModel, type EngineHost, type HostMessage } from "../host"
import { ownerAlive, type Journal } from "../journal"
import { loadWorkflow, loadWorkflowConfig, sha256 } from "../loader"
import { runWorkflow, type RunWorkflowOutput } from "../orchestrator"
import {
  PROTOCOL_VERSION,
  WorkflowProtocolError,
  type ActivityEntry,
  type GetTranscriptOutput,
  type InfoOutput,
  type TranscriptMessage,
  type LibraryEntry,
  type ListRunsInput,
  type ListWorkflowsOutput,
  type ProtocolEvent,
  type Run,
  type Unit,
  type WorkflowIdentity,
} from "../protocol"
import { buildRegistry } from "../registry"
import { MAX_RESTARTS } from "../runner"
import { elideEvent, elideRun, isTerminal, newRun, toLibraryEntry, type RunStore } from "../runs"
import { toJsonSchema } from "../schema-bridge"
import type { UnitIndex } from "../units"
import type { DefineWorkflowConfig } from "../workflow"
import type { PluginConfig } from "./config"

export const PLUGIN_NAME = "@malhashemi/opencode-dynamic-workflows"
export const PLUGIN_VERSION: string = manifest.version

export interface ServiceDeps {
  location: string
  host: EngineHost
  index: UnitIndex
  store: RunStore
  journal: Journal
  broker: Broker
  config: PluginConfig
  instance: string
  opencodeVersion: string
  cacheDir?: string
  /** Project-level "always allow inline Workflows here" flag (backed by plugin storage). */
  approvals: { get(): Promise<boolean>; set(): Promise<void> }
  gatewayUrl: () => string | null
}

export interface StartOptions {
  background?: boolean
  /** Abort signal of a foreground caller (the tool's signal). */
  signal?: AbortSignal
  surface?: string
  replay?: ReplayPlan
  resumeOf?: string | null
  identity?: WorkflowIdentity
}

export interface StartedRun {
  runId: string
  /** Settles when the Run is terminal. Never rejects. */
  done: Promise<{ output?: RunWorkflowOutput; error?: string; run: Run }>
}

interface LiveRun {
  stop: (reason?: string) => void
  units: Map<string, () => void>
  result?: unknown
}

/** Why an input `args` might arrive as a JSON string (a provider quirk); parse only what looks like JSON. */
export function normalizeArgs(args: unknown): unknown {
  if (typeof args !== "string") return args
  const trimmed = args.trim()
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return args
  try {
    return JSON.parse(trimmed)
  } catch {
    return args
  }
}

export function argsSchemaOf(schema: unknown): Record<string, unknown> | null {
  if (!schema) return null
  try {
    return toJsonSchema(schema as Parameters<typeof toJsonSchema>[0])
  } catch {
    return null
  }
}

const ACTIVITY_PER_RUN = 1_000
const CLIP = 20_000

function textOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    const texts = value
      .map((entry) =>
        entry && typeof entry === "object" && "text" in entry ? String((entry as { text: unknown }).text) : "",
      )
      .filter(Boolean)
    if (texts.length > 0) return texts.join("")
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Map a session's messages to the protocol's transcript shape, clipping large parts. */
export function toTranscript(sessionID: string, messages: readonly HostMessage[]): GetTranscriptOutput {
  let clipped = false
  const clip = (text: string | undefined) => {
    if (text === undefined || text.length <= CLIP) return text
    clipped = true
    return `${text.slice(0, CLIP)}… (${text.length - CLIP} more characters)`
  }
  const out: TranscriptMessage[] = messages.map((message) => ({
    role: message.type === "user" || message.type === "assistant" || message.type === "system" ? message.type : "other",
    model: formatModel(message.model),
    error: message.error?.message ?? null,
    parts: (message.content ?? []).map((part) => {
      if (part.type === "text" || part.type === "reasoning") {
        const text = clip(part.text)
        return { kind: part.type, ...(text !== undefined ? { text } : {}) } as TranscriptMessage["parts"][number]
      }
      if (part.type === "tool") {
        const input = clip(textOf(part.state?.input))
        const output = clip(textOf(part.state?.content))
        return {
          kind: "tool" as const,
          tool: {
            name: part.name ?? "tool",
            status: part.state?.status ?? "unknown",
            ...(input !== undefined ? { input } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(part.state?.error?.message ? { error: part.state.error.message } : {}),
          },
        }
      }
      return { kind: "other" as const, text: part.type }
    }),
  }))
  return { sessionID, messages: out, clipped }
}

export class WorkflowService {
  readonly deps: ServiceDeps
  private readonly live = new Map<string, LiveRun>()
  private readonly results = new Map<string, unknown>()
  private readonly activity = new Map<string, ActivityEntry[]>()
  private readonly surfaces = new Map<string, { expires: number; sessionID: string | null }>()
  private readonly started = new Map<string, string>()

  constructor(deps: ServiceDeps) {
    this.deps = deps
    deps.store.subscribe((event) => this.observe(event))
  }

  /** Swap the host after a plugin reload; Units already running keep the one they started with. */
  setHost(host: EngineHost): void {
    this.deps.host = host
  }

  get location(): string {
    return this.deps.location
  }

  private observe(event: ProtocolEvent): void {
    if (event.type !== "activity.appended" || !event.runId) return
    const list = this.activity.get(event.runId) ?? []
    list.push(event.data as ActivityEntry)
    if (list.length > ACTIVITY_PER_RUN) list.splice(0, list.length - ACTIVITY_PER_RUN)
    this.activity.set(event.runId, list)
  }

  // ------------------------------------------------------------------------------------------------------------
  // Surfaces
  // ------------------------------------------------------------------------------------------------------------

  /** A surface says "I am watching" for `ttlMs`. Surfaces re-attach periodically. */
  attach(surface: string, ttlMs = 45_000, sessionID?: string): void {
    this.surfaces.set(surface, { expires: Date.now() + ttlMs, sessionID: sessionID ?? null })
  }

  /** Sessions currently in view on an attached surface. */
  watchedSessions(): string[] {
    return this.attached()
      ? [...this.surfaces.values()].map((entry) => entry.sessionID).filter((id): id is string => !!id)
      : []
  }

  detach(surface: string): void {
    this.surfaces.delete(surface)
  }

  attached(): boolean {
    const now = Date.now()
    let any = false
    for (const [surface, entry] of this.surfaces) {
      if (entry.expires > now) {
        any = true
        continue
      }
      this.surfaces.delete(surface)
    }
    return any
  }

  // ------------------------------------------------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------------------------------------------------

  info(): InfoOutput {
    return {
      protocol: PROTOCOL_VERSION,
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      opencode: this.deps.opencodeVersion,
      location: this.deps.location,
      capabilities: [
        "runs",
        "units",
        "interactions",
        "resume",
        "restart-unit",
        "save",
        "cleanup",
        "events",
        "inline-approval",
      ],
      limits: {
        ...this.deps.config.limits,
        maxConcurrentUnits: this.deps.config.maxConcurrentUnits,
        maxConcurrentRuns: this.deps.config.maxConcurrentRuns,
        providerConcurrency: { ...this.deps.config.providerConcurrency },
      },
      gateway: { url: this.deps.gatewayUrl() },
    }
  }

  async listRuns(input: ListRunsInput = {}): Promise<LibraryEntry[]> {
    const live = this.deps.store
      .list()
      .map((run) => toLibraryEntry(run, this.live.has(run.runId) || !isTerminal(run.status)))
    const seen = new Set(live.map((entry) => entry.runId))
    const history = (await this.deps.journal.list()).filter((entry) => !seen.has(entry.runId))
    let entries = [...live, ...history]
    if (input.status?.length) entries = entries.filter((entry) => input.status!.includes(entry.status))
    if (input.parentSessionID) entries = entries.filter((entry) => entry.parentSessionID === input.parentSessionID)
    if (input.since !== undefined) entries = entries.filter((entry) => entry.startedAt >= input.since!)
    if (input.search) {
      const needle = input.search.toLowerCase()
      entries = entries.filter((entry) =>
        [entry.runId, entry.workflow.name, entry.workflow.key ?? "", entry.workflow.description].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      )
    }
    entries.sort((a, b) => b.startedAt - a.startedAt || a.runId.localeCompare(b.runId))
    return entries.slice(0, input.limit ?? 200)
  }

  /** The full Run (outputs elided when large), live or from the journal. */
  async getRun(runId: string): Promise<{ run: Run; live: boolean }> {
    const live = this.deps.store.get(runId)
    if (live) return { run: elideRun(live), live: !isTerminal(live.status) }
    const record = await this.deps.journal.read(runId)
    if (!record) throw new WorkflowProtocolError("not_found", `No Run "${runId}" in this location.`)
    return { run: elideRun(record.run), live: false }
  }

  async getUnit(runId: string, unitId: string): Promise<Unit> {
    const run = this.deps.store.get(runId) ?? (await this.deps.journal.read(runId))?.run
    if (!run) throw new WorkflowProtocolError("not_found", `No Run "${runId}" in this location.`)
    const unit = run.units.find((candidate) => candidate.unitId === unitId)
    if (!unit) throw new WorkflowProtocolError("not_found", `Run "${runId}" has no Unit "${unitId}".`)
    return unit
  }

  /** A Unit's session, simplified for display (the web app's transcript view). */
  async getTranscript(runId: string, unitId: string): Promise<GetTranscriptOutput> {
    const unit = await this.getUnit(runId, unitId)
    if (!unit.sessionID)
      throw new WorkflowProtocolError(
        "not_found",
        `Unit "${unitId}" has no session (it never started, or was replayed).`,
      )
    let messages: readonly HostMessage[]
    try {
      messages = await this.deps.host.session.context({ sessionID: unit.sessionID })
    } catch (error) {
      throw new WorkflowProtocolError(
        "not_found",
        `The Unit's session is gone (${error instanceof Error ? error.message : String(error)}).`,
      )
    }
    return toTranscript(unit.sessionID, messages)
  }

  async getResult(runId: string): Promise<{ runId: string; status: Run["status"]; result: unknown }> {
    const live = this.deps.store.get(runId)
    if (live && !isTerminal(live.status)) {
      throw new WorkflowProtocolError("invalid_state", `Run "${runId}" has not finished yet.`, { retryable: true })
    }
    if (this.results.has(runId)) return { runId, status: live!.status, result: this.results.get(runId) }
    const record = await this.deps.journal.read(runId)
    if (!record) throw new WorkflowProtocolError("not_found", `No Run "${runId}" in this location.`)
    return { runId, status: record.run.status, result: record.result ?? null }
  }

  async getActivity(runId: string): Promise<ActivityEntry[]> {
    const entries = this.activity.get(runId)
    if (entries) return entries.map((entry) => ({ ...entry }))
    const run = (await this.getRun(runId)).run
    return run.logs.map((message) => ({ kind: "log" as const, message, time: run.startedAt, unitId: null }))
  }

  async listWorkflows(): Promise<ListWorkflowsOutput> {
    const registry = await buildRegistry({
      directory: this.deps.location,
      ...(this.deps.cacheDir ? { cacheDir: this.deps.cacheDir } : {}),
    })
    return {
      workflows: [...registry.entries.values()]
        .toSorted((a, b) => a.key.localeCompare(b.key))
        .map((entry) => ({
          key: entry.key,
          name: entry.meta.name,
          description: entry.meta.description,
          whenToUse: entry.meta.whenToUse ?? null,
          phases: (entry.meta.phases ?? []).map((phase) => ({ title: phase.title, detail: phase.detail ?? null })),
          args: argsSchemaOf(entry.meta.args),
          path: entry.absPath,
          scope: entry.scope,
        })),
      collisions: registry.collisions.map((c) => ({
        key: c.key,
        kept: c.kept,
        shadowed: c.shadowed,
        sameScope: c.sameScope,
      })),
      failures: registry.failures.map((f) => ({ path: f.absPath, error: f.error })),
    }
  }

  eventsSince(after = 0, epoch?: string) {
    const tail = this.deps.store.eventsSince(after, epoch)
    return {
      events: tail.events.map((event) => elideEvent(event)),
      complete: tail.complete,
      latest: tail.latest,
      epoch: tail.epoch,
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // Commands
  // ------------------------------------------------------------------------------------------------------------

  /**
   * Start a Run. Resolves as soon as the Run exists (its `runId` is addressable); `done` settles when it ends.
   * Throws {@link WorkflowProtocolError} when nothing could be started (unknown name, invalid source, …).
   */
  async startRun(
    input: { name?: string; source?: string; args?: unknown; parentSessionID?: string; requestId?: string },
    options: StartOptions = {},
  ): Promise<StartedRun> {
    if (input.requestId && this.started.has(input.requestId)) {
      const runId = this.started.get(input.requestId)!
      return { runId, done: Promise.resolve({ run: this.deps.store.get(runId)! }) }
    }
    if (!!input.name === !!input.source) {
      throw new WorkflowProtocolError(
        "invalid_args",
        "Provide exactly one of `name` (a durable Workflow) or `source` (inline).",
      )
    }
    const args = normalizeArgs(input.args)
    const parentSessionID =
      input.parentSessionID ?? (await this.starterSession(input.name ?? "inline", options.surface))

    let source: string
    let sourcePath: string | undefined
    let identity: WorkflowIdentity
    if (input.name) {
      const registry = await buildRegistry({
        directory: this.deps.location,
        ...(this.deps.cacheDir ? { cacheDir: this.deps.cacheDir } : {}),
      })
      const entry = registry.entries.get(input.name)
      if (!entry) {
        const known = Array.from(registry.entries.keys()).toSorted()
        throw new WorkflowProtocolError(
          "not_found",
          `No durable Workflow named "${input.name}". Registered: ${known.length ? known.join(", ") : "(none)"}.`,
          {
            details: { known },
          },
        )
      }
      source = await readFile(entry.absPath, "utf8")
      sourcePath = entry.absPath
      identity = options.identity ?? {
        key: entry.key,
        name: entry.meta.name,
        description: entry.meta.description,
        provenance: "durable",
      }
    } else {
      source = input.source!
      identity = options.identity ?? { key: null, name: "inline", description: "", provenance: "inline" }
    }

    let config: DefineWorkflowConfig
    try {
      config = (
        await loadWorkflow(source, {
          ...(this.deps.cacheDir ? { cacheDir: this.deps.cacheDir } : {}),
          ...(sourcePath ? { sourcePath } : {}),
        })
      ).config
    } catch (error) {
      throw new WorkflowProtocolError(
        "invalid_args",
        `The Workflow did not load: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (identity.provenance === "inline" && identity.name === "inline") {
      identity = { ...identity, name: config.meta.name, description: config.meta.description }
    }

    const runId = crypto.randomUUID()
    if (input.requestId) this.started.set(input.requestId, runId)
    const needsApproval = identity.provenance === "inline" && !options.resumeOf
    const store = this.deps.store
    store.create(
      newRun({
        runId,
        workflow: identity,
        location: this.deps.location,
        parentSessionID,
        phases: (config.meta.phases ?? []).map((phase) => phase.title),
        background: options.background ?? false,
        resumeOf: options.resumeOf ?? null,
        status: "queued",
      }),
    )
    // Journaled while still queued: a Run refused or stopped before it starts keeps its script (resumable) and a
    // terminal record. The orchestrator's own `begin` later rewrites the same files.
    await this.deps.journal.begin(store.get(runId)!, { source, args, instance: this.deps.instance })
    const live: LiveRun = { stop: () => {}, units: new Map() }
    const queuedStop = new AbortController()
    live.stop = (reason) => queuedStop.abort(new Error(reason ?? "stopped"))
    this.live.set(runId, live)
    const signal = options.signal ? AbortSignal.any([options.signal, queuedStop.signal]) : queuedStop.signal

    let releaseRun: () => void = () => {}
    const done = (async (): Promise<{ output?: RunWorkflowOutput; error?: string; run: Run }> => {
      try {
        if (needsApproval) {
          const verdict = await this.approveInline(runId, source, parentSessionID, signal)
          if (verdict !== true) {
            await this.endQueued(runId, verdict)
            return { error: verdict, run: store.get(runId)! }
          }
        }
        if (signal.aborted) {
          await this.endQueued(runId, "stopped before it started", "stopped")
          return { error: "stopped before it started", run: store.get(runId)! }
        }
        // At most maxConcurrentRuns Runs execute at once; this one waits, queued, for a slot.
        if (runSlotsFull()) {
          store.apply({
            type: "run.log",
            runId,
            value: `waiting: ${this.deps.config.maxConcurrentRuns} Runs are already running (maxConcurrentRuns)`,
            kind: "engine",
          })
        }
        try {
          releaseRun = await runSlot(signal)
        } catch {
          await this.endQueued(runId, "stopped before it started", "stopped")
          return { error: "stopped before it started", run: store.get(runId)! }
        }
        const output = await runWorkflow({
          config,
          source,
          identity,
          args,
          host: this.deps.host,
          index: this.deps.index,
          broker: this.deps.broker,
          store,
          journal: this.deps.journal,
          runId,
          parentSessionID,
          location: this.deps.location,
          instance: this.deps.instance,
          signal,
          background: options.background ?? false,
          limits: this.deps.config.limits,
          slot: unitSlot,
          maxConcurrency: this.deps.config.maxConcurrentUnits,
          resolveWorkflow: (name) => this.resolveDurable(name),
          existingRun: true,
          ...(identity.provenance === "inline" && !this.deps.config.inlineCapabilities
            ? {
                capabilities: {
                  disabled:
                    "inline Workflows have no capabilities in this project (plugin option inlineCapabilities: false)",
                },
              }
            : {}),
          ...(options.replay ? { replay: options.replay } : {}),
          ...(options.resumeOf ? { resumeOf: options.resumeOf } : {}),
          onRegister: (_id, stop) => {
            live.stop = stop
          },
          onUnitSession: (_id, unitId, _sessionID, stop) => {
            live.units.set(unitId, stop)
          },
          onResult: (id, result) => {
            this.results.set(id, result)
          },
          onSettled: (run) => {
            if (run.status === "succeeded" && this.deps.config.retention === "delete-on-success") {
              store.apply({ type: "run.patch", runId, patch: { cleanup: "pending" } })
              void this.deps.journal.update(store.get(runId)!)
            }
          },
        })
        return { output, run: store.get(runId)! }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error), run: store.get(runId)! }
      } finally {
        releaseRun()
        this.live.delete(runId)
      }
    })()
    return { runId, done }
  }

  /** Load a saved Workflow by key (for `ctx.workflow`). */
  private async resolveDurable(name: string): Promise<DefineWorkflowConfig> {
    const registry = await buildRegistry({
      directory: this.deps.location,
      ...(this.deps.cacheDir ? { cacheDir: this.deps.cacheDir } : {}),
    })
    const entry = registry.entries.get(name)
    if (!entry)
      throw new Error(
        `ctx.workflow: no saved Workflow named "${name}" (known: ${Array.from(registry.entries.keys()).toSorted().join(", ") || "none"})`,
      )
    const source = await readFile(entry.absPath, "utf8")
    return (
      await loadWorkflow(source, {
        sourcePath: entry.absPath,
        ...(this.deps.cacheDir ? { cacheDir: this.deps.cacheDir } : {}),
      })
    ).config
  }

  /** The session a surface-started Run is attributed to. */
  private async starterSession(workflow: string, surface = "a workflow surface"): Promise<string> {
    const info = await this.deps.host.session.create({
      title: `⟡ wf · ${workflow} (started from ${surface})`,
      metadata: { workflow: { protocol: PROTOCOL_VERSION, starter: true } },
      permissions: [],
    })
    return info.id
  }

  /** End a Run that never started running. Journaled first, announced second (the orchestrator's rule). */
  private async endQueued(runId: string, reason: string, status: Run["status"] = "failed"): Promise<void> {
    const run = this.deps.store.get(runId)
    if (!run || isTerminal(run.status)) return
    this.deps.store.apply({ type: "run.log", runId, value: reason, kind: "engine" })
    const current = this.deps.store.get(runId)!
    const patch: Partial<Run> = { status, endedAt: Date.now(), error: reason }
    await this.deps.journal.finish({ ...current, ...patch, revision: current.revision + 1 }, null)
    if (!isTerminal(this.deps.store.get(runId)?.status ?? "failed"))
      this.deps.store.apply({ type: "run.ended", runId, patch })
  }

  /** The inline-run gate (P0 S7): project approval, plugin policy, or a person — never silent. */
  private async approveInline(
    runId: string,
    source: string,
    sessionID: string,
    signal: AbortSignal,
  ): Promise<true | string> {
    const policy = this.deps.config.inline
    if (policy === "allow") return true
    if (policy === "deny") return 'inline Workflows are disabled for this project (plugin option inline: "deny")'
    if (await this.deps.approvals.get()) return true
    const verdict = await this.deps.broker.approval({
      runId,
      sessionID,
      detail: {
        sha256: sha256(source),
        bytes: Buffer.byteLength(source),
        preview: source.split("\n").slice(0, 40).join("\n"),
        requestingSessionID: sessionID,
      },
      signal,
    })
    if (verdict === "once") return true
    if (verdict === "project") {
      await this.deps.approvals.set()
      return true
    }
    if (verdict === "reject") return "the inline Workflow was rejected by the user"
    return signal.aborted
      ? "stopped before it started"
      : 'no one approved the inline Workflow (no workflow surface is attached). Open the TUI or the web app and retry, approve inline runs for this project, or set the plugin option inline: "allow".'
  }

  stopRun(runId: string, reason = "stopped by the user"): void {
    const live = this.live.get(runId)
    if (!live) {
      const run = this.deps.store.get(runId)
      if (run && !isTerminal(run.status)) {
        void this.endQueued(runId, reason, "stopped")
        return
      }
      throw new WorkflowProtocolError("invalid_state", `Run "${runId}" is not running.`)
    }
    live.stop(reason)
  }

  stopUnit(runId: string, unitId: string): void {
    const stop = this.live.get(runId)?.units.get(unitId)
    const binding = this.deps.index.all().find((candidate) => candidate.runId === runId && candidate.unitId === unitId)
    if (!stop || !binding || binding.settled)
      throw new WorkflowProtocolError("invalid_state", `Unit "${unitId}" is not running.`)
    stop()
  }

  async restartUnit(runId: string, unitId: string): Promise<void> {
    const binding = this.deps.index.all().find((candidate) => candidate.runId === runId && candidate.unitId === unitId)
    if (!binding || binding.settled)
      throw new WorkflowProtocolError(
        "invalid_state",
        `Unit "${unitId}" is not running; resume the Run to re-run finished Units.`,
      )
    if (binding.restarts >= MAX_RESTARTS)
      throw new WorkflowProtocolError("invalid_state", `Unit "${unitId}" was already restarted ${MAX_RESTARTS} times.`)
    if (binding.restart) throw new WorkflowProtocolError("conflict", `Unit "${unitId}" is already restarting.`)
    if (!binding.turnActive) {
      throw new WorkflowProtocolError(
        "invalid_state",
        `Unit "${unitId}" is finishing its turn; a restart only takes effect while it is working. Try again, or resume the Run later.`,
        { retryable: true },
      )
    }
    binding.restart = true
    await this.deps.host.session.interrupt({ sessionID: binding.sessionID })
    this.deps.store.apply({
      type: "run.log",
      runId,
      value: `restarted a Unit in its own session`,
      kind: "engine",
      unitId,
    })
  }

  /** Resume a finished or interrupted Run: replay what it finished, run the rest live. */
  async resumeRun(runId: string, rerunFailed = true, options: StartOptions = {}): Promise<StartedRun> {
    const live = this.deps.store.get(runId)
    if (live && !isTerminal(live.status))
      throw new WorkflowProtocolError("invalid_state", `Run "${runId}" is still running.`)
    const record = await this.deps.journal.read(runId)
    if (!record || !record.source)
      throw new WorkflowProtocolError("not_found", `Run "${runId}" has no journaled script to resume.`)
    // Another process (a second OpenCode, `opencode run`) may still be running it: never start a second copy.
    if (
      !isTerminal(record.run.status) &&
      record.owner &&
      ownerAlive(record.owner) &&
      !(record.owner.pid === process.pid)
    ) {
      throw new WorkflowProtocolError(
        "invalid_state",
        `Run "${runId}" is still running in another OpenCode process (pid ${record.owner.pid}).`,
        { retryable: true },
      )
    }
    const run = record.run
    const units = new Map<
      number,
      { prompt: string; status: Unit["status"]; output?: string; schema: boolean; subagent: string }
    >()
    for (const unit of run.units) {
      units.set(unit.ordinal, {
        prompt: unit.prompt,
        status: unit.status,
        ...(unit.output !== undefined ? { output: unit.output } : {}),
        schema: unit.schema,
        subagent: unit.subagent,
      })
    }
    // One entry per `ctx.ask` the script got past, in order. An ask released because the Run stopped is not a
    // decision (skip it: ask again); a person handing one back chose the fallback (null replays the fallback).
    const answers = run.resolved
      .filter((entry) => entry.origin === "script" && !(entry.by === "automation" && entry.outcome === "cancelled"))
      .toSorted((a, b) => a.raisedAt - b.raisedAt)
      .map((entry) => (entry.answers.length > 0 ? entry.answers : null))
    const replay: ReplayPlan = { units, answers, rerunFailed, diverged: false }
    // The journaled script, not the file on disk: a resume replays the Run that happened, even if the durable
    // file was edited since (a changed script diverges and runs live from the first changed Unit).
    return this.startRun(
      {
        source: record.source,
        args: record.args,
        ...(run.parentSessionID ? { parentSessionID: run.parentSessionID } : {}),
      },
      { ...options, replay, resumeOf: runId, identity: run.workflow },
    )
  }

  /** Native OpenCode forms are answered through OpenCode's own form API (the TUI does), not through the engine. */
  private refuseNativeForm(runId: string, interactionId: string): void {
    const pending = this.deps.store
      .get(runId)
      ?.interactions.find((candidate) => candidate.interactionId === interactionId)
    if (pending?.form) {
      throw new WorkflowProtocolError(
        "unsupported",
        "This is a native OpenCode form; answer or dismiss it in the OpenCode TUI (/workflows).",
      )
    }
  }

  async replyInteraction(runId: string, interactionId: string, answers: string[][]): Promise<void> {
    this.refuseNativeForm(runId, interactionId)
    if (!(await this.deps.broker.reply(runId, interactionId, answers))) {
      throw new WorkflowProtocolError(
        "conflict",
        "That interaction is not pending, or the answer does not fit its options.",
      )
    }
  }

  async cancelInteraction(runId: string, interactionId: string): Promise<void> {
    this.refuseNativeForm(runId, interactionId)
    if (!(await this.deps.broker.cancel(runId, interactionId))) {
      throw new WorkflowProtocolError("conflict", "That interaction is not pending.")
    }
  }

  /** Promote a Run's script to a durable Workflow in `<project>/.opencode/workflows/`. */
  async saveRun(runId: string, name?: string): Promise<{ key: string; path: string }> {
    const record = await this.deps.journal.read(runId)
    if (!record?.source) throw new WorkflowProtocolError("not_found", `Run "${runId}" has no journaled script.`)
    if (record.run.workflow.provenance === "durable" && !name) {
      throw new WorkflowProtocolError(
        "conflict",
        `${record.run.workflow.key ?? record.run.workflow.name} is already a durable Workflow.`,
      )
    }
    return this.promote(record.source, name ?? record.run.workflow.name)
  }

  async promote(source: string, save: string): Promise<{ key: string; path: string }> {
    let meta: DefineWorkflowConfig["meta"]
    try {
      meta = (await loadWorkflowConfig(source, this.deps.cacheDir ? { cacheDir: this.deps.cacheDir } : {})).meta
    } catch (error) {
      throw new WorkflowProtocolError(
        "invalid_args",
        `The source is not a Workflow: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const rel = save.replace(/\.ts$/, "")
    const root = path.join(this.deps.location, ".opencode", "workflows")
    const target = path.join(root, `${rel}.ts`)
    const resolvedRoot = path.resolve(root)
    if (!path.resolve(target).startsWith(resolvedRoot + path.sep)) {
      throw new WorkflowProtocolError(
        "invalid_args",
        `The save name must stay within .opencode/workflows (got ${JSON.stringify(save)}).`,
      )
    }
    if (rel.split(/[/\\]/)[0] === "runs")
      throw new WorkflowProtocolError("invalid_args", "`runs/` is reserved for the run journal.")
    if (existsSync(target)) throw new WorkflowProtocolError("conflict", `A Workflow file already exists at ${target}.`)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, source, "utf8")
    let key = meta.name
    try {
      const registry = await buildRegistry({
        directory: this.deps.location,
        ...(this.deps.cacheDir ? { cacheDir: this.deps.cacheDir } : {}),
      })
      key =
        [...registry.entries.values()].find((entry) => path.resolve(entry.absPath) === path.resolve(target))?.key ?? key
    } catch {
      // Report meta.name.
    }
    return { key, path: target }
  }

  /**
   * Retention for one Run's Unit sessions. The server plugin cannot delete sessions (P0 S8): a surface with a full
   * client deletes them and reports `deleted`; without that, the Run is marked `cleanup: pending`.
   */
  async cleanupRun(runId: string, deleted: string[] = []): Promise<{ deleted: number; pending: number }> {
    const live = this.deps.store.get(runId)
    const run = live ?? (await this.deps.journal.read(runId))?.run
    if (!run) throw new WorkflowProtocolError("not_found", `No Run "${runId}" in this location.`)
    if (!isTerminal(run.status))
      throw new WorkflowProtocolError("invalid_state", "Stop the Run before deleting its Unit sessions.")
    const sessions = new Set(run.units.map((unit) => unit.sessionID).filter((id): id is string => !!id))
    for (const id of deleted) sessions.delete(id)
    const cleanup: Run["cleanup"] = sessions.size === 0 ? "done" : "pending"
    const updated = { ...run, cleanup }
    if (live) this.deps.store.apply({ type: "run.patch", runId, patch: { cleanup } })
    await this.deps.journal.update(live ? this.deps.store.get(runId)! : updated)
    return { deleted: deleted.length, pending: sessions.size }
  }

  /**
   * Called once per process when the location's service is first created: a journaled Run still marked
   * running whose owner process is gone was killed mid-run. Mark it interrupted so a surface can offer resume.
   */
  async reconcileJournal(): Promise<number> {
    let marked = 0
    for (const entry of await this.deps.journal.list({ status: ["running", "queued"] })) {
      if (this.deps.store.get(entry.runId)) continue
      const record = await this.deps.journal.read(entry.runId)
      if (!record) continue
      const owner = record.owner
      if (owner && owner.pid !== process.pid && ownerAlive(owner)) continue
      if (owner && owner.pid === process.pid && owner.instance === this.deps.instance) continue
      await this.deps.journal.update({
        ...record.run,
        status: "interrupted",
        endedAt: record.run.endedAt ?? Date.now(),
        error: "the OpenCode service stopped while this Run was running; resume it",
      })
      marked += 1
    }
    if (marked > 0)
      this.deps.store.emit("resync.required", { reason: `${marked} interrupted Run(s) found in the journal` })
    return marked
  }

  liveRuns(): number {
    return this.live.size
  }
}

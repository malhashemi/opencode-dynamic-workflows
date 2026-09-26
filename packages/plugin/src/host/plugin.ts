/**
 * The OpenCode V2 server plugin — the host adapter around the workflow service.
 *
 * One instance per location (project directory); instances are replaced on reload. Everything that must outlive
 * an instance (the service, its store, broker and live Runs, the Unit index) sits in process-wide state, so this
 * module only (re)binds OpenCode surfaces around it:
 *
 * - tools `workflow`, `workflow_inline`, `workflow_result`, and a wrapper on the built-in `question` tool for
 *   Unit sessions (all `codemode: false`, so models call them by name);
 * - hooks: `context` (per-Unit result schema, instruction, step guard; hides `workflow_result` elsewhere),
 *   `permission evaluate` (workflow policy for Unit sessions), `model.request` (Copilot subagent headers);
 * - the event stream (permission and form requests raised inside Units → the Run's broker);
 * - plugin RPC (`workflow`), the protocol for the TUI and other clients;
 * - commands `/workflow` and one per durable Workflow, reloaded when Workflow files change;
 * - the Gateway (HTTP + SSE for the web app and third parties).
 */
import { realpathSync, watch, type FSWatcher } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"

import { createBroker } from "../broker"
import { confine } from "../capabilities"
import { configureLimits, engineGlobal, locationSlot } from "../engine-global"
import { ensureGateway, type GatewayHandle } from "../gateway/server"
import type { EngineHost, HostSessionInfo } from "../host"
import { createJournal, journalRoot, subscribeJournal } from "../journal"
import { InvalidArgsError } from "../orchestrator"
import { WorkflowProtocolError, type InteractionQuestion, type ProtocolEvent } from "../protocol"
import { configDirs } from "../registry"
import { RESULT_INSTRUCTION, RESULT_INSTRUCTION_REPAIR } from "../runner"
import { createRunStore, elideEvent, isTerminal } from "../runs"
import { parseConfig, type PluginConfig } from "../service/config"
import { WorkflowRpc } from "../service/rpc"
import { WorkflowService, argsSchemaOf } from "../service/service"
import {
  RESULT_TOOL_DESCRIPTION,
  WORKFLOW_COMMAND_TEMPLATE,
  WORKFLOW_INLINE_DESCRIPTION,
  WORKFLOW_TOOL_DESCRIPTION,
} from "./description"
import { finishedRunText, listText, notificationText, runLink, startedRunText, statusText } from "./format"
import { loadAuthoringSkill } from "./skill"

export const PLUGIN_ID = "opencode-dynamic-workflows"

type ToolResult = { content: string; metadata?: Record<string, unknown> }

function canonical(directory: string): string {
  try {
    return realpathSync(directory)
  } catch {
    return path.resolve(directory)
  }
}

/** The engine's view of this instance's OpenCode context. */
export function adaptHost(ctx: Context): EngineHost {
  return {
    session: {
      create: (input) => ctx.session.create(input as never) as unknown as Promise<HostSessionInfo>,
      prompt: (input) => ctx.session.prompt(input as never),
      wait: (input) => ctx.session.wait(input),
      context: (input) => ctx.session.context(input) as never,
      interrupt: (input) => ctx.session.interrupt(input),
      get: (input) => ctx.session.get(input) as unknown as Promise<HostSessionInfo>,
    },
    generateText: (input) =>
      ctx.generate.text({ prompt: input.prompt, model: input.model } as never) as Promise<{ text: string }>,
    worktree: {
      async create(name) {
        const created = (await ctx.worktree.create({ projectID: ctx.location.project.id, name } as never)) as {
          directory: string
        }
        const directory = canonical(created.directory)
        // OpenCode checks worktrees out detached: give each its own branch so kept work can be merged by name.
        let branch = git(directory, ["rev-parse", "--abbrev-ref", "HEAD"])
        if (!branch || branch === "HEAD") {
          const named = `workflow/${name}`
          branch = git(directory, ["switch", "-c", named]) !== null ? named : null
        }
        return { directory, branch, base: git(directory, ["rev-parse", "HEAD"]) }
      },
      async changed(directory, base) {
        if (git(directory, ["status", "--porcelain"])) return true
        return base !== null && git(directory, ["rev-parse", "HEAD"]) !== base
      },
      async remove(directory) {
        await ctx.worktree.remove({ projectID: ctx.location.project.id, directory, force: true } as never)
      },
      async pluginActive(directory) {
        // The Unit's session boots that location, which loads its plugins; give setup a moment to finish.
        const key = canonical(directory)
        for (let waited = 0; waited < 5_000; waited += 100) {
          if (locationSlot(key).owner) return true
          await Bun.sleep(100)
        }
        return false
      },
    },
  }
}

/** One git command's trimmed stdout, or null when it fails. */
function git(directory: string, args: string[]): string | null {
  const out = Bun.spawnSync(["git", "-C", directory, ...args], { stdout: "pipe", stderr: "ignore" })
  return out.exitCode === 0 ? out.stdout.toString().trim() : null
}

/** The shape of the built-in `question` tool's input (2.0.16). */
interface QuestionToolInput {
  questions?: Array<{
    question?: string
    header?: string
    options?: Array<{ label?: string; description?: string }>
    multiple?: boolean
  }>
}

export function toQuestions(input: QuestionToolInput): InteractionQuestion[] {
  return (input.questions ?? []).map((question) => ({
    header: question.header ?? "Question",
    prompt: question.question ?? "",
    options: (question.options ?? []).map((option) => ({
      label: option.label ?? "",
      description: option.description ?? "",
    })),
    multiple: question.multiple === true,
    custom: true,
  }))
}

function protocolErrorText(error: unknown, schema?: Record<string, unknown> | null): string {
  if (error instanceof InvalidArgsError)
    return `${error.message}${schema ? `\nExpected args JSON Schema: ${JSON.stringify(schema)}` : ""}`
  if (error instanceof WorkflowProtocolError) return `workflow: ${error.message}`
  return `workflow failed: ${error instanceof Error ? error.message : String(error)}`
}

interface ServiceSlot {
  service: WorkflowService
  replyPermission: (input: {
    sessionID: string
    requestID: string
    decision: "once" | "always" | "reject"
    message?: string
  }) => Promise<void>
  gatewayAttached: () => boolean
}

function ensureService(
  ctx: Context,
  location: string,
  config: PluginConfig,
  instance: string,
): { slot: ServiceSlot; fresh: boolean } {
  const locationState = locationSlot(location)
  const existing = locationState.state.service as ServiceSlot | undefined
  if (existing) {
    existing.service.setHost(adaptHost(ctx))
    existing.service.deps.instance = instance
    existing.service.deps.config = config
    return { slot: existing, fresh: false }
  }
  const store = createRunStore(location)
  const journal = createJournal(journalRoot(location), {
    onError: (error, context, runId) => {
      const message = `journal ${context}: ${error instanceof Error ? error.message : String(error)}`
      console.warn(`[workflow] ${message}`)
      // Visible where people look: the Run's activity. (A journal error never fails the Run itself.)
      if (runId && store.get(runId))
        store.apply({
          type: "run.log",
          runId,
          value: `the run journal could not be written — ${message}`,
          kind: "engine",
        })
    },
  })
  subscribeJournal(store, journal)
  const holder = {} as ServiceSlot
  const broker = createBroker({
    store,
    attached: () => holder.service.attached() || holder.gatewayAttached(),
    replyPermission: (input) => holder.replyPermission(input),
  })
  const approvalKey = `approvals/inline/${location}`
  holder.service = new WorkflowService({
    location,
    host: adaptHost(ctx),
    index: engineGlobal().units,
    store,
    journal,
    broker,
    config,
    instance,
    opencodeVersion: ctx.app.version,
    approvals: {
      get: async () => (await ctx.storage.get(approvalKey)) === true,
      set: async () => ctx.storage.set(approvalKey, true),
    },
    gatewayUrl: () => (engineGlobal().singletons.get("gateway") as GatewayHandle | undefined)?.url ?? null,
    gatewayWeb: () => (engineGlobal().singletons.get("gateway") as GatewayHandle | undefined)?.web ?? false,
  })
  holder.gatewayAttached = () =>
    (engineGlobal().singletons.get("gateway") as GatewayHandle | undefined)?.attached(location) ?? false
  holder.replyPermission = async () => {
    throw new Error("no plugin instance is serving this location")
  }
  locationState.state.service = holder
  locationState.state.broker = broker
  return { slot: holder, fresh: true }
}

export async function setup(ctx: Context): Promise<() => Promise<void>> {
  const instance = crypto.randomUUID()
  const location = canonical(ctx.location.directory)
  const config = parseConfig(ctx.options)
  configureLimits(config.maxConcurrentRuns, config.providerConcurrency)
  const units = engineGlobal().units
  const { slot, fresh } = ensureService(ctx, location, config, instance)
  const service = slot.service
  const broker = service.deps.broker
  slot.replyPermission = async (input) => {
    await ctx.permission.reply({
      sessionID: input.sessionID,
      requestID: input.requestID,
      decision: input.decision,
      ...(input.message ? { message: input.message } : {}),
    } as never)
  }
  locationSlot(location).owner = instance
  let alive = true
  let resolveDisposed!: () => void
  const disposed = new Promise<void>((resolve) => (resolveDisposed = resolve))
  if (fresh) void service.reconcileJournal().catch(() => {})

  // --------------------------------------------------------------------------------------------------------------
  // Tools
  // --------------------------------------------------------------------------------------------------------------

  // No link to a web app that is turned off. The Gateway is shared by every location and keeps the settings of the
  // one that started it, so ask the running Gateway, not this location's config.
  const link = (runId: string) => (service.deps.gatewayWeb?.() ? runLink(service.deps.gatewayUrl(), runId) : null)

  const mirrorProgress = (runId: string, tc: ToolContext) => {
    let last = ""
    return service.deps.store.subscribe((event) => {
      if (event.runId !== runId || (event.type !== "unit.updated" && event.type !== "run.updated")) return
      const run = service.deps.store.get(runId)
      if (!run) return
      const done = run.units.filter((unit) => unit.endedAt !== null).length
      const title = `workflow ${run.workflow.key ?? run.workflow.name} · ${run.currentPhase ?? "running"} · ${done}/${run.units.length} units`
      if (title === last) return
      last = title
      void tc.progress({ title, runId, done, total: run.units.length }).catch(() => {})
    })
  }

  const runForeground = async (
    start: () => ReturnType<WorkflowService["startRun"]>,
    tc: ToolContext,
    background: boolean,
    argsSchema?: Record<string, unknown> | null,
  ): Promise<ToolResult> => {
    let started
    try {
      started = await start()
    } catch (error) {
      return { content: protocolErrorText(error, argsSchema) }
    }
    const run = service.deps.store.get(started.runId)!
    if (background) {
      if (service.deps.config.notify) {
        const sessionID = tc.sessionID
        void started.done
          .then(async (outcome) => {
            const text = notificationText(outcome.run, outcome.output?.result, link(outcome.run.runId), outcome.error)
            // Queued: if the session is mid-turn the notice waits for the turn to end, then the model reads it.
            await ctx.session.prompt({ sessionID, text, delivery: "queue" } as never)
          })
          .catch((error: unknown) =>
            console.warn(
              `[workflow] background notification failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          )
      }
      return {
        content: startedRunText(run, link(started.runId), service.deps.config.notify),
        metadata: { runId: started.runId },
      }
    }
    const stopMirror = mirrorProgress(started.runId, tc)
    try {
      const outcome = await Promise.race([started.done, disposed.then(() => null)])
      if (!outcome) {
        return {
          content: `The plugin reloaded while this Run was going; it continues in the background.\nrun ${started.runId} — workflow({ status: "${started.runId}" })`,
          metadata: { runId: started.runId },
        }
      }
      const text = finishedRunText(outcome.run, outcome.output?.result, link(started.runId), outcome.error)
      if (outcome.error?.startsWith("invalid args") && argsSchema) {
        return {
          content: `${outcome.error}\nExpected args JSON Schema: ${JSON.stringify(argsSchema)}`,
          metadata: { runId: started.runId },
        }
      }
      return { content: text, metadata: { runId: started.runId, status: outcome.run.status } }
    } finally {
      stopMirror()
    }
  }

  const workflowTool = async (input: Record<string, unknown>, tc: ToolContext): Promise<ToolResult> => {
    try {
      if (input.list === true) return { content: listText(await service.listWorkflows()) }
      if (typeof input.status === "string") {
        const { run, live } = await service.getRun(input.status)
        return { content: statusText(run, live, link(run.runId)), metadata: { runId: run.runId, status: run.status } }
      }
      if (typeof input.result === "string") {
        const { run, live } = await service.getRun(input.result)
        if (live || !isTerminal(run.status))
          return { content: `That Run has not finished yet.\n\n${statusText(run, live, link(run.runId))}` }
        const { result } = await service.getResult(input.result)
        return { content: finishedRunText(run, result, link(run.runId)), metadata: { runId: run.runId } }
      }
      if (typeof input.stop === "string") {
        service.stopRun(input.stop)
        return { content: `Stopping run ${input.stop}.` }
      }
      const resumeTarget =
        typeof input.resume === "string"
          ? input.resume
          : typeof input.resumeFromRunId === "string"
            ? input.resumeFromRunId
            : undefined
      if (resumeTarget) {
        const resumeId = resumeTarget
        return runForeground(
          () => service.resumeRun(resumeId, true, { surface: "the workflow tool" }),
          tc,
          input.background === true,
        )
      }
      if (typeof input.save_run === "string") {
        const saved = await service.saveRun(input.save_run)
        return {
          content: `Saved as durable Workflow "${saved.key}" at ${saved.path}. Run it with workflow({ name: "${saved.key}", args }).`,
        }
      }
      if (typeof input.name === "string") {
        const name = input.name
        const listing = await service.listWorkflows()
        const schema = listing.workflows.find((entry) => entry.key === name)?.args ?? null
        return runForeground(
          () =>
            service.startRun(
              { name, args: input.args, parentSessionID: tc.sessionID },
              {
                background: input.background === true,
                ...(input.background === true ? {} : { signal: tc.signal }),
                surface: "the workflow tool",
              },
            ),
          tc,
          input.background === true,
          schema,
        )
      }
      if (typeof input.source === "string") {
        return {
          content: "Inline source runs through the `workflow_inline` tool. Call workflow_inline({ source, args }).",
        }
      }
      return {
        content:
          "Provide one of: list, name (+ args), status, result, stop, resume, save_run. Inline source goes to workflow_inline.",
      }
    } catch (error) {
      return { content: protocolErrorText(error) }
    }
  }

  const inlineTool = async (input: Record<string, unknown>, tc: ToolContext): Promise<ToolResult> => {
    let source = typeof input.source === "string" ? input.source : ""
    if (!source && typeof input.scriptPath === "string") {
      try {
        source = await readFile(confine(location, input.scriptPath), "utf8")
      } catch (error) {
        return {
          content: `workflow_inline could not read scriptPath: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
    if (!source)
      return {
        content:
          "workflow_inline needs `source` (or `scriptPath`): a module that default-exports defineWorkflow({ meta, run }).",
      }
    try {
      if (typeof input.save === "string") {
        const saved = await service.saveInline(source, input.save, tc.sessionID, tc.signal)
        return {
          content: `Saved as durable Workflow "${saved.key}" at ${saved.path}. Run it with workflow({ name: "${saved.key}", args }).`,
        }
      }
    } catch (error) {
      return { content: protocolErrorText(error) }
    }
    return runForeground(
      () =>
        service.startRun(
          { source, args: input.args, parentSessionID: tc.sessionID },
          {
            background: input.background === true,
            ...(input.background === true ? {} : { signal: tc.signal }),
            surface: "workflow_inline",
          },
        ),
      tc,
      input.background === true,
    )
  }

  let questionWrapperEnabled = true
  await ctx.tool.transform((editor) => {
    editor.add({
      name: "workflow",
      description: WORKFLOW_TOOL_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "Run a durable Workflow by its registry key (see `list`)." },
          args: { description: "JSON value passed to the Workflow as `args` (validated against meta.args)." },
          background: { type: "boolean", description: "Return at once with the runId instead of waiting." },
          list: { type: "boolean", description: "List durable Workflows and return." },
          status: { type: "string", description: "runId: report where a Run is." },
          result: { type: "string", description: "runId: return a finished Run's result." },
          stop: { type: "string", description: "runId: stop a running Run." },
          resume: { type: "string", description: "runId: resume an interrupted or failed Run." },
          resumeFromRunId: { type: "string", description: "Alias of `resume`." },
          save_run: { type: "string", description: "runId: save an inline Run's script as a durable Workflow." },
        },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: (input, tc) => workflowTool(input as Record<string, unknown>, tc),
    })
    editor.add({
      name: "workflow_inline",
      description: WORKFLOW_INLINE_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          source: { type: "string", description: "TypeScript module: export default defineWorkflow({ meta, run })." },
          scriptPath: {
            type: "string",
            description: "Instead of `source`: a project file holding the module (still approved as inline).",
          },
          args: { description: "JSON value passed to the Workflow as `args`." },
          background: { type: "boolean", description: "Return at once with the runId instead of waiting." },
          save: {
            type: "string",
            description: "Save the source as .opencode/workflows/<save>.ts instead of running it.",
          },
        },
        additionalProperties: false,
      },
      options: { codemode: false },
      execute: (input, tc) => inlineTool(input as Record<string, unknown>, tc),
    })
    editor.add({
      name: "workflow_result",
      description: RESULT_TOOL_DESCRIPTION,
      input: { type: "object", additionalProperties: true },
      options: { codemode: false },
      execute: async (input, tc) => {
        const outcome = units.submit(tc.sessionID, input)
        if (!outcome.ok)
          throw new Error(`Invalid result. Fix these fields and call workflow_result again: ${outcome.error}`)
        return { content: "Result recorded. Your work is complete — reply with one short confirmation." }
      },
    })
    // Unit questions go to the Run's broker instead of a native form nobody may be able to answer.
    editor.update("question", (tool) => {
      const original = tool.execute
      ;(tool as { execute: typeof original }).execute = async (input, tc) => {
        const binding = units.get(tc.sessionID)
        if (!binding || !questionWrapperEnabled) return original(input, tc)
        const questions = toQuestions(input as QuestionToolInput)
        const answer = await binding.ask(questions, tc.signal)
        const answers = answer ? answer.answers : questions.map(() => [] as string[])
        const content = answer
          ? `User has answered your questions: ${questions.map((q, i) => `"${q.prompt}"="${(answers[i] ?? []).join(", ")}"`).join(", ")}. You can now continue with the user's answers in mind.`
          : "No person is available to answer (the workflow is running unattended, or the question was dismissed). Proceed with your best judgement and state the assumption you made."
        return { output: { answers }, content, metadata: { answers } } as never
      }
    })
  })

  // The authoring guide the tool descriptions point to.
  const skill = loadAuthoringSkill()
  if (skill) {
    await ctx.skill.transform((editor) => {
      if (!editor.get(skill.id)) editor.add(skill as never)
    })
  }

  // If OpenCode ever rejects the wrapper's output shape, fall back to native forms instead of failing Units.
  await ctx.tool.hook("execute.after", (event) => {
    if (event.tool !== "question" || event.status !== "error" || !units.get(event.sessionID)) return
    if (/declared output/i.test(event.error.message)) {
      questionWrapperEnabled = false
      console.warn(
        "[workflow] the question-tool wrapper was rejected by this OpenCode version; Unit questions now use native forms",
      )
    }
  })

  // --------------------------------------------------------------------------------------------------------------
  // Hooks
  // --------------------------------------------------------------------------------------------------------------

  await ctx.session.hook("context", (event) => {
    const binding = units.get(event.sessionID)
    if (!binding) {
      delete event.tools.workflow_result
      return
    }
    binding.steps += 1
    if (binding.steps > binding.maxSteps) binding.onStepLimit()
    if (binding.schema && binding.jsonSchema && event.tools.workflow_result) {
      event.tools.workflow_result = { description: RESULT_TOOL_DESCRIPTION, input: binding.jsonSchema as never }
      event.system.push({
        type: "text",
        text: binding.repairing ? RESULT_INSTRUCTION_REPAIR : RESULT_INSTRUCTION,
      } as never)
    } else if (!binding.schema) {
      delete event.tools.workflow_result
    }
  })

  await ctx.permission.hook("evaluate", (event) => {
    const binding = units.get(event.sessionID)
    if (!binding || event.effect !== "ask") return
    const policy = binding.permissionPolicy()
    if (policy === "auto") {
      event.effect = "allow"
      return
    }
    const attached = service.attached() || slot.gatewayAttached()
    if (policy === "deny" || !attached) {
      event.effect = "deny"
      event.message =
        policy === "deny"
          ? `Workflow policy denies "${event.action}" for this Unit. Continue without it, or report that you need it.`
          : `No person is attached to approve "${event.action}" (this workflow is running unattended). Continue without it, or report that you need it.`
    }
  })

  await ctx.session.hook(
    "model.request",
    (event) => {
      if (!units.get(event.sessionID) || event.kind !== "primary") return
      event.headers["X-Interaction-Type"] = "conversation-subagent"
      event.headers["x-initiator"] = "agent"
    },
    { providerID: "github-copilot" },
  )

  // --------------------------------------------------------------------------------------------------------------
  // Events: requests raised inside Units
  // --------------------------------------------------------------------------------------------------------------

  const events = new AbortController()
  void (async () => {
    try {
      for await (const raw of ctx.event.subscribe({ signal: events.signal })) {
        if (!alive) break
        const event = raw as { type: string; data?: Record<string, unknown> }
        const data = event.data ?? {}
        if (event.type === "permission.asked") {
          const binding = units.get(String(data.sessionID))
          if (!binding || binding.location !== location) continue
          broker.permission({
            runId: binding.runId,
            unitId: binding.unitId,
            sessionID: binding.sessionID,
            detail: {
              action: String(data.action ?? ""),
              resources: Array.isArray(data.resources) ? data.resources.map(String) : [],
              save: Array.isArray(data.save) ? data.save.map(String) : [],
              requestID: String(data.id),
            },
          })
        } else if (event.type === "permission.replied") {
          broker.permissionResolved(String(data.requestID), typeof data.reply === "string" ? data.reply : undefined)
        } else if (event.type === "form.created") {
          const form = data.form as
            | {
                id?: string
                sessionID?: string
                fields?: Array<{
                  key?: string
                  title?: string
                  description?: string
                  options?: Array<{ label?: string; value?: string; description?: string }>
                }>
              }
            | undefined
          const binding = form?.sessionID ? units.get(form.sessionID) : undefined
          if (!form?.id || !binding || binding.location !== location) continue
          broker.form({
            runId: binding.runId,
            unitId: binding.unitId,
            sessionID: binding.sessionID,
            formID: form.id,
            questions: (form.fields ?? []).map((field) => ({
              header: field.title ?? field.key ?? "Question",
              prompt: field.description ?? field.title ?? "",
              options: (field.options ?? []).map((option) => ({
                label: option.label ?? option.value ?? "",
                description: option.description ?? "",
              })),
              multiple: false,
              custom: true,
            })),
          })
        } else if (event.type === "form.replied" || event.type === "form.cancelled") {
          const answer = data.answer as Record<string, unknown> | undefined
          broker.formResolved(
            String(data.id),
            answer
              ? Object.values(answer).map((value) => (Array.isArray(value) ? value.map(String) : [String(value)]))
              : null,
          )
        }
      }
    } catch {
      // The stream ends on cleanup or a service restart; a fresh instance subscribes again.
    }
  })()

  // --------------------------------------------------------------------------------------------------------------
  // RPC
  // --------------------------------------------------------------------------------------------------------------

  const guard = async <T>(
    fail: (type: "workflow", message: string, data: never) => never,
    work: () => Promise<T> | T,
  ): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      const protocol =
        error instanceof WorkflowProtocolError
          ? error
          : new WorkflowProtocolError("internal", error instanceof Error ? error.message : String(error))
      return fail("workflow", protocol.message, protocol.toJSON() as never)
    }
  }

  const rpc = await ctx.rpc.register(WorkflowRpc, {
    info: (_input, c) => guard(c.error as never, () => service.info()),
    listRuns: (input, c) => guard(c.error as never, async () => ({ runs: await service.listRuns(input) })),
    getRun: (input, c) => guard(c.error as never, () => service.getRun(input.runId)),
    getUnit: (input, c) =>
      guard(c.error as never, async () => ({ unit: await service.getUnit(input.runId, input.unitId) })),
    getResult: (input, c) => guard(c.error as never, () => service.getResult(input.runId)),
    getTranscript: (input, c) => guard(c.error as never, () => service.getTranscript(input.runId, input.unitId)),
    getActivity: (input, c) =>
      guard(c.error as never, async () => ({ entries: await service.getActivity(input.runId) })),
    listWorkflows: (_input, c) => guard(c.error as never, () => service.listWorkflows()),
    startRun: (input, c) =>
      guard(c.error as never, async () => {
        const started = await service.startRun(input, { background: true, surface: "the TUI" })
        return { runId: started.runId }
      }),
    stopRun: (input, c) => guard(c.error as never, () => (service.stopRun(input.runId), { ok: true as const })),
    stopUnit: (input, c) =>
      guard(c.error as never, () => (service.stopUnit(input.runId, input.unitId), { ok: true as const })),
    restartUnit: (input, c) =>
      guard(
        c.error as never,
        async () => (await service.restartUnit(input.runId, input.unitId), { ok: true as const }),
      ),
    resumeRun: (input, c) =>
      guard(c.error as never, async () => ({
        runId: (
          await service.resumeRun(input.runId, input.rerunFailed ?? true, { background: true, surface: "the TUI" })
        ).runId,
      })),
    replyInteraction: (input, c) =>
      guard(
        c.error as never,
        async () => (
          await service.replyInteraction(input.runId, input.interactionId, input.answers),
          { ok: true as const }
        ),
      ),
    cancelInteraction: (input, c) =>
      guard(
        c.error as never,
        async () => (await service.cancelInteraction(input.runId, input.interactionId), { ok: true as const }),
      ),
    saveRun: (input, c) => guard(c.error as never, () => service.saveRun(input.runId, input.name)),
    cleanupRun: (input, c) => guard(c.error as never, () => service.cleanupRun(input.runId, input.deleted ?? [])),
    attach: (input, c) =>
      guard(
        c.error as never,
        () => (service.attach(input.surface, input.ttlMs, input.sessionID), { ok: true as const }),
      ),
    detach: (input, c) => guard(c.error as never, () => (service.detach(input.surface), { ok: true as const })),
    eventsSince: (input, c) => guard(c.error as never, () => service.eventsSince(input.after ?? 0, input.epoch)),
    pair: (_input, c) =>
      guard(c.error as never, () => {
        const current = engineGlobal().singletons.get("gateway") as GatewayHandle | undefined
        if (!current)
          throw new WorkflowProtocolError("unsupported", "The Gateway is not running (gateway.enabled: false).")
        return current.createPairingCode()
      }),
  })
  const unsubscribeRpc = service.deps.store.subscribe((event: ProtocolEvent) => {
    if (!alive) return
    void rpc.events.emit("event", elideEvent(event) as never).catch(() => {})
  })

  // --------------------------------------------------------------------------------------------------------------
  // Commands: /workflow and one per durable Workflow, reloaded when Workflow files change
  // --------------------------------------------------------------------------------------------------------------

  let commands: Array<{ name: string; description: string; template: string }> = []
  const refreshCommands = async () => {
    try {
      const listing = await service.listWorkflows()
      commands = listing.workflows.map((entry) => ({
        name: entry.key.replaceAll(":", "/"),
        description: `Workflow: ${entry.description}`,
        template: [
          `**${entry.key}** — ${entry.description}`,
          ...(entry.whenToUse ? [`_${entry.whenToUse}_`] : []),
          "",
          `Run it by calling \`workflow({ name: ${JSON.stringify(entry.key)}, args })\`, building \`args\` from the request below.`,
          `Args JSON Schema: ${entry.args ? JSON.stringify(entry.args) : "(none)"}`,
          "",
          "**Request:** $ARGUMENTS",
        ].join("\n"),
      }))
    } catch {
      commands = []
    }
  }
  await refreshCommands()
  const promptWith =
    (template: string) =>
    async (invocation: { sessionID: string; prompt: { text: string }; delivery: "steer" | "queue" }) => {
      await ctx.session.prompt({
        ...(invocation.prompt as object),
        sessionID: invocation.sessionID,
        text: template.replaceAll("$ARGUMENTS", invocation.prompt.text ?? ""),
        delivery: invocation.delivery,
      } as never)
    }
  await ctx.command.transform((editor) => {
    editor.add({
      name: "workflow",
      description: "Run a durable Workflow by key: /workflow <key> <request>",
      execute: promptWith(WORKFLOW_COMMAND_TEMPLATE) as never,
    })
    const reserved = new Set(["workflow", "workflows"])
    for (const command of commands) {
      if (reserved.has(command.name)) continue
      editor.add({
        name: command.name,
        description: command.description,
        execute: promptWith(command.template) as never,
      })
    }
  })

  const watchers: FSWatcher[] = []
  let reloadTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleReload = () => {
    if (reloadTimer) clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      void refreshCommands()
        .then(() => (alive ? ctx.command.reload() : undefined))
        .catch(() => {})
    }, 300)
  }
  for (const scope of configDirs(location)) {
    for (const folder of ["workflows", "workflow"]) {
      try {
        const watcher = watch(path.join(scope, folder), { recursive: true }, (_event, file) => {
          if (typeof file === "string" && (file.startsWith("runs") || !file.endsWith(".ts"))) return
          scheduleReload()
        })
        watcher.on("error", () => {})
        watchers.push(watcher)
      } catch {
        // No such folder in this scope.
      }
    }
  }

  // --------------------------------------------------------------------------------------------------------------
  // Gateway
  // --------------------------------------------------------------------------------------------------------------

  const gateway = config.gateway.enabled
    ? await ensureGateway(config.gateway).catch((error: unknown) => {
        console.warn(`[workflow] gateway did not start: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
    : null
  const unregisterGateway = gateway?.register(location, service) ?? (() => {})

  return async () => {
    alive = false
    resolveDisposed()
    events.abort()
    unsubscribeRpc()
    unregisterGateway()
    if (reloadTimer) clearTimeout(reloadTimer)
    for (const watcher of watchers) watcher.close()
    // Only the current owner hands the location back: a leaked older instance cleaning up late must not unhook
    // the instance that replaced it.
    const locationState = locationSlot(location)
    if (locationState.owner === instance) {
      locationState.owner = null
      slot.replyPermission = async () => {
        throw new Error("no plugin instance is serving this location")
      }
    }
  }
}

export const WorkflowPlugin = Plugin.define({ id: PLUGIN_ID, setup })

export { argsSchemaOf }

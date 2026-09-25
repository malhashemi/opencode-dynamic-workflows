/**
 * The Unit runner — one `agent()` call, one Unit session, on OpenCode V2's public session API.
 *
 *     create (title, agent, model, create-time metadata, ruleset) → prompt → wait → context → (repair) → result
 *
 * Decisions carried from the P0 spikes:
 *
 * - The Unit is an ordinary, unlinked session (D1). Its identity goes in `metadata.workflow` at create time —
 *   the plugin cannot update metadata later — and in the process-wide Unit index.
 * - `prompt` only admits; `wait` resolves when the session settles. Stopping a Unit is `interrupt`.
 * - Typed results come from the plugin-owned `workflow_result` tool (validated in the tool itself, so the model
 *   can correct itself within the same turn). If the model answers in text instead, the JSON in that text is
 *   tried next, then a short repair turn in the SAME session, then — last — an extraction call. Every attempt
 *   is recorded, and every turn stays visible in the Unit's transcript.
 * - The runner never throws: a failed Unit is a value (error model D9), recorded by the context in `ctx.errors`.
 */
import type { z } from "zod"
import { addUsage, emptyUsage, type ResultPath, type UnitAttempt, type Usage } from "./protocol"
import {
  finalAssistant,
  type EngineHost,
  type HostModelRef,
  type HostPermissionRule,
  type HostSessionInfo,
} from "./host"
import { modelJsonSchema } from "./schema-bridge"
import { formatIssues, type UnitBinding, type UnitIndex } from "./units"

/** Default subagent when a Unit names none — OpenCode V2's built-in general-purpose subagent. */
export const DEFAULT_SUBAGENT = "general"

/** Extra repair turns for a typed Unit (the first turn is not counted). */
export const DEFAULT_RETRIES = 2

/** Model requests one Unit may make before the engine stops it (runaway guard; P0 spike S1 saw 170 in 40 s). */
export const DEFAULT_MAX_UNIT_STEPS = 250

/** How many times one Unit may be restarted from a surface. */
const MAX_RESTARTS = 5

/** Rules every Unit session carries after the author's: typed results always work, recursion never does. */
export const ENGINE_UNIT_RULES: HostPermissionRule[] = [
  { action: "workflow_result", resource: "*", effect: "allow" },
  // Subagents lack `question` by default (observed on 2.0.16). In a Unit the engine's wrapper answers it: the
  // Run's person when one is attached, else "nobody available" — so it never blocks a headless Run.
  { action: "question", resource: "*", effect: "allow" },
  { action: "workflow", resource: "*", effect: "deny" },
  { action: "workflow_inline", resource: "*", effect: "deny" },
]

export const RESULT_INSTRUCTION =
  "You are a workflow Unit. When your work is complete, call the `workflow_result` tool exactly once with your " +
  "final answer. Its input must match the tool's schema exactly. If the tool returns a validation error, fix the " +
  "input and call it again. Do not put the final answer in plain text."

export const RESULT_INSTRUCTION_REPAIR =
  "Your task is not complete until you call the `workflow_result` tool. Call it now with your final answer. Do not " +
  "redo the work and do not change your conclusions — only submit them in the required shape."

export interface UnitSpec {
  runId: string
  unitId: string
  workflow: string
  /** The Run's location; also the Unit's unless `unitLocation` names another directory (a worktree). */
  location: string
  unitLocation?: string
  parentSessionID: string
  ordinal: number
  prompt: string
  subagent: string
  label: string | null
  model?: HostModelRef
  schema?: z.ZodType
  retries?: number
  timeoutMs?: number
  signal?: AbortSignal
  maxSteps?: number
  /** Author rules (workflow-level then unit-level); engine rules are appended after them. */
  permissions?: HostPermissionRule[]
  ask: UnitBinding["ask"]
  permissionPolicy: UnitBinding["permissionPolicy"]
  /** Called once the session exists, with a handle that stops this Unit and the model the session resolved. */
  onSession?: (sessionID: string, stop: () => void, model: HostModelRef | undefined) => void
  /** Called when the Unit moves into repair turns. */
  onRepairing?: () => void
  /**
   * Hard budget: may this Unit spend more? Receives the output tokens the Unit has used so far. Checked before
   * every repair turn and before extraction, so a typed Unit cannot overrun a hard budget on its own.
   */
  mayContinue?: (unitOutputTokens: number) => boolean
}

export type UnitRunResult =
  | {
      ok: true
      value: unknown
      sessionID: string
      usage: Usage
      model: HostModelRef | undefined
      path: ResultPath
      attempts: UnitAttempt[]
    }
  | {
      ok: false
      error: string
      stopped: boolean
      sessionID: string | null
      usage: Usage
      model: HostModelRef | undefined
      attempts: UnitAttempt[]
    }

export function stringifyError(error: unknown): string {
  if (error == null) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function unitTitle(workflow: string, label: string | null, subagent: string): string {
  return `⟡ wf · ${workflow} · ${label ?? subagent}`
}

/** Pull a JSON object out of a model's reply: a fenced block first, then the outermost braces of the text. */
export function parseJsonFromText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  for (const candidate of [fence?.[1], text]) {
    if (!candidate) continue
    for (const [open, close] of [
      ["{", "}"],
      ["[", "]"],
    ] as const) {
      const start = candidate.indexOf(open)
      const end = candidate.lastIndexOf(close)
      if (start < 0 || end <= start) continue
      try {
        return { ok: true, value: JSON.parse(candidate.slice(start, end + 1)) }
      } catch {
        // try the next shape
      }
    }
  }
  return { ok: false, error: "no parseable JSON object found in the reply" }
}

export function usageFromSession(info: HostSessionInfo | undefined): Usage {
  if (!info?.tokens && info?.cost === undefined) return emptyUsage()
  const tokens = info.tokens ?? {}
  return {
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
    },
    cost: info.cost ?? 0,
  }
}

type Settle = "settled" | "stopped" | "aborted" | "timeout" | "steps" | { error: string }

/** How long to wait for a session to go quiet after `interrupt`, before reading its final usage. */
const DRAIN_MS = 5_000

/** Rough token count for host calls that report no usage (`generate.text` on 2.0.16): ~4 characters a token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function repairText(binding: UnitBinding, lastError: string | undefined): string {
  const reason = lastError
    ? `Your previous result did not match the required schema:\n${lastError}`
    : "You have not submitted your final answer with the `workflow_result` tool."
  return `${reason}\n\n${RESULT_INSTRUCTION_REPAIR}${binding.jsonSchema ? `\n\nRequired schema:\n${JSON.stringify(binding.jsonSchema)}` : ""}`
}

/**
 * Run one Unit to a result. Never throws.
 */
export async function runUnit(host: EngineHost, index: UnitIndex, spec: UnitSpec): Promise<UnitRunResult> {
  try {
    return await runUnitUnsafe(host, index, spec)
  } catch (error) {
    // The contract is "never throws": a failed Unit is a value (D9). This is the backstop for host surprises.
    return {
      ok: false,
      error: `the Unit failed unexpectedly: ${stringifyError(error)}`,
      stopped: false,
      sessionID: null,
      usage: emptyUsage(),
      model: spec.model,
      attempts: [],
    }
  }
}

async function runUnitUnsafe(host: EngineHost, index: UnitIndex, spec: UnitSpec): Promise<UnitRunResult> {
  const attempts: UnitAttempt[] = []
  let sessionID: string | null = null
  let model: HostModelRef | undefined = spec.model
  const fail = (error: string, stopped = false, usage: Usage = emptyUsage()): UnitRunResult => ({
    ok: false,
    error,
    stopped,
    sessionID,
    usage,
    model,
    attempts,
  })

  let jsonSchema: Record<string, unknown> | undefined
  if (spec.schema) {
    try {
      jsonSchema = modelJsonSchema(spec.schema)
    } catch (error) {
      return fail(`agent({ schema }) is not a valid zod schema: ${stringifyError(error)}`)
    }
  }
  if (spec.signal?.aborted) return fail("unit aborted before it started", true)

  const location = spec.unitLocation ?? spec.location
  let info: HostSessionInfo
  try {
    info = await host.session.create({
          title: unitTitle(spec.workflow, spec.label, spec.subagent),
          agent: spec.subagent,
          ...(spec.model ? { model: spec.model } : {}),
          metadata: {
            workflow: {
              protocol: 1,
              runId: spec.runId,
              unitId: spec.unitId,
              ordinal: spec.ordinal,
              attempt: 1,
              parentSessionID: spec.parentSessionID,
              workflow: spec.workflow,
              location: spec.location,
            },
          },
          permissions: [...(spec.permissions ?? []), ...ENGINE_UNIT_RULES],
          ...(spec.unitLocation ? { location: { directory: spec.unitLocation } } : {}),
        })
  } catch (error) {
    return fail(`could not create the Unit session: ${stringifyError(error)}`)
  }
  sessionID = info.id
  if (!sessionID) return fail("session.create returned no session id")

  const stop = new AbortController()
  const stepLimit = new AbortController()
  const binding: UnitBinding = {
    sessionID,
    runId: spec.runId,
    unitId: spec.unitId,
    location: spec.location,
    workflow: spec.workflow,
    ...(spec.schema ? { schema: spec.schema, jsonSchema } : {}),
    toolCalls: 0,
    invalidCalls: 0,
    steps: 0,
    maxSteps: spec.maxSteps ?? DEFAULT_MAX_UNIT_STEPS,
    repairing: false,
    settled: false,
    restart: false,
    onStepLimit: () => stepLimit.abort(),
    ask: spec.ask,
    permissionPolicy: spec.permissionPolicy,
  }
  const unbind = index.bind(binding)
  model = info.model ?? model
  spec.onSession?.(sessionID, () => stop.abort(), model)

  const timeout = spec.timeoutMs && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 ? AbortSignal.timeout(spec.timeoutMs) : undefined
  const guards = [spec.signal, stop.signal, stepLimit.signal, timeout].filter((signal): signal is AbortSignal => !!signal)
  const guard = AbortSignal.any(guards)

  const reason = (): Settle =>
    stop.signal.aborted ? "stopped" : stepLimit.signal.aborted ? "steps" : timeout?.aborted ? "timeout" : "aborted"
  const aborted = new Promise<Settle>((resolve) => {
    if (guard.aborted) resolve(reason())
    else guard.addEventListener("abort", () => resolve(reason()), { once: true })
  })

  /** Stop the session and give it a bounded moment to go quiet, so its usage is final and no work outlives the Unit. */
  const halt = async (id: string) => {
    await Promise.resolve()
      .then(() => host.session.interrupt({ sessionID: id }))
      .catch(() => {})
    await Promise.race([Promise.resolve(host.session.wait({ sessionID: id })).catch(() => {}), Bun.sleep(DRAIN_MS)])
  }

  /** Admit a prompt, racing the stop signals; a rejection or a stop halts the session (it may have started). */
  const admit = async (id: string, text: string): Promise<Settle> => {
    if (guard.aborted) {
      await halt(id)
      return reason()
    }
    const outcome = await Promise.race([
      Promise.resolve(host.session.prompt({ sessionID: id, text })).then(
        () => "settled" as const,
        (error: unknown) => ({ error: `could not prompt the Unit session: ${stringifyError(error)}` }),
      ),
      aborted,
    ])
    if (outcome !== "settled") await halt(id)
    return outcome
  }

  const settle = async (id: string): Promise<Settle> => {
    if (guard.aborted) {
      await halt(id)
      return reason()
    }
    const outcome = await Promise.race([
      Promise.resolve(host.session.wait({ sessionID: id })).then(
        () => "settled" as const,
        (error: unknown) => ({ error: `waiting for the Unit session failed: ${stringifyError(error)}` }),
      ),
      aborted,
    ])
    if (outcome !== "settled") await halt(id)
    return outcome
  }

  /** Output tokens and cost of host calls the session does not count (extraction). */
  let extra = emptyUsage()

  const readUsage = async (): Promise<Usage> => {
    try {
      const current = await host.session.get({ sessionID: sessionID! })
      model = current.model ?? model
      return addUsage(usageFromSession(current), extra)
    } catch {
      return extra
    }
  }

  const interruptedMessage = (outcome: Exclude<Settle, "settled">): string => {
    if (typeof outcome === "object") return outcome.error
    if (outcome === "stopped") return "unit stopped before completion"
    if (outcome === "steps") return `unit exceeded its step limit (${binding.maxSteps} model requests) and was stopped`
    if (outcome === "timeout")
      return `unit exceeded its ${spec.timeoutMs}ms timeout and was cancelled — raise or remove the deadline with meta.unitTimeout or agent({ timeoutMs })`
    return "unit aborted before completion"
  }

  try {
    const retries = spec.schema ? Math.max(0, spec.retries ?? DEFAULT_RETRIES) : 0
    let text = spec.prompt
    let lastText: string | undefined
    let lastError: string | undefined
    let restarts = 0

    const overBudget = async (): Promise<Usage | null> => {
      if (!spec.mayContinue) return null
      const usage = await readUsage()
      return spec.mayContinue(usage.tokens.output) ? null : usage
    }

    for (let turn = 0; turn <= retries; turn++) {
      if (turn > 0) {
        const spent = await overBudget()
        if (spent) return fail(`budget exhausted before repair turn ${turn}: ${lastError ?? "workflow_result was not called"}`, false, spent)
      }
      const admitted = await admit(sessionID, text)
      if (admitted !== "settled") {
        return fail(interruptedMessage(admitted), admitted === "stopped" || admitted === "aborted", await readUsage())
      }
      const outcome = await settle(sessionID)
      if (outcome === "settled" && binding.restart && restarts < MAX_RESTARTS) {
        binding.restart = false
        binding.result = undefined
        binding.lastError = undefined
        restarts += 1
        text = `The workflow operator restarted this task. Start again from the beginning:\n\n${spec.prompt}`
        turn -= 1
        continue
      }
      if (outcome !== "settled") {
        return fail(interruptedMessage(outcome), outcome === "stopped" || outcome === "aborted", await readUsage())
      }

      let final: ReturnType<typeof finalAssistant>
      try {
        final = finalAssistant(await host.session.context({ sessionID }))
      } catch (error) {
        return fail(`could not read the Unit transcript: ${stringifyError(error)}`, false, await readUsage())
      }
      model = final.model ?? model
      lastText = final.text ?? lastText

      if (!spec.schema) {
        if (final.text !== undefined) {
          attempts.push({ turn, path: "text", ok: true })
          return { ok: true, value: final.text, sessionID, usage: await readUsage(), model, path: "text", attempts }
        }
        if (binding.result) {
          attempts.push({ turn, path: "tool", ok: true })
          return { ok: true, value: binding.result.value, sessionID, usage: await readUsage(), model, path: "tool", attempts }
        }
        attempts.push({ turn, path: "text", ok: false, error: final.error ?? "no assistant text" })
        return fail(final.error ?? "the Unit produced no assistant text", false, await readUsage())
      }

      // Typed Unit: the tool result first.
      if (binding.result) {
        attempts.push({ turn, path: "tool", ok: true })
        return { ok: true, value: binding.result.value, sessionID, usage: await readUsage(), model, path: "tool", attempts }
      }
      attempts.push({ turn, path: "tool", ok: false, error: binding.lastError ?? "workflow_result was not called" })

      // Then JSON in the reply text (a model that ignores the tool but answers correctly).
      if (final.text !== undefined) {
        const parsed = parseJsonFromText(final.text)
        if (parsed.ok) {
          const valid = spec.schema.safeParse(parsed.value)
          if (valid.success) {
            attempts.push({ turn, path: "text-json", ok: true })
            return { ok: true, value: valid.data, sessionID, usage: await readUsage(), model, path: "text-json", attempts }
          }
          lastError = formatIssues(valid.error)
          attempts.push({ turn, path: "text-json", ok: false, error: lastError })
        }
      }
      lastError = binding.lastError ?? lastError
      if (final.error && final.text === undefined && binding.toolCalls === 0) {
        // The provider failed the turn outright (no text, no tool call): repairing would re-hit the same failure.
        return fail(final.error, false, await readUsage())
      }
      if (turn < retries) {
        binding.repairing = true
        spec.onRepairing?.()
        text = repairText(binding, lastError)
      }
    }

    // Last resort: extract JSON from the final reply with a plain generation call.
    const spentBeforeExtract = lastText && host.generateText && model ? await overBudget() : null
    if (spentBeforeExtract) {
      return fail(`budget exhausted before extraction: ${lastError ?? "workflow_result was never called"}`, false, spentBeforeExtract)
    }
    if (lastText && host.generateText && model) {
      try {
        const prompt =
          "Extract the answer below into ONE JSON value that matches this JSON Schema. Output only the JSON.\n" +
          `Schema: ${JSON.stringify(jsonSchema)}\n\nAnswer:\n${lastText}`
        const generated = await host.generateText({ model, prompt })
        // The host reports no usage for this call; count an estimate so budgets and totals are not blind to it.
        extra = addUsage(extra, { ...emptyUsage(), tokens: { ...emptyUsage().tokens, input: estimateTokens(prompt), output: estimateTokens(generated.text) } })
        const parsed = parseJsonFromText(generated.text)
        const valid = parsed.ok ? spec.schema!.safeParse(parsed.value) : undefined
        if (valid?.success) {
          attempts.push({ turn: attempts.length, path: "extract", ok: true, note: "usage estimated (the host reports none for extraction)" })
          return { ok: true, value: valid.data, sessionID, usage: await readUsage(), model, path: "extract", attempts }
        }
        attempts.push({
          turn: attempts.length,
          path: "extract",
          ok: false,
          error: valid && !valid.success ? formatIssues(valid.error) : parsed.ok ? "invalid" : parsed.error,
        })
      } catch (error) {
        attempts.push({ turn: attempts.length, path: "extract", ok: false, error: stringifyError(error) })
      }
    }
    return fail(
      `structured output failed after ${retries} repair turn(s): ${lastError ?? "workflow_result was never called"}`,
      false,
      await readUsage(),
    )
  } finally {
    binding.settled = true
    unbind()
  }
}

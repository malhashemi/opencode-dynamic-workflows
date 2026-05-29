import type { PromptFormatInput, WorkflowClient } from "../src/client"

export interface CreateCall {
  body?: { parentID?: string; title?: string }
  query?: { directory?: string }
}
export interface PromptCall {
  path: { id: string }
  body?: {
    agent?: string
    model?: { providerID: string; modelID: string }
    parts: { type: string; text?: string }[]
    format?: PromptFormatInput
  }
}

/**
 * One prompt outcome. Used both as the uniform reply (scalar options) and as the per-attempt entries of a
 * {@link FakeClientOptions.responses} queue, so a test can make attempt 1 fail and attempt 2 succeed.
 */
export type FakeResponse =
  | { text: string }
  | { structured: unknown }
  | { structuredError: string } // -> info.error = a StructuredOutputError (named), the retryable failure
  | { error: unknown } // -> info.error = an arbitrary (non-structured) error
  | { noText: true } // -> a reply with no text part

export interface FakeClientOptions {
  /** Text the prompt returns; if a function, receives the PromptCall. Default echoes the prompt text. */
  reply?: string | ((call: PromptCall) => string)
  /** Return this as the persisted `info.structured` payload (the structured-output success path). */
  structured?: unknown
  /** Return a `StructuredOutputError` as `info.error` (the retryable structured failure). */
  structuredError?: string
  /** Force a prompt error (sets info.error). */
  promptError?: unknown
  /** Return no id from create (simulates a create failure). */
  noSessionId?: boolean
  /** Return no text part from prompt. */
  noTextPart?: boolean
  /**
   * A queue of per-attempt outcomes (overrides the scalar options). Each prompt call shifts the next entry;
   * once exhausted, the last entry repeats. Lets a test drive the engine's retry loop attempt-by-attempt.
   */
  responses?: FakeResponse[]
  /** Base id; each create returns `${idPrefix}-${n}`. */
  idPrefix?: string
  /** Hold each prompt open this many ms before replying — lets a test observe in-flight concurrency. */
  delayMs?: number
  /** Output-token count reported on each prompt's `info.tokens.output` — drives the budget path. */
  outputTokens?: number
}

export interface FakeClient extends WorkflowClient {
  createCalls: CreateCall[]
  promptCalls: PromptCall[]
  /** Live concurrency meter for the prompt path; `peak` is the max simultaneous in-flight prompts observed. */
  meter: { active: number; peak: number }
}

function build(spec: FakeResponse, outputTokens?: number) {
  // Attach a token count onto `info` (the budget path reads `info.tokens.output`); merged into every shape so
  // even the text-success path (which otherwise has `info: null`) reports tokens when the option is set.
  const tokens = outputTokens != null ? { tokens: { output: outputTokens } } : undefined
  if ("structured" in spec) return { data: { info: { structured: spec.structured, ...tokens }, parts: [] } }
  if ("structuredError" in spec)
    return {
      data: {
        info: { error: { name: "StructuredOutputError", data: { message: spec.structuredError ?? "no output", retries: 0 } }, ...tokens },
        parts: [],
      },
    }
  if ("error" in spec) return { data: { info: { error: spec.error, ...tokens }, parts: [] } }
  if ("noText" in spec) return { data: { info: tokens ?? null, parts: [{ type: "reasoning" }] } }
  return { data: { info: tokens ?? null, parts: [{ type: "text", text: spec.text }] } }
}

/** A deterministic in-memory WorkflowClient that records every call. */
export function makeFakeClient(opts: FakeClientOptions = {}): FakeClient {
  const createCalls: CreateCall[] = []
  const promptCalls: PromptCall[] = []
  const meter = { active: 0, peak: 0 }
  let counter = 0
  let promptIndex = 0
  const idPrefix = opts.idPrefix ?? "child"

  return {
    createCalls,
    promptCalls,
    meter,
    session: {
      async create(input) {
        createCalls.push(input)
        counter += 1
        if (opts.noSessionId) return { data: null }
        return { data: { id: `${idPrefix}-${counter}` } }
      },
      async prompt(input) {
        promptCalls.push(input)
        meter.active += 1
        meter.peak = Math.max(meter.peak, meter.active)
        try {
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
          const i = promptIndex++
          const tok = opts.outputTokens
          if (opts.responses && opts.responses.length > 0) {
            return build(opts.responses[Math.min(i, opts.responses.length - 1)]!, tok)
          }
          if (opts.structured !== undefined) return build({ structured: opts.structured }, tok)
          if (opts.structuredError !== undefined) return build({ structuredError: opts.structuredError }, tok)
          if (opts.promptError !== undefined) return build({ error: opts.promptError }, tok)
          if (opts.noTextPart) return build({ noText: true }, tok)
          const text = typeof opts.reply === "function" ? opts.reply(input) : opts.reply ?? input.body?.parts?.find((p) => p.type === "text")?.text ?? ""
          return build({ text }, tok)
        } finally {
          meter.active -= 1
        }
      },
    },
  }
}

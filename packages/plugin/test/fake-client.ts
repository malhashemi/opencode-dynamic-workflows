import type { WorkflowClient } from "../src/client"

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
  }
}

export interface FakeClientOptions {
  /** Text the prompt returns; if a function, receives the PromptCall. Default echoes the prompt text. */
  reply?: string | ((call: PromptCall) => string)
  /** Force a prompt error (sets info.error). */
  promptError?: unknown
  /** Return no id from create (simulates a create failure). */
  noSessionId?: boolean
  /** Return no text part from prompt. */
  noTextPart?: boolean
  /** Base id; each create returns `${idPrefix}-${n}`. */
  idPrefix?: string
}

export interface FakeClient extends WorkflowClient {
  createCalls: CreateCall[]
  promptCalls: PromptCall[]
}

/** A deterministic in-memory WorkflowClient that records every call. */
export function makeFakeClient(opts: FakeClientOptions = {}): FakeClient {
  const createCalls: CreateCall[] = []
  const promptCalls: PromptCall[] = []
  let counter = 0
  const idPrefix = opts.idPrefix ?? "child"

  return {
    createCalls,
    promptCalls,
    session: {
      async create(input) {
        createCalls.push(input)
        counter += 1
        if (opts.noSessionId) return { data: null }
        return { data: { id: `${idPrefix}-${counter}` } }
      },
      async prompt(input) {
        promptCalls.push(input)
        if (opts.promptError !== undefined) {
          return { data: { info: { error: opts.promptError }, parts: [] } }
        }
        if (opts.noTextPart) {
          return { data: { info: null, parts: [{ type: "reasoning" }] } }
        }
        const text =
          typeof opts.reply === "function"
            ? opts.reply(input)
            : opts.reply ?? (input.body?.parts?.find((p) => p.type === "text")?.text ?? "")
        return { data: { info: null, parts: [{ type: "text", text }] } }
      },
    },
  }
}

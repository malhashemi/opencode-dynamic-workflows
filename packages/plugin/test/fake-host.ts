/**
 * A deterministic in-memory OpenCode for engine tests: the V2 session API (`create`, `prompt`, `wait`, `context`,
 * `interrupt`, `get`) with scripted model behaviour and a record of every call.
 *
 * A scripted reply can do what a real model does in a Unit session: answer in text, call `workflow_result`
 * (routed through the real {@link UnitIndex}, exactly as the tool's `execute` does), fail, or hang until
 * interrupted. Replies are consumed per prompt, so a test can script a bad first answer and a good repair.
 */
import type { EngineHost, HostCreateInput, HostMessage, HostSessionInfo } from "../src/host"
import type { UnitIndex } from "../src/units"

export type FakeReply =
  | { text: string }
  | { result: unknown; text?: string }
  /** Call workflow_result with each payload in order (invalid ones get the validation error back). */
  | { results: unknown[]; text?: string }
  | { error: string }
  | { hang: true }
  | { none: true }
  /** Ask a question through the Unit's question tool; the answer ends up in the reply text. */
  | { question: { header: string; prompt: string; options: string[] } }

export interface FakeHostOptions {
  /** Reply per prompt; a function receives the prompt text and the session. Default echoes the prompt. */
  reply?: FakeReply | ((call: PromptCall) => FakeReply)
  /** Per-prompt queue (overrides `reply`); the last entry repeats once exhausted. */
  replies?: FakeReply[]
  delayMs?: number
  outputTokens?: number
  cost?: number
  /** Model reported as resolved on assistant messages. */
  model?: { providerID: string; id: string }
  /** Make `create` fail. */
  createError?: string
  /** Hold `create` open this long (lets a test stop the Run while the session is being created). */
  createDelayMs?: number
  /** `prompt` never resolves (a hung admission). */
  promptHang?: boolean
  /** `prompt` rejects with this message. */
  promptError?: string
  /** `wait` rejects with this message. */
  waitError?: string
  /** Steps (model requests) each prompt takes — drives the step guard via the index. */
  stepsPerPrompt?: number
  /** Extraction reply for `generateText`; absent ⇒ no extraction support. */
  generate?: (prompt: string) => string | Promise<string>
}

export interface PromptCall {
  sessionID: string
  text: string
  turn: number
}

interface FakeSession {
  info: HostSessionInfo
  create: HostCreateInput
  messages: HostMessage[]
  running: Promise<void> | null
  interrupt: (() => void) | null
  turns: number
}

export interface FakeHost extends EngineHost {
  creates: HostCreateInput[]
  prompts: PromptCall[]
  interrupts: string[]
  generates: string[]
  sessions: Map<string, FakeSession>
  meter: { active: number; peak: number }
}

export function createFakeHost(index: UnitIndex, options: FakeHostOptions = {}): FakeHost {
  const creates: HostCreateInput[] = []
  const prompts: PromptCall[] = []
  const interrupts: string[] = []
  const generates: string[] = []
  const sessions = new Map<string, FakeSession>()
  const meter = { active: 0, peak: 0 }
  let counter = 0
  let promptIndex = 0
  const model = options.model ?? { providerID: "fake", id: "model-1" }

  const pick = (call: PromptCall): FakeReply => {
    if (options.replies && options.replies.length > 0) {
      return options.replies[Math.min(promptIndex - 1, options.replies.length - 1)]!
    }
    if (typeof options.reply === "function") return options.reply(call)
    return options.reply ?? { text: call.text }
  }

  const assistant = (content: HostMessage["content"], extra: Partial<HostMessage> = {}): HostMessage => ({
    type: "assistant",
    content,
    model,
    tokens: { input: 10, output: options.outputTokens ?? 0 },
    cost: options.cost ?? 0,
    finish: "stop",
    ...extra,
  })

  const run = async (session: FakeSession, call: PromptCall, reply: FakeReply): Promise<void> => {
    const id = session.info.id
    const binding = () => index.get(id)
    for (let step = 0; step < (options.stepsPerPrompt ?? 1); step++) {
      const b = binding()
      if (b) {
        b.steps += 1
        if (b.steps > b.maxSteps) b.onStepLimit()
      }
    }
    if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
    if ("hang" in reply) {
      await new Promise<void>((resolve) => {
        session.interrupt = resolve
      })
      session.messages.push(assistant([], { finish: "error", error: { type: "aborted", message: "Step interrupted" } }))
      session.info.outcome = "interrupted"
      return
    }
    if ("error" in reply) {
      session.messages.push(assistant([], { finish: "error", error: { type: "provider", message: reply.error } }))
      session.info.outcome = "failed"
      return
    }
    if ("none" in reply) {
      session.messages.push(assistant([{ type: "reasoning" }]))
      session.info.outcome = "succeeded"
      return
    }
    if ("question" in reply) {
      const b = binding()
      const answer = b
        ? await b.ask(
            [
              {
                header: reply.question.header,
                prompt: reply.question.prompt,
                options: reply.question.options.map((label) => ({ label, description: label })),
                multiple: false,
                custom: true,
              },
            ],
            new AbortController().signal,
          )
        : null
      session.messages.push(assistant([{ type: "text", text: answer ? `ANSWER: ${answer.answers[0]?.[0]}` : "ANSWER: none" }]))
      session.info.outcome = "succeeded"
      return
    }
    if ("result" in reply || "results" in reply) {
      const payloads = "results" in reply ? reply.results : [reply.result]
      const content: NonNullable<HostMessage["content"]> = []
      for (const payload of payloads) {
        const outcome = index.submit(id, payload)
        content.push({ type: "tool", name: "workflow_result", state: { status: outcome.ok ? "completed" : "error" } })
      }
      if (reply.text) content.push({ type: "text", text: reply.text })
      session.messages.push(assistant(content))
      session.info.outcome = "succeeded"
      return
    }
    session.messages.push(assistant([{ type: "text", text: reply.text }]))
    session.info.outcome = "succeeded"
  }

  const host: FakeHost = {
    creates,
    prompts,
    interrupts,
    generates,
    sessions,
    meter,
    session: {
      async create(input) {
        creates.push(structuredClone(input))
        if (options.createDelayMs) await new Promise((resolve) => setTimeout(resolve, options.createDelayMs))
        if (options.createError) throw new Error(options.createError)
        counter += 1
        const id = `ses_fake_${counter}`
        const info: HostSessionInfo = {
          id,
          metadata: input.metadata,
          location: input.location ?? { directory: "/fake" },
          ...(input.model ? { model: input.model } : {}),
        }
        sessions.set(id, { info, create: input, messages: [], running: null, interrupt: null, turns: 0 })
        return { ...info }
      },
      async prompt(input) {
        const session = sessions.get(input.sessionID)
        if (!session) throw new Error(`unknown session ${input.sessionID}`)
        if (options.promptHang) return new Promise(() => {})
        if (options.promptError) throw new Error(options.promptError)
        promptIndex += 1
        const call: PromptCall = { sessionID: input.sessionID, text: input.text, turn: session.turns++ }
        prompts.push(call)
        session.messages.push({ type: "user", content: [{ type: "text", text: input.text }] })
        const reply = pick(call)
        meter.active += 1
        meter.peak = Math.max(meter.peak, meter.active)
        session.running = run(session, call, reply).finally(() => {
          meter.active -= 1
          session.running = null
        })
        return { id: `msg_${promptIndex}` }
      },
      async wait(input) {
        if (options.waitError) throw new Error(options.waitError)
        const session = sessions.get(input.sessionID)
        await session?.running
      },
      async context(input) {
        return structuredClone(sessions.get(input.sessionID)?.messages ?? [])
      },
      async interrupt(input) {
        interrupts.push(input.sessionID)
        const session = sessions.get(input.sessionID)
        session?.interrupt?.()
        return { interrupted: true }
      },
      async get(input) {
        const session = sessions.get(input.sessionID)
        if (!session) throw new Error(`Session not found: ${input.sessionID}`)
        const assistants = session.messages.filter((message) => message.type === "assistant")
        return {
          ...session.info,
          model,
          cost: assistants.reduce((sum, message) => sum + (message.cost ?? 0), 0),
          tokens: {
            input: assistants.reduce((sum, message) => sum + (message.tokens?.input ?? 0), 0),
            output: assistants.reduce((sum, message) => sum + (message.tokens?.output ?? 0), 0),
          },
        }
      },
    },
    ...(options.generate
      ? {
          async generateText(input: { prompt: string }) {
            generates.push(input.prompt)
            return { text: await options.generate!(input.prompt) }
          },
        }
      : {}),
  }
  return host
}

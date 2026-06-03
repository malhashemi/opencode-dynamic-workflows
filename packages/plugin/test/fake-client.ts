import type {
  PendingPermission,
  PendingQuestion,
  PromptFormatInput,
  SessionCreateResult,
  SessionInfo,
  SessionMessage,
  SessionPromptResult,
  WorkflowClient,
  WorkflowSessionAbortInput,
  WorkflowSessionCreateInput,
  WorkflowSessionPromptInput,
} from "../src/client"

export interface CreateCall {
  parentID?: string
  title?: string
  directory?: string
  workspace?: string
}
export interface PromptCall {
  sessionID: string
  directory?: string
  workspace?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  parts: { type: string; text?: string }[]
  format?: PromptFormatInput
}
export interface PermissionReplyCall {
  requestID: string
  reply: "once" | "always" | "reject"
  message?: string
  directory?: string
  workspace?: string
}
export interface QuestionReplyCall {
  requestID: string
  answers: string[][]
  directory?: string
  workspace?: string
}
export interface QuestionRejectCall {
  requestID: string
  directory?: string
  workspace?: string
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
  /** Make every prompt HANG (never resolve) until `session.abort` is called for it — drives the timeout/abort path. */
  hang?: boolean
  /** Session records available through `session.get`, including parent chains for descendant-scope tests. */
  sessions?: SessionInfo[]
  /** Message envelopes available through `session.messages`, keyed by session id. */
  sessionMessages?: Record<string, SessionMessage[]>
  /** Pending permission requests returned by `permission.list`. */
  pendingPermissions?: PendingPermission[]
  /** Pending question requests returned by `question.list`. */
  pendingQuestions?: PendingQuestion[]
}

export interface FakeClient extends WorkflowClient {
  createCalls: CreateCall[]
  promptCalls: PromptCall[]
  /** Child-session ids passed to `session.abort` (the timeout/abort recovery path). */
  abortCalls: { sessionID: string }[]
  /** Calls made to the watcher permission-resolution surface. */
  permissionReplies: PermissionReplyCall[]
  /** Calls made to the watcher question-answer surface. */
  questionReplies: QuestionReplyCall[]
  /** Calls made to the watcher question-rejection surface. */
  questionRejects: QuestionRejectCall[]
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

function copySession(info: SessionInfo): SessionInfo {
  return { ...info }
}

function copySessionMessage(message: SessionMessage): SessionMessage {
  return {
    info: { ...message.info },
    parts: message.parts.map((part) => ({ ...part })),
  }
}

function copyPermission(permission: PendingPermission): PendingPermission {
  return {
    ...permission,
    patterns: [...permission.patterns],
    metadata: { ...permission.metadata },
    always: [...permission.always],
    tool: permission.tool ? { ...permission.tool } : undefined,
  }
}

function copyQuestion(question: PendingQuestion): PendingQuestion {
  return {
    ...question,
    questions: question.questions.map((q) => ({
      ...q,
      options: q.options.map((option) => ({ ...option })),
    })),
    tool: question.tool ? { ...question.tool } : undefined,
  }
}

/** A deterministic in-memory WorkflowClient that records every call. */
export function makeFakeClient(opts: FakeClientOptions = {}): FakeClient {
  const createCalls: CreateCall[] = []
  const promptCalls: PromptCall[] = []
  const abortCalls: { sessionID: string }[] = []
  const permissionReplies: PermissionReplyCall[] = []
  const questionReplies: QuestionReplyCall[] = []
  const questionRejects: QuestionRejectCall[] = []
  const meter = { active: 0, peak: 0 }
  let counter = 0
  let promptIndex = 0
  const idPrefix = opts.idPrefix ?? "child"
  const sessions = new Map((opts.sessions ?? []).map((session) => [session.id, copySession(session)] as const))
  const sessionMessages = new Map(
    Object.entries(opts.sessionMessages ?? {}).map(([sessionID, messages]) => [sessionID, messages.map(copySessionMessage)] as const),
  )
  const pendingPermissions = (opts.pendingPermissions ?? []).map(copyPermission)
  const pendingQuestions = (opts.pendingQuestions ?? []).map(copyQuestion)
  // Resolvers for hung prompts, keyed by child session id; `abort` resolves them (mirrors opencode's
  // abort → onInterrupt resolving the prompt) so the test leaves no dangling promise.
  const pendingHangs = new Map<string, () => void>()

  return {
    createCalls,
    promptCalls,
    abortCalls,
    permissionReplies,
    questionReplies,
    questionRejects,
    meter,
    session: {
      async create(input) {
        createCalls.push({ ...input })
        counter += 1
        if (opts.noSessionId) return { data: null }
        const id = `${idPrefix}-${counter}`
        sessions.set(id, { id, parentID: input.parentID, title: input.title })
        return { data: { id } }
      },
      async abort(input) {
        abortCalls.push({ sessionID: input.sessionID })
        const resolve = pendingHangs.get(input.sessionID)
        if (resolve) {
          pendingHangs.delete(input.sessionID)
          resolve()
        }
        return { data: true }
      },
      async prompt(input) {
        promptCalls.push({ ...input })
        // Hang mode: never settle until aborted (the runner's timeout/abort race handles it).
        if (opts.hang) {
          return new Promise<ReturnType<typeof build>>((resolve) => {
            pendingHangs.set(input.sessionID, () => resolve(build({ error: "aborted" }, opts.outputTokens)))
          })
        }
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
          const text = typeof opts.reply === "function" ? opts.reply(input) : opts.reply ?? input.parts.find((p) => p.type === "text")?.text ?? ""
          return build({ text }, tok)
        } finally {
          meter.active -= 1
        }
      },
      async get(input) {
        const session = sessions.get(input.sessionID)
        return { data: session ? copySession(session) : null }
      },
      async messages(input) {
        return { data: (sessionMessages.get(input.sessionID) ?? []).map(copySessionMessage) }
      },
    },
    permission: {
      async list() {
        return { data: pendingPermissions.map(copyPermission) }
      },
      async reply(input) {
        permissionReplies.push({ ...input })
        const index = pendingPermissions.findIndex((permission) => permission.id === input.requestID)
        if (index >= 0) pendingPermissions.splice(index, 1)
        return { data: true }
      },
    },
    question: {
      async list() {
        return { data: pendingQuestions.map(copyQuestion) }
      },
      async reply(input) {
        questionReplies.push({ ...input, answers: input.answers.map((answer) => [...answer]) })
        const index = pendingQuestions.findIndex((question) => question.id === input.requestID)
        if (index >= 0) pendingQuestions.splice(index, 1)
        return { data: true }
      },
      async reject(input) {
        questionRejects.push({ ...input })
        const index = pendingQuestions.findIndex((question) => question.id === input.requestID)
        if (index >= 0) pendingQuestions.splice(index, 1)
        return { data: true }
      },
    },
  }
}

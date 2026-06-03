/**
 * The narrow structural slice of the opencode SDK client that the workflow engine actually uses.
 *
 * We depend on this interface rather than the full `ReturnType<typeof createOpencodeClient>` so the engine is
 * trivially testable with a fake, and so the exact request/response shapes we rely on are documented in one
 * place. The real SDK client is a structural superset; the plugin adapter casts it to this type once, at the
 * boundary (see {@link file://./index.ts}). Shapes verified against the `@opencode-ai/sdk/v2` public client
 * signatures on opencode v1.15.12.
 */

/** Response envelope: the SDK uses `responseStyle: "fields"`, so payloads live under `.data`. */
export interface SessionCreateResult {
  data?: { id: string } | null
}

/** Minimal session record needed for descendant-session parent walks. */
export interface SessionInfo {
  id: string
  parentID?: string
  title?: string
}

/** A text part to send into a prompt. */
export interface PromptPartInput {
  type: "text"
  text: string
}

/**
 * Native structured-output request. opencode's core reads `format` off the user message: a `json_schema`
 * format makes it inject the validated `StructuredOutput` tool, force `toolChoice:"required"`, and persist
 * `info.structured` (`prompt.ts:1403-1473`; shape `message-v2.ts:64-68`). The v2 SDK request type carries
 * `format` natively. `schema` is a plain JSON Schema object (zod-derived; see schema-bridge).
 */
export interface PromptFormatInput {
  type: "json_schema"
  schema: Record<string, unknown>
  /** Core's own retry budget — present for completeness; core does NOT consume it, so the engine retries. */
  retryCount?: number
}

/** A returned message part. We only read `text` parts; others are ignored. */
export interface PromptResultPart {
  type: string
  text?: string
}

export interface SessionPromptResult {
  data?: {
    /** `error` carries a `StructuredOutputError` (named) when forced structured output fails; `structured` is
     * the validated payload when it succeeds (`prompt.ts:1458`). `tokens.output` is the assistant's output-token
     * count for the advisory budget — confirmed live (2026-05-29) to be populated synchronously on the blocking
     * prompt response (matches the SDK `AssistantMessage.tokens.output`); read best-effort, missing ⇒ 0. */
    info?: { error?: unknown; structured?: unknown; tokens?: { output?: number } } | null
    parts?: PromptResultPart[]
  } | null
}

export interface WorkflowSessionCreateInput {
  parentID?: string
  title?: string
  directory?: string
  workspace?: string
  /** Compile-only compatibility guard: engine code must not send the old SDK envelope. */
  body?: never
  /** Compile-only compatibility guard: engine code must not send the old SDK envelope. */
  query?: never
}

export interface WorkflowSessionPromptInput {
  sessionID: string
  directory?: string
  workspace?: string
  agent?: string
  model?: { providerID: string; modelID: string }
  parts: PromptPartInput[]
  format?: PromptFormatInput
  /** Compile-only compatibility guard: engine code must not send the old SDK envelope. */
  path?: never
  /** Compile-only compatibility guard: engine code must not send the old SDK envelope. */
  body?: never
  /** Compile-only compatibility guard: engine code must not send the old SDK envelope. */
  query?: never
}

export interface WorkflowSessionAbortInput {
  sessionID: string
  directory?: string
  workspace?: string
  /** Compile-only compatibility guard: engine code must not send the old SDK envelope. */
  path?: never
}

export interface WorkflowSessionGetInput {
  sessionID: string
  directory?: string
  workspace?: string
  /** Compile-only compatibility guard: engine code must not send the old SDK envelope. */
  path?: never
}

export interface SessionGetResult {
  data?: SessionInfo | null
}

export interface WorkflowSessionMessagesInput {
  sessionID: string
  directory?: string
  workspace?: string
  /** Compile-only compatibility guard: engine code must not send the old SDK envelope. */
  path?: never
}

export interface SessionMessageInfo {
  role: "user" | "assistant"
}

export interface SessionMessagePart {
  type: string
  text?: string
}

/** Minimal message envelope needed for proxy seeding: find the first user message and read text parts. */
export interface SessionMessage {
  info: SessionMessageInfo
  parts: SessionMessagePart[]
}

export interface SessionMessagesResult {
  data?: SessionMessage[] | null
}

export interface PermissionToolRef {
  messageID: string
  callID: string
}

export interface PendingPermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: PermissionToolRef
}

export interface PermissionListResult {
  data?: PendingPermission[] | null
}

export interface WorkflowPermissionReplyInput {
  requestID: string
  reply: "once" | "always" | "reject"
  message?: string
  directory?: string
  workspace?: string
}

export interface QuestionOptionInfo {
  /** Display label returned by the v2 Question surface. */
  label: string
  /** Explanation for the option returned by the v2 Question surface. */
  description: string
}

export interface QuestionInfo {
  /** The complete question text; the v2 SDK names this field `question`. */
  question: string
  /** Short display header for the question. */
  header: string
  /** Available answer choices. */
  options: QuestionOptionInfo[]
  multiple?: boolean
  custom?: boolean
}

export interface QuestionToolRef {
  messageID: string
  callID: string
}

export interface PendingQuestion {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: QuestionToolRef
}

export interface QuestionListResult {
  data?: PendingQuestion[] | null
}

export interface WorkflowQuestionReplyInput {
  requestID: string
  answers: string[][]
  directory?: string
  workspace?: string
}

export interface WorkflowQuestionRejectInput {
  requestID: string
  directory?: string
  workspace?: string
}

export interface WorkflowClient {
  session: {
    create(input: WorkflowSessionCreateInput): Promise<SessionCreateResult>
    prompt(input: WorkflowSessionPromptInput): Promise<SessionPromptResult>
    /**
     * Cancel an in-flight prompt on a child session (`POST /session/{id}/abort`). Used to recover a Unit whose
     * blocking prompt has hung (e.g. on an unanswered permission ask) or whose Run was aborted — interrupting
     * the server-side fiber resolves the otherwise-unbounded prompt instead of leaking it.
     */
    abort(input: WorkflowSessionAbortInput): Promise<unknown>
    /** Read a session's parent pointer/title for descendant-scope checks. */
    get(input: WorkflowSessionGetInput): Promise<SessionGetResult>
    /** Read a session's message envelopes so the proxy seed can recover the first user-message text. */
    messages(input: WorkflowSessionMessagesInput): Promise<SessionMessagesResult>
  }
  permission: {
    /** Pending permission requests across all sessions in the instance (`GET /permission`). */
    list(): Promise<PermissionListResult>
    /** Reply to a pending permission request (`POST /permission/{requestID}/reply`). */
    reply(input: WorkflowPermissionReplyInput): Promise<unknown>
  }
  question: {
    /** Pending question requests across all sessions in the instance (`GET /question`). */
    list(): Promise<QuestionListResult>
    /** Answer a pending question request (`POST /question/{requestID}/reply`). */
    reply(input: WorkflowQuestionReplyInput): Promise<unknown>
    /** Reject a pending question request (`POST /question/{requestID}/reject`). */
    reject(input: WorkflowQuestionRejectInput): Promise<unknown>
  }
}

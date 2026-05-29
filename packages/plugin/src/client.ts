/**
 * The narrow structural slice of the opencode SDK client that the workflow engine actually uses.
 *
 * We depend on this interface rather than the full `ReturnType<typeof createOpencodeClient>` so the engine is
 * trivially testable with a fake, and so the exact request/response shapes we rely on are documented in one
 * place. The real SDK client is a structural superset; the plugin adapter casts it to this type once, at the
 * boundary (see {@link file://./index.ts}). Shapes verified against opencode v1.15.12 — see research note
 * `opencode-plugin-sdk-api-contract`.
 */

/** Response envelope: the SDK uses `responseStyle: "fields"`, so payloads live under `.data`. */
export interface SessionCreateResult {
  data?: { id: string } | null
}

/** A text part to send into a prompt. */
export interface PromptPartInput {
  type: "text"
  text: string
}

/**
 * Native structured-output request. opencode's core reads `format` off the user message: a `json_schema`
 * format makes it inject the validated `StructuredOutput` tool, force `toolChoice:"required"`, and persist
 * `info.structured` (`prompt.ts:1403-1473`; shape `message-v2.ts:64-68`). The v1 SDK request types are stale
 * and omit `format`, so the adapter hand-casts the body — the route itself accepts it (confirmed live by the
 * structured binding-confirm). `schema` is a plain JSON Schema object (zod-derived; see schema-bridge).
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

export interface WorkflowClient {
  session: {
    create(input: {
      body?: { parentID?: string; title?: string }
      query?: { directory?: string }
    }): Promise<SessionCreateResult>
    prompt(input: {
      /** v1.15.x path key is `id` (NOT v2's `sessionID`). */
      path: { id: string }
      body?: {
        agent?: string
        model?: { providerID: string; modelID: string }
        parts: PromptPartInput[]
        /** Hand-cast onto the v1 body (the v1 types omit it); core reads it to drive structured output. */
        format?: PromptFormatInput
      }
      query?: { directory?: string }
    }): Promise<SessionPromptResult>
    /**
     * Cancel an in-flight prompt on a child session (`POST /session/{id}/abort`). Used to recover a Unit whose
     * blocking prompt has hung (e.g. on an unanswered permission ask) or whose Run was aborted — interrupting
     * the server-side fiber resolves the otherwise-unbounded prompt instead of leaking it.
     */
    abort(input: { path: { id: string } }): Promise<unknown>
  }
}

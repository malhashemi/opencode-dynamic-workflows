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

/** A text part to send into a prompt. v1.15.x has no `format`/json_schema field. */
export interface PromptPartInput {
  type: "text"
  text: string
}

/** A returned message part. We only read `text` parts; others are ignored. */
export interface PromptResultPart {
  type: string
  text?: string
}

export interface SessionPromptResult {
  data?: {
    info?: { error?: unknown } | null
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
      }
      query?: { directory?: string }
    }): Promise<SessionPromptResult>
  }
}

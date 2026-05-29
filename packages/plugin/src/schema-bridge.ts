/**
 * The Schema-bridge — the pure boundary between an author's zod `schema` and opencode's native structured
 * output. It does two things and nothing else (so it is testable with no live opencode and no git):
 *
 *  1. {@link toJsonSchema} — zod → a plain JSON Schema object for the `format:{type:"json_schema"}` request.
 *  2. {@link parseStructured} — opencode's persisted `info.structured` → the schema's typed value, re-validated.
 *
 * Why re-validate? opencode's `StructuredOutput` tool already validates the model's output against the JSON
 * Schema before it lands (`prompt.ts:createStructuredOutputTool`). But JSON Schema cannot express zod
 * refinements, transforms, defaults, coercions or branded types — so we `parse()` again to apply those and to
 * recover the precisely-typed value. A payload that is JSON-Schema-valid yet fails the zod schema is a real
 * (retryable) failure, not a success.
 */
import { z } from "@opencode-ai/workflow"

/**
 * Engine-side retry budget for structured output, matching opencode's own `OutputFormatJsonSchema.retryCount`
 * default (`message-v2.ts`). Core does NOT consume it (it raises `StructuredOutputError` with `retries:0`),
 * so the engine retries; this is the default for {@link AgentOpts.retries}.
 */
export const DEFAULT_RETRIES = 2

/**
 * Convert a zod schema to a plain JSON Schema object suitable for `format:{type:"json_schema",schema}`.
 *
 * Targets draft-7 to match the `JSONSchema7` shape opencode feeds the AI SDK, and strips the top-level
 * `$schema` annotation (core strips it anyway — `prompt.ts:1752` — and the tool input wants a bare object).
 * Throws on a non-zod input: that is author misuse, surfaced loudly rather than shipped to the model loop.
 */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>
  return rest
}

/** Result of re-validating a structured payload: the typed value, or a stringified failure reason. */
export type ParseStructuredResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Re-validate opencode's `info.structured` payload through the author's zod schema, returning the typed value
 * or a recorded error (never throws). A failure here is a Unit failure (retryable upstream), not author misuse.
 */
export function parseStructured<S extends z.ZodType>(schema: S, payload: unknown): ParseStructuredResult<z.infer<S>> {
  const parsed = schema.safeParse(payload)
  if (parsed.success) return { ok: true, value: parsed.data }
  return { ok: false, error: z.prettifyError(parsed.error) }
}

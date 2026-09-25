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
import { z } from "zod"

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

// ---------------------------------------------------------------------------------------------------------------
// JSON Schema input (D7 alias): `agent({ schema: { type: "object", ... } })`
// ---------------------------------------------------------------------------------------------------------------

type JsonSchemaObject = Record<string, unknown>

/** JSON Schemas an author passed directly, keyed by the zod schema built from them, so the model sees the original. */
const originals = new WeakMap<z.ZodType, JsonSchemaObject>()

export function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && typeof (value as { safeParse?: unknown }).safeParse === "function"
}

/**
 * Accept a zod schema as-is, or build one from a plain JSON Schema object. Supports the keywords models and
 * authors actually use: type (incl. arrays of types), properties/required/additionalProperties, items, enum,
 * const, anyOf/oneOf, min/max length and value, pattern, and nullable-by-type. Unknown keywords are ignored.
 */
export function resolveJsonSchema(schema: unknown): z.ZodType | undefined {
  if (schema === undefined || schema === null) return undefined
  if (isZodSchema(schema)) return schema
  if (typeof schema !== "object" || Array.isArray(schema)) throw new TypeError("expected a zod schema or a JSON Schema object")
  const built = fromJsonSchema(schema as JsonSchemaObject)
  originals.set(built, schema as JsonSchemaObject)
  return built
}

export function fromJsonSchema(node: JsonSchemaObject): z.ZodType {
  if (Array.isArray(node.enum)) {
    const values = node.enum as unknown[]
    if (values.length > 0 && values.every((value) => typeof value === "string")) return z.enum(values as [string, ...string[]])
    return z.union(values.map((value) => z.literal(value as never)) as unknown as [z.ZodType, z.ZodType])
  }
  if ("const" in node) return z.literal(node.const as never)
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = node[key]
    if (Array.isArray(options) && options.length > 0) {
      const members = options.map((option) => fromJsonSchema(option as JsonSchemaObject))
      return members.length === 1 ? members[0]! : z.union(members as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
    }
  }
  const type = node.type
  if (Array.isArray(type)) {
    const members = type.map((entry) => fromJsonSchema({ ...node, type: entry }))
    return members.length === 1 ? members[0]! : z.union(members as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]])
  }
  switch (type) {
    case "string": {
      let s = z.string()
      if (typeof node.minLength === "number") s = s.min(node.minLength)
      if (typeof node.maxLength === "number") s = s.max(node.maxLength)
      if (typeof node.pattern === "string") s = s.regex(new RegExp(node.pattern))
      return s
    }
    case "integer":
    case "number": {
      let n = type === "integer" ? z.number().int() : z.number()
      if (typeof node.minimum === "number") n = n.min(node.minimum)
      if (typeof node.maximum === "number") n = n.max(node.maximum)
      if (typeof node.exclusiveMinimum === "number") n = n.gt(node.exclusiveMinimum)
      if (typeof node.exclusiveMaximum === "number") n = n.lt(node.exclusiveMaximum)
      return n
    }
    case "boolean":
      return z.boolean()
    case "null":
      return z.null()
    case "array": {
      let a = z.array(node.items && typeof node.items === "object" ? fromJsonSchema(node.items as JsonSchemaObject) : z.unknown())
      if (typeof node.minItems === "number") a = a.min(node.minItems)
      if (typeof node.maxItems === "number") a = a.max(node.maxItems)
      return a
    }
    case "object": {
      const properties = (node.properties ?? {}) as Record<string, JsonSchemaObject>
      const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : [])
      const shape: Record<string, z.ZodType> = {}
      for (const [key, value] of Object.entries(properties)) {
        const member = fromJsonSchema(value)
        shape[key] = required.has(key) ? member : member.optional()
      }
      const object = z.object(shape)
      if (node.additionalProperties === false) return object.strict()
      if (node.additionalProperties && typeof node.additionalProperties === "object") {
        return object.catchall(fromJsonSchema(node.additionalProperties as JsonSchemaObject))
      }
      return object.loose()
    }
    default:
      return z.unknown()
  }
}

/** The JSON Schema the model should see: the author's original when they wrote one, else zod's rendering. */
export function modelJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const original = originals.get(schema)
  if (original) {
    const { $schema: _drop, ...rest } = original
    return rest
  }
  return toJsonSchema(schema)
}

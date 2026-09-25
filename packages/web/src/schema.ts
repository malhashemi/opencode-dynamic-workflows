/**
 * A small JSON Schema check for Workflow args, run before a Start request so obvious mistakes are caught in the
 * form. It covers the keywords zod's `toJSONSchema` emits for plain objects (type, properties, required,
 * additionalProperties, items, enum, const, bounds, anyOf/oneOf). Anything it does not understand passes; the
 * engine validates for real.
 */
export type JsonSchema = Record<string, unknown>

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function typeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  return typeof value
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value)
  if (expected === "number") return actual === "number" || actual === "integer"
  return expected === actual
}

export function validateJson(schema: unknown, value: unknown, at = "args"): string[] {
  if (!isObject(schema)) return []
  const errors: string[] = []
  const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : []
  if (types.length > 0 && !types.some((type) => typeMatches(type, value))) {
    return [`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`]
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
    errors.push(`${at}: must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(", ")}`)
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) errors.push(`${at}: must be ${JSON.stringify(schema.const)}`)
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key]
    if (Array.isArray(options) && options.length > 0 && !options.some((option) => validateJson(option, value, at).length === 0)) {
      errors.push(`${at}: does not match any allowed shape`)
    }
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`${at}: at least ${schema.minLength} characters`)
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`${at}: at most ${schema.maxLength} characters`)
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${at}: must be ≥ ${schema.minimum}`)
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${at}: must be ≤ ${schema.maximum}`)
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${at}: must be > ${schema.exclusiveMinimum}`)
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(`${at}: must be < ${schema.exclusiveMaximum}`)
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${at}: at least ${schema.minItems} items`)
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) errors.push(`${at}: at most ${schema.maxItems} items`)
    if (isObject(schema.items)) value.forEach((item, index) => errors.push(...validateJson(schema.items, item, `${at}[${index}]`)))
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (typeof key === "string" && !(key in value)) errors.push(`${at}.${key}: required`)
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) errors.push(...validateJson(properties[key], child, `${at}.${key}`))
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: not allowed`)
      else if (isObject(schema.additionalProperties)) errors.push(...validateJson(schema.additionalProperties, child, `${at}.${key}`))
    }
  }
  return errors
}

/** A starting value for the args textarea: required fields with placeholder values of the right type. */
export function templateFor(schema: unknown, depth = 0): unknown {
  if (!isObject(schema) || depth > 4) return null
  if ("default" in schema) return schema.default
  if ("const" in schema) return schema.const
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  const type = typeof schema.type === "string" ? schema.type : Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : undefined
  switch (type) {
    case "object": {
      const properties = isObject(schema.properties) ? schema.properties : {}
      const required = new Set(Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : Object.keys(properties))
      return Object.fromEntries(Object.entries(properties).filter(([key]) => required.has(key)).map(([key, child]) => [key, templateFor(child, depth + 1)]))
    }
    case "array":
      return []
    case "string":
      return ""
    case "number":
    case "integer":
      return typeof schema.minimum === "number" ? schema.minimum : 0
    case "boolean":
      return false
    default:
      return null
  }
}

export type ParsedArgs = { ok: true; value: unknown } | { ok: false; errors: string[] }

/** Parse the textarea and check it against the listing's args schema. Empty means "no args". */
export function parseArgs(text: string, schema: unknown): ParsedArgs {
  const trimmed = text.trim()
  if (!trimmed) {
    if (isObject(schema) && Array.isArray(schema.required) && schema.required.length > 0) return { ok: false, errors: ["args: required"] }
    return { ok: true, value: undefined }
  }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch (error) {
    return { ok: false, errors: [`not valid JSON: ${error instanceof Error ? error.message : String(error)}`] }
  }
  const errors = validateJson(schema, value)
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value }
}

/** Human summary of the args schema, one line per top-level field. */
export function describeFields(schema: unknown): { name: string; type: string; required: boolean; description: string | null }[] {
  if (!isObject(schema) || !isObject(schema.properties)) return []
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(schema.properties).map(([name, child]) => {
    const node = isObject(child) ? child : {}
    const type = Array.isArray(node.enum)
      ? node.enum.map((option) => JSON.stringify(option)).join(" | ")
      : typeof node.type === "string"
        ? node.type === "array" && isObject(node.items) && typeof node.items.type === "string" ? `${node.items.type}[]` : node.type
        : Array.isArray(node.type) ? node.type.join(" | ") : "any"
    return { name, type, required: required.has(name), description: typeof node.description === "string" ? node.description : null }
  })
}

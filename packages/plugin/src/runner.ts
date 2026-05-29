/**
 * The Agent runner — the load-bearing per-Unit mechanic.
 *
 * One `agent()` call == one Unit == its OWN child session, blocking-prompted under a named subagent. Giving
 * every Unit a fresh child upholds opencode's per-childSession serialization invariant (two prompts to one
 * session coalesce — see the feasibility study), so the skeleton is correct by construction.
 *
 * With a `schema`, the Unit requests native structured output: the schema becomes a `format:{json_schema}`
 * request (opencode injects its validated `StructuredOutput` tool and forces it), and the persisted
 * `info.structured` is re-parsed through the same zod schema. Core does NOT retry a structured failure (it
 * raises `StructuredOutputError` with `retries:0`), so the retry lives HERE — each attempt a fresh child.
 */
import type { z } from "@opencode-ai/workflow"
import type { PromptFormatInput, WorkflowClient } from "./client"
import { DEFAULT_RETRIES, parseStructured, toJsonSchema } from "./schema-bridge"

/** Default subagent when a Unit omits `subagent` — `general` is a native opencode subagent. */
export const DEFAULT_SUBAGENT = "general"

export interface RunAgentOptions {
  subagent?: string
  model?: { providerID: string; modelID: string }
  /** Zod schema → native structured output. Absent ⇒ the Unit resolves to its last assistant text part. */
  schema?: z.ZodType
  /** Extra attempts on a structured-output failure (default {@link DEFAULT_RETRIES}). Ignored without `schema`. */
  retries?: number
}

/**
 * Discriminated result so a failed Unit never aborts the surrounding fan-out (error model D9). The `kind`
 * distinguishes the text path (`text`) from the structured path (`value`, already parsed to the schema type).
 */
export type AgentRunResult =
  | { ok: true; kind: "text"; text: string; childSessionID: string; outputTokens: number }
  | { ok: true; kind: "structured"; value: unknown; childSessionID: string; outputTokens: number }
  | { ok: false; error: string; childSessionID?: string }

/** Best-effort stringify of an arbitrary thrown/error value for the `ctx.errors` side-channel (D9). */
export function stringifyError(error: unknown): string {
  if (error == null) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** opencode raises a named `StructuredOutputError` when forced structured output fails (`message-v2.ts:42`). */
function isStructuredOutputError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "StructuredOutputError"
}

/**
 * Run a single Unit: create a child session under `parentSessionID`, blocking-prompt it as `subagent`
 * (default `general`), and return its last assistant text — or, with a `schema`, its validated structured value.
 */
export async function runAgent(
  client: WorkflowClient,
  parentSessionID: string,
  prompt: string,
  opts: RunAgentOptions = {},
): Promise<AgentRunResult> {
  const subagent = opts.subagent ?? DEFAULT_SUBAGENT
  const schema = opts.schema

  // Convert the schema ONCE up front. A conversion failure is author misuse (a non-zod `schema`) and is
  // deterministic — surface it immediately as a Unit failure rather than throwing (D9); retrying cannot help.
  let format: PromptFormatInput | undefined
  if (schema !== undefined) {
    try {
      format = { type: "json_schema", schema: toJsonSchema(schema) }
    } catch (error) {
      return { ok: false, error: `agent({ schema }) is not a valid zod schema: ${stringifyError(error)}` }
    }
  }

  // Engine-layer retry: only a structured failure (a `StructuredOutputError`, or a payload that fails the zod
  // schema) is retried, only on the schema path, up to `retries` extra attempts. Each attempt gets its OWN
  // fresh child — re-prompting one child would coalesce (the serialization invariant). Infra failures
  // (create returned no id, a transport reject, a non-structured `info.error`) fail fast: retrying won't help.
  const maxAttempts = schema === undefined ? 1 : Math.max(0, opts.retries ?? DEFAULT_RETRIES) + 1
  let childSessionID: string | undefined
  let lastError = "structured output failed"

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const isLast = attempt === maxAttempts - 1
    // Never-throw for runtime failures (D9): any transport rejection becomes `{ ok: false }` so a single
    // failed Unit is recorded in `ctx.errors` and never aborts the surrounding run or fan-out.
    try {
      const created = await client.session.create({
        body: { parentID: parentSessionID, title: `wf:${subagent}` },
      })
      childSessionID = created.data?.id
      if (!childSessionID) return { ok: false, error: "session.create returned no session id" }

      // Long-await guard: a Unit can run for many minutes. We impose NO client-side timeout on this blocking
      // prompt, so a slow Unit is not cut short by us; a dropped connection surfaces as a rejection (caught
      // below) or `info.error`, recorded in `ctx.errors` — never a silent drop. (Recorded per the long-await AC.)
      const res = await client.session.prompt({
        path: { id: childSessionID },
        body: {
          agent: subagent,
          ...(opts.model ? { model: opts.model } : {}),
          parts: [{ type: "text", text: prompt }],
          ...(format ? { format } : {}),
        },
      })

      const info = res.data?.info
      // Best-effort output-token count for the advisory budget; missing ⇒ 0 (the exact SDK field is a pending
      // live-check per the spec's open item).
      const outputTokens = info?.tokens?.output ?? 0

      if (schema === undefined) {
        // --- text path (unchanged contract; no retry) ---
        if (info?.error) return { ok: false, error: stringifyError(info.error), childSessionID }
        const text = (res.data?.parts ?? []).filter((p) => p.type === "text").at(-1)?.text
        if (text === undefined) return { ok: false, error: "prompt returned no assistant text part", childSessionID }
        return { ok: true, kind: "text", text, childSessionID, outputTokens }
      }

      // --- structured path ---
      if (info?.error) {
        lastError = stringifyError(info.error)
        if (isStructuredOutputError(info.error) && !isLast) continue // retry only the structured failure
        return { ok: false, error: lastError, childSessionID }
      }
      if (info?.structured === undefined) {
        // No error AND no structured payload — unexpected (core forces the tool); not a retryable case.
        return { ok: false, error: "structured output missing from response", childSessionID }
      }
      const parsed = parseStructured(schema, info.structured)
      if (parsed.ok) return { ok: true, kind: "structured", value: parsed.value, childSessionID, outputTokens }
      // JSON-Schema-valid but zod-invalid (a refinement/transform): retryable, like a StructuredOutputError.
      lastError = `structured output failed schema validation: ${parsed.error}`
      if (!isLast) continue
      return { ok: false, error: lastError, childSessionID }
    } catch (error) {
      // Infra/transport rejection — never retried (deterministic-ish failure), never thrown.
      return { ok: false, error: stringifyError(error), childSessionID }
    }
  }
  return { ok: false, error: lastError, childSessionID }
}

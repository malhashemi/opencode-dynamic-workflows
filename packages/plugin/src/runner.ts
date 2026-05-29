/**
 * The Agent runner — the load-bearing per-Unit mechanic.
 *
 * One `agent()` call == one Unit == its OWN child session, blocking-prompted under a named subagent. Giving
 * every Unit a fresh child upholds opencode's per-childSession serialization invariant (two prompts to one
 * session coalesce — see the feasibility study), so the skeleton is correct by construction.
 */
import type { WorkflowClient } from "./client"

/** Default subagent when a Unit omits `subagent` — `general` is a native opencode subagent. */
export const DEFAULT_SUBAGENT = "general"

export interface RunAgentOptions {
  subagent?: string
  model?: { providerID: string; modelID: string }
  /** Present only so we can fail loudly: native structured output does not exist on the v1.15.x route. */
  schema?: unknown
}

/** Discriminated result so a failed Unit never aborts the surrounding fan-out (error model D9). */
export type AgentRunResult =
  | { ok: true; text: string; childSessionID: string }
  | { ok: false; error: string; childSessionID?: string }

function stringifyError(error: unknown): string {
  if (error == null) return "unknown error"
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/**
 * Run a single Unit: create a child session under `parentSessionID`, blocking-prompt it as `subagent`
 * (default `general`), and return its last assistant text part.
 */
export async function runAgent(
  client: WorkflowClient,
  parentSessionID: string,
  prompt: string,
  opts: RunAgentOptions = {},
): Promise<AgentRunResult> {
  if (opts.schema !== undefined) {
    throw new Error(
      "agent({ schema }) is not supported on the opencode v1.15.x SDK (no json_schema `format` route). " +
        "Native structured output is a later ticket — drop `schema` for now.",
    )
  }

  const subagent = opts.subagent ?? DEFAULT_SUBAGENT

  const created = await client.session.create({
    body: { parentID: parentSessionID, title: `wf:${subagent}` },
  })
  const childSessionID = created.data?.id
  if (!childSessionID) {
    return { ok: false, error: "session.create returned no session id" }
  }

  const res = await client.session.prompt({
    path: { id: childSessionID },
    body: {
      agent: subagent,
      ...(opts.model ? { model: opts.model } : {}),
      parts: [{ type: "text", text: prompt }],
    },
  })

  const info = res.data?.info
  if (info?.error) {
    return { ok: false, error: stringifyError(info.error), childSessionID }
  }

  const parts = res.data?.parts ?? []
  const text = parts.filter((p) => p.type === "text").at(-1)?.text
  if (text === undefined) {
    return { ok: false, error: "prompt returned no assistant text part", childSessionID }
  }

  return { ok: true, text, childSessionID }
}

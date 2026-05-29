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

  // Never-throw for runtime failures (error model D9): any transport rejection from create/prompt becomes an
  // `{ ok: false }` so a single failed Unit is recorded in `ctx.errors` and never aborts the surrounding run
  // or fan-out. (The `schema` guard above stays a throw — it is author misuse, not a Unit failure.)
  let childSessionID: string | undefined
  try {
    const created = await client.session.create({
      body: { parentID: parentSessionID, title: `wf:${subagent}` },
    })
    childSessionID = created.data?.id
    if (!childSessionID) {
      return { ok: false, error: "session.create returned no session id" }
    }

    // Long-await guard (parallel-fan-out AC). A Unit can run for many minutes. We impose NO client-side
    // timeout on this blocking prompt, so a slow Unit is not cut short by us. If the underlying transport or
    // server *does* drop the connection (opencode's server sets no timeout; Bun's fetch has none by default —
    // unverified at extreme durations), it surfaces as a rejection (caught below) or `info.error` and is
    // recorded in `ctx.errors` — never a silent drop. Chosen v1 mitigation: rely on no-timeout +
    // error-on-drop; keep-alive liveness-polling is deferred to a live spike, and the author-side guidance is
    // to split a Unit that would run for very long. (Recorded per the long-await AC.)
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
  } catch (error) {
    return { ok: false, error: stringifyError(error), childSessionID }
  }
}

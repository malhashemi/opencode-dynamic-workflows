/**
 * The client half of `POST /control`.
 *
 * A run is owned by exactly one engine instance, and the TUI may be watching several at once (two projects,
 * two hosts). So the addressing question — "which endpoint owns this runId?" — is answered by the same
 * descriptor scan the run client already performs, rather than by a second discovery mechanism that could
 * disagree with the first about which host is live.
 */
import type { EndpointDescriptor } from "../discovery"
import type { ControlAction, ControlResult } from "../control"
import type { RunClientFetch } from "./client"

export interface RunControlClient {
  send(action: ControlAction): Promise<ControlResult>
}

export interface ControlClientOptions {
  endpointFor: (runId: string) => EndpointDescriptor | undefined
  fetch?: RunClientFetch
}

function isControlResult(value: unknown): value is ControlResult {
  return typeof value === "object" && value !== null && typeof (value as ControlResult).ok === "boolean"
}

export function createControlClient(options: ControlClientOptions): RunControlClient {
  const fetcher = options.fetch ?? globalThis.fetch
  return {
    async send(action) {
      const descriptor = options.endpointFor(action.runId)
      // No live endpoint claims this run. From the user's side that is indistinguishable from a run the engine
      // has forgotten, and `unknown-run` is exactly what the engine would have answered.
      if (!descriptor) return { ok: false, reason: "unknown-run" }
      try {
        const response = await fetcher(`${descriptor.url}/control`, {
          method: "POST",
          headers: { authorization: `Bearer ${descriptor.token}`, "content-type": "application/json" },
          body: JSON.stringify(action),
        })
        const body: unknown = await response.json().catch(() => null)
        // The endpoint answers with a `ControlResult` on every outcome including its error statuses, so the
        // body is the answer whenever it parses; the status is corroboration, not a second protocol.
        if (isControlResult(body)) return body
        return { ok: false, reason: response.status === 404 ? "unknown-run" : "unsupported" }
      } catch {
        // A transport failure is not a control outcome the engine produced. `unsupported` is the honest
        // member of `ControlFailure` for "this endpoint did not answer at all".
        return { ok: false, reason: "unsupported" }
      }
    },
  }
}

/**
 * The browser mirror of the TUI's `RunControlClient`: one `send`, the endpoint's own `ControlResult` back.
 *
 * No endpoint lookup — the TUI merges many hosts and has to resolve which one owns a run, but a dashboard was
 * served BY its endpoint, so the base URL is the answer. Failures come back as results rather than throws for
 * the same reason the TUI client never throws mid-keystroke: a dead endpoint is a state the surface renders,
 * not an exception the surface crashes on.
 */
import type { ControlAction, ControlResult } from "./engine"

export function createControls(options: { baseUrl: string; token?: string | null; fetch?: typeof fetch }): {
  send(action: ControlAction): Promise<ControlResult>
} {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  return {
    async send(action) {
      try {
        const response = await fetcher(`${options.baseUrl}/control`, {
          method: "POST",
          headers: {
            // Loopback (the normal case) needs no credential; a token is only ever present on the rare
            // non-loopback bind, whose link still carries one.
            ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
            "content-type": "application/json",
          },
          body: JSON.stringify(action),
        })
        const body: unknown = await response.json().catch(() => null)
        if (typeof body === "object" && body !== null && "ok" in body) return body as ControlResult
        return { ok: false, reason: "unsupported", detail: `endpoint answered ${response.status}` }
      } catch (error) {
        return { ok: false, reason: "unsupported", detail: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

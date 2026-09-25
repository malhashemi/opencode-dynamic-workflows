/**
 * Plugin options, as configured in `opencode.json(c)`:
 *
 *     { "plugins": [{ "package": "opencode-dynamic-workflows", "options": { … } }] }
 *
 * Every field is optional; invalid values fall back to the default rather than failing plugin setup.
 */
import type { RunLimits } from "../context"
import { DEFAULT_LIMITS } from "../context"

export type InlinePolicy = "ask" | "allow" | "deny"
export type Retention = "keep" | "delete-on-success"
export type GatewayBind = "loopback" | "lan" | "tailscale" | string

export interface GatewayConfig {
  enabled: boolean
  bind: GatewayBind
  port: number
  allowedOrigins: string[]
  /** `token` (default): control needs a bearer token; loopback reads do not. `none`: no auth on loopback only. */
  auth: "token" | "none"
  /** Serve the web app from the Gateway. */
  web: boolean
}

export interface PluginConfig {
  inline: InlinePolicy
  /** Give inline (model-authored) Runs `ctx.$` / `ctx.file` / `ctx.fetch`. Durable Runs always have them. */
  inlineCapabilities: boolean
  retention: Retention
  limits: RunLimits
  gateway: GatewayConfig
}

export const DEFAULT_GATEWAY_PORT = 4320

export const DEFAULT_CONFIG: PluginConfig = {
  inline: "ask",
  inlineCapabilities: true,
  retention: "keep",
  limits: { ...DEFAULT_LIMITS },
  gateway: { enabled: true, bind: "loopback", port: DEFAULT_GATEWAY_PORT, allowedOrigins: [], auth: "token", web: true },
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const positiveInt = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback

export function parseConfig(options: unknown): PluginConfig {
  const input = record(options)
  const limits = record(input.limits)
  const gateway = record(input.gateway)
  const inline = input.inline === "allow" || input.inline === "deny" ? input.inline : "ask"
  const retention = input.retention === "delete-on-success" ? "delete-on-success" : "keep"
  const port = typeof gateway.port === "number" && Number.isInteger(gateway.port) && gateway.port >= 0 && gateway.port <= 65_535 ? gateway.port : DEFAULT_GATEWAY_PORT
  return {
    inline,
    inlineCapabilities: input.inlineCapabilities !== false,
    retention,
    limits: {
      maxUnits: positiveInt(limits.maxUnits, DEFAULT_LIMITS.maxUnits),
      maxItemsPerCall: positiveInt(limits.maxItemsPerCall, DEFAULT_LIMITS.maxItemsPerCall),
      maxUnitSteps: positiveInt(limits.maxUnitSteps, DEFAULT_LIMITS.maxUnitSteps),
    },
    gateway: {
      enabled: gateway.enabled !== false,
      bind: typeof gateway.bind === "string" && gateway.bind.length > 0 ? gateway.bind : "loopback",
      port,
      allowedOrigins: Array.isArray(gateway.allowedOrigins) ? gateway.allowedOrigins.filter((o): o is string => typeof o === "string") : [],
      auth: gateway.auth === "none" ? "none" : "token",
      web: gateway.web !== false,
    },
  }
}

/**
 * The engine's narrow view of OpenCode — exactly the calls it makes, and nothing more.
 *
 * The real plugin context (`@opencode/plugin`, `ctx.session.*`, `ctx.generate.text`) satisfies this shape; the
 * single adaptation lives in `host/adapter.ts`. Tests supply an in-memory fake (`test/fake-host.ts`). Keeping
 * the slice narrow is what lets the whole engine run under `bun test` with no OpenCode at all.
 *
 * Shapes follow the 2.0.16 plugin types (verified in the P0 spikes: create/prompt/wait/context/interrupt/get).
 */

export interface HostModelRef {
  providerID: string
  id: string
  variant?: string
}

export interface HostPermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface HostCreateInput {
  title: string
  agent?: string
  model?: HostModelRef
  metadata: Record<string, unknown>
  permissions: HostPermissionRule[]
  location?: { directory: string }
}

export interface HostTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

export interface HostContentPart {
  type: string
  text?: string
  name?: string
  state?: { status?: string; input?: unknown; content?: unknown; error?: { message?: string } }
}

/** One message from `session.context`. Only assistant messages are read closely. */
export interface HostMessage {
  type: string
  content?: HostContentPart[]
  model?: HostModelRef
  tokens?: HostTokens
  cost?: number
  finish?: string
  error?: { type?: string; message?: string }
}

export interface HostSessionInfo {
  id: string
  outcome?: "succeeded" | "failed" | "interrupted"
  cost?: number
  tokens?: HostTokens
  model?: HostModelRef
  metadata?: Record<string, unknown>
  location?: { directory: string }
}

export interface HostSessionApi {
  create(input: HostCreateInput): Promise<HostSessionInfo>
  /** Admits the prompt; the run happens asynchronously. */
  prompt(input: { sessionID: string; text: string }): Promise<unknown>
  /** Resolves once the session has settled (its run finished, failed, or was interrupted). */
  wait(input: { sessionID: string }): Promise<void>
  context(input: { sessionID: string }): Promise<readonly HostMessage[]>
  interrupt(input: { sessionID: string }): Promise<unknown>
  get(input: { sessionID: string }): Promise<HostSessionInfo>
}

/** Git worktrees for `agent({ isolation: "worktree" })` (OpenCode's own worktree service). */
export interface HostWorktreeApi {
  /** Create a worktree of the Run's project; `base` is the commit it starts from. */
  create(name: string): Promise<{ directory: string; branch: string | null; base: string | null }>
  /** Did the Unit change anything (uncommitted files or new commits since `base`)? */
  changed(directory: string, base: string | null): Promise<boolean>
  remove(directory: string): Promise<void>
  /** Is this plugin active in that location (so typed results and policy work there)? */
  pluginActive(directory: string): Promise<boolean>
}

export interface EngineHost {
  worktree?: HostWorktreeApi
  session: HostSessionApi
  /** Transient generation with no session (used only to extract JSON as a last resort). */
  generateText?(input: { model: HostModelRef; prompt: string }): Promise<{ text: string }>
}

/** `provider/model#variant` or `{ providerID, modelID | id, variant? }` → the host's model reference. */
export function toHostModel(model: unknown): HostModelRef | undefined {
  if (!model) return undefined
  if (typeof model === "string") {
    const [path, variant] = model.split("#", 2)
    const slash = path?.indexOf("/") ?? -1
    if (!path || slash <= 0 || slash === path.length - 1) return undefined
    return { providerID: path.slice(0, slash), id: path.slice(slash + 1), ...(variant ? { variant } : {}) }
  }
  if (typeof model === "object") {
    const value = model as { providerID?: unknown; modelID?: unknown; id?: unknown; variant?: unknown }
    const id = typeof value.modelID === "string" ? value.modelID : typeof value.id === "string" ? value.id : undefined
    if (typeof value.providerID !== "string" || !id) return undefined
    return {
      providerID: value.providerID,
      id,
      ...(typeof value.variant === "string" ? { variant: value.variant } : {}),
    }
  }
  return undefined
}

export function formatModel(model: HostModelRef | undefined): string | null {
  if (!model) return null
  return `${model.providerID}/${model.id}${model.variant && model.variant !== "default" ? `#${model.variant}` : ""}`
}

/** The last assistant text in a transcript, with that message's model and error. */
export function finalAssistant(messages: readonly HostMessage[]): {
  text: string | undefined
  model: HostModelRef | undefined
  error: string | undefined
  finish: string | undefined
} {
  let model: HostModelRef | undefined
  let error: string | undefined
  let finish: string | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.type !== "assistant") continue
    model ??= message.model
    if (error === undefined && message.error?.message) error = message.error.message
    finish ??= message.finish
    const text = (message.content ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
    if (text.trim().length > 0) return { text, model: message.model ?? model, error, finish }
  }
  return { text: undefined, model, error, finish }
}

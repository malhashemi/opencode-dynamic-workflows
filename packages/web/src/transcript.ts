/** Display logic for a Unit's session transcript (the view lives in unit.tsx). */
import type { TranscriptMessage, TranscriptPart } from "opencode-dynamic-workflows/protocol"

export type TranscriptTool = NonNullable<TranscriptPart["tool"]>

/** One renderable part, with consecutive empty text parts dropped. */
export type TranscriptItem =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string; summary: string }
  | { kind: "tool"; tool: TranscriptTool; title: string; failed: boolean }
  | { kind: "other"; text: string }

export interface TranscriptView {
  role: TranscriptMessage["role"]
  header: string
  model: string | null
  error: string | null
  items: TranscriptItem[]
}

const ROLE_LABEL: Record<TranscriptMessage["role"], string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
  other: "Other",
}

export function roleLabel(role: TranscriptMessage["role"]): string {
  return ROLE_LABEL[role] ?? role
}

export function toolFailed(tool: TranscriptTool): boolean {
  return tool.status === "error" || Boolean(tool.error)
}

/** The compact row title for a tool call: "name · status". */
export function toolTitle(tool: TranscriptTool): string {
  const name = tool.name.trim() || "tool"
  const status = tool.status.trim()
  return status ? `${name} · ${status}` : name
}

/** A one-line preview of a reasoning block for its collapsed summary. */
export function reasoningSummary(text: string, max = 80): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "")?.trim() ?? ""
  if (!line) return "Reasoning"
  return `Reasoning — ${line.length > max ? `${line.slice(0, max - 1)}…` : line}`
}

export function partItem(part: TranscriptPart): TranscriptItem | null {
  switch (part.kind) {
    case "text":
      return part.text?.trim() ? { kind: "text", text: part.text } : null
    case "reasoning":
      return part.text?.trim() ? { kind: "reasoning", text: part.text, summary: reasoningSummary(part.text) } : null
    case "tool":
      return part.tool ? { kind: "tool", tool: part.tool, title: toolTitle(part.tool), failed: toolFailed(part.tool) } : null
    default:
      return part.text?.trim() ? { kind: "other", text: part.text } : null
  }
}

export function messageView(message: TranscriptMessage): TranscriptView {
  const items: TranscriptItem[] = []
  for (const part of message.parts) {
    const item = partItem(part)
    if (!item) continue
    const last = items[items.length - 1]
    // Streaming leaves text split over several parts; show it as one block.
    if (item.kind === "text" && last?.kind === "text") last.text += item.text
    else items.push(item)
  }
  return {
    role: message.role,
    header: roleLabel(message.role),
    model: message.role === "assistant" ? message.model : null,
    error: message.error,
    items,
  }
}

export interface TranscriptSummary {
  messages: number
  toolCalls: number
  failedTools: number
  errors: number
}

export function summarizeTranscript(messages: readonly TranscriptMessage[]): TranscriptSummary {
  let toolCalls = 0
  let failedTools = 0
  let errors = 0
  for (const message of messages) {
    if (message.error) errors++
    for (const part of message.parts) {
      if (part.kind !== "tool" || !part.tool) continue
      toolCalls++
      if (toolFailed(part.tool)) failedTools++
    }
  }
  return { messages: messages.length, toolCalls, failedTools, errors }
}

export function summaryLine(summary: TranscriptSummary): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`
  const bits = [plural(summary.messages, "message"), plural(summary.toolCalls, "tool call")]
  if (summary.failedTools > 0) bits.push(`${summary.failedTools} failed`)
  if (summary.errors > 0) bits.push(plural(summary.errors, "error"))
  return bits.join(" · ")
}

/** Formatting for dense tables: short, fixed-shape figures that right-align well. */
import type { Usage } from "@malhashemi/opencode-dynamic-workflows/protocol"

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`
  return `${Math.floor(hours / 24)}d ${String(hours % 24).padStart(2, "0")}h`
}

/** Elapsed for a thing that started at `start` and ended at `end` (or is still going at `now`). */
export function elapsed(start: number | null, end: number | null, now: number): string {
  if (start === null) return "—"
  return formatDuration((end ?? now) - start)
}

export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "—"
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (abs < 1_000_000) return `${Math.round(n / 1000)}k`
  if (abs < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return `${Math.round(n / 1_000_000)}M`
}

/** Tokens the model processed or produced: input + output + reasoning (cache reads are listed separately). */
export function totalTokens(usage: Usage): number {
  return usage.tokens.input + usage.tokens.output + usage.tokens.reasoning
}

export function tokenBreakdown(usage: Usage): string {
  const t = usage.tokens
  return `in ${t.input} · out ${t.output} · reasoning ${t.reasoning} · cache read ${t.cacheRead} · cache write ${t.cacheWrite}`
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return "—"
  if (usd === 0) return "$0"
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}

export function relativeTime(time: number, now: number): string {
  const delta = now - time
  if (delta < 0) return "just now"
  if (delta < 5_000) return "just now"
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`
  return new Date(time).toISOString().slice(0, 10)
}

export function clockTime(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`
}

export function shortId(id: string, length = 8): string {
  return id.length > length ? id.slice(0, length) : id
}

/** The last two path segments — enough to tell projects apart in a column. */
export function shortLocation(location: string): string {
  const parts = location.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? location : `…/${parts.slice(-2).join("/")}`
}

/** Pretty JSON for structured values and JSON-looking strings; anything else verbatim. */
export function prettyValue(value: unknown): { text: string; json: boolean } {
  if (value === undefined) return { text: "", json: false }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      try {
        return { text: JSON.stringify(JSON.parse(trimmed), null, 2), json: true }
      } catch {
        return { text: value, json: false }
      }
    }
    return { text: value, json: false }
  }
  try {
    return { text: JSON.stringify(value, null, 2) ?? String(value), json: true }
  } catch {
    return { text: String(value), json: false }
  }
}

export type JsonToken = { kind: "key" | "string" | "number" | "literal" | "punct" | "space"; text: string }

/** Tokenise pretty-printed JSON for highlighting (rendered as text nodes — never as HTML). */
export function tokenizeJson(text: string): JsonToken[] {
  const out: JsonToken[] = []
  const pattern =
    /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}[\],:])|(\s+)|(.)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match[1] !== undefined) {
      out.push({ kind: match[2] ? "key" : "string", text: match[1] })
      if (match[2]) out.push({ kind: "punct", text: match[2] })
    } else if (match[3] !== undefined) out.push({ kind: "number", text: match[3] })
    else if (match[4] !== undefined) out.push({ kind: "literal", text: match[4] })
    else if (match[5] !== undefined) out.push({ kind: "punct", text: match[5] })
    else if (match[6] !== undefined) out.push({ kind: "space", text: match[6] })
    else out.push({ kind: "punct", text: match[7] ?? "" })
  }
  return out
}

export type CodeToken = {
  kind: "comment" | "string" | "number" | "keyword" | "literal" | "type" | "fn" | "plain"
  text: string
}

const TS_KEYWORDS = new Set(
  (
    "as async await break case catch class const continue debugger declare default delete do else enum export " +
    "extends finally for from function if implements import in instanceof interface let new of private protected " +
    "public readonly return satisfies static super switch throw try type typeof var void while with yield"
  ).split(" "),
)
const TS_LITERALS = new Set(["true", "false", "null", "undefined", "this", "NaN", "Infinity"])

/**
 * Tokenise TypeScript for highlighting, one token list per line (rendered as text nodes — never as HTML). A light
 * lexer, not a parser: comments, strings, template literals, numbers, keywords, types and calls. Joining every
 * token of every line with "\n" gives back the source exactly.
 */
export function tokenizeTs(text: string): CodeToken[][] {
  const pattern =
    /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?)|(\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)n?\b)|([A-Za-z_$][\w$]*)(?=(\s*\()?)|([\s\S])/g
  const lines: CodeToken[][] = [[]]
  const push = (kind: CodeToken["kind"], value: string) => {
    const parts = value.split("\n")
    parts.forEach((part, index) => {
      if (index > 0) lines.push([])
      if (!part) return
      const line = lines[lines.length - 1]!
      const last = line[line.length - 1]
      if (last && last.kind === kind) last.text += part
      else line.push({ kind, text: part })
    })
  }
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match[1] !== undefined) push("comment", match[1])
    else if (match[2] !== undefined) push("string", match[2])
    else if (match[3] !== undefined) push("number", match[3])
    else if (match[4] !== undefined) {
      const word = match[4]
      push(
        TS_KEYWORDS.has(word)
          ? "keyword"
          : TS_LITERALS.has(word)
            ? "literal"
            : match[5]
              ? "fn"
              : /^[A-Z]/.test(word)
                ? "type"
                : "plain",
        word,
      )
    } else push("plain", match[6] ?? "")
  }
  return lines
}

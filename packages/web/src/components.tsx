import { createMemo, createSignal, For, Show, splitProps, type JSX } from "solid-js"

import { ApiError } from "./api"
import { useApp } from "./context"
import { prettyValue, tokenizeJson, tokenizeTs, type CodeToken } from "./format"
import { navigate } from "./router"

/** An anchor that routes in-app on a plain click and behaves like a link otherwise (new tab, copy link…). */
export function Link(props: JSX.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const [local, rest] = splitProps(props, ["href", "onClick", "children"])
  return (
    <a
      {...rest}
      href={local.href}
      onClick={(event) => {
        if (typeof local.onClick === "function") (local.onClick as (e: MouseEvent) => void)(event)
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return
        event.preventDefault()
        navigate(local.href)
      }}
    >
      {local.children}
    </a>
  )
}

const STATUS_LABEL: Record<string, string> = {
  queued: "queued",
  running: "running",
  repairing: "repairing",
  succeeded: "succeeded",
  failed: "failed",
  stopped: "stopped",
  replayed: "replayed",
  interrupted: "interrupted",
}

export function StatusBadge(props: { status: string; title?: string }) {
  return (
    <span class="badge" data-status={props.status} title={props.title}>
      <span class="dot" aria-hidden="true" />
      {STATUS_LABEL[props.status] ?? props.status}
    </span>
  )
}

export function Tag(props: { tone?: "attention" | "live" | "muted" | "info"; children: JSX.Element; title?: string }) {
  return (
    <span class="tag" data-tone={props.tone ?? "muted"} title={props.title}>
      {props.children}
    </span>
  )
}

/** Pretty JSON with token colouring (text nodes only), or plain text. */
export function ValueBlock(props: { value: unknown; label?: string; maxHeight?: string }) {
  const pretty = createMemo(() => prettyValue(props.value))
  const tokens = createMemo(() =>
    pretty().json && pretty().text.length < 200_000 ? tokenizeJson(pretty().text) : null,
  )
  return (
    <div class="code-wrap">
      <div class="code-tools">
        <Show when={props.label}>
          <span class="muted small">{props.label}</span>
        </Show>
        <CopyButton text={pretty().text} />
      </div>
      <pre
        class="code"
        tabIndex={0}
        style={props.maxHeight ? { "max-height": props.maxHeight } : undefined}
        aria-label={props.label}
      >
        <Show when={tokens()} fallback={pretty().text}>
          {(list) => (
            <For each={list()}>
              {(token) =>
                token.kind === "space" || token.kind === "punct" ? (
                  token.text
                ) : (
                  <span class={`j-${token.kind}`}>{token.text}</span>
                )
              }
            </For>
          )}
        </Show>
      </pre>
    </div>
  )
}

const TOKEN_CLASS: Record<CodeToken["kind"], string | undefined> = {
  comment: "t-comment",
  string: "j-string",
  number: "j-number",
  keyword: "t-keyword",
  literal: "j-literal",
  type: "t-type",
  fn: "t-fn",
  plain: undefined,
}

function CodeLine(props: { tokens: CodeToken[] }) {
  return (
    <For each={props.tokens}>
      {(token) => {
        const cls = TOKEN_CLASS[token.kind]
        return cls ? <span class={cls}>{token.text}</span> : token.text
      }}
    </For>
  )
}

/** Plain or numbered code; `language: "ts"` colours it (as text nodes, never HTML). */
export function CodeBlock(props: {
  text: string
  label?: string
  maxHeight?: string
  numbered?: boolean
  language?: "ts"
}) {
  const lines = createMemo(() =>
    props.language === "ts" && props.text.length < 200_000
      ? tokenizeTs(props.text)
      : props.text.split("\n").map((line): CodeToken[] => (line ? [{ kind: "plain", text: line }] : [])),
  )
  return (
    <div class="code-wrap">
      <div class="code-tools">
        <Show when={props.label}>
          <span class="muted small">{props.label}</span>
        </Show>
        <CopyButton text={props.text} />
      </div>
      <pre
        class="code"
        tabIndex={0}
        style={props.maxHeight ? { "max-height": props.maxHeight } : undefined}
        aria-label={props.label}
      >
        <Show
          when={props.numbered}
          fallback={
            <Show when={props.language} fallback={props.text}>
              <For each={lines()}>
                {(line, index) => (
                  <>
                    {index() > 0 ? "\n" : ""}
                    <CodeLine tokens={line} />
                  </>
                )}
              </For>
            </Show>
          }
        >
          <For each={lines()}>
            {(line, index) => (
              <span class="code-line">
                <span class="code-ln" aria-hidden="true">
                  {index() + 1}
                </span>
                <CodeLine tokens={line} />
              </span>
            )}
          </For>
        </Show>
      </pre>
    </div>
  )
}

export function CopyButton(props: { text: string; label?: string }) {
  const [done, setDone] = createSignal(false)
  return (
    <button
      type="button"
      class="btn btn-ghost btn-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text)
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        } catch {
          // Clipboard needs a secure context; the text is selectable anyway.
        }
      }}
    >
      {done() ? "Copied" : (props.label ?? "Copy")}
    </button>
  )
}

export type Tone = "default" | "primary" | "danger" | "ghost"

/**
 * A control button: runs an async action, shows it is busy, reports failures, and — when the Gateway wants a
 * token this browser does not have — opens pairing and retries once.
 */
export function ActionButton(props: {
  onAction: () => Promise<unknown>
  children: JSX.Element
  tone?: Tone
  size?: "sm" | "xs"
  disabled?: boolean
  confirm?: string
  title?: string
  done?: string
  class?: string
  "aria-keyshortcuts"?: string
}) {
  const app = useApp()
  const [busy, setBusy] = createSignal(false)
  const run = async () => {
    if (busy()) return
    if (props.confirm && !window.confirm(props.confirm)) return
    setBusy(true)
    try {
      try {
        await props.onAction()
      } catch (error) {
        if (error instanceof ApiError && error.needsPairing && (await app.requestPairing(error.message)))
          await props.onAction()
        else throw error
      }
      if (props.done) app.announce(props.done)
    } catch (error) {
      app.announce(error instanceof Error ? error.message : String(error), "error")
    } finally {
      setBusy(false)
    }
  }
  return (
    <button
      type="button"
      class={`btn btn-${props.tone ?? "default"}${props.size ? ` btn-${props.size}` : ""}${props.class ? ` ${props.class}` : ""}`}
      disabled={props.disabled || busy()}
      aria-busy={busy()}
      title={props.title}
      aria-keyshortcuts={props["aria-keyshortcuts"]}
      onClick={run}
    >
      {props.children}
    </button>
  )
}

export function Stat(props: { label: string; value: JSX.Element; title?: string }) {
  return (
    <div class="stat" title={props.title}>
      <div class="stat-label">{props.label}</div>
      <div class="stat-value">{props.value}</div>
    </div>
  )
}

/** Settled / total, drawn as a thin bar. Never draws a denominator the system does not know. */
export function Meter(props: { value: number; total: number; failed?: number; label: string }) {
  const pct = () => (props.total > 0 ? Math.min(100, (props.value / props.total) * 100) : 0)
  const failedPct = () => (props.total > 0 ? Math.min(100, ((props.failed ?? 0) / props.total) * 100) : 0)
  return (
    <span
      class="meter"
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={props.total}
      aria-valuenow={props.value}
    >
      <span class="meter-fill" style={{ width: `${pct()}%` }} />
      <span class="meter-failed" style={{ width: `${failedPct()}%` }} />
    </span>
  )
}

export function Empty(props: { children: JSX.Element }) {
  return <div class="empty">{props.children}</div>
}

export function ErrorNote(props: { error: unknown; retry?: () => void }) {
  const message = () => (props.error instanceof Error ? props.error.message : String(props.error))
  return (
    <div class="note note-error" role="alert">
      <span>{message()}</span>
      <Show when={props.retry}>
        <button type="button" class="btn btn-xs" onClick={() => props.retry?.()}>
          Retry
        </button>
      </Show>
    </div>
  )
}

/** Arrow keys / j k move focus between rows' primary links in a table body. */
export function rowKeys(event: KeyboardEvent): void {
  const key = event.key
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "j" && key !== "k") return
  const target = event.target as HTMLElement
  if (target.closest("input, textarea, select")) return
  const table = event.currentTarget as HTMLElement
  const links = [...table.querySelectorAll<HTMLElement>("[data-row-link]")]
  if (links.length === 0) return
  const index = links.findIndex((link) => link === document.activeElement || link.contains(document.activeElement))
  const next = key === "ArrowDown" || key === "j" ? Math.min(links.length - 1, index + 1) : Math.max(0, index - 1)
  event.preventDefault()
  links[next]?.focus()
}

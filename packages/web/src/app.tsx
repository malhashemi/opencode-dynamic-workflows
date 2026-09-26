import type { PendingInteraction } from "@malhashemi/opencode-dynamic-workflows/protocol"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { ApiError, createApi, localTokenStorage, type GatewayInfo, type TokenStorage } from "./api"
import { ErrorNote, Link } from "./components"
import { App as AppCtx, type AppContext } from "./context"
import { shortId } from "./format"
import { EventHub, type LocationStatus } from "./hub"
import { LibraryPage } from "./library"
import { currentPath, parseRoute, runPath } from "./router"
import { RunPage } from "./run"

interface Toast {
  id: number
  message: string
  tone: "info" | "attention" | "error"
  href?: string
  /** An interaction this toast is about; it goes away when the interaction resolves. */
  interactionId?: string
}

export function App() {
  const stored = localTokenStorage()
  const [tokenRevision, setTokenRevision] = createSignal(0)
  const tokens: TokenStorage = {
    get: () => stored.get(),
    set(token) {
      stored.set(token)
      setTokenRevision((n) => n + 1)
    },
  }
  const api = createApi({ tokens })
  const [info, setInfo] = createSignal<GatewayInfo | null>(null)
  const [bootError, setBootError] = createSignal<unknown>(null)
  const [needsPairing, setNeedsPairing] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  const [toasts, setToasts] = createSignal<Toast[]>([])
  const [liveText, setLiveText] = createSignal("")
  const [statuses, setStatuses] = createSignal<Map<string, LocationStatus>>(new Map())
  const [pairing, setPairing] = createSignal<{ reason?: string; resolve: (ok: boolean) => void } | null>(null)
  let toastId = 0

  const hub = new EventHub({
    eventsUrl: (location) => api.eventsUrl(location),
    authHeaders: () => api.authHeaders(),
    onUnauthorized: () => {
      // A token the Gateway no longer knows would fail every read; drop it (loopback reads need none).
      if (api.tokens.get()) api.tokens.set(null)
    },
  })

  const announce: AppContext["announce"] = (message, tone = "info") => {
    push({ message, tone })
  }
  const push = (toast: Omit<Toast, "id">) => {
    const id = ++toastId
    setToasts((list) => [...list.slice(-4), { ...toast, id }])
    setLiveText(toast.message)
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), toast.tone === "error" ? 9000 : toast.tone === "attention" ? 12000 : 4000)
  }

  const requestPairing: AppContext["requestPairing"] = (reason) =>
    new Promise<boolean>((resolve) => {
      pairing()?.resolve(false)
      setPairing({ reason, resolve })
    })

  const reloadInfo = async () => {
    const loaded = await api.info()
    setInfo(loaded)
    for (const { location } of loaded.locations) hub.ensure(location)
  }
  // A token was issued or dropped: the header's paired state comes from the Gateway, so ask again.
  createEffect(on(tokenRevision, () => void (info() && reloadInfo().catch(() => {})), { defer: true }))

  const boot = async () => {
    try {
      const loaded = await api.info()
      setInfo(loaded)
      setNeedsPairing(false)
      setBootError(null)
      for (const { location } of loaded.locations) hub.ensure(location)
    } catch (error) {
      if (error instanceof ApiError && error.code === "unauthorized") setNeedsPairing(true)
      else setBootError(error)
    }
  }

  onMount(() => {
    void boot()
    const tick = setInterval(() => setNow(Date.now()), 1000)
    // New locations register with the Gateway as OpenCode opens projects.
    const refreshInfo = setInterval(() => {
      if (info() && !document.hidden) void reloadInfo().catch(() => {})
    }, 30_000)
    const offStatus = hub.onStatus((map) => setStatuses(new Map(map)))
    const offEvents = hub.listen({
      event(event) {
        if (event.type === "interaction.pending") {
          const interaction = event.data as PendingInteraction
          const what = interaction.kind === "permission" ? "a permission decision" : interaction.kind === "approval" ? "approval to run an inline Workflow" : "an answer"
          const message = `A Run needs ${what} (${shortId(event.runId)}).`
          // On that Run's page the panel is right there: announce it, but skip the visual toast.
          if (runId() === event.runId) setLiveText(message)
          else push({ message, tone: "attention", href: runPath(event.runId), interactionId: interaction.interactionId })
        } else if (event.type === "interaction.resolved") {
          const id = (event.data as { interactionId?: string }).interactionId
          setToasts((list) => list.filter((toast) => toast.interactionId !== id))
        }
      },
    })
    onCleanup(() => {
      clearInterval(tick)
      clearInterval(refreshInfo)
      offStatus()
      offEvents()
      hub.close()
    })
  })

  const route = createMemo(() => parseRoute(currentPath().split("?")[0] ?? "/"))
  const runId = createMemo(() => {
    const r = route()
    return r.name === "run" || r.name === "unit" ? r.runId : null
  })
  const unitId = () => {
    const r = route()
    return r.name === "unit" ? r.unitId : undefined
  }

  const connection = createMemo(() => {
    const values = [...statuses().values()]
    if (values.length === 0) return { state: "idle" as const, label: "no streams" }
    if (values.some((status) => status === "unauthorized")) return { state: "error" as const, label: "not authorized" }
    if (values.every((status) => status === "open")) return { state: "ok" as const, label: "live" }
    if (values.some((status) => status === "retrying")) return { state: "warn" as const, label: "reconnecting" }
    return { state: "warn" as const, label: "connecting" }
  })
  // Only complain about a stream that stayed down for a few seconds.
  const [stale, setStale] = createSignal(false)
  let staleTimer: ReturnType<typeof setTimeout> | undefined
  createEffect(
    on(
      () => connection().state === "warn" || connection().state === "error",
      (down) => {
        if (down) {
          if (!staleTimer) staleTimer = setTimeout(() => setStale(true), 3000)
        } else {
          if (staleTimer) clearTimeout(staleTimer)
          staleTimer = undefined
          setStale(false)
        }
      },
    ),
  )

  return (
    <>
      <a class="skip" href="#main">
        Skip to content
      </a>
      <header class="topbar">
        <Link href="/" class="brand">
          <span class="brand-mark" aria-hidden="true" />
          Workflows
        </Link>
        <span class="spacer" />
        <Show when={info()}>
          {(loaded) => (
            <>
              <span class="conn" data-state={connection().state} title={[...statuses().entries()].map(([location, status]) => `${location}: ${status}`).join("\n")}>
                <span class="dot" aria-hidden="true" />
                {connection().label}
              </span>
              <Show
                when={loaded().auth.device}
                fallback={
                  <button type="button" class="btn btn-ghost btn-xs" onClick={() => void requestPairing()}>
                    {loaded().auth.loopback ? "Read-only · pair to control" : "Pair"}
                  </button>
                }
              >
                <span class="muted small" title="This browser holds a Gateway token with control scope">
                  paired{loaded().auth.device ? ` · ${loaded().auth.device!.name}` : ""}
                </span>
              </Show>
              <span class="muted small mono">v{loaded().plugin.version}</span>
            </>
          )}
        </Show>
      </header>

      <Show when={stale()}>
        <div class="banner" role="status">
          Live updates are disconnected; figures may be stale. Reconnecting…
        </div>
      </Show>

      <main id="main" tabIndex={-1}>
        <Switch>
          <Match when={needsPairing()}>
            <div class="page narrow">
              <PairingForm
                intro="This Gateway needs a device token for this browser. Open the Workflows panel in the OpenCode TUI and create a pairing code, then enter it here."
                onPaired={() => void boot()}
                api={api}
              />
            </div>
          </Match>
          <Match when={bootError()}>
            <div class="page narrow">
              <ErrorNote error={bootError()} retry={() => void boot()} />
            </div>
          </Match>
          <Match when={info()}>
            {(loaded) => (
              <AppCtx.Provider value={{ api, hub, info: loaded, now, announce, requestPairing }}>
                <Switch fallback={<NotFound />}>
                  <Match when={route().name === "library"}>
                    <LibraryPage />
                  </Match>
                  <Match when={runId()} keyed>
                    {(id) => <RunPage runId={id} unitId={unitId()} />}
                  </Match>
                </Switch>
              </AppCtx.Provider>
            )}
          </Match>
          <Match when={true}>
            <div class="page">
              <p class="muted">Connecting to the Gateway…</p>
            </div>
          </Match>
        </Switch>
      </main>

      <div class="sr-only" aria-live="polite" aria-atomic="true">
        {liveText()}
      </div>
      <div class="toasts">
        <For each={toasts()}>
          {(toast) => (
            <div class="toast" data-tone={toast.tone} role={toast.tone === "error" ? "alert" : undefined}>
              <span>{toast.message}</span>
              <Show when={toast.href}>
                <Link href={toast.href!} onClick={() => setToasts((list) => list.filter((t) => t.id !== toast.id))}>
                  Open
                </Link>
              </Show>
              <button type="button" class="btn btn-ghost btn-xs" aria-label="Dismiss" onClick={() => setToasts((list) => list.filter((t) => t.id !== toast.id))}>
                ×
              </button>
            </div>
          )}
        </For>
      </div>

      <Show when={pairing()}>
        {(request) => (
          <PairingDialog
            reason={request().reason}
            api={api}
            loopback={info()?.auth.loopback ?? false}
            onClose={(ok) => {
              request().resolve(ok)
              setPairing(null)
              if (ok) void boot()
            }}
          />
        )}
      </Show>
    </>
  )
}

function NotFound() {
  return (
    <div class="page narrow">
      <h1>Not found</h1>
      <p>
        <Link href="/">Back to the library</Link>
      </p>
    </div>
  )
}

function defaultDeviceName(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? ""
  return `browser${platform ? ` on ${platform}` : ""}`
}

function PairingForm(props: { intro?: string; api: ReturnType<typeof createApi>; onPaired: () => void; loopback?: boolean }) {
  const [code, setCode] = createSignal("")
  const [name, setName] = createSignal(defaultDeviceName())
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await props.api.pair(code(), name().trim() || "browser")
      props.onPaired()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  const local = async () => {
    setBusy(true)
    setError(null)
    try {
      await props.api.pairLocal()
      props.onPaired()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form
      class="pairing"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <h1>Pair this browser</h1>
      <Show when={props.intro}>
        <p>{props.intro}</p>
      </Show>
      <label class="field">
        <span class="field-label">Pairing code</span>
        <input
          class="input mono code-input"
          autocomplete="one-time-code"
          autocapitalize="characters"
          spellcheck={false}
          required
          value={code()}
          onInput={(event) => setCode(event.currentTarget.value)}
          ref={(el) => queueMicrotask(() => el.focus())}
        />
      </label>
      <label class="field">
        <span class="field-label">Device name</span>
        <input class="input" value={name()} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <Show when={error()}>
        <p class="err" role="alert">
          {error()}
        </p>
      </Show>
      <div class="controls">
        <button type="submit" class="btn btn-primary" disabled={busy() || !code().trim()}>
          Pair
        </button>
        <Show when={props.loopback}>
          <button type="button" class="btn" disabled={busy()} onClick={() => void local()} title="This browser runs on the Gateway's machine">
            Pair this local browser
          </button>
        </Show>
      </div>
      <p class="muted small">The token is kept in this browser's local storage and sent only in request headers.</p>
    </form>
  )
}

function PairingDialog(props: { reason?: string; api: ReturnType<typeof createApi>; loopback: boolean; onClose: (ok: boolean) => void }) {
  let dialog: HTMLDialogElement | undefined
  onMount(() => dialog?.showModal())
  return (
    <dialog
      ref={dialog}
      class="dialog"
      aria-label="Pair this browser"
      onCancel={(event) => {
        event.preventDefault()
        props.onClose(false)
      }}
    >
      <PairingForm
        intro={props.reason ?? "Control actions need a device token. Get a pairing code from the Workflows panel in the OpenCode TUI."}
        api={props.api}
        loopback={props.loopback}
        onPaired={() => props.onClose(true)}
      />
      <div class="controls">
        <span class="spacer" />
        <button type="button" class="btn btn-ghost btn-sm" onClick={() => props.onClose(false)}>
          Cancel
        </button>
      </div>
    </dialog>
  )
}

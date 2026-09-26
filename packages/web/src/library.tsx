import type { LibraryEntry, WorkflowListing } from "@malhashemi/opencode-dynamic-workflows/protocol"
import { createMemo, createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { ActionButton, Empty, ErrorNote, Link, Meter, rowKeys, StatusBadge, Tag } from "./components"
import { useApp } from "./context"
import { elapsed, formatCost, formatCount, relativeTime, shortId, shortLocation, tokenBreakdown, totalTokens } from "./format"
import { navigate, runPath } from "./router"
import { describeFields, parseArgs, templateFor } from "./schema"
import { filterLibrary, phasePosition, upsertLibraryEntry, type LibraryFilter } from "./state"

const STATUS_FILTERS: { value: LibraryFilter["status"]; label: string }[] = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "waiting", label: "Waiting" },
  { value: "running", label: "Running" },
  { value: "succeeded", label: "Succeeded" },
  { value: "failed", label: "Failed" },
  { value: "stopped", label: "Stopped" },
  { value: "interrupted", label: "Interrupted" },
]

const POLL_MS = 10_000

export function LibraryPage() {
  const app = useApp()
  const [runs, setRuns] = createSignal<LibraryEntry[]>([])
  const [loaded, setLoaded] = createSignal(false)
  const [error, setError] = createSignal<unknown>(null)
  const [filter, setFilter] = createSignal<LibraryFilter>({ status: "all", search: "", location: "all" })
  let search: HTMLInputElement | undefined
  let inflight = false
  let again = false

  const fetchRuns = async () => {
    if (inflight) {
      again = true
      return
    }
    inflight = true
    try {
      setRuns(await app.api.listRuns({ limit: 500 }))
      setError(null)
      setLoaded(true)
    } catch (caught) {
      setError(caught)
    } finally {
      inflight = false
      if (again) {
        again = false
        void fetchRuns()
      }
    }
  }

  // `library.changed` → refetch soon; other Run events → refetch at most every 2 s (progress figures);
  // plus a 10 s fallback poll while the tab is visible.
  let soon: ReturnType<typeof setTimeout> | undefined
  let lastProgress = 0
  const schedule = (delay: number) => {
    if (soon) return
    soon = setTimeout(() => {
      soon = undefined
      void fetchRuns()
    }, delay)
  }
  const unlisten = app.hub.listen({
    event(event) {
      if (event.type === "library.changed") {
        setRuns((current) => upsertLibraryEntry(current, event.data as LibraryEntry))
        schedule(150)
      } else if (event.runId && Date.now() - lastProgress > 2000) {
        lastProgress = Date.now()
        schedule(2000)
      }
    },
    resync() {
      schedule(0)
    },
  })
  const poll = setInterval(() => {
    if (!document.hidden) void fetchRuns()
  }, POLL_MS)
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "/" && !(event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) {
      event.preventDefault()
      search?.focus()
    }
  }
  onMount(() => {
    document.title = "Workflows"
    void fetchRuns()
    window.addEventListener("keydown", onKey)
  })
  onCleanup(() => {
    unlisten()
    clearInterval(poll)
    if (soon) clearTimeout(soon)
    window.removeEventListener("keydown", onKey)
  })

  const locations = () => app.info().locations.map((entry) => entry.location)
  const visible = createMemo(() => filterLibrary(runs(), filter()))
  const waiting = createMemo(() => runs().filter((entry) => entry.waiting))
  const multiLocation = () => locations().length > 1 || new Set(runs().map((entry) => entry.location)).size > 1

  return (
    <div class="page">
      <Show when={waiting().length > 0}>
        <div class="note note-attention" role="status">
          <strong>{waiting().length === 1 ? "A Run is" : `${waiting().length} Runs are`} waiting on you:</strong>{" "}
          <For each={waiting().slice(0, 5)}>
            {(entry, index) => (
              <>
                {index() > 0 ? ", " : ""}
                <Link href={runPath(entry.runId)}>
                  {entry.workflow.name} <span class="mono">{shortId(entry.runId)}</span>
                </Link>
              </>
            )}
          </For>
        </div>
      </Show>

      <section class="panel" aria-labelledby="runs-title">
        <header class="panel-head wrap">
          <h1 id="runs-title">
            Runs <span class="muted num">{visible().length === runs().length ? runs().length : `${visible().length}/${runs().length}`}</span>
          </h1>
          <div class="filters" role="search">
            <label class="sr-only" for="run-search">
              Search Runs
            </label>
            <input
              id="run-search"
              ref={search}
              class="input input-sm"
              type="search"
              placeholder="Search (press /)"
              aria-keyshortcuts="/"
              value={filter().search}
              onInput={(event) => setFilter({ ...filter(), search: event.currentTarget.value })}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setFilter({ ...filter(), search: "" })
                  event.currentTarget.blur()
                }
              }}
            />
            <div class="segmented" role="radiogroup" aria-label="Status filter">
              <For each={STATUS_FILTERS}>
                {(option) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={filter().status === option.value}
                    class="seg"
                    onClick={() => setFilter({ ...filter(), status: option.value })}
                  >
                    {option.label}
                  </button>
                )}
              </For>
            </div>
            <Show when={multiLocation()}>
              <label class="sr-only" for="run-location">
                Location
              </label>
              <select id="run-location" class="input input-sm" value={filter().location} onChange={(event) => setFilter({ ...filter(), location: event.currentTarget.value })}>
                <option value="all">All locations</option>
                <For each={locations()}>{(location) => <option value={location}>{shortLocation(location)}</option>}</For>
              </select>
            </Show>
          </div>
        </header>
        <Show when={error()}>
          <ErrorNote error={error()} retry={() => void fetchRuns()} />
        </Show>
        <Show when={visible().length > 0} fallback={<Empty>{!loaded() ? "Loading Runs…" : runs().length === 0 ? "No Runs yet. Start a Workflow below, or from an OpenCode session." : "No Runs match the filter."}</Empty>}>
          <div class="table-scroll">
            <table class="table" onKeyDown={rowKeys}>
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Status</th>
                  <th>Phase</th>
                  <th>Units</th>
                  <th class="r">Tokens</th>
                  <th class="r">Cost</th>
                  <th class="r">Elapsed</th>
                  <th class="r">Started</th>
                  <Show when={multiLocation()}>
                    <th>Location</th>
                  </Show>
                </tr>
              </thead>
              <tbody>
                <For each={visible()}>
                  {(entry) => (
                    <tr data-status={entry.status} data-waiting={entry.waiting ? "" : undefined}>
                      <td class="wf-cell">
                        <Link href={runPath(entry.runId)} data-row-link>
                          {entry.workflow.name}
                        </Link>{" "}
                        <span class="mono muted small">{shortId(entry.runId)}</span>
                        <Show when={entry.workflow.provenance === "inline"}>
                          <Tag tone="muted">ad-hoc</Tag>
                        </Show>
                      </td>
                      <td class="nowrap">
                        <StatusBadge status={entry.status} />
                        <Show when={entry.live}>
                          <Tag tone="live">live</Tag>
                        </Show>
                        <Show when={entry.waiting}>
                          <Tag tone="attention">waiting</Tag>
                        </Show>
                      </td>
                      <td class="muted truncate">{phasePosition(entry) ?? "—"}</td>
                      <td class="nowrap">
                        <span class="num">
                          {entry.settledUnits}/{entry.units}
                        </span>{" "}
                        <Meter value={entry.settledUnits} total={entry.units} failed={entry.failedUnits} label="Units settled" />
                        <Show when={entry.failedUnits > 0}>
                          <span class="err small"> {entry.failedUnits} failed</span>
                        </Show>
                      </td>
                      <td class="r num" title={tokenBreakdown(entry.usage)}>
                        {formatCount(totalTokens(entry.usage))}
                      </td>
                      <td class="r num">{formatCost(entry.usage.cost)}</td>
                      <td class="r num">{entry.endedAt === null && !entry.live ? "—" : elapsed(entry.startedAt, entry.endedAt, app.now())}</td>
                      <td class="r muted nowrap" title={new Date(entry.startedAt).toLocaleString()}>
                        {relativeTime(entry.startedAt, app.now())}
                      </td>
                      <Show when={multiLocation()}>
                        <td class="mono small muted" title={entry.location}>
                          {shortLocation(entry.location)}
                        </td>
                      </Show>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </Show>
      </section>

      <WorkflowsPanel />
    </div>
  )
}

function WorkflowsPanel() {
  const app = useApp()
  const locations = () => app.info().locations.map((entry) => entry.location)
  return (
    <section class="panel" aria-labelledby="workflows-title">
      <header class="panel-head">
        <h2 id="workflows-title">Durable Workflows</h2>
        <span class="muted small">saved under .opencode/workflows/</span>
      </header>
      <Show when={locations().length > 0} fallback={<p class="muted pad">No location is registered with the Gateway.</p>}>
        <For each={locations()}>{(location) => <LocationWorkflows location={location} showLocation={locations().length > 1} />}</For>
      </Show>
    </section>
  )
}

function LocationWorkflows(props: { location: string; showLocation: boolean }) {
  const app = useApp()
  const [listing, { refetch }] = createResource(() => props.location, (location) => app.api.listWorkflows(location))
  return (
    <div class="location-block">
      <Show when={props.showLocation}>
        <h3 class="location-title mono" title={props.location}>
          {shortLocation(props.location)}
        </h3>
      </Show>
      <Show when={!listing.error} fallback={<ErrorNote error={listing.error} retry={() => void refetch()} />}>
        <Show when={listing()} fallback={<p class="muted pad">Loading…</p>}>
          {(data) => (
            <>
              <Show when={data().workflows.length > 0} fallback={<p class="muted pad">No durable Workflows in this project.</p>}>
                <ul class="workflows">
                  <For each={data().workflows}>{(workflow) => <WorkflowRow location={props.location} workflow={workflow} />}</For>
                </ul>
              </Show>
              <Show when={data().failures.length > 0}>
                <div class="note note-error">
                  <strong>Workflows that failed to load:</strong>
                  <ul class="plain">
                    <For each={data().failures}>
                      {(failure) => (
                        <li>
                          <span class="mono">{failure.path}</span> — {failure.error}
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
              <Show when={data().collisions.length > 0}>
                <div class="note small">
                  <For each={data().collisions}>
                    {(collision) => (
                      <div>
                        <span class="mono">{collision.key}</span>: using <span class="mono">{collision.kept}</span>, shadowing <span class="mono">{collision.shadowed}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}

function WorkflowRow(props: { location: string; workflow: WorkflowListing }) {
  const app = useApp()
  const w = () => props.workflow
  const template = () => {
    if (!w().args) return ""
    return JSON.stringify(templateFor(w().args), null, 2)
  }
  const [text, setText] = createSignal(template())
  const parsed = createMemo(() => parseArgs(text(), w().args))
  const fields = createMemo(() => describeFields(w().args))
  const id = () => `wf-${w().key.replace(/[^a-zA-Z0-9_-]/g, "_")}-${props.location.length}`

  return (
    <li class="workflow">
      <details>
        <summary>
          <span class="wf-name">{w().name}</span>
          <Show when={w().key !== w().name}>
            <span class="mono muted small">{w().key}</span>
          </Show>
          <span class="muted truncate wf-desc">{w().description}</span>
          <Show when={w().phases.length > 0}>
            <span class="muted small nowrap">{w().phases.length} phases</span>
          </Show>
          <span class="btn btn-xs" aria-hidden="true">
            Start…
          </span>
        </summary>
        <div class="wf-body">
          <Show when={w().whenToUse}>
            <p>
              <span class="muted">When to use:</span> {w().whenToUse}
            </p>
          </Show>
          <Show when={w().phases.length > 0}>
            <ol class="wf-phases">
              <For each={w().phases}>
                {(phase) => (
                  <li>
                    <strong>{phase.title}</strong>
                    <Show when={phase.detail}>
                      <span class="muted"> — {phase.detail}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ol>
          </Show>
          <p class="small muted mono">{w().path}</p>
          <form
            class="start-form"
            onSubmit={(event) => {
              event.preventDefault()
            }}
          >
            <Show when={fields().length > 0}>
              <table class="table fields">
                <caption class="sr-only">Arguments</caption>
                <thead>
                  <tr>
                    <th>Argument</th>
                    <th>Type</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={fields()}>
                    {(field) => (
                      <tr>
                        <td class="mono">
                          {field.name}
                          {field.required ? "" : "?"}
                        </td>
                        <td class="mono small">{field.type}</td>
                        <td class="small">{field.description ?? ""}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
            <label class="field" for={`${id()}-args`}>
              <span class="field-label">Args (JSON){w().args ? "" : " — this Workflow declares none"}</span>
              <textarea
                id={`${id()}-args`}
                class="mono"
                rows={Math.min(12, Math.max(3, text().split("\n").length))}
                spellcheck={false}
                value={text()}
                aria-invalid={!parsed().ok}
                aria-describedby={`${id()}-errors`}
                onInput={(event) => setText(event.currentTarget.value)}
              />
            </label>
            <div id={`${id()}-errors`} class="field-errors" aria-live="polite">
              <Show when={!parsed().ok}>
                <ul class="plain err small">
                  <For each={(parsed() as { errors: string[] }).errors}>{(message) => <li>{message}</li>}</For>
                </ul>
              </Show>
            </div>
            <div class="controls">
              <ActionButton
                tone="primary"
                disabled={!parsed().ok}
                onAction={async () => {
                  const result = parsed()
                  if (!result.ok) return
                  const { runId } = await app.api.startRun(props.location, { name: w().key, ...(result.value !== undefined ? { args: result.value } : {}) })
                  navigate(runPath(runId))
                }}
              >
                Start Run
              </ActionButton>
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => setText(template())}>
                Reset args
              </button>
            </div>
          </form>
        </div>
      </details>
    </li>
  )
}

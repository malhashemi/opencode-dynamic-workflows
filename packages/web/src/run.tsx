import type { ActivityEntry, Run } from "opencode-dynamic-workflows/protocol"
import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js"
import { ActionButton, CopyButton, Empty, ErrorNote, Link, Meter, rowKeys, Stat, StatusBadge, Tag, ValueBlock } from "./components"
import { useApp } from "./context"
import { clockTime, elapsed, formatCost, formatCount, shortId, shortLocation, tokenBreakdown, totalTokens } from "./format"
import { InteractionsPanel } from "./interactions"
import { createRunData, type RunData } from "./run-data"
import { navigate, runPath, unitPath } from "./router"
import { phasePosition, phaseRows, unitCounts } from "./state"
import { UnitControls, UnitDetail } from "./unit"

export function RunPage(props: { runId: string; unitId?: string }) {
  const app = useApp()
  const data = createRunData(app, () => props.runId)
  const run = () => data.view().run

  createEffect(() => {
    const current = run()
    document.title = current ? `${current.workflow.name} · ${current.status} — Workflows` : "Run — Workflows"
  })

  return (
    <Show
      when={run()}
      fallback={
        <div class="page">
          <Breadcrumb runId={props.runId} />
          <Show when={data.error()} fallback={<Empty>Loading Run…</Empty>}>
            <ErrorNote error={data.error()} retry={() => void data.refresh()} />
          </Show>
        </div>
      }
    >
      {(current) => (
        <div class="page">
          <Breadcrumb runId={props.runId} run={current()} unitId={props.unitId} />
          <Show when={data.error()}>
            <ErrorNote error={data.error()} retry={() => void data.refresh()} />
          </Show>
          <Show when={data.view().sync === "syncing"}>
            <div class="note" role="status">Re-reading the Run after missed events…</div>
          </Show>
          <Show when={props.unitId} fallback={<RunBody run={current()} data={data} />}>
            {(unitId) => <UnitDetail run={current()} unitId={unitId()} data={data} />}
          </Show>
        </div>
      )}
    </Show>
  )
}

function Breadcrumb(props: { runId: string; run?: Run; unitId?: string }) {
  const unit = () => props.run?.units.find((candidate) => candidate.unitId === props.unitId)
  return (
    <nav class="crumbs" aria-label="Breadcrumb">
      <Link href="/">Library</Link>
      <span aria-hidden="true">/</span>
      <Show when={props.unitId} fallback={<span aria-current="page">{props.run?.workflow.name ?? "Run"} <span class="mono muted">{shortId(props.runId)}</span></span>}>
        <Link href={runPath(props.runId)}>
          {props.run?.workflow.name ?? "Run"} <span class="mono muted">{shortId(props.runId)}</span>
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{unit() ? (unit()!.label ?? `${unit()!.subagent} #${unit()!.ordinal}`) : props.unitId}</span>
      </Show>
    </nav>
  )
}

function RunBody(props: { run: Run; data: RunData }) {
  const [phaseFilter, setPhaseFilter] = createSignal<string | null>(null)
  return (
    <>
      <RunHeader run={props.run} live={props.data.view().live} />
      <InteractionsPanel run={props.run} />
      <Phases run={props.run} selected={phaseFilter()} onSelect={(phase) => setPhaseFilter((current) => (current === phase ? null : phase))} />
      <UnitsTable run={props.run} phase={phaseFilter()} />
      <div class="grid-2">
        <ResultPanel run={props.run} />
        <ActivityPanel run={props.run} activity={props.data.view().activity} />
      </div>
      <Show when={props.run.errors.length > 0}>
        <ErrorsPanel run={props.run} />
      </Show>
    </>
  )
}

function RunHeader(props: { run: Run; live: boolean }) {
  const app = useApp()
  const counts = createMemo(() => unitCounts(props.run.units))
  const r = () => props.run
  const terminal = () => r().status !== "running" && r().status !== "queued"
  const [rerunFailed, setRerunFailed] = createSignal(true)
  const [saveName, setSaveName] = createSignal("")
  const link = () => `${window.location.origin}${runPath(r().runId)}`

  return (
    <header class="run-header panel">
      <div class="run-title">
        <h1>{r().workflow.name}</h1>
        <StatusBadge status={r().status} />
        <Show when={props.live}>
          <Tag tone="live">live</Tag>
        </Show>
        <Show when={r().waiting}>
          <Tag tone="attention">waiting on you</Tag>
        </Show>
        <Tag tone="muted" title={r().workflow.provenance === "durable" ? "A saved Workflow" : "An Ad-hoc Workflow, authored inline"}>
          {r().workflow.provenance === "durable" ? `durable · ${r().workflow.key ?? r().workflow.name}` : "ad-hoc"}
        </Tag>
        <Show when={r().background}>
          <Tag tone="muted">background</Tag>
        </Show>
      </div>
      <Show when={r().workflow.description}>
        <p class="muted run-desc">{r().workflow.description}</p>
      </Show>
      <div class="stats">
        <Stat label="Phase" value={phasePosition(r()) ?? "—"} title={r().currentPhase ?? undefined} />
        <Stat
          label="Units"
          value={
            <span class="units-stat">
              <span class="num">
                {counts().settled}/{counts().total}
              </span>
              <Meter value={counts().settled} total={counts().total} failed={counts().failed + counts().stopped} label="Units settled" />
              <Show when={counts().running + counts().repairing > 0}>
                <span class="muted small">{counts().running + counts().repairing} active</span>
              </Show>
              <Show when={counts().failed > 0}>
                <span class="err small">{counts().failed} failed</span>
              </Show>
            </span>
          }
        />
        <Stat label="Elapsed" value={<span class="num">{elapsed(r().startedAt, r().endedAt, app.now())}</span>} title={`Started ${new Date(r().startedAt).toLocaleString()}`} />
        <Stat label="Tokens" value={<span class="num">{formatCount(totalTokens(r().usage))}</span>} title={tokenBreakdown(r().usage)} />
        <Stat label="Cost" value={<span class="num">{formatCost(r().usage.cost)}</span>} />
        <Show when={r().budget.total !== null}>
          <Stat
            label={r().budget.hard ? "Budget (hard)" : "Budget"}
            value={
              <span class="num">
                {formatCount(r().tokensSpent)}/{formatCount(r().budget.total ?? 0)}
              </span>
            }
            title="Output tokens counted against the budget"
          />
        </Show>
        <Stat label="Location" value={<span class="mono" title={r().location}>{shortLocation(r().location)}</span>} />
        <Stat label="Run" value={<span class="mono" title={r().runId}>{shortId(r().runId)}</span>} />
      </div>
      <div class="controls" role="toolbar" aria-label="Run controls">
        <Show when={!terminal()}>
          <ActionButton tone="danger" confirm="Stop this Run? Running Units are interrupted." onAction={() => app.api.stopRun(r().runId)} done="Stop requested">
            Stop Run
          </ActionButton>
        </Show>
        <Show when={terminal()}>
          <span class="control-group">
            <ActionButton
              tone="primary"
              onAction={async () => {
                const { runId } = await app.api.resumeRun(r().runId, rerunFailed())
                navigate(runPath(runId))
              }}
              title="Start a new Run that replays what this one finished and runs the rest live"
            >
              Resume
            </ActionButton>
            <label class="check small">
              <input type="checkbox" checked={rerunFailed()} onChange={(event) => setRerunFailed(event.currentTarget.checked)} />
              re-run failed Units
            </label>
          </span>
          <span class="control-group">
            <label class="sr-only" for="save-name">
              Save as durable Workflow named
            </label>
            <input
              id="save-name"
              class="input input-sm"
              placeholder={r().workflow.provenance === "durable" ? "new name (required)" : r().workflow.name}
              value={saveName()}
              onInput={(event) => setSaveName(event.currentTarget.value)}
            />
            <ActionButton
              disabled={r().workflow.provenance === "durable" && !saveName().trim()}
              onAction={async () => {
                const saved = await app.api.saveRun(r().runId, saveName().trim() || undefined)
                app.announce(`Saved as ${saved.key} (${saved.path})`)
              }}
              title="Save this Run's script as a durable Workflow in the project"
            >
              Save
            </ActionButton>
          </span>
          <Show when={r().cleanup !== "done"}>
            <ActionButton
              confirm="Mark this Run's Unit sessions for cleanup?"
              onAction={async () => {
                const result = await app.api.cleanupRun(r().runId)
                app.announce(result.pending > 0 ? `${result.pending} Unit sessions marked for cleanup (the TUI deletes them).` : "Nothing left to clean up.")
              }}
              title="Apply retention to this Run's Unit sessions"
            >
              Clean up
            </ActionButton>
          </Show>
          <Show when={r().cleanup !== "none"}>
            <Tag tone="muted">cleanup {r().cleanup}</Tag>
          </Show>
        </Show>
        <span class="spacer" />
        <Show when={r().resumeOf}>
          {(of) => (
            <span class="small muted">
              resumes <Link href={runPath(of())} class="mono">{shortId(of())}</Link>
            </span>
          )}
        </Show>
        <CopyButton text={link()} label="Copy link" />
      </div>
    </header>
  )
}

function Phases(props: { run: Run; selected: string | null; onSelect: (phase: string) => void }) {
  const rows = createMemo(() => phaseRows(props.run))
  return (
    <Show when={props.run.phases.length > 0}>
      <section class="panel" aria-labelledby="phases-title">
        <header class="panel-head">
          <h2 id="phases-title">Phases</h2>
          <Show when={!props.run.phasesDeclared}>
            <span class="muted small">as reached (not declared up front)</span>
          </Show>
          <Show when={props.selected}>
            <button type="button" class="btn btn-ghost btn-xs" onClick={() => props.onSelect(props.selected!)}>
              Show all Units
            </button>
          </Show>
        </header>
        <ol class="phases">
          <For each={rows().phases}>
            {(phase, index) => {
              const counts = () => unitCounts(phase.units)
              return (
                <li class="phase" data-state={phase.state} data-selected={props.selected === phase.name ? "" : undefined}>
                  <button type="button" class="phase-btn" aria-pressed={props.selected === phase.name} onClick={() => props.onSelect(phase.name)} title="Show only this phase's Units">
                    <span class="phase-index num">{index() + 1}</span>
                    <span class="phase-name">{phase.name}</span>
                    <span class="phase-units num muted">
                      <Show when={counts().total > 0}>
                        {counts().settled}/{counts().total}
                        <Show when={counts().failed > 0}>
                          <span class="err"> · {counts().failed} failed</span>
                        </Show>
                      </Show>
                    </span>
                  </button>
                </li>
              )
            }}
          </For>
        </ol>
      </section>
    </Show>
  )
}

function UnitsTable(props: { run: Run; phase: string | null }) {
  const app = useApp()
  const units = createMemo(() => (props.phase ? props.run.units.filter((unit) => unit.phase === props.phase) : props.run.units))
  return (
    <section class="panel" aria-labelledby="units-title">
      <header class="panel-head">
        <h2 id="units-title">
          Units <span class="muted num">{units().length}</span>
        </h2>
        <Show when={props.phase}>
          <Tag tone="info">phase: {props.phase}</Tag>
        </Show>
      </header>
      <Show when={units().length > 0} fallback={<p class="muted pad">No Units yet.</p>}>
        <div class="table-scroll">
          <table class="table" onKeyDown={rowKeys}>
            <thead>
              <tr>
                <th class="r">#</th>
                <th>Unit</th>
                <th>Phase</th>
                <th>Status</th>
                <th>Model</th>
                <th>Result path</th>
                <th class="r">Attempts</th>
                <th class="r">Tokens</th>
                <th class="r">Cost</th>
                <th class="r">Time</th>
                <th>Session</th>
                <th>
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={units()}>
                {(unit) => (
                  <tr data-status={unit.status}>
                    <td class="r num muted">{unit.ordinal}</td>
                    <td class="unit-cell">
                      <Link href={unitPath(props.run.runId, unit.unitId)} data-row-link>
                        {unit.label ?? unit.subagent}
                      </Link>
                      <span class="muted small"> {unit.label ? unit.subagent : ""}</span>
                      <Show when={unit.schema}>
                        <Tag tone="muted" title="Asked for a typed result">typed</Tag>
                      </Show>
                    </td>
                    <td class="muted">{unit.phase ?? "—"}</td>
                    <td>
                      <StatusBadge status={unit.status} title={unit.error} />
                    </td>
                    <td class="mono small truncate" title={unit.model.requested && unit.model.requested !== unit.model.resolved ? `requested ${unit.model.requested}` : undefined}>
                      {unit.model.resolved ?? unit.model.requested ?? "—"}
                    </td>
                    <td class="mono small">{unit.resultPath ?? "—"}</td>
                    <td class="r num">{unit.attempts.length || "—"}</td>
                    <td class="r num" title={tokenBreakdown(unit.usage)}>
                      {formatCount(totalTokens(unit.usage))}
                    </td>
                    <td class="r num">{formatCost(unit.usage.cost)}</td>
                    <td class="r num">{elapsed(unit.startedAt, unit.endedAt, app.now())}</td>
                    <td class="mono small">
                      <Show when={unit.sessionID} fallback={<span class="muted">—</span>}>
                        <span>{unit.sessionID}</span>
                      </Show>
                    </td>
                    <td class="r nowrap">
                      <UnitControls run={props.run} unit={unit} compact />
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
    </section>
  )
}

function ResultPanel(props: { run: Run }) {
  const app = useApp()
  const terminal = () => props.run.status !== "running" && props.run.status !== "queued"
  const [result, { refetch }] = createResource(
    () => (terminal() ? props.run.runId : null),
    (runId) => app.api.getResult(runId),
  )
  createEffect(on(() => props.run.status, (status, previous) => {
    if (previous !== undefined && status !== previous && terminal()) void refetch()
  }))
  return (
    <section class="panel" aria-labelledby="result-title">
      <header class="panel-head">
        <h2 id="result-title">Result</h2>
      </header>
      <div class="pad">
        <Show
          when={terminal()}
          fallback={
            <Show when={props.run.resultPreview} fallback={<p class="muted">The Run has not finished.</p>}>
              <ValueBlock value={props.run.resultPreview} label="Preview" />
            </Show>
          }
        >
          <Show when={!result.error} fallback={<ErrorNote error={result.error} retry={() => void refetch()} />}>
            <Show when={!result.loading} fallback={<p class="muted">Loading…</p>}>
              <Show when={result()?.result !== null && result()?.result !== undefined} fallback={<p class="muted">No result{props.run.status === "succeeded" ? "." : ` (the Run ${props.run.status}).`}</p>}>
                <ValueBlock value={result()?.result} maxHeight="32rem" />
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  )
}

function ActivityPanel(props: { run: Run; activity: ActivityEntry[] }) {
  const [filter, setFilter] = createSignal("")
  let list: HTMLOListElement | undefined
  const unitLabel = (unitId: string | null) => {
    if (!unitId) return null
    const unit = props.run.units.find((candidate) => candidate.unitId === unitId)
    return unit ? (unit.label ?? `${unit.subagent} #${unit.ordinal}`) : shortId(unitId)
  }
  const entries = createMemo(() => {
    const needle = filter().trim().toLowerCase()
    if (!needle) return props.activity
    return props.activity.filter((entry) => entry.message.toLowerCase().includes(needle) || (unitLabel(entry.unitId) ?? "").toLowerCase().includes(needle))
  })
  let stick = true
  createEffect(on(() => entries().length, () => {
    if (list && stick) queueMicrotask(() => list && (list.scrollTop = list.scrollHeight))
  }))
  return (
    <section class="panel" aria-labelledby="activity-title">
      <header class="panel-head">
        <h2 id="activity-title">
          Activity <span class="muted num">{props.activity.length}</span>
        </h2>
        <label class="sr-only" for="activity-filter">
          Filter activity
        </label>
        <input id="activity-filter" class="input input-sm" type="search" placeholder="Filter" value={filter()} onInput={(event) => setFilter(event.currentTarget.value)} />
      </header>
      <Show when={entries().length > 0} fallback={<p class="muted pad">No activity{filter() ? " matches" : " yet"}.</p>}>
        <ol
          class="activity"
          ref={list}
          tabIndex={0}
          aria-label="Activity feed"
          onScroll={(event) => {
            const el = event.currentTarget
            stick = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          <For each={entries()}>
            {(entry) => (
              <li class="activity-row" data-kind={entry.kind}>
                <span class="mono muted">{clockTime(entry.time)}</span>
                <span class="activity-kind">{entry.kind}</span>
                <span class="activity-msg">
                  <Show when={entry.unitId}>
                    <Link href={unitPath(props.run.runId, entry.unitId!)} class="activity-unit">
                      {unitLabel(entry.unitId)}
                    </Link>{" "}
                  </Show>
                  {entry.message}
                </span>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  )
}

function ErrorsPanel(props: { run: Run }) {
  return (
    <section class="panel" aria-labelledby="errors-title">
      <header class="panel-head">
        <h2 id="errors-title">
          Errors <span class="err num">{props.run.errors.length}</span>
        </h2>
      </header>
      <ul class="errors">
        <For each={props.run.errors}>
          {(error) => (
            <li class="error-row">
              <div>
                <strong>{error.unit}</strong> <span class="muted small">{error.subagent}</span>
              </div>
              <pre class="code code-inline err-text">{error.error}</pre>
              <details>
                <summary class="small muted">Prompt</summary>
                <pre class="code">{error.prompt}</pre>
              </details>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}

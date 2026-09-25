import type { Run, Unit } from "opencode-dynamic-workflows/protocol"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { ActionButton, CodeBlock, CopyButton, Empty, Link, Stat, StatusBadge, Tag, ValueBlock } from "./components"
import { useApp } from "./context"
import { clockTime, elapsed, formatCost, formatCount, tokenBreakdown, totalTokens } from "./format"
import type { RunData } from "./run-data"
import { navigate, unitPath } from "./router"

export function UnitDetail(props: { run: Run; unitId: string; data: RunData }) {
  const app = useApp()
  const unit = createMemo(() => props.run.units.find((candidate) => candidate.unitId === props.unitId))
  const [loading, setLoading] = createSignal(false)

  // An elided output is one request away; fetch it again whenever the Unit's state moves on.
  createEffect(
    on(
      () => [unit()?.unitId, unit()?.status, unit()?.outputElided, unit()?.output === undefined] as const,
      ([id, , elided, missing]) => {
        if (!id || !elided || !missing || loading()) return
        setLoading(true)
        void props.data.loadFullUnit(id).finally(() => setLoading(false))
      },
    ),
  )

  const siblings = createMemo(() => {
    const units = props.run.units
    const index = units.findIndex((candidate) => candidate.unitId === props.unitId)
    return { previous: index > 0 ? units[index - 1] : undefined, next: index >= 0 ? units[index + 1] : undefined }
  })

  const onKey = (event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey || (event.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return
    const target = event.key === "[" ? siblings().previous : event.key === "]" ? siblings().next : undefined
    if (!target) return
    event.preventDefault()
    navigate(unitPath(props.run.runId, target.unitId))
  }
  onMount(() => window.addEventListener("keydown", onKey))
  onCleanup(() => window.removeEventListener("keydown", onKey))

  const interactions = createMemo(() => props.run.interactions.filter((interaction) => interaction.unitId === props.unitId))
  const activity = createMemo(() => props.data.view().activity.filter((entry) => entry.unitId === props.unitId))

  return (
    <Show when={unit()} fallback={<Empty>This Run has no Unit “{props.unitId}”.</Empty>}>
      {(u) => (
        <>
          <header class="panel run-header">
            <div class="run-title">
              <h1>{u().label ?? `${u().subagent} #${u().ordinal}`}</h1>
              <StatusBadge status={u().status} />
              <Show when={u().schema}>
                <Tag tone="muted" title="Asked for a typed result">typed</Tag>
              </Show>
              <span class="spacer" />
              <nav class="control-group" aria-label="Other Units">
                <Show when={siblings().previous}>
                  {(previous) => (
                    <Link class="btn btn-ghost btn-sm" href={unitPath(props.run.runId, previous().unitId)} aria-keyshortcuts="[">
                      ← {previous().label ?? `#${previous().ordinal}`}
                    </Link>
                  )}
                </Show>
                <Show when={siblings().next}>
                  {(next) => (
                    <Link class="btn btn-ghost btn-sm" href={unitPath(props.run.runId, next().unitId)} aria-keyshortcuts="]">
                      {next().label ?? `#${next().ordinal}`} →
                    </Link>
                  )}
                </Show>
              </nav>
            </div>
            <div class="stats">
              <Stat label="Subagent" value={u().subagent} />
              <Stat label="Phase" value={u().phase ?? "—"} />
              <Stat
                label="Model"
                value={
                  <span class="mono">
                    {u().model.resolved ?? "—"}
                    <Show when={u().model.requested && u().model.requested !== u().model.resolved}>
                      <span class="muted small"> (asked {u().model.requested})</span>
                    </Show>
                  </span>
                }
              />
              <Stat label="Result path" value={<span class="mono">{u().resultPath ?? "—"}</span>} />
              <Stat label="Elapsed" value={<span class="num">{elapsed(u().startedAt, u().endedAt, app.now())}</span>} />
              <Stat label="Tokens" value={<span class="num">{formatCount(totalTokens(u().usage))}</span>} title={tokenBreakdown(u().usage)} />
              <Stat label="Cost" value={<span class="num">{formatCost(u().usage.cost)}</span>} />
              <Stat label="Unit #" value={<span class="num">{u().ordinal}</span>} />
            </div>
            <div class="controls">
              <UnitControls run={props.run} unit={u()} />
              <span class="spacer" />
              <Show when={u().sessionID}>
                <span class="small muted">
                  Unit session <span class="mono">{u().sessionID}</span>
                </span>
                <CopyButton text={u().sessionID!} label="Copy session id" />
              </Show>
            </div>
            <Show when={u().location && u().location !== props.run.location}>
              <p class="small muted">
                Runs in <span class="mono">{u().location}</span>
              </p>
            </Show>
          </header>

          <Show when={interactions().length > 0}>
            <div class="note note-attention" role="status">
              This Unit is waiting on {interactions().length === 1 ? "an interaction" : `${interactions().length} interactions`} —{" "}
              <Link href={`/runs/${encodeURIComponent(props.run.runId)}`}>answer on the Run page</Link>.
            </div>
          </Show>

          <Show when={u().error}>
            <section class="panel" aria-labelledby="unit-error">
              <header class="panel-head">
                <h2 id="unit-error" class="err">Error</h2>
              </header>
              <div class="pad">
                <pre class="code err-text">{u().error}</pre>
              </div>
            </section>
          </Show>

          <div class="grid-2">
            <section class="panel" aria-labelledby="unit-output">
              <header class="panel-head">
                <h2 id="unit-output">Output</h2>
                <Show when={u().outputElided}>
                  <span class="muted small">{loading() ? "loading full output…" : "large output"}</span>
                </Show>
              </header>
              <div class="pad">
                <Show
                  when={u().output !== undefined}
                  fallback={<p class="muted">{u().outputElided ? "Loading…" : u().status === "running" || u().status === "queued" || u().status === "repairing" ? "No output yet." : "No output."}</p>}
                >
                  <ValueBlock value={u().output} maxHeight="40rem" />
                </Show>
              </div>
            </section>
            <section class="panel" aria-labelledby="unit-prompt">
              <header class="panel-head">
                <h2 id="unit-prompt">Prompt</h2>
              </header>
              <div class="pad">
                <CodeBlock text={u().prompt} maxHeight="40rem" />
              </div>
            </section>
          </div>

          <section class="panel" aria-labelledby="unit-attempts">
            <header class="panel-head">
              <h2 id="unit-attempts">
                Attempts <span class="muted num">{u().attempts.length}</span>
              </h2>
              <span class="muted small">turns in the Unit session, including repairs of an invalid typed result</span>
            </header>
            <Show when={u().attempts.length > 0} fallback={<p class="muted pad">No attempts recorded yet.</p>}>
              <table class="table">
                <thead>
                  <tr>
                    <th class="r">Turn</th>
                    <th>Path</th>
                    <th>Outcome</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={u().attempts}>
                    {(attempt) => (
                      <tr>
                        <td class="r num">{attempt.turn}</td>
                        <td class="mono small">{attempt.path}</td>
                        <td>
                          <StatusBadge status={attempt.ok ? "succeeded" : "failed"} />
                        </td>
                        <td class="small">{attempt.error ?? ""}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>
          </section>

          <Show when={activity().length > 0}>
            <section class="panel" aria-labelledby="unit-activity">
              <header class="panel-head">
                <h2 id="unit-activity">Activity</h2>
              </header>
              <ol class="activity">
                <For each={activity()}>
                  {(entry) => (
                    <li class="activity-row" data-kind={entry.kind}>
                      <span class="mono muted">{clockTime(entry.time)}</span>
                      <span class="activity-kind">{entry.kind}</span>
                      <span class="activity-msg">{entry.message}</span>
                    </li>
                  )}
                </For>
              </ol>
            </section>
          </Show>
        </>
      )}
    </Show>
  )
}

export function UnitControls(props: { run: Run; unit: Unit; compact?: boolean }) {
  const app = useApp()
  const active = () => props.unit.status === "running" || props.unit.status === "repairing"
  return (
    <Show when={active()}>
      <span class="control-group">
        <ActionButton
          size={props.compact ? "xs" : undefined}
          onAction={() => app.api.restartUnit(props.run.runId, props.unit.unitId)}
          title="Interrupt and run this Unit again in its session"
          done="Restart requested"
        >
          Restart
        </ActionButton>
        <ActionButton
          size={props.compact ? "xs" : undefined}
          tone="danger"
          onAction={() => app.api.stopUnit(props.run.runId, props.unit.unitId)}
          title="Stop this Unit; the Workflow sees it as failed"
          done="Stop requested"
        >
          Stop
        </ActionButton>
      </span>
    </Show>
  )
}

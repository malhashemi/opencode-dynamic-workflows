/**
 * The right pane: one run, live — phase progress, unit rows expanding in place, tokens, questions (pending
 * cards pinned on top, answered ones kept as records), and the log stream.
 *
 * The honesty rules are the TUI's, in a native medium:
 * - an undeclared-phase run gets a position with NO denominator and NO bar (a bar implies a total the system
 *   does not have);
 * - a successful run drops its phase position, a failed one keeps it — where it stopped is the first question;
 * - a unit whose answer was elided from `/state` says where the answer went and fetches it on demand, because
 *   "produced nothing" and "the answer lives on disk" are different facts.
 *
 * Answer cards are keyed by requestID STRINGS, not by interaction objects: every store event clones the run,
 * so keying on object identity would recreate the card — and throw away a half-composed answer — each time an
 * unrelated log line lands.
 */
import { createEffect, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js"
import {
  formatClock,
  formatDay,
  formatElapsed,
  formatTokens,
  phasePosition,
  phaseProgress,
  settledUnits,
  type ControlResult,
  type PendingInteraction,
  type ResolvedInteraction,
  type RunOrigin,
  type RunSnapshot,
  type UnitSnapshot,
} from "./engine"
import type { createControls } from "./controls"
import { Code } from "./highlight"
import type { RecordResult } from "./state"
import { AnswerCard } from "./interactions"

const UNIT_DOT: Record<UnitSnapshot["status"], string> = {
  queued: "queued",
  running: "running",
  ok: "done",
  failed: "failed",
}

/** `from #3 refine-citations` — resolved against the run, which is the only party that knows its units. */
function asker(interaction: PendingInteraction | ResolvedInteraction, run: RunSnapshot): string {
  if (interaction.unitId) {
    const unit = run.units.find((candidate) => candidate.unitId === interaction.unitId)
    if (unit) return `from #${unit.ordinal} ${unit.label ?? unit.subagent}`
  }
  return interaction.origin === "script" ? "from the run" : "from the run root"
}

function answerText(interaction: ResolvedInteraction): string {
  if (interaction.answers.length > 0) {
    return interaction.answers.map((row) => row.join(", ")).join(" · ")
  }
  return interaction.outcome === "rejected" ? "rejected" : "answer not recorded"
}

/** The journal read backing elided unit answers, cached per run and reset when the pane moves on. */
type RecordCache =
  | { runId: string; state: "reading" }
  | { runId: string; state: "failed"; reason: "not-found" | "unreachable" }
  | { runId: string; state: "ok"; outputs: Map<string, string> }

export function RunDetail(props: {
  run: Accessor<RunSnapshot | undefined>
  controls: ReturnType<typeof createControls>
  readRecord: (runId: string) => Promise<RecordResult>
}): JSX.Element {
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [record, setRecord] = createSignal<RecordCache | null>(null)
  // A control's outcome is not always a failure: `save.run` answers with a DETAIL either way (`saved as …`,
  // `already a durable workflow`), and the honest rendering carries the tone with the words.
  const [notice, setNotice] = createSignal<{ text: string; error: boolean } | null>(null)

  // The shell's clock never reaches this pane: `Show`'s `when` is a memo, and between store events the selected
  // run keeps its object identity, so the memo swallows every tick — a quiet live run's elapsed sat frozen at
  // its last event. Time-driven figures therefore read a clock of their own instead of relying on the run
  // object changing underneath them.
  const [now, setNow] = createSignal(Date.now())
  const tick = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(tick))

  // The pane's own state belongs to the run it is showing; carrying an expanded set or a fetched record across
  // a selection change would show one run's answers under another run's rows.
  let shownRunId: string | undefined
  createEffect(() => {
    const runId = props.run()?.runId
    if (runId === shownRunId) return
    shownRunId = runId
    setExpanded(new Set<string>())
    setRecord(null)
    setNotice(null)
  })

  const ensureRecord = (runId: string) => {
    const current = record()
    if (current && current.runId === runId) return
    setRecord({ runId, state: "reading" })
    void props.readRecord(runId).then((result) => {
      if (record()?.runId !== runId) return
      if (!result.ok) {
        setRecord({ runId, state: "failed", reason: result.reason })
        return
      }
      const outputs = new Map<string, string>()
      for (const unit of result.record.run.units) {
        if (unit.output !== undefined) outputs.set(unit.unitId, unit.output)
      }
      setRecord({ runId, state: "ok", outputs })
    })
  }

  const toggleUnit = (run: RunSnapshot, unit: UnitSnapshot) => {
    const next = new Set(expanded())
    if (next.has(unit.unitId)) next.delete(unit.unitId)
    else {
      next.add(unit.unitId)
      if (unit.outputElided) ensureRecord(run.runId)
    }
    setExpanded(next)
  }

  /** Three-ended, like every journal read: the text, a state notice, or nothing because nothing was produced. */
  const outputView = (run: RunSnapshot, unit: UnitSnapshot): { text?: string; notice?: string } | null => {
    if (unit.output !== undefined) return { text: unit.output }
    if (!unit.outputElided) return null
    const cache = record()
    if (!cache || cache.runId !== run.runId || cache.state === "reading") {
      return { notice: "Reading the answer from the journal…" }
    }
    if (cache.state === "failed") {
      // "Not in the journal" and "could not be read" are different facts: the first is an answer about the
      // record, the second is an answer about the transport.
      return {
        notice:
          cache.reason === "not-found" ? "This answer is not in the journal." : "The journal could not be read.",
      }
    }
    const text = cache.outputs.get(unit.unitId)
    return text !== undefined ? { text } : { notice: "This answer is not in the journal." }
  }

  const stop = async (runId: string) => {
    const result: ControlResult = await props.controls.send({ action: "stop.run", runId })
    setNotice(
      result.ok ? null : { text: result.detail ?? `could not stop (${result.reason ?? "unknown"})`, error: true },
    )
  }

  // The TUI's `s`, as a button: promote this run's journaled script to a durable workflow. The endpoint's
  // answer carries the same honest detail the TUI shows — including the already-durable refusal, which is a
  // fact about the run rather than a failure of the button.
  const save = async (runId: string) => {
    const result: ControlResult = await props.controls.send({ action: "save.run", runId })
    if (result.ok) setNotice({ text: result.detail ?? "saved", error: false })
    else setNotice({ text: result.detail ?? `could not save (${result.reason ?? "unknown"})`, error: true })
  }

  const phaseStat = (run: RunSnapshot): { text: string; ratio: number | null } | null => {
    // A successful run drops its phase position — `done · phase 3/3` says nothing `done` did not — while a
    // failed or aborted one keeps it, because where it stopped is the first thing asked.
    if (run.status === "done") return null
    const position = phasePosition(run)
    const title = run.currentPhase ?? (run.status === "running" ? "starting" : "")
    const text = [position, title].filter(Boolean).join(" · ")
    if (!text) return null
    const progress = phaseProgress(run)
    return { text, ratio: progress ? progress.index / progress.total : null }
  }

  return (
    <Show when={props.run()}>
      {(run) => (
        <article aria-label={run().workflow}>
          <header class="detail-header">
            <h1 class="detail-title">{run().workflow}</h1>
            <span class={`status-pill ${run().status}`}>{run().status}</span>
            <span class="detail-meta">
              {formatElapsed((run().endedAt ?? now()) - run().startedAt)} · started{" "}
              {[formatDay(run().startedAt), formatClock(run().startedAt)].filter(Boolean).join(" ")}
            </span>
            <Show when={(run() as RunSnapshot & { origin?: RunOrigin }).origin}>
              {/* A foreign run (the `everywhere` merge) names where it lives; controls proxy to that endpoint. */}
              {(origin) => (
                <span class="detail-meta" title={origin().worktree}>
                  in {origin().worktree.split("/").filter(Boolean).at(-1) ?? origin().worktree}
                </span>
              )}
            </Show>
            <div class="shell-spacer" />
            <button type="button" onClick={() => void save(run().runId)}>
              Save
            </button>
            <Show when={run().status === "running"}>
              <button type="button" onClick={() => void stop(run().runId)}>
                Stop
              </button>
            </Show>
          </header>

          <Show when={notice()}>
            {(current) => (
              <p class="detail-notice" classList={{ error: current().error }} role={current().error ? "alert" : "status"}>
                {current().text}
              </p>
            )}
          </Show>

          <div class="stat-strip">
            <Show when={phaseStat(run())}>
              {(stat) => (
                <div class="stat">
                  <span class="stat-label">phase</span>
                  <span class="stat-value">{stat().text}</span>
                  {/* No bar without a declared total: a bar asserts a denominator. */}
                  <Show when={stat().ratio !== null}>
                    <div class="progress" role="presentation">
                      <div
                        class="progress-fill"
                        classList={{ failed: run().status === "failed" }}
                        style={{ width: `${Math.round((stat().ratio ?? 0) * 100)}%` }}
                      />
                    </div>
                  </Show>
                </div>
              )}
            </Show>
            <div class="stat">
              <span class="stat-label">units</span>
              <span class="stat-value">
                {settledUnits(run())}/{run().units.length}
              </span>
              <Show when={run().units.length > 0}>
                <div class="progress" role="presentation">
                  <div
                    class="progress-fill"
                    classList={{ success: run().status === "done", failed: run().status === "failed" }}
                    style={{ width: `${Math.round((settledUnits(run()) / run().units.length) * 100)}%` }}
                  />
                </div>
              </Show>
            </div>
            <Show when={run().tokensSpent > 0}>
              <div class="stat col-tokens">
                <span class="stat-label">tokens</span>
                <span class="stat-value">{formatTokens(run().tokensSpent)}</span>
              </div>
            </Show>
          </div>

          {/* Pending questions, pinned above everything: a run waiting on a person outranks a run's scenery. */}
          <For each={run().interactions.map((interaction) => interaction.requestID)}>
            {(requestID) => (
              <Show when={run().interactions.find((candidate) => candidate.requestID === requestID)}>
                {(interaction) => (
                  <AnswerCard
                    runId={run().runId}
                    interaction={interaction()}
                    controls={props.controls}
                    source={asker(interaction(), run())}
                  />
                )}
              </Show>
            )}
          </For>

          <Show when={run().errors.length > 0}>
            <section class="panel error">
              <h3 class="panel-title">{run().errors.length} unit(s) failed</h3>
              <For each={run().errors}>
                {(error) => (
                  <p class="detail-notice error">
                    [{error.subagent}] {error.error}
                  </p>
                )}
              </For>
            </section>
          </Show>

          <Show when={run().units.length > 0}>
            <section class="panel">
              <h3 class="panel-title">Units</h3>
              <ul class="unit-list">
                <For each={run().units}>
                  {(unit) => (
                    <li class="unit-row" classList={{ expanded: expanded().has(unit.unitId) }}>
                      <button type="button" onClick={() => toggleUnit(run(), unit)}>
                        <span class={`status-dot ${UNIT_DOT[unit.status]}`} role="presentation" />
                        <span class="unit-ordinal">#{unit.ordinal}</span>
                        <span class="unit-label">{unit.label ?? unit.subagent}</span>
                        <Show when={unit.phase}>
                          <span class="unit-phase">{unit.phase}</span>
                        </Show>
                        <span class="unit-elapsed">
                          {unit.startedAt !== null ? formatElapsed((unit.endedAt ?? now()) - unit.startedAt) : ""}
                        </span>
                      </button>
                      <Show when={expanded().has(unit.unitId)}>
                        <div class="unit-detail">
                          <p class="detail-notice">
                            {unit.subagent}
                            <Show when={unit.sessionID}>
                              {" · session "}
                              <span class="mono">{unit.sessionID}</span>
                            </Show>
                          </p>
                          <h4>Prompt</h4>
                          <Code text={unit.prompt} />
                          <Show when={unit.error}>
                            <h4>Error</h4>
                            <pre class="error">{unit.error}</pre>
                          </Show>
                          <Show when={outputView(run(), unit)}>
                            {(view) => (
                              <>
                                <h4>Answer</h4>
                                <Show when={view().text !== undefined} fallback={<p class="detail-notice">{view().notice}</p>}>
                                  <Code text={view().text as string} />
                                </Show>
                              </>
                            )}
                          </Show>
                        </div>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </section>
          </Show>

          <Show when={run().resolved.length > 0}>
            <section class="panel">
              <h3 class="panel-title">Answered</h3>
              <For each={run().resolved}>
                {(resolved) => (
                  <p class="resolved-row">
                    <span class="resolved-question">{resolved.questions[0]?.header ?? resolved.questions[0]?.prompt}</span>
                    <span class="resolved-answer">{answerText(resolved)}</span>
                    <span class="muted">
                      {resolved.by} · {asker(resolved, run())}
                    </span>
                  </p>
                )}
              </For>
            </section>
          </Show>

          <Show when={run().logs.length > 0}>
            <details class="log-stream panel" open={run().status === "running"}>
              <summary>log stream ({run().logs.length})</summary>
              <pre>{run().logs.join("\n")}</pre>
            </details>
          </Show>
        </article>
      )}
    </Show>
  )
}

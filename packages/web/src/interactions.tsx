import type {
  InteractionQuestion,
  PendingInteraction,
  ResolvedInteraction,
  Run,
} from "@malhashemi/opencode-dynamic-workflows/protocol"
import { createMemo, createSignal, For, Index, Show } from "solid-js"

import { ActionButton, CodeBlock, Link, Tag } from "./components"
import { useApp } from "./context"
import { clockTime, formatDuration, relativeTime } from "./format"
import { unitPath } from "./router"

const KIND_LABEL: Record<string, string> = {
  question: "Question",
  permission: "Permission",
  approval: "Inline Workflow approval",
}
const ORIGIN_LABEL: Record<string, string> = {
  script: "from the Workflow",
  agent: "from a Unit's model",
  permission: "a Unit's tool call",
  engine: "from the engine",
}

function unitName(run: Run, unitId: string | null): string | null {
  if (!unitId) return null
  const unit = run.units.find((candidate) => candidate.unitId === unitId)
  return unit ? (unit.label ?? `${unit.subagent} #${unit.ordinal}`) : unitId
}

export function InteractionsPanel(props: { run: Run }) {
  const pending = () => props.run.interactions
  return (
    <section
      class="panel interactions"
      aria-labelledby="interactions-title"
      data-attention={pending().length > 0 ? "" : undefined}
    >
      <header class="panel-head">
        <h2 id="interactions-title">
          Interactions
          <Show when={pending().length > 0}>
            <Tag tone="attention">{pending().length} waiting</Tag>
          </Show>
        </h2>
      </header>
      <Show when={pending().length > 0} fallback={<p class="muted pad">Nothing is waiting on a person.</p>}>
        <For each={pending()}>{(interaction) => <PendingCard run={props.run} interaction={interaction} />}</For>
      </Show>
      <Show when={props.run.resolved.length > 0}>
        <details class="resolved">
          <summary>{props.run.resolved.length} resolved</summary>
          <ul class="resolved-list">
            <For each={props.run.resolved.toReversed()}>
              {(record) => <ResolvedRow run={props.run} record={record} />}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  )
}

function PendingCard(props: { run: Run; interaction: PendingInteraction }) {
  const app = useApp()
  const i = () => props.interaction
  const unit = () => unitName(props.run, i().unitId)
  const readOnly = () => i().form !== undefined
  const oneClick = () => {
    const questions = i().questions
    return (
      i().kind !== "question" ||
      (questions.length === 1 && !questions[0]!.multiple && !questions[0]!.custom && questions[0]!.options.length > 0)
    )
  }
  const reply = (answers: string[][]) => app.api.reply(props.run.runId, i().interactionId, answers)
  const titleId = () => `ix-${i().interactionId}`

  return (
    <article class="ix-card" data-kind={i().kind} aria-labelledby={titleId()}>
      <header class="ix-head">
        <strong id={titleId()}>{KIND_LABEL[i().kind] ?? i().kind}</strong>
        <span class="muted">{ORIGIN_LABEL[i().origin] ?? i().origin}</span>
        <Show when={unit()}>
          <span class="muted">·</span>
          <Link href={unitPath(props.run.runId, i().unitId!)}>{unit()}</Link>
        </Show>
        <Show when={i().phase}>
          <span class="muted">· {i().phase}</span>
        </Show>
        <span class="spacer" />
        <Show when={i().graceEndsAt !== null}>
          <Tag tone="attention" title="When automation takes this interaction back">
            automation in {formatDuration(Math.max(0, (i().graceEndsAt ?? 0) - app.now()))}
          </Tag>
        </Show>
        <span class="muted small" title={new Date(i().raisedAt).toLocaleString()}>
          {relativeTime(i().raisedAt, app.now())}
        </span>
      </header>

      <Show when={i().permission}>
        {(permission) => (
          <div class="ix-detail">
            <div>
              <span class="muted">Action</span> <code>{permission().action}</code>
            </div>
            <Show when={permission().resources.length > 0}>
              <div class="muted">Resources</div>
              <ul class="plain mono">
                <For each={permission().resources}>{(resource) => <li>{resource}</li>}</For>
              </ul>
            </Show>
            <Show when={permission().save.length > 0}>
              <div class="muted small">
                "Always allow" saves: <span class="mono">{permission().save.join(", ")}</span>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <Show when={i().approval}>
        {(approval) => (
          <div class="ix-detail">
            <div class="muted small">
              {approval().bytes} bytes · sha256 <span class="mono">{approval().sha256}</span>
            </div>
            <CodeBlock text={approval().preview} label="Inline source (preview)" maxHeight="22rem" />
          </div>
        )}
      </Show>

      <Show
        when={!readOnly()}
        fallback={
          <div class="ix-detail">
            <For each={i().questions}>{(question) => <QuestionText question={question} />}</For>
            <p class="note">This is a native OpenCode form. Answer it in the TUI; the web app shows it read-only.</p>
          </div>
        }
      >
        <Show
          when={oneClick()}
          fallback={
            <QuestionForm
              interaction={i()}
              onSubmit={reply}
              onCancel={() => app.api.cancel(props.run.runId, i().interactionId)}
            />
          }
        >
          <For each={i().questions}>{(question) => <QuestionText question={question} hideOptions />}</For>
          <div class="ix-actions">
            <For each={i().questions[0]?.options ?? []}>
              {(option, index) => (
                <ActionButton
                  tone={option.label === "Reject" ? "danger" : index() === 0 ? "primary" : "default"}
                  title={option.description}
                  onAction={() => reply([[option.label]])}
                  done={`Answered: ${option.label}`}
                >
                  {option.label}
                </ActionButton>
              )}
            </For>
            <Show when={i().kind === "question"}>
              <span class="spacer" />
              <ActionButton
                tone="ghost"
                onAction={() => app.api.cancel(props.run.runId, i().interactionId)}
                title="Dismiss; the Workflow gets its fallback"
                done="Dismissed"
              >
                Dismiss
              </ActionButton>
            </Show>
          </div>
        </Show>
      </Show>
    </article>
  )
}

function QuestionText(props: { question: InteractionQuestion; hideOptions?: boolean }) {
  return (
    <div class="ix-question">
      <Show when={props.question.header && props.question.header !== props.question.prompt}>
        <div class="ix-q-header">{props.question.header}</div>
      </Show>
      <p class="ix-prompt">{props.question.prompt}</p>
      <Show when={!props.hideOptions && props.question.options.length > 0}>
        <ul class="plain">
          <For each={props.question.options}>
            {(option) => (
              <li>
                <strong>{option.label}</strong> <span class="muted">{option.description}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  )
}

function QuestionForm(props: {
  interaction: PendingInteraction
  onSubmit: (answers: string[][]) => Promise<unknown>
  onCancel: () => Promise<unknown>
}) {
  const questions = () => props.interaction.questions
  const [chosen, setChosen] = createSignal<string[][]>(questions().map(() => []))
  const [custom, setCustom] = createSignal<string[]>(questions().map(() => ""))
  const answers = createMemo(() =>
    questions().map((question, index) => {
      const labels = chosen()[index] ?? []
      const text = (custom()[index] ?? "").trim()
      return question.custom && text ? [...labels, text] : labels
    }),
  )
  const complete = () => answers().every((row) => row.length > 0)
  const toggle = (index: number, label: string, multiple: boolean) =>
    setChosen((rows) =>
      rows.map((row, i) =>
        i !== index
          ? row
          : multiple
            ? row.includes(label)
              ? row.filter((l) => l !== label)
              : [...row, label]
            : [label],
      ),
    )
  const base = `q-${props.interaction.interactionId}`

  return (
    <form
      class="ix-form"
      onSubmit={(event) => {
        event.preventDefault()
      }}
    >
      <Index each={questions()}>
        {(question, index) => (
          <fieldset class="ix-fieldset">
            <legend>
              <span class="ix-q-header">{question().header}</span>
            </legend>
            <p class="ix-prompt">{question().prompt}</p>
            <div class="ix-options" role={question().multiple ? "group" : "radiogroup"} aria-label={question().header}>
              <For each={question().options}>
                {(option, optionIndex) => {
                  const id = `${base}-${index}-${optionIndex()}`
                  return (
                    <label class="ix-option" for={id}>
                      <input
                        id={id}
                        type={question().multiple ? "checkbox" : "radio"}
                        name={`${base}-${index}`}
                        checked={(chosen()[index] ?? []).includes(option.label)}
                        onChange={() => toggle(index, option.label, question().multiple)}
                      />
                      <span>
                        <strong>{option.label}</strong>
                        <Show when={option.description}>
                          <span class="muted"> — {option.description}</span>
                        </Show>
                      </span>
                    </label>
                  )
                }}
              </For>
            </div>
            <Show when={question().custom}>
              <label class="field">
                <span class="field-label">
                  {question().options.length > 0 ? "Or type your own answer" : "Your answer"}
                </span>
                <textarea
                  rows={2}
                  value={custom()[index] ?? ""}
                  onInput={(event) => {
                    const value = event.currentTarget.value
                    setCustom((rows) => rows.map((row, i) => (i === index ? value : row)))
                    if (!question().multiple && value.trim())
                      setChosen((rows) => rows.map((row, i) => (i === index ? [] : row)))
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      event.currentTarget.form?.querySelector<HTMLButtonElement>("button.submit")?.click()
                    }
                  }}
                />
              </label>
            </Show>
          </fieldset>
        )}
      </Index>
      <div class="ix-actions">
        <ActionButton
          tone="primary"
          disabled={!complete()}
          onAction={() => props.onSubmit(answers())}
          done="Answer sent"
          class="submit"
          aria-keyshortcuts="Control+Enter"
        >
          Send answer
        </ActionButton>
        <span class="spacer" />
        <ActionButton
          tone="ghost"
          onAction={props.onCancel}
          title="Dismiss; the Workflow gets its fallback"
          done="Dismissed"
        >
          Dismiss
        </ActionButton>
      </div>
    </form>
  )
}

function ResolvedRow(props: { run: Run; record: ResolvedInteraction }) {
  const r = () => props.record
  const answer = () =>
    r()
      .answers.map((row) => row.join(", "))
      .join(" · ")
  return (
    <li class="resolved-row">
      <span class="mono muted">{clockTime(r().resolvedAt)}</span>
      <span>{KIND_LABEL[r().kind] ?? r().kind}</span>
      <span
        class="truncate"
        title={r()
          .questions.map((q) => q.prompt)
          .join("\n")}
      >
        {r().questions[0]?.header || r().questions[0]?.prompt}
      </span>
      <span>
        <Show when={answer()} fallback={<span class="muted">{r().outcome ?? "no answer"}</span>}>
          <strong>{answer()}</strong>
        </Show>
      </span>
      <Tag tone={r().by === "human" ? "info" : "muted"}>{r().by}</Tag>
      <Show when={r().outcome && r().outcome !== "answered"}>
        <Tag tone="muted">{r().outcome}</Tag>
      </Show>
    </li>
  )
}

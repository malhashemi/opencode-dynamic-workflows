/** @jsxImportSource @opentui/solid */
/**
 * The answer pane — where a person answers a question raised inside a run.
 *
 * A LEVEL of the run browser's drill stack rather than a modal, which is the whole design in one sentence: a
 * modal interrupts whatever the user was typing and has to be dismissed before anything else can happen, while
 * a level can be walked into, walked out of, and left open next to a run that is still moving. It also means
 * `esc` keeps the one meaning it has everywhere else in the route.
 *
 * One pane serves both origins. An agent-raised question and a script-raised `ctx.ask` arrive as the same
 * `PendingInteraction`, so there is exactly one thing to render, one control action to send, and no branch
 * anywhere in this file on where the question came from.
 *
 * A multi-question form is answered ONE QUESTION AT A TIME. `PendingInteraction.questions` is a list, so a
 * script can pose several at once; rendering them all at once would turn a terminal pane into a web form, and
 * the person answering has a run in flight to keep track of.
 */
import type { TuiTheme } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { formatElapsed, meter } from "../progress"
import type { InteractionQuestion, PendingInteraction } from "../runs"

/** Cells in the grace meter — the same four the rest of the route uses, so it reads as one system. */
const METER_WIDTH = 4

/** Below this fraction of the grace remaining, the meter stops being information and starts being a deadline. */
const URGENT_FRACTION = 0.25

/** The row that opens the free-text field, when the question allows one. */
export const CUSTOM_ROW_LABEL = "✎ custom answer…"

/**
 * Turn a pane's selection into the host's own reply shape.
 *
 * `selection` is the set of option labels chosen for the CURRENT question and `custom` is the free-text buffer
 * (`null` while the user is choosing from the offered set). `answered` carries the rows already collected for
 * earlier questions — a fourth parameter the sketch did not have, and the price of answering a multi-question
 * form one question at a time: the reply is a property of the whole form, and the pane only ever holds one
 * question's worth of state at a time.
 *
 * The result is complete when its length equals `interaction.questions.length`; until then the pane advances.
 */
export function buildAnswer(
  interaction: PendingInteraction,
  selection: readonly string[],
  custom: string | null,
  answered: readonly string[][] = [],
): string[][] {
  const chosen = custom !== null && custom.trim().length > 0 ? [custom.trim()] : [...selection]
  const rows = [...answered.map((row) => [...row]), chosen]
  return rows.slice(0, Math.max(1, interaction.questions.length))
}

/** `4m52s left`, or `""` when this interaction has no deadline at all. */
export function graceRemaining(interaction: PendingInteraction, now = Date.now()): string {
  if (interaction.graceEndsAt === null) return ""
  const remaining = interaction.graceEndsAt - now
  if (remaining <= 0) return "handing over to automation…"
  return `${formatElapsed(remaining)} left`
}

/** How much of the grace is still the human's, as a 0..1 ratio; `null` when there is no grace. */
export function graceRatio(interaction: PendingInteraction, now = Date.now()): number | null {
  if (interaction.graceEndsAt === null) return null
  const total = interaction.graceEndsAt - interaction.raisedAt
  if (total <= 0) return 0
  return Math.max(0, Math.min(1, (interaction.graceEndsAt - now) / total))
}

/**
 * Everything the pane needs, and nothing about the run browser.
 *
 * `onAnswer` / `onHandOff` rather than a control client, because the route already owns dispatch and owning it
 * twice is how two surfaces come to disagree about what a keystroke did.
 */
export interface InteractionPaneProps {
  interaction: Accessor<PendingInteraction | undefined>
  theme: TuiTheme
  /** Live clock, driven by the route's own tick so the countdown and the run's elapsed move together. */
  now: Accessor<number>
  /** Row index the route's cursor is on, within {@link paneRows}. */
  selected: Accessor<number>
  /** The free-text buffer, or `null` while the user is choosing from the offered options. */
  custom: Accessor<string | null>
  /** Which question of a multi-part form is on screen, zero-based. */
  index: Accessor<number>
  /**
   * Who raised it, already resolved to a name — `#1 nested asker`, or the depth when no unit could be named.
   *
   * Passed in rather than derived here because attributing an interaction needs the RUN's unit list, and the
   * pane is deliberately given one interaction and nothing else.
   */
  source?: Accessor<string>
  onSelect: (index: number) => void
  onCustomInput: (value: string) => void
  onAnswer: () => void
  onHandOff: () => void
}

/** One selectable row of the pane: an offered option, or the custom-answer entry. */
export interface PaneRow {
  label: string
  description: string
  custom: boolean
}

export function paneRows(question: InteractionQuestion | undefined): PaneRow[] {
  if (!question) return []
  const rows: PaneRow[] = question.options.map((option) => ({
    label: option.label,
    description: option.description,
    custom: false,
  }))
  if (question.custom) rows.push({ label: CUSTOM_ROW_LABEL, description: "Answer in your own words", custom: true })
  return rows
}

export default function InteractionPane(props: InteractionPaneProps) {
  const theme = () => props.theme.current
  const question = createMemo<InteractionQuestion | undefined>(
    () => props.interaction()?.questions[props.index()],
  )
  const rows = createMemo(() => paneRows(question()))
  const [inputValue, setInputValue] = createSignal("")

  // The buffer lives in the route's state (so `esc` can clear it and the reducer can see it), but the input
  // renderable owns a string of its own; keep them in step in the one direction that matters.
  createEffect(() => {
    const custom = props.custom()
    if (custom !== null && custom !== inputValue()) setInputValue(custom)
  })

  const remaining = createMemo(() => {
    const interaction = props.interaction()
    return interaction ? graceRemaining(interaction, props.now()) : ""
  })
  const ratio = createMemo(() => {
    const interaction = props.interaction()
    return interaction ? graceRatio(interaction, props.now()) : null
  })
  /**
   * The one place in the route where a meter carries urgency rather than progress.
   *
   * Everywhere else `▰▰▱▱` is a neutral accent, because "12 of 40 units" is not an emergency. Here the bar is
   * DRAINING toward a moment when the answer stops being the user's to give, so the last quarter earns
   * `warning` — the same colour the route already uses for a run that was stopped.
   */
  const meterColor = () => {
    const value = ratio()
    return value !== null && value <= URGENT_FRACTION ? theme().warning : theme().accent
  }

  /** Who is asking, in the words the run browser used to get here. */
  const source = createMemo(() => {
    const interaction = props.interaction()
    if (!interaction) return ""
    const named = props.source?.()
    if (named) return `from ${named}`
    return `from ${interaction.origin === "script" ? "the workflow script" : `a unit at depth ${interaction.depth}`}`
  })

  const rowBackground = (index: number) => (index === props.selected() ? theme().backgroundElement : undefined)
  // Selection changes the BACKGROUND and promotes the label to accent, and nothing else. Never paired with
  // `selectedListItemText`: that token is cut to sit on the host's own selection fill and lands invisible
  // against any other background — it did exactly that in the run browser, on a real host.
  const rowLabel = (index: number) => (index === props.selected() ? theme().accent : theme().text)

  return (
    <Show when={props.interaction()}>
      {(interaction: Accessor<PendingInteraction>) => (
        <box flexDirection="column" gap={1}>
          <box flexDirection="row" gap={2}>
            <text flexShrink={0} fg={theme().accent}>
              <b>{interaction().kind === "permission" ? "⚠ permission" : "❓ question"}</b>
            </text>
            <text flexShrink={1} fg={theme().textMuted}>
              {source()}
            </text>
            <Show when={interaction().questions.length > 1}>
              <text flexShrink={0} fg={theme().textMuted}>
                {`${props.index() + 1}/${interaction().questions.length}`}
              </text>
            </Show>
            <Show when={remaining()}>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <Show when={ratio() !== null}>
                  <text flexShrink={0} fg={meterColor()}>
                    {meter(ratio() ?? 0, METER_WIDTH)}
                  </text>
                </Show>
                <text flexShrink={0} fg={meterColor()}>
                  {remaining()}
                </text>
              </box>
            </Show>
          </box>

          <box
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
            border
            borderStyle="rounded"
            borderColor={theme().borderSubtle}
            title={` ${question()?.header ?? "Question"} `}
            titleAlignment="left"
          >
            <text fg={theme().text} wrapMode="word">
              {question()?.prompt ?? ""}
            </text>
          </box>

          <box flexDirection="column">
            <For each={rows()}>
              {(row: PaneRow, index) => (
                <box
                  flexDirection="column"
                  backgroundColor={rowBackground(index())}
                  onMouseUp={() => props.onSelect(index())}
                >
                  <text fg={rowLabel(index())}>{` ${row.label}`}</text>
                  {/* The description under the label, because a choice that explains itself is the difference
                      between an informed answer and a guess — and the host's shape carries one already. */}
                  <Show when={row.description}>
                    <text fg={theme().textMuted}>{`   ${row.description}`}</text>
                  </Show>
                </box>
              )}
            </For>
          </box>

          <Show when={props.custom() !== null}>
            <box
              flexDirection="column"
              paddingLeft={1}
              paddingRight={1}
              border
              borderStyle="rounded"
              borderColor={theme().accent}
              title=" Your answer "
              titleAlignment="left"
            >
              <input
                focused
                value={inputValue()}
                placeholder="type an answer, then ⏎"
                onInput={(value: string) => {
                  setInputValue(value)
                  props.onCustomInput(value)
                }}
                onSubmit={() => props.onAnswer()}
              />
            </box>
          </Show>
        </box>
      )}
    </Show>
  )
}

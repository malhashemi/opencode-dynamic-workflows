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
 * the person answering has a run in flight to keep track of. One question at a time is not one DIRECTION at a
 * time, though: `esc` steps back through the form, restoring what was said to the question it lands on, because
 * a form that only went forwards made mis-answering question one of four cost the whole form.
 */
import type { TuiTheme } from "@opencode-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { formatElapsed, meter } from "../progress"
import type { InteractionQuestion, PendingInteraction, ResolvedInteraction } from "../runs"

/**
 * Cells in the grace meter — and the one documented exception to the Visual language's `METER_WIDTH` of 4.
 *
 * Four cells is a rule about RATIO COLUMNS in a list, where a meter is a glanceable proportion sitting beside
 * eleven other rows and a wider bar would read as a chart nobody asked for. This meter has the opposite job: it
 * is the only one in the product that DRAINS, it is the sole occupant of its corner of a full-width pane, and
 * the thing it measures is how long you have left to decide. At four cells a countdown has five states, so it
 * sits still and then jumps — which reads as broken, and worse, as time you did not know you were losing.
 * Twenty-one states across a 40-second fuse is one step every two seconds: continuous enough to be a clock.
 */
const GRACE_METER_WIDTH = 20

/** Below this fraction of the grace remaining, the meter stops being information and starts being a deadline. */
const URGENT_FRACTION = 0.25

/** The row that opens the free-text field, when the question allows one. */
export const CUSTOM_ROW_LABEL = "✎ custom answer…"

/**
 * The mark in front of an option, and the one thing on the screen that says how many answers are wanted.
 *
 * Boxes for a question that takes a SET, a radio for one that takes exactly one — the vocabulary every other
 * terminal and every form on the web uses, including the host's own ask tool. This is not decoration: it is the
 * only signal a person gets, before they try anything, about whether ticking two options is a thing this
 * question does. A circle on both said "pick one" on a question that wanted three.
 *
 * Both marks are three cells wide, so the labels line up down the list whichever kind of question it is, and the
 * custom row is blanked to the same width rather than left un-marked and half a word out of column.
 */
const CHOICE_MARKS = {
  multiple: { on: "[x]", off: "[ ]" },
  single: { on: "(•)", off: "( )" },
  none: "   ",
} as const

/**
 * Turn a pane's selection into the host's own reply shape.
 *
 * `selection` is the set of option labels chosen for the CURRENT question and `custom` is the free-text buffer
 * (`null` while the user is choosing from the offered set). `answered` carries the rows already collected for
 * the other questions — a fourth parameter the sketch did not have, and the price of answering a multi-question
 * form one question at a time: the reply is a property of the whole form, and the pane only ever holds one
 * question's worth of state at a time.
 *
 * `at` is which question the answer belongs to, and it is what lets a form be walked BACKWARDS. Appending would
 * have been enough for a form that only ever went forwards; once `esc` can step back to question one, changing
 * it must overwrite question one's row and leave questions two and three alone.
 *
 * The set is a set on purpose: a `multiple` question hands in everything the user ticked, a single-choice one
 * hands in the row the cursor was on, and this function cannot tell the difference — which is why it never had
 * to change when multi-select arrived. A typed answer still wins over both, because someone who reached for the
 * free-text field after ticking has said which of the two they meant.
 *
 * Whether the form is finished is the CALLER's question now (`at === questions.length - 1`), because a revisited
 * form is already the right length long before its last question is on screen.
 */
export function buildAnswer(
  interaction: PendingInteraction,
  selection: readonly string[],
  custom: string | null,
  answered: readonly string[][] = [],
  at: number = answered.length,
): string[][] {
  const chosen = custom !== null && custom.trim().length > 0 ? [custom.trim()] : [...selection]
  const index = Math.max(0, Math.min(at, Math.max(0, interaction.questions.length - 1)))
  const rows: string[][] = []
  for (let row = 0; row < Math.max(index + 1, answered.length); row++) {
    rows.push(row === index ? chosen : [...(answered[row] ?? [])])
  }
  return rows.slice(0, Math.max(1, interaction.questions.length))
}

/**
 * `4m52s left`, or `""` when this interaction has no deadline at all.
 *
 * The empty string is now the COMMON case: a grace period is opt-in per workflow, so most questions simply wait
 * for the person they were asked of. Rendering no countdown for them is the honest thing — a bar drawn where
 * there is no deadline invents urgency the system does not actually have.
 */
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
 * The one line that says how a settled question ended, in the terms the reader cares about.
 *
 * Four endings, four sentences. The fourth used to be the only one automation ever got: an answer the ladder
 * produced arrived with `answers: []` and read "settled without a recorded answer", which was true of the
 * record and false about the run — the ladder knew exactly what it had replied. Now the missing case is the one
 * that genuinely is missing (a person answering in the host's own dialog, which this process never sees), and a
 * REFUSAL says so in its own words, because a unit that was denied did not get an answer at all.
 */
export function settledNote(interaction: ResolvedInteraction): string {
  if (interaction.outcome === "rejected") {
    return interaction.by === "human"
      ? "You declined this — the asker was refused."
      : "Automation declined this — the asker was refused."
  }
  if (interaction.by === "human") return "You answered this."
  if (interaction.answers.length > 0) {
    return "Automation answered this — nobody was watching, or the grace ran out."
  }
  return "Settled elsewhere; this run never saw the answer."
}

/**
 * Everything the pane needs, and nothing about the run browser.
 *
 * `onAnswer` rather than a control client, because the route already owns dispatch and owning it twice is how
 * two surfaces come to disagree about what a keystroke did. There is deliberately no `onHandOff`: giving a
 * question to automation is `x`, which the route handles through `selectedControl` like every other control
 * key, and a pane-local callback for it was how `esc` came to mean something it must never mean.
 */
export interface InteractionPaneProps {
  interaction: Accessor<PendingInteraction | undefined>
  /**
   * The same question after it was settled, when that is what this level addresses.
   *
   * Mutually exclusive with `interaction` in practice — a request is either waiting or recorded — but passed as
   * two accessors rather than one union so the pane's read-only mode is a fact about its props rather than a
   * type test buried in the render path.
   */
  answered?: Accessor<ResolvedInteraction | undefined>
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
   * The labels ticked so far, on a question that accepts more than one answer.
   *
   * Empty everywhere else, which is what makes the pane's rendering of it uniform: a single-choice question has
   * nothing ticked because ticking is not how it is answered, and a record has nothing ticked because its
   * chosen set is already `answers`.
   */
  chosen?: Accessor<readonly string[]>
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
  /** Whichever half of the question's life this level addresses. */
  const record = createMemo<PendingInteraction | ResolvedInteraction | undefined>(
    () => props.interaction() ?? props.answered?.(),
  )
  const answered = createMemo<ResolvedInteraction | undefined>(() =>
    props.interaction() ? undefined : props.answered?.(),
  )
  const question = createMemo<InteractionQuestion | undefined>(() => record()?.questions[props.index()])
  const rows = createMemo(() => paneRows(question()))
  const [inputValue, setInputValue] = createSignal("")

  /**
   * The labels chosen for the question on screen, for a record being read back.
   *
   * A free-text answer will not be among the offered options; that is not a mismatch to hide but the whole
   * point of a custom answer, so it gets a row of its own below rather than silently marking nothing.
   */
  const chosen = createMemo<readonly string[]>(() => answered()?.answers[props.index()] ?? [])
  const chosenCustom = createMemo<string | null>(() => {
    const offered = new Set((question()?.options ?? []).map((option) => option.label.toLowerCase()))
    const free = chosen().find((label) => !offered.has(label.toLowerCase()))
    return free ?? null
  })

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
    const interaction = record()
    if (!interaction) return ""
    const named = props.source?.()
    if (named) return `from ${named}`
    return `from ${interaction.origin === "script" ? "the workflow script" : `a unit at depth ${interaction.depth}`}`
  })

  const isChosen = (label: string) => chosen().some((entry) => entry.toLowerCase() === label.toLowerCase())

  /**
   * Whether this question accepts more than one answer — the field the host has always sent and nothing read.
   *
   * It changes two things here, and neither is a new vocabulary: every option is marked with a BOX rather than
   * a radio, and a ticked one takes the same `success` an answered record's chosen option takes.
   */
  const multiple = createMemo(() => !answered() && question()?.multiple === true)
  const isTicked = (label: string) =>
    multiple() && (props.chosen?.() ?? []).some((entry) => entry.toLowerCase() === label.toLowerCase())

  // A record has no cursor: there is nothing to choose, so nothing is highlighted as choosable. What IS marked
  // is the option that was taken.
  const rowBackground = (index: number) =>
    !answered() && index === props.selected() ? theme().backgroundElement : undefined
  // Selection changes the BACKGROUND and promotes the label to accent, and nothing else. Never paired with
  // `selectedListItemText`: that token is cut to sit on the host's own selection fill and lands invisible
  // against any other background — it did exactly that in the run browser, on a real host.
  const rowLabel = (row: PaneRow, index: number) => {
    if (answered()) return isChosen(row.label) ? theme().success : theme().textMuted
    if (index === props.selected()) return theme().accent
    // A ticked option the cursor has moved off still has to read as chosen — the same `success` a settled
    // record uses for the answer that was given, because it is the same claim about the same option.
    return isTicked(row.label) ? theme().success : theme().text
  }
  /**
   * `[x]` / `[ ]` when the question takes a set, `(•)` / `( )` when it takes exactly one.
   *
   * The shape of the mark is the answer to a question a person has before they touch a key: how many of these
   * am I allowed to pick? Circles on both said "one" on a question that wanted several — and since a
   * single-choice question is answered by the cursor and ⏎, its radio simply follows the cursor, which is what
   * a radio does everywhere else.
   *
   * A settled record uses the same rule, from its own `multiple`: what was ticked and what was taken are the
   * same claim about the same option at two moments, so they must not be drawn with two vocabularies.
   *
   * The custom row is never marked — typing is how it is answered — but it is padded to the same width so the
   * labels stay in one column.
   */
  const rowMark = (row: PaneRow, index: number) => {
    if (row.custom) return CHOICE_MARKS.none
    const marks = question()?.multiple === true ? CHOICE_MARKS.multiple : CHOICE_MARKS.single
    if (answered()) return isChosen(row.label) ? marks.on : marks.off
    if (multiple()) return isTicked(row.label) ? marks.on : marks.off
    // Single choice: the option under the cursor is the one ⏎ would send, so it is the one that reads as taken.
    return index === props.selected() ? marks.on : marks.off
  }

  return (
    <Show when={record()}>
      {(interaction: Accessor<PendingInteraction | ResolvedInteraction>) => (
        <box flexDirection="column" gap={1}>
          {/* No flex `gap` in this strip: the separators live in the text. One source of horizontal spacing
              means it cannot come out doubled in one terminal and absent in another. */}
          <box flexDirection="row">
            <text flexShrink={0} fg={answered() ? theme().textMuted : theme().accent}>
              <b>
                {answered()
                  ? interaction().kind === "permission"
                    ? "⚠ permission (answered)"
                    : "❓ question (answered)"
                  : interaction().kind === "permission"
                    ? "⚠ permission"
                    : "❓ question"}
              </b>
            </text>
            <text flexShrink={1} fg={theme().textMuted}>
              {`  ${source()}`}
            </text>
            <Show when={interaction().questions.length > 1}>
              <text flexShrink={0} fg={theme().textMuted}>
                {`  ${props.index() + 1}/${interaction().questions.length}`}
              </text>
            </Show>
            <Show when={remaining()}>
              <box flexDirection="row" flexShrink={0}>
                <Show when={ratio() !== null}>
                  <text flexShrink={0} fg={meterColor()}>
                    {`  ${meter(ratio() ?? 0, GRACE_METER_WIDTH)}`}
                  </text>
                </Show>
                {/* Two spaces, not one: the meter before it can overhang its cell. See route.tsx's stat strip. */}
                <text flexShrink={0} fg={meterColor()}>
                  {`  ${remaining()}`}
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
                  <text fg={rowLabel(row, index())}>{`${rowMark(row, index())} ${row.label}`}</text>
                  {/* The description under the label, because a choice that explains itself is the difference
                      between an informed answer and a guess — and the host's shape carries one already. Indented
                      to the label's own column: the mark is three cells wide and a space follows it. */}
                  <Show when={row.description}>
                    <text fg={theme().textMuted}>{`    ${row.description}`}</text>
                  </Show>
                </box>
              )}
            </For>
          </box>

          {/* A free-text answer is not among the offered options by definition; showing it as its own row is
              the only way a record of one is a record at all. */}
          <Show when={chosenCustom()}>
            {(free: Accessor<string>) => (
              <box
                flexDirection="column"
                paddingLeft={1}
                paddingRight={1}
                border
                borderStyle="rounded"
                borderColor={theme().borderSubtle}
                title=" Your answer "
                titleAlignment="left"
              >
                <text fg={theme().success} wrapMode="word">
                  {free()}
                </text>
              </box>
            )}
          </Show>

          <Show when={answered()}>
            {(settled: Accessor<ResolvedInteraction>) => (
              <text fg={settled().outcome === "rejected" ? theme().warning : theme().textMuted}>
                {settledNote(settled())}
              </text>
            )}
          </Show>

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

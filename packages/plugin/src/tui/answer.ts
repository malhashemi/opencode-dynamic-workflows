/**
 * Answer mode for a pending interaction — a pure state machine the panel renders.
 *
 * The TUI enters answer mode explicitly (P0 S4 T9): while answering, the view's navigation keys are off, so
 * single-letter bindings cannot steal typing. Inside answer mode there are two sub-modes: choosing (arrow keys,
 * space, enter over the offered options) and typing (an `<input>` holds focus for a free-text answer, only where
 * the question allows `custom`). Each question gets one list of labels; the last confirmation yields the
 * `answers` array `replyInteraction` expects (one entry per question).
 */
import type { FormField, FormInfo } from "@opencode/client"
import type { InteractionQuestion, PendingInteraction } from "../protocol"

export interface AnswerState {
  readonly interactionId: string
  readonly runId: string
  readonly questions: readonly InteractionQuestion[]
  /** The question being answered. */
  readonly index: number
  /** The highlighted row of the current question (options, then "type your own" when custom). */
  readonly cursor: number
  /** Chosen labels per question (toggled for `multiple`). */
  readonly chosen: readonly (readonly string[])[]
  readonly typing: boolean
}

export type AnswerRow =
  | { readonly kind: "option"; readonly label: string; readonly description: string; readonly checked: boolean }
  | { readonly kind: "custom"; readonly label: string; readonly typed: readonly string[] }

export interface AnswerStep {
  readonly state: AnswerState
  /** Set when the last question was confirmed: the reply to send. */
  readonly submit?: string[][]
}

export function startAnswer(interaction: Pick<PendingInteraction, "interactionId" | "runId" | "questions">): AnswerState {
  return {
    interactionId: interaction.interactionId,
    runId: interaction.runId,
    questions: interaction.questions,
    index: 0,
    cursor: 0,
    chosen: interaction.questions.map(() => []),
    typing: false,
  }
}

export function currentQuestion(state: AnswerState): InteractionQuestion | undefined {
  return state.questions[state.index]
}

/** Custom answers already given for the current question (labels not among its options). */
function typedFor(state: AnswerState, index = state.index): string[] {
  const question = state.questions[index]
  if (!question) return []
  return (state.chosen[index] ?? []).filter((label) => !question.options.some((option) => option.label === label))
}

export function rows(state: AnswerState): AnswerRow[] {
  const question = currentQuestion(state)
  if (!question) return []
  const chosen = state.chosen[state.index] ?? []
  const options: AnswerRow[] = question.options.map((option) => ({
    kind: "option",
    label: option.label,
    description: option.description,
    checked: chosen.includes(option.label),
  }))
  if (question.custom) options.push({ kind: "custom", label: "Type your own answer", typed: typedFor(state) })
  return options
}

export function move(state: AnswerState, delta: number): AnswerState {
  const count = rows(state).length
  if (count === 0 || state.typing) return state
  const cursor = (((state.cursor + delta) % count) + count) % count
  return { ...state, cursor }
}

function withChosen(state: AnswerState, labels: readonly string[]): AnswerState {
  const chosen = state.chosen.map((row, index) => (index === state.index ? [...labels] : row))
  return { ...state, chosen }
}

/** The next question, or the finished reply when this was the last one. */
function advance(state: AnswerState): AnswerStep {
  if (state.index + 1 < state.questions.length) return { state: { ...state, index: state.index + 1, cursor: 0, typing: false } }
  return { state: { ...state, typing: false }, submit: state.chosen.map((row) => [...row]) }
}

/** Space: toggle the highlighted option of a `multiple` question (select it, for a single-choice one). */
export function toggle(state: AnswerState): AnswerState {
  const question = currentQuestion(state)
  const row = rows(state)[state.cursor]
  if (!question || !row || state.typing) return state
  if (row.kind === "custom") return { ...state, typing: true }
  const chosen = state.chosen[state.index] ?? []
  if (!question.multiple) return withChosen(state, [row.label])
  return withChosen(state, chosen.includes(row.label) ? chosen.filter((label) => label !== row.label) : [...chosen, row.label])
}

/**
 * Enter. On the custom row: start typing. Single choice: take the highlighted option and move on. Multiple:
 * confirm what is toggled (the highlighted option when nothing is).
 */
export function confirm(state: AnswerState): AnswerStep {
  const question = currentQuestion(state)
  const row = rows(state)[state.cursor]
  if (!question || state.typing) return { state }
  if (row?.kind === "custom") return { state: { ...state, typing: true } }
  if (!question.multiple) {
    if (!row) return { state }
    return advance(withChosen(state, [row.label]))
  }
  const chosen = state.chosen[state.index] ?? []
  if (chosen.length === 0) {
    if (!row) return { state }
    return advance(withChosen(state, [row.label]))
  }
  return advance(state)
}

/** Quick pick by number (1-based) — the same as moving there and pressing Enter. */
export function pick(state: AnswerState, number: number): AnswerStep {
  const count = rows(state).length
  if (state.typing || number < 1 || number > count) return { state }
  return confirm({ ...state, cursor: number - 1 })
}

/** Enter in the text input: a non-empty text becomes (part of) this question's answer. */
export function submitText(state: AnswerState, text: string): AnswerStep {
  const question = currentQuestion(state)
  const value = text.trim()
  if (!question || !value) return { state }
  const chosen = state.chosen[state.index] ?? []
  const labels = question.multiple ? [...chosen.filter((label) => label !== value), value] : [value]
  return advance(withChosen({ ...state, typing: false }, labels))
}

/** Escape: leave typing, else go back one question; `null` means leave answer mode altogether. */
export function back(state: AnswerState): AnswerState | null {
  if (state.typing) return { ...state, typing: false }
  if (state.index > 0) return { ...state, index: state.index - 1, cursor: 0 }
  return null
}

// ---------------------------------------------------------------------------------------------------------------
// Native OpenCode forms (interactions carrying `form: { formID }`)
// ---------------------------------------------------------------------------------------------------------------

export type FormAnswerValue = string | number | boolean | string[]

function optionValue(field: { options?: ReadonlyArray<{ label: string; value: string }> }, label: string): string {
  return field.options?.find((option) => option.label === label || option.value === label)?.value ?? label
}

/**
 * Map an interaction's answers (one label list per question, in form-field order — how the server built the
 * questions from `form.fields`) to a native form answer keyed by field. Returns an error for an answer the field
 * cannot take.
 */
export function formAnswer(fields: readonly FormField[], answers: readonly (readonly string[])[]): { answer: Record<string, FormAnswerValue> } | { error: string } {
  const answer: Record<string, FormAnswerValue> = {}
  for (const [index, field] of fields.entries()) {
    const given = answers[index] ?? []
    const first = given[0]
    if (field.type === "external") continue
    if (given.length === 0 || first === undefined) {
      if ("required" in field && field.required) return { error: `"${field.title ?? field.key}" needs an answer` }
      continue
    }
    switch (field.type) {
      case "string":
        answer[field.key] = optionValue(field, first)
        break
      case "multiselect":
        answer[field.key] = given.map((label) => optionValue(field, label))
        break
      case "boolean":
        answer[field.key] = /^(y|yes|true|on|1|allow|ok)$/i.test(first.trim())
        break
      case "number":
      case "integer": {
        const value = Number(first)
        if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) return { error: `"${field.title ?? field.key}" needs a number` }
        answer[field.key] = value
        break
      }
    }
  }
  return { answer }
}

export function findForm(forms: readonly FormInfo[] | undefined, formID: string): FormInfo | undefined {
  return forms?.find((form) => form.id === formID)
}

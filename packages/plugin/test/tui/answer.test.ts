import { describe, expect, test } from "bun:test"

import type { FormField } from "@opencode/client"

import { back, confirm, formAnswer, move, pick, rows, startAnswer, submitText, toggle } from "../../src/tui/answer"
import { question } from "./fixtures"

const PERMISSION = question({
  kind: "permission",
  origin: "permission",
  questions: [
    {
      header: "Permission: read",
      prompt: "A Unit wants to read: notes.txt",
      options: [
        { label: "Allow once", description: "" },
        { label: "Always allow", description: "" },
        { label: "Reject", description: "" },
      ],
      multiple: false,
      custom: false,
    },
  ],
})

describe("answer mode", () => {
  test("single choice: move and confirm submits the highlighted label", () => {
    let state = startAnswer(question())
    expect(rows(state).map((row) => row.kind)).toEqual(["option", "option", "custom"])
    state = move(state, 1)
    const step = confirm(state)
    expect(step.submit).toEqual([["Thorough"]])
  })

  test("the cursor wraps; number keys pick directly", () => {
    const state = startAnswer(PERMISSION)
    expect(move(state, -1).cursor).toBe(2)
    expect(pick(state, 3).submit).toEqual([["Reject"]])
    expect(pick(state, 4).submit).toBeUndefined()
  })

  test("custom: Enter on the custom row starts typing; text is the answer; empty text is ignored", () => {
    let state = startAnswer(question())
    state = move(state, 2)
    const typing = confirm(state)
    expect(typing.state.typing).toBe(true)
    expect(typing.submit).toBeUndefined()
    expect(submitText(typing.state, "   ").submit).toBeUndefined()
    expect(submitText(typing.state, " medium ").submit).toEqual([["medium"]])
    // Escape leaves typing, then leaves answer mode.
    const backed = back(typing.state)!
    expect(backed.typing).toBe(false)
    expect(back(backed)).toBeNull()
  })

  test("multiple: space toggles, Enter confirms the toggled set; typed text joins it", () => {
    let state = startAnswer(
      question({
        questions: [
          {
            header: "Pick",
            prompt: "Which?",
            options: [
              { label: "a", description: "" },
              { label: "b", description: "" },
            ],
            multiple: true,
            custom: true,
          },
        ],
      }),
    )
    state = toggle(state)
    state = toggle(move(state, 1))
    expect(rows(state).filter((row) => row.kind === "option" && row.checked)).toHaveLength(2)
    state = toggle(state)
    expect(state.chosen[0]).toEqual(["a"])
    const typing = toggle(move(state, 1))
    expect(typing.typing).toBe(true)
    expect(submitText(typing, "c").submit).toEqual([["a", "c"]])
  })

  test("several questions advance one by one and submit together", () => {
    let state = startAnswer(
      question({
        questions: [
          { header: "One", prompt: "1?", options: [{ label: "x", description: "" }], multiple: false, custom: false },
          {
            header: "Two",
            prompt: "2?",
            options: [
              { label: "y", description: "" },
              { label: "z", description: "" },
            ],
            multiple: false,
            custom: false,
          },
        ],
      }),
    )
    const first = confirm(state)
    expect(first.submit).toBeUndefined()
    expect(first.state.index).toBe(1)
    state = move(first.state, 1)
    expect(confirm(state).submit).toEqual([["x"], ["z"]])
    expect(back(first.state)!.index).toBe(0)
  })
})

describe("formAnswer", () => {
  const fields: FormField[] = [
    {
      key: "colour",
      type: "string",
      options: [
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
      ],
      custom: true,
    },
    {
      key: "tags",
      type: "multiselect",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    },
    { key: "ok", type: "boolean" },
    { key: "count", type: "integer", required: true },
    { key: "docs", type: "external", url: "https://example.com" },
  ]

  test("maps labels to option values per field type", () => {
    expect(formAnswer(fields, [["Blue"], ["A", "B"], ["yes"], ["3"], []])).toEqual({
      answer: { colour: "blue", tags: ["a", "b"], ok: true, count: 3 },
    })
    expect(formAnswer(fields, [["green"], [], ["no"], ["1"]])).toEqual({
      answer: { colour: "green", ok: false, count: 1 },
    })
  })

  test("rejects answers the field cannot take", () => {
    expect(formAnswer(fields, [["Red"], [], ["yes"], ["1.5"]])).toHaveProperty("error")
    expect(formAnswer(fields, [["Red"], [], ["yes"], []])).toHaveProperty("error")
  })
})

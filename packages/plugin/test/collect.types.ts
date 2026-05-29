/**
 * Type-level proof that `ctx.collect()` **narrows** `(T | null)[]` to `T[]` (error model D9 AC: verified by
 * `tsc`, not only at runtime). This file is compiled by `tsc --build` (the plugin tsconfig includes `test`)
 * but is NOT a `*.test.ts`, so `bun test` skips it. It contains no runtime assertions: if `collect` ever
 * stopped narrowing, the GREEN lines below fail to compile and `bun run typecheck` breaks.
 *
 * The `@ts-expect-error` control lines are load-bearing: they prove the checks have teeth (the same access on
 * the un-narrowed input array is genuinely a type error). If narrowing were a no-op, those `@ts-expect-error`
 * directives would become *unused* — which `tsc` also reports as an error — so the fixture fails either way.
 */
import { createEngineState, createWorkflowContext } from "../src/context"
import { makeFakeClient } from "./fake-client"

const ctx = createWorkflowContext({
  client: makeFakeClient(),
  parentSessionID: "p",
  args: undefined,
  state: createEngineState(),
})

interface Finding {
  title: string
}

declare const maybeFindings: Array<Finding | null>
declare const maybeStrings: Array<string | null>

// GREEN — narrowed to Finding[]: a member access on the element needs no null-guard.
const findings = ctx.collect(maybeFindings)
findings.forEach((f) => f.title.toUpperCase())
const _assignableToFindingArray: Finding[] = findings

// CONTROL — the *input* is still (Finding | null)[]; the same access IS a type error (proves teeth).
// @ts-expect-error — `f` is possibly null here, so `.title` is rejected.
maybeFindings.forEach((f) => f.title.toUpperCase())

// GREEN — narrowed to string[].
const strings = ctx.collect(maybeStrings)
const _assignableToStringArray: string[] = strings

// CONTROL — collect's element type must exclude null: pushing a null is a type error. If collect ever
// returned `(string | null)[]` again, this push would be allowed and the `@ts-expect-error` would go unused
// (also a tsc error) — so the fixture fails either way.
// @ts-expect-error — `null` is not assignable to a narrowed `string` element.
strings.push(null)

// Reference the bindings so `noUnusedLocals`-style checks (if ever enabled) stay satisfied.
void _assignableToFindingArray
void _assignableToStringArray

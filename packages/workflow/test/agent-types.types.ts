/**
 * Type-level proof that {@link AgentFn} carries the schema's inferred type through to its return (the
 * structured-output AC: "typed as the schema's inferred type", verified by `tsc`, not only at runtime). This
 * file is compiled by `tsc --build` (the workflow tsconfig includes `test`) but is NOT a `*.test.ts`, so
 * `bun test` skips it. It has no runtime assertions: if the conditional return type ever stopped threading
 * the schema, the GREEN lines fail to compile and `bun run typecheck` breaks.
 *
 * The `@ts-expect-error` control lines are load-bearing: they prove the checks have teeth. If the type
 * collapsed (e.g. `agent()` returned `any`), those directives would become *unused* — which `tsc` also
 * reports as an error — so the fixture fails either way.
 */
import type { AgentFn } from "../src/index"
import { z } from "../src/index"

declare const agent: AgentFn

const Finding = z.object({ title: z.string(), score: z.number() })

async function proof() {
  // GREEN — no schema: resolves to `string | null`.
  const text = await agent("summarise")
  if (text !== null) text.toUpperCase()

  // GREEN — with schema: resolves to `z.infer<typeof Finding> | null`; fields are typed.
  const finding = await agent("rate it", { schema: Finding })
  if (finding !== null) {
    finding.title.toUpperCase()
    const _n: number = finding.score
    void _n
  }

  // CONTROL — the no-schema result is `string`, so a struct field access IS a type error (proves teeth).
  // @ts-expect-error — `text` is a string, it has no `.title`.
  if (text !== null) text.title

  // CONTROL — the schema result is the inferred object, NOT a string (proves the branch actually switched).
  // @ts-expect-error — `finding` is an object, it has no string method `.toUpperCase`.
  if (finding !== null) finding.toUpperCase()

  // CONTROL — `score` is a number, not a string: assigning it to a string is a type error.
  if (finding !== null) {
    // @ts-expect-error — number is not assignable to string.
    const _s: string = finding.score
    void _s
  }
}

void proof

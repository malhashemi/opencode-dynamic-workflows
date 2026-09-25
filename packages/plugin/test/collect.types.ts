/**
 * Type-level proof that `ctx.collect()` narrows `(T | null)[]` to `T[]` (compiled by `tsc --build`, skipped by
 * `bun test`). The `@ts-expect-error` controls prove the checks have teeth.
 */
import { makeCtx } from "./helpers"

const { ctx } = makeCtx()

interface Finding {
  title: string
}

declare const maybeFindings: Array<Finding | null>
declare const maybeStrings: Array<string | null>

const findings = ctx.collect(maybeFindings)
findings.forEach((f) => f.title.toUpperCase())
const _assignableToFindingArray: Finding[] = findings

// @ts-expect-error — `f` is possibly null here, so `.title` is rejected.
maybeFindings.forEach((f) => f.title.toUpperCase())

const strings = ctx.collect(maybeStrings)
const _assignableToStringArray: string[] = strings

// @ts-expect-error — `null` is not assignable to a narrowed `string` element.
strings.push(null)

void _assignableToFindingArray
void _assignableToStringArray

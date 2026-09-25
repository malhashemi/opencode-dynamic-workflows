import { createEngineState, createWorkflowContext, type CreateContextInput } from "../src/context"
import { createUnitIndex, type UnitIndex } from "../src/units"
import { createFakeHost, type FakeHost, type FakeHostOptions } from "./fake-host"

export interface TestCtx {
  ctx: ReturnType<typeof createWorkflowContext<unknown>>
  state: ReturnType<typeof createEngineState>
  host: FakeHost
  index: UnitIndex
}

/** A context over the fake host, with every engine requirement filled in. */
export function makeCtx(
  hostOptions: FakeHostOptions = {},
  overrides: Partial<Omit<CreateContextInput<unknown>, "host" | "index" | "state">> = {},
): TestCtx {
  const index = createUnitIndex()
  const host = createFakeHost(index, hostOptions)
  const state = createEngineState()
  const ctx = createWorkflowContext<unknown>({
    host,
    index,
    runId: "run-test",
    workflow: "test",
    location: "/project",
    parentSessionID: "ses_parent",
    args: undefined,
    state,
    ...overrides,
  })
  return { ctx, state, host, index }
}

import type {
  ActivityEntry,
  PendingInteraction,
  ProtocolEvent,
  ResolvedInteraction,
  Run,
  RunHeader,
  Unit,
  Usage,
} from "@malhashemi/opencode-dynamic-workflows/protocol"

export const LOCATION = "/tmp/project"

export function usage(output = 0, cost = 0): Usage {
  return { tokens: { input: 0, output, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost }
}

export function run(overrides: Partial<Run> = {}): Run {
  return {
    runId: "run-1",
    workflow: { key: "fanout", name: "fanout", description: "d", provenance: "durable" },
    location: LOCATION,
    parentSessionID: "ses_parent",
    status: "running",
    waiting: false,
    background: true,
    phases: ["facts", "rate"],
    phasesDeclared: true,
    currentPhase: "facts",
    units: [],
    logs: [],
    errors: [],
    interactions: [],
    resolved: [],
    usage: usage(),
    tokensSpent: 0,
    budget: { total: null, hard: false },
    startedAt: 1000,
    endedAt: null,
    resultPreview: null,
    resumeOf: null,
    cleanup: "none",
    revision: 5,
    ...overrides,
  }
}

export function unit(overrides: Partial<Unit> = {}): Unit {
  return {
    unitId: "u1",
    runId: "run-1",
    ordinal: 1,
    label: "fact 1",
    subagent: "general",
    phase: "facts",
    status: "running",
    sessionID: "ses_u1",
    location: LOCATION,
    prompt: "p",
    model: { requested: null, resolved: "google/flash" },
    schema: false,
    resultPath: null,
    attempts: [],
    usage: usage(),
    startedAt: 1100,
    endedAt: null,
    ...overrides,
  }
}

export function pending(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    interactionId: "i1",
    runId: "run-1",
    unitId: null,
    kind: "question",
    origin: "script",
    sessionID: "ses_parent",
    phase: "facts",
    questions: [
      {
        header: "Go?",
        prompt: "Proceed?",
        options: [
          { label: "Yes", description: "" },
          { label: "No", description: "" },
        ],
        multiple: false,
        custom: false,
      },
    ],
    raisedAt: 1200,
    graceEndsAt: null,
    ...overrides,
  }
}

export function resolved(from: PendingInteraction, answers: string[][]): ResolvedInteraction {
  const { graceEndsAt: _grace, ...rest } = from
  return { ...rest, answers, by: "human", outcome: "answered", resolvedAt: 1300 }
}

export function header(of: Run): RunHeader {
  const { units: _u, logs: _l, interactions: _i, resolved: _r, ...rest } = of
  return rest
}

let seq = 0
export function event(type: ProtocolEvent["type"], revision: number, data: unknown, runId = "run-1"): ProtocolEvent {
  return { protocol: 1, seq: ++seq, time: Date.now(), location: LOCATION, runId, type, revision, data }
}

export function activity(message: string, time = 1500, kind: ActivityEntry["kind"] = "log"): ActivityEntry {
  return { kind, message, time, unitId: null }
}

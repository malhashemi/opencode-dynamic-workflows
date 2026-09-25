import type { LibraryEntry, PendingInteraction, ProtocolEvent, Run, Unit } from "../../src/protocol"
import { emptyUsage } from "../../src/protocol"
import { newRun, runHeader, toLibraryEntry } from "../../src/runs"

export const LOCATION = "/tmp/project"

export function run(overrides: Partial<Run> = {}): Run {
  return {
    ...newRun({
      runId: overrides.runId ?? "run-1",
      workflow: { key: "review", name: "review", description: "reviews things", provenance: "durable" },
      location: LOCATION,
      parentSessionID: "ses_parent",
      phases: ["plan", "work"],
      startedAt: 1_000,
    }),
    revision: 1,
    ...overrides,
  }
}

export function unit(overrides: Partial<Unit> = {}): Unit {
  return {
    unitId: "u1",
    runId: "run-1",
    ordinal: 0,
    label: null,
    subagent: "general",
    phase: "plan",
    status: "running",
    sessionID: "ses_u1",
    location: LOCATION,
    prompt: "Say hi",
    model: { requested: null, resolved: "google/gemini" },
    schema: false,
    resultPath: null,
    attempts: [],
    usage: emptyUsage(),
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  }
}

export function question(overrides: Partial<PendingInteraction> = {}): PendingInteraction {
  return {
    interactionId: "i1",
    runId: "run-1",
    unitId: null,
    kind: "question",
    origin: "script",
    sessionID: "ses_parent",
    phase: null,
    questions: [
      {
        header: "Depth",
        prompt: "How deep?",
        options: [
          { label: "Fast", description: "quick" },
          { label: "Thorough", description: "slow" },
        ],
        multiple: false,
        custom: true,
      },
    ],
    raisedAt: 2_000,
    graceEndsAt: null,
    ...overrides,
  }
}

export function entry(r: Run, live = true): LibraryEntry {
  return toLibraryEntry(r, live)
}

let seq = 0
export function resetSeq(value = 0) {
  seq = value
}

export function event(type: ProtocolEvent["type"], data: unknown, options: { runId?: string; revision?: number; seq?: number; location?: string } = {}): ProtocolEvent {
  return {
    protocol: 1,
    seq: options.seq ?? ++seq,
    time: 0,
    location: options.location ?? LOCATION,
    runId: options.runId ?? "run-1",
    type,
    revision: options.revision ?? 0,
    data,
  }
}

export { runHeader }

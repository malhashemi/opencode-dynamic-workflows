/**
 * The TUI's narrow, typed view of the workflow RPC (protocol v1).
 *
 * The OpenCode client builds an RPC client from a definition's id and method names only (no client-side
 * validation), so the TUI passes the server's own {@link WorkflowRpc} and casts the result to this interface once,
 * here. Every method is bound to the TUI's location. The same interface is what the unit tests fake.
 */
import type {
  ActivityEntry,
  GetTranscriptOutput,
  InfoOutput,
  LibraryEntry,
  ListRunsInput,
  ListWorkflowsOutput,
  ProtocolError,
  ProtocolEvent,
  Run,
  RunStatus,
  Unit,
} from "../protocol"

export interface WorkflowApi {
  info(): Promise<InfoOutput>
  listRuns(input?: ListRunsInput): Promise<{ runs: LibraryEntry[] }>
  getRun(input: { runId: string }): Promise<{ run: Run; live: boolean }>
  getUnit(input: { runId: string; unitId: string }): Promise<{ unit: Unit }>
  getResult(input: { runId: string }): Promise<{ runId: string; status: RunStatus; result: unknown }>
  getTranscript(input: { runId: string; unitId: string }): Promise<GetTranscriptOutput>
  getActivity(input: { runId: string }): Promise<{ entries: ActivityEntry[] }>
  listWorkflows(): Promise<ListWorkflowsOutput>
  startRun(input: { name?: string; source?: string; args?: unknown; parentSessionID?: string; requestId?: string }): Promise<{ runId: string }>
  stopRun(input: { runId: string }): Promise<{ ok: true }>
  stopUnit(input: { runId: string; unitId: string }): Promise<{ ok: true }>
  restartUnit(input: { runId: string; unitId: string }): Promise<{ ok: true }>
  resumeRun(input: { runId: string; rerunFailed?: boolean }): Promise<{ runId: string }>
  replyInteraction(input: { runId: string; interactionId: string; answers: string[][] }): Promise<{ ok: true }>
  cancelInteraction(input: { runId: string; interactionId: string }): Promise<{ ok: true }>
  saveRun(input: { runId: string; name?: string }): Promise<{ key: string; path: string }>
  cleanupRun(input: { runId: string; deleted?: string[] }): Promise<{ deleted: number; pending: number }>
  attach(input: { surface: string; sessionID?: string; ttlMs?: number }): Promise<{ ok: true }>
  detach(input: { surface: string }): Promise<{ ok: true }>
  eventsSince(input: { after?: number; epoch?: string }): Promise<{ events: ProtocolEvent[]; complete: boolean; latest: number; epoch?: string }>
  pair(): Promise<{ code: string; expiresAt: number; url: string }>
}

/** The RPC event stream, as the OpenCode client delivers it (`rpc.workflow.event`). */
export type EventStream = (signal: AbortSignal) => AsyncIterable<{ data: ProtocolEvent }>

type Location = { directory: string; workspaceID?: string }

interface RawRpcClient {
  readonly events: { subscribe(name: "event", options?: { signal?: AbortSignal }): AsyncIterable<{ data: unknown }> }
  readonly [method: string]: unknown
}

const METHODS = [
  "info",
  "listRuns",
  "getRun",
  "getUnit",
  "getResult",
  "getTranscript",
  "getActivity",
  "listWorkflows",
  "startRun",
  "stopRun",
  "stopUnit",
  "restartUnit",
  "resumeRun",
  "replyInteraction",
  "cancelInteraction",
  "saveRun",
  "cleanupRun",
  "attach",
  "detach",
  "eventsSince",
  "pair",
] as const satisfies ReadonlyArray<keyof WorkflowApi>

/** Bind a raw RPC client (from `client.rpc(WorkflowRpc)`) to one location. */
export function bindApi(raw: unknown, location: Location | undefined): { api: WorkflowApi; events: EventStream } {
  const client = raw as RawRpcClient
  const api = Object.fromEntries(
    METHODS.map((name) => {
      const method = client[name] as (input: unknown, options?: { location?: Location }) => Promise<unknown>
      return [name, (input: unknown = {}) => method(input, location ? { location } : undefined)]
    }),
  ) as unknown as WorkflowApi
  const events: EventStream = (signal) => client.events.subscribe("event", { signal }) as AsyncIterable<{ data: ProtocolEvent }>
  return { api, events }
}

/** A readable message for an RPC failure: the protocol error's message when there is one. */
export function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const data = (error as { data?: Partial<ProtocolError> }).data
    if (data && typeof data.message === "string") return data.message
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return String(error)
}

/**
 * The workflow RPC contract — protocol v1 over OpenCode's plugin RPC (`POST /api/rpc/workflow/<method>`,
 * events `rpc.workflow.event` on `/api/event`).
 *
 * Import it from `opencode-dynamic-workflows/rpc` and pass it to an OpenCode client:
 *
 *     const workflow = client.rpc(WorkflowRpc)
 *     const { runs } = await workflow.listRuns({}, { location: { directory } })
 *     workflow.events.on("event", (e) => apply(e.data))
 *
 * RPC is how the TUI plugin reaches the service without opening a port. The Gateway (HTTP + SSE) serves the
 * same methods and the same event envelopes to the web app and third parties. Every method can fail with the
 * declared `workflow` error, whose data is a protocol `ProtocolError` (`code`, `message`, `retryable`).
 */
import { Rpc } from "@opencode/plugin/rpc"
import { z } from "zod"
import {
  ActivityOutput,
  AttachInput,
  CleanupRunOutput,
  EventsSinceInput,
  EventsSinceOutput,
  GetResultOutput,
  GetTranscriptOutput,
  GetRunOutput,
  GetUnitOutput,
  InfoOutput,
  InteractionRef,
  ListRunsInput,
  ListRunsOutput,
  ListWorkflowsOutput,
  OkOutput,
  ProtocolError,
  ProtocolEvent,
  ReplyInteractionInput,
  ResumeRunInput,
  RunRef,
  SaveRunInput,
  SaveRunOutput,
  StartRunInput,
  StartRunOutput,
  UnitRef,
} from "../protocol"

const errors = { workflow: ProtocolError }
const Empty = z.object({}).loose()

export const WorkflowRpc = Rpc.define({
  id: "workflow",
  methods: {
    info: { input: Empty, output: InfoOutput, errors },
    listRuns: { input: ListRunsInput, output: ListRunsOutput, errors },
    getRun: { input: RunRef, output: GetRunOutput, errors },
    getUnit: { input: UnitRef, output: GetUnitOutput, errors },
    getResult: { input: RunRef, output: GetResultOutput, errors },
    getTranscript: { input: UnitRef, output: GetTranscriptOutput, errors },
    getActivity: { input: RunRef, output: ActivityOutput, errors },
    listWorkflows: { input: Empty, output: ListWorkflowsOutput, errors },
    startRun: { input: StartRunInput, output: StartRunOutput, errors },
    stopRun: { input: RunRef, output: OkOutput, errors },
    stopUnit: { input: UnitRef, output: OkOutput, errors },
    restartUnit: { input: UnitRef, output: OkOutput, errors },
    resumeRun: { input: ResumeRunInput, output: StartRunOutput, errors },
    replyInteraction: { input: ReplyInteractionInput, output: OkOutput, errors },
    cancelInteraction: { input: InteractionRef, output: OkOutput, errors },
    saveRun: { input: SaveRunInput, output: SaveRunOutput, errors },
    cleanupRun: {
      input: RunRef.extend({ deleted: z.array(z.string()).optional() }),
      output: CleanupRunOutput,
      errors,
    },
    attach: { input: AttachInput, output: OkOutput, errors },
    /** The surface closed: stop treating it as a person watching. */
    detach: { input: z.object({ surface: z.string() }), output: OkOutput, errors },
    eventsSince: { input: EventsSinceInput, output: EventsSinceOutput, errors },
    /** A one-use pairing code for a remote browser (the Gateway's `POST /v1/pair`). */
    pair: {
      input: Empty,
      output: z.object({ code: z.string(), expiresAt: z.number(), url: z.string() }),
      errors,
    },
  },
  events: {
    /** Every protocol event of every location this plugin serves; filter by `data.location`. */
    event: { schema: ProtocolEvent },
  },
})

export type WorkflowRpcDefinition = typeof WorkflowRpc

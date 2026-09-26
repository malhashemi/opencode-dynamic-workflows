/**
 * The Gateway's HTTP API as an OpenAPI 3.1 document, built from the protocol's zod schemas (the same source as the
 * JSON Schemas and the RPC contract). Served at `GET /v1/openapi.json` and written to `docs/protocol/openapi.json`.
 *
 * `info.version` is the protocol version, not the package version: the document changes only when the API does.
 */
import { z } from "zod"

import {
  ActivityOutput,
  CleanupRunOutput,
  GatewayInfoOutput,
  GetResultOutput,
  GetRunOutput,
  GetTranscriptOutput,
  GetUnitOutput,
  ListRunsOutput,
  ListWorkflowsOutput,
  OkOutput,
  PairInput,
  PairOutput,
  ProtocolError,
  ProtocolEvent,
  PROTOCOL_VERSION,
  RunStatus,
  SaveRunOutput,
  StartRunInput,
  StartRunOutput,
} from "./index"

type Schema = z.ZodType
type Json = Record<string, unknown>

/** The schemas the document names; each becomes `#/components/schemas/<name>`. */
const COMPONENTS: Record<string, Schema> = {
  GatewayInfoOutput,
  ListRunsOutput,
  GetRunOutput,
  GetUnitOutput,
  GetResultOutput,
  ActivityOutput,
  GetTranscriptOutput,
  ListWorkflowsOutput,
  StartRunInput,
  StartRunOutput,
  ResumeRunBody: z.object({
    /** Re-run Units that failed or were stopped instead of replaying them as failures. Default true. */
    rerunFailed: z.boolean().optional(),
  }),
  SaveRunBody: z.object({ name: z.string().optional() }),
  SaveRunOutput,
  CleanupRunBody: z.object({ deleted: z.array(z.string()).optional() }),
  CleanupRunOutput,
  ReplyBody: z.object({ answers: z.array(z.array(z.string())) }),
  OkOutput,
  PairInput,
  PairOutput,
  ProtocolEvent,
  ProtocolError: z.object({ error: ProtocolError }),
}

const ref = (name: keyof typeof COMPONENTS | string) => ({ $ref: `#/components/schemas/${name}` })

const jsonBody = (name: string) => ({ required: true, content: { "application/json": { schema: ref(name) } } })
const ok = (name: string, status = "200", description = "OK") => ({
  [status]: { description, content: { "application/json": { schema: ref(name) } } },
})
const errors = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [
      String(code),
      {
        description: ERROR_TEXT[code] ?? "Error",
        content: { "application/json": { schema: ref("ProtocolError") } },
      },
    ]),
  )
const ERROR_TEXT: Record<number, string> = {
  400: "invalid_args: the request does not match the schema",
  401: "unauthorized: a token is missing, unknown or revoked",
  403: "forbidden: the token lacks the scope, or the origin or host is not allowed",
  404: "not_found: no such Run, Unit, Workflow or route",
  409: "conflict or invalid_state: the Run or interaction is not in a state for this",
  429: "rate_limited",
}

const param = (name: string, description: string, required = true) => ({
  name,
  in: "path",
  required,
  description,
  schema: { type: "string" },
})
const location = {
  name: "location",
  in: "query",
  required: false,
  description:
    "The project directory (an OpenCode location) this call is for. Needed when the OpenCode process serves more than one; see `GET /v1/info`.",
  schema: { type: "string" },
}
const runId = param("runId", "The Run's id.")
const unitId = param("unitId", "The Unit's id.")
const interactionId = param("interactionId", "The pending interaction's id.")

/**
 * Reads need a token with `read` scope. A client on the same machine as a loopback Gateway may omit it: OpenAPI
 * cannot express a network-dependent exception, so it is documented (in `info` and the bearer scheme) instead.
 */
const READ = [{ bearer: [] }]
/** Control actions: always a token with `control` scope (or `gateway.auth: "none"` on a loopback bind). */
const CONTROL = [{ bearer: [] }]

const PATHS: Json = {
  "/v1/openapi.json": {
    get: {
      operationId: "openapi",
      summary: "This document",
      security: READ,
      responses: {
        "200": { description: "The OpenAPI document", content: { "application/json": {} } },
        ...errors(401),
      },
    },
  },
  "/v1/info": {
    get: {
      operationId: "info",
      summary: "Versions, capabilities and limits of every location this process serves, and who the caller is",
      security: READ,
      responses: { ...ok("GatewayInfoOutput"), ...errors(401) },
    },
  },
  "/v1/events": {
    get: {
      operationId: "events",
      summary: "The event stream of one location (Server-Sent Events)",
      description: [
        "Each SSE message has `id: <epoch>.<seq>`, `event: <type>` and `data: <ProtocolEvent>` (JSON).",
        "Reconnect with the `Last-Event-ID` header (or `?after=<epoch>.<seq>`) to receive what was missed; when the",
        "gap cannot be filled (the service restarted, or the buffer moved on) a `resync.required` event arrives:",
        "re-read `GET /v1/runs` and the Runs you show.",
        "",
        "An open stream also marks the location as **attached**: while one is open, questions and inline-Workflow",
        "approvals wait for an answer instead of being refused or taking their fallback.",
      ].join("\n"),
      security: READ,
      parameters: [
        location,
        {
          name: "after",
          in: "query",
          required: false,
          description: "Resume after this event id (`<epoch>.<seq>`); the `Last-Event-ID` header does the same.",
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "An endless `text/event-stream`; every `data` line is a ProtocolEvent",
          content: { "text/event-stream": { schema: ref("ProtocolEvent") } },
        },
        ...errors(401, 404),
      },
    },
  },
  "/v1/workflows": {
    get: {
      operationId: "listWorkflows",
      summary: "The durable (saved) Workflows of a location, with each one's args JSON Schema",
      security: READ,
      parameters: [location],
      responses: { ...ok("ListWorkflowsOutput"), ...errors(401, 404) },
    },
  },
  "/v1/runs": {
    get: {
      operationId: "listRuns",
      summary: "Runs, newest first (live and journaled)",
      security: READ,
      parameters: [
        location,
        {
          name: "status",
          in: "query",
          required: false,
          description: "Only Runs in these states (repeat the parameter for several).",
          schema: { type: "array", items: z.toJSONSchema(RunStatus) },
          style: "form",
          explode: true,
        },
        { name: "search", in: "query", required: false, schema: { type: "string" } },
        { name: "parentSessionID", in: "query", required: false, schema: { type: "string" } },
        {
          name: "since",
          in: "query",
          required: false,
          description: "Only Runs started at or after this time (ms since the epoch).",
          schema: { type: "number" },
        },
        { name: "limit", in: "query", required: false, schema: { type: "number", default: 200 } },
      ],
      responses: { ...ok("ListRunsOutput"), ...errors(400, 401) },
    },
    post: {
      operationId: "startRun",
      summary: "Start a Run: a durable Workflow by `name`, or inline `source`",
      description:
        "Returns at once; follow the Run on the event stream. Inline source needs approval unless the project allows it (plugin option `inline`); the approval is a pending interaction on the Run.",
      security: CONTROL,
      parameters: [location],
      requestBody: jsonBody("StartRunInput"),
      responses: {
        ...ok("StartRunOutput", "202", "Accepted: the Run is starting"),
        ...errors(400, 401, 403, 404, 429),
      },
    },
  },
  "/v1/runs/{runId}": {
    get: {
      operationId: "getRun",
      summary: "A Run in full (Units' outputs may be elided; fetch the Unit for the whole value)",
      security: READ,
      parameters: [runId],
      responses: { ...ok("GetRunOutput"), ...errors(401, 404) },
    },
  },
  "/v1/runs/{runId}/result": {
    get: {
      operationId: "getResult",
      summary: "What the Workflow returned",
      security: READ,
      parameters: [runId],
      responses: { ...ok("GetResultOutput"), ...errors(401, 404, 409) },
    },
  },
  "/v1/runs/{runId}/activity": {
    get: {
      operationId: "getActivity",
      summary: "The Run's activity: logs, phases, engine and capability lines",
      security: READ,
      parameters: [runId],
      responses: { ...ok("ActivityOutput"), ...errors(401, 404) },
    },
  },
  "/v1/runs/{runId}/units/{unitId}": {
    get: {
      operationId: "getUnit",
      summary: "One Unit with its whole output",
      security: READ,
      parameters: [runId, unitId],
      responses: { ...ok("GetUnitOutput"), ...errors(401, 404) },
    },
  },
  "/v1/runs/{runId}/units/{unitId}/transcript": {
    get: {
      operationId: "getTranscript",
      summary: "The Unit's session: messages, reasoning and tool calls",
      security: READ,
      parameters: [runId, unitId],
      responses: { ...ok("GetTranscriptOutput"), ...errors(401, 404) },
    },
  },
  "/v1/runs/{runId}/stop": {
    post: {
      operationId: "stopRun",
      summary: "Stop a Run (running Units are interrupted)",
      security: CONTROL,
      parameters: [runId],
      responses: { ...ok("OkOutput"), ...errors(401, 403, 404, 409, 429) },
    },
  },
  "/v1/runs/{runId}/resume": {
    post: {
      operationId: "resumeRun",
      summary: "Resume a finished Run from its journal as a new Run (finished Units replay)",
      security: CONTROL,
      parameters: [runId],
      requestBody: { ...jsonBody("ResumeRunBody"), required: false },
      responses: { ...ok("StartRunOutput", "202", "Accepted: the new Run is starting"), ...errors(401, 403, 404, 409) },
    },
  },
  "/v1/runs/{runId}/save": {
    post: {
      operationId: "saveRun",
      summary: "Save the Run's script as a durable Workflow",
      description:
        "Inline source that no person approved to run needs approval to be saved (a saved Workflow runs without approval): the call waits for it.",
      security: CONTROL,
      parameters: [runId],
      requestBody: { ...jsonBody("SaveRunBody"), required: false },
      responses: { ...ok("SaveRunOutput"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/v1/runs/{runId}/cleanup": {
    post: {
      operationId: "cleanupRun",
      summary: "Mark a finished Run's Unit sessions for deletion, or record the ones a client deleted",
      security: CONTROL,
      parameters: [runId],
      requestBody: { ...jsonBody("CleanupRunBody"), required: false },
      responses: { ...ok("CleanupRunOutput"), ...errors(401, 403, 404, 409) },
    },
  },
  "/v1/runs/{runId}/units/{unitId}/stop": {
    post: {
      operationId: "stopUnit",
      summary: "Stop one Unit (it resolves to null in the script)",
      security: CONTROL,
      parameters: [runId, unitId],
      responses: { ...ok("OkOutput"), ...errors(401, 403, 404, 409) },
    },
  },
  "/v1/runs/{runId}/units/{unitId}/restart": {
    post: {
      operationId: "restartUnit",
      summary: "Restart one Unit in a fresh session",
      security: CONTROL,
      parameters: [runId, unitId],
      responses: { ...ok("OkOutput"), ...errors(401, 403, 404, 409) },
    },
  },
  "/v1/runs/{runId}/interactions/{interactionId}/reply": {
    post: {
      operationId: "replyInteraction",
      summary: "Answer a pending question, permission request or inline-Workflow approval",
      description:
        "`answers` has one entry per question, each a list of chosen option labels (or free text where the question allows `custom`). An approval's options are `Run once`, `Always for this project` and `Reject` (to save: `Save`, `Reject`).",
      security: CONTROL,
      parameters: [runId, interactionId],
      requestBody: jsonBody("ReplyBody"),
      responses: { ...ok("OkOutput"), ...errors(400, 401, 403, 404, 409) },
    },
  },
  "/v1/runs/{runId}/interactions/{interactionId}/cancel": {
    post: {
      operationId: "cancelInteraction",
      summary: "Dismiss a pending interaction (a script question takes its fallback; an approval is refused)",
      security: CONTROL,
      parameters: [runId, interactionId],
      responses: { ...ok("OkOutput"), ...errors(401, 403, 404, 409) },
    },
  },
  "/v1/pair": {
    post: {
      operationId: "pair",
      summary: "Exchange a one-use pairing code (from `/workflows pair` in the TUI) for a token",
      security: [{}],
      requestBody: jsonBody("PairInput"),
      responses: { ...ok("PairOutput"), ...errors(401, 429) },
    },
  },
  "/v1/pair/local": {
    post: {
      operationId: "pairLocal",
      summary: "A browser on this machine, on the Gateway's own origin, pairs itself",
      security: [{}],
      responses: { ...ok("PairOutput"), ...errors(403) },
    },
  },
}

/** `serverUrl`: the Gateway serving the document (its real address); the committed copy uses the default. */
export function openApiDocument(serverUrl?: string): Json {
  return {
    openapi: "3.1.0",
    info: {
      title: "OpenCode dynamic workflows: Gateway API",
      version: `${PROTOCOL_VERSION}`,
      description: [
        "The HTTP + SSE face of the workflow protocol: start and follow Runs, answer questions and approvals, read",
        "results and transcripts. The same resources and commands are also OpenCode plugin RPC methods",
        "(`POST /api/rpc/workflow/<method>` on the OpenCode server), which an OpenCode client can use with its",
        "existing credentials. Guide: https://github.com/malhashemi/opencode-dynamic-workflows/blob/main/docs/integrating.md",
        "",
        "Within protocol v1 changes are additive only: new optional fields, event types and error codes. Ignore",
        "what you do not know.",
        "",
        "Auth: reads need a `read` token, except from the same machine to a loopback Gateway; every action (start,",
        "stop, answer, …) needs a `control` token. See the bearer scheme and the guide.",
      ].join("\n"),
      license: { name: "MIT", identifier: "MIT" },
    },
    servers: serverUrl
      ? [{ url: serverUrl.replace(/\/$/, ""), description: "This Gateway" }]
      : [{ url: "http://127.0.0.1:4320", description: "The default local Gateway (the next free port if taken)" }],
    security: READ,
    paths: PATHS,
    components: {
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description:
            "A device token from pairing: `read` scope for reads, `control` scope for every action. A client on the same machine as a loopback Gateway may read without one. Tokens never go in URLs.",
        },
      },
      schemas: Object.fromEntries(
        Object.entries(COMPONENTS).map(([name, schema]) => [
          name,
          z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }),
        ]),
      ),
    },
  }
}

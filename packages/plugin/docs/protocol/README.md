# Workflow protocol v1

The protocol is the one contract between the workflow engine and every client: the TUI plugin, the web app,
and third-party tools. It has two transports that carry the same resources, commands and events:

| Transport | Who uses it | Address |
| --- | --- | --- |
| OpenCode plugin RPC | the TUI plugin, any OpenCode client | `POST /api/rpc/workflow/<method>` on the OpenCode server; events on `/api/event` as `rpc.workflow.event` |
| Gateway (HTTP + SSE) | the web app, scripts, other machines | `http://127.0.0.1:4320/v1/…` by default (see [security](../security.md)) |

The zod definitions in `src/protocol/index.ts` are the source of truth. The JSON Schemas in
[`schemas/`](./schemas) are generated from them (`bun run script/protocol-schemas.ts`). TypeScript clients can
import the types from `@malhashemi/opencode-dynamic-workflows/protocol` and the RPC contract from
`@malhashemi/opencode-dynamic-workflows/rpc`.

## Versioning

- Every event carries `protocol: 1`. `info` reports the protocol version, the plugin version, the OpenCode
  version, the capabilities and the limits.
- Within v1, changes are additive only: new optional fields, new event types, new error codes, new
  `ActivityEntry.kind` values. Clients must ignore what they do not know.
- A breaking change creates v2. The engine's process-wide state is keyed by the protocol major version.

## Resources

| Resource | Schema | Notes |
| --- | --- | --- |
| Run | [`Run`](./schemas/Run.json) | One execution of a Workflow. `revision` increases on every change. |
| Unit | [`Unit`](./schemas/Unit.json) | One `agent()` call: one OpenCode session. `output` may be elided (`outputElided: true`); fetch the Unit for the whole value. |
| Interaction | [`PendingInteraction`](./schemas/PendingInteraction.json), [`ResolvedInteraction`](./schemas/ResolvedInteraction.json) | Something a Run waits on a person for. |
| Library entry | [`LibraryEntry`](./schemas/LibraryEntry.json) | The summary of a Run in lists (live and journaled). |
| Workflow listing | [`WorkflowListing`](./schemas/WorkflowListing.json) | A durable Workflow and its `args` JSON Schema. |
| Activity | [`ActivityEntry`](./schemas/ActivityEntry.json) | `log`, `phase`, `engine`, `capability` lines. |

### Run status

`queued` (created; waiting for inline approval) → `running` → one of `succeeded`, `failed`, `stopped`,
`interrupted` (the service died while it ran; resume it). `waiting` is true while an interaction is pending.

### Unit status

`queued` → `running` ⇄ `repairing` (the engine asks the Unit again for a valid typed result) → one of
`succeeded`, `failed`, `stopped`, `replayed` (a resumed Run took the value from the journal).
`resultPath` tells how the value was obtained: `text`, `tool` (`workflow_result`), `text-json`, `extract`,
`replay`.

### Interactions

| `kind` | `origin` | Answer with |
| --- | --- | --- |
| `question` | `script` (`ctx.ask`) | labels from the options; free text only where `custom` |
| `question` | `agent` (a Unit called `question`) | labels or free text |
| `question` with `form` | `agent` (a native OpenCode form) | only a client with OpenCode's form API (the TUI) |
| `permission` | `permission` | `Allow once`, `Always allow` or `Reject` |
| `approval` | `engine` (inline Workflow) | `Run once`, `Always for this project` or `Reject` |

`answers` has one entry per question; each entry is a list of labels. Cancelling (`cancelInteraction`) hands a
script question back to its fallback, dismisses a Unit's question, and rejects a permission or approval.

## Queries and commands

| RPC method | Gateway route | Result |
| --- | --- | --- |
| `info` | `GET /v1/info` | versions, capabilities, limits, Gateway URL (Gateway: every location) |
| `listRuns` | `GET /v1/runs?status=&search=&parentSessionID=&since=&limit=&location=` | `{ runs: LibraryEntry[] }` |
| `getRun` | `GET /v1/runs/:runId` | `{ run, live }` |
| `getUnit` | `GET /v1/runs/:runId/units/:unitId` | `{ unit }` with the whole output |
| `getTranscript` | `GET /v1/runs/:runId/units/:unitId/transcript` | `{ sessionID, messages, clipped }`: the Unit's session for display ([`TranscriptMessage`](./schemas/TranscriptMessage.json)) |
| `getResult` | `GET /v1/runs/:runId/result` | `{ runId, status, result }`; `invalid_state` while running |
| `getActivity` | `GET /v1/runs/:runId/activity` | `{ entries }` |
| `listWorkflows` | `GET /v1/workflows?location=` | workflows, key collisions, load failures |
| `startRun` | `POST /v1/runs?location=` `{ name \| source, args, requestId? }` | `{ runId }` (inline source asks for approval) |
| `stopRun` | `POST /v1/runs/:runId/stop` | `{ ok }` |
| `stopUnit` | `POST /v1/runs/:runId/units/:unitId/stop` | `{ ok }` |
| `restartUnit` | `POST /v1/runs/:runId/units/:unitId/restart` | `{ ok }`: the running Unit starts again in its own session |
| `resumeRun` | `POST /v1/runs/:runId/resume` `{ rerunFailed? }` | `{ runId }` of the new Run (`resumeOf` points back) |
| `replyInteraction` | `POST /v1/runs/:runId/interactions/:id/reply` `{ answers }` | `{ ok }` |
| `cancelInteraction` | `POST /v1/runs/:runId/interactions/:id/cancel` | `{ ok }` |
| `saveRun` | `POST /v1/runs/:runId/save` `{ name? }` | `{ key, path }` of the new durable Workflow |
| `cleanupRun` | `POST /v1/runs/:runId/cleanup` `{ deleted? }` | `{ deleted, pending }` |
| `attach` | – | `{ ok }`: "a person is watching" for `ttlMs` (TUI heartbeat), optionally with the `sessionID` in view |
| `detach` | – | `{ ok }`: that surface closed |
| `eventsSince` | `GET /v1/events` with `Last-Event-ID` | missed events, or `complete: false` |
| `pair` | – (Gateway: `POST /v1/pair`) | a one-use pairing code for a remote browser |

`startRun` with the same `requestId` returns the same `runId` (safe retry).

## Events

Every event is a [`ProtocolEvent`](./schemas/ProtocolEvent.json):

```json
{ "protocol": 1, "seq": 42, "time": 1790366413270, "location": "/path/to/project", "runId": "…",
  "type": "unit.updated", "revision": 7, "data": { … } }
```

| `type` | `data` |
| --- | --- |
| `run.started` | `Run` (outputs elided) |
| `run.updated`, `run.ended` | `RunHeader` (a Run without its units, logs and interactions) |
| `unit.updated` | `Unit` (output elided when large) |
| `interaction.pending` | `PendingInteraction` |
| `interaction.resolved` | `ResolvedInteraction` |
| `activity.appended` | `ActivityEntry` |
| `library.changed` | `LibraryEntry` (location-wide; `runId` is empty) |
| `resync.required` | `{ reason }` (location-wide) |

`seq` is per location and increases by one per event. `revision` is per Run.

On the Gateway, `GET /v1/events?location=<dir>` is a Server-Sent Events stream: `id:` is the `seq`, `event:`
is the `type`, `data:` is the whole event. Reconnect with `Last-Event-ID` to receive what you missed.

### The client rule

1. Read a snapshot (`getRun`, `listRuns`).
2. Subscribe to events.
3. Apply an event to a Run only when its `revision` is greater than the Run you hold.
4. On a gap in `seq`, on `resync.required`, or when `eventsSince` answers `complete: false`, read the
   snapshots again.

The engine keeps the last 5 000 events per location for catch-up.

## Errors

Every failure is a [`ProtocolError`](./schemas/ProtocolError.json): `{ code, message, retryable, details? }`.
Over RPC it arrives as the declared `workflow` error; over the Gateway as `{ "error": … }` with an HTTP status:

| `code` | HTTP | Meaning |
| --- | --- | --- |
| `not_found` | 404 | no such Run, Unit, Workflow or location |
| `invalid_args` | 400 | the request (or the Workflow's `args`) is not valid |
| `invalid_state` | 409 | the Run or Unit is not in a state for that action |
| `conflict` | 409 | the interaction is settled, or the answer does not fit; a file exists |
| `unauthorized` | 401 | a control action (or a remote read) without a valid token |
| `forbidden` | 403 | bad `Host` or `Origin`, or a token without the scope |
| `rate_limited` | 429 | too many requests |
| `unsupported` | 501 | the feature is off (for example the Gateway) |
| `internal` | 500 | a bug; the message says what failed |

## A minimal client

```ts
import { OpenCode } from "@opencode/client"
import { WorkflowRpc } from "@malhashemi/opencode-dynamic-workflows/rpc"

const client = OpenCode.make({ baseUrl: "http://127.0.0.1:4096", headers: { "x-opencode-directory": "/my/project" } })
const workflow = client.rpc(WorkflowRpc)
const { runId } = await workflow.startRun({ name: "review-files", args: { files: ["src/a.ts"] } })
workflow.events.on("event", (event) => {
  if (event.data.runId === runId && event.data.type === "run.ended") console.log(event.data.data)
})
```

Over HTTP only:

```sh
curl -s http://127.0.0.1:4320/v1/runs | jq '.runs[0]'
curl -N http://127.0.0.1:4320/v1/events?location=/my/project
```

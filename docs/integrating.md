# Integrating dynamic workflows into your app

This guide is for people who build on OpenCode: an ADE, an editor extension, a dashboard, a bot. Everything
the TUI and the web app do is available to you through a versioned protocol, and you do not need the TUI. A
Workflow runs in the OpenCode server, so a user who installs the plugin gets Workflows in your app as well.

If you add support, [open an issue](https://github.com/malhashemi/opencode-dynamic-workflows/issues) or a pull
request that adds your app to the README. We are glad to help, and to add what the protocol is missing.

## What you get

- **Workflows:** list the saved Workflows of a project, with each one's `args` JSON Schema, so you can build a
  form for it.
- **Runs:** start a saved Workflow or inline source; follow its phases, Units, tokens and cost live; stop,
  resume, restart a Unit; read the result and every Unit's transcript.
- **People in the loop:** show a Workflow's questions, a Unit's permission requests and inline-Workflow
  approvals, and send the answers.
- **History:** every Run is journaled, including Runs from before a restart.

## Two ways in

|          | OpenCode plugin RPC                                                                           | The Gateway (HTTP + SSE)                                                                            |
| -------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Address  | the OpenCode server: `POST /api/rpc/workflow/<method>`                                        | `http://127.0.0.1:4320/v1/…` (next free port if taken)                                              |
| Auth     | whatever your app already uses for OpenCode                                                   | a device token for control actions ([pairing](#tokens))                                             |
| Events   | the OpenCode event stream, as `rpc.workflow.event`                                            | Server-Sent Events at `GET /v1/events`                                                              |
| Contract | [`@malhashemi/opencode-dynamic-workflows/rpc`](../packages/plugin/src/service/rpc.ts) (typed) | [OpenAPI 3.1](../packages/plugin/docs/protocol/openapi.json), also served at `GET /v1/openapi.json` |
| Best for | apps that already talk to an OpenCode server                                                  | scripts, other machines, apps that do not use the OpenCode client                                   |

Both carry the same resources, commands and events ([protocol reference](../packages/plugin/docs/protocol/README.md),
[JSON Schemas](../packages/plugin/docs/protocol/schemas)). Protocol v1 changes only by addition: new optional
fields, event types and error codes. Ignore what you do not know, and check `protocol` in `info`.

Detect the plugin with `info`: it answers with the protocol version, the plugin and OpenCode versions, the
capabilities (`runs`, `interactions`, `inline-approval`, …), the limits and the Gateway's address.

## Be "attached", or nobody can answer

A Run asks a person three kinds of thing: a Workflow's `ask()` questions, a Unit's permission requests, and the
approval of inline (model-written) Workflows. They wait only while some client is **attached** to the project.
With nobody attached, a question takes its fallback answer, a permission request is denied, and an inline
Workflow is refused, so a Run never hangs.

- **Plugin RPC:** call `attach({ surface: "my-app", ttlMs: 45000, sessionID })` and repeat it every 20 seconds
  or so while your app shows Workflows. `sessionID` is the session in view, if any. Call `detach` on exit.
- **Gateway:** an open `GET /v1/events` stream counts as attached.

Show pending interactions from `run.interactions` (and the `interaction.pending` / `interaction.resolved`
events), and answer with `replyInteraction`: one list of chosen labels per question. For an inline approval,
`interaction.approval` carries the whole `source`, its `sha256` and `bytes`, the `action` (`run` or `save`) and,
for a save, the `target` file. Show the source to the person before they choose; that approval is the only thing
between model-written code and their machine. The choices are `Run once`, `Always for this project` and `Reject`
(`Save` and `Reject` for a save).

## A Run from start to finish (plugin RPC)

```ts
import { OpenCode } from "@opencode/client"
import type { PendingInteraction } from "@malhashemi/opencode-dynamic-workflows/protocol"
import { WorkflowRpc } from "@malhashemi/opencode-dynamic-workflows/rpc"

const directory = "/path/to/project"
const client = OpenCode.make({ baseUrl: "http://127.0.0.1:4096", headers: { "x-opencode-directory": directory } })
const workflow = client.rpc(WorkflowRpc)
const at = { location: { directory } }

// Be attached while your UI is open, so questions and approvals wait for the person.
await workflow.attach({ surface: "my-app", ttlMs: 45_000 }, at)
const heartbeat = setInterval(() => void workflow.attach({ surface: "my-app", ttlMs: 45_000 }, at), 20_000)

// Show an interaction to the person, then send their answer (one list of chosen labels per question).
// The event and the read below can both see the same interaction: answer each one once.
const answered = new Set<string>()
const answer = async (runId: string, interaction: PendingInteraction) => {
  if (answered.has(interaction.interactionId)) return
  answered.add(interaction.interactionId)
  await workflow.replyInteraction({ runId, interactionId: interaction.interactionId, answers: [["Quick"]] }, at)
}

// Listen before starting, so nothing the Run asks early is missed.
let runId: string | null = null
workflow.events.on("event", async ({ data: event }) => {
  if (!runId || event.runId !== runId) return
  if (event.type === "interaction.pending") await answer(runId, event.data as PendingInteraction)
  if (event.type === "run.ended") {
    const { result } = await workflow.getResult({ runId }, at)
    console.log(event.data, result)
    clearInterval(heartbeat)
    await workflow.detach({ surface: "my-app" }, at)
  }
})

const { workflows } = await workflow.listWorkflows({}, at) // each with its args JSON Schema
runId = (await workflow.startRun({ name: workflows[0]!.key, args: {} }, at)).runId
// Anything that became pending before `runId` was known: read it from the Run.
for (const interaction of (await workflow.getRun({ runId }, at)).run.interactions) await answer(runId, interaction)
```

Without the typed client, a plugin RPC call is a plain POST to the OpenCode server: the input goes in `input`,
the answer comes back in `output`, and the project is the `x-opencode-directory` header (or `?location=`):

```sh
curl -s -u "opencode:$OPENCODE_SERVER_PASSWORD" -H "x-opencode-directory: $P" -H "content-type: application/json" \
  -X POST -d '{"input":{}}' http://127.0.0.1:4096/api/rpc/workflow/listWorkflows   # → {"output":{"workflows":[…]}}
```

## The same over the Gateway

```sh
GW=http://127.0.0.1:4320
P=/path/to/project

curl -s "$GW/v1/info"                                  # versions, capabilities, locations
curl -s "$GW/v1/workflows?location=$P" | jq '.workflows[].key'
curl -N "$GW/v1/events?location=$P"                   # keep open: live events, and you are attached

curl -s -X POST "$GW/v1/runs?location=$P" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"review-diff","args":{"base":"main"}}'   # → { "runId": "…" }

curl -s -X POST "$GW/v1/runs/$RUN/interactions/$ID/reply" \
  -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"answers":[["Run once"]]}'

curl -s "$GW/v1/runs/$RUN/result"
```

Every route, parameter and response is in the [OpenAPI document](../packages/plugin/docs/protocol/openapi.json);
point your client generator at it, or at `GET /v1/openapi.json` on a running Gateway.

## Tokens

Reads need a token with `read` scope, except from the same machine to a Gateway bound to loopback (the
default). Control actions (start, stop, resume, answer, save, cleanup) need
`Authorization: Bearer <token>` with `control` scope:

- A browser page served by the Gateway itself pairs automatically (`POST /v1/pair/local`).
- Anything else gets a one-use code from the TUI (`/workflows pair`, valid five minutes) and exchanges it at
  `POST /v1/pair` with `{ "code": "…", "name": "my-app" }`. Store the token; revoke it by deleting its entry in
  `$XDG_STATE_HOME/opencode-dynamic-workflows/gateway-tokens.json`.
- The plugin RPC route needs no Gateway token: it uses your OpenCode credentials.

The [security guide](../packages/plugin/docs/security.md) covers the Gateway's host, origin and CORS rules, and
binding it beyond loopback.

## Events worth handling

| Event                                         | What to do                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| `run.started`, `run.updated`, `run.ended`     | Update the Run's row: status, phase, usage, result preview.                   |
| `unit.updated`                                | Update one Unit. `output` may be elided; fetch the Unit when you show it.     |
| `interaction.pending`, `interaction.resolved` | Show or clear a question, permission request or approval.                     |
| `library.changed`                             | A Run was added to or removed from history: refresh your list of Runs.        |
| `activity.appended`                           | The Run's log line, phase change or capability use.                           |
| `resync.required`                             | You missed events (a restart, or you fell behind): re-read the Runs you show. |

Events carry a `seq` and an `epoch`. Over SSE, reconnect with `Last-Event-ID` to receive what you missed; over
RPC, `eventsSince({ after, epoch })` does the same.

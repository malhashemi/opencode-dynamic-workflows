# opencode-dynamic-workflows — plugin engine

The opencode plugin that registers the `workflow` orchestrator tool. It runs inline Ad-hoc Workflows: each
`agent()` call is one Unit (its own child session), composable via bounded `parallel` fan-out + `collect`,
with the D9 `null`+`ctx.errors` error model and native structured output (`agent({ schema })` → a validated
typed object). No core changes; loads as a local file plugin.

## Layout

- `src/client.ts` — narrow structural slice of the opencode SDK client the engine uses (`session.create`,
  `session.prompt`, `session.abort`). A constructed v2 SDK client is cast to this once, at the `index.ts`
  boundary. Shapes verified vs `@opencode-ai/sdk/v2` on opencode 1.15.12 (DR-004; research note
  `opencode-plugin-sdk-api-contract`). Includes native structured-output `format` (request) +
  `info.structured` (response).
- `src/schema-bridge.ts` — pure zod ⇄ JSON Schema boundary: `toJsonSchema()` (zod → draft-7 object for the
  `format:{json_schema}` request) and `parseStructured()` (re-validate `info.structured` through the zod
  schema → the typed value). No live opencode/git, so it carries the bulk of the structured-path unit tests.
- `src/runner.ts` — `runAgent()`: one Unit = its own child session, blocking-prompted under a named subagent
  (default `general`). Own-child-per-Unit upholds the per-session serialization invariant. With a `schema`,
  sends `format:{json_schema}`, parses `info.structured` back, and retries a `StructuredOutputError`/zod-parse
  failure up to `retries` (default 2) — a fresh child per attempt; core itself does not retry.
- `src/context.ts` — `createWorkflowContext()`: assembles the author-facing `WorkflowContext`
  (`agent`/`args`/`log`/`phase`); failed Units → `null` + `state.errors` (no throw). `agent()` returns the
  schema's inferred type when a `schema` is given, else the Unit text.
- `src/orchestrator.ts` — `runWorkflow()`: writes inline source to a temp `.ts` inside this package tree (so
  `@opencode-ai/workflow` resolves), `import()`s it (no eval), runs it, cleans up.
- `src/index.ts` — the `Plugin`: registers `workflow` via `Hooks.tool`, constructs the v2 client from
  `serverUrl` (`createOpencodeClient({ baseUrl: serverUrl.toString() })`), and casts it to `WorkflowClient` at the
  boundary. Exports both a default `{ id, server }` and the named `WorkflowPlugin`.

## Commands (run from repo root)

- `bun test` — full suite (engine tested against an in-memory fake client; no live opencode needed).
- `bunx tsc -b` — typecheck (strict, project references).

## Conventions

- **No `as any` for SDK calls** — the only cast is constructed v2 client→`WorkflowClient` at the boundary
  (DR-004). If the SDK surface drifts, extend the narrow interface in `client.ts` rather than reaching for
  `as any`; `session.create`/`prompt`/`abort` stay on v2 flat/`sessionID` params.
- **Native structured output is v2-typed.** `format:{json_schema}` is native on the `@opencode-ai/sdk/v2`
  client surface; `format`, `info.structured`, `StructuredOutputError`, and `tokens.output` are byte-identical
  and now type-visible (R15; `prompt.ts:1403-1473`). A zod `schema` round-trips to `info.structured` and parses
  back. Authors write zod via the re-exported **`zod/v4`** `z` (its built-in `z.toJSONSchema` is why; no extra
  dependency).
- TS runs directly under Bun (no build step). Author-facing package is `@opencode-ai/workflow` (name is a
  publish-time risk — we don't own the scope; fine for local/workspace use).

## Live test

Registered in `~/.config/opencode/opencode.json` `plugin` array by absolute path. In an opencode session,
call the `workflow` tool with `source` = a module that `export default defineWorkflow({ meta, run })`.

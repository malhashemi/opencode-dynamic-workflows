# opencode-dynamic-workflows — plugin engine

The opencode plugin that registers the `workflow` orchestrator tool. It runs inline Ad-hoc Workflows: each
`agent()` call is one Unit (its own child session), composable via bounded `parallel` fan-out + `collect`,
with the D9 `null`+`ctx.errors` error model and native structured output (`agent({ schema })` → a validated
typed object). No core changes; loads as a local file plugin.

## Layout

- `src/client.ts` — narrow structural slice of the opencode SDK client the engine uses (`session.create`,
  `session.prompt`). The real client is cast to this once, at the `index.ts` boundary. Shapes verified vs
  opencode v1.15.12 (research note `opencode-plugin-sdk-api-contract`). Includes the structured-output
  `format` (request) + `info.structured` (response), hand-cast onto the v1 body since the v1 types omit them.
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
- `src/index.ts` — the `Plugin`: registers `workflow` via `Hooks.tool`, closing over the injected client.
  Exports both a default `{ id, server }` and the named `WorkflowPlugin`.

## Commands (run from repo root)

- `bun test` — full suite (engine tested against an in-memory fake client; no live opencode needed).
- `bunx tsc -b` — typecheck (strict, project references).

## Conventions

- **No `as any` for SDK calls** — the only cast is client→`WorkflowClient` at the boundary. Where the v1 SDK
  request/response types are stale (they omit `format` and `info.structured`), extend the `WorkflowClient`
  interface in `client.ts` rather than reaching for `as any` — the route accepts the hand-cast field
  (live-confirmed end-to-end; see `test/live/structured-binding.live.ts`).
- **Native structured output works on v1.15.x.** `format:{json_schema}` reaches the model loop through the v1
  route (the v1 *types* are stale, the *route* is not — `prompt.ts:1403-1473`); a zod `schema` round-trips to
  `info.structured` and parses back. Authors write zod via the re-exported **`zod/v4`** `z` (its built-in
  `z.toJSONSchema` is why; no extra dependency).
- TS runs directly under Bun (no build step). Author-facing package is `@opencode-ai/workflow` (name is a
  publish-time risk — we don't own the scope; fine for local/workspace use).

## Live test

Registered in `~/.config/opencode/opencode.json` `plugin` array by absolute path. In an opencode session,
call the `workflow` tool with `source` = a module that `export default defineWorkflow({ meta, run })`.

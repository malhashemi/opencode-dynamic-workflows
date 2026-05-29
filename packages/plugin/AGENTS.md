# opencode-dynamic-workflows — plugin engine

The opencode plugin that registers the `workflow` orchestrator tool. Walking-skeleton scope: run one
inline Ad-hoc Workflow → one Unit → return its text. No core changes; loads as a local file plugin.

## Layout

- `src/client.ts` — narrow structural slice of the opencode SDK client the engine uses (`session.create`,
  `session.prompt`). The real client is cast to this once, at the `index.ts` boundary. Shapes verified vs
  opencode v1.15.12 (research note `opencode-plugin-sdk-api-contract`).
- `src/runner.ts` — `runAgent()`: one Unit = its own child session, blocking-prompted under a named subagent
  (default `general`). Own-child-per-Unit upholds the per-session serialization invariant.
- `src/context.ts` — `createWorkflowContext()`: assembles the author-facing `WorkflowContext`
  (`agent`/`args`/`log`/`phase`); failed Units → `null` + `state.errors` (no throw).
- `src/orchestrator.ts` — `runWorkflow()`: writes inline source to a temp `.ts` inside this package tree (so
  `@opencode-ai/workflow` resolves), `import()`s it (no eval), runs it, cleans up.
- `src/index.ts` — the `Plugin`: registers `workflow` via `Hooks.tool`, closing over the injected client.
  Exports both a default `{ id, server }` and the named `WorkflowPlugin`.

## Commands (run from repo root)

- `bun test` — full suite (engine tested against an in-memory fake client; no live opencode needed).
- `bunx tsc -b` — typecheck (strict, project references).

## Conventions

- **No `as any` for SDK calls** — v1.15.x types are complete; the only cast is client→`WorkflowClient` at the
  boundary. Keep it that way.
- **No native structured output** on v1.15.x (`format`/json_schema is v2-only) — `runAgent` throws on
  `schema`. That's a later ticket, not a bug.
- TS runs directly under Bun (no build step). Author-facing package is `@opencode-ai/workflow` (name is a
  publish-time risk — we don't own the scope; fine for local/workspace use).

## Live test

Registered in `~/.config/opencode/opencode.json` `plugin` array by absolute path. In an opencode session,
call the `workflow` tool with `source` = a module that `export default defineWorkflow({ meta, run })`.

# opencode-dynamic-workflows — plugin package (OpenCode V2)

One package: the server plugin, the TUI plugin (`dist/tui.js`, precompiled), the authoring API, the protocol,
the RPC contract, the Gateway and the built web app (`dist/web`). Target: OpenCode **2.0.16+** only. Use V2
sources only (https://opencode.ai/v2/docs/, the installed `@opencode/*` 2.0.16 types) — never V1 docs.

## Layout

- `src/workflow/` — authoring API (`defineWorkflow`, `z`, context types). Published as `./workflow`; the loader
  also maps the legacy `@opencode-ai/workflow` import.
- `src/protocol/` — protocol v1 zod schemas: the single source for types, RPC validation and
  `docs/protocol/schemas/*.json` (`bun run script/protocol-schemas.ts`; a test fails when stale).
- Engine (host-independent, tested with `test/fake-host.ts`): `host.ts` (the narrow OpenCode slice),
  `runner.ts` (one Unit: create → prompt → wait → context → repair), `units.ts` (Unit index),
  `context.ts` (`ctx`), `orchestrator.ts` (a Run), `broker.ts` (interactions), `runs.ts` (store + events),
  `journal.ts`, `loader.ts`, `registry.ts`, `scheduler.ts`, `capabilities.ts`, `schema-bridge.ts`,
  `engine-global.ts` (process-wide state on `globalThis`).
- `src/service/` — `service.ts` (the one application boundary), `rpc.ts` (plugin RPC contract), `config.ts`.
- `src/host/` — the V2 adapter: `plugin.ts` (tools, hooks, events, RPC, commands), `description.ts`,
  `format.ts`.
- `src/gateway/` — HTTP + SSE Gateway (process singleton) and token auth.
- `src/tui/` — the TUI plugin (built by `script/build-tui.ts`).
- Root `server.ts`, `rpc.ts`, `tui.*` — directory-plugin entry shims (OpenCode resolves `<dir>/server`,
  `<dir>/tui`, `<dir>/rpc` by path for directory plugins; packages via exports).

## Commands (repo root)

- `bun run typecheck`, `bun test` — no OpenCode needed.
- `bun test ./packages/plugin/test/live --timeout 300000` — real OpenCode on a private `opencode serve` with
  its own database (harness in `test/live/harness.ts`; cheap model by default).

## Conventions

- The engine never imports `@opencode/*`: only `src/host/`, `src/service/rpc.ts`, `src/gateway/` and
  `src/tui/` do. Extend `host.ts` instead of reaching past it.
- Units are unlinked sessions; their identity is create-time `metadata.workflow` (plugin metadata updates are
  a no-op on 2.0.16). Mutable Unit state lives in the Unit index, the store and the journal.
- Tools use `options: { codemode: false }`.
- A journal error is never a Run error; a Run's terminal state is journaled before `run.ended` is published.
- Protocol changes within v1 are additive only.

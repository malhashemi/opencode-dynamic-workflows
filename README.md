# opencode-dynamic-workflows

Deterministic multi-subagent Workflows for OpenCode V2, as a plugin. No OpenCode core changes.

- [`packages/plugin`](./packages/plugin) — the published package `opencode-dynamic-workflows`: server plugin,
  TUI plugin, authoring API, protocol, Gateway. Start with its [README](./packages/plugin/README.md).
- [`packages/web`](./packages/web) — the web app (Solid + Vite), built into `packages/plugin/dist/web`.

```sh
bun install
bun run typecheck && bun test
bun run build
```

Protocol: [`packages/plugin/docs/protocol`](./packages/plugin/docs/protocol/README.md).
Security: [`packages/plugin/docs/security.md`](./packages/plugin/docs/security.md).

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

## Dogfooding in this repo

`.opencode/opencode.json` loads the plugin from `packages/plugin` (a relative path), and
`.opencode/workflows/` holds ready-made Workflows. Both are git-ignored (machine-local), like the rest of
`.opencode/`.

1. `bun install && bun run build` (the TUI and web app are built into `packages/plugin/dist`).
2. **Restart OpenCode** (quit the TUI; stop a background `opencode serve --service` if one runs). A location
   reload is not enough after you change plugin source: Bun caches the modules for the life of the process.
3. In the TUI: `/workflows` opens the library; `/<key>` runs a Workflow, e.g. `/review-diff`, `/repo-report`,
   `/echo hello`. Or ask the model: "list the workflows", "run review-diff".

| Workflow | Try it for |
| --- | --- |
| `review-diff` | typed Units per changed file, `ctx.$` git, `pipeline`, permission rules |
| `repo-report` | `ctx.$` / `ctx.file`; writes `.opencode/reports/latest.md` |
| `needs-permission` | a permission interaction (Allow once / Always / Reject) |
| `asks-the-human`, `asks-complex`, `asks-briefly` | script questions (`ctx.ask`), grace timers |
| `asks-nested-question`, `asks-complex-nested` | a Unit's model asking you through its `question` tool |
| `long-run` | stop, stop/restart a Unit, resume |
| `refine`, `constrain`, `deep-research` | typed results driving loops and multi-stage pipelines |
| `echo`, `phase-gate`, `summarize`, `research:quick`, `schema-probe` | quick smoke tests |

Runs are journaled under `.opencode/workflows/runs/` and show in the library, with the web app linked from
every tool result (`http://127.0.0.1:4320` by default; the next free port if taken).

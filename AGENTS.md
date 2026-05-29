# opencode-dynamic-workflows

Agent guidance for this repo. The plugin, its TUI, the authoring API and the Gateway are one package in
`packages/plugin/` (see `packages/plugin/AGENTS.md`); `packages/web/` is the web app shipped inside it.

- Target OpenCode **2.0.16+** only. Use V2 sources only: https://opencode.ai/v2/docs/ and the installed
  `@opencode/*` types.
- Before you finish a change, run `bun run check` (format, lint, types, tests, protocol schemas, README copy).
- Change the root `README.md`, never `packages/plugin/README.md`; regenerate the npm copy with
  `bun run packages/plugin/script/sync-readme.ts`.
- Commit and pull request titles follow Conventional Commits; see `CONTRIBUTING.md`.
- Setup, local plugin runs, live tests and releases: `docs/development.md`.

# Development guide

Everything you need to change the plugin, run it from a checkout and test it.

## Prerequisites

| Tool                                    | Why                                                        |
| --------------------------------------- | ---------------------------------------------------------- |
| [Bun](https://bun.sh) 1.3+              | Installs dependencies, runs tests, builds and scripts.     |
| [OpenCode](https://opencode.ai) 2.0.16+ | Runs the plugin; needed only for the live tests.           |
| A model provider signed in to OpenCode  | Live tests and real Runs. Unit tests and the UI need none. |

## Layout

| Path                                | What                                                                          |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `packages/plugin`                   | The published package: engine, protocol, service, Gateway, TUI plugin, skill. |
| `packages/plugin/src/*.ts`          | The engine. Host-independent; talks to OpenCode only through `src/host.ts`.   |
| `packages/plugin/src/host/`         | The OpenCode V2 adapter: tools, hooks, events, RPC, commands, the skill.      |
| `packages/plugin/src/service/`      | The service boundary every surface calls, and the plugin-RPC contract.        |
| `packages/plugin/src/gateway/`      | HTTP + SSE Gateway and token auth.                                            |
| `packages/plugin/src/tui/`          | The TUI plugin, precompiled to `dist/tui.js`.                                 |
| `packages/plugin/skill/`            | The `dynamic-workflows` authoring skill the plugin registers.                 |
| `packages/web`                      | The web app (Solid + Vite), built into `packages/plugin/dist/web`.            |
| `packages/plugin/test/fake-host.ts` | An in-memory OpenCode: most engine behaviour is tested against it.            |
| `packages/plugin/test/live/`        | Live tests against a real OpenCode server.                                    |

## Setup

```sh
git clone https://github.com/malhashemi/opencode-dynamic-workflows
cd opencode-dynamic-workflows
bun install
bun run build   # dist/tui.js and dist/web
```

## Running the plugin from your checkout

Point a test project at the package directory (OpenCode resolves a directory plugin's `server`, `tui` and `rpc`
entries by path):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/absolute/path/to/opencode-dynamic-workflows/packages/plugin" }]
}
```

- **Server changes** (engine, host, service, Gateway) need an OpenCode restart: Bun caches modules for the life of the
  process, so a location reload does not pick them up.
- **TUI changes** need `bun run build` and a restart.
- **Web app changes**: `bun run --cwd packages/web dev` serves it with hot reload and forwards `/v1` to
  `WF_GATEWAY` (default `http://127.0.0.1:4320`).
- **Worktree Units** (`isolation: "worktree"`) only work when the plugin is configured in a committed
  `opencode.json` (or globally): worktrees check out the committed tree.

## Checks

```sh
bun run check      # oxfmt --check, oxlint, tsc, bun test
bun run format     # format with oxfmt
bun run lint:fix   # apply oxlint's automatic fixes
bun run schemas    # regenerate docs/protocol/schemas after a protocol change
```

A few rules are off in `.oxlintrc.json` on purpose: sequential `await` in loops (Unit turns and repair loops are
sequential by design), closures in factories, and the Solid `ref` pattern in `.tsx` files.

## Live tests

```sh
bun run verify:live
```

Each suite starts a private `opencode serve` with its own database and a throwaway project under
`$TMPDIR/opencode`, loads the plugin from your checkout, and never touches your configuration. `WF_LIVE_MODEL` picks
the model (default `claude-work/claude-opus-5-5`; any `provider/model` you have works). The acceptance suite packs
the package, installs it through a `git+file` spec in a clean project and runs it end to end.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Conventional commits land on `main` through pull requests.
2. release-please keeps a release pull request open with the next version and the changelog
   (`packages/plugin/CHANGELOG.md`).
3. Merging it tags the release; the Release workflow runs `bun run check` and `bun run build`, then publishes
   `@malhashemi/opencode-dynamic-workflows` to npm through trusted publishing (OIDC) with provenance.

A release that failed part-way can be finished by running the Release workflow manually with its tag.

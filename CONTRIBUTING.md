# Contributing

Thanks for helping. Bug reports, platform testing, example Workflows and code are all welcome.

## Where to start

- **Found a bug?** [Open a bug report](https://github.com/malhashemi/opencode-dynamic-workflows/issues/new?template=bug.yml).
  Include the Run's journal if you can: `.opencode/workflows/runs/<runId>/` in your project (`run.json`,
  `units.jsonl`, `script.ts`). It shows exactly what the engine did. Remove anything private first.
- **On Linux or Windows?** Development and live testing happen on macOS, and CI runs the test suite on all three. A
  report that Workflows, the TUI panel or the web app work (or don't) on your setup is a real contribution.
- **Have an idea?** [Open a feature request](https://github.com/malhashemi/opencode-dynamic-workflows/issues/new?template=feature.yml)
  before writing a lot of code, so we can agree on the shape first.
- **Security issue?** Follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

The [development guide](docs/development.md) covers setup, running the plugin from your checkout, the test layers and
the release process.

The short version:

```sh
bun install
bun run build   # the TUI bundle and the web app
bun run check   # formatting, lint, types, tests
```

## Pull requests

1. Fork the repository and create a branch from `main`.
2. Make your change, with tests. The engine runs against an in-memory OpenCode (`packages/plugin/test/fake-host.ts`),
   so most behaviour can be tested without a server.
3. Run `bun run check`.
4. When your change affects how Units run, interactions, the TUI or the web app, try it on a real OpenCode (see the
   development guide) and say in the pull request what you tested and on which platform.
5. Open the pull request with a [Conventional Commit](https://www.conventionalcommits.org/) title.

`main` only changes through pull requests, and CI must pass before anything merges. CI on a pull request from someone
who has not had a contribution merged yet starts once a maintainer approves the run. A maintainer reviews and merges
outside contributions; maintainers merge their own pull requests once CI passes.

### Commit and pull request titles

Titles drive the changelog and version numbers, so they follow Conventional Commits:

| Prefix      | Use for                              | Release effect           |
| ----------- | ------------------------------------ | ------------------------ |
| `feat:`     | A new capability users will notice   | Minor version, changelog |
| `fix:`      | A bug fix                            | Patch version, changelog |
| `perf:`     | A performance improvement            | Patch version, changelog |
| `docs:`     | Documentation only                   | None                     |
| `refactor:` | Code changes with no behavior change | None                     |
| `test:`     | Tests only                           | None                     |
| `build:`    | Dependencies, tooling, packaging     | None                     |
| `ci:`       | Workflows                            | None                     |
| `chore:`    | Anything else                        | None                     |

Add `!` after the type (`feat!:`) for a breaking change, and describe the migration in the pull request body.

### Code style

- TypeScript is formatted with [oxfmt](https://oxc.rs/docs/guide/usage/formatter) and linted with
  [oxlint](https://oxc.rs/docs/guide/usage/linter); CI rejects warnings. Fix findings in the code rather than disabling
  rules; a targeted `oxlint-disable-next-line` needs a comment explaining why.
- The engine (`packages/plugin/src/*.ts`) never imports `@opencode/*`: only `src/host/`, `src/service/rpc.ts`,
  `src/gateway/` and `src/tui/` talk to OpenCode. Extend `src/host.ts` instead of reaching past it.
- Protocol changes within v1 are additive only. After changing `src/protocol/index.ts`, run
  `bun run schemas` so the published JSON Schemas match (a test checks it).
- Comments explain why something is done, not what the next line does.

### Improving the authoring skill

[`packages/plugin/skill/dynamic-workflows/SKILL.md`](packages/plugin/skill/dynamic-workflows/SKILL.md) teaches models to
write Workflows, and it ships with the plugin. It is reviewed like code: describe what a model got wrong, the change,
and how a model did afterwards. Every complete Workflow in it must load (a test checks it).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be kind and assume good intent.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).

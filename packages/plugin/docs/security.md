# Security

This plugin runs code and starts model sessions on your behalf. This page states what is trusted, what is
not, and what each control does — including what it does not do.

## Trust model

| Code                                                                 | Trust                                                                                                                             | Gate                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Durable Workflows (`.opencode/workflows/**/*.ts`, global config dir) | Trusted like any plugin or script in your project. They run when a model or a person names them.                                  | Review them like code you commit.                                                                           |
| Inline Workflows (source written by a model, `workflow_inline`)      | **Untrusted.** They run with the full privileges of the OpenCode service process — the same user, files, network and environment. | A person approves each one, or the project is marked "always allow", or the plugin option `inline` says so. |
| Units (the sessions a Workflow starts)                               | Ordinary OpenCode sessions.                                                                                                       | OpenCode's permission rules, plus the Workflow's rules and the engine's policy (below).                     |

**Inline Workflows are not sandboxed.** The script can `import "node:fs"` or spawn processes whatever the
capability settings are. The approval is the control. Read the whole source before you approve, and prefer
durable Workflows for anything you run often (`workflow({ save_run })` or `workflow_inline({ save })`).

## Inline approval

- `inline: "ask"` (default): an inline Run starts `queued` and publishes an `approval` interaction with the
  whole source, its byte count and SHA-256. The TUI (`/workflows`, then `a`) shows the source with line numbers
  in a scrolling view (PgUp/PgDn, Home/End, mouse wheel); the web app shows it in a scrolling code box. Choices:
  **Run once**, **Always for this project** (stored in the plugin's storage for this project directory),
  **Reject**. The request has no time limit: it waits until someone answers or the Run is stopped, and the
  model's `workflow_inline` call waits with it.
- Nobody attached (headless `opencode run`, CI): the Run is refused with a message, unless the project was
  approved before.
- `inline: "allow"`: no approval (use only where you would run any model-written script).
- `inline: "deny"`: inline Workflows never run.
- `inlineCapabilities: false`: inline Runs get no `ctx.$`, `ctx.file`, `ctx.fetch` (defence in depth only;
  see above).

## Unit permissions

Every Unit session gets, after the subagent's own rules and your Workflow's `meta.permissions` / per-Unit
`permissions` (later rules win):

- `workflow_result` allowed (typed results), `question` allowed (the engine answers it), `workflow` and
  `workflow_inline` denied (no recursion).

When a Unit's tool call hits an `ask` rule, the engine's policy decides (`meta.interaction.permissions`):

- `ask` (default): a person attached (TUI, web app) gets the request as a Run interaction; headless, it is
  denied with a message the Unit can act on. A headless Run never hangs on a permission.
- `auto`: allowed once, silently. Prefer explicit `allow` rules for exactly what the Units need.
- `deny`: always denied with a message.

## Capabilities (`ctx.$`, `ctx.file`, `ctx.fetch`)

- Paths (and the shell's working directory) must resolve inside the Run's project, through symlinks.
- Shell commands and fetches stop when the Run stops; shell commands also time out (120 s default).
- Every call is recorded in the Run's activity (`kind: "capability"`), visible in the TUI and web app.
- Tagged-template interpolations in `ctx.$` are shell-quoted; a plain string is passed to `sh -c` as is.

## Limits

Defaults (plugin option `limits`, or per Workflow `meta.limits`): 1 000 Units per Run, 4 096 items per
`parallel` / `pipeline` call, 250 model requests per Unit. A Run that hits a limit ends `failed` with a
message that names the limit. `meta.budget: { tokens, hard: true }` stops a Run when its output-token budget
is spent.

## The Gateway

The Gateway serves the protocol and the web app over HTTP. It is one listener per OpenCode service process.

| Setting (`gateway.*`) | Default    | Effect                                                                                       |
| --------------------- | ---------- | -------------------------------------------------------------------------------------------- |
| `enabled`             | `true`     | `false` turns it off (the TUI keeps working over RPC).                                       |
| `bind`                | `loopback` | `loopback` (127.0.0.1), `lan` (0.0.0.0), `tailscale` (your 100.64.0.0/10 address), or an IP. |
| `port`                | `4320`     | The next free port is used if it is taken; the TUI and tool results show the real URL.       |
| `auth`                | `token`    | `none` removes auth for loopback clients on a loopback bind only.                            |
| `allowedOrigins`      | `[]`       | Extra browser origins (CORS and CSRF allow-list).                                            |
| `web`                 | `true`     | Serve the web app.                                                                           |

Rules the Gateway enforces:

- **Host check.** Requests must name a host the Gateway serves (defeats DNS rebinding).
- **Origin check.** A browser write must come from the Gateway's own origin or an allowed origin (defeats
  CSRF). CORS headers are sent to allowed origins only.
- **Reads** need no token from a loopback client. Remote reads need a token.
- **Every control action** (start, stop, restart, resume, answer, save, cleanup) needs
  `Authorization: Bearer <token>` with `control` scope. Tokens never travel in URLs.
- **Pairing.** A browser on the same machine, on the Gateway's own origin, pairs itself
  (`POST /v1/pair/local`). A remote browser needs a one-use code from the TUI (`/workflows pair`), valid for
  five minutes, exchanged at `POST /v1/pair`.
- Tokens are stored as SHA-256 hashes in `$XDG_STATE_HOME/opencode-dynamic-workflows/gateway-tokens.json`
  (mode 0600). Delete an entry to revoke it.
- Writes are rate-limited per client. Control actions are recorded in the Run's activity with the device name.
- Responses carry a strict Content-Security-Policy, `nosniff`, `no-referrer` and `frame-ancestors 'none'`.

Exposing the Gateway beyond loopback (`lan`) makes the web app reachable by anyone on that network; reads
still need a token, but prefer `tailscale` or an SSH tunnel.

## Data on disk

| Path                                                    | Content                                                                                                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<project>/.opencode/workflows/runs/<runId>/`           | the Run journal: `run.json`, `units.jsonl`, `script.ts` (the source, inline included), `result.json`. Add it to `.gitignore` if you do not want it committed. |
| `$XDG_CACHE_HOME/opencode-dynamic-workflows/workflows/` | loaded Workflow modules, one directory per content hash. Safe to delete.                                                                                      |
| `$XDG_STATE_HOME/opencode-dynamic-workflows/`           | Gateway device tokens.                                                                                                                                        |

Unit sessions stay in OpenCode's database like any session. The server plugin cannot delete sessions,
so deletion happens in the TUI and only on your action: `d` on a finished Run, or `/workflows cleanup` for the
Runs that `retention: "delete-on-success"` marked. The web app can only mark a Run for cleanup.

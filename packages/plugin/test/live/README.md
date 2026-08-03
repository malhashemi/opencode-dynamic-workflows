# Live verification

**Audience: an agent.** This is the recipe for proving the workflow engine against a real OpenCode host,
without asking a human to look at anything. Each phase of the plan appends its own section below; the
prerequisites and the failure-triage recipe are shared.

```bash
bun run verify:live
```

---

## Why this directory exists

Every contract in this package has a deterministic unit test. None of those tests can fail the way a real host
fails, because none of them load the plugin the way a host loads it.

The first run of these probes found four defects that every unit test had passed over. They are worth knowing,
because each one names a class of mistake this directory exists to catch:

| Defect | Why no unit test could see it |
|---|---|
| The plugin **deadlocked any project it was installed in**: it resolved OpenCode's state directory by calling `GET /path` on its own host during plugin init, and a server plugin is initialized *inside* the instance bootstrap that must finish before the host answers anything | The host's request lifecycle only exists on a host |
| Every SSE subscriber was **dropped after ten seconds**: the endpoint's keepalive is 15s, and Bun closes idle connections at 10s by default | In-process tests never idle that long |
| **No unit could run under the TUI**: OpenCode's default TUI runs no HTTP listener at all, so `PluginInput.serverUrl` is the placeholder `http://localhost:4096`; the engine believed it and talked to nothing | `serverUrl` is a real server in every other mode |
| The sidebar **crashed the entire TUI** on first render: the view was deferred behind `lazy()`, and Solid holds a lazy component's place with an empty text node, which OpenTUI refuses to put in a box | Nothing renders in a row-model test |

The last one is now covered by `packages/plugin/test/tui/sidebar-view.test.tsx`, which mounts views through the
real slot registry — cheaper than a live run, so prefer it when a change is to a view's structure.

## Isolation

Each probe builds its own scratch project **and its own `XDG_STATE_HOME`**. That is not tidiness:

- OpenCode's TUI persists display preferences in the state directory's `kv.json`, including `sidebar: "hide"`.
  A probe that inherits the developer's preferences asserts against the developer's screen rather than the
  product's defaults — and a hidden sidebar makes every sidebar assertion time out with a blank right column.
- The workflow endpoint descriptor lives there too, so isolation keeps a probe from discovering the
  developer's own running OpenCode, and keeps its litter out of theirs.

---

## Prerequisites

| Requirement | Why | Check |
|---|---|---|
| `tmux` ≥ 3.0 | Runs the real TUI on a pseudo-terminal so frames are readable text | `tmux -V` |
| `opencode` 1.18.x | The host under test; the plan targets the 1.18 line | `opencode --version` |
| Model credentials | Probes drive real child sessions | `opencode auth list` |
| `bun install --frozen-lockfile` | The plugin is installed as a *source-tree* reference and resolves through this repo's workspace | — |

Probes that need tmux skip themselves with a warning when it is absent; nothing in `bun test` needs it.

**These probes spend real tokens.** Each run is one parent prompt plus one child session.

### Choosing the model

| Variable | Effect |
|---|---|
| `OPENCODE_LIVE_MODEL` | Pins the scratch host's model, e.g. `anthropic/claude-haiku-4-5-20251001`. Unset ⇒ the host's own default. |
| `OPENCODE_LIVE_ISOLATE_CONFIG=1` | Boots the host on **stock** config, ignoring the developer's global `opencode.json`. |

The fixtures only ever ask a model to echo a token, so there is no reason for them to spend the daily-driver
model — and good reason not to. By default a probe **inherits the developer's global config**, including
`default_agent` and every per-agent `model` pin, which is what decides which credentials the run spends. A
probe can therefore fail with `No Claude account is available` while the code under test is perfectly healthy.

```bash
OPENCODE_LIVE_MODEL=anthropic/claude-haiku-4-5-20251001 bun run verify:live
```

`OPENCODE_LIVE_ISOLATE_CONFIG` makes a probe fully hermetic, but it is **off by default on purpose**: global
config is also where credential brokers and custom providers are wired up, so isolating it can remove the very
thing that makes a model reachable. Reach for `OPENCODE_LIVE_MODEL` first.

A probe does not wait out a host that cannot answer. `waitFor` scans each frame for fatal host errors —
exhausted account pools, invalid credentials, rate limits — and fails immediately quoting the message, instead
of spending the full timeout and then blaming whichever pattern it was waiting for.

---

## What `verify:live` covers today

### `phase-gate.live.ts` — the engine, headlessly

Boots `opencode serve` in a throwaway Git project with this package installed by the real installer.

- **Activation, not configuration.** `tool.ids()` lists `workflow` — which can only happen if the package was
  imported, its factory ran, and its `tool` hook returned.
- **Dual-target install.** One `opencode plugin <path>` patched both `.opencode/opencode.json` and
  `.opencode/tui.json` (asserted while building the scratch project, so a half-install fails at setup).
- **Descriptor.** A record for this worktree appears under
  `${XDG_STATE_HOME:-$HOME/.local/state}/opencode/workflows/endpoints/<pid>.json` with a loopback URL and a
  64-character token.
- **Transport.** `/health` and `/state` answer with a bearer token and 401 without one; `/state` has the
  blessed `{ runs, revision }` shape.
- **Event order.** The fixture produces exactly nine events, in order:
  `run.started → run.phase → run.log → unit.queued → unit.started → unit.settled → run.phase → run.log → run.ended`.
- **Timing, as data.** The run's real wall-clock appears in the tool's returned **text** (`phase-gate · done ·
  1/1 units · 7s`) and matches `/state` to within a second. The tool part's own `time.start` is *not* the run's
  start — the host restamps it on every `ctx.metadata()` call — which is exactly why the summary rides the
  returned text instead.
- **Change-driven mirroring.** The `workflow` tool part is republished at most four times over the whole run
  (once per record-changing transition), not once per elapsed second, and the completed part carries the
  **result** metadata rather than a final progress record.

### `sidebar.tui.live.ts` — the sidebar, as pixels

Runs the real `opencode` TUI inside tmux at 140×40 and reads the screen back.

- Two lines per active run, directly under the `Workflows` heading.
- No truncation: every sidebar line fits 42 columns, with the workflow name intact.
- Theme tokens: the workflow name uses a different foreground color than its detail line, and line 1 uses
  both — accent on the name, `textMuted` on counts and elapsed.
- A phase position (`phase 1/2 · dispatch`) derived from the fixture's declared phases.
- The row **persists** once the run settles, with the spinner replaced by an outcome glyph (`✓`/`✗`/`⊘`) and
  the phase line dropped. The strip used to empty itself the moment a run ended, which meant a workflow that
  finished in seconds never showed whether it worked — and one that failed vanished just as quietly.
- Section order after LSP and before todos, asserted over whichever of those sections actually rendered.

### `route.tui.live.ts` — the run browser, under real keystrokes

Opens the `workflow-runs` route in the same tmux-driven TUI and drives it with `send-keys`. Uses
`long-run.workflow.ts`, a fixture that holds its own run open until something stops it — `phase-gate` is over
in seconds, so a probe racing to press a key would be asserting against a run that had already finished.

- **The palette way in.** `ctrl+p` → "browse runs" → `Enter`. The sidebar strip renders nothing until a run
  starts, so a palette entry is the only way to reach the browser when you are looking for a run you remember.
- **Drill.** `Enter` walks list → run → unit; the breadcrumb names each level (`Workflows ▸ long-run ▸ #1 slow
  unit`), and the unit level shows the run's own recorded child session ID.
- **Session ids are real.** A second block runs `phase-gate`, reads the child session ID off the unit level,
  then starts a throwaway `opencode serve` in the same project and resolves it through the SDK, parent and all.
- **Filter.** `f` cycles `all → active → done → failed`; under `done` a running run leaves the list.
- **Width.** `resize(80, 40)` and every row still fits its line.
- **Stop, in three projections.** `x` on a live run, then the same stop asserted in the route's frame
  (`⊘ long-run` · `aborted · 1/1 units`), in the sidebar strip after leaving the route, and in the engine's
  `/state`. This is the first write direction the endpoint has ever had, so it is checked from all three.
- **No stuck mode.** After `q`, the probe types into the session prompt and confirms the echo. A route that
  pushes a keymap mode and never pops it leaves the terminal permanently deaf — and looks perfectly fine in a
  screenshot.

Two things this probe deliberately does **not** cover, each with a better home:

| Not here | Where instead | Why |
|---|---|---|
| Clicking a sidebar row to open the browser | `test/tui/sidebar-view.test.tsx` | tmux injects keystrokes, not mouse events; the mounted harness clicks for real, through the host's slot registry |
| `stop.unit` on an in-flight unit | `test/control.test.ts` | its window is a unit that is genuinely running, whose length is a property of whichever model is pinned; the unit test stops a real in-flight unit against a client that never answers |

---

## Reading a failure

Every probe writes frames to `packages/plugin/test/live/.artifacts/` (gitignored), named
`<timestamp>-<label>.txt` for the plain screen and `<timestamp>-<label>.ansi.txt` for the same screen with SGR
sequences intact. A timeout inside `waitFor`/`waitUntilGone` writes a frame automatically and names it after
the pattern that never matched.

```bash
ls -t packages/plugin/test/live/.artifacts | head
cat packages/plugin/test/live/.artifacts/<newest>.txt
```

Read the frames in order — `00-home`, `10-sidebar-running`, `20-sidebar-phase`, `30-sidebar-cleared` — and ask
where the screen stopped matching the story.

| Symptom in the frames | Usual cause |
|---|---|
| `00-home` never written; "the TUI never painted a frame" | A plugin is blocking the host's instance bootstrap (something in server-plugin init awaits the host) |
| An `opencode crashed` panel with `Orphan text error` | A view put a text node under a non-`<text>` parent — most often indirectly, via `lazy()` or another placeholder. Reproduce with `bun test packages/plugin/test/tui/sidebar-view.test.tsx` |
| "the TUI never echoed the typed prompt" | The host was still initializing, or a dialog is in front of the prompt; read the captured frame |
| Home screen renders, but no `Workflows` block ever appears | The TUI target did not activate — check `.opencode/tui.json`, and that `OPENCODE_PURE` is unset |
| `Workflows` appears, run line never does | The server target activated but the run never started — check the model actually called the tool (the prompt is an instruction, not a forced call) |
| "no workflow endpoint descriptor … appeared" | Server target inactive, or `directory`/`worktree` were not both supplied to the plugin |
| Frames look right, colors assertion fails | The theme resolved accent and `textMuted` to the same value — try another theme before suspecting the code |
| A pattern with `$` never matches a whole frame | `waitFor` tests the entire frame; anchor patterns need the `m` flag |
| "Workflows: browse runs" never appears after `ctrl+p` | The command palette is bound elsewhere in the developer's config — run with `OPENCODE_LIVE_ISOLATE_CONFIG=1`, or check `tui.json` keybinds |
| The route opens but keys do nothing | The keymap layer's `mode` and the mode the route pushes have drifted apart; both are `WORKFLOW_ROUTE` in `src/tui/keymap.ts` |
| The route closed but the prompt ignores typing | A pushed mode was never popped. The pop is `onCleanup(api.mode.push(...))` in `src/tui/route.tsx`; `test/tui/route.test.tsx` asserts it on unmount |

## Debugging by hand

The harness is thin on purpose; anything it does can be done directly.

```bash
# 1. a scratch project with the plugin really installed
SCRATCH="$(mktemp -d)" && cd "$SCRATCH" && git init -q && mkdir -p .opencode/workflows
cp <repo>/packages/plugin/test/live/fixtures/phase-gate.workflow.ts .opencode/workflows/
opencode plugin <repo>/packages/plugin        # patches opencode.json AND tui.json

# 2. drive the TUI yourself, on a state dir of its own (see "Isolation" above)
export XDG_STATE_HOME="$SCRATCH/xdg-state"
tmux new-session -d -s wf -x 140 -y 40 -c "$SCRATCH" -- env -u OPENCODE_PURE \
  XDG_STATE_HOME="$XDG_STATE_HOME" opencode .
tmux capture-pane -p -t wf            # the screen, as text
tmux capture-pane -p -e -t wf         # the screen, with color
tmux send-keys -t wf -l 'run /phase-gate'
tmux send-keys -t wf Enter
tmux kill-session -t wf

# 3. talk to the engine's endpoint directly
STATE="$XDG_STATE_HOME/opencode"
cat "$STATE"/workflows/endpoints/*.json
curl -H "Authorization: Bearer $TOKEN" "$URL/state"
curl --no-buffer -H "Authorization: Bearer $TOKEN" "$URL/events"
```

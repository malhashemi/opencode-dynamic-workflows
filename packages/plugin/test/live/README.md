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
- **Transport.** `/health` and `/state` answer a bare loopback read — loopback is tokenless by design (the
  Phase 5 amendment: same trust boundary as `opencode serve` itself), with the descriptor's token still
  accepted; `/state` has the blessed `{ runs, revision }` shape.
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
- **Scope.** The browser opens on `scope this session` — it was opened from a session, and the run under test
  belongs to it — and `w` widens through `this project` and `everywhere` before wrapping. Two indicators in one
  header, and both survive the 80-column contract.
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

### `journal.tui.live.ts` — durability, across four hosts

The only claim in this package that cannot be checked inside one process: a run outliving the engine that ran
it. So this probe runs workflows on a real host, **kills it**, and asks a different host — and then a real TUI
— about runs whose engine no longer exists.

| Host | What it proves |
|---|---|
| A · `opencode serve` | Runs `phase-gate` (durable) and a one-line inline workflow, journaling both under `<project>/.opencode/workflows/runs/<runId>/` |
| B · `opencode serve` | A **cold** engine: `/state` is empty, `/history` serves both runs with every column a row needs, and `workflow({ status })` / `workflow({ result })` answer "from the journal" — including the fixture's own `phase-gate-unit-ok` |
| C · `opencode .` (tmux) | The run browser's `History` section; **opening** a history row into the run the journal kept, and its unit's answer read back on demand; and `s` promoting the journaled inline run to `.opencode/workflows/inline-keeper.ts` — verbatim. `s` on the durable run answers `already a durable workflow` |
| D · `opencode serve` | Runs the promoted workflow **by its registry key**, so the save was real rather than cosmetic |

- **The record is four files.** `run.json`, `units.jsonl`, `script.ts`, `result.json`, checked as a directory
  listing after its host is gone.
- **The script is byte-for-byte.** What `s` promotes is a copy, not a reconstruction, so the assertion is
  equality with the source the model sent.
- **`s` moved from dimmed to live in place.** The footer still reads `… x stop · (r restart) · s save · q
  close`, in that order — asserted, because the point of shipping an inert key is that wiring it changes
  nothing else.
- **A listed row and an openable row are different claims.** This probe asserted the first for two phases while
  the second was unwired in `route.tsx`, and a user found it by restarting OpenCode and pressing `⏎`. Leg C now
  presses the key: the run level names the run `(archived)`, renders its phases and units from the record, and
  the unit level shows an answer that exists nowhere but on disk.

Costs five parent prompts and one child session. Only `phase-gate` dispatches a unit.

---

### `interactions.tui.live.ts` — a human answering a question mid-run

The question a unit's grandchild raises exists in the **host**, reached through `GET /question`, and the only
thing that produces one is a model deciding to call the Question tool. There is no way to fake it and still be
testing the thing: so this probe runs real workflows, drives the real TUI, and answers a real pending question
by keystroke.

| Leg | Host | What it proves |
|---|---|---|
| A | `opencode .` (tmux) | An **agent** question: the sidebar badge, the `/workflow-answer` deep link, the pane naming its asker with **no invented countdown**, `⏎` unblocking the agent, the pane LEAVING the moment the answer lands, and the run keeping a record of what was asked and answered |
| B | `opencode .` (tmux) | `esc` decides **nothing** — the question is still pending afterwards — and then `x` hands it to automation, the ladder resolves it, and the run still completes |
| C | `opencode serve` | The same fixture with **no subscriber**: the headless ladder, unchanged, no stall, nothing orphaned |
| D | `opencode .` (tmux) | A **script** question (`ctx.ask`) whose options the run computed from a unit's answer; answering the second one changes the script's own branch, and the answer is filed under the phase it was asked in |
| E | `opencode serve` | The same script question with nobody attached — its declared fallback, immediately, and nothing ever published |

- **Neither fixture declares a grace, on purpose.** That is the default: a published question waits until a
  person answers it, hands it off, or the run stops. So leg A asserts the pane draws **no** countdown and no
  meter, and leg E asserts a headless run still resolves at once — the safety lives in "nothing is published
  with nobody attached", not in a clock.
- **`esc` is navigation, `x` is a decision.** `back` is bound to `escape,left,h`; when it sent
  `question.reject`, the key everyone presses to step out of a screen silently handed a pending decision to a
  machine. Leg B presses `esc`, asserts the interaction is STILL pending, re-enters through its row, and only
  then presses `x`. Handing off is still not the host's `question.reject`: it expires the grace so the
  proxy → escalate → reject ladder takes over, and the run ends `done`.
- **The script leg is the justification for the primitive.** `meta.args` is fixed before a run starts, so it
  could never have carried the option labels the pane shows — they come out of a unit's answer. The labels are
  read off the published interaction rather than hardcoded, so a model's phrasing cannot masquerade as an
  engine defect.
- **Legs A–C depend on a model's mood.** A grandchild that answers its own question produces a valid run with
  no question in it. `waitForQuestion` fails with that spelled out, so a flake reads as a flake.
- **The toast is still UNVERIFIED, but no longer unexplained.** Two facts, read out of the `1.18.10` binary
  rather than guessed at: the host mounts `<Toast />` **only** inside its own `home` and `session` route
  bodies, so a toast raised from a plugin route paints on nothing; and `attention.notify` refuses to raise a
  desktop notification while the renderer's focus state is `unknown`, which is its state until a focus or blur
  event arrives — i.e. always, under tmux. `announce.tsx` now gates the toast on the route and reads the
  notify RESULT instead of discarding it. What remains unproven is only whether the toast paints in a session
  route on a real host; `test/tui/announce.test.tsx` covers our half. The sidebar badge is the durable
  announcement and IS asserted. A frame named `15-interactions-no-toast` under `.artifacts/` is this.

Costs five parent prompts, five child sessions, and three `task`-spawned grandchildren.

---

### `dashboard.live.ts` — the dashboard, from the link outward

Desktop and web users get exactly one path to the dashboard: a URL in the tool's returned text, because the
app's generic tool card renders no title, no metadata, and no output body. This probe starts where they start.

**Prerequisite beyond the shared ones:** `bun run build:dashboard`. The probe fails at setup, naming the
command, if no dist exists — the "run the build" notice passing for the app would be the suite asserting a
placeholder.

- **Extraction, the way a model does it.** A real run of `phase-gate` completes; the URL is pulled out of the
  completed tool part's text with nothing but a URL regex — no metadata read, no descriptor scan. If that
  cannot find it, neither can a model relaying the reply.
- **The link works cold.** Following it with no headers (which is what a browser does) serves the built app
  shell, and the shell's own hashed bundle loads the same way. Asset routes are unauthenticated **by design**
  — they carry no run state.
- **The bare link is the whole handoff.** The extracted URL carries **no** `?token=` — loopback is tokenless
  by design, so `/state`, `/history`, and `/control` all answer the same headerless request the shell makes,
  and the descriptor's old token is still accepted for anything that kept one. The URL's port is the
  persisted per-worktree preference, which is what lets an old tab survive a host restart. (A deliberately
  non-loopback bind keeps the old shape: `?token=` on the link, 401 without it.)

Costs one parent prompt and one child session.

#### Browser-agent legs (not part of `verify:live`)

The probe proves the transport; a browser agent proves the app. Spawn an agent with the `agent-browser` skill,
give it the URL this probe extracts (or any live run's), and have it:

1. open the dashboard mid-run and watch the rail and detail pane advance **without a reload**;
2. run `asks-nested-question.workflow.ts` with no TUI attached and answer from the pinned answer card;
3. screenshot light, dark, and a ~700px viewport into `.artifacts/`, checking Inter, the 13–20px scale,
   semantic tokens, and that `prefers-reduced-motion` suppresses the running-dot pulse and progress
   transitions;
4. repeat from the OpenCode **desktop app**: the generic `Called workflow` card stays inert, and the URL in
   the model's reply is clickable and lands on a working dashboard.

Screenshots land in `packages/plugin/test/live/.artifacts/`, beside the tmux frames, and are part of what the
Phase 8 human gate reviews.

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
| `History` never appears in the route, but `/history` answers | The TUI client's history read failed silently — check that the descriptor's endpoint is the one for THIS worktree, and that `/history` is authorized |
| `/history` is empty after a restart | Nothing was journaled: the plugin resolves the journal from `worktree \|\| directory`, so a host with neither writes no records |
| `s` answers "that run is not in the journal" | The row's owning endpoint could not be resolved. History rows are owned via `client.endpointFor` too — a live-only owner map would answer exactly this |
| "finished `done` without ever publishing a question" | The grandchild declined to call the Question tool. A model outcome, not an engine one — re-run |
| The badge appears but `/workflow-answer` opens the list | Nothing was pending by the time the command ran, so it fell back to the browser. Usually means the grace expired or another surface answered |
| The pane opens and `⏎` does nothing | The route dispatches `drill` to the pane only while the question level is on top; check the breadcrumb ends in `question` |
| A headless run sits on a question | `attached()` returned true with no real subscriber. It is `endpoint.attached()`, i.e. open SSE connections — a stray `curl --no-buffer /events` counts |

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

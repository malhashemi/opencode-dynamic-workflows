/**
 * Drive a REAL OpenCode TUI and read its rendered frames back as text.
 *
 * This is the keystone of the live verification strategy: without it, every UI claim in this plan ("the
 * sidebar shows two lines", "the route drills", "the badge appears") is something only a human can check, and
 * the phases stall waiting on eyeballs. With it, a frame is a string and a claim is an assertion.
 *
 * How it works: `tmux new-session -d` runs the real `opencode` binary on a pseudo-terminal at a FIXED size,
 * detached from any real terminal. `tmux send-keys` injects keystrokes; `tmux capture-pane` reads the screen
 * back. OpenCode's TUI lives on the alternate screen, which `capture-pane` reads natively. `capture-pane -e`
 * additionally preserves SGR sequences, so theme-token usage (accent vs. `textMuted`) is assertable — see
 * {@link fgTokensOn}.
 *
 * Proven on tmux 3.7b + opencode 1.18.10 before anything was built on it: the TUI paints, `send-keys C-p`
 * opens the command palette, `Escape` closes it, and `-e` capture yields truecolor `38;2;R;G;B` runs.
 *
 * Honest limits. This proves layout, ordering, content, truncation, and color tokens. It does NOT prove font
 * rendering, terminal-emulator quirks, or whether the result is beautiful — that is what the single human
 * gate in Phase 8 is for.
 */
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

/** Where captured frames land. Gitignored; Phase 8 collects the final set for the human gate. */
export const ARTIFACTS_DIR = path.join(import.meta.dir, "..", ".artifacts")

export interface TuiSessionOptions {
  cwd: string
  /** Default 140 — above the 120-column threshold at which the session sidebar auto-opens. */
  cols?: number
  rows?: number
  /** Extra environment for the host process. `OPENCODE_PURE` is always unset (it suppresses our plugin). */
  env?: Record<string, string>
  /** Default `["opencode", "."]`. */
  command?: string[]
  /** How long to wait for the host's first painted frame. Plugin load dominates a cold start. */
  bootTimeoutMs?: number
}

export interface TuiSession {
  name: string
  /**
   * Send ONE tmux key spec — a named key (`"Enter"`, `"Escape"`, `"Up"`, `"C-p"`) or a run of plain ASCII
   * with no spaces, which tmux expands to one keypress per character. Use {@link TuiSession.type} for prose.
   */
  send(keys: string): Promise<void>
  /** Type literal text (`send-keys -l`) — spaces, punctuation, and quotes survive intact. */
  type(text: string): Promise<void>
  /**
   * Type `text` into the session prompt and submit it, verifying at each step.
   *
   * Fire-and-forget typing does not work against a real host. The TUI paints its home screen before it is
   * ready for input, and a first run may put a dialog in front of the prompt — so keystrokes sent "once the
   * screen is not blank" land nowhere, and the probe then waits five minutes for a run that was never asked
   * for. This waits for the prompt, clears anything in front of it, types, CONFIRMS the text arrived, and
   * only then presses Enter.
   */
  submitPrompt(text: string, opts?: { timeoutMs?: number }): Promise<void>
  /** The current screen. `{ ansi: true }` keeps SGR sequences for theme-token assertions. */
  capture(opts?: { ansi?: boolean }): Promise<string>
  /** Poll until `pattern` matches a frame; resolves with that frame, rejects with the last frame on timeout. */
  waitFor(pattern: RegExp, opts?: { timeoutMs?: number; intervalMs?: number; ansi?: boolean }): Promise<string>
  /** Poll until `pattern` no longer matches — e.g. a completed run's block clearing out of the sidebar. */
  waitUntilGone(pattern: RegExp, opts?: { timeoutMs?: number; intervalMs?: number }): Promise<void>
  resize(cols: number, rows: number): Promise<void>
  /** Write the current frame (plain + ANSI) under `.artifacts/`; returns the plain frame's path. */
  snapshot(label: string): Promise<string>
  kill(): Promise<void>
}

interface TmuxResult {
  ok: boolean
  stdout: string
  stderr: string
}

async function tmux(args: string[]): Promise<TmuxResult> {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { ok: code === 0, stdout, stderr }
}

async function tmuxOrThrow(args: string[]): Promise<string> {
  const result = await tmux(args)
  if (!result.ok) throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr.trim() || "(no stderr)"}`)
  return result.stdout
}

/** True when a usable `tmux` is on PATH. Pair with `describe.skipIf(!tmuxAvailable())`. */
export function tmuxAvailable(): boolean {
  try {
    return Bun.spawnSync(["tmux", "-V"]).exitCode === 0
  } catch {
    return false
  }
}

/**
 * Fail with an actionable message when tmux is missing, rather than with a spawn error 40 lines deep in a
 * probe. Call it at the top of any suite that uses {@link startTui}.
 */
/**
 * Host failures that no amount of waiting will resolve, matched against the rendered frame.
 *
 * These probes wait minutes for a real model to answer, so a genuine timeout is indistinguishable from a
 * blocked one — and the blocked case prints its reason on screen the whole time. Without this, an exhausted
 * credential pool costs five minutes and reports "timed out waiting for /✓ phase-gate/", which points the
 * reader at the sidebar rather than at their auth.
 */
const FATAL_HOST_ERRORS: readonly RegExp[] = [
  /No \w+ account is available[^\n]*/i,
  /(?:invalid|expired|missing) (?:api )?(?:key|credential|token)[^\n]*/i,
  /not (?:authenticated|logged in)[^\n]*/i,
  /rate limit(?:ed)?[^\n]*/i,
  /insufficient (?:credit|quota|balance)[^\n]*/i,
]

/** The first fatal host error visible in a frame, or `null` when the frame shows none. */
export function fatalHostError(frame: string): string | null {
  for (const pattern of FATAL_HOST_ERRORS) {
    const match = pattern.exec(frame)
    if (match) return match[0].trim()
  }
  return null
}

export function requireTmux(): void {
  if (tmuxAvailable()) return
  throw new Error(
    "tmux is required to drive the OpenCode TUI in live probes and was not found on PATH.\n" +
      "  install:  brew install tmux   (or your platform's package manager)\n" +
      "  skip:     run `bun test` instead of `bun run verify:live` — no unit test needs tmux.",
  )
}

// CSI/OSC and the rest of the escape zoo tmux can emit in an `-e` capture.
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(frame: string): string {
  return frame.replace(ANSI_PATTERN, "")
}

/**
 * Foreground colors used on the first line of an ANSI capture matching `line`, in the order they appear.
 *
 * Truecolor (`38;2;R;G;B`) normalizes to `#rrggbb`, so a probe can compare a rendered run against a theme
 * token directly. Indexed and basic colors normalize to `color<n>` / `ansi<n>` so they are still comparable
 * without pretending to be hex.
 */
export function fgTokensOn(frame: string, line: RegExp): string[] {
  const target = frame.split("\n").find((candidate) => line.test(stripAnsi(candidate)))
  if (target === undefined) return []

  const tokens: string[] = []
  for (const match of target.matchAll(/\u001b\[([0-9;]*)m/g)) {
    const codes = (match[1] ?? "").split(";").map((value) => Number(value || 0))
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i] as number
      if (code === 38 && codes[i + 1] === 2) {
        const [r, g, b] = [codes[i + 2] ?? 0, codes[i + 3] ?? 0, codes[i + 4] ?? 0]
        tokens.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`)
        i += 4
      } else if (code === 38 && codes[i + 1] === 5) {
        tokens.push(`color${codes[i + 2] ?? 0}`)
        i += 2
      } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
        tokens.push(`ansi${code}`)
      }
    }
  }
  return tokens
}

function uniqueSessionName(): string {
  return `wf-live-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
}

function slug(label: string): string {
  return label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "frame"
}

/**
 * Boot the real `opencode` binary inside a detached tmux session and wait for its first painted frame.
 *
 * The boot wait is not ceremony: a plugin that hangs the host's instance bootstrap produces a session that
 * lives forever and paints nothing — exactly the failure mode that shipped in the committed Phase 1 code
 * (a server plugin awaiting `GET /path` on the very instance that was still loading it). Surfacing that as
 * "the TUI never painted" beats surfacing it as a mystery timeout in whatever assertion came first.
 */
export async function startTui(options: TuiSessionOptions): Promise<TuiSession> {
  requireTmux()

  const name = uniqueSessionName()
  const cols = options.cols ?? 140
  const rows = options.rows ?? 40
  const command = options.command ?? ["opencode", "."]
  // `env -u OPENCODE_PURE` rather than trusting the ambient environment: pure mode drops every external
  // plugin, so a stray export would make the probe assert against a host that never loaded our targets.
  const envPrefix = ["env", "-u", "OPENCODE_PURE"]
  for (const [key, value] of Object.entries(options.env ?? {})) envPrefix.push(`${key}=${value}`)

  await tmuxOrThrow([
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    String(cols),
    "-y",
    String(rows),
    "-c",
    options.cwd,
    "--",
    ...envPrefix,
    ...command,
  ])
  // Detached sessions otherwise resize to whatever a later client wants; pin the geometry we asserted on.
  await tmux(["set-option", "-t", name, "window-size", "manual"])

  const session: TuiSession = {
    name,

    async send(keys) {
      await tmuxOrThrow(["send-keys", "-t", name, "--", keys])
    },

    async type(text) {
      await tmuxOrThrow(["send-keys", "-t", name, "-l", "--", text])
    },

    async submitPrompt(text, opts) {
      const timeoutMs = opts?.timeoutMs ?? 60_000
      // The prompt's placeholder is the host's own readiness signal — it is painted once the session route
      // is mounted and accepting keys.
      await session.waitFor(/Ask anything/, { timeoutMs })

      // Anything modal in front of the prompt (a first-run dialog, a stray palette) swallows typing.
      await session.send("Escape")
      await Bun.sleep(400)

      // A distinctive prefix: long enough to be unambiguous, short enough to survive the prompt's wrapping.
      const echo = text.slice(0, 24)
      const deadline = Date.now() + timeoutMs
      let landed = false
      while (Date.now() < deadline) {
        await session.type(text)
        await Bun.sleep(600)
        if (stripAnsi(await session.capture()).includes(echo)) {
          landed = true
          break
        }
        // Not echoed: the TUI was not listening yet. Clear the line and try again rather than submitting a
        // half-typed prompt.
        await session.send("C-u")
        await Bun.sleep(400)
      }
      if (!landed) {
        const artifact = await session.snapshot("prompt-never-accepted-input")
        throw new Error(
          `the TUI never echoed the typed prompt within ${timeoutMs}ms — it is not accepting keyboard input.\n` +
            `last frame written to ${artifact}`,
        )
      }

      await session.send("Enter")
      // Confirm the submission actually took. The placeholder does NOT come back while the assistant streams
      // — the prompt swaps to an interrupt affordance instead — so accept either, and accept them quickly:
      // a short run can finish before a slow poll notices anything at all.
      await session.waitFor(/esc interrupt|Ask anything/, { timeoutMs: 30_000, intervalMs: 150 })
    },

    async capture(opts) {
      const args = ["capture-pane", "-p", "-t", name]
      if (opts?.ansi) args.splice(2, 0, "-e")
      const result = await tmux(args)
      return result.ok ? result.stdout : ""
    },

    async waitFor(pattern, opts) {
      const timeoutMs = opts?.timeoutMs ?? 90_000
      const intervalMs = opts?.intervalMs ?? 300
      const deadline = Date.now() + timeoutMs
      let frame = ""
      while (Date.now() < deadline) {
        frame = await session.capture({ ansi: opts?.ansi })
        const plain = opts?.ansi ? stripAnsi(frame) : frame
        if (pattern.test(plain)) return frame
        // Before sleeping again, check whether the host has already printed a reason this can never match.
        const fatal = fatalHostError(plain)
        if (fatal) {
          const artifact = await session.snapshot("host-error")
          throw new Error(
            `the host cannot run this probe — waiting for ${pattern} would time out for an unrelated reason.\n` +
              `  ${fatal}\n` +
              `last frame written to ${artifact}`,
          )
        }
        await Bun.sleep(intervalMs)
      }
      const artifact = await session.snapshot(`timeout-${pattern.source}`)
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${pattern} in the TUI.\n` +
          `last frame written to ${artifact}\n--- last frame ---\n${stripAnsi(frame)}`,
      )
    },

    async waitUntilGone(pattern, opts) {
      const timeoutMs = opts?.timeoutMs ?? 90_000
      const intervalMs = opts?.intervalMs ?? 300
      const deadline = Date.now() + timeoutMs
      let frame = ""
      while (Date.now() < deadline) {
        frame = await session.capture()
        if (!pattern.test(frame)) return
        await Bun.sleep(intervalMs)
      }
      const artifact = await session.snapshot(`still-present-${pattern.source}`)
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for ${pattern} to disappear.\n` +
          `last frame written to ${artifact}\n--- last frame ---\n${frame}`,
      )
    },

    async resize(nextCols, nextRows) {
      await tmuxOrThrow(["resize-window", "-t", name, "-x", String(nextCols), "-y", String(nextRows)])
      // One repaint tick — OpenTUI relayouts on the SIGWINCH, not synchronously with the tmux call.
      await Bun.sleep(750)
    },

    async snapshot(label) {
      await mkdir(ARTIFACTS_DIR, { recursive: true })
      const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug(label)}`
      const plainPath = path.join(ARTIFACTS_DIR, `${stem}.txt`)
      const [plain, ansi] = await Promise.all([session.capture(), session.capture({ ansi: true })])
      await Promise.all([
        writeFile(plainPath, plain, "utf8"),
        writeFile(path.join(ARTIFACTS_DIR, `${stem}.ansi.txt`), ansi, "utf8"),
      ])
      return plainPath
    },

    async kill() {
      await tmux(["kill-session", "-t", name])
    },
  }

  try {
    await session.waitFor(/\S/, { timeoutMs: options.bootTimeoutMs ?? 120_000, intervalMs: 500 })
  } catch (error) {
    await session.kill()
    throw new Error(
      `the OpenCode TUI never painted a frame in ${options.bootTimeoutMs ?? 120_000}ms.\n` +
        "the usual cause is a plugin that blocks the host's instance bootstrap (a server plugin awaiting the " +
        "very instance that is loading it deadlocks the whole project).\n" +
        `${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return session
}

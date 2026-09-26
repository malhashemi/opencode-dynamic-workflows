/**
 * Script capabilities — `ctx.$`, `ctx.file`, `ctx.fetch`.
 *
 * What they add over a script importing `node:fs` or `Bun.spawn` itself:
 * - **Confinement**: every path (file paths, the shell's `cwd`) must resolve — through symlinks — inside the
 *   Run's location. `..`, absolute paths elsewhere, and symlinks that point out are refused.
 * - **Abort**: shell commands and fetches stop when the Run stops (and on their own timeout).
 * - **Audit**: every call is written to the Run's activity (`kind: "capability"`), visible in the TUI and web app.
 *
 * They are NOT a sandbox. Inline (model-authored) source is untrusted and runs with the service's privileges
 * whatever it imports; the real gate is the inline approval (see docs/security.md). For inline Runs the
 * capabilities can be switched off entirely with the plugin option `inlineCapabilities: false`.
 */
import { existsSync, realpathSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"

import type { ShellResult, WorkflowCapabilities } from "./workflow"

export interface CapabilityOptions {
  location: string
  signal: AbortSignal
  /** Record one activity line. */
  audit: (message: string) => void
  /** Default shell timeout (ms). */
  shellTimeoutMs?: number
  /** Why capabilities are off, when they are; every call then throws this. */
  disabled?: string
}

const MAX_AUDIT = 160
const clip = (text: string) => (text.length > MAX_AUDIT ? `${text.slice(0, MAX_AUDIT - 1)}…` : text)

/** Resolve `target` against `root` and refuse anything outside it, following symlinks of the existing prefix. */
export function confine(root: string, target: string): string {
  const base = realpathSync(root)
  const resolved = path.resolve(base, target)
  // Resolve the deepest existing ancestor through symlinks, then re-append the part that does not exist yet.
  let existing = resolved
  const rest: string[] = []
  while (!existsSync(existing)) {
    rest.unshift(path.basename(existing))
    const parent = path.dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  const real = path.join(realpathSync(existing), ...rest)
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new Error(`path escapes the project: ${target}`)
  }
  return real
}

const WINDOWS = process.platform === "win32"

/** The shell `ctx.$` runs a command line in: `sh -c` on macOS/Linux, `cmd.exe /d /s /c` on Windows. */
export function shellCommand(command: string, windows = WINDOWS): string[] {
  return windows ? [process.env.ComSpec || "cmd.exe", "/d", "/s", "/c", command] : ["sh", "-c", command]
}

/** Quote one value for the platform's shell (`sh`, or `cmd.exe` on Windows). */
export function shellQuote(value: unknown, windows = WINDOWS): string {
  if (Array.isArray(value)) return value.map((entry) => shellQuote(entry, windows)).join(" ")
  const text = String(value)
  if (/^[A-Za-z0-9_/.,:=@+-]+$/.test(text)) return text
  // cmd.exe: double quotes with inner quotes doubled. `%NAME%` still expands inside them (cmd has no escape for it
  // on a command line) — values containing `%` are the one case that is not literal on Windows.
  if (windows) return `"${text.replace(/"/g, '""')}"`
  return `'${text.replace(/'/g, `'\\''`)}'`
}

export function createCapabilities(options: CapabilityOptions): WorkflowCapabilities {
  const guard = (name: string) => {
    if (options.disabled) throw new Error(`ctx.${name} is disabled: ${options.disabled}`)
    if (options.signal.aborted) throw new Error(`ctx.${name}: the Run was stopped`)
  }

  const run = async (
    command: string,
    opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<ShellResult> => {
    guard("$")
    const cwd = confine(options.location, opts.cwd ?? ".")
    options.audit(`$ ${clip(command)}`)
    const timeout = opts.timeoutMs ?? options.shellTimeoutMs ?? 120_000
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
    const windows = process.platform === "win32"
    const child = Bun.spawn(shellCommand(command), {
      cwd,
      env: { ...process.env, ...opts.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group, so a stop ends the whole command, not only the shell.
      detached: !windows,
    })
    // Killing only the shell leaves its children running, holding the output pipes open.
    const kill = () => {
      try {
        if (windows)
          Bun.spawn(["taskkill", "/pid", String(child.pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" })
        else process.kill(-child.pid, "SIGKILL")
      } catch {
        child.kill()
      }
    }
    signal.addEventListener("abort", kill, { once: true })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (signal.aborted)
        throw new Error(options.signal.aborted ? "ctx.$: the Run was stopped" : `ctx.$: timed out after ${timeout}ms`)
      return { stdout, stderr, exitCode }
    } finally {
      signal.removeEventListener("abort", kill)
    }
  }

  /** `ctx.$("ls -la")` or `ctx.$\`git log ${ref}\`` (interpolations are shell-quoted). */
  const $ = ((first: string | TemplateStringsArray, ...rest: unknown[]) => {
    if (typeof first === "string") return run(first, (rest[0] as Parameters<typeof run>[1]) ?? {})
    const command = first.reduce(
      (out, chunk, index) => out + chunk + (index < rest.length ? shellQuote(rest[index]) : ""),
      "",
    )
    return run(command)
  }) as WorkflowCapabilities["$"]

  const file: WorkflowCapabilities["file"] = {
    async read(target) {
      guard("file.read")
      const real = confine(options.location, target)
      options.audit(`read ${clip(target)}`)
      return readFile(real, "utf8")
    },
    async write(target, content) {
      guard("file.write")
      const real = confine(options.location, target)
      options.audit(`write ${clip(target)} (${Buffer.byteLength(content)} bytes)`)
      await mkdir(path.dirname(real), { recursive: true })
      await writeFile(real, content, "utf8")
    },
    async exists(target) {
      guard("file.exists")
      return existsSync(confine(options.location, target))
    },
    async list(target = ".") {
      guard("file.list")
      const real = confine(options.location, target)
      options.audit(`list ${clip(target)}`)
      const entries = await readdir(real, { withFileTypes: true })
      return entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)).toSorted()
    },
    async stat(target) {
      guard("file.stat")
      const info = await stat(confine(options.location, target))
      return { size: info.size, isFile: info.isFile(), isDirectory: info.isDirectory(), modified: info.mtimeMs }
    },
  }

  const fetchCapability: WorkflowCapabilities["fetch"] = async (input, init = {}) => {
    guard("fetch")
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    options.audit(`fetch ${init.method ?? "GET"} ${clip(url)}`)
    const signal = init.signal ? AbortSignal.any([options.signal, init.signal]) : options.signal
    return fetch(input, { ...init, signal })
  }

  return { $, file, fetch: fetchCapability }
}

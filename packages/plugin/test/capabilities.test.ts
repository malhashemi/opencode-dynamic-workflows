import { afterAll, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { confine, createCapabilities, shellQuote } from "../src/capabilities"

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "wf-cap-")))
const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), "wf-cap-out-")))
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const make = (overrides: { signal?: AbortSignal; disabled?: string } = {}) => {
  const audit: string[] = []
  const caps = createCapabilities({ location: root, signal: overrides.signal ?? new AbortController().signal, audit: (m) => audit.push(m), ...(overrides.disabled ? { disabled: overrides.disabled } : {}) })
  return { caps, audit }
}

describe("confine", () => {
  it("allows paths inside, including ones that do not exist yet", () => {
    expect(confine(root, "a/b.txt")).toBe(path.join(root, "a", "b.txt"))
    expect(confine(root, ".")).toBe(root)
  })
  it("refuses .., absolute paths elsewhere and symlinks that point out", async () => {
    expect(() => confine(root, "../x")).toThrow("escapes")
    expect(() => confine(root, outside)).toThrow("escapes")
    await symlink(outside, path.join(root, "link"))
    expect(() => confine(root, "link/secret")).toThrow("escapes")
  })
})

describe("capabilities", () => {
  it("file read/write/list/exists stay in the project and are audited", async () => {
    const { caps, audit } = make()
    await caps.file.write("notes/a.txt", "hello")
    expect(await caps.file.read("notes/a.txt")).toBe("hello")
    expect(await caps.file.exists("notes/a.txt")).toBe(true)
    expect(await caps.file.list("notes")).toEqual(["a.txt"])
    await expect(caps.file.read("../etc/passwd")).rejects.toThrow("escapes")
    expect(audit[0]).toBe("write notes/a.txt (5 bytes)")
  })

  it("$ runs in the project, returns the exit code, and quotes template values", async () => {
    await mkdir(path.join(root, "sub"), { recursive: true })
    await writeFile(path.join(root, "sub", "f.txt"), "x")
    const { caps, audit } = make()
    const pwd = await caps.$("pwd")
    expect(pwd.stdout.trim()).toBe(root)
    const fail = await caps.$("exit 3")
    expect(fail.exitCode).toBe(3)
    const tricky = "a b; echo pwned"
    const echoed = await caps.$`printf %s ${tricky}`
    expect(echoed.stdout).toBe(tricky)
    expect(await caps.$("ls", { cwd: "sub" }).then((r) => r.stdout.trim())).toBe("f.txt")
    await expect(caps.$("ls", { cwd: ".." })).rejects.toThrow("escapes")
    expect(audit.some((line) => line.startsWith("$ printf"))).toBe(true)
  })

  it("$ stops with the Run and on its timeout", async () => {
    const controller = new AbortController()
    const { caps } = make({ signal: controller.signal })
    const slow = caps.$("sleep 5")
    setTimeout(() => controller.abort(), 20)
    await expect(slow).rejects.toThrow("stopped")
    const { caps: other } = make()
    await expect(other.$("sleep 5", { timeoutMs: 30 })).rejects.toThrow("timed out")
  })

  it("disabled capabilities throw the reason", async () => {
    const { caps } = make({ disabled: "inline off" })
    await expect(caps.file.read("x")).rejects.toThrow("ctx.file.read is disabled: inline off")
    await expect(caps.$("ls")).rejects.toThrow("disabled")
  })

  it("shellQuote leaves safe words and quotes the rest", () => {
    expect(shellQuote("abc/d.ts")).toBe("abc/d.ts")
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    expect(shellQuote(["a", "b c"])).toBe(`a 'b c'`)
  })
})

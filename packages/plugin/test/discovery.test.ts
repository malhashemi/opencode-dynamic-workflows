import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  endpointDescriptorDirectory,
  endpointDescriptorPath,
  readDescriptors,
  removeDescriptor,
  writeDescriptor,
  type EndpointDescriptor,
} from "../src/discovery"

function descriptor(pid = process.pid): EndpointDescriptor {
  return {
    url: "http://127.0.0.1:12345",
    token: "secret",
    pid,
    directory: "/project",
    worktree: "/project",
    startedAt: Date.now(),
  }
}

describe("endpoint discovery", () => {
  it("writes, reads, and removes a descriptor under the state path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-discovery-"))
    try {
      const expected = descriptor()
      const file = await writeDescriptor(root, expected)
      expect(file).toBe(endpointDescriptorPath(root, process.pid))
      expect(await readDescriptors(root)).toEqual([expected])
      await removeDescriptor(root)
      expect(existsSync(file)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("prunes dead pids plus malformed and stale descriptor data safely", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-discovery-"))
    try {
      const deadPid = 999_999
      await writeDescriptor(root, descriptor(deadPid))
      const directory = endpointDescriptorDirectory(root)
      const malformed = path.join(directory, "broken.json")
      const stale = path.join(directory, "123.json")
      await writeFile(malformed, "not json", "utf8")
      await writeFile(stale, JSON.stringify({ ...descriptor(123), startedAt: Date.now() + 120_000 }), "utf8")

      expect(await readDescriptors(root, { isProcessAlive: () => false })).toEqual([])
      expect(existsSync(endpointDescriptorPath(root, deadPid))).toBe(false)
      expect(existsSync(malformed)).toBe(false)
      expect(existsSync(stale)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("returns an empty list for a missing state directory", async () => {
    const root = path.join(os.tmpdir(), `wf-discovery-missing-${crypto.randomUUID()}`)
    expect(await readDescriptors(root)).toEqual([])
  })
})

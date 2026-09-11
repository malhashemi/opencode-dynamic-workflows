import { describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  endpointDescriptorDirectory,
  endpointDescriptorPath,
  endpointPreferencePath,
  readDescriptors,
  readEndpointPreference,
  removeDescriptor,
  writeDescriptor,
  writeEndpointPreference,
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

/**
 * The address book behind the stable dashboard URL: `{ port, token }` per worktree, keyed on a path hash. It
 * lives in its own directory because {@link readDescriptors} prunes everything in the descriptor directory
 * that fails to parse as a live descriptor — a preference filed there would be deleted on the first scan.
 */
describe("endpoint address preference", () => {
  it("round-trips per worktree, and answers null for a worktree it has never seen", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-preference-"))
    try {
      expect(await readEndpointPreference(root, "/project/a")).toBeNull()
      await writeEndpointPreference(root, "/project/a", { port: 7_466, token: "stable-token" })
      expect(await readEndpointPreference(root, "/project/a")).toEqual({ port: 7_466, token: "stable-token" })
      // A neighbouring worktree files under its own key.
      expect(await readEndpointPreference(root, "/project/b")).toBeNull()
      expect(endpointPreferencePath(root, "/project/a")).not.toBe(endpointPreferencePath(root, "/project/b"))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("reads a corrupt or nonsensical preference as a first boot, never as an error", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-preference-"))
    try {
      const file = endpointPreferencePath(root, "/project/a")
      await writeEndpointPreference(root, "/project/a", { port: 7_466, token: "stable-token" })
      await writeFile(file, "not json", "utf8")
      expect(await readEndpointPreference(root, "/project/a")).toBeNull()
      await writeFile(file, JSON.stringify({ port: 0, token: "" }), "utf8")
      expect(await readEndpointPreference(root, "/project/a")).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("never files a preference where the descriptor pruner would eat it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "wf-preference-"))
    try {
      await writeEndpointPreference(root, "/project/a", { port: 7_466, token: "stable-token" })
      // A rescan of the descriptor directory must leave the address book untouched.
      expect(await readDescriptors(root)).toEqual([])
      expect(await readEndpointPreference(root, "/project/a")).toEqual({ port: 7_466, token: "stable-token" })
      expect(endpointPreferencePath(root, "/project/a").startsWith(endpointDescriptorDirectory(root))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

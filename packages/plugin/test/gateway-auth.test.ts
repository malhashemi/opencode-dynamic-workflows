import { afterAll, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { createTokenStore } from "../src/gateway/auth"

const dir = await mkdtemp(path.join(os.tmpdir(), "wf-tokens-"))
afterAll(() => rm(dir, { recursive: true, force: true }))

describe("gateway tokens", () => {
  it("deleting an entry from the token file revokes it in the running store", async () => {
    const file = path.join(dir, "gateway-tokens.json")
    const store = await createTokenStore(file)
    const kept = await store.issue("kept", ["read"])
    const removed = await store.issue("removed", ["read", "control"])
    expect(store.verify(removed.token)?.name).toBe("removed")

    const doc = JSON.parse(await readFile(file, "utf8")) as { tokens: Array<{ id: string }> }
    doc.tokens = doc.tokens.filter((token) => token.id !== removed.id)
    await writeFile(file, JSON.stringify(doc))

    expect(store.verify(removed.token)).toBeNull()
    expect(store.verify(kept.token)?.name).toBe("kept")
  })

  it("a missing or unreadable file grants nothing", async () => {
    const file = path.join(dir, "broken.json")
    const store = await createTokenStore(file)
    const issued = await store.issue("device", ["read"])
    await writeFile(file, "{ not json")
    expect(store.verify(issued.token)).toBeNull()
    await rm(file)
    expect(store.verify(issued.token)).toBeNull()
  })
})

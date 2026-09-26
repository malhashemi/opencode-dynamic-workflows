import { afterAll, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createBroker } from "../src/broker"
import { createJournal, journalRoot, processStartedAt } from "../src/journal"
import { newRun, createRunStore } from "../src/runs"
import { DEFAULT_CONFIG } from "../src/service/config"
import { WorkflowService } from "../src/service/service"
import { createUnitIndex } from "../src/units"
import { createFakeHost } from "./fake-host"

const project = await mkdtemp(path.join(os.tmpdir(), "wf-service-"))
afterAll(() => rm(project, { recursive: true, force: true }))

function service() {
  const index = createUnitIndex()
  const store = createRunStore(project)
  const journal = createJournal(journalRoot(project), { onError: () => {} })
  return {
    journal,
    service: new WorkflowService({
      location: project,
      host: createFakeHost(index),
      index,
      store,
      journal,
      broker: createBroker({ store, attached: () => false }),
      config: DEFAULT_CONFIG,
      instance: "test",
      opencodeVersion: "2.0.16",
      approvals: { get: async () => false, set: async () => {} },
      gatewayUrl: () => null,
    }),
  }
}

describe("audit round 4 — resume never duplicates a Run another process is running", () => {
  it("refuses while the journaled owner (another live process) still runs it", async () => {
    const { journal, service: svc } = service()
    const run = newRun({ runId: "busy", workflow: { key: null, name: "w", description: "", provenance: "inline" }, location: project, parentSessionID: "p" })
    await journal.begin(run, { source: "export default 1", args: null, instance: "other" })
    const ppid = process.ppid
    await journal.update({ ...run, status: "running" })
    await journal.flush()
    // Rewrite the owner as the parent process: alive, and not us.
    const file = path.join(journalRoot(project), "busy", "run.json")
    const doc = JSON.parse(await Bun.file(file).text())
    doc.owner = { pid: ppid, instance: "other", startedAt: processStartedAt(ppid) ?? undefined }
    await Bun.write(file, JSON.stringify(doc))
    await expect(svc.resumeRun("busy")).rejects.toThrow("still running in another OpenCode process")
  })
})

describe("transcripts", () => {
  it("maps text, reasoning and tool parts, and clips large outputs", async () => {
    const { toTranscript } = await import("../src/service/service")
    const out = toTranscript("ses_x", [
      { type: "user", content: [{ type: "text", text: "hi" }] },
      {
        type: "assistant",
        model: { providerID: "p", id: "m" },
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "tool", name: "read", state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "x".repeat(25_000) }] } },
          { type: "text", text: "done" },
        ],
      },
    ])
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    const tool = out.messages[1]!.parts[1]!.tool!
    expect(tool.name).toBe("read")
    expect(tool.input).toContain('"path": "a.ts"')
    expect(tool.output!.length).toBeLessThan(21_000)
    expect(out.clipped).toBe(true)
    expect(out.messages[1]!.model).toBe("p/m")
  })
})

import { describe, expect, it } from "bun:test"
import { coerceAnswers, createBroker, type PermissionDecision } from "../src/broker"
import { createRunStore, newRun } from "../src/runs"

const setup = (attached = true) => {
  const store = createRunStore("/p")
  store.create(newRun({ runId: "r1", workflow: { key: null, name: "wf", description: "", provenance: "inline" }, location: "/p", parentSessionID: "ses_p" }))
  const replies: Array<{ requestID: string; decision: PermissionDecision }> = []
  let isAttached = attached
  const broker = createBroker({
    store,
    attached: () => isAttached,
    replyPermission: async (input) => {
      replies.push({ requestID: input.requestID, decision: input.decision })
    },
  })
  return { store, broker, replies, setAttached: (value: boolean) => (isAttached = value) }
}

const form = [{ header: "Depth", prompt: "How deep?", options: [{ label: "Fast", description: "" }, { label: "Thorough", description: "" }] }]
const pendingId = (store: ReturnType<typeof createRunStore>) => store.get("r1")!.interactions[0]!.interactionId

describe("broker — script asks", () => {
  it("headless resolves to the fallback without publishing", async () => {
    const { broker, store } = setup(false)
    const answer = await broker.ask({ runId: "r1", sessionID: "s", form, options: { fallback: [["fast"]] }, defaultGraceMs: null, signal: new AbortController().signal })
    expect(answer).toEqual([["Fast"]])
    expect(store.get("r1")!.interactions).toHaveLength(0)
  })

  it("attached publishes, accepts a coerced reply, and records it", async () => {
    const { broker, store } = setup()
    const pending = broker.ask({ runId: "r1", sessionID: "s", form, options: { fallback: [["Fast"]] }, defaultGraceMs: null, signal: new AbortController().signal })
    await Promise.resolve()
    expect(store.get("r1")!.waiting).toBe(true)
    expect(await broker.reply("r1", pendingId(store), [["Mars"]])).toBe(false)
    expect(await broker.reply("r1", pendingId(store), [["thorough"]])).toBe(true)
    expect(await pending).toEqual([["Thorough"]])
    expect(store.get("r1")!.resolved[0]).toMatchObject({ by: "human", answers: [["Thorough"]], origin: "script" })
  })

  it("cancel and abort settle on the fallback; grace expiry answers for automation", async () => {
    const { broker, store } = setup()
    const a = broker.ask({ runId: "r1", sessionID: "s", form, options: { fallback: [["Fast"]] }, defaultGraceMs: null, signal: new AbortController().signal })
    await Promise.resolve()
    await broker.cancel("r1", pendingId(store))
    expect(await a).toEqual([["Fast"]])

    const controller = new AbortController()
    const b = broker.ask({ runId: "r1", sessionID: "s", form, options: { fallback: [["Fast"]] }, defaultGraceMs: null, signal: controller.signal })
    controller.abort()
    expect(await b).toEqual([["Fast"]])

    const c = broker.ask({ runId: "r1", sessionID: "s", form, options: { fallback: [["Thorough"]], graceMs: 5 }, defaultGraceMs: null, signal: new AbortController().signal })
    expect(await c).toEqual([["Thorough"]])
    expect(store.get("r1")!.resolved.at(-1)?.by).toBe("automation")
  })
})

describe("broker — Unit questions, permissions, approvals", () => {
  it("an agent question accepts free text and returns null when dismissed or headless", async () => {
    const { broker, store, setAttached } = setup()
    const questions = [{ header: "Color", prompt: "?", options: [{ label: "red", description: "" }], multiple: false, custom: false }]
    const a = broker.askAgent({ runId: "r1", unitId: "u1", sessionID: "su", questions, signal: new AbortController().signal })
    await Promise.resolve()
    await broker.reply("r1", pendingId(store), [["teal"]])
    expect(await a).toEqual({ answers: [["teal"]], by: "human" })

    const b = broker.askAgent({ runId: "r1", unitId: "u1", sessionID: "su", questions, signal: new AbortController().signal })
    await Promise.resolve()
    await broker.cancel("r1", pendingId(store))
    expect(await b).toBeNull()

    setAttached(false)
    expect(await broker.askAgent({ runId: "r1", unitId: "u1", sessionID: "su", questions, signal: new AbortController().signal })).toBeNull()
  })

  it("a permission reply goes to the host; a host-side resolution files the record once", async () => {
    const { broker, store, replies } = setup()
    const detail = { action: "shell", resources: ["ls"], save: ["ls *"], requestID: "per_1" }
    broker.permission({ runId: "r1", unitId: "u1", sessionID: "su", detail })
    broker.permission({ runId: "r1", unitId: "u1", sessionID: "su", detail })
    expect(store.get("r1")!.interactions).toHaveLength(1)
    expect(await broker.reply("r1", pendingId(store), [["Allow once"]])).toBe(true)
    expect(replies).toEqual([{ requestID: "per_1", decision: "once" }])
    broker.permissionResolved("per_1", "once")
    expect(store.get("r1")!.resolved).toHaveLength(1)

    broker.permission({ runId: "r1", unitId: "u1", sessionID: "su", detail: { ...detail, requestID: "per_2" } })
    broker.permissionResolved("per_2", "reject")
    expect(store.get("r1")!.resolved.at(-1)).toMatchObject({ outcome: "rejected", answers: [["Reject"]] })
  })

  it("approval maps the chosen option and is null when nobody is attached", async () => {
    const { broker, store, setAttached } = setup()
    const detail = { sha256: "abc", bytes: 10, preview: "x", requestingSessionID: "s" }
    const pending = broker.approval({ runId: "r1", sessionID: "s", detail, signal: new AbortController().signal })
    await Promise.resolve()
    expect(store.get("r1")!.interactions[0]?.kind).toBe("approval")
    await broker.reply("r1", pendingId(store), [["Always for this project"]])
    expect(await pending).toBe("project")
    setAttached(false)
    expect(await broker.approval({ runId: "r1", sessionID: "s", detail, signal: new AbortController().signal })).toBeNull()
  })

  it("releaseRun settles everything a Run waits on", async () => {
    const { broker } = setup()
    const a = broker.ask({ runId: "r1", sessionID: "s", form, options: { fallback: [["Fast"]] }, defaultGraceMs: null, signal: new AbortController().signal })
    await Promise.resolve()
    broker.releaseRun("r1")
    expect(await a).toEqual([["Fast"]])
    expect(broker.pending()).toBe(0)
  })
})

describe("coerceAnswers", () => {
  const questions = [{ header: "h", prompt: "p", options: [{ label: "A", description: "" }, { label: "B", description: "" }], multiple: true, custom: false }]
  it("accepts case-insensitive labels and multiple picks where allowed", () => {
    expect(coerceAnswers(questions, [["a", "B"]])).toEqual([["A", "B"]])
  })
  it("rejects wrong arity, empties and unknown labels", () => {
    expect(coerceAnswers(questions, [])).toBeNull()
    expect(coerceAnswers(questions, [[]])).toBeNull()
    expect(coerceAnswers(questions, [["Z"]])).toBeNull()
  })
})

describe("audit regressions — permission decisions and native forms", () => {
  const slowSetup = () => {
    const store = createRunStore("/p")
    store.create(newRun({ runId: "r1", workflow: { key: null, name: "wf", description: "", provenance: "inline" }, location: "/p", parentSessionID: "ses_p" }))
    const replies: Array<{ requestID: string; decision: PermissionDecision }> = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const broker = createBroker({
      store,
      attached: () => true,
      replyPermission: async (input) => {
        replies.push({ requestID: input.requestID, decision: input.decision })
        await gate
      },
    })
    return { store, broker, replies, release }
  }
  const detail = { action: "shell", resources: ["ls"], save: [], requestID: "per_9" }

  it("a second decision cannot start while the first is on its way to the host", async () => {
    const { store, broker, replies, release } = slowSetup()
    broker.permission({ runId: "r1", unitId: "u", sessionID: "su", detail })
    const id = store.get("r1")!.interactions[0]!.interactionId
    const first = broker.reply("r1", id, [["Allow once"]])
    const second = broker.cancel("r1", id)
    expect(await second).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(replies).toEqual([{ requestID: "per_9", decision: "once" }])
  })

  it("a delivered decision succeeds even when the host's own event filed the record first", async () => {
    const { store, broker, release } = slowSetup()
    broker.permission({ runId: "r1", unitId: "u", sessionID: "su", detail })
    const id = store.get("r1")!.interactions[0]!.interactionId
    const reply = broker.reply("r1", id, [["Reject"]])
    broker.permissionResolved("per_9", "reject")
    release()
    expect(await reply).toBe(true)
    expect(store.get("r1")!.resolved).toHaveLength(1)
  })

  it("ending a Run rejects the permission requests its Units still wait on", async () => {
    const { broker, replies, release } = slowSetup()
    release()
    broker.permission({ runId: "r1", unitId: "u", sessionID: "su", detail })
    broker.releaseRun("r1")
    await Promise.resolve()
    expect(replies).toEqual([{ requestID: "per_9", decision: "reject" }])
  })

  it("native forms cannot be answered or dismissed through the engine", async () => {
    const { store, broker } = slowSetup()
    broker.form({ runId: "r1", unitId: "u", sessionID: "su", formID: "frm_1", questions: [{ header: "h", prompt: "p", options: [], multiple: false, custom: true }] })
    const id = store.get("r1")!.interactions[0]!.interactionId
    expect(await broker.reply("r1", id, [["x"]])).toBe(false)
    expect(await broker.cancel("r1", id)).toBe(false)
    expect(store.get("r1")!.interactions).toHaveLength(1)
  })
})

describe("audit round 2 — nothing answerable outlives its Unit", () => {
  const gatedSetup = () => {
    const store = createRunStore("/p")
    store.create(newRun({ runId: "r1", workflow: { key: null, name: "wf", description: "", provenance: "inline" }, location: "/p", parentSessionID: "ses_p" }))
    const replies: Array<{ requestID: string; decision: PermissionDecision }> = []
    let release!: () => void
    let gate: Promise<void> = Promise.resolve()
    const broker = createBroker({
      store,
      attached: () => true,
      replyPermission: async (input) => {
        replies.push({ requestID: input.requestID, decision: input.decision })
        await gate
      },
    })
    return { store, broker, replies, hold: () => (gate = new Promise<void>((resolve) => (release = resolve))), open: () => release() }
  }
  const detail = (requestID: string) => ({ action: "read", resources: ["x"], save: [], requestID })

  it("releaseUnit rejects that Unit's permission requests and leaves other Units alone", async () => {
    const { store, broker, replies } = gatedSetup()
    broker.permission({ runId: "r1", unitId: "u1", sessionID: "s1", detail: detail("p1") })
    broker.permission({ runId: "r1", unitId: "u2", sessionID: "s2", detail: detail("p2") })
    broker.releaseUnit("r1", "u1")
    await Promise.resolve()
    expect(replies).toEqual([{ requestID: "p1", decision: "reject" }])
    expect(store.get("r1")!.interactions.map((i) => i.permission?.requestID)).toEqual(["p2"])
  })

  it("an allow in flight when the Unit ends is not followed by a contradictory reject", async () => {
    const { store, broker, replies, hold, open } = gatedSetup()
    broker.permission({ runId: "r1", unitId: "u1", sessionID: "s1", detail: detail("p1") })
    const id = store.get("r1")!.interactions[0]!.interactionId
    hold()
    const reply = broker.reply("r1", id, [["Allow once"]])
    broker.releaseUnit("r1", "u1")
    open()
    expect(await reply).toBe(true)
    await Promise.resolve()
    expect(replies.map((r) => r.decision)).toEqual(["once"])
  })

  it("coerceAnswers drops duplicate labels", () => {
    const questions = [{ header: "h", prompt: "p", options: [{ label: "A", description: "" }], multiple: true, custom: false }]
    expect(coerceAnswers(questions, [["A", "a", "A"]])).toEqual([["A"]])
  })
})

describe("audit round 5 — a finished Run waits on nobody", () => {
  it("an ask after the Run ended answers with the fallback at once", async () => {
    const { broker, store } = setup()
    store.apply({ type: "run.ended", runId: "r1", patch: { status: "succeeded", endedAt: 1 } })
    const answer = await broker.ask({ runId: "r1", sessionID: "s", form, options: { fallback: [["Fast"]] }, defaultGraceMs: null, signal: new AbortController().signal })
    expect(answer).toEqual([["Fast"]])
    expect(broker.pending()).toBe(0)
  })
})

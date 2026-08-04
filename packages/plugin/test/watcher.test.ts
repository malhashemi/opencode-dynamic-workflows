import { describe, expect, it } from "bun:test"
import type { PendingQuestion, SessionInfo, SessionMessage } from "../src/client"
import { createEngineState, runOwnedRoots } from "../src/context"
import type { PendingInteraction } from "../src/runs"
import { DEFAULT_MAX_ESCALATION_HOPS, isRunOwned, startWatcher, type InteractionEvent } from "../src/watcher"
import { makeFakeClient, type FakeResponse } from "./fake-client"

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(message)
}

function firstUserMessage(text: string): SessionMessage[] {
  return [{ info: { role: "user" }, parts: [{ type: "text", text }] }]
}

function deploymentRegionQuestion(id: string, sessionID: string): PendingQuestion {
  return {
    id,
    sessionID,
    questions: [
      {
        question: "Which deployment region should this launch use?",
        header: "Deployment region",
        options: [
          { label: "US", description: "Deploy in the United States" },
          { label: "EU", description: "Deploy in Europe" },
        ],
      },
    ],
  }
}

const tieredQuestionSessions: SessionInfo[] = [
  { id: "run-root", title: "Privacy launch Workflow Run" },
  { id: "launch-unit", parentID: "run-root", title: "Prepare deployment Unit" },
  { id: "nested-question-session", parentID: "launch-unit", title: "Nested deploy chooser" },
]

const tieredQuestionMessages: Record<string, SessionMessage[]> = {
  "run-root": firstUserMessage("Run the Workflow for the privacy-sensitive EU launch."),
  "launch-unit": firstUserMessage("Prepare launch using EU data residency because customers are in Germany."),
  "nested-question-session": firstUserMessage("The nested Subagent needs deployment region; the launch context says EU."),
}

type FakeResponses = FakeResponse[]

async function exerciseTieredQuestionBranch(opts: {
  name: string
  responses: FakeResponses
  maxEscalationHops?: number
  humanReachable?: boolean
  questionID?: string
}) {
  const questionID = opts.questionID ?? `question-${opts.name}`
  const client = makeFakeClient({
    responses: opts.responses,
    sessions: tieredQuestionSessions,
    sessionMessages: tieredQuestionMessages,
    pendingQuestions: [deploymentRegionQuestion(questionID, "nested-question-session")],
  })
  const controller = new AbortController()
  const watcher = startWatcher({
    client,
    parentSessionID: "run-root",
    runOwnedRoots: () => new Set(["run-root"]),
    signal: controller.signal,
    pollIntervalMs: 5,
    resolutionPolicy: {
      kind: "tiered",
      standInSubagent: "explore",
      maxEscalationHops: opts.maxEscalationHops ?? DEFAULT_MAX_ESCALATION_HOPS,
      humanReachable: opts.humanReachable,
    },
  })

  try {
    await waitFor(
      () => client.questionReplies.length + client.questionRejects.length >= 1,
      `${opts.name}: tiered branch did not resolve the pending question`,
      500,
    )
  } finally {
    watcher.stop()
    controller.abort()
  }

  return { client, questionID }
}

describe("watcher substrate", () => {
  it("v2 slice exposes permission/question/session.get; fake stages pendings", async () => {
    const client = makeFakeClient({
      sessions: [
        { id: "root-session", title: "Run root" },
        { id: "child-session", parentID: "root-session", title: "Nested Unit" },
      ],
      pendingPermissions: [
        {
          id: "perm-1",
          sessionID: "child-session",
          permission: "bash",
          patterns: ["bun test"],
          metadata: { command: "bun test" },
          always: [],
        },
      ],
      pendingQuestions: [
        {
          id: "question-1",
          sessionID: "child-session",
          questions: [
            {
              question: "Which path should the Subagent take?",
              header: "Pick path",
              options: [{ label: "Safe", description: "Use the scoped path" }],
            },
          ],
        },
        {
          id: "question-2",
          sessionID: "child-session",
          questions: [
            {
              question: "Should the staged request be rejected?",
              header: "Reject path",
              options: [{ label: "Reject", description: "Exercise the reject removal path" }],
            },
          ],
        },
      ],
    })

    expect(typeof client.session.get).toBe("function")
    expect(typeof client.permission.list).toBe("function")
    expect(typeof client.permission.reply).toBe("function")
    expect(typeof client.question.list).toBe("function")
    expect(typeof client.question.reply).toBe("function")
    expect(typeof client.question.reject).toBe("function")

    await expect(client.session.get({ sessionID: "child-session" })).resolves.toEqual({
      data: { id: "child-session", parentID: "root-session", title: "Nested Unit" },
    })
    await expect(client.permission.list()).resolves.toEqual({
      data: [
        {
          id: "perm-1",
          sessionID: "child-session",
          permission: "bash",
          patterns: ["bun test"],
          metadata: { command: "bun test" },
          always: [],
        },
      ],
    })
    await expect(client.question.list()).resolves.toEqual({
      data: [
        {
          id: "question-1",
          sessionID: "child-session",
          questions: [
            {
              question: "Which path should the Subagent take?",
              header: "Pick path",
              options: [{ label: "Safe", description: "Use the scoped path" }],
            },
          ],
        },
        {
          id: "question-2",
          sessionID: "child-session",
          questions: [
            {
              question: "Should the staged request be rejected?",
              header: "Reject path",
              options: [{ label: "Reject", description: "Exercise the reject removal path" }],
            },
          ],
        },
      ],
    })

    await client.permission.reply({ requestID: "perm-1", reply: "once" })
    await expect(client.permission.list()).resolves.toEqual({ data: [] })

    await client.question.reply({ requestID: "question-1", answers: [["Safe"]] })
    await expect(client.question.list()).resolves.toEqual({
      data: [
        {
          id: "question-2",
          sessionID: "child-session",
          questions: [
            {
              question: "Should the staged request be rejected?",
              header: "Reject path",
              options: [{ label: "Reject", description: "Exercise the reject removal path" }],
            },
          ],
        },
      ],
    })

    await client.question.reject({ requestID: "question-2" })
    await expect(client.question.list()).resolves.toEqual({ data: [] })

    expect(client.permissionReplies).toEqual([{ requestID: "perm-1", reply: "once" }])
    expect(client.questionReplies).toEqual([{ requestID: "question-1", answers: [["Safe"]] }])
    expect(client.questionRejects).toEqual([{ requestID: "question-2" }])
  })

  it("session-read: originating task title and first user message are readable for proxy seeding", async () => {
    const client = makeFakeClient({
      sessions: [{ id: "originating-task-session", title: "Explore nested prompt behavior" }],
      sessionMessages: {
        "originating-task-session": [
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Prior assistant output should not seed the proxy." }],
          },
          {
            info: { role: "user" },
            parts: [
              { type: "text", text: "Investigate why nested Questions hang and report the safe fix." },
              { type: "file" },
            ],
          },
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "A later user message must not be selected." }],
          },
        ],
      },
    })

    const session = await client.session.get({ sessionID: "originating-task-session" })
    const messages = await client.session.messages({ sessionID: "originating-task-session" })
    const firstUser = messages.data?.find((message) => message.info.role === "user")
    const firstUserText = firstUser?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")

    expect({ title: session.data?.title, firstUserText }).toEqual({
      title: "Explore nested prompt behavior",
      firstUserText: "Investigate why nested Questions hang and report the safe fix.",
    })
  })

  it("isRunOwned: Run-rooted chain owned with depth; foreign chain untouched", async () => {
    const client = makeFakeClient({
      sessions: [
        { id: "run-root", title: "Run-owned Unit root" },
        { id: "run-child", parentID: "run-root", title: "Nested child" },
        { id: "run-grandchild", parentID: "run-child", title: "Nested grandchild" },
        { id: "foreign-root", title: "Foreign root" },
        { id: "foreign-child", parentID: "foreign-root", title: "Foreign child" },
        { id: "operator-root", title: "Operator's own root outside this Run" },
        { id: "sibling-run-root", title: "Sibling Run root" },
        { id: "sibling-run-child", parentID: "sibling-run-root", title: "Sibling Run child" },
        { id: "exhaust-leaf", parentID: "exhaust-parent", title: "Chain leaf" },
        { id: "exhaust-parent", title: "Chain exhausts here" },
        { id: "cycle-a", parentID: "cycle-b", title: "Cycle A" },
        { id: "cycle-b", parentID: "cycle-a", title: "Cycle B" },
      ],
      pendingPermissions: [
        {
          id: "perm-owned",
          sessionID: "run-child",
          permission: "bash",
          patterns: ["bun test"],
          metadata: {},
          always: [],
        },
        {
          id: "perm-foreign",
          sessionID: "foreign-child",
          permission: "bash",
          patterns: ["rm -rf elsewhere"],
          metadata: {},
          always: [],
        },
      ],
      pendingQuestions: [
        {
          id: "question-owned",
          sessionID: "run-root",
          questions: [
            {
              question: "Root question?",
              header: "Run root",
              options: [{ label: "Keep", description: "Depth-1 questions are preserved in B4" }],
            },
          ],
        },
        {
          id: "question-sibling",
          sessionID: "sibling-run-child",
          questions: [
            {
              question: "Sibling Run question?",
              header: "Sibling",
              options: [{ label: "No", description: "Outside this Run" }],
            },
          ],
        },
      ],
    })

    const roots = new Set(["run-root"])

    // `root` is the run root the walk landed on; `unitSession` is the hop below it — a RUNNING unit's own
    // child session, which is not yet a root, and is what attributes a grandchild's question to its unit.
    await expect(isRunOwned("run-root", roots, client)).resolves.toEqual({ owned: true, depth: 1, root: "run-root", unitSession: null })
    await expect(isRunOwned("run-child", roots, client)).resolves.toEqual({ owned: true, depth: 2, root: "run-root", unitSession: "run-child" })
    await expect(isRunOwned("run-grandchild", roots, client)).resolves.toEqual({ owned: true, depth: 3, root: "run-root", unitSession: "run-child" })

    await expect(isRunOwned("operator-root", roots, client)).resolves.toMatchObject({ owned: false })
    await expect(isRunOwned("sibling-run-root", roots, client)).resolves.toMatchObject({ owned: false })
    await expect(isRunOwned("sibling-run-child", roots, client)).resolves.toMatchObject({ owned: false })
    await expect(isRunOwned("foreign-child", roots, client)).resolves.toMatchObject({ owned: false })
    await expect(isRunOwned("exhaust-leaf", roots, client)).resolves.toMatchObject({ owned: false })
    await expect(isRunOwned("cycle-a", roots, client)).resolves.toMatchObject({ owned: false })

    const state = createEngineState()
    state.units.push({ sessionID: "run-root", label: "unit", subagent: "general", phase: null, ok: true })
    state.units.push({ sessionID: null, label: "failed", subagent: "general", phase: null, ok: false })
    expect([...runOwnedRoots(state, "parent-run-session")].sort()).toEqual(["parent-run-session", "run-root"])

    const controller = new AbortController()
    const watcher = startWatcher({ client, runOwnedRoots: () => roots, signal: controller.signal, pollIntervalMs: 5 })
    await new Promise((resolve) => setTimeout(resolve, 20))
    watcher.stop()
    controller.abort()

    expect(client.permissionReplies).toEqual([{ requestID: "perm-owned", reply: "once" }])
    expect(client.questionReplies).toEqual([])
    expect(client.questionRejects).toEqual([])
    await expect(client.permission.list()).resolves.toEqual({
      data: [
        {
          id: "perm-foreign",
          sessionID: "foreign-child",
          permission: "bash",
          patterns: ["rm -rf elsewhere"],
          metadata: {},
          always: [],
        },
      ],
    })
    await expect(client.question.list()).resolves.toEqual({
      data: [
        {
          id: "question-owned",
          sessionID: "run-root",
          questions: [
            {
              question: "Root question?",
              header: "Run root",
              options: [{ label: "Keep", description: "Depth-1 questions are preserved in B4" }],
            },
          ],
        },
        {
          id: "question-sibling",
          sessionID: "sibling-run-child",
          questions: [
            {
              question: "Sibling Run question?",
              header: "Sibling",
              options: [{ label: "No", description: "Outside this Run" }],
            },
          ],
        },
      ],
    })
  })

  it("permission: Run-owned residual ask auto-allowed once at any depth; non-Run untouched", async () => {
    const foreignPermission = {
      id: "perm-foreign",
      sessionID: "foreign-child",
      permission: "bash",
      patterns: ["rm -rf elsewhere"],
      metadata: {},
      always: [],
    }
    const client = makeFakeClient({
      sessions: [
        { id: "run-root", title: "Run-owned root" },
        { id: "run-child", parentID: "run-root", title: "Run-owned child" },
        { id: "run-grandchild", parentID: "run-child", title: "Run-owned grandchild" },
        { id: "foreign-root", title: "Foreign root" },
        { id: "foreign-child", parentID: "foreign-root", title: "Foreign child" },
      ],
      pendingPermissions: [
        {
          id: "perm-depth-1",
          sessionID: "run-root",
          permission: "bash",
          patterns: ["bun test"],
          metadata: {},
          always: [],
        },
        {
          id: "perm-depth-3",
          sessionID: "run-grandchild",
          permission: "bash",
          patterns: ["bunx tsc -b"],
          metadata: {},
          always: [],
        },
        foreignPermission,
      ],
    })

    const roots = new Set(["run-root"])
    const controller = new AbortController()
    const watcher = startWatcher({ client, runOwnedRoots: () => roots, signal: controller.signal, pollIntervalMs: 5 })

    await waitFor(() => client.permissionReplies.length >= 2, "watcher did not auto-allow owned permission asks")
    watcher.stop()
    controller.abort()

    expect(client.permissionReplies).toEqual([
      { requestID: "perm-depth-1", reply: "once" },
      { requestID: "perm-depth-3", reply: "once" },
    ])
    // DR-001: the watcher resolves only residual ASKS that reached the pending list; core-denied permissions
    // short-circuit before an ask appears. The residual auto-allow must be a one-shot grant, never "always".
    expect(client.permissionReplies.map((reply) => reply.reply)).toEqual(["once", "once"])
    await expect(client.permission.list()).resolves.toEqual({ data: [foreignPermission] })
  })

  it("question P1: depth≥2 Run-owned rejected; depth-1 preserved; non-Run untouched", async () => {
    const depth1Question = {
      id: "question-depth-1",
      sessionID: "run-root",
      questions: [
        {
          question: "Should the Run root question surface to the human?",
          header: "Run root question",
          options: [{ label: "Yes", description: "Depth-1 questions stay human-visible" }],
        },
      ],
    }
    const foreignQuestion = {
      id: "question-foreign",
      sessionID: "foreign-child",
      questions: [
        {
          question: "Should a foreign question be left alone?",
          header: "Foreign question",
          options: [{ label: "Yes", description: "Outside this Run" }],
        },
      ],
    }
    const client = makeFakeClient({
      sessions: [
        { id: "run-root", title: "Run-owned root" },
        { id: "run-child", parentID: "run-root", title: "Run-owned child" },
        { id: "run-grandchild", parentID: "run-child", title: "Run-owned grandchild" },
        { id: "foreign-root", title: "Foreign root" },
        { id: "foreign-child", parentID: "foreign-root", title: "Foreign child" },
      ],
      pendingPermissions: [
        {
          id: "perm-owned",
          sessionID: "run-grandchild",
          permission: "bash",
          patterns: ["bun test"],
          metadata: {},
          always: [],
        },
      ],
      pendingQuestions: [
        depth1Question,
        {
          id: "question-depth-2",
          sessionID: "run-child",
          questions: [
            {
              question: "Should the nested child continue waiting?",
              header: "Nested child question",
              options: [{ label: "No", description: "Depth-2 questions are rejected" }],
            },
          ],
        },
        {
          id: "question-depth-3",
          sessionID: "run-grandchild",
          questions: [
            {
              question: "Should the nested grandchild continue waiting?",
              header: "Nested grandchild question",
              options: [{ label: "No", description: "Depth-3 questions are rejected" }],
            },
          ],
        },
        foreignQuestion,
      ],
    })

    const roots = new Set(["run-root"])
    const controller = new AbortController()
    const watcher = startWatcher({ client, runOwnedRoots: () => roots, signal: controller.signal, pollIntervalMs: 5 })

    await waitFor(
      () => client.questionRejects.length >= 2 && client.permissionReplies.length >= 1,
      "watcher did not reject depth >= 2 Run-owned questions",
    )
    watcher.stop()
    controller.abort()

    expect(client.questionRejects).toEqual([{ requestID: "question-depth-2" }, { requestID: "question-depth-3" }])
    expect(client.questionRejects).not.toContainEqual({ requestID: "question-depth-1" })
    expect(client.questionRejects).not.toContainEqual({ requestID: "question-foreign" })
    await expect(client.question.list()).resolves.toEqual({ data: [depth1Question, foreignQuestion] })

    // B3 stays intact while B4 fills the question seam.
    expect(client.permissionReplies).toEqual([{ requestID: "perm-owned", reply: "once" }])
  })

  it("proxy: grounded answer replies; unanswerable abstains (never forced)", async () => {
    const answerableClient = makeFakeClient({
      reply: "Blue",
      sessions: [
        { id: "run-root", title: "Run root" },
        { id: "answerable-question-session", parentID: "run-root", title: "Palette selection task" },
      ],
      sessionMessages: {
        "answerable-question-session": [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "Use Blue as the primary brand color for the launch page." }],
          },
        ],
      },
      pendingQuestions: [
        {
          id: "question-answerable",
          sessionID: "answerable-question-session",
          questions: [
            {
              question: "Which color should be used as the primary brand color?",
              header: "Primary color",
              options: [
                { label: "Blue", description: "Use the blue palette" },
                { label: "Red", description: "Use the red palette" },
              ],
            },
          ],
        },
      ],
    })
    const answerableController = new AbortController()
    const answerableWatcher = startWatcher({
      client: answerableClient,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root"]),
      signal: answerableController.signal,
      pollIntervalMs: 5,
      resolutionPolicy: { kind: "tiered", standInSubagent: "explore", maxEscalationHops: 1 },
    })

    await waitFor(() => answerableClient.questionReplies.length === 1, "proxy did not reply with the grounded answer")
    answerableWatcher.stop()
    answerableController.abort()

    expect(answerableClient.createCalls).toContainEqual({ parentID: "run-root", title: "wf:explore" })
    expect(answerableClient.promptCalls).toHaveLength(1)
    expect(answerableClient.promptCalls[0]?.agent).toBe("explore")
    expect(answerableClient.promptCalls[0]?.format).toBeUndefined()
    expect(answerableClient.promptCalls[0]?.parts[0]?.text).toContain("UNANSWERABLE")
    expect(answerableClient.promptCalls[0]?.parts[0]?.text).toContain("Use Blue as the primary brand color")
    expect(answerableClient.questionReplies).toEqual([{ requestID: "question-answerable", answers: [["Blue"]] }])
    expect(answerableClient.questionRejects).toEqual([])

    const unanswerableClient = makeFakeClient({
      reply: "UNANSWERABLE",
      sessions: [
        { id: "run-root", title: "Run root" },
        { id: "unanswerable-question-session", parentID: "run-root", title: "Palette selection task" },
      ],
      sessionMessages: {
        "unanswerable-question-session": [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "Use Blue as the primary brand color for the launch page." }],
          },
        ],
      },
      pendingQuestions: [
        {
          id: "question-unanswerable",
          sessionID: "unanswerable-question-session",
          questions: [
            {
              question: "Which deployment region should this launch use?",
              header: "Deployment region",
              options: [
                { label: "US", description: "Deploy in the United States" },
                { label: "EU", description: "Deploy in Europe" },
              ],
            },
          ],
        },
      ],
    })
    const unanswerableController = new AbortController()
    const unanswerableWatcher = startWatcher({
      client: unanswerableClient,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root"]),
      signal: unanswerableController.signal,
      pollIntervalMs: 5,
      resolutionPolicy: { kind: "tiered", standInSubagent: "explore", maxEscalationHops: 1 },
    })

    await waitFor(() => unanswerableClient.questionRejects.length === 1, "proxy abstain did not fall through to reject terminus")
    unanswerableWatcher.stop()
    unanswerableController.abort()

    expect(unanswerableClient.promptCalls).toHaveLength(1)
    expect(unanswerableClient.promptCalls[0]?.agent).toBe("explore")
    expect(unanswerableClient.promptCalls[0]?.format).toBeUndefined()
    expect(unanswerableClient.questionReplies).toEqual([])
    expect(unanswerableClient.questionReplies).not.toContainEqual({ requestID: "question-unanswerable", answers: [["US"]] })
    expect(unanswerableClient.questionReplies).not.toContainEqual({ requestID: "question-unanswerable", answers: [["EU"]] })
    expect(unanswerableClient.questionRejects).toEqual([{ requestID: "question-unanswerable" }])

    const invalidOptionClient = makeFakeClient({
      reply: "Purple",
      sessions: [
        { id: "run-root", title: "Run root" },
        { id: "invalid-option-question-session", parentID: "run-root", title: "Deployment region task" },
      ],
      sessionMessages: {
        "invalid-option-question-session": [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "Choose the launch region only from the approved deployment options." }],
          },
        ],
      },
      pendingQuestions: [
        {
          id: "question-invalid-option",
          sessionID: "invalid-option-question-session",
          questions: [
            {
              question: "Which deployment region should this launch use?",
              header: "Deployment region",
              options: [
                { label: "US", description: "Deploy in the United States" },
                { label: "EU", description: "Deploy in Europe" },
              ],
            },
          ],
        },
      ],
    })
    const invalidOptionController = new AbortController()
    const invalidOptionWatcher = startWatcher({
      client: invalidOptionClient,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root"]),
      signal: invalidOptionController.signal,
      pollIntervalMs: 5,
      resolutionPolicy: { kind: "tiered", standInSubagent: "explore", maxEscalationHops: 1 },
    })

    await waitFor(() => invalidOptionClient.questionRejects.length === 1, "invalid proxy option did not abstain and reject")
    invalidOptionWatcher.stop()
    invalidOptionController.abort()

    expect(invalidOptionClient.promptCalls).toHaveLength(1)
    expect(invalidOptionClient.questionReplies).toEqual([])
    expect(invalidOptionClient.questionReplies).not.toContainEqual({ requestID: "question-invalid-option", answers: [["Purple"]] })
    expect(invalidOptionClient.questionRejects).toEqual([{ requestID: "question-invalid-option" }])
  })

  it("tiered policy skips escalation on proxy abstain unless humanReachable is true", async () => {
    const headlessCases = [
      { name: "default-absent" },
      { name: "explicit-false", humanReachable: false },
    ]

    for (const headlessCase of headlessCases) {
      const { client, questionID } = await exerciseTieredQuestionBranch({
        name: `human-unreachable-${headlessCase.name}`,
        responses: [{ text: "UNANSWERABLE" }, { text: "EU" }],
        humanReachable: headlessCase.humanReachable,
      })

      expect(client.questionReplies).toEqual([])
      expect(client.questionRejects).toEqual([{ requestID: questionID }])
      expect(client.promptCalls.map((call) => call.agent)).toEqual(["explore"])
      expect(client.createCalls.map((call) => call.title)).toEqual(["wf:explore"])
    }

    const { client, questionID } = await exerciseTieredQuestionBranch({
      name: "human-reachable-escalates",
      responses: [{ text: "UNANSWERABLE" }, { text: "EU" }],
      humanReachable: true,
    })

    expect(client.questionReplies).toEqual([{ requestID: questionID, answers: [["EU"]] }])
    expect(client.questionRejects).toEqual([])
    expect(client.promptCalls.map((call) => call.agent)).toEqual(["explore", "general"])
    expect(client.createCalls.map((call) => call.title)).toEqual(["wf:explore", "wf:general"])
  })

  it("escalate: human surface with context; headless rejects; depth-bound → reject", async () => {
    const humanClient = makeFakeClient({
      responses: [{ text: "UNANSWERABLE" }, { text: "EU" }],
      sessions: [
        { id: "run-root", title: "Privacy launch Workflow Run" },
        { id: "launch-unit", parentID: "run-root", title: "Prepare deployment Unit" },
        { id: "nested-question-session", parentID: "launch-unit", title: "Nested deploy chooser" },
      ],
      sessionMessages: {
        "run-root": [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "Run the workflow for the privacy-sensitive EU launch." }],
          },
        ],
        "launch-unit": [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "Prepare launch using EU residency because customers are in Germany." }],
          },
        ],
        "nested-question-session": [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "The nested Subagent needs deployment region but cannot see launch constraints." }],
          },
        ],
      },
      pendingQuestions: [
        {
          id: "question-escalate-human",
          sessionID: "nested-question-session",
          questions: [
            {
              question: "Which deployment region should this launch use?",
              header: "Deployment region",
              options: [
                { label: "US", description: "Deploy in the United States" },
                { label: "EU", description: "Deploy in Europe" },
              ],
            },
          ],
        },
      ],
    })
    const humanController = new AbortController()
    const humanWatcher = startWatcher({
      client: humanClient,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root"]),
      signal: humanController.signal,
      pollIntervalMs: 5,
      resolutionPolicy: { kind: "tiered", standInSubagent: "explore", maxEscalationHops: DEFAULT_MAX_ESCALATION_HOPS, humanReachable: true },
    })

    await waitFor(() => humanClient.questionReplies.length === 1, "escalation did not reply with the human-provided answer")
    humanWatcher.stop()
    humanController.abort()

    expect(humanClient.createCalls).toEqual([
      { parentID: "run-root", title: "wf:explore" },
      { parentID: "run-root", title: "wf:general" },
    ])
    expect(humanClient.promptCalls).toHaveLength(2)
    expect(humanClient.promptCalls[0]?.agent).toBe("explore")
    expect(humanClient.promptCalls[1]?.agent).toBe("general")
    const escalationPrompt = humanClient.promptCalls[1]?.parts[0]?.text ?? ""
    expect(escalationPrompt).toContain("Accumulated context chain")
    expect(escalationPrompt).toContain("Nested deploy chooser")
    expect(escalationPrompt).toContain("The nested Subagent needs deployment region")
    expect(escalationPrompt).toContain("Prepare deployment Unit")
    expect(escalationPrompt).toContain("Prepare launch using EU residency")
    expect(escalationPrompt).toContain("Privacy launch Workflow Run")
    expect(escalationPrompt).toContain("Run the workflow for the privacy-sensitive EU launch")
    expect(escalationPrompt).toContain("Which deployment region should this launch use?")
    expect(escalationPrompt).toContain("EU: Deploy in Europe")
    expect(humanClient.questionReplies).toEqual([{ requestID: "question-escalate-human", answers: [["EU"]] }])
    expect(humanClient.questionRejects).toEqual([])

    const headlessClient = makeFakeClient({
      responses: [{ text: "UNANSWERABLE" }, { noText: true }],
      sessions: [
        { id: "run-root", title: "Headless Run" },
        { id: "headless-question-session", parentID: "run-root", title: "Headless nested chooser" },
      ],
      sessionMessages: {
        "headless-question-session": [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "No operator is available to answer the region prompt." }],
          },
        ],
      },
      pendingQuestions: [
        {
          id: "question-escalate-headless",
          sessionID: "headless-question-session",
          questions: [
            {
              question: "Which deployment region should this launch use?",
              header: "Deployment region",
              options: [
                { label: "US", description: "Deploy in the United States" },
                { label: "EU", description: "Deploy in Europe" },
              ],
            },
          ],
        },
      ],
    })
    const headlessController = new AbortController()
    const headlessWatcher = startWatcher({
      client: headlessClient,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root"]),
      signal: headlessController.signal,
      pollIntervalMs: 5,
      resolutionPolicy: { kind: "tiered", standInSubagent: "explore", maxEscalationHops: DEFAULT_MAX_ESCALATION_HOPS, humanReachable: true },
    })

    await waitFor(() => headlessClient.questionRejects.length === 1, "headless escalation did not hit reject terminus")
    headlessWatcher.stop()
    headlessController.abort()

    expect(headlessClient.promptCalls).toHaveLength(2)
    expect(headlessClient.promptCalls[1]?.agent).toBe("general")
    expect(headlessClient.questionReplies).toEqual([])
    expect(headlessClient.questionRejects).toEqual([{ requestID: "question-escalate-headless" }])

    const boundedClient = makeFakeClient({
      responses: [{ text: "UNANSWERABLE" }],
      sessions: [
        { id: "run-root", title: "Bounded Run" },
        { id: "bounded-unit", parentID: "run-root", title: "Bounded Unit" },
        { id: "bounded-question-session", parentID: "bounded-unit", title: "Bounded nested chooser" },
      ],
      sessionMessages: {
        "bounded-question-session": [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "This path is already at the configured escalation hop bound." }],
          },
        ],
      },
      pendingQuestions: [
        {
          id: "question-escalate-bounded",
          sessionID: "bounded-question-session",
          questions: [
            {
              question: "Which deployment region should this launch use?",
              header: "Deployment region",
              options: [
                { label: "US", description: "Deploy in the United States" },
                { label: "EU", description: "Deploy in Europe" },
              ],
            },
          ],
        },
      ],
    })
    const boundedController = new AbortController()
    const boundedWatcher = startWatcher({
      client: boundedClient,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root"]),
      signal: boundedController.signal,
      pollIntervalMs: 5,
      resolutionPolicy: { kind: "tiered", standInSubagent: "explore", maxEscalationHops: 3, humanReachable: true },
    })

    await waitFor(() => boundedClient.questionRejects.length === 1, "bounded escalation did not hit reject terminus")
    boundedWatcher.stop()
    boundedController.abort()

    expect(boundedClient.promptCalls).toHaveLength(1)
    expect(boundedClient.createCalls).toEqual([{ parentID: "run-root", title: "wf:explore" }])
    expect(boundedClient.questionReplies).toEqual([])
    expect(boundedClient.questionRejects).toEqual([{ requestID: "question-escalate-bounded" }])
  })

  it("tiered branch selection: resolve, abstain→escalate, abstain→reject, bound, invalid-option", async () => {
    const cases: Array<{
      name: string
      responses: FakeResponses
      maxEscalationHops?: number
      humanReachable?: boolean
      expectedReplies: string[][]
      expectedRejects: number
      expectedAgents: string[]
      expectedCreateTitles: string[]
    }> = [
      {
        name: "resolve",
        responses: [{ text: "EU" }],
        expectedReplies: [["EU"]],
        expectedRejects: 0,
        expectedAgents: ["explore"],
        expectedCreateTitles: ["wf:explore"],
      },
      {
        name: "abstain-escalate-answered",
        responses: [{ text: "UNANSWERABLE" }, { text: "EU" }],
        humanReachable: true,
        expectedReplies: [["EU"]],
        expectedRejects: 0,
        expectedAgents: ["explore", "general"],
        expectedCreateTitles: ["wf:explore", "wf:general"],
      },
      {
        name: "abstain-escalate-headless",
        responses: [{ text: "UNANSWERABLE" }, { noText: true }],
        humanReachable: true,
        expectedReplies: [],
        expectedRejects: 1,
        expectedAgents: ["explore", "general"],
        expectedCreateTitles: ["wf:explore", "wf:general"],
      },
      {
        name: "abstain-bound",
        responses: [{ text: "UNANSWERABLE" }],
        maxEscalationHops: 3,
        humanReachable: true,
        expectedReplies: [],
        expectedRejects: 1,
        expectedAgents: ["explore"],
        expectedCreateTitles: ["wf:explore"],
      },
      {
        name: "invalid-option",
        responses: [{ text: "Purple" }, { text: "EU" }],
        humanReachable: true,
        expectedReplies: [["EU"]],
        expectedRejects: 0,
        expectedAgents: ["explore", "general"],
        expectedCreateTitles: ["wf:explore", "wf:general"],
      },
    ]

    for (const branchCase of cases) {
      const { client, questionID } = await exerciseTieredQuestionBranch(branchCase)
      expect(client.questionReplies).toEqual(
        branchCase.expectedReplies.length > 0 ? [{ requestID: questionID, answers: branchCase.expectedReplies }] : [],
      )
      expect(client.questionRejects).toEqual(
        branchCase.expectedRejects > 0 ? Array.from({ length: branchCase.expectedRejects }, () => ({ requestID: questionID })) : [],
      )
      expect(client.promptCalls.map((call) => call.agent)).toEqual(branchCase.expectedAgents)
      expect(client.createCalls.map((call) => call.title)).toEqual(branchCase.expectedCreateTitles)
      expect(client.questionReplies).not.toContainEqual({ requestID: questionID, answers: [["Purple"]] })
    }
  })

  it("tiered policy preserves Phase-1 guarantees: permission once, scope-safety, depth-1 preserved, reject terminus", async () => {
    const depth1Question = {
      id: "question-depth-1",
      sessionID: "run-root",
      questions: [
        {
          question: "Should the Run root question surface to the human?",
          header: "Run root question",
          options: [{ label: "Yes", description: "Depth-1 questions stay human-visible" }],
        },
      ],
    }
    const foreignQuestion = deploymentRegionQuestion("question-foreign", "foreign-child")
    const foreignPermission = {
      id: "perm-foreign",
      sessionID: "foreign-child",
      permission: "bash",
      patterns: ["rm -rf elsewhere"],
      metadata: {},
      always: [],
    }
    const client = makeFakeClient({
      responses: [{ text: "UNANSWERABLE" }],
      sessions: [
        { id: "run-root", title: "Run-owned root" },
        { id: "run-child", parentID: "run-root", title: "Run-owned child" },
        { id: "run-grandchild", parentID: "run-child", title: "Run-owned grandchild" },
        { id: "foreign-root", title: "Foreign root" },
        { id: "foreign-child", parentID: "foreign-root", title: "Foreign child" },
      ],
      sessionMessages: {
        "run-child": firstUserMessage("The child lacks enough context to answer the pending prompt."),
        "run-grandchild": firstUserMessage("Permission depth should not affect one-shot auto-allow."),
        "foreign-child": firstUserMessage("This belongs to a different Run and must remain untouched."),
      },
      pendingPermissions: [
        {
          id: "perm-depth-1",
          sessionID: "run-root",
          permission: "bash",
          patterns: ["bun test"],
          metadata: {},
          always: [],
        },
        {
          id: "perm-depth-3",
          sessionID: "run-grandchild",
          permission: "bash",
          patterns: ["bunx tsc -b"],
          metadata: {},
          always: [],
        },
        foreignPermission,
      ],
      pendingQuestions: [depth1Question, deploymentRegionQuestion("question-reject-terminus", "run-child"), foreignQuestion],
    })
    const controller = new AbortController()
    const watcher = startWatcher({
      client,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root"]),
      signal: controller.signal,
      pollIntervalMs: 5,
      resolutionPolicy: { kind: "tiered", standInSubagent: "explore", maxEscalationHops: 2 },
    })

    try {
      await waitFor(
        () => client.permissionReplies.length === 2 && client.questionRejects.length === 1,
        "tiered policy did not preserve Phase-1 permission/reject guarantees",
        500,
      )
    } finally {
      watcher.stop()
      controller.abort()
    }

    expect(client.permissionReplies).toEqual([
      { requestID: "perm-depth-1", reply: "once" },
      { requestID: "perm-depth-3", reply: "once" },
    ])
    expect(client.permissionReplies.map((reply) => reply.reply)).toEqual(["once", "once"])
    expect(client.permissionReplies.some((reply) => reply.reply === "always")).toBe(false)
    await expect(client.permission.list()).resolves.toEqual({ data: [foreignPermission] })

    expect(client.questionReplies).toEqual([])
    expect(client.questionRejects).toEqual([{ requestID: "question-reject-terminus" }])
    expect(client.questionRejects).not.toContainEqual({ requestID: "question-depth-1" })
    expect(client.questionRejects).not.toContainEqual({ requestID: "question-foreign" })
    await expect(client.question.list()).resolves.toEqual({ data: [depth1Question, foreignQuestion] })
    expect(client.promptCalls.map((call) => call.agent)).toEqual(["explore"])
    expect(client.createCalls.map((call) => call.title)).toEqual(["wf:explore"])
    // Fix B's per-Unit timeout is asserted by the existing orchestrator test; B10's verification runs the full
    // package and repo suites so that guard remains covered while the tiered policy is active in watcher tests.
  })

  it("permission stop race: at most trailing owned resolve; foreign ask never replied", async () => {
    const client = makeFakeClient({
      sessions: [
        { id: "run-root", title: "Run-owned root" },
        { id: "run-child", parentID: "run-root", title: "Run-owned child" },
        { id: "foreign-root", title: "Foreign root" },
        { id: "foreign-child", parentID: "foreign-root", title: "Foreign child" },
      ],
      pendingPermissions: [
        {
          id: "perm-owned",
          sessionID: "run-child",
          permission: "bash",
          patterns: ["bun test"],
          metadata: {},
          always: [],
        },
        {
          id: "perm-foreign",
          sessionID: "foreign-child",
          permission: "bash",
          patterns: ["rm -rf elsewhere"],
          metadata: {},
          always: [],
        },
      ],
    })
    const originalList = client.permission.list.bind(client.permission)
    let releaseList: (() => void) | undefined
    client.permission.list = async () => {
      await new Promise<void>((resolve) => {
        releaseList = resolve
      })
      return originalList()
    }

    const roots = new Set(["run-root"])
    const controller = new AbortController()
    const watcher = startWatcher({ client, runOwnedRoots: () => roots, signal: controller.signal, pollIntervalMs: 5 })

    await waitFor(() => releaseList !== undefined, "watcher did not start an in-flight permission list")
    watcher.stop()
    controller.abort()
    releaseList?.()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(client.permissionReplies.length).toBeLessThanOrEqual(1)
    expect(client.permissionReplies.every((reply) => reply.requestID === "perm-owned" && reply.reply === "once")).toBe(true)
    expect(client.permissionReplies.some((reply) => reply.requestID === "perm-foreign")).toBe(false)
  })
})

/**
 * The human-first rows of the matrix.
 *
 * Every row above this block describes the HEADLESS ladder, and every one of them still holds — that is the
 * contract Phase 4 was written against: with nobody attached, the watcher behaves byte-for-byte as it did.
 * What changes is that an attached surface gets first refusal, for a grace period, on the questions that were
 * previously proxied without anyone ever seeing them.
 */
describe("watcher: human-first interactions", () => {
  const NESTED_SESSIONS: SessionInfo[] = [
    { id: "run-root", title: "Run root" },
    { id: "unit-session", parentID: "run-root", title: "Unit" },
    { id: "grandchild", parentID: "unit-session", title: "Grandchild" },
  ]

  function humanFirstPolicy(overrides: Partial<{ graceMs: number; attached: () => boolean; questions: "human" | "proxy-then-human"; permissions: "auto" | "human" }> = {}) {
    return {
      kind: "human-first" as const,
      graceMs: overrides.graceMs ?? 10_000,
      attached: overrides.attached ?? (() => true),
      questions: overrides.questions ?? ("human" as const),
      permissions: overrides.permissions ?? ("auto" as const),
      fallback: {
        kind: "tiered" as const,
        standInSubagent: "explore",
        maxEscalationHops: DEFAULT_MAX_ESCALATION_HOPS,
        humanReachable: false,
      },
    }
  }

  function start(opts: {
    client: ReturnType<typeof makeFakeClient>
    policy: ReturnType<typeof humanFirstPolicy>
    events: InteractionEvent[]
    unitIdForSession?: (sessionID: string) => string | null
  }) {
    const controller = new AbortController()
    const watcher = startWatcher({
      client: opts.client,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root", "unit-session"]),
      signal: controller.signal,
      pollIntervalMs: 5,
      resolutionPolicy: opts.policy,
      onInteraction: (event) => opts.events.push(event),
      ...(opts.unitIdForSession ? { unitIdForSession: opts.unitIdForSession } : {}),
    })
    return { watcher, controller, stop: () => { watcher.stop(); controller.abort() } }
  }

  it("attached and within grace: the question is published and left alone", async () => {
    const client = makeFakeClient({
      sessions: NESTED_SESSIONS,
      sessionMessages: { "run-root": firstUserMessage("do the thing") },
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    const session = start({
      client,
      policy: humanFirstPolicy({ graceMs: 10_000 }),
      events,
      unitIdForSession: (sessionID) => (sessionID === "unit-session" ? "unit-abc" : null),
    })
    try {
      await waitFor(() => events.length > 0, "no interaction was published")
      await new Promise((resolve) => setTimeout(resolve, 60))

      const published = events.filter((event) => event.kind === "pending")
      expect(published).toHaveLength(1)
      const interaction = (published[0] as { interaction: PendingInteraction }).interaction
      expect(interaction.requestID).toBe("q-1")
      expect(interaction.origin).toBe("agent")
      // Depth counts to the NEAREST run root, and a unit's own child session is one — so a grandchild of the
      // run parent that is a child of a unit is depth 2, not 3.
      expect(interaction.depth).toBe(2)
      // The unit that owns the asking session, resolved through the run root the walk landed on.
      expect(interaction.unitId).toBe("unit-abc")
      expect(interaction.questions[0]?.prompt).toContain("deployment region")
      expect(interaction.graceEndsAt).toBeGreaterThan(interaction.raisedAt)

      // Nothing dispatched, nothing rejected: while the grace runs, the question is the human's.
      expect(client.promptCalls).toHaveLength(0)
      expect(client.questionReplies).toHaveLength(0)
      expect(client.questionRejects).toHaveLength(0)
    } finally {
      session.stop()
    }
  })

  it("a human answering mid-grace resolves it with no proxy dispatch at all", async () => {
    const client = makeFakeClient({
      sessions: NESTED_SESSIONS,
      sessionMessages: { "run-root": firstUserMessage("do the thing") },
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    const session = start({ client, policy: humanFirstPolicy({ graceMs: 10_000 }), events })
    try {
      await waitFor(() => events.some((event) => event.kind === "pending"), "no interaction was published")
      // What a surface answering through `POST /control` does to the host.
      await client.question.reply({ requestID: "q-1", answers: [["EU"]] })
      await waitFor(
        () => events.some((event) => event.kind === "resolved" && event.by === "human"),
        "the watcher never noticed the human's answer",
      )
      expect(client.promptCalls).toHaveLength(0)
      expect(client.questionRejects).toHaveLength(0)
    } finally {
      session.stop()
    }
  })

  it("grace expiry hands it to the tiered ladder, and says so", async () => {
    const client = makeFakeClient({
      responses: [{ text: "EU" }],
      sessions: NESTED_SESSIONS,
      sessionMessages: {
        "run-root": firstUserMessage("Launch in the EU."),
        "unit-session": firstUserMessage("Launch region answer: EU"),
        grandchild: firstUserMessage("Launch region answer: EU"),
      },
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    const session = start({ client, policy: humanFirstPolicy({ graceMs: 20 }), events })
    try {
      await waitFor(
        () => client.questionReplies.length + client.questionRejects.length >= 1,
        "the ladder never ran after the grace expired",
        1_000,
      )
      expect(events.map((event) => event.kind)).toEqual(["pending", "resolved"])
      expect(events[1]).toMatchObject({ kind: "resolved", requestID: "q-1", by: "automation" })
      // The proxy rung, exactly as it runs headlessly.
      expect(client.promptCalls.map((call) => call.agent)).toEqual(["explore"])
      expect(client.questionReplies).toEqual([{ requestID: "q-1", answers: [["EU"]] }])
    } finally {
      session.stop()
    }
  })

  it("detached: today's behaviour, byte for byte — nothing published, the ladder runs at once", async () => {
    const client = makeFakeClient({
      responses: [{ text: "EU" }],
      sessions: NESTED_SESSIONS,
      sessionMessages: {
        "run-root": firstUserMessage("Launch region answer: EU"),
        "unit-session": firstUserMessage("Launch region answer: EU"),
        grandchild: firstUserMessage("Launch region answer: EU"),
      },
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    const session = start({ client, policy: humanFirstPolicy({ attached: () => false, graceMs: 600_000 }), events })
    try {
      await waitFor(
        () => client.questionReplies.length + client.questionRejects.length >= 1,
        "a detached watcher did not resolve the question",
        1_000,
      )
      expect(events).toEqual([])
      expect(client.questionReplies).toEqual([{ requestID: "q-1", answers: [["EU"]] }])
    } finally {
      session.stop()
    }
  })

  it("`handOff` expires the grace early, so `esc` costs no wait", async () => {
    const client = makeFakeClient({
      responses: [{ text: "UNANSWERABLE" }],
      sessions: NESTED_SESSIONS,
      sessionMessages: { "run-root": firstUserMessage("no help here") },
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    const session = start({ client, policy: humanFirstPolicy({ graceMs: 600_000 }), events })
    try {
      await waitFor(() => events.some((event) => event.kind === "pending"), "no interaction was published")
      expect(session.watcher.handOff("q-1")).toBe(true)
      expect(session.watcher.handOff("not-a-request")).toBe(false)
      await waitFor(
        () => client.questionRejects.length >= 1,
        "the ladder never took over after the hand-off",
        2_000,
      )
      expect(events.at(-1)).toMatchObject({ kind: "resolved", by: "automation" })
    } finally {
      session.stop()
    }
  })

  it("`proxy-then-human` asks the grounded proxy first, and nobody at all when it answers", async () => {
    const client = makeFakeClient({
      responses: [{ text: "EU" }],
      sessions: NESTED_SESSIONS,
      sessionMessages: {
        "run-root": firstUserMessage("Launch region answer: EU"),
        "unit-session": firstUserMessage("Launch region answer: EU"),
        grandchild: firstUserMessage("Launch region answer: EU"),
      },
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    const session = start({
      client,
      policy: humanFirstPolicy({ questions: "proxy-then-human", graceMs: 600_000 }),
      events,
    })
    try {
      await waitFor(() => client.questionReplies.length >= 1, "the proxy rung never ran", 1_000)
      // Nothing was ever published: a question the run's own context answers should not interrupt anyone.
      expect(events).toEqual([])
      expect(client.questionReplies).toEqual([{ requestID: "q-1", answers: [["EU"]] }])
    } finally {
      session.stop()
    }
  })

  it("`proxy-then-human` publishes only what the proxy could not ground", async () => {
    const client = makeFakeClient({
      responses: [{ text: "UNANSWERABLE" }],
      sessions: NESTED_SESSIONS,
      sessionMessages: { "run-root": firstUserMessage("nothing relevant") },
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    const session = start({
      client,
      policy: humanFirstPolicy({ questions: "proxy-then-human", graceMs: 600_000 }),
      events,
    })
    try {
      await waitFor(() => events.some((event) => event.kind === "pending"), "the abstained question was never offered", 2_000)
      expect(client.promptCalls.map((call) => call.agent)).toEqual(["explore"])
      expect(client.questionRejects).toHaveLength(0)
    } finally {
      session.stop()
    }
  })

  it("an auto-allowed permission is reported, not published — the badge stays for real decisions", async () => {
    const client = makeFakeClient({
      sessions: NESTED_SESSIONS,
      pendingPermissions: [
        { id: "perm-1", sessionID: "grandchild", permission: "bash", patterns: ["bun test"], metadata: {}, always: [] },
      ],
    })
    const events: InteractionEvent[] = []
    const session = start({ client, policy: humanFirstPolicy(), events })
    try {
      await waitFor(() => client.permissionReplies.length >= 1, "the owned permission was not allowed")
      expect(client.permissionReplies).toEqual([{ requestID: "perm-1", reply: "once" }])
      expect(events).toEqual([{ kind: "auto-allowed", requestID: "perm-1", permission: "bash", depth: 2 }])
      expect(events.some((event) => event.kind === "pending")).toBe(false)
    } finally {
      session.stop()
    }
  })

  it("`permissions: \"human\"` offers it instead, and still allows once when the grace runs out", async () => {
    const client = makeFakeClient({
      sessions: NESTED_SESSIONS,
      pendingPermissions: [
        { id: "perm-1", sessionID: "grandchild", permission: "bash", patterns: ["bun test"], metadata: {}, always: [] },
      ],
    })
    const events: InteractionEvent[] = []
    const session = start({ client, policy: humanFirstPolicy({ permissions: "human", graceMs: 30 }), events })
    try {
      await waitFor(() => events.some((event) => event.kind === "pending"), "the permission was never offered")
      const interaction = (events[0] as { interaction: PendingInteraction }).interaction
      expect(interaction.kind).toBe("permission")
      // `always` is deliberately absent: replies stay `once`-scoped, so no surface offers to persist a grant.
      expect(interaction.questions[0]?.options.map((option) => option.label)).toEqual(["once", "reject"])

      await waitFor(() => client.permissionReplies.length >= 1, "the permission was never allowed on expiry", 2_000)
      expect(client.permissionReplies).toEqual([{ requestID: "perm-1", reply: "once" }])
      expect(events.some((event) => event.kind === "resolved")).toBe(true)
    } finally {
      session.stop()
    }
  })

  it("never escalates a handed-back question to a human — `esc` means automation", async () => {
    const client = makeFakeClient({
      responses: [{ text: "UNANSWERABLE" }],
      sessions: NESTED_SESSIONS,
      sessionMessages: { "run-root": firstUserMessage("nothing that grounds this") },
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    // A surface IS attached — which is exactly the trap. The tiered ladder's escalation rung spends a depth-1
    // unit to surface the question through the host's own dock, so a live `humanReachable` would re-ask the
    // very person who just declined, through a worse surface, and hang the run until they answered it.
    const session = start({ client, policy: humanFirstPolicy({ graceMs: 20 }), events })
    try {
      await waitFor(
        () => client.questionRejects.length >= 1,
        "the handed-back question never reached the reject terminus",
        2_000,
      )
      // One unit only: the grounded proxy. No escalation was dispatched.
      expect(client.promptCalls.map((call) => call.agent)).toEqual(["explore"])
      expect(client.questionRejects).toEqual([{ requestID: "q-1" }])
    } finally {
      session.stop()
    }
  })

  it("attributes a question to the RUNNING unit it is blocking, not to the run", async () => {
    const client = makeFakeClient({
      sessions: NESTED_SESSIONS,
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    // Only the run root is a root: a unit's own session becomes one when it SETTLES, and the unit blocked on
    // this question has not. Found live — the run browser said the question came from "run" while the unit
    // waiting on it sat one row below.
    const controller = new AbortController()
    const watcher = startWatcher({
      client,
      parentSessionID: "run-root",
      runOwnedRoots: () => new Set(["run-root"]),
      signal: controller.signal,
      pollIntervalMs: 5,
      resolutionPolicy: humanFirstPolicy({ graceMs: 600_000 }),
      onInteraction: (event) => events.push(event),
      unitIdForSession: (sessionID) => (sessionID === "unit-session" ? "unit-abc" : null),
    })
    try {
      await waitFor(() => events.some((event) => event.kind === "pending"), "no interaction was published")
      const interaction = (events[0] as { interaction: PendingInteraction }).interaction
      expect(interaction.depth).toBe(3)
      expect(interaction.unitId).toBe("unit-abc")
    } finally {
      watcher.stop()
      controller.abort()
    }
  })

  it("clears everything it published when it stops, so a dead run carries no badge", async () => {
    const client = makeFakeClient({
      sessions: NESTED_SESSIONS,
      pendingQuestions: [deploymentRegionQuestion("q-1", "grandchild")],
    })
    const events: InteractionEvent[] = []
    const session = start({ client, policy: humanFirstPolicy({ graceMs: 600_000 }), events })
    await waitFor(() => events.some((event) => event.kind === "pending"), "no interaction was published")
    session.stop()
    expect(events.at(-1)).toMatchObject({ kind: "resolved", requestID: "q-1", by: "automation" })
  })
})

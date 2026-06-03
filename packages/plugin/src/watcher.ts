import type { PendingPermission, PendingQuestion, WorkflowClient } from "./client"
import { runAgent } from "./runner"

export type QuestionResolutionPolicy =
  | { kind: "reject" }
  | { kind: "tiered"; standInSubagent: string; maxEscalationHops: number; humanReachable?: boolean }

export interface WatcherDeps {
  client: WorkflowClient
  /** Parent session for this Run; required by the tiered proxy-answer policy so the stand-in Unit is Run-owned. */
  parentSessionID?: string
  runOwnedRoots: () => ReadonlySet<string>
  signal: AbortSignal
  pollIntervalMs?: number
  resolutionPolicy?: QuestionResolutionPolicy
}

export interface Watcher {
  stop(): void
}

export interface RunOwnership {
  owned: boolean
  /**
   * Depth is one-based from the pending prompt's originating session to the matched Run root: a pending prompt
   * on a Run root is depth 1, a direct child is depth 2, and each deeper descendant increments from there.
   * B4 depends on this convention: depth-1 questions are preserved, while depth >= 2 questions are nested.
   */
  depth: number
}

const DEFAULT_POLL_INTERVAL_MS = 300
const MAX_PARENT_WALK_HOPS = 100
const DEFAULT_PROXY_ANSWER_TIMEOUT_MS = 300_000
export const DEFAULT_MAX_ESCALATION_HOPS = 4
const DEFAULT_ESCALATION_TIMEOUT_MS = 300_000
const UNANSWERABLE_SENTINEL = "UNANSWERABLE"

interface SeedContext {
  title: string
  firstUserText: string
}

interface SessionContextRead {
  seedContext: SeedContext
  parentID?: string
}

interface SessionWalkEntry {
  id: string
  title: string
}

interface RunContextWalk {
  ownership: RunOwnership
  contextChain: SeedContext[]
}

export type ParsedProxyAnswer = { abstained: true } | { answer: string[][] }

/**
 * Walk a session's parentID chain until it reaches one of this Run's roots, exhausts, cycles, or hits the
 * bounded-hop guard. This is the scope-safety core: pending permission/question lists are instance-wide, so a
 * request is Run-owned only when its session chain reaches a root recorded for this Run.
 */
export async function isRunOwned(sessionID: string, roots: ReadonlySet<string>, client: WorkflowClient): Promise<RunOwnership> {
  if (!sessionID) return { owned: false, depth: 0 }

  const visited = new Set<string>()
  let currentID: string | undefined = sessionID

  for (let depth = 1; currentID && depth <= MAX_PARENT_WALK_HOPS; depth += 1) {
    if (roots.has(currentID)) return { owned: true, depth }
    if (visited.has(currentID)) return { owned: false, depth }
    visited.add(currentID)

    const session = await client.session.get({ sessionID: currentID })
    const parentID = session.data?.parentID
    if (!parentID) return { owned: false, depth }
    currentID = parentID
  }

  return { owned: false, depth: MAX_PARENT_WALK_HOPS }
}

/**
 * Start the descendant-interaction watcher. Owned pending permission asks are resolved with a one-shot allow;
 * owned pending questions follow the configured question-resolution policy. Non-owned entries are never touched.
 */
export function startWatcher(deps: WatcherDeps): Watcher {
  const resolutionPolicy: QuestionResolutionPolicy = deps.resolutionPolicy ?? { kind: "reject" }
  let stopped = false
  let polling = false
  let timer: ReturnType<typeof setInterval> | null = null

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    deps.signal.removeEventListener("abort", stop)
  }

  const poll = async () => {
    if (stopped || deps.signal.aborted || polling) return
    polling = true
    try {
      const roots = deps.runOwnedRoots()
      const [permissions, questions] = await Promise.all([deps.client.permission.list(), deps.client.question.list()])
      if (stopped || deps.signal.aborted) return

      for (const permission of permissions.data ?? []) {
        if (stopped || deps.signal.aborted) return
        const ownership = await isRunOwned(permission.sessionID, roots, deps.client)
        if (stopped || deps.signal.aborted) return
        if (ownership.owned) await resolvePermission(permission, deps.client)
      }

      for (const question of questions.data ?? []) {
        if (stopped || deps.signal.aborted) return
        const walk =
          resolutionPolicy.kind === "tiered"
            ? await readRunContextChain(question.sessionID, roots, deps.client)
            : { ownership: await isRunOwned(question.sessionID, roots, deps.client), contextChain: [] }
        if (stopped || deps.signal.aborted) return
        if (walk.ownership.owned) await resolveQuestion(question, walk.ownership.depth, walk.contextChain, deps.client, resolutionPolicy, deps.parentSessionID, deps.signal)
      }
    } finally {
      polling = false
      if (deps.signal.aborted) stop()
    }
  }

  if (deps.signal.aborted) return { stop }

  deps.signal.addEventListener("abort", stop, { once: true })
  timer = setInterval(() => {
    void poll().catch(() => {
      // The watcher is best-effort discovery. Do not let a transient list/session.get failure, or a reply/reject
      // failure on a now-stale requestID, leak an unhandled rejection or stop unrelated Run work; the next interval
      // retries from a fresh instance-wide list.
    })
  }, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)

  return { stop }
}

async function resolvePermission(permission: PendingPermission, client: WorkflowClient): Promise<void> {
  // DR-001: resolve only the live requestID returned by this poll with a one-shot allow. Never use "always";
  // that would mutate the Subagent session's approved-permission state instead of resolving this residual ask.
  await client.permission.reply({ requestID: permission.id, reply: "once" })
}

async function resolveQuestion(
  question: PendingQuestion,
  depth: number,
  accumulatedContext: SeedContext[],
  client: WorkflowClient,
  policy: QuestionResolutionPolicy,
  parentSessionID: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (depth < 2) return
  if (policy.kind === "reject") {
    await client.question.reject({ requestID: question.id })
    return
  }

  if (!parentSessionID) {
    await client.question.reject({ requestID: question.id })
    return
  }

  const seedContext = accumulatedContext[0] ?? (await readSeedContext(question.sessionID, client))
  const proxyResult = await proxyAnswer(question, seedContext, {
    client,
    parentSessionID,
    signal,
    standInSubagent: policy.standInSubagent,
  })
  if (signal.aborted) return

  if ("answered" in proxyResult) {
    await client.question.reply({ requestID: question.id, answers: proxyResult.answered })
    return
  }

  if (policy.humanReachable === true) {
    await escalateQuestion(question, accumulatedContext.length > 0 ? accumulatedContext : [seedContext], depth, client, policy, parentSessionID, signal)
    return
  }

  await client.question.reject({ requestID: question.id })
}

async function readSeedContext(sessionID: string, client: WorkflowClient): Promise<SeedContext> {
  return (await readSessionContext(sessionID, client)).seedContext
}

async function readSessionContext(sessionID: string, client: WorkflowClient): Promise<SessionContextRead> {
  const session = await client.session.get({ sessionID })
  return {
    seedContext: { title: session.data?.title ?? "", firstUserText: await readFirstUserText(sessionID, client) },
    parentID: session.data?.parentID,
  }
}

async function readRunContextChain(sessionID: string, roots: ReadonlySet<string>, client: WorkflowClient): Promise<RunContextWalk> {
  if (!sessionID) return { ownership: { owned: false, depth: 0 }, contextChain: [] }

  const visited = new Set<string>()
  const chain: SessionWalkEntry[] = []
  let currentID: string | undefined = sessionID

  for (let depth = 1; currentID && depth <= MAX_PARENT_WALK_HOPS; depth += 1) {
    if (visited.has(currentID)) return { ownership: { owned: false, depth }, contextChain: [] }
    visited.add(currentID)

    const session = await client.session.get({ sessionID: currentID })
    const parentID = session.data?.parentID
    chain.push({ id: currentID, title: session.data?.title ?? "" })
    if (roots.has(currentID)) return { ownership: { owned: true, depth }, contextChain: await readContextForChain(chain, client) }
    if (!parentID) return { ownership: { owned: false, depth }, contextChain: [] }
    currentID = parentID
  }

  return { ownership: { owned: false, depth: MAX_PARENT_WALK_HOPS }, contextChain: [] }
}

async function readContextForChain(chain: SessionWalkEntry[], client: WorkflowClient): Promise<SeedContext[]> {
  return Promise.all(
    chain.map(async (entry) => ({
      title: entry.title,
      firstUserText: await readFirstUserText(entry.id, client),
    })),
  )
}

async function readFirstUserText(sessionID: string, client: WorkflowClient): Promise<string> {
  const messages = await client.session.messages({ sessionID })
  const firstUser = messages.data?.find((message) => message.info.role === "user")
  return (
    firstUser?.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("") ?? ""
  )
}

async function proxyAnswer(
  question: PendingQuestion,
  seedContext: SeedContext,
  deps: { client: WorkflowClient; parentSessionID: string; signal: AbortSignal; standInSubagent: string },
): Promise<{ answered: string[][] } | { abstained: true }> {
  const result = await runAgent(deps.client, deps.parentSessionID, buildProxyPrompt(question, seedContext), {
    subagent: deps.standInSubagent,
    signal: deps.signal,
    timeoutMs: DEFAULT_PROXY_ANSWER_TIMEOUT_MS,
  })

  if (!result.ok || result.kind !== "text") return { abstained: true }

  const parsed = parseAbstainOrAnswer(result.text)
  if ("abstained" in parsed) return parsed

  return coerceToQuestionAnswers(parsed.answer, question)
}

async function escalateQuestion(
  question: PendingQuestion,
  accumulatedContext: SeedContext[],
  hop: number,
  client: WorkflowClient,
  policy: Extract<QuestionResolutionPolicy, { kind: "tiered" }>,
  parentSessionID: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  if (!parentSessionID || hop >= maxEscalationHops(policy)) {
    await client.question.reject({ requestID: question.id })
    return
  }

  const result = await runAgent(client, parentSessionID, buildEscalationPrompt(question, accumulatedContext), {
    signal,
    timeoutMs: DEFAULT_ESCALATION_TIMEOUT_MS,
  })
  if (signal.aborted) return

  if (!result.ok || result.kind !== "text") {
    await client.question.reject({ requestID: question.id })
    return
  }

  const parsed = parseAbstainOrAnswer(result.text)
  if ("abstained" in parsed) {
    await client.question.reject({ requestID: question.id })
    return
  }

  const coerced = coerceToQuestionAnswers(parsed.answer, question)
  if ("answered" in coerced) {
    await client.question.reply({ requestID: question.id, answers: coerced.answered })
    return
  }

  await client.question.reject({ requestID: question.id })
}

function maxEscalationHops(policy: Extract<QuestionResolutionPolicy, { kind: "tiered" }>): number {
  if (Number.isFinite(policy.maxEscalationHops) && policy.maxEscalationHops >= 0) return Math.floor(policy.maxEscalationHops)
  return DEFAULT_MAX_ESCALATION_HOPS
}

function buildProxyPrompt(question: PendingQuestion, seedContext: SeedContext): string {
  const questions = question.questions
    .map((q, index) => {
      const options = q.options.map((option) => `- ${option.label}: ${option.description}`).join("\n")
      return [`Question ${index + 1}: ${q.header}`, q.question, "Options:", options].join("\n")
    })
    .join("\n\n")

  return [
    "You are resolving a pending Question for a Workflow Run as a text-mode stand-in.",
    `Answer ONLY if the seeded parent context below directly supports one of the listed option labels; otherwise reply EXACTLY with ${UNANSWERABLE_SENTINEL}.`,
    "Do not guess. Do not use or report a confidence score. Use only the seeded context below.",
    "If supported, reply ONLY with option label(s): one line per question; use comma-separated labels only for multiple-choice questions.",
    "",
    "Seeded parent context:",
    `Title: ${seedContext.title}`,
    "First user message:",
    seedContext.firstUserText,
    "",
    "Pending Question:",
    questions,
  ].join("\n")
}

function buildEscalationPrompt(question: PendingQuestion, accumulatedContext: SeedContext[]): string {
  const context = accumulatedContext
    .map((entry, index) => [`Context ${index + 1}:`, `Title: ${entry.title}`, "First user message:", entry.firstUserText || "(none)"].join("\n"))
    .join("\n\n")
  const questions = question.questions
    .map((q, index) => {
      const options = q.options.map((option) => `- ${option.label}: ${option.description}`).join("\n")
      return [`Question ${index + 1}: ${q.header}`, q.question, "Options:", options].join("\n")
    })
    .join("\n\n")

  return [
    "You are a depth-1 human-escalation Unit for a Workflow Run.",
    "Use the Question tool to surface the pending Question to the operator with the accumulated context chain below. Do NOT answer from the context yourself; it is included so the operator can answer the nested prompt.",
    `If no operator answer is available, reply EXACTLY with ${UNANSWERABLE_SENTINEL}.`,
    "After the operator answers, reply ONLY with option label(s): one line per question; use comma-separated labels only for multiple-choice questions.",
    "",
    "Accumulated context chain (pending question session first, then each parent up to the Run root):",
    context,
    "",
    "Pending Question to surface:",
    questions,
  ].join("\n")
}

export function parseAbstainOrAnswer(text: string): ParsedProxyAnswer {
  const trimmed = text.trim()
  if (trimmed === UNANSWERABLE_SENTINEL) return { abstained: true }
  const answer = trimmed
    .split(/\r?\n/)
    .map((line) => parseAnswerLine(line))
    .filter((line) => line.length > 0)
  return answer.length > 0 ? { answer } : { abstained: true }
}

function parseAnswerLine(line: string): string[] {
  const cleaned = line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim()

  return cleaned
    .split(",")
    .map((part) => part.trim().replace(/^['\"]|['\"]$/g, ""))
    .filter(Boolean)
}

function coerceToQuestionAnswers(answer: string[][], question: PendingQuestion): { answered: string[][] } | { abstained: true } {
  if (answer.length !== question.questions.length) return { abstained: true }

  const coerced: string[][] = []
  for (const [index, q] of question.questions.entries()) {
    const requested = answer[index] ?? []
    if (requested.length === 0) return { abstained: true }
    if (!q.multiple && requested.length !== 1) return { abstained: true }

    const labels: string[] = []
    for (const candidate of requested) {
      const option = q.options.find((o) => o.label.toLowerCase() === candidate.toLowerCase())
      if (!option) return { abstained: true }
      labels.push(option.label)
    }
    coerced.push(labels)
  }

  return { answered: coerced }
}

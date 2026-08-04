import type { PendingPermission, PendingQuestion, WorkflowClient } from "./client"
import { runAgent } from "./runner"
import type { InteractionQuestion, PendingInteraction } from "./runs"

export type QuestionResolutionPolicy =
  | { kind: "reject" }
  | { kind: "tiered"; standInSubagent: string; maxEscalationHops: number; humanReachable?: boolean }
  /**
   * Human first, automation second.
   *
   * An owned request is PUBLISHED and left alone while a surface is attached and the grace has not run out;
   * after that — or with nobody attached at all — `fallback` runs, byte-for-byte the headless behaviour. The
   * grace is the only deadline in this path: its expiry falls back, it never fails a unit.
   */
  | {
      kind: "human-first"
      graceMs: number
      /** Whether any surface is currently subscribed. Read per poll, because surfaces come and go mid-run. */
      attached: () => boolean
      /**
       * Who is asked first.
       *
       * `human` publishes straight away. `proxy-then-human` runs the grounded proxy rung FIRST and only offers
       * the question to a person when the proxy abstains — cheaper, and it means a question the run's own
       * context already answers never interrupts anyone.
       */
      questions: "human" | "proxy-then-human"
      /**
       * Whether an owned PERMISSION also gets first refusal.
       *
       * Not in the original sketch, but `meta.interaction.permissions` declares the choice and a declared knob
       * that does nothing is worse than no knob. `auto` keeps today's silent allow-once at any depth.
       */
      permissions: "auto" | "human"
      fallback: Extract<QuestionResolutionPolicy, { kind: "tiered" }>
    }

/** What the watcher observed about one interaction, for the run store to project. */
export type InteractionEvent =
  | { kind: "pending"; interaction: PendingInteraction }
  | { kind: "resolved"; requestID: string; by: "human" | "automation" }
  /**
   * An owned permission the watcher allowed without asking anyone.
   *
   * A third member rather than a `pending`/`resolved` pair, because those two mean "someone has to decide" and
   * an auto-allowed ask does not: emitting the pair would flash the sidebar's question badge on every `bash`
   * call a subagent makes, which is precisely how a badge stops meaning anything. This lands in the run's log —
   * the activity feed that already exists — so the allow is visible without being an interruption.
   */
  | { kind: "auto-allowed"; requestID: string; permission: string; depth: number }

export interface WatcherDeps {
  client: WorkflowClient
  /** Parent session for this Run; required by the tiered proxy-answer policy so the stand-in Unit is Run-owned. */
  parentSessionID?: string
  runOwnedRoots: () => ReadonlySet<string>
  signal: AbortSignal
  pollIntervalMs?: number
  resolutionPolicy?: QuestionResolutionPolicy
  /** Where interaction observations go. Absent ⇒ the watcher is invisible, exactly as it was before Phase 4. */
  onInteraction?: (event: InteractionEvent) => void
  /**
   * Which unit owns a run-root session, so a published interaction can name where it came from.
   *
   * Supplied by the orchestrator, which is the only party that knows both. Absent (or unmatched) ⇒ `unitId`
   * stays `null`, and the pane falls back to naming the depth.
   */
  unitIdForSession?: (sessionID: string) => string | null
}

export interface Watcher {
  stop(): void
  /**
   * Expire a published request's grace right now, so automation takes it on the next poll.
   *
   * What `esc leave for automation` means for an agent-raised question. Deliberately NOT the host's
   * `question.reject`: the person declining to answer is not declining the question, they are declining to be
   * the one who answers it — and the ladder may well ground it from the run's own context.
   */
  handOff(requestID: string): boolean
}

export interface RunOwnership {
  owned: boolean
  /**
   * Depth is one-based from the pending prompt's originating session to the matched Run root: a pending prompt
   * on a Run root is depth 1, a direct child is depth 2, and each deeper descendant increments from there.
   * B4 depends on this convention: depth-1 questions are preserved, while depth >= 2 questions are nested.
   */
  depth: number
  /**
   * The Run root the walk landed on — a Unit's child session, or the Run's parent session.
   *
   * Carried so an interaction can be attributed to the Unit that owns it: the asking session may be several
   * hops below the Unit, and the root is the only point in the chain the engine has a name for.
   */
  root: string | null
  /**
   * The session one hop BELOW {@link RunOwnership.root} — which, when the root is the Run's parent, is the
   * Unit's own child session.
   *
   * Needed because `runOwnedRoots()` only records a Unit's session once that Unit has SETTLED: while it is
   * running, an interaction raised inside it walks past its session to the Run parent, so the root alone
   * cannot name the Unit. Found live — the run browser attributed a grandchild's question to "run" while the
   * unit that was blocked on it sat one row below. `null` when the request was raised on the root itself.
   */
  unitSession: string | null
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
  const unowned = (depth: number): RunOwnership => ({ owned: false, depth, root: null, unitSession: null })
  if (!sessionID) return unowned(0)

  const visited = new Set<string>()
  let currentID: string | undefined = sessionID
  /** The hop before the current one, so the walk can name the session directly beneath the matched root. */
  let previousID: string | null = null

  for (let depth = 1; currentID && depth <= MAX_PARENT_WALK_HOPS; depth += 1) {
    if (roots.has(currentID)) return { owned: true, depth, root: currentID, unitSession: previousID }
    if (visited.has(currentID)) return unowned(depth)
    visited.add(currentID)

    const session = await client.session.get({ sessionID: currentID })
    const parentID = session.data?.parentID
    if (!parentID) return unowned(depth)
    previousID = currentID
    currentID = parentID
  }

  return unowned(MAX_PARENT_WALK_HOPS)
}

/**
 * Start the descendant-interaction watcher. Owned pending permission asks are resolved with a one-shot allow;
 * owned pending questions follow the configured question-resolution policy. Non-owned entries are never touched.
 */
export function startWatcher(deps: WatcherDeps): Watcher {
  const resolutionPolicy: QuestionResolutionPolicy = deps.resolutionPolicy ?? { kind: "reject" }
  const humanFirst = resolutionPolicy.kind === "human-first" ? resolutionPolicy : null
  /**
   * The ladder a human-first policy hands back to; the sole policy otherwise.
   *
   * Under human-first the ladder runs with `humanReachable` forced FALSE, and that is not a detail. The
   * escalation rung spends a depth-1 unit surfacing the question through the host's own Question dock — i.e. it
   * asks a person. But this ladder only ever runs because a person already declined: they pressed `esc`, or
   * they let the grace lapse. Re-asking them through a different surface is not an escalation, it is the same
   * question again in a worse place, and it hangs the run until that dialog is answered.
   *
   * Found live: `esc leave for automation` left a run sitting for five minutes on a native dialog nobody had
   * asked for. `esc` means automation.
   */
  const automationPolicy: Exclude<QuestionResolutionPolicy, { kind: "human-first" }> =
    resolutionPolicy.kind === "human-first"
      ? { ...resolutionPolicy.fallback, humanReachable: false }
      : resolutionPolicy
  let stopped = false
  let polling = false
  let timer: ReturnType<typeof setInterval> | null = null

  /** Requests published to a surface and still waiting: requestID → when automation takes it back. */
  const published = new Map<string, number>()
  /** Requests whose fallback is mid-flight, so a slow ladder is never dispatched twice for one request. */
  const resolving = new Set<string>()
  /** Requests the grounded proxy rung has already abstained on, under `proxy-then-human`. */
  const proxied = new Set<string>()

  const emit = (event: InteractionEvent) => {
    try {
      deps.onInteraction?.(event)
    } catch {
      // An observer is observation-only; a throwing surface must never stop the resolution it was watching.
    }
  }

  /**
   * The unit that owns an interaction's session, or `null` when it came from the run root.
   *
   * Tries the matched ROOT first (a settled unit's own session is a root), then the session one hop below it —
   * which is where a RUNNING unit's session sits, since roots are only recorded as units settle.
   */
  const unitIdFor = (ownership: RunOwnership): string | null => {
    const resolve = deps.unitIdForSession
    if (!resolve) return null
    return (ownership.root ? resolve(ownership.root) : null) ?? (ownership.unitSession ? resolve(ownership.unitSession) : null)
  }

  /** Drop a published request and tell the store why it went away. */
  const unpublish = (requestID: string, by: "human" | "automation") => {
    if (!published.delete(requestID)) return
    emit({ kind: "resolved", requestID, by })
  }

  const stop = () => {
    if (stopped) return
    stopped = true
    // Anything still published is no longer answerable — the run is over or the watcher is gone. Clearing it
    // is what keeps a dead run from carrying a question badge forever.
    for (const requestID of [...published.keys()]) unpublish(requestID, "automation")
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    deps.signal.removeEventListener("abort", stop)
  }

  /**
   * Decide what to do with one owned request under the human-first policy.
   *
   * Returns `"wait"` while it belongs to the human, `"fallback"` once it does not.
   */
  const humanFirstTurn = (
    requestID: string,
    build: () => PendingInteraction,
  ): "wait" | "fallback" => {
    if (!humanFirst) return "fallback"
    if (!humanFirst.attached()) {
      // No surface: this is the headless path, and a request published to nobody has to come back at once.
      unpublish(requestID, "automation")
      return "fallback"
    }
    const deadline = published.get(requestID)
    if (deadline === undefined) {
      const interaction = build()
      published.set(requestID, interaction.graceEndsAt ?? Number.POSITIVE_INFINITY)
      emit({ kind: "pending", interaction })
      return "wait"
    }
    if (Date.now() < deadline) return "wait"
    unpublish(requestID, "automation")
    return "fallback"
  }

  const poll = async () => {
    if (stopped || deps.signal.aborted || polling) return
    polling = true
    try {
      const roots = deps.runOwnedRoots()
      const [permissions, questions] = await Promise.all([deps.client.permission.list(), deps.client.question.list()])
      if (stopped || deps.signal.aborted) return

      // Anything we published that is no longer pending in the host was answered by somebody — in practice, the
      // human we published it for. Reconciled BEFORE the per-request work so an answer landing mid-poll is not
      // mistaken for a grace expiry.
      const live = new Set([
        ...(permissions.data ?? []).map((permission) => permission.id),
        ...(questions.data ?? []).map((question) => question.id),
      ])
      for (const requestID of [...published.keys()]) {
        if (!live.has(requestID)) unpublish(requestID, "human")
      }

      for (const permission of permissions.data ?? []) {
        if (stopped || deps.signal.aborted) return
        if (resolving.has(permission.id)) continue
        const ownership = await isRunOwned(permission.sessionID, roots, deps.client)
        if (stopped || deps.signal.aborted) return
        if (!ownership.owned) continue
        if (
          humanFirst?.permissions === "human" &&
          humanFirstTurn(permission.id, () =>
            toPendingInteraction(permission, ownership.depth, humanFirst.graceMs, {
              unitId: unitIdFor(ownership),
            }),
          ) === "wait"
        ) {
          continue
        }
        resolving.add(permission.id)
        try {
          await resolvePermission(permission, deps.client)
          emit({
            kind: "auto-allowed",
            requestID: permission.id,
            permission: permission.permission,
            depth: ownership.depth,
          })
        } finally {
          resolving.delete(permission.id)
        }
      }

      for (const question of questions.data ?? []) {
        if (stopped || deps.signal.aborted) return
        if (resolving.has(question.id)) continue
        const walk =
          automationPolicy.kind === "tiered"
            ? await readRunContextChain(question.sessionID, roots, deps.client)
            : { ownership: await isRunOwned(question.sessionID, roots, deps.client), contextChain: [] }
        if (stopped || deps.signal.aborted) return
        if (!walk.ownership.owned) continue
        // Depth 1 belongs to the host's own question dock, human-first or not — the native UI is already the
        // better surface for it, and taking it over would replace a good dialog with a worse one.
        if (walk.ownership.depth < 2) continue
        // `proxy-then-human`: the grounded rung runs BEFORE anyone is interrupted, and only its abstention
        // makes the question a person's problem. Run once per request, then remembered.
        if (humanFirst?.questions === "proxy-then-human" && !proxied.has(question.id)) {
          resolving.add(question.id)
          try {
            const outcome = await resolveQuestion(
              question,
              walk.ownership.depth,
              walk.contextChain,
              deps.client,
              automationPolicy,
              deps.parentSessionID,
              deps.signal,
              "proxy",
            )
            if (outcome === "resolved") continue
            proxied.add(question.id)
          } finally {
            resolving.delete(question.id)
          }
          if (stopped || deps.signal.aborted) return
        }
        if (
          humanFirst &&
          humanFirstTurn(question.id, () =>
            toPendingInteraction(question, walk.ownership.depth, humanFirst.graceMs, {
              unitId: unitIdFor(walk.ownership),
            }),
          ) === "wait"
        ) {
          continue
        }
        resolving.add(question.id)
        try {
          await resolveQuestion(
            question,
            walk.ownership.depth,
            walk.contextChain,
            deps.client,
            automationPolicy,
            deps.parentSessionID,
            deps.signal,
            // The proxy already ran and abstained; running it again would spend a second unit to learn the
            // same thing.
            proxied.has(question.id) ? "escalate" : "all",
          )
        } finally {
          resolving.delete(question.id)
        }
      }
    } finally {
      polling = false
      if (deps.signal.aborted) stop()
    }
  }

  const handOff = (requestID: string): boolean => {
    if (!published.has(requestID)) return false
    // Zero, not delete: the entry has to survive until the next poll so `humanFirstTurn` can emit the
    // `resolved` that takes the row off every surface at the same moment the ladder picks it up.
    published.set(requestID, 0)
    void poll().catch(() => {})
    return true
  }

  if (deps.signal.aborted) return { stop, handOff }

  deps.signal.addEventListener("abort", stop, { once: true })
  timer = setInterval(() => {
    void poll().catch(() => {
      // The watcher is best-effort discovery. Do not let a transient list/session.get failure, or a reply/reject
      // failure on a now-stale requestID, leak an unhandled rejection or stop unrelated Run work; the next interval
      // retries from a fresh instance-wide list.
    })
  }, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)

  return { stop, handOff }
}

/**
 * The two answers a permission ask is offered.
 *
 * `always` is deliberately absent, per the standing decision not to persist permission grants: a reply here is
 * resolving one residual ask inside a run, and `always` would mutate the subagent session's approved-permission
 * state instead. The control action still admits it for an API caller; no surface offers it.
 */
const PERMISSION_OPTIONS: InteractionQuestion["options"] = [
  { label: "once", description: "Allow this one request" },
  { label: "reject", description: "Refuse it; the unit sees a denial" },
]

function permissionQuestion(permission: PendingPermission): InteractionQuestion {
  const patterns = permission.patterns.filter(Boolean).join(", ")
  return {
    header: `Permission: ${permission.permission}`,
    prompt: patterns ? `Allow \`${permission.permission}\` for ${patterns}?` : `Allow \`${permission.permission}\`?`,
    options: PERMISSION_OPTIONS.map((option) => ({ ...option })),
    multiple: false,
    custom: false,
  }
}

/**
 * Normalize a host-pending request into the one shape every surface renders.
 *
 * A question and a permission arrive from different endpoints with different fields and mean the same thing to
 * the person looking at them — "something in your run is waiting on you" — so they become one type here rather
 * than two branches in every view downstream.
 */
export function toPendingInteraction(
  request: PendingQuestion | PendingPermission,
  depth: number,
  graceMs: number | null,
  opts: { unitId?: string | null; now?: number } = {},
): PendingInteraction {
  const now = opts.now ?? Date.now()
  const isQuestion = "questions" in request
  return {
    requestID: request.id,
    kind: isQuestion ? "question" : "permission",
    origin: "agent",
    sessionID: request.sessionID,
    unitId: opts.unitId ?? null,
    depth,
    questions: isQuestion
      ? request.questions.map((question) => ({
          header: question.header,
          prompt: question.question,
          options: question.options.map((option) => ({ ...option })),
          multiple: question.multiple === true,
          custom: question.custom === true,
        }))
      : [permissionQuestion(request)],
    raisedAt: now,
    graceEndsAt: graceMs === null || !Number.isFinite(graceMs) ? null : now + Math.max(0, graceMs),
  }
}

async function resolvePermission(permission: PendingPermission, client: WorkflowClient): Promise<void> {
  // DR-001: resolve only the live requestID returned by this poll with a one-shot allow. Never use "always";
  // that would mutate the Subagent session's approved-permission state instead of resolving this residual ask.
  await client.permission.reply({ requestID: permission.id, reply: "once" })
}

/**
 * Which rungs of the ladder to run.
 *
 * `proxy` and `escalate` exist for the `proxy-then-human` policy, which needs the grounded rung to run on its
 * own and then STOP — so the question can be offered to a person instead of being rejected the moment the proxy
 * abstains. `all` is the original, undivided ladder.
 */
type LadderStage = "all" | "proxy" | "escalate"

async function resolveQuestion(
  question: PendingQuestion,
  depth: number,
  accumulatedContext: SeedContext[],
  client: WorkflowClient,
  policy: Exclude<QuestionResolutionPolicy, { kind: "human-first" }>,
  parentSessionID: string | undefined,
  signal: AbortSignal,
  stage: LadderStage = "all",
): Promise<"resolved" | "abstained"> {
  if (depth < 2) return "resolved"
  if (policy.kind === "reject") {
    if (stage === "proxy") return "abstained"
    await client.question.reject({ requestID: question.id })
    return "resolved"
  }

  if (!parentSessionID) {
    if (stage === "proxy") return "abstained"
    await client.question.reject({ requestID: question.id })
    return "resolved"
  }

  const seedContext = accumulatedContext[0] ?? (await readSeedContext(question.sessionID, client))

  if (stage !== "escalate") {
    const proxyResult = await proxyAnswer(question, seedContext, {
      client,
      parentSessionID,
      signal,
      standInSubagent: policy.standInSubagent,
    })
    if (signal.aborted) return "resolved"

    if ("answered" in proxyResult) {
      await client.question.reply({ requestID: question.id, answers: proxyResult.answered })
      return "resolved"
    }
    // The grounded rung had nothing. Under `proxy-then-human` that is the cue to ask a person, not to give up.
    if (stage === "proxy") return "abstained"
  }

  if (policy.humanReachable === true) {
    await escalateQuestion(question, accumulatedContext.length > 0 ? accumulatedContext : [seedContext], depth, client, policy, parentSessionID, signal)
    return "resolved"
  }

  await client.question.reject({ requestID: question.id })
  return "resolved"
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
  const unowned = (depth: number): RunContextWalk => ({
    ownership: { owned: false, depth, root: null, unitSession: null },
    contextChain: [],
  })
  if (!sessionID) return unowned(0)

  const visited = new Set<string>()
  const chain: SessionWalkEntry[] = []
  let currentID: string | undefined = sessionID
  let previousID: string | null = null

  for (let depth = 1; currentID && depth <= MAX_PARENT_WALK_HOPS; depth += 1) {
    if (visited.has(currentID)) return unowned(depth)
    visited.add(currentID)

    const session = await client.session.get({ sessionID: currentID })
    const parentID = session.data?.parentID
    chain.push({ id: currentID, title: session.data?.title ?? "" })
    if (roots.has(currentID)) {
      return {
        ownership: { owned: true, depth, root: currentID, unitSession: previousID },
        contextChain: await readContextForChain(chain, client),
      }
    }
    if (!parentID) return unowned(depth)
    previousID = currentID
    currentID = parentID
  }

  return unowned(MAX_PARENT_WALK_HOPS)
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

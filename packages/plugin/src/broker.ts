import type {
  ApprovalDetail,
  InteractionQuestion,
  PendingInteraction,
  PermissionDetail,
  ResolvedInteraction,
} from "./protocol"
import { isTerminal, type RunStore } from "./runs"
/**
 * The interaction broker — everything in a Run that waits on a person, published as Run state and settled
 * through one path.
 *
 * Four kinds share it (protocol `InteractionOrigin`):
 *
 * - `script`: `ctx.ask` — a closed set of labels with a REQUIRED fallback, so a headless Run never waits.
 * - `agent`: a Unit's model called the built-in `question` tool; the plugin wraps that tool for Unit sessions
 *   and routes the call here. Headless → `null`, and the tool tells the model to proceed.
 * - `permission`: a Unit's tool call hit an `ask` rule. The native request stays in OpenCode; this records it
 *   against the Run and answers it through the host (`ctx.permission.reply`).
 * - `engine`: the engine's own questions — today, approval of an inline (model-authored) Workflow.
 *
 * A published interaction never has a deadline unless the author set one (`graceMs`): most questions worth
 * interrupting someone for are worth waiting for. Stopping the Run releases everything it was waiting on.
 */
import type { AskOptions, AskQuestion } from "./workflow"

export type PermissionDecision = "once" | "always" | "reject"

export interface BrokerOptions {
  store: RunStore
  /** Is a person watching right now? Read at the moment of asking, because surfaces come and go. */
  attached: () => boolean
  /** Answer a native permission request (host call). */
  replyPermission?: (input: {
    sessionID: string
    requestID: string
    decision: PermissionDecision
    message?: string
  }) => Promise<void>
}

export interface Broker {
  /** `ctx.ask`: publish and wait; resolves to the fallback when headless, on grace expiry, or on Run abort. */
  ask(input: {
    runId: string
    sessionID: string
    form: AskQuestion[]
    options: AskOptions
    defaultGraceMs: number | null
    signal: AbortSignal
  }): Promise<string[][]>
  /** A Unit model's question. Resolves to `null` when nobody can answer or the person dismissed it. */
  askAgent(input: {
    runId: string
    unitId: string
    sessionID: string
    questions: InteractionQuestion[]
    signal: AbortSignal
  }): Promise<{ answers: string[][]; by: ResolvedInteraction["by"] } | null>
  /** A native permission request raised inside a Unit. Idempotent per requestID. */
  permission(input: { runId: string; unitId: string | null; sessionID: string; detail: PermissionDetail }): void
  /** The host reports a permission request resolved (by anyone). */
  permissionResolved(requestID: string, decision: string | undefined): void
  /** A native form raised inside a Run (not interceptable). Recorded so surfaces with the form API can answer it. */
  form(input: {
    runId: string
    unitId: string | null
    sessionID: string
    formID: string
    questions: InteractionQuestion[]
  }): void
  /** The host reports a native form replied or cancelled. */
  formResolved(formID: string, answers: string[][] | null): void
  /** Inline-run approval. Resolves to the decision; headless resolves at once to `null` (no one to ask). */
  approval(input: {
    runId: string
    sessionID: string
    detail: ApprovalDetail
    signal: AbortSignal
  }): Promise<"once" | "project" | "reject" | null>
  /** A surface's answer. `false` when the interaction is unknown, settled, or the answer is not acceptable. */
  reply(runId: string, interactionId: string, answers: string[][]): Promise<boolean>
  /** A surface hands the interaction back: fallback for script asks, dismissal for questions, reject for asks. */
  cancel(runId: string, interactionId: string): Promise<boolean>
  /** Release everything a Run is waiting on (the Run ended or stopped). */
  releaseRun(runId: string): void
  /** Release what one Unit is waiting on (it ended, was stopped or timed out): no late answer may reach it. */
  releaseUnit(runId: string, unitId: string): void
  pending(): number
}

/** Coerce an answer to the offered labels (case-insensitive), or reject it. Free text only where `custom`. */
export function coerceAnswers(form: readonly InteractionQuestion[], answers: readonly string[][]): string[][] | null {
  if (answers.length !== form.length) return null
  const coerced: string[][] = []
  for (const [index, question] of form.entries()) {
    const requested = answers[index] ?? []
    if (requested.length === 0) return null
    if (!question.multiple && requested.length !== 1) return null
    const labels: string[] = []
    for (const candidate of requested) {
      const option = question.options.find((entry) => entry.label.toLowerCase() === candidate.toLowerCase())
      const label = option ? option.label : question.custom && candidate.trim().length > 0 ? candidate : null
      if (label === null) return null
      if (!labels.includes(label)) labels.push(label)
    }
    coerced.push(labels)
  }
  return coerced
}

export function toInteractionQuestions(form: readonly AskQuestion[]): InteractionQuestion[] {
  return form.map((question) => ({
    header: question.header,
    prompt: question.prompt,
    options: question.options.map((option) => ({ ...option })),
    multiple: question.multiple === true,
    custom: question.custom === true,
  }))
}

const PERMISSION_OPTIONS = [
  { label: "Allow once", description: "Allow this request only." },
  { label: "Always allow", description: "Allow matching requests from now on (saved by OpenCode)." },
  { label: "Reject", description: "Refuse; the Unit is told why." },
]

const APPROVAL_OPTIONS = [
  { label: "Run once", description: "Run this inline Workflow now." },
  { label: "Always for this project", description: "Run inline Workflows in this project without asking." },
  { label: "Reject", description: "Do not run it." },
]

interface Waiter {
  runId: string
  interaction: PendingInteraction
  /** Settle with answers, or with the cancel path. */
  settle: (result: {
    answers: string[][] | null
    by: ResolvedInteraction["by"]
    outcome: ResolvedInteraction["outcome"]
  }) => void
  accept: (answers: string[][]) => string[][] | null
  timer: ReturnType<typeof setTimeout> | null
  /** A permission decision is on its way to the host: no second decision may start. */
  sending?: boolean
  /** Its Unit or Run ended while a decision was on its way: make sure the request ends up rejected. */
  released?: boolean
}

export function createBroker(options: BrokerOptions): Broker {
  const waiters = new Map<string, Waiter>()
  /** Native permission requestID → interactionId, so a host-side resolution files the record once. */
  const permissions = new Map<
    string,
    { runId: string; unitId: string | null; interactionId: string; sessionID: string }
  >()
  const forms = new Map<string, { runId: string; unitId: string | null; interactionId: string }>()

  const publish = (runId: string, interaction: PendingInteraction): boolean => {
    // A finished Run cannot wait on anyone: the asker gets its fallback at once instead of a waiter that never settles.
    const status = options.store.get(runId)?.status
    if (!status || isTerminal(status)) return false
    try {
      options.store.apply({ type: "interaction.pending", runId, interaction })
      return true
    } catch {
      return false
    }
  }

  const resolveRecord = (
    runId: string,
    interactionId: string,
    by: ResolvedInteraction["by"],
    answers: string[][] | undefined,
    outcome: ResolvedInteraction["outcome"],
  ) => {
    try {
      options.store.apply({
        type: "interaction.resolved",
        runId,
        interactionId,
        by,
        ...(answers ? { answers } : {}),
        ...(outcome ? { outcome } : {}),
      })
    } catch {
      // The Run may be gone (a store swapped in a test); the waiter is still released by the caller.
    }
  }

  const finish = (
    interactionId: string,
    result: { answers: string[][] | null; by: ResolvedInteraction["by"]; outcome: ResolvedInteraction["outcome"] },
  ): boolean => {
    const waiter = waiters.get(interactionId)
    if (!waiter) return false
    waiters.delete(interactionId)
    if (waiter.timer) clearTimeout(waiter.timer)
    resolveRecord(waiter.runId, interactionId, result.by, result.answers ?? undefined, result.outcome)
    waiter.settle(result)
    return true
  }

  const rejectNative = (sessionID: string, requestID: string, message: string) => {
    if (!options.replyPermission) return
    void options.replyPermission({ sessionID, requestID, decision: "reject", message }).catch((error: unknown) => {
      // The request may already be settled (answered, or its session interrupted): nothing is left to close.
      console.warn(
        `[workflow] could not reject permission ${requestID}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /** Close what matches: reject native permission requests (or flag in-flight ones), settle the waiters. */
  const release = (matches: (entry: { runId: string; unitId: string | null }) => boolean, message: string) => {
    for (const [requestID, entry] of Array.from(permissions)) {
      if (!matches(entry)) continue
      permissions.delete(requestID)
      const waiter = waiters.get(entry.interactionId)
      if (waiter?.sending) waiter.released = true
      else rejectNative(entry.sessionID, requestID, message)
    }
    for (const [interactionId, waiter] of Array.from(waiters)) {
      if (!matches({ runId: waiter.runId, unitId: waiter.interaction.unitId })) continue
      finish(interactionId, { answers: null, by: "automation", outcome: "cancelled" })
    }
    for (const [formID, entry] of Array.from(forms)) if (matches(entry)) forms.delete(formID)
  }

  /**
   * Send one permission decision to the host. The waiter is reserved first, so a concurrent reply or cancel cannot
   * send a second, conflicting decision. Once the host has it, the call succeeds even if the host's own
   * "replied" event (or the Run ending) filed the record first — the decision WAS delivered.
   */
  const sendPermission = async (
    interactionId: string,
    waiter: Waiter,
    decision: PermissionDecision,
    answers: string[][],
    message?: string,
  ): Promise<boolean> => {
    if (!options.replyPermission || !waiter.interaction.permission) return false
    waiter.sending = true
    const request = { sessionID: waiter.interaction.sessionID, requestID: waiter.interaction.permission.requestID }
    try {
      await options.replyPermission({ ...request, decision, ...(message ? { message } : {}) })
    } catch (error) {
      waiter.sending = false
      // Released while this failed: nobody will answer it now, so close it with a reject.
      if (waiter.released) rejectNative(request.sessionID, request.requestID, "The workflow Unit ended.")
      console.warn(`[workflow] permission reply failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    permissions.delete(waiter.interaction.permission.requestID)
    finish(interactionId, { answers, by: "human", outcome: decision === "reject" ? "rejected" : "answered" })
    return true
  }

  const wait = (input: {
    runId: string
    interaction: PendingInteraction
    graceMs: number | null
    signal: AbortSignal
    accept: (answers: string[][]) => string[][] | null
    onGrace: () => { answers: string[][] | null; outcome: ResolvedInteraction["outcome"] }
  }) =>
    new Promise<{ answers: string[][] | null; by: ResolvedInteraction["by"]; outcome: ResolvedInteraction["outcome"] }>(
      (settle) => {
        const waiter: Waiter = {
          runId: input.runId,
          interaction: input.interaction,
          settle,
          accept: input.accept,
          timer: null,
        }
        waiters.set(input.interaction.interactionId, waiter)
        if (input.graceMs !== null) {
          waiter.timer = setTimeout(
            () => finish(input.interaction.interactionId, { ...input.onGrace(), by: "automation" }),
            input.graceMs,
          )
        }
        const onAbort = () =>
          finish(input.interaction.interactionId, { ...input.onGrace(), by: "automation", outcome: "cancelled" })
        if (input.signal.aborted) onAbort()
        else input.signal.addEventListener("abort", onAbort, { once: true })
        if (!publish(input.runId, input.interaction))
          finish(input.interaction.interactionId, { ...input.onGrace(), by: "automation" })
      },
    )

  const base = (input: { runId: string; unitId: string | null; sessionID: string }) => ({
    interactionId: crypto.randomUUID(),
    runId: input.runId,
    unitId: input.unitId,
    sessionID: input.sessionID,
    phase: null,
    raisedAt: Date.now(),
  })

  return {
    async ask(input) {
      const questions = toInteractionQuestions(input.form)
      const fallback = coerceAnswers(questions, input.options.fallback)
      if (!fallback) {
        throw new Error(
          "ctx.ask: `fallback` must have one entry per question, each drawn from that question's offered labels",
        )
      }
      if (input.signal.aborted || !options.attached()) return fallback
      const declared = input.options.graceMs ?? input.defaultGraceMs
      const graceMs =
        declared === null || declared === undefined || !Number.isFinite(declared) ? null : Math.max(0, declared)
      const interaction: PendingInteraction = {
        ...base({ runId: input.runId, unitId: null, sessionID: input.sessionID }),
        kind: "question",
        origin: "script",
        questions,
        graceEndsAt: graceMs === null ? null : Date.now() + graceMs,
      }
      const result = await wait({
        runId: input.runId,
        interaction,
        graceMs,
        signal: input.signal,
        accept: (answers) => coerceAnswers(questions, answers),
        onGrace: () => ({ answers: fallback, outcome: "answered" }),
      })
      return result.answers ?? fallback
    },

    async askAgent(input) {
      if (input.signal.aborted || !options.attached()) return null
      const interaction: PendingInteraction = {
        ...base(input),
        kind: "question",
        origin: "agent",
        questions: input.questions.map((question) => ({ ...question, custom: true })),
        graceEndsAt: null,
      }
      const result = await wait({
        runId: input.runId,
        interaction,
        graceMs: null,
        signal: input.signal,
        accept: (answers) => coerceAnswers(interaction.questions, answers),
        onGrace: () => ({ answers: null, outcome: "cancelled" }),
      })
      return result.answers ? { answers: result.answers, by: result.by } : null
    },

    permission(input) {
      if (permissions.has(input.detail.requestID)) return
      const interaction: PendingInteraction = {
        ...base(input),
        kind: "permission",
        origin: "permission",
        questions: [
          {
            header: `Permission: ${input.detail.action}`,
            prompt: `A Unit wants to ${input.detail.action}: ${input.detail.resources.join(", ") || "(no resource)"}`,
            options: PERMISSION_OPTIONS.map((option) => ({ ...option })),
            multiple: false,
            custom: false,
          },
        ],
        permission: { ...input.detail, resources: [...input.detail.resources], save: [...input.detail.save] },
        graceEndsAt: null,
      }
      permissions.set(input.detail.requestID, {
        runId: input.runId,
        unitId: input.unitId,
        interactionId: interaction.interactionId,
        sessionID: input.sessionID,
      })
      // Not awaited: the waiter exists only so `reply` has somewhere to land. The native request is the source
      // of truth and settles itself through the host.
      void wait({
        runId: input.runId,
        interaction,
        graceMs: null,
        signal: new AbortController().signal,
        accept: (answers) => coerceAnswers(interaction.questions, answers),
        onGrace: () => ({ answers: null, outcome: "cancelled" }),
      })
    },

    permissionResolved(requestID, decision) {
      const entry = permissions.get(requestID)
      if (!entry) return
      permissions.delete(requestID)
      const label =
        decision === "once"
          ? "Allow once"
          : decision === "always"
            ? "Always allow"
            : decision === "reject"
              ? "Reject"
              : undefined
      finish(entry.interactionId, {
        answers: label ? [[label]] : null,
        by: "human",
        outcome: decision === "reject" ? "rejected" : label ? "answered" : undefined,
      })
    },

    form(input) {
      if (forms.has(input.formID)) return
      const interaction: PendingInteraction = {
        ...base(input),
        kind: "question",
        origin: "agent",
        questions: input.questions,
        form: { formID: input.formID },
        graceEndsAt: null,
      }
      forms.set(input.formID, { runId: input.runId, unitId: input.unitId, interactionId: interaction.interactionId })
      void wait({
        runId: input.runId,
        interaction,
        graceMs: null,
        signal: new AbortController().signal,
        accept: () => null,
        onGrace: () => ({ answers: null, outcome: "cancelled" }),
      })
    },

    formResolved(formID, answers) {
      const entry = forms.get(formID)
      if (!entry) return
      forms.delete(formID)
      finish(entry.interactionId, { answers, by: "human", outcome: answers ? "answered" : "cancelled" })
    },

    async approval(input) {
      if (input.signal.aborted || !options.attached()) return null
      const interaction: PendingInteraction = {
        ...base({ runId: input.runId, unitId: null, sessionID: input.sessionID }),
        kind: "approval",
        origin: "engine",
        questions: [
          {
            header: "Run inline Workflow?",
            prompt:
              `A model wants to run an inline Workflow (${input.detail.bytes} bytes, sha256 ${input.detail.sha256.slice(0, 12)}). ` +
              "Inline Workflows run with your permissions inside the OpenCode service.",
            options: APPROVAL_OPTIONS.map((option) => ({ ...option })),
            multiple: false,
            custom: false,
          },
        ],
        approval: { ...input.detail },
        graceEndsAt: null,
      }
      const result = await wait({
        runId: input.runId,
        interaction,
        graceMs: null,
        signal: input.signal,
        accept: (answers) => coerceAnswers(interaction.questions, answers),
        onGrace: () => ({ answers: null, outcome: "cancelled" }),
      })
      const choice = result.answers?.[0]?.[0]
      if (choice === "Run once") return "once"
      if (choice === "Always for this project") return "project"
      if (choice === "Reject") return "reject"
      return null
    },

    async reply(runId, interactionId, answers) {
      const waiter = waiters.get(interactionId)
      if (!waiter || waiter.runId !== runId || waiter.sending) return false
      if (waiter.interaction.form) return false // native forms are answered through OpenCode's form API (the TUI)
      const accepted = waiter.accept(answers)
      if (!accepted) return false
      if (waiter.interaction.kind === "permission" && waiter.interaction.permission) {
        const label = accepted[0]?.[0]
        const decision: PermissionDecision =
          label === "Allow once" ? "once" : label === "Always allow" ? "always" : "reject"
        return sendPermission(interactionId, waiter, decision, accepted)
      }
      return finish(interactionId, { answers: accepted, by: "human", outcome: "answered" })
    },

    async cancel(runId, interactionId) {
      const waiter = waiters.get(interactionId)
      if (!waiter || waiter.runId !== runId || waiter.sending) return false
      if (waiter.interaction.form) return false
      if (waiter.interaction.kind === "permission" && waiter.interaction.permission) {
        return sendPermission(interactionId, waiter, "reject", [["Reject"]], "Rejected from the workflow surface.")
      }
      // A script ask handed back settles on the author's own fallback (its `ask` maps `null` to it); a Unit's
      // question is dismissed and the model is told to proceed; an approval is refused.
      return finish(interactionId, { answers: null, by: "human", outcome: "cancelled" })
    },

    releaseRun(runId) {
      // The Run is over: refuse what its Units were still asking for, so no native request outlives it.
      release((entry) => entry.runId === runId, "The workflow Run ended.")
    },

    releaseUnit(runId, unitId) {
      release((entry) => entry.runId === runId && entry.unitId === unitId, "The workflow Unit ended.")
    },

    pending() {
      return waiters.size
    },
  }
}

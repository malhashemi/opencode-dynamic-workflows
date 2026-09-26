/**
 * TUI setup: connect to the workflow service over plugin RPC, keep the location's Runs current, say "a person
 * is here" (attach heartbeat), and register every surface — the `/workflows` page, the session panel, the
 * composer strip, the sidebar block, commands and keybinds, toasts and attention.
 */
import type { Context } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"
import { Show } from "solid-js"

import { formatClock } from "../progress"
import type { PendingInteraction, Run, Unit } from "../protocol"
import { isTerminal } from "../runs"
import { WorkflowRpc } from "../service/rpc"
import { formAnswer, findForm } from "./answer"
import { bindApi, errorText } from "./api"
import { cleanupPending, cleanupRun, cleanupTargets } from "./cleanup"
import { shortId, workflowName } from "./format"
import { anyLive, emptyState, libraryEntries, sessionEntries, waitingRuns, type Effect, type SyncState } from "./state"
import { WorkflowSync } from "./sync"
import { LibraryPage, PANEL, RunPanel, SidebarRuns, Strip, type Actions, type Wf } from "./views"

export const ROUTE = "workflows"
const HEARTBEAT_MS = 20_000
const ATTACH_TTL_MS = 45_000

export function setupWorkflowsTui(context: Context): () => void {
  const location = context.location ?? context.data.location.default()
  const { api, events } = bindApi(context.client.rpc(WorkflowRpc as never), location)
  const surface = `tui:${crypto.randomUUID().slice(0, 8)}`

  const [state, setState] = createSignal<SyncState>(emptyState())
  const [error, setError] = createSignal<string | null>(null)
  const [now, setNow] = createSignal(Date.now())
  const [panelTarget, setPanelTarget] = createSignal<{ runId?: string; answer?: boolean } | undefined>(undefined)
  const [panelFocus, setPanelFocus] = createSignal(false)
  let returnTo: ReturnType<Context["ui"]["router"]["current"]> | null = null

  const toast = (
    message: string,
    variant: "info" | "success" | "warning" | "error" = "info",
    extra: { title?: string; sessionID?: string; duration?: number } = {},
  ) => context.ui.toast.show({ message, variant, ...extra })

  const runOf = (runId: string): Run | null => sync.current.runs[runId]?.run ?? null

  const onNotice = (effect: Extract<Effect, { kind: "waiting" | "ended" }>) => {
    const run = runOf(effect.runId)
    if (!run) return
    const name = workflowName(run)
    if (effect.kind === "waiting") {
      const interaction = effect.interaction
      const question = interaction.questions[0]
      const what =
        interaction.kind === "approval"
          ? interaction.approval?.action === "save"
            ? "wants approval to be saved"
            : "wants approval to run"
          : interaction.kind === "permission"
            ? `needs a permission: ${interaction.permission?.action ?? ""}`
            : `asks: ${question?.prompt ?? question?.header ?? ""}`
      toast(`${name} ${what} — /workflows answer`, "warning", {
        title: "Workflow waiting",
        sessionID: run.parentSessionID,
        duration: 10_000,
      })
      void context.attention
        .notify({
          title: `Workflow ${name}`,
          message: `${name} ${what}`,
          sound: { name: interaction.kind === "question" ? "question" : "permission" },
          notification: { when: "blurred" },
        })
        .catch(() => {})
      return
    }
    const ok = run.status === "succeeded"
    toast(
      `${name} ${run.status}${run.resultPreview ? ` — ${run.resultPreview}` : ""}`,
      ok ? "success" : run.status === "failed" ? "error" : "info",
      { title: "Workflow finished", sessionID: run.parentSessionID },
    )
    void context.attention
      .notify({
        title: `Workflow ${name}`,
        message: `${name} ${run.status}`,
        sound: { name: ok ? "done" : "error", when: "blurred" },
        notification: { when: "blurred" },
      })
      .catch(() => {})
  }

  const sync = new WorkflowSync({ api, events, onState: setState, onNotice, onError: setError })

  const sessionInView = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const heartbeat = async () => {
    const sessionID = sessionInView()
    try {
      await api.attach({ surface, ...(sessionID ? { sessionID } : {}), ttlMs: ATTACH_TTL_MS })
    } catch (err) {
      setError(`attach: ${errorText(err)}`)
    }
    await sync.poll()
  }

  void heartbeat()
  void sync.start().then(() => {
    const waiting = waitingRuns(sync.current)
    if (waiting.length > 0)
      toast(
        `${waiting.length} workflow${waiting.length === 1 ? " is" : "s are"} waiting for an answer — /workflows answer`,
        "warning",
        { title: "Workflows" },
      )
  })
  const beat = setInterval(() => void heartbeat(), HEARTBEAT_MS)
  const tick = setInterval(() => {
    if (anyLive(state())) setNow(Date.now())
  }, 1_000)

  // --- actions -------------------------------------------------------------------------------------------------

  const attempt = async <T,>(label: string, work: () => Promise<T>): Promise<T | null> => {
    try {
      return await work()
    } catch (err) {
      toast(`${label}: ${errorText(err)}`, "error")
      return null
    }
  }

  const ask = async (title: string, message: string, confirmLabel: string) =>
    (await context.ui.dialog.confirm({ title, message, label: { confirm: confirmLabel, cancel: "Cancel" } })) === true

  const removeSession = async (sessionID: string) => {
    await context.client.session.remove({ sessionID })
  }

  const openRoute = (target: { runId?: string; unitId?: string; answer?: boolean } = {}) => {
    const route = context.ui.router.current()
    if (route.type !== "plugin") returnTo = route
    context.ui.router.navigate({ type: "plugin", name: ROUTE, data: { ...target, at: Date.now() } })
  }

  const leaveRoute = () => {
    const target = returnTo
    returnTo = null
    if (target && target.type !== "plugin") context.ui.router.navigate(target)
    else context.ui.router.navigate({ type: "home" })
  }

  /** The Run a session panel should show: waiting first, then live, then the latest. */
  const bestRunFor = (sessionID: string): string | undefined => {
    const entries = sessionEntries(state(), sessionID)
    return (entries.find((entry) => entry.live && entry.waiting) ?? entries.find((entry) => entry.live) ?? entries[0])
      ?.runId
  }

  const openPanel = (runId?: string, sessionID?: string, answer = false) => {
    const inView = sessionID ?? sessionInView()
    const runFor = runId ?? (inView ? bestRunFor(inView) : undefined)
    const run = runFor ? sync.current.runs[runFor]?.entry : undefined
    // A panel belongs to a session: show a Run in its own session's panel, or on the page outside one.
    if (run && run.parentSessionID !== sessionInView()) {
      if (context.ui.tabs.enabled() && context.data.session.get(run.parentSessionID)) {
        context.ui.tabs.focus(run.parentSessionID)
      } else {
        openRoute({ runId: run.runId, answer })
        return
      }
    }
    setPanelTarget(runFor ? { runId: runFor, answer } : undefined)
    setPanelFocus(true)
    if (!context.ui.panel.open(PANEL)) openRoute(runFor ? { runId: runFor, answer } : {})
  }

  const answerFirst = () => {
    const waiting = waitingRuns(state())
    const first = waiting.find((run) => run.parentSessionID === sessionInView()) ?? waiting[0]
    if (!first) {
      toast("No workflow is waiting for an answer.", "info")
      return
    }
    openPanel(first.runId, first.parentSessionID, true)
  }

  const replyForm = async (
    run: Run,
    interaction: PendingInteraction,
    answers: string[][] | null,
  ): Promise<string | null> => {
    const formID = interaction.form!.formID
    const unit = run.units.find((candidate) => candidate.unitId === interaction.unitId)
    const at = { directory: unit?.location ?? run.location }
    await context.data.session.form.sync(interaction.sessionID, at)
    const form = findForm(context.data.session.form.list(interaction.sessionID, at), formID)
    if (!form) return "the form is no longer pending"
    if (answers === null) {
      await context.data.session.form.cancel({ sessionID: interaction.sessionID, formID }, at)
      return null
    }
    const mapped = formAnswer(form.fields, answers)
    if ("error" in mapped) return mapped.error
    await context.data.session.form.reply({ sessionID: interaction.sessionID, formID, answer: mapped.answer }, at)
    return null
  }

  const actions: Actions = {
    async stopRun(run) {
      if (
        !(await ask(
          "Stop Run?",
          `Stop ${workflowName(run)} (${shortId(run.runId)})? Running Units are interrupted.`,
          "Stop",
        ))
      )
        return
      if (await attempt("Stop", () => api.stopRun({ runId: run.runId }))) toast(`Stopping ${workflowName(run)}.`)
    },
    async resumeRun(run) {
      const out = await attempt("Resume", () => api.resumeRun({ runId: run.runId }))
      if (out)
        toast(
          `Resumed ${workflowName(run)} as ${shortId(out.runId)}: finished Units replay, the rest run live.`,
          "success",
        )
      return out?.runId ?? null
    },
    async saveRun(run) {
      const name = await context.ui.dialog.prompt({
        title: "Save as a durable Workflow",
        description: "Writes the Run's script to .opencode/workflows/<name>.ts",
        placeholder: run.workflow.name,
        value: run.workflow.provenance === "inline" ? run.workflow.name : `${run.workflow.name}-copy`,
      })
      if (!name) return
      const saved = await attempt("Save", () => api.saveRun({ runId: run.runId, name }))
      if (saved) toast(`Saved as "${saved.key}" (${saved.path}).`, "success")
    },
    async cleanupRun(run) {
      if (!isTerminal(run.status)) {
        toast("Stop the Run before deleting its Unit sessions.", "warning")
        return
      }
      const targets = cleanupTargets(run)
      if (targets.length === 0) {
        toast("This Run has no Unit sessions to delete.")
        return
      }
      if (
        !(await ask(
          "Delete Unit sessions?",
          `Delete the ${targets.length} Unit session${targets.length === 1 ? "" : "s"} of ${workflowName(run)}? Their transcripts leave OpenCode; the Run's record stays.`,
          "Delete",
        ))
      )
        return
      const outcome = await attempt("Clean up", () => cleanupRun(run, { api, remove: removeSession }))
      if (!outcome) return
      toast(
        `Deleted ${outcome.deleted} Unit session${outcome.deleted === 1 ? "" : "s"}${outcome.failures.length ? `; ${outcome.failures.length} failed (${outcome.failures[0]!.error})` : ""}.`,
        outcome.failures.length ? "warning" : "success",
      )
      await sync.hydrate(run.runId)
    },
    async cleanupPending() {
      const finished = libraryEntries(state()).filter((entry) => isTerminal(entry.status))
      if (finished.length === 0) {
        toast("No finished Runs.")
        return
      }
      if (
        !(await ask(
          "Clean up finished Runs?",
          "Delete the Unit sessions of finished Runs marked for cleanup (retention: pending). Runs not marked are left alone.",
          "Clean up",
        ))
      )
        return
      const outcomes = await attempt("Clean up", () => cleanupPending(finished, { api, remove: removeSession }))
      if (!outcomes) return
      const deleted = outcomes.reduce((sum, outcome) => sum + outcome.deleted, 0)
      const failed = outcomes.reduce((sum, outcome) => sum + outcome.failures.length, 0)
      toast(
        outcomes.length === 0
          ? "No finished Run is marked for cleanup."
          : `Cleaned up ${outcomes.length} Run${outcomes.length === 1 ? "" : "s"}: ${deleted} session${deleted === 1 ? "" : "s"} deleted${failed ? `, ${failed} failed` : ""}.`,
        failed ? "warning" : "success",
      )
      await sync.resync("cleanup")
    },
    async stopUnit(run, unit: Unit) {
      if (await attempt("Stop Unit", () => api.stopUnit({ runId: run.runId, unitId: unit.unitId })))
        toast("Unit stopped.")
    },
    async restartUnit(run, unit: Unit) {
      if (await attempt("Restart Unit", () => api.restartUnit({ runId: run.runId, unitId: unit.unitId })))
        toast("Unit restarting in its own session.")
    },
    openTranscript(sessionID) {
      if (context.ui.tabs.enabled() && context.ui.tabs.focus(sessionID)) return
      context.ui.router.navigate({ type: "session", sessionID })
    },
    async reply(run, interaction, answers) {
      try {
        if (interaction.form) return await replyForm(run, interaction, answers)
        await api.replyInteraction({ runId: run.runId, interactionId: interaction.interactionId, answers })
        return null
      } catch (err) {
        return errorText(err)
      }
    },
    async dismiss(run, interaction) {
      try {
        if (interaction.form) return await replyForm(run, interaction, null)
        await api.cancelInteraction({ runId: run.runId, interactionId: interaction.interactionId })
        return null
      } catch (err) {
        return errorText(err)
      }
    },
    async pair() {
      const out = await attempt("Pair", () => api.pair())
      if (!out) return
      await context.ui.dialog.alert({
        title: "Pair a browser",
        message: `Open ${out.url} on the other device and enter the code:\n\n    ${out.code}\n\nOne use; expires at ${formatClock(out.expiresAt)}.`,
      })
    },
    async refresh() {
      await sync.resync("refresh")
    },
    openPanel: (runId, sessionID) => openPanel(runId, sessionID),
    openRoute: (target) => openRoute(target),
  }

  const wf: Wf = {
    context,
    state,
    now,
    error,
    open: (runId) => sync.open(runId),
    loadUnit: async (runId, unitId) => (await attempt("Load Unit", () => api.getUnit({ runId, unitId })))?.unit ?? null,
    actions,
  }

  // --- the `/workflows` command ----------------------------------------------------------------------------------

  const runCommand = async (input?: string) => {
    const [sub = "", ...rest] = (input ?? "").trim().split(/\s+/)
    switch (sub.toLowerCase()) {
      case "":
      case "library":
        openRoute()
        return
      case "panel":
        openPanel()
        return
      case "answer":
        answerFirst()
        return
      case "cleanup":
        await actions.cleanupPending()
        return
      case "pair":
        await actions.pair()
        return
      case "refresh":
        await actions.refresh()
        return
      default: {
        const needle = [sub, ...rest].join(" ").toLowerCase()
        const match = libraryEntries(state()).find(
          (entry) =>
            entry.runId.startsWith(needle) ||
            entry.runId.replace(/-/g, "").startsWith(needle) ||
            workflowName(entry).toLowerCase() === needle,
        )
        if (match) openRoute({ runId: match.runId })
        else
          toast(
            `/workflows [panel | answer | cleanup | pair | refresh | <run id or workflow>] — no Run matches "${needle}".`,
            "warning",
          )
      }
    }
  }

  function Commands() {
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "workflows.library",
          title: "Workflows: open the run library",
          description: "/workflows [panel | answer | cleanup | pair | refresh | <run>]",
          group: "Workflows",
          bind: "<leader>f",
          palette: true,
          slash: { name: "workflows", arguments: true },
          run: (input) => void runCommand(input),
        },
        {
          id: "workflows.panel",
          title: "Workflows: open the run panel",
          group: "Workflows",
          palette: true,
          run: () => openPanel(),
        },
        {
          id: "workflows.answer",
          title: "Workflows: answer a waiting question",
          group: "Workflows",
          palette: true,
          suggested: () => waitingRuns(state()).length > 0,
          run: answerFirst,
        },
        {
          id: "workflows.cleanup",
          title: "Workflows: delete Unit sessions of finished runs",
          group: "Workflows",
          palette: true,
          run: () => void actions.cleanupPending(),
        },
        {
          id: "workflows.pair",
          title: "Workflows: pair a browser (web app)",
          group: "Workflows",
          palette: true,
          run: () => void actions.pair(),
        },
      ],
    }))
    return null
  }

  const disposers = [
    context.ui.router.register({
      name: ROUTE,
      render: (input) => (
        <LibraryPage
          wf={wf}
          data={() => input.data as { runId?: string; unitId?: string; answer?: boolean } | undefined}
          onExit={leaveRoute}
        />
      ),
    }),
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => <Strip wf={wf} sessionID={input.sessionID} />,
    }),
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <SidebarRuns wf={wf} sessionID={input.sessionID} />,
    }),
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <RunPanel
            wf={wf}
            panel={panel}
            target={() =>
              panelTarget() ??
              (() => {
                const runId = bestRunFor(panel.sessionID)
                return runId ? { runId } : undefined
              })()
            }
            focusOnOpen={() => {
              const focus = panelFocus()
              setPanelFocus(false)
              return focus
            }}
          />
        </Show>
      ),
    }),
    context.ui.slot({ append: "app", render: () => <Commands /> }),
  ]

  return () => {
    clearInterval(beat)
    clearInterval(tick)
    sync.stop()
    // Detach at once rather than leaving the service to believe someone is watching for another 45 s.
    void api.detach({ surface }).catch(() => {})
    for (const dispose of disposers) dispose()
  }
}

/**
 * The run browser's keyboard vocabulary — declared once, in full, including the keys that do not work yet.
 *
 * `restart` is in the table with `enabled: false`. That is a deliberate cost: a footer row that answers "not
 * yet" instead of doing something. The alternative is worse — a user who learns the browser in one release and
 * finds a NEW key in the next has to relearn it, and cannot tell whether `r` was always there and they missed
 * it. A visible-but-inert key teaches the shape of the tool; when it is wired, nothing about the vocabulary
 * moves. `s` (save) made exactly that transition in Phase 3, in place.
 */
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { RouteAction } from "./route-model"

/** The plugin route's name, and the keymap mode pushed while it owns the screen. */
export const WORKFLOW_ROUTE = "workflow-runs"

export interface WorkflowBinding {
  /**
   * The keymap spec, comma-separated alternatives first-listed-is-canonical (`"up,k"`), matching the host's
   * own binding syntax. {@link footerHint} displays the first alternative.
   */
  key: string
  action: RouteAction | "close"
  label: string
  enabled: boolean
}

export const WORKFLOW_BINDINGS: readonly WorkflowBinding[] = [
  { key: "up,k", action: "up", label: "select", enabled: true },
  { key: "down,j", action: "down", label: "select", enabled: true },
  { key: "return,right,l", action: "drill", label: "open", enabled: true },
  { key: "escape,left,h", action: "back", label: "back", enabled: true },
  { key: "f", action: "filter", label: "filter", enabled: true },
  { key: "x", action: "stop", label: "stop", enabled: true },
  { key: "r", action: "restart", label: "restart", enabled: false }, // Phase 6
  { key: "s", action: "save", label: "save", enabled: true },
  { key: "q", action: "close", label: "close", enabled: true },
]

/**
 * The same bindings, relabelled for the answer pane.
 *
 * Same keys, same order, same footer positions — only the words change. Deriving them rather than writing a
 * second table is what guarantees the two can never drift into different vocabularies.
 *
 * **`esc` no longer gives a question away.** It used to: `back` was relabelled `leave for automation`, and
 * `back` is bound to `escape,left,h`. So the three keys everyone reaches for to step out of a screen quietly
 * handed a pending decision to a machine — which a user duly did, by pressing `esc`. Leaving a question to
 * automation is a real decision and now costs a real key: `x`, the same one that stops a run, relabelled here
 * because on this level the destructive thing is not the run but the question. `esc` pops the level and leaves
 * the question exactly where it was, like every other level in the browser.
 */
export const QUESTION_BINDINGS: readonly WorkflowBinding[] = WORKFLOW_BINDINGS.map((binding) => {
  if (binding.action === "drill") return { ...binding, label: "answer" }
  if (binding.action === "stop") return { ...binding, label: "leave for automation" }
  return binding
})

/** The palette/slash name that opens the browser from anywhere. */
export const OPEN_COMMAND = "workflow.runs.open"

/** The palette/slash name that jumps straight to the question that has been waiting longest. */
export const ANSWER_COMMAND = "workflow.question.answer"

/**
 * Navigate to the run browser, remembering where the user came from.
 *
 * The return route is captured HERE, at the moment of the navigation, because that is the only point at which
 * the host's current route is still the one being left — a plugin route gets no history to walk back through.
 */
export function openWorkflowRoute(api: TuiPluginApi, runId?: string | null, requestID?: string | null): void {
  const from = api.route.current
  const params: Record<string, unknown> = {}
  if (runId) params.runId = runId
  // With both, the route opens ON the answer pane rather than near it: a badge that costs three more keystrokes
  // to act on is a notification, not a deep link.
  if (runId && requestID) params.requestID = requestID
  const sessionID =
    from.name === "session" ? (from.params as { sessionID?: unknown } | undefined)?.sessionID : undefined
  if (typeof sessionID === "string") params.returnTo = sessionID
  api.route.navigate(WORKFLOW_ROUTE, params)
}

/**
 * The one always-available way in: a palette entry and a `/workflow-runs` slash command.
 *
 * Necessary, not decorative. The sidebar strip renders nothing when no run has started this session, so
 * without this the browser would be unreachable in exactly the state where a user most wants to look for a run
 * they remember starting. Deliberately carries NO default keybinding — an unprompted global key from a plugin
 * is a key taken away from the user.
 */
export function registerOpenCommand(
  api: TuiPluginApi,
  /** The oldest question still waiting, so the answer command has somewhere to go. */
  oldestPending?: () => { runId: string; requestID: string } | null,
): () => void {
  return api.keymap.registerLayer({
    commands: [
      {
        name: OPEN_COMMAND,
        title: "Workflows: browse runs",
        category: "Workflows",
        namespace: "palette",
        slashName: "workflow-runs",
        run() {
          openWorkflowRoute(api)
        },
      },
      {
        name: ANSWER_COMMAND,
        title: "Workflows: answer waiting question",
        category: "Workflows",
        namespace: "palette",
        slashName: "workflow-answer",
        run() {
          // The reachable half of the "one keypress from the toast" design. The host's toast carries no action
          // of its own, and a plugin claiming a global key is a key taken away from the user — so the deep link
          // is a named command the toast points at, reachable from the palette in two keystrokes.
          const pending = oldestPending?.()
          if (pending) openWorkflowRoute(api, pending.runId, pending.requestID)
          else openWorkflowRoute(api)
        },
      },
    ],
    bindings: [],
  })
}

/** Keys whose spec name is not what a person calls them. */
const KEY_DISPLAY: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  return: "⏎",
  enter: "⏎",
  escape: "esc",
  backspace: "⌫",
}

function displayKey(binding: WorkflowBinding): string {
  const first = binding.key.split(",")[0] ?? binding.key
  return KEY_DISPLAY[first] ?? first
}

export function commandName(action: WorkflowBinding["action"]): string {
  return `workflow.runs.${action}`
}

/**
 * The footer line: `↑↓ select · ⏎ open · esc back · f filter · x stop · (r restart) · (s save) · q close`.
 *
 * Consecutive bindings that share a label collapse into one hint, which is what turns two separate `up`/`down`
 * commands into the single `↑↓ select` a user actually reads. A disabled binding is parenthesised rather than
 * omitted — see this module's header for why it is there at all.
 */
export interface FooterGroup {
  /** Display form of the key(s), already collapsed — `↑↓`, `⏎`, `esc`. */
  keys: string
  label: string
  enabled: boolean
}

/**
 * The footer's hints as structured groups, so a renderer can colour the key differently from its label.
 *
 * {@link footerHint} is the flat-string rendering of exactly this, kept for the tests and for any surface that
 * only has one colour to spend.
 */
export function footerGroups(bindings: readonly WorkflowBinding[] = WORKFLOW_BINDINGS): FooterGroup[] {
  const groups: { keys: string[]; label: string; enabled: boolean }[] = []
  for (const binding of bindings) {
    const last = groups[groups.length - 1]
    if (last && last.label === binding.label && last.enabled === binding.enabled) {
      last.keys.push(displayKey(binding))
      continue
    }
    groups.push({ keys: [displayKey(binding)], label: binding.label, enabled: binding.enabled })
  }
  return groups.map((group) => ({ keys: group.keys.join(""), label: group.label, enabled: group.enabled }))
}

export function footerHint(bindings: readonly WorkflowBinding[] = WORKFLOW_BINDINGS): string {
  return footerGroups(bindings)
    .map((group) => {
      const hint = `${group.keys} ${group.label}`
      return group.enabled ? hint : `(${hint})`
    })
    .join(" · ")
}

/**
 * Register the enabled bindings as one mode-scoped keymap layer.
 *
 * Scoping is by MODE, not by route name: the host's `mode` layer field requires the mode stack's top to match,
 * and the route pushes {@link WORKFLOW_ROUTE} while it is mounted. That is what keeps `x` from stopping a run
 * while the user is typing a prompt in a session — and, symmetrically, what guarantees the session prompt gets
 * its keys back the instant the route unmounts.
 *
 * Deviation from the outline's sketch: `dispatch` takes `RouteAction | "close"` rather than `RouteAction`,
 * because `close` is a real binding (`q`) and leaving the route is not a navigation the reducer can express.
 */
export function registerKeymap(
  api: TuiPluginApi,
  dispatch: (action: WorkflowBinding["action"]) => void,
): () => void {
  const active = WORKFLOW_BINDINGS.filter((binding) => binding.enabled)
  return api.keymap.registerLayer({
    mode: WORKFLOW_ROUTE,
    commands: active.map((binding) => ({
      name: commandName(binding.action),
      title: `Workflows: ${binding.label}`,
      category: "Workflows",
      run() {
        dispatch(binding.action)
      },
    })),
    bindings: active.map((binding) => ({
      key: binding.key,
      cmd: commandName(binding.action),
      desc: binding.label,
      group: "Workflows",
    })),
  })
}

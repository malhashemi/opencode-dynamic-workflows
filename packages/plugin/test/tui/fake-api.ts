import { createSignal } from "solid-js"
import type {
  TuiAttentionNotifyInput,
  TuiAttentionNotifyResult,
  TuiPluginApi,
  TuiRouteDefinition,
  TuiSlotPlugin,
  TuiTheme,
} from "@opencode-ai/plugin/tui"

/** A structural `TuiTheme` with distinguishable tokens, so a color assertion can name what it expects. */
/**
 * A theme double covering EVERY token the views read, each with a distinct value.
 *
 * Completeness is the point, not tidiness. An absent token arrives at OpenTUI as `undefined`, which renders as
 * the terminal's default colour — i.e. always visible. A view that reaches for a token this object forgot
 * therefore looks perfect in every mounted test and can still be invisible on a real theme. That is not
 * hypothetical: the run browser's selected row used `selectedListItemText` over `backgroundElement`, passed
 * here, and rendered every selected cell blank on a real host.
 */
export function fakeTheme(overrides: Partial<Record<string, string>> = {}): TuiTheme {
  const current = {
    primary: "#5588ff",
    secondary: "#8855ff",
    accent: "#00ccff",
    error: "#ff0000",
    warning: "#ffaa00",
    success: "#00ff00",
    info: "#00aaff",
    text: "#ffffff",
    textMuted: "#888888",
    selectedListItemText: "#001122",
    background: "#000000",
    backgroundPanel: "#111111",
    backgroundElement: "#222222",
    backgroundMenu: "#181818",
    border: "#444444",
    borderActive: "#666666",
    borderSubtle: "#333333",
    ...overrides,
  }
  return { current } as unknown as TuiTheme
}

/** The shape of a keymap layer as this plugin registers it — enough to invoke a command by name. */
export interface FakeKeymapLayer {
  mode?: string
  commands?: Array<{ name: string; title?: string; run: (ctx: never) => unknown }>
  bindings?: Array<{ key: string; cmd?: string; desc?: string }>
}

export interface FakeNavigation {
  name: string
  params?: Record<string, unknown>
}

export interface FakeToast {
  variant?: string
  title?: string
  message: string
  duration?: number
}

export interface FakeTuiApi {
  api: TuiPluginApi
  slots: TuiSlotPlugin[]
  toasts: FakeToast[]
  routes: TuiRouteDefinition[][]
  keymapLayers: FakeKeymapLayer[]
  attention: TuiAttentionNotifyInput[]
  navigations: FakeNavigation[]
  /** Modes currently pushed, newest last — the same stack discipline the host keeps. */
  modes: string[]
  /**
   * Invoke a registered keymap command by name — the test's stand-in for a keystroke.
   *
   * Real key dispatch needs the host's `KeymapProvider` in the render tree, which a mounted view does not
   * have. Running the command the binding points at exercises everything downstream of the key lookup, which
   * is where this plugin's behavior actually lives.
   */
  runCommand(name: string): boolean
  /**
   * Move the host's current route, reactively.
   *
   * Load-bearing rather than convenience: the announcer reads `api.route.current` INSIDE its effect precisely so
   * that navigating re-runs it, which is what lets an announcement that reached nobody try again when the user
   * lands somewhere it can. A non-reactive double would make that untestable, which is how it got missed.
   */
  navigateTo(name: string, params?: Record<string, unknown>): void
  /** What the host says came of an `attention.notify` — the answer the announcer must not throw away. */
  setNotifyResult(result: TuiAttentionNotifyResult | (() => never)): void
  /** The user's own attention configuration, which the plugin respects rather than overrides. */
  setAttentionEnabled(enabled: boolean): void
  dispose(): Promise<void>
}

export function createFakeTuiApi(
  statePath = "/tmp/opencode-state",
  /** Token overrides, for pinning a view's legibility against a hostile palette. */
  themeOverrides: Partial<Record<string, string>> = {},
): FakeTuiApi {
  const slots: TuiSlotPlugin[] = []
  const routes: TuiRouteDefinition[][] = []
  const keymapLayers: FakeKeymapLayer[] = []
  const attention: TuiAttentionNotifyInput[] = []
  const toasts: FakeToast[] = []
  const navigations: FakeNavigation[] = []
  const modes: string[] = []
  const disposers: Array<() => void | Promise<void>> = []
  const controller = new AbortController()
  // A signal, not a plain variable: the host's route is a Solid store, so a component that reads it inside an
  // effect is subscribed to navigation. A double that is not reactive silently makes that behaviour untestable.
  const [current, setCurrent] = createSignal<{ name: string; params?: Record<string, unknown> }>({ name: "home" })
  let notifyResult: TuiAttentionNotifyResult | (() => never) = { ok: true, notification: true, sound: true }
  let attentionEnabled = true

  const api = {
    slots: {
      register(plugin: TuiSlotPlugin) {
        slots.push(plugin)
        return `slot-${slots.length}`
      },
    },
    route: {
      get current() {
        return current()
      },
      register(definitions: TuiRouteDefinition[]) {
        routes.push(definitions)
        return () => {}
      },
      navigate(name: string, params?: Record<string, unknown>) {
        navigations.push({ name, params })
        setCurrent({ name, params })
      },
    },
    keymap: {
      registerLayer(layer: FakeKeymapLayer) {
        keymapLayers.push(layer)
        return () => {
          const index = keymapLayers.indexOf(layer)
          if (index >= 0) keymapLayers.splice(index, 1)
        }
      },
    },
    mode: {
      current() {
        return modes[modes.length - 1] ?? "base"
      },
      push(mode: string) {
        modes.push(mode)
        return () => {
          const index = modes.lastIndexOf(mode)
          if (index >= 0) modes.splice(index, 1)
        }
      },
    },
    theme: fakeTheme(themeOverrides),
    ui: {
      toast(input: FakeToast) {
        toasts.push(input)
      },
    },
    attention: {
      async notify(input: TuiAttentionNotifyInput) {
        attention.push(input)
        // A thrower stands in for a missing sound pack or a platform with no notifications — the case that must
        // read as "nothing reached them" rather than crash the announcer.
        if (typeof notifyResult === "function") return notifyResult()
        return notifyResult
      },
    },
    get tuiConfig() {
      return { attention: { enabled: attentionEnabled, notifications: true, sound: true, volume: 1 } }
    },
    lifecycle: {
      signal: controller.signal,
      onDispose(dispose: () => void | Promise<void>) {
        disposers.push(dispose)
        return () => {}
      },
    },
    state: {
      path: { state: statePath, config: "", worktree: "", directory: "" },
    },
  } as unknown as TuiPluginApi

  return {
    api,
    slots,
    toasts,
    routes,
    keymapLayers,
    attention,
    navigations,
    modes,
    runCommand(name) {
      for (const layer of keymapLayers) {
        const command = layer.commands?.find((candidate) => candidate.name === name)
        if (command) {
          command.run(undefined as never)
          return true
        }
      }
      return false
    },
    navigateTo(name, params) {
      setCurrent({ name, params })
    },
    setNotifyResult(result) {
      notifyResult = result
    },
    setAttentionEnabled(enabled) {
      attentionEnabled = enabled
    },
    async dispose() {
      controller.abort()
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

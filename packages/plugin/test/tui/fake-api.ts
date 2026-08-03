import type {
  TuiAttentionNotifyInput,
  TuiPluginApi,
  TuiRouteDefinition,
  TuiSlotPlugin,
  TuiTheme,
} from "@opencode-ai/plugin/tui"

/** A structural `TuiTheme` with distinguishable tokens, so a color assertion can name what it expects. */
export function fakeTheme(overrides: Partial<Record<string, string>> = {}): TuiTheme {
  const current = {
    text: "#ffffff",
    textMuted: "#888888",
    accent: "#00ccff",
    success: "#00ff00",
    warning: "#ffaa00",
    error: "#ff0000",
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

export interface FakeTuiApi {
  api: TuiPluginApi
  slots: TuiSlotPlugin[]
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
  dispose(): Promise<void>
}

export function createFakeTuiApi(statePath = "/tmp/opencode-state"): FakeTuiApi {
  const slots: TuiSlotPlugin[] = []
  const routes: TuiRouteDefinition[][] = []
  const keymapLayers: FakeKeymapLayer[] = []
  const attention: TuiAttentionNotifyInput[] = []
  const navigations: FakeNavigation[] = []
  const modes: string[] = []
  const disposers: Array<() => void | Promise<void>> = []
  const controller = new AbortController()
  let current: { name: string; params?: Record<string, unknown> } = { name: "home" }

  const api = {
    slots: {
      register(plugin: TuiSlotPlugin) {
        slots.push(plugin)
        return `slot-${slots.length}`
      },
    },
    route: {
      get current() {
        return current
      },
      register(definitions: TuiRouteDefinition[]) {
        routes.push(definitions)
        return () => {}
      },
      navigate(name: string, params?: Record<string, unknown>) {
        navigations.push({ name, params })
        current = { name, params }
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
    theme: fakeTheme(),
    attention: {
      async notify(input: TuiAttentionNotifyInput) {
        attention.push(input)
        return { ok: true, notification: false, sound: false }
      },
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
    async dispose() {
      controller.abort()
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

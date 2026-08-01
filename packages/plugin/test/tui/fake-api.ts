import type {
  TuiAttentionNotifyInput,
  TuiPluginApi,
  TuiRouteDefinition,
  TuiSlotPlugin,
} from "@opencode-ai/plugin/tui"

export interface FakeTuiApi {
  api: TuiPluginApi
  slots: TuiSlotPlugin[]
  routes: TuiRouteDefinition[][]
  keymapLayers: unknown[]
  attention: TuiAttentionNotifyInput[]
  dispose(): Promise<void>
}

export function createFakeTuiApi(statePath = "/tmp/opencode-state"): FakeTuiApi {
  const slots: TuiSlotPlugin[] = []
  const routes: TuiRouteDefinition[][] = []
  const keymapLayers: unknown[] = []
  const attention: TuiAttentionNotifyInput[] = []
  const disposers: Array<() => void | Promise<void>> = []
  const controller = new AbortController()

  const api = {
    slots: {
      register(plugin: TuiSlotPlugin) {
        slots.push(plugin)
        return `slot-${slots.length}`
      },
    },
    route: {
      current: { name: "home" },
      register(definitions: TuiRouteDefinition[]) {
        routes.push(definitions)
        return () => {}
      },
      navigate() {},
    },
    keymap: {
      registerLayer(layer: unknown) {
        keymapLayers.push(layer)
        return () => {}
      },
    },
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
    async dispose() {
      controller.abort()
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

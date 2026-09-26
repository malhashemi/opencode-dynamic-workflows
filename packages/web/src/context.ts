import { createContext, useContext, type Accessor } from "solid-js"

import type { Api, GatewayInfo } from "./api"
import type { EventHub } from "./hub"

export interface AppContext {
  api: Api
  hub: EventHub
  info: Accessor<GatewayInfo>
  /** Ticks every second while something is running; drives elapsed figures. */
  now: Accessor<number>
  /** Announce through the polite live region (screen readers) and the toast strip. */
  announce(message: string, tone?: "info" | "attention" | "error"): void
  /** Open the pairing dialog; resolves true once paired. */
  requestPairing(reason?: string): Promise<boolean>
}

export const App = createContext<AppContext>()

export function useApp(): AppContext {
  const context = useContext(App)
  if (!context) throw new Error("useApp outside <App.Provider>")
  return context
}

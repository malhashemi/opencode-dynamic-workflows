/** Solid binding of the pure Run reducer: snapshot → subscribe → apply → resync. */
import type { Unit } from "@malhashemi/opencode-dynamic-workflows/protocol"
import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { AppContext } from "./context"
import { beginResync, emptyRunView, receiveEvent, receiveSnapshot, withFullUnit, type RunView } from "./state"

export interface RunData {
  view: Accessor<RunView>
  error: Accessor<unknown>
  refresh(): Promise<void>
  loadFullUnit(unitId: string): Promise<Unit | undefined>
}

export function createRunData(app: AppContext, runId: Accessor<string>): RunData {
  const [view, setView] = createSignal<RunView>(emptyRunView(runId()))
  const [error, setError] = createSignal<unknown>(null)
  let generation = 0

  const refresh = async () => {
    const id = runId()
    const mine = ++generation
    setView((current) => (current.runId === id ? beginResync(current) : emptyRunView(id)))
    try {
      const snapshot = await app.api.getRun(id)
      const activity = await app.api.getActivity(id).catch(() => [])
      if (mine !== generation) return
      setError(null)
      app.hub.ensure(snapshot.run.location)
      setView((current) => receiveSnapshot(current, snapshot, activity))
    } catch (caught) {
      if (mine !== generation) return
      setError(caught)
    }
  }

  const unlisten = app.hub.listen({
    event(event) {
      if (event.runId === view().runId) setView((current) => receiveEvent(current, event))
    },
    resync(location) {
      const run = view().run
      if (!run || run.location === location) void refresh()
    },
  })
  onCleanup(() => {
    generation += 1
    unlisten()
  })

  createEffect(on(runId, () => void refresh()))

  const loadFullUnit = async (unitId: string) => {
    try {
      const unit = await app.api.getUnit(runId(), unitId)
      setView((current) => withFullUnit(current, unit))
      return unit
    } catch (caught) {
      setError(caught)
      return undefined
    }
  }

  return { view, error, refresh, loadFullUnit }
}

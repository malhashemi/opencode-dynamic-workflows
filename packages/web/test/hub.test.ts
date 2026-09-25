import { describe, expect, test } from "bun:test"
import { EventHub } from "../src/hub"
import type { SseOptions } from "../src/sse"

function setup() {
  const connections: SseOptions[] = []
  const hub = new EventHub(
    { eventsUrl: (location) => `/v1/events?location=${encodeURIComponent(location)}`, authHeaders: () => ({}) },
    (options) => {
      connections.push(options)
      return { close() {}, lastEventId: "" }
    },
  )
  const events: number[] = []
  const resyncs: string[] = []
  hub.listen({ event: (event) => events.push(event.seq), resync: (location, reason) => resyncs.push(`${location}:${reason}`) })
  hub.ensure("/p")
  hub.ensure("/p")
  const send = (seq: number, type = "unit.updated", data: unknown = {}) =>
    connections[0]!.onMessage({ id: String(seq), event: type, data: JSON.stringify({ protocol: 1, seq, time: 0, location: "/p", runId: "r", type, revision: seq, data }) })
  return { hub, connections, events, resyncs, send }
}

describe("EventHub", () => {
  test("one stream per location", () => {
    const { connections } = setup()
    expect(connections).toHaveLength(1)
    expect(connections[0]!.url).toBe("/v1/events?location=%2Fp")
  })

  test("delivers contiguous events and asks for a resync on a gap", () => {
    const { events, resyncs, send } = setup()
    send(1)
    send(2)
    send(5)
    expect(events).toEqual([1, 2, 5])
    expect(resyncs).toEqual(["/p:missed events"])
  })

  test("a seq going backwards (service restart) triggers a resync", () => {
    const { resyncs, send } = setup()
    send(10)
    send(1)
    expect(resyncs).toEqual(["/p:the service restarted"])
  })

  test("resync.required is not delivered as an event, and resets the cursor", () => {
    const { events, resyncs, send } = setup()
    send(1)
    send(30, "resync.required", { reason: "events were missed" })
    send(31)
    expect(events).toEqual([1, 31])
    expect(resyncs).toEqual(["/p:events were missed"])
  })

  test("a reconnect after the first open asks for a resync", () => {
    const { connections, resyncs } = setup()
    connections[0]!.onStatus!("open")
    expect(resyncs).toEqual([])
    connections[0]!.onStatus!("retrying")
    connections[0]!.onStatus!("open")
    expect(resyncs).toEqual(["/p:reconnected"])
  })
})

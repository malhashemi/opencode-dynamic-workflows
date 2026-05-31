/**
 * Unit coverage for the event-recorder's pure core: `sessionIdOf`. This is the ONLY part of the
 * silent-hang harness that is pure (no live opencode, no SSE stream), so it carries the unit tests —
 * the rest of the recorder (subscribe/query/boot) is exercised by the operator-run live probes
 * (slices 1.2–1.4).
 *
 * `sessionIdOf` normalizes the session id off whichever event the SSE stream hands us. The opencode
 * v1.15.12 wire (CF2) scatters the session id across four different field forms depending on the event
 * type, plus an error event that may carry none. These fixtures are literal slices of those wire shapes
 * (verified against `@opencode-ai/sdk` `types.gen.d.ts`).
 */
import { describe, expect, it } from "bun:test"
import { sessionIdOf } from "./event-recorder"

describe("sessionIdOf", () => {
  it("reads `properties.sessionID` off a session.status event", () => {
    // EventSessionStatus — the id sits directly on properties.
    const event = {
      type: "session.status",
      properties: { sessionID: "ses_status_1", status: { type: "busy" } },
    }
    expect(sessionIdOf(event)).toBe("ses_status_1")
  })

  it("reads `properties.info.id` off a session.updated event", () => {
    // EventSessionUpdated — properties.info is a Session, whose own id is the session id.
    const event = {
      type: "session.updated",
      properties: { info: { id: "ses_updated_1", title: "x" } },
    }
    expect(sessionIdOf(event)).toBe("ses_updated_1")
  })

  it("reads `properties.info.sessionID` off a message.updated event", () => {
    // EventMessageUpdated — properties.info is a Message, which carries sessionID (not its own id).
    const event = {
      type: "message.updated",
      properties: { info: { id: "msg_1", sessionID: "ses_message_1", role: "assistant" } },
    }
    expect(sessionIdOf(event)).toBe("ses_message_1")
  })

  it("reads `properties.part.sessionID` off a message.part.updated event", () => {
    // EventMessagePartUpdated — properties.part is a Part, which carries sessionID.
    const event = {
      type: "message.part.updated",
      properties: { part: { id: "prt_1", sessionID: "ses_part_1", messageID: "msg_1", type: "text" } },
    }
    expect(sessionIdOf(event)).toBe("ses_part_1")
  })

  it("returns null for a session.error event with no sessionID", () => {
    // EventSessionError — sessionID is optional; absent ⇒ unattributable ⇒ null (not a throw).
    const event = {
      type: "session.error",
      properties: { error: { name: "UnknownError", data: { message: "boom" } } },
    }
    expect(sessionIdOf(event)).toBeNull()
  })
})

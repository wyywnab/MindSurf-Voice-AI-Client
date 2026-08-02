import { describe, expect, it, vi } from "vitest";

import type { ControlEnvelope } from "../../types/protocol";
import { ProtocolEventRouter } from "./protocolEventRouter";

function event(
  type: string,
  requestId: string | null,
  eventId: string = crypto.randomUUID(),
): ControlEnvelope<unknown> {
  return {
    v: 1,
    type,
    request_id: requestId,
    event_id: eventId,
    sent_at_ms: Date.now(),
    payload: {},
  };
}

describe("ProtocolEventRouter", () => {
  it("routes only events for the active request", () => {
    const onRequestEvent = vi.fn();
    const router = new ProtocolEventRouter({
      onConnectionEvent: vi.fn(),
      onRequestEvent,
    });
    expect(router.route(event("asr.final", "current"), "current", false)).toBe(
      "request",
    );
    expect(router.route(event("asr.final", "old"), "current", false)).toBe(
      "stale_request",
    );
    expect(onRequestEvent).toHaveBeenCalledTimes(1);
  });

  it("deduplicates event IDs and rejects terminal updates", () => {
    const router = new ProtocolEventRouter({
      onConnectionEvent: vi.fn(),
      onRequestEvent: vi.fn(),
    });
    const message = event("assistant.text.delta", "current", "same-event");
    expect(router.route(message, "current", false)).toBe("request");
    expect(router.route(message, "current", false)).toBe("duplicate");
    expect(router.route(event("request.done", "current"), "current", true)).toBe(
      "terminal_request",
    );
  });
});

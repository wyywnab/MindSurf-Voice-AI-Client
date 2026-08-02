import type { ControlEnvelope } from "../../types/protocol";

export type ProtocolRouteResult =
  | "connection"
  | "request"
  | "duplicate"
  | "stale_request"
  | "terminal_request"
  | "unknown";

const CONNECTION_EVENTS = new Set(["server.hello", "session.ping", "error"]);
const REQUEST_EVENTS = new Set([
  "request.accepted",
  "input.committed",
  "asr.partial",
  "asr.final",
  "assistant.text.delta",
  "assistant.text.done",
  "output.audio.start",
  "output.audio.done",
  "request.done",
  "request.cancelled",
  "error",
]);

export class ProtocolEventRouter {
  private readonly eventIds = new Set<string>();

  constructor(
    private readonly callbacks: {
      onConnectionEvent(message: ControlEnvelope<unknown>): void;
      onRequestEvent(message: ControlEnvelope<unknown>): void;
    },
  ) {}

  route(
    message: ControlEnvelope<unknown>,
    activeRequestId: string | null,
    requestIsTerminal: boolean,
  ): ProtocolRouteResult {
    if (this.eventIds.has(message.event_id)) return "duplicate";
    this.eventIds.add(message.event_id);
    if (this.eventIds.size > 1_024) {
      this.eventIds.clear();
      this.eventIds.add(message.event_id);
    }

    if (CONNECTION_EVENTS.has(message.type) && message.request_id === null) {
      this.callbacks.onConnectionEvent(message);
      return "connection";
    }
    if (!REQUEST_EVENTS.has(message.type)) return "unknown";
    if (!message.request_id || message.request_id !== activeRequestId) {
      return "stale_request";
    }
    if (requestIsTerminal) return "terminal_request";
    this.callbacks.onRequestEvent(message);
    return "request";
  }
}

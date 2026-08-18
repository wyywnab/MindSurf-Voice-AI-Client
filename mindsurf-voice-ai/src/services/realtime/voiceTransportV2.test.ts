import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTicketProvider } from "./realtimeTicketProvider";
import { shouldReconnectAfterClose, VoiceTransportV2 } from "./voiceTransportV2";

const helloEventId = "019d643e-1550-761a-b7a0-471791bcaf0b";
const sessionId = "019d643e-1550-761a-b7a0-471791bcaf0c";

class FakeSocket {
  readyState = 0;
  protocol = "mindsurf.voice.v2";
  binaryType = "blob";
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  send(value: string) {
    this.sent.push(value);
  }

  close(code = 1_006, reason = "") {
    this.closeCalls.push({ code, reason });
    this.serverClose(code, reason);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  message(value: unknown) {
    const data = typeof value === "string" ? value : JSON.stringify(value);
    this.onmessage?.({ data } as MessageEvent);
  }

  binaryMessage() {
    this.onmessage?.({ data: new ArrayBuffer(2) } as MessageEvent);
  }

  serverClose(code: number, reason = "") {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

function envelope(
  type: string,
  payload: Record<string, unknown>,
  eventId = helloEventId,
  requestId: string | null = null,
) {
  return {
    v: 2,
    type,
    event_id: eventId,
    request_id: requestId,
    sent_at_ms: Date.now(),
    payload,
  };
}

function serverHello() {
  return envelope("server.hello", {
    session_id: sessionId,
    protocol_version: 2,
    input_audio: { encoding: "pcm_s16le", sample_rate: 16_000, channels: 1 },
    heartbeat_interval_ms: 2_000,
    heartbeat_timeout_ms: 1_000,
    input_idle_timeout_ms: 10_000,
    limits: {
      max_control_bytes: 65_536,
      max_binary_bytes: 65_584,
      max_recording_ms: 120_000,
    },
  });
}

function requestAccepted() {
  return {
    mode: "asr_only",
    pipeline: "opaque",
    capabilities_revision: "cap-1",
    selection: { asr: "asr", llm: null },
    language: "auto",
    max_recording_ms: 60_000,
    quota_reservation: { asr_credits: 1, llm_credits: 0, credits: 1 },
  };
}

function setup() {
  const acquire = vi.fn(async () => ({
    url: "wss://api.example.com/socket?ticket=redacted",
    subprotocol: "mindsurf.voice.v2" as const,
    expiresAtMs: Date.now() + 30_000,
  }));
  const sockets: FakeSocket[] = [];
  const callbacks = {
    onStatusChange: vi.fn(),
    onServerHello: vi.fn(),
    onControlMessage: vi.fn(),
    onError: vi.fn(),
    onReconnectAttempt: vi.fn(),
    onDuplicateEvent: vi.fn(),
    onSessionRevoked: vi.fn(),
  };
  const transport = new VoiceTransportV2(
    { acquire } as unknown as RealtimeTicketProvider,
    { version: "2.0.0", platform: "macos", arch: "aarch64" },
    callbacks,
    () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    () => 0,
  );
  return { transport, acquire, sockets, callbacks };
}

describe("VoiceTransportV2", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => vi.useRealTimers());

  it("implements the frozen close-code reconnect matrix", () => {
    for (const code of [1_001, 1_011, 4_002, 4_003]) {
      expect(shouldReconnectAfterClose(code), String(code)).toBe(true);
    }
    for (const code of [1_000, 1_002, 4_001]) {
      expect(shouldReconnectAfterClose(code), String(code)).toBe(false);
    }
  });

  it("uses a fresh ticket, completes hello, and replies to ping with the same nonce", async () => {
    const { transport, acquire, sockets, callbacks } = setup();
    await transport.connect();
    expect(acquire).toHaveBeenCalledOnce();
    const socket = sockets[0]!;
    socket.open();
    const clientHello = JSON.parse(socket.sent[0]!);
    expect(clientHello.type).toBe("client.hello");
    expect(clientHello.payload.protocol_versions).toEqual([2]);
    expect(clientHello.payload).not.toHaveProperty("auth");

    socket.message(serverHello());
    expect(transport.connectionStatus).toBe("connected");
    expect(callbacks.onServerHello).toHaveBeenCalledOnce();

    socket.message(
      envelope(
        "session.ping",
        { nonce: "hb-1" },
        "019d643e-1550-761a-b7a0-471791bcaf0d",
      ),
    );
    const pong = JSON.parse(socket.sent[socket.sent.length - 1]!);
    expect(pong.type).toBe("session.pong");
    expect(pong.payload.nonce).toBe("hb-1");
  });

  it("only lets valid pings refresh the heartbeat watchdog", async () => {
    const { transport, sockets } = setup();
    await transport.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.message(serverHello());
    await vi.advanceTimersByTimeAsync(2_000);
    socket.message(
      envelope(
        "request.accepted",
        requestAccepted(),
        "019d643e-1550-761a-b7a0-471791bcaf0e",
        "00112233-4455-6677-8899-aabbccddeeff",
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.closeCalls[socket.closeCalls.length - 1]?.code).toBe(4_002);
  });

  it("rejects server binary messages and does not reconnect after protocol close", async () => {
    const { transport, acquire, sockets } = setup();
    await transport.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.message(serverHello());
    socket.binaryMessage();
    expect(socket.closeCalls[socket.closeCalls.length - 1]?.code).toBe(1_002);
    await vi.runAllTimersAsync();
    expect(acquire).toHaveBeenCalledOnce();
    expect(transport.connectionStatus).toBe("error");
  });

  it("uses a new ticket after recoverable close and stops after 4001", async () => {
    const { transport, acquire, sockets } = setup();
    await transport.connect();
    sockets[0]!.serverClose(4_002);
    await vi.advanceTimersByTimeAsync(200);
    expect(acquire).toHaveBeenCalledTimes(2);
    sockets[1]!.serverClose(4_001);
    await vi.runAllTimersAsync();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(transport.connectionStatus).toBe("error");
  });

  it("hard-resets a socket that is still connecting when manually retried", async () => {
    const { transport, acquire, sockets } = setup();
    await transport.connect();
    expect(transport.connectionStatus).toBe("connecting");

    await transport.retryNow();

    expect(sockets[0]!.closeCalls).toEqual([{ code: 1_000, reason: "manual retry" }]);
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(transport.connectionStatus).toBe("connecting");
  });

  it("reports a safe reason when WebSocket construction is blocked", async () => {
    const acquire = vi.fn(async () => ({
      url: "wss://api.example.com/socket?ticket=must-not-appear",
      subprotocol: "mindsurf.voice.v2" as const,
      expiresAtMs: Date.now() + 30_000,
    }));
    const callbacks = {
      onStatusChange: vi.fn(),
      onServerHello: vi.fn(),
      onControlMessage: vi.fn(),
      onError: vi.fn(),
      onReconnectAttempt: vi.fn(),
    };
    const transport = new VoiceTransportV2(
      { acquire } as unknown as RealtimeTicketProvider,
      { version: "2.0.0", platform: "macos", arch: "aarch64" },
      callbacks,
      () => {
        throw new DOMException(
          "Blocked URL wss://api.example.com/socket?ticket=must-not-appear",
          "SecurityError",
        );
      },
      () => 0,
    );

    await transport.connect();

    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "connection_failed",
        message: "浏览器安全策略阻止创建实时连接",
        recoverable: true,
      }),
    );
    expect(JSON.stringify(callbacks.onError.mock.calls)).not.toContain(
      "must-not-appear",
    );
  });

  it("silently ignores duplicate event IDs", async () => {
    const { transport, sockets, callbacks } = setup();
    await transport.connect();
    const socket = sockets[0]!;
    socket.open();
    socket.message(serverHello());
    const ping = envelope(
      "session.ping",
      { nonce: "same" },
      "019d643e-1550-761a-b7a0-471791bcaf0d",
    );
    socket.message(ping);
    socket.message(ping);
    expect(callbacks.onDuplicateEvent).toHaveBeenCalledOnce();
    expect(
      socket.sent.filter((item) => JSON.parse(item).type === "session.pong"),
    ).toHaveLength(1);
  });
});

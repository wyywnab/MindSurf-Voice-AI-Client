import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeAudioFrameHeader } from "./protocol";
import { VoiceWebSocketClient } from "./voiceWebSocket";
import type { ControlEnvelope, ServerHelloPayload } from "../types/protocol";
import type { ServiceConnectionStatus } from "../types/voice";

class FakeWebSocket {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  binaryType = "blob";
  bufferedAmount = 0;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  protocol: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];

  constructor(
    readonly url: string,
    protocol: string,
  ) {
    this.protocol = protocol;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ControlEnvelope<unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  receiveData(data: unknown) {
    this.onmessage?.({ data });
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("VoiceWebSocketClient", () => {
  it("handshakes, accepts a request and sends a protocol audio frame", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const statuses: ServiceConnectionStatus[] = [];
    const client = new VoiceWebSocketClient(
      "ws://127.0.0.1:8000/v1/voice/ws",
      { version: "0.1.0", platform: "windows", arch: "x86_64" },
      {
        onAudioFrame: vi.fn(),
        onControlMessage: vi.fn(),
        onReconnectAttempt: vi.fn(),
        onServerHello: vi.fn(),
        onStatusChange: (status) => statuses.push(status),
        onTransportError: vi.fn(),
      },
    );

    client.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket?.open();

    const hello = JSON.parse(String(socket?.sent[0])) as ControlEnvelope<unknown>;
    expect(hello.type).toBe("client.hello");

    socket?.receive(envelope("server.hello", null, serverHello()));
    expect(statuses).toContain("connected");

    const acceptedPromise = client.startRequest({
      mode: "dictation",
    });
    const start = JSON.parse(
      String(socket?.sent[(socket?.sent.length ?? 1) - 1]),
    ) as ControlEnvelope<unknown>;
    socket?.receive(
      envelope("request.accepted", start.request_id, {
        mode: "dictation",
        language: "zh-CN",
        selection: {
          asr: "asr-mock",
          llm: null,
          tts: null,
          output_audio: null,
        },
        voice: "default",
        max_recording_ms: 60_000,
      }),
    );

    const accepted = await acceptedPromise;
    client.sendInputAudio(accepted.requestId, 0, 0, new Int16Array(320));

    const binary = socket?.sent[(socket?.sent.length ?? 1) - 1];
    expect(binary).toBeInstanceOf(ArrayBuffer);
    expect(decodeAudioFrameHeader(binary as ArrayBuffer)).toMatchObject({
      requestId: accepted.requestId,
      sequence: 0,
      payloadLength: 640,
    });

    client.disconnect();
  });

  it("sends bearer auth and does not reconnect after an auth failure", async () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const statuses: ServiceConnectionStatus[] = [];
    const reconnectAttempts = vi.fn();
    const client = new VoiceWebSocketClient(
      "wss://voice.example.com/v1/voice/ws",
      { version: "0.1.0", platform: "windows", arch: "x86_64" },
      {
        onAudioFrame: vi.fn(),
        onControlMessage: vi.fn(),
        onReconnectAttempt: reconnectAttempts,
        onServerHello: vi.fn(),
        onStatusChange: (status) => statuses.push(status),
        onTransportError: vi.fn(),
      },
      { tokenProvider: async () => "secret-token" },
    );

    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await vi.waitFor(() => expect(socket?.sent).toHaveLength(1));

    const hello = JSON.parse(String(socket?.sent[0])) as ControlEnvelope<{
      auth: { scheme: string; token: string };
    }>;
    expect(hello.payload.auth).toEqual({
      scheme: "bearer",
      token: "secret-token",
    });

    socket?.receive(
      envelope("error", null, {
        code: "authentication_failed",
        message: "Token 无效",
        stage: "session",
        recoverable: false,
        fatal: true,
        details: {},
      }),
    );

    expect(statuses[statuses.length - 1]).toBe("error");
    expect(reconnectAttempts).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("times out handshake and request acceptance with stable error codes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const transportErrors = vi.fn();
    const client = createClient(transportErrors);

    client.connect();
    const firstSocket = FakeWebSocket.instances[0];
    firstSocket?.open();
    await vi.advanceTimersByTimeAsync(3_001);
    expect(transportErrors.mock.calls[0]?.[0]).toMatchObject({
      code: "handshake_timeout",
    });

    const connectedClient = createClient(transportErrors);
    connectedClient.connect();
    const secondSocket = FakeWebSocket.instances[1];
    secondSocket?.open();
    secondSocket?.receive(envelope("server.hello", null, serverHello()));
    const accepted = connectedClient.startRequest({ mode: "dictation" });
    const rejection = expect(accepted).rejects.toMatchObject({
      code: "request.accepted_timeout",
    });
    await vi.advanceTimersByTimeAsync(2_001);
    await rejection;
    connectedClient.disconnect();
  });

  it("rejects malformed output audio without delivering it", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onAudioFrame = vi.fn();
    const onTransportError = vi.fn();
    const client = createClient(onTransportError, onAudioFrame);
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    socket?.receive(envelope("server.hello", null, serverHello()));
    socket?.receiveData(new ArrayBuffer(8));

    expect(onAudioFrame).not.toHaveBeenCalled();
    expect(onTransportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: "invalid_audio_frame" }),
    );
    client.disconnect();
  });
});

function createClient(onTransportError = vi.fn(), onAudioFrame = vi.fn()) {
  return new VoiceWebSocketClient(
    "ws://127.0.0.1:8000/v1/voice/ws",
    { version: "0.1.0", platform: "windows", arch: "x86_64" },
    {
      onAudioFrame,
      onControlMessage: vi.fn(),
      onReconnectAttempt: vi.fn(),
      onServerHello: vi.fn(),
      onStatusChange: vi.fn(),
      onTransportError,
    },
    { autoReconnect: false },
  );
}

function envelope(
  type: string,
  requestId: string | null,
  payload: unknown,
): ControlEnvelope<unknown> {
  return {
    v: 1,
    type,
    event_id: crypto.randomUUID(),
    request_id: requestId,
    sent_at_ms: Date.now(),
    payload,
  };
}

function serverHello(): ServerHelloPayload {
  return {
    session_id: crypto.randomUUID(),
    protocol_version: 1,
    pipeline: "cascade",
    limits: {
      max_recording_ms: 60_000,
      max_json_bytes: 65_536,
      max_binary_bytes: 65_536,
    },
    features: {
      streaming_asr: true,
      streaming_text: false,
      streaming_audio: false,
      cancellation: true,
    },
    inference_options: {
      defaults: {
        asr: "asr-mock",
        llm: "llm-mock",
        tts: "tts-mock",
        output_audio: "pcm16-24k-mono",
      },
      asr: [{ id: "asr-mock", name: "ASR", description: "Mock" }],
      llm: [{ id: "llm-mock", name: "LLM", description: "Mock" }],
      tts: [{ id: "tts-mock", name: "TTS", description: "Mock" }],
      output_audio: [
        {
          id: "pcm16-24k-mono",
          name: "PCM",
          description: "Mock",
          encoding: "pcm_s16le",
          sample_rate: 24_000,
          channels: 1,
        },
      ],
    },
    heartbeat: { interval_ms: 15_000, timeout_ms: 10_000 },
  };
}

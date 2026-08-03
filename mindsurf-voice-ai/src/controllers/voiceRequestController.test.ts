import { afterEach, describe, expect, it, vi } from "vitest";

import { requestStoreActions, useRequestStore } from "../stores/requestStore";
import { settingsStoreActions } from "../stores/settingsStore";
import type { ControlEnvelope, ServerHelloPayload } from "../types/protocol";
import { VoiceRequestController } from "./voiceRequestController";

class MockTransportSocket {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static instances: MockTransportSocket[] = [];

  binaryType = "blob";
  bufferedAmount = 0;
  onclose: ((event?: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onopen: (() => void) | null = null;
  protocol = "mindsurf.voice.v1";
  readyState = MockTransportSocket.CONNECTING;
  sent: unknown[] = [];

  constructor(
    readonly url: string,
    readonly requestedProtocol: string,
  ) {
    MockTransportSocket.instances.push(this);
  }

  open() {
    this.readyState = MockTransportSocket.OPEN;
    this.onopen?.();
  }

  receive(message: ControlEnvelope<unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close(code = 1_000, reason = "") {
    if (this.readyState === MockTransportSocket.CLOSED) return;
    this.readyState = MockTransportSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

afterEach(() => {
  MockTransportSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("VoiceRequestController integration", () => {
  it("completes a dictation request and releases the active request", async () => {
    vi.stubGlobal("WebSocket", MockTransportSocket);
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    settingsStoreActions.setMode("dictation");
    settingsStoreActions.setAutoInjection("dictation", false);
    const controller = new VoiceRequestController();
    controller.connect({ version: "0.1.0", platform: "windows", arch: "x86_64" });
    const socket = MockTransportSocket.instances[0]!;
    socket.open();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.receive(envelope("server.hello", null, serverHello()));

    requestStoreActions.beginPreparation();
    const started = controller.startRequest();
    const start = JSON.parse(
      String(socket.sent[socket.sent.length - 1]),
    ) as ControlEnvelope<unknown>;
    socket.receive(envelope("request.accepted", start.request_id, acceptedPayload()));
    const requestId = await started;
    controller.markRecording();
    expect(controller.sendAudioFrame(new Int16Array(320), 0)).toBe(true);

    const committed = controller.commitInput({
      durationMs: 20,
      frameCount: 1,
      liveTracksAfterCleanup: 0,
      sampleCount: 320,
      sampleRate: 16_000,
      sourceSampleRate: 16_000,
      wavBytes: new Uint8Array(),
    });
    socket.receive(
      envelope("input.committed", requestId, { accepted_duration_ms: 20 }),
    );
    await committed;
    socket.receive(
      envelope("asr.final", requestId, {
        text: "集成测试识别结果",
        language: "zh-CN",
        confidence: 1,
        duration_ms: 20,
      }),
    );
    socket.receive(envelope("request.done", requestId, { result: "success" }));

    const request = useRequestStore().state;
    expect(request.status).toBe("completed");
    expect(request.asrFinal).toBe("集成测试识别结果");
    expect(request.activeRequestId).toBeNull();

    requestStoreActions.beginPreparation();
    const prematureStart = controller.startRequest();
    const prematureEnvelope = JSON.parse(
      String(socket.sent[socket.sent.length - 1]),
    ) as ControlEnvelope<unknown>;
    socket.receive(
      envelope("request.accepted", prematureEnvelope.request_id, acceptedPayload()),
    );
    const prematureRequestId = await prematureStart;
    controller.markRecording();
    const prematureCommit = controller.commitInput({
      durationMs: 0,
      frameCount: 0,
      liveTracksAfterCleanup: 0,
      sampleCount: 0,
      sampleRate: 16_000,
      sourceSampleRate: 16_000,
      wavBytes: new Uint8Array(),
    });
    socket.receive(
      envelope("input.committed", prematureRequestId, {
        accepted_duration_ms: 0,
      }),
    );
    await prematureCommit;
    socket.receive(envelope("request.done", prematureRequestId, { result: "success" }));
    expect(request.status).toBe("failed");
    expect(request.lastError).toContain("未收到最终识别结果");
    expect(request.activeRequestId).toBeNull();
    controller.disconnect();
  });
});

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

function acceptedPayload() {
  return {
    mode: "dictation",
    language: "zh-CN",
    selection: { asr: "asr-mock", llm: null, tts: null, output_audio: null },
    voice: "default",
    max_recording_ms: 60_000,
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
      streaming_text: true,
      streaming_audio: true,
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

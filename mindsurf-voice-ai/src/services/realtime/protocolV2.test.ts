import { describe, expect, it } from "vitest";
import {
  createClientHello,
  createInputCommit,
  createRequestCancel,
  createRequestStart,
  parseServerControlMessage,
  parseServerHello,
} from "./protocolV2";

const eventId = "019d643e-1550-761a-b7a0-471791bcaf0b";
const sessionId = "019d643e-1550-761a-b7a0-471791bcaf0c";

function helloPayload() {
  return {
    session_id: sessionId,
    protocol_version: 2,
    input_audio: { encoding: "pcm_s16le", sample_rate: 16_000, channels: 1 },
    heartbeat_interval_ms: 15_000,
    heartbeat_timeout_ms: 5_000,
    input_idle_timeout_ms: 10_000,
    limits: {
      max_control_bytes: 65_536,
      max_binary_bytes: 65_584,
      max_recording_ms: 120_000,
    },
  };
}

describe("Voice v2 protocol", () => {
  it("creates a v2 hello without auth or output audio", () => {
    const hello = createClientHello({
      version: "2.0.0",
      platform: "macos",
      arch: "aarch64",
    });
    expect(hello.v).toBe(2);
    expect(hello.request_id).toBeNull();
    expect(hello.payload).toMatchObject({ protocol_versions: [2] });
    expect(hello.payload).not.toHaveProperty("auth");
    expect(hello.payload).not.toHaveProperty("output_audio");
  });

  it("creates request-scoped client controls with fresh event IDs", () => {
    const requestId = "00112233-4455-6677-8899-aabbccddeeff";
    const start = createRequestStart(requestId, {
      mode: "asr_only",
      pipeline: "opaque",
      capabilities_revision: "cap-1",
      selection: { asr: "asr", llm: null },
      language: "auto",
    });
    const commit = createInputCommit(requestId, {
      last_sequence: 0,
      chunk_count: 1,
      sample_count: 320,
      duration_ms: 20,
    });
    const cancel = createRequestCancel(requestId, "user_cancelled");
    expect([start, commit, cancel].map((item) => item.request_id)).toEqual([
      requestId,
      requestId,
      requestId,
    ]);
    expect(new Set([start.event_id, commit.event_id, cancel.event_id]).size).toBe(3);
    expect(start.payload).not.toHaveProperty("generation");
  });

  it("validates the frozen heartbeat relation", () => {
    expect(parseServerHello(helloPayload()).protocol_version).toBe(2);
    expect(() =>
      parseServerHello({
        ...helloPayload(),
        heartbeat_interval_ms: 5_000,
        heartbeat_timeout_ms: 5_000,
      }),
    ).toThrow();
  });

  it("rejects unknown top-level fields and oversized controls", () => {
    const message = {
      v: 2,
      type: "server.hello",
      event_id: eventId,
      request_id: null,
      sent_at_ms: 1,
      payload: helloPayload(),
    };
    expect(parseServerControlMessage(JSON.stringify(message), 65_536).type).toBe(
      "server.hello",
    );
    expect(() =>
      parseServerControlMessage(JSON.stringify({ ...message, extra: true }), 65_536),
    ).toThrow();
    expect(() => parseServerControlMessage(JSON.stringify(message), 10)).toThrow(
      /上限/,
    );
  });

  it("rejects request/session scope mismatches", () => {
    const ping = {
      v: 2,
      type: "session.ping",
      event_id: eventId,
      request_id: sessionId,
      sent_at_ms: 1,
      payload: { nonce: "hb" },
    };
    expect(() => parseServerControlMessage(JSON.stringify(ping), 65_536)).toThrow();
  });

  it("strictly validates request payloads and error combinations", () => {
    const requestId = "00112233-4455-6677-8899-aabbccddeeff";
    const accepted = {
      v: 2,
      type: "request.accepted",
      event_id: eventId,
      request_id: requestId,
      sent_at_ms: 1,
      payload: {
        mode: "asr_only",
        pipeline: "opaque",
        capabilities_revision: "cap-1",
        selection: { asr: "asr", llm: null },
        language: "auto",
        max_recording_ms: 60_000,
        quota_reservation: { asr_credits: 1, llm_credits: 0, credits: 1 },
      },
    };
    expect(parseServerControlMessage(JSON.stringify(accepted), 65_536).type).toBe(
      "request.accepted",
    );
    expect(() =>
      parseServerControlMessage(
        JSON.stringify({
          ...accepted,
          payload: {
            ...accepted.payload,
            quota_reservation: { asr_credits: 1, llm_credits: 0, credits: 2 },
          },
        }),
        65_536,
      ),
    ).toThrow();
    const removedContextKey = ["conversation", "id"].join("_");
    expect(() =>
      parseServerControlMessage(
        JSON.stringify({
          ...accepted,
          payload: { ...accepted.payload, [removedContextKey]: "removed" },
        }),
        65_536,
      ),
    ).toThrow();

    const invalidError = {
      v: 2,
      type: "error",
      event_id: eventId,
      request_id: null,
      sent_at_ms: 1,
      payload: {
        code: "session_revoked",
        message: "revoked",
        stage: "routing",
        terminal: false,
        retryable: false,
        fatal: true,
        details: {},
      },
    };
    expect(() =>
      parseServerControlMessage(JSON.stringify(invalidError), 65_536),
    ).toThrow();
  });
});

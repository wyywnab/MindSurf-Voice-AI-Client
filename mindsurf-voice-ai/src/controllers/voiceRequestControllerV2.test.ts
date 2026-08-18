import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capabilities, VoiceModeV2 } from "../types/httpApi";
import type { V2ControlEnvelope } from "../types/realtimeV2";

let listener: {
  onMessage(message: V2ControlEnvelope): void;
  onConnectionLost(): void;
};
const sentControls: V2ControlEnvelope[] = [];
const sendBinary = vi.fn();
const refreshAccount = vi.fn(async () => undefined);
const addHistory = vi.fn(async () => undefined);

vi.mock("../stores/accountStore", () => ({
  useAccountStore: () => ({
    state: { user: { user_id: "user-a" } },
  }),
}));

vi.mock("../stores/historyStore", () => ({
  historyStoreActions: { add: addHistory },
}));

const hello = {
  session_id: "019d643e-1550-761a-b7a0-471791bcaf0c",
  protocol_version: 2 as const,
  input_audio: {
    encoding: "pcm_s16le" as const,
    sample_rate: 16_000 as const,
    channels: 1 as const,
  },
  heartbeat_interval_ms: 15_000,
  heartbeat_timeout_ms: 5_000,
  input_idle_timeout_ms: 10_000,
  limits: {
    max_control_bytes: 65_536,
    max_binary_bytes: 65_584,
    max_recording_ms: 120_000,
  },
};

vi.mock("./realtimeConnectionController", () => ({
  realtimeConnectionController: {
    get serverHello() {
      return hello;
    },
    setRequestListener(value: typeof listener) {
      listener = value;
    },
    sendControl(message: V2ControlEnvelope) {
      sentControls.push(message);
    },
    sendBinary,
    recycleConnection: vi.fn(),
    notifyRequestTerminal: refreshAccount,
  },
}));

vi.mock("./authController", () => ({ authController: { refreshAccount } }));

const capabilities: Capabilities = {
  protocol_version: 2,
  revision: "cap-1",
  realtime: {
    websocket_path: "/v2/realtime",
    ticket_path: "/v2/realtime/tickets",
    subprotocol: "mindsurf.voice.v2",
    persistent: true,
  },
  modes: ["asr_only", "asr_llm"],
  pipelines: [
    {
      id: "pipeline",
      name: "Pipeline",
      description: "test",
      modes: ["asr_only", "asr_llm"],
      max_recording_ms: 60_000,
      asr_options: ["asr"],
      llm_options: ["llm"],
      generation_controls: {},
    },
  ],
  asr_options: [{ id: "asr", name: "ASR" }],
  llm_options: [{ id: "llm", name: "LLM" }],
  recognition_languages: ["auto"],
  defaults: {
    asr_only: { pipeline: "pipeline", selection: { asr: "asr", llm: null } },
    asr_llm: { pipeline: "pipeline", selection: { asr: "asr", llm: "llm" } },
  },
};

let controller: typeof import("./voiceRequestControllerV2").voiceRequestControllerV2;
let capabilityActions: typeof import("../stores/capabilitiesStore").capabilitiesStoreActions;
let requestState: ReturnType<
  typeof import("../stores/requestStore").useRequestStore
>["state"];

beforeAll(async () => {
  ({ voiceRequestControllerV2: controller } =
    await import("./voiceRequestControllerV2"));
  ({ capabilitiesStoreActions: capabilityActions } =
    await import("../stores/capabilitiesStore"));
  requestState = (await import("../stores/requestStore")).useRequestStore().state;
});

beforeEach(() => {
  vi.clearAllMocks();
  sentControls.length = 0;
  capabilityActions.setCapabilities(capabilities);
});

function event(
  type: string,
  requestId: string,
  payload: Record<string, unknown>,
): V2ControlEnvelope {
  return {
    v: 2,
    type,
    event_id: crypto.randomUUID(),
    request_id: requestId,
    sent_at_ms: Date.now(),
    payload,
  };
}

async function accept(mode: VoiceModeV2) {
  capabilityActions.selectMode(mode);
  const pending = controller.startRequest();
  const start = sentControls[sentControls.length - 1]!;
  listener.onMessage(
    event("request.accepted", start.request_id!, {
      ...start.payload,
      max_recording_ms: 60_000,
      quota_reservation: {
        asr_credits: 1,
        llm_credits: mode === "asr_llm" ? 1 : 0,
        credits: mode === "asr_llm" ? 2 : 1,
      },
    }),
  );
  await expect(pending).resolves.toBe(60_000);
  return start.request_id!;
}

async function sendAndCommit(requestId: string) {
  expect(controller.sendAudioFrame(new Int16Array([1, -1]))).toBe(true);
  await controller.commitInput();
  const commit = sentControls[sentControls.length - 1]!;
  listener.onMessage(event("input.committed", requestId, commit.payload));
}

describe("VoiceRequestControllerV2", () => {
  it("commits asr_only exactly once after final snapshot and matching done", async () => {
    const requestId = await accept("asr_only");
    await sendAndCommit(requestId);
    const output = vi.spyOn(controller.textOutput, "output").mockResolvedValue();
    listener.onMessage(
      event("output.text.snapshot", requestId, {
        stage: "asr",
        text: "Final text",
        final: true,
      }),
    );
    expect(output).not.toHaveBeenCalled();
    listener.onMessage(
      event("request.done", requestId, {
        result: "success",
        mode: "asr_only",
        final_text: "Final text",
        usage: {},
      }),
    );
    expect(output).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith("Final text", 0, expect.any(Number));
    expect(addHistory).toHaveBeenCalledOnce();
    expect(addHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: requestId,
        userId: "user-a",
        mode: "asr_only",
        sourceText: null,
        resultText: "Final text",
      }),
    );
    expect(requestState.status).toBe("completed");
    expect(requestState.activeRequestId).toBeNull();
  });

  it("requires ASR closure and the empty LLM stage transition", async () => {
    const requestId = await accept("asr_llm");
    await sendAndCommit(requestId);
    listener.onMessage(
      event("output.text.snapshot", requestId, {
        stage: "asr",
        text: "raw",
        final: false,
      }),
    );
    listener.onMessage(
      event("output.text.snapshot", requestId, {
        stage: "llm",
        text: "",
        final: false,
      }),
    );
    listener.onMessage(
      event("output.text.delta", requestId, {
        stage: "llm",
        sequence: 0,
        delta: "polished",
      }),
    );
    listener.onMessage(
      event("output.text.snapshot", requestId, {
        stage: "llm",
        text: "Polished.",
        final: true,
      }),
    );
    listener.onMessage(
      event("request.done", requestId, {
        result: "success",
        mode: "asr_llm",
        final_text: "Polished.",
        usage: {},
      }),
    );
    expect(requestState.temporaryText).toBe("Polished.");
    expect(addHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        id: requestId,
        mode: "asr_llm",
        sourceText: "raw",
        resultText: "Polished.",
      }),
    );
    expect(requestState.status).toBe("completed");
  });

  it("revokes commit eligibility on cancellation even when done wins the race", async () => {
    const requestId = await accept("asr_only");
    await sendAndCommit(requestId);
    const output = vi.spyOn(controller.textOutput, "output").mockResolvedValue();
    listener.onMessage(
      event("output.text.snapshot", requestId, {
        stage: "asr",
        text: "Final",
        final: true,
      }),
    );
    await controller.cancelCurrentRequest("user_cancelled");
    listener.onMessage(
      event("request.done", requestId, {
        result: "success",
        mode: "asr_only",
        final_text: "Final",
        usage: {},
      }),
    );
    expect(output).not.toHaveBeenCalled();
    expect(addHistory).not.toHaveBeenCalled();
    expect(requestState.status).toBe("completed");
  });

  it("splits recorder chunks to honor the negotiated binary limit", async () => {
    const requestId = await accept("asr_only");
    hello.limits.max_binary_bytes = 52;
    expect(controller.sendAudioFrame(new Int16Array([1, 2, 3, 4, 5]))).toBe(true);
    expect(sendBinary).toHaveBeenCalledTimes(3);
    await controller.commitInput();
    expect(sentControls[sentControls.length - 1]!.payload).toEqual({
      last_sequence: 2,
      chunk_count: 3,
      sample_count: 5,
      duration_ms: 1,
    });
    await controller.cancelCurrentRequest("user_cancelled");
    listener.onMessage(
      event("request.cancelled", requestId, { reason: "user_cancelled" }),
    );
    hello.limits.max_binary_bytes = 65_584;
  });

  it("fails an active request on disconnect without replay", async () => {
    await accept("asr_only");
    listener.onConnectionLost();
    expect(addHistory).not.toHaveBeenCalled();
    expect(requestState.status).toBe("failed");
    expect(requestState.commitEligible).toBe(false);
    expect(requestState.activeRequestId).toBeNull();
  });
});

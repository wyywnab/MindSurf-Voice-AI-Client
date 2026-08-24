import { beforeEach, describe, expect, it, vi } from "vitest";

import { RecordingController } from "./recordingController";

const { cancelCurrentRequest, prepareTarget, startRequest } = vi.hoisted(() => ({
  cancelCurrentRequest: vi.fn(async () => undefined),
  prepareTarget: vi.fn(async () => undefined),
  startRequest: vi.fn(async () => undefined),
}));

vi.mock("./voiceRequestControllerV2", () => ({
  voiceRequestControllerV2: {
    cancelCurrentRequest,
    startRequest,
    textOutput: { prepareTarget },
  },
}));

vi.mock("../stores/realtimeConnectionStore", () => ({
  useRealtimeConnectionStore: () => ({ state: { status: "connected" } }),
}));

vi.mock("../stores/requestStore", () => ({
  requestStoreActions: { beginPreparation: vi.fn() },
  useRequestStore: () => ({
    state: {
      acceptedMaxRecordingMs: null,
      activeRequestId: null,
      status: "idle",
    },
  }),
}));

vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: () => ({
    state: {
      autoInjection: { asr_only: true, asr_llm: true },
      inputDeviceId: null,
    },
  }),
}));

vi.mock("../stores/capabilitiesStore", () => ({
  useCapabilitiesStore: () => ({ state: { selectedMode: "asr_only" } }),
}));

vi.mock("../stores/diagnosticsStore", () => ({
  diagnosticsStoreActions: {
    beginTimeline: vi.fn(),
    recordTimeline: vi.fn(),
  },
}));

describe("RecordingController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("releases a prepared recorder when injection permission preparation fails", async () => {
    prepareTarget.mockRejectedValueOnce(new Error("accessibility permission required"));
    const recorder = {
      cancelRecording: vi.fn(async () => undefined),
      isBusy: { value: false },
      prepareRecording: vi.fn(async () => true),
      startRecording: vi.fn(async () => true),
      stopRecording: vi.fn(),
    };
    const controller = new RecordingController(
      recorder as unknown as ConstructorParameters<typeof RecordingController>[0],
    );

    await expect(controller.startPushToTalk()).resolves.toBe(false);

    expect(recorder.cancelRecording).toHaveBeenCalledOnce();
    expect(cancelCurrentRequest).toHaveBeenCalledWith("user_cancelled");
    expect(startRequest).not.toHaveBeenCalled();
  });
});

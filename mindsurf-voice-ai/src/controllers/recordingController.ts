import type { useRecorder } from "../composables/useRecorder";
import { useRealtimeConnectionStore } from "../stores/realtimeConnectionStore";
import { diagnosticsStoreActions } from "../stores/diagnosticsStore";
import { requestStoreActions, useRequestStore } from "../stores/requestStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useCapabilitiesStore } from "../stores/capabilitiesStore";
import { voiceRequestControllerV2 } from "./voiceRequestControllerV2";

type Recorder = ReturnType<typeof useRecorder>;

export class RecordingController {
  private attempt = 0;
  private readonly connection = useRealtimeConnectionStore();
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();
  private readonly capabilities = useCapabilitiesStore();

  constructor(private readonly recorder: Recorder) {}

  async startPushToTalk(shouldContinue: () => boolean = () => true) {
    const attempt = ++this.attempt;
    diagnosticsStoreActions.beginTimeline(this.capabilities.state.selectedMode);
    requestStoreActions.beginPreparation();
    diagnosticsStoreActions.recordTimeline(
      "recording.prepare_started",
      "input",
      "开始准备麦克风",
    );
    const prepared = await this.recorder.prepareRecording(
      this.settings.state.inputDeviceId,
    );
    if (!prepared || attempt !== this.attempt || !shouldContinue()) {
      await this.recorder.cancelRecording();
      await voiceRequestControllerV2.cancelCurrentRequest("user_cancelled");
      return false;
    }
    if (this.settings.state.autoInjection[this.capabilities.state.selectedMode]) {
      try {
        await voiceRequestControllerV2.textOutput.prepareTarget();
      } catch {
        await voiceRequestControllerV2.cancelCurrentRequest("user_cancelled");
        return false;
      }
    }
    try {
      await voiceRequestControllerV2.startRequest();
    } catch {
      await this.recorder.cancelRecording();
      return false;
    }
    if (attempt !== this.attempt || !shouldContinue()) {
      await this.recorder.cancelRecording();
      await voiceRequestControllerV2.cancelCurrentRequest("user_cancelled");
      return false;
    }
    const maxDurationMs = this.request.state.acceptedMaxRecordingMs ?? 60_000;
    const started = await this.recorder.startRecording({
      maxDurationMs,
      onAutoStop: () => void this.stopPushToTalk(),
      onFrame: (frame, sequence) => {
        void sequence;
        voiceRequestControllerV2.sendAudioFrame(frame);
      },
    });
    if (started) {
      diagnosticsStoreActions.recordTimeline(
        "recording.started",
        "input",
        "录音已开始",
      );
      voiceRequestControllerV2.markRecording();
    } else await voiceRequestControllerV2.cancelCurrentRequest("user_cancelled");
    return started;
  }

  async stopPushToTalk() {
    const result = await this.recorder.stopRecording();
    if (!result) {
      await voiceRequestControllerV2.cancelCurrentRequest("user_cancelled");
      return;
    }
    diagnosticsStoreActions.recordTimeline("recording.stopped", "input", "录音已停止", {
      durationMs: Math.round(result.durationMs),
      frameCount: result.frameCount,
      sampleCount: result.sampleCount,
    });
    try {
      await voiceRequestControllerV2.commitInput();
    } catch {
      // Controller: 请求错误已经写入 requestStore。
    }
  }

  async cancelCurrentRequest() {
    this.attempt += 1;
    await this.recorder.cancelRecording();
    await voiceRequestControllerV2.cancelCurrentRequest("user_cancelled");
  }

  canStart() {
    return (
      this.connection.state.status === "connected" &&
      !this.request.state.activeRequestId &&
      ["idle", "completed", "cancelled", "failed"].includes(
        this.request.state.status,
      ) &&
      !this.recorder.isBusy.value
    );
  }
}

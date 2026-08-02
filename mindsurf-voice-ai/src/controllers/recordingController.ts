import type { useRecorder } from "../composables/useRecorder";
import { useConnectionStore } from "../stores/connectionStore";
import { useRequestStore } from "../stores/requestStore";
import { useSettingsStore } from "../stores/settingsStore";
import { voiceRequestController } from "./voiceRequestController";

type Recorder = ReturnType<typeof useRecorder>;

export class RecordingController {
  private attempt = 0;
  private readonly connection = useConnectionStore();
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();

  constructor(private readonly recorder: Recorder) {}

  async startPushToTalk(shouldContinue: () => boolean = () => true) {
    const attempt = ++this.attempt;
    const prepared = await this.recorder.prepareRecording();
    if (!prepared || attempt !== this.attempt || !shouldContinue()) {
      await this.recorder.cancelRecording();
      return false;
    }
    if (this.settings.state.autoInjection[this.settings.state.selectedMode]) {
      await voiceRequestController.textOutput.prepareTarget();
    }
    try {
      await voiceRequestController.startRequest();
    } catch {
      await this.recorder.cancelRecording();
      return false;
    }
    if (attempt !== this.attempt || !shouldContinue()) {
      await this.recorder.cancelRecording();
      await voiceRequestController.cancelCurrentRequest("user_cancelled");
      return false;
    }
    const maxDurationMs = Math.min(
      60_000,
      this.connection.state.serverHello?.limits.max_recording_ms ?? 60_000,
    );
    const started = await this.recorder.startRecording({
      maxDurationMs,
      onAutoStop: () => void this.stopPushToTalk(),
      onFrame: (frame, sequence) => {
        voiceRequestController.sendAudioFrame(frame, sequence);
      },
    });
    if (started) voiceRequestController.markRecording();
    else await voiceRequestController.cancelCurrentRequest("user_cancelled");
    return started;
  }

  async stopPushToTalk() {
    const result = await this.recorder.stopRecording();
    if (!result) {
      await voiceRequestController.cancelCurrentRequest("user_cancelled");
      return;
    }
    try {
      await voiceRequestController.commitInput(result);
    } catch {
      // Controller: 请求错误已经写入 requestStore。
    }
  }

  async cancelCurrentRequest() {
    this.attempt += 1;
    await this.recorder.cancelRecording();
    await voiceRequestController.cancelCurrentRequest("user_cancelled");
  }

  async interruptPlayback() {
    await voiceRequestController.interruptPlayback();
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

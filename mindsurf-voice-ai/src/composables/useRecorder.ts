import { computed, onBeforeUnmount, ref } from "vue";

import { MicrophoneRecorder, type RecordingResult } from "../services/recorder";
import { openMicrophonePermissionSettings } from "../services/permissions";

export type MicrophonePermissionState =
  "unknown" | "prompt" | "granted" | "denied" | "unsupported";

export type RecorderState =
  "idle" | "requesting" | "recording" | "stopping" | "ready" | "error";

export interface StartRecordingOptions {
  onAutoStop?: () => void;
  onFrame?: (frame: Int16Array, sequence: number) => void;
}

const recorder = new MicrophoneRecorder();
const MAX_RECORDING_MS = 60_000;

export function useRecorder() {
  const activeTrackCount = ref(0);
  const completedRecordingCount = ref(0);
  const durationMs = ref(0);
  const errorMessage = ref("");
  const latestRecording = ref<RecordingResult | null>(null);
  const level = ref(0);
  const permissionState = ref<MicrophonePermissionState>("unknown");
  const state = ref<RecorderState>("idle");
  let operationId = 0;

  const isBusy = computed(
    () =>
      state.value === "requesting" ||
      state.value === "recording" ||
      state.value === "stopping",
  );
  const isRecording = computed(() => state.value === "recording");

  async function refreshPermissionState() {
    if (!navigator.mediaDevices?.getUserMedia) {
      permissionState.value = "unsupported";
      return;
    }

    if (!navigator.permissions?.query) {
      permissionState.value = "prompt";
      return;
    }

    try {
      const result = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      permissionState.value = result.state;
    } catch {
      permissionState.value = "prompt";
    }
  }

  async function startRecording(options: StartRecordingOptions = {}) {
    if (isBusy.value) {
      return false;
    }

    errorMessage.value = "";
    durationMs.value = 0;
    level.value = 0;
    state.value = "requesting";
    const currentOperationId = ++operationId;

    try {
      await recorder.start({
        onDuration: (value) => {
          durationMs.value = value;
          if (value >= MAX_RECORDING_MS && state.value === "recording") {
            if (options.onAutoStop) {
              options.onAutoStop();
            } else {
              void stopRecording();
            }
          }
        },
        onLevel: (value) => {
          level.value = value;
        },
        onFrame: options.onFrame,
      });
      if (currentOperationId !== operationId) {
        await recorder.cancel();
        return false;
      }
      activeTrackCount.value = 1;
      permissionState.value = "granted";
      state.value = "recording";
      return true;
    } catch (error) {
      activeTrackCount.value = 0;
      errorMessage.value = describeRecorderError(error);
      permissionState.value =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "denied"
          : permissionState.value;
      state.value = "error";
      return false;
    }
  }

  async function stopRecording() {
    if (!isRecording.value) {
      return null;
    }

    state.value = "stopping";

    try {
      latestRecording.value = await recorder.stop();
      activeTrackCount.value = latestRecording.value.liveTracksAfterCleanup;
      completedRecordingCount.value += 1;
      durationMs.value = latestRecording.value.durationMs;
      level.value = 0;
      state.value = "ready";
      return latestRecording.value;
    } catch (error) {
      activeTrackCount.value = 0;
      errorMessage.value = describeRecorderError(error);
      state.value = "error";
      return null;
    }
  }

  async function cancelRecording() {
    operationId += 1;
    await recorder.cancel();
    activeTrackCount.value = 0;
    durationMs.value = 0;
    errorMessage.value = "";
    level.value = 0;
    state.value = "idle";
  }

  function downloadLatestRecording() {
    if (!latestRecording.value) {
      return;
    }

    const bytes = latestRecording.value.wavBytes.slice();
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: "audio/wav" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `mindsurf-recording-${new Date()
      .toISOString()
      .replace(/:/g, "-")}.wav`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function openPermissionSettings() {
    const result = await openMicrophonePermissionSettings();
    if (!result.ok) {
      errorMessage.value = result.error.message;
    }
  }

  onBeforeUnmount(() => {
    operationId += 1;
    void recorder.cancel();
  });

  return {
    activeTrackCount,
    cancelRecording,
    completedRecordingCount,
    downloadLatestRecording,
    durationMs,
    errorMessage,
    isBusy,
    isRecording,
    latestRecording,
    level,
    openPermissionSettings,
    permissionState,
    refreshPermissionState,
    startRecording,
    state,
    stopRecording,
  };
}

function describeRecorderError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      return "麦克风权限被拒绝，请在系统设置中允许访问后重试。";
    }
    if (error.name === "NotFoundError") {
      return "没有找到可用的麦克风设备。";
    }
    if (error.name === "NotReadableError") {
      return "麦克风正被其他应用占用，或设备暂时不可用。";
    }
  }

  if (error instanceof Error && error.message === "media_devices_unavailable") {
    return "当前运行环境不支持麦克风采集。";
  }

  return "录音初始化失败，请检查麦克风和系统权限后重试。";
}

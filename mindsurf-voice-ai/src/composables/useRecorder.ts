import { isTauri } from "@tauri-apps/api/core";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import {
  describeRecorderError,
  MicrophoneRecorder,
  type RecordingResult,
} from "../services/recorder";
import { NativeMicrophoneRecorder } from "../services/nativeRecorder";
import {
  getSystemPermissionStatus,
  openMicrophonePermissionSettings,
} from "../services/permissions";

export type MicrophonePermissionState =
  "unknown" | "prompt" | "granted" | "denied" | "unsupported";

export type RecorderState =
  "idle" | "requesting" | "prepared" | "recording" | "stopping" | "ready" | "error";

export interface StartRecordingOptions {
  maxDurationMs?: number;
  onAutoStop?: () => void;
  onFrame?: (frame: Int16Array, sequence: number) => void;
}

const isMacOSClient =
  isTauri() && /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? "");
const nativeRecorder = new NativeMicrophoneRecorder();
const browserRecorder = new MicrophoneRecorder();
let recorder: NativeMicrophoneRecorder | MicrophoneRecorder = isMacOSClient
  ? nativeRecorder
  : browserRecorder;
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
  let preparedDeviceId: string | null = null;
  let recordingUsesNative = isMacOSClient;

  const isBusy = computed(
    () =>
      state.value === "requesting" ||
      state.value === "prepared" ||
      state.value === "recording" ||
      state.value === "stopping",
  );
  const isRecording = computed(() => state.value === "recording");

  async function refreshPermissionState() {
    if (recordingUsesNative) {
      const nativeStatus = await getSystemPermissionStatus("microphone");
      if (!nativeStatus.ok) {
        permissionState.value = "unknown";
        return;
      }
      permissionState.value =
        nativeStatus.data.status === "granted"
          ? "granted"
          : ["denied", "restricted"].includes(nativeStatus.data.status)
            ? "denied"
            : nativeStatus.data.status === "not_determined"
              ? "prompt"
              : "unknown";
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      permissionState.value = "unsupported";
      return;
    }

    const nativeStatus = await getSystemPermissionStatus("microphone");
    if (nativeStatus.ok) {
      if (["denied", "restricted"].includes(nativeStatus.data.status)) {
        permissionState.value = "denied";
        return;
      }
      if (nativeStatus.data.status === "not_determined") {
        permissionState.value = "prompt";
        return;
      }
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
    if (state.value !== "prepared" && !(await prepareRecording())) {
      return false;
    }

    errorMessage.value = "";
    durationMs.value = 0;
    level.value = 0;
    const currentOperationId = operationId;

    try {
      await recorder.start({
        onDuration: (value) => {
          durationMs.value = value;
          const maxDurationMs = Math.min(
            MAX_RECORDING_MS,
            options.maxDurationMs ?? MAX_RECORDING_MS,
          );
          if (value >= maxDurationMs && state.value === "recording") {
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
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        const nativeStatus = await getSystemPermissionStatus("microphone");
        const nativePermissionGranted =
          nativeStatus.ok && nativeStatus.data.status === "granted";
        errorMessage.value = describeRecorderError(error, {
          nativePermissionGranted,
        });
        permissionState.value = "denied";
      } else {
        errorMessage.value = describeRecorderError(error);
      }
      state.value = "error";
      return false;
    }
  }

  async function prepareRecording(inputDeviceId: string | null = null) {
    if (state.value === "prepared" && preparedDeviceId === inputDeviceId) {
      return true;
    }
    if (state.value === "prepared") {
      await recorder.cancel();
      preparedDeviceId = null;
      state.value = "idle";
    }
    if (isBusy.value) {
      return false;
    }

    errorMessage.value = "";
    durationMs.value = 0;
    level.value = 0;
    state.value = "requesting";
    const currentOperationId = ++operationId;

    try {
      const shouldUseNative =
        isMacOSClient && (!inputDeviceId || inputDeviceId === "default");
      const nextRecorder = shouldUseNative ? nativeRecorder : browserRecorder;
      if (recorder !== nextRecorder) {
        await recorder.cancel();
        recorder = nextRecorder;
      }
      recordingUsesNative = shouldUseNative;
      await recorder.prepare(inputDeviceId);
      preparedDeviceId = inputDeviceId;
      if (recordingUsesNative) {
        await refreshPermissionState();
      }
      if (currentOperationId !== operationId) {
        await recorder.cancel();
        return false;
      }
      if (recordingUsesNative && permissionState.value !== "granted") {
        await recorder.cancel();
        activeTrackCount.value = 0;
        errorMessage.value =
          permissionState.value === "denied"
            ? "麦克风权限未授权，请在系统设置中允许访问后重试。"
            : "请先在权限页面完成麦克风授权。";
        state.value = "error";
        return false;
      }
      activeTrackCount.value = recordingUsesNative ? 0 : 1;
      if (!recordingUsesNative) {
        permissionState.value = "granted";
      }
      state.value = "prepared";
      return true;
    } catch (error) {
      activeTrackCount.value = 0;
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        const nativeStatus = await getSystemPermissionStatus("microphone");
        const nativePermissionGranted =
          nativeStatus.ok && nativeStatus.data.status === "granted";
        errorMessage.value = describeRecorderError(error, {
          nativePermissionGranted,
        });
        permissionState.value = "denied";
      } else {
        errorMessage.value = describeRecorderError(error);
      }
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
      preparedDeviceId = null;
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
    preparedDeviceId = null;
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

  function handleWindowFocus() {
    void refreshPermissionState();
  }

  onMounted(() => {
    globalThis.addEventListener("focus", handleWindowFocus);
  });

  onBeforeUnmount(() => {
    globalThis.removeEventListener("focus", handleWindowFocus);
    operationId += 1;
    void Promise.all([nativeRecorder.dispose(), browserRecorder.dispose()]);
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
    prepareRecording,
    refreshPermissionState,
    startRecording,
    state,
    stopRecording,
  };
}

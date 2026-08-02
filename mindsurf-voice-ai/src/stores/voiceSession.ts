import { hideOverlayWindow, setOverlayWindowPosition } from "../services/overlay";
import {
  getRecordShortcutStatus,
  registerRecordShortcut,
  unregisterRecordShortcut,
} from "../services/shortcuts";
import { syncTrayMode } from "../services/tray";
import type { VoiceClientIdentity } from "../services/transport/voiceTransport";
import type { RecordingResult } from "../services/recorder";
import { voiceRequestController } from "../controllers/voiceRequestController";
import { isTerminalRequestState } from "../controllers/requestStateMachine";
import type { CancelReason } from "../types/request";
import type { ShortcutBinding } from "../types/shortcut";
import type {
  OverlayPosition,
  VoiceInteractionMode,
  VoiceSessionState,
} from "../types/voice";
import { useConnectionStore } from "./connectionStore";
import { useRequestStore } from "./requestStore";
import {
  settingsStoreActions,
  type InferenceOptionKind,
  useSettingsStore,
} from "./settingsStore";

const connection = useConnectionStore();
const request = useRequestStore();
const settings = useSettingsStore();

// Compatibility: 旧组件通过只读聚合视图访问拆分后的状态域。
const state = new Proxy({} as VoiceSessionState, {
  get(_target, property: keyof VoiceSessionState) {
    const key = property as string;
    if (key === "connectionStatus") return connection.state.status;
    if (key === "requestStatus") return request.state.status;
    if (key === "lastError") {
      return request.state.lastError || connection.state.lastError;
    }
    if (key in connection.state) {
      return connection.state[key as keyof typeof connection.state];
    }
    if (key in request.state) return request.state[key as keyof typeof request.state];
    return settings.state[key as keyof typeof settings.state];
  },
});

export function useVoiceSessionStore() {
  function setInferenceOption(kind: InferenceOptionKind, id: string) {
    const hello = connection.state.serverHello;
    if (!hello || !hello.inference_options[kind].some((option) => option.id === id)) {
      return;
    }
    settingsStoreActions.setInferenceOption(kind, id);
  }

  function setMode(mode: VoiceInteractionMode) {
    if (!(["dictation", "assistant", "mixed"] as const).includes(mode)) return false;
    if (
      request.state.activeRequestId ||
      (request.state.status !== "idle" && !isTerminalRequestState(request.state.status))
    ) {
      return false;
    }
    settingsStoreActions.setMode(mode);
    void syncTrayMode(mode);
    return true;
  }

  function setAutoInjection(mode: VoiceInteractionMode, enabled: boolean) {
    settingsStoreActions.setAutoInjection(mode, enabled);
  }

  function setInjectionMaxCodePoints(value: number) {
    const normalized = Math.trunc(value);
    if (!Number.isFinite(normalized) || normalized < 1 || normalized > 8_000) return;
    settingsStoreActions.setInjectionMaxCodePoints(normalized);
  }

  function setOverlayPosition(position: OverlayPosition) {
    if (!(["left", "center", "right"] as const).includes(position)) return;
    settingsStoreActions.setOverlayPosition(position);
    void setOverlayWindowPosition(position);
  }

  function setOverlayEnabled(enabled: boolean) {
    settingsStoreActions.setOverlayEnabled(enabled);
    if (!enabled) void hideOverlayWindow();
  }

  async function initializeRecordShortcut() {
    if (!settings.state.shortcutDesiredEnabled) {
      const result = await unregisterRecordShortcut();
      if (result.ok) settingsStoreActions.applyShortcutStatus(result.data);
      else
        settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
      return;
    }
    const result = await registerRecordShortcut(settings.state.shortcutBinding);
    if (result.ok) {
      settingsStoreActions.applyShortcutStatus(result.data);
      setTimeout(() => void refreshShortcutStatus(), 250);
      return;
    }
    const message = describeShortcutError(result.error.code);
    const disabled = await unregisterRecordShortcut();
    if (disabled.ok) settingsStoreActions.applyShortcutStatus(disabled.data);
    settingsStoreActions.setShortcutError(message);
  }

  async function configureRecordShortcut(binding: ShortcutBinding) {
    settingsStoreActions.setShortcutError("");
    if (!settings.state.shortcutDesiredEnabled) {
      settingsStoreActions.setShortcutBinding(binding);
      return true;
    }
    const result = await registerRecordShortcut(binding);
    if (!result.ok) {
      settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
      return false;
    }
    settingsStoreActions.applyShortcutStatus(result.data);
    settingsStoreActions.setShortcutBinding(binding);
    return true;
  }

  async function setRecordShortcutEnabled(enabled: boolean) {
    settingsStoreActions.setShortcutError("");
    settingsStoreActions.setShortcutDesiredEnabled(enabled);
    const result = enabled
      ? await registerRecordShortcut(settings.state.shortcutBinding)
      : await unregisterRecordShortcut();
    if (result.ok) settingsStoreActions.applyShortcutStatus(result.data);
    else
      settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
  }

  async function refreshShortcutStatus() {
    const result = await getRecordShortcutStatus();
    if (result.ok) settingsStoreActions.applyShortcutStatus(result.data);
    else
      settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
  }

  return {
    beginRequest: () => voiceRequestController.startRequest(),
    cancelActiveRequest: (reason: CancelReason = "user_cancelled") =>
      voiceRequestController.cancelCurrentRequest(reason),
    commitInput: (result: RecordingResult) =>
      voiceRequestController.commitInput(result),
    configureRecordShortcut,
    connect: (identity: VoiceClientIdentity) =>
      voiceRequestController.connect(identity),
    connectionLabel: connection.connectionLabel,
    disconnect: () => voiceRequestController.disconnect(),
    dismissInjectionResult: () => voiceRequestController.textOutput.dismiss(),
    initializeRecordShortcut,
    injectText: (text: string, delayMs = 0) =>
      voiceRequestController.textOutput.output(text, delayMs),
    interruptPlayback: () => voiceRequestController.interruptPlayback(),
    markRecording: () => voiceRequestController.markRecording(),
    noteShortcutEvent: settingsStoreActions.noteShortcutEvent,
    retryConnection: voiceRequestController.retryConnection,
    retryInjection: (delayMs = 1_500) =>
      voiceRequestController.textOutput.retry(delayMs),
    sendAudioFrame: (frame: Int16Array, sequence: number) =>
      voiceRequestController.sendAudioFrame(frame, sequence),
    setAutoInjection,
    setInferenceOption,
    setInjectionMaxCodePoints,
    setMode,
    setOverlayEnabled,
    setOverlayPosition,
    setRecordShortcutEnabled,
    state,
  };
}

function describeShortcutError(code: string) {
  const messages: Record<string, string> = {
    accessibility_required: "请先在系统设置中授予辅助功能权限",
    shortcut_conflict: "该快捷键已被系统或其他程序占用，请选择其他组合",
    shortcut_listener_unavailable: "系统全局快捷键监听器不可用",
    shortcut_state_unavailable: "快捷键状态暂时不可用，请重试",
    unsupported_platform: "当前平台不支持全局快捷键",
  };
  return messages[code] ?? "快捷键配置失败，请选择其他组合";
}

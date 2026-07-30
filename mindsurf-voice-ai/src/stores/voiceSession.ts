import { computed, reactive, readonly } from "vue";

import { StreamingAudioPlayer } from "../audio/streamingPlayer";
import {
  validateAssistantTextDelta,
  validateAssistantTextDone,
  validateOutputAudioDone,
  validateOutputAudioStart,
} from "../services/protocol";
import type { RecordingResult } from "../services/recorder";
import {
  getRecordShortcutStatus,
  registerRecordShortcut,
  unregisterRecordShortcut,
} from "../services/shortcuts";
import { injectTextIntoForegroundWindow } from "../services/textInjection";
import { syncTrayMode } from "../services/tray";
import { hideOverlayWindow, setOverlayWindowPosition } from "../services/overlay";
import {
  VoiceTransportError,
  VoiceWebSocketClient,
  type VoiceClientIdentity,
} from "../services/voiceWebSocket";
import type {
  AsrFinalPayload,
  AsrPartialPayload,
  ControlEnvelope,
  OutputAudioDonePayload,
  OutputAudioStartPayload,
  ProtocolErrorPayload,
  ServerHelloPayload,
} from "../types/protocol";
import type { ShortcutBinding, ShortcutStatus } from "../types/shortcut";
import {
  CONNECTION_STATUS_LABELS,
  type OverlayPosition,
  type VoiceInteractionMode,
  type VoiceSessionState,
} from "../types/voice";

export const DEFAULT_SERVICE_URL =
  import.meta.env.VITE_VOICE_SERVICE_URL ?? "ws://127.0.0.1:8000/v1/voice/ws";

const ASR_FINAL_TIMEOUT_MS = 10_000;
const LLM_FIRST_TOKEN_TIMEOUT_MS = 15_000;
const MODE_STORAGE_KEY = "mindsurf.voice.mode";
const INJECTION_LIMIT_STORAGE_KEY = "mindsurf.injection.maxCodePoints";
const SHORTCUT_STORAGE_KEY = "mindsurf.shortcut.record";
const OVERLAY_ENABLED_STORAGE_KEY = "mindsurf.overlay.enabled";
const OVERLAY_POSITION_STORAGE_KEY = "mindsurf.overlay.position";
const AUTO_INJECTION_STORAGE_KEYS: Record<VoiceInteractionMode, string> = {
  dictation: "mindsurf.injection.auto.dictation",
  assistant: "mindsurf.injection.auto.assistant",
  mixed: "mindsurf.injection.auto.mixed",
};
const OPTION_STORAGE_KEYS = {
  asr: "mindsurf.inference.asr",
  llm: "mindsurf.inference.llm",
  tts: "mindsurf.inference.tts",
  output_audio: "mindsurf.inference.output_audio",
} as const;

type InferenceOptionKind = keyof typeof OPTION_STORAGE_KEYS;

const state = reactive<VoiceSessionState>({
  activeRequestId: null,
  autoInjection: readAutoInjectionPreferences(),
  assistantFinal: "",
  assistantLastSequence: -1,
  assistantStreaming: "",
  assistantWarning: "",
  asrFinal: "",
  asrLanguage: "",
  asrPartial: "",
  asrRevision: -1,
  connectionStatus: "disconnected",
  injectionError: "",
  injectionMaxCodePoints: readInjectionLimit(),
  injectionRemainingText: "",
  injectionReport: null,
  injectionStatus: "idle",
  lastError: "",
  networkCongested: false,
  overlayEnabled: readStoredBoolean(OVERLAY_ENABLED_STORAGE_KEY, true),
  overlayPosition: readOverlayPosition(),
  playbackError: "",
  playbackMetrics: {
    firstChunkAt: null,
    playbackStartedAt: null,
    playbackCompletedAt: null,
    receivedChunks: 0,
    receivedSamples: 0,
    underrunCount: 0,
  },
  playbackStatus: "idle",
  reconnectAttempt: 0,
  requestStatus: "idle",
  shortcutBinding: readStoredShortcut(),
  shortcutDisplay: "录音快捷键",
  shortcutEnabled: true,
  shortcutError: "",
  shortcutLastEventAt: null,
  shortcutListenerStatus: "starting",
  selectedMode: readStoredMode(),
  selectedAsrId: "",
  selectedLlmId: "",
  selectedOutputAudioId: "",
  selectedTtsId: "",
  serverHello: null,
  serviceUrl: DEFAULT_SERVICE_URL,
});

let asrTimer: ReturnType<typeof setTimeout> | null = null;
let llmTimer: ReturnType<typeof setTimeout> | null = null;
let injectionTimer: ReturnType<typeof setTimeout> | null = null;
let injectionDelayResolve: (() => void) | null = null;
let injectionSequence = 0;
let client: VoiceWebSocketClient | null = null;
let focusListenerAttached = false;
const player = new StreamingAudioPlayer({
  onError: (message) => {
    state.playbackError = message;
    state.assistantWarning = message;
  },
  onMetrics: (metrics) => {
    state.playbackMetrics = metrics;
  },
  onStatusChange: (status) => {
    state.playbackStatus = status;
  },
});

export function useVoiceSessionStore() {
  const connectionLabel = computed(
    () => CONNECTION_STATUS_LABELS[state.connectionStatus],
  );

  function connect(identity: VoiceClientIdentity) {
    if (client) {
      client.connect();
      return;
    }

    client = new VoiceWebSocketClient(state.serviceUrl, identity, {
      onAudioFrame: (frame) => {
        if (frame.requestId === state.activeRequestId) {
          player.enqueue(frame);
        }
      },
      onControlMessage: handleControlMessage,
      onReconnectAttempt: (attempt) => {
        state.reconnectAttempt = attempt;
      },
      onServerHello: (payload) => {
        state.serverHello = payload;
        hydrateInferenceSelections(payload);
        state.lastError = "";
      },
      onStatusChange: (status) => {
        state.connectionStatus = status;
        if (status !== "connected" && state.activeRequestId) {
          player.stop("error");
          state.requestStatus = "failed";
          state.lastError = "连接已断开，当前录音请求无法恢复";
          state.activeRequestId = null;
          clearRequestTimers();
        }
      },
      onTransportError: (error) => {
        state.lastError = error.message;
      },
    });
    client.connect();

    if (!focusListenerAttached) {
      window.addEventListener("focus", retryConnection);
      focusListenerAttached = true;
    }
  }

  function disconnect() {
    player.dispose();
    client?.disconnect();
    client = null;
    clearAsrTimer();
    clearLlmTimer();
    injectionSequence += 1;
    clearInjectionTimer();
    if (focusListenerAttached) {
      window.removeEventListener("focus", retryConnection);
      focusListenerAttached = false;
    }
  }

  function retryConnection() {
    state.lastError = "";
    client?.retryNow();
  }

  async function beginRequest() {
    if (!client || state.connectionStatus !== "connected" || !state.serverHello) {
      throw new VoiceTransportError("connection_not_ready", "请先等待推理服务连接完成");
    }
    if (state.activeRequestId) {
      throw new VoiceTransportError("request_already_active", "已有录音请求正在进行");
    }

    resetTranscripts();
    player.stop("idle");
    state.lastError = "";
    state.requestStatus = "starting";
    const defaults = state.serverHello.inference_options.defaults;
    const protocolMode = state.selectedMode === "dictation" ? "dictation" : "assistant";
    let wantsAudio =
      protocolMode === "assistant" && state.serverHello.features.streaming_audio;
    if (wantsAudio && !player.prepare()) {
      wantsAudio = false;
    }
    if (protocolMode === "assistant" && !state.serverHello.features.streaming_text) {
      const error = new VoiceTransportError(
        "streaming_text_unsupported",
        "当前服务不支持助手文本流",
      );
      state.requestStatus = "failed";
      state.lastError = error.message;
      throw error;
    }

    try {
      const accepted = await client.startRequest({
        mode: protocolMode,
        language: "zh-CN",
        conversation_id: null,
        selection: {
          asr: state.selectedAsrId || defaults.asr,
          llm:
            protocolMode === "assistant" ? state.selectedLlmId || defaults.llm : null,
          tts: wantsAudio ? state.selectedTtsId || defaults.tts : null,
          output_audio: wantsAudio
            ? state.selectedOutputAudioId || defaults.output_audio
            : null,
        },
        input_audio: {
          encoding: "pcm_s16le",
          sample_rate: 16_000,
          channels: 1,
          frame_duration_ms: 20,
        },
        response: {
          text: protocolMode === "assistant",
          audio: wantsAudio,
          voice: "default",
        },
      });
      state.activeRequestId = accepted.requestId;
      state.requestStatus = "accepted";
      return accepted.requestId;
    } catch (error) {
      state.requestStatus = "failed";
      state.lastError = describeTransportError(error);
      throw error;
    }
  }

  function markRecording() {
    if (state.activeRequestId) {
      state.requestStatus = "recording";
    }
  }

  function sendAudioFrame(frame: Int16Array, sequence: number) {
    if (!client || !state.activeRequestId) {
      return false;
    }

    try {
      state.networkCongested = client.sendInputAudio(
        state.activeRequestId,
        sequence,
        sequence * 20_000,
        frame,
      );
      return true;
    } catch (error) {
      state.networkCongested = false;
      state.requestStatus = "failed";
      state.lastError = describeTransportError(error);
      const requestId = state.activeRequestId;
      void client.cancelRequest(requestId, "audio_backpressure").finally(() => {
        if (state.activeRequestId === requestId) {
          state.activeRequestId = null;
        }
      });
      return false;
    }
  }

  async function commitInput(result: RecordingResult) {
    if (!client || !state.activeRequestId) {
      throw new VoiceTransportError("request_not_found", "没有可以提交的录音请求");
    }

    const requestId = state.activeRequestId;
    state.requestStatus = "committing";
    state.networkCongested = false;

    try {
      await client.commitInput(requestId, {
        last_sequence: result.frameCount > 0 ? result.frameCount - 1 : null,
        frame_count: result.frameCount,
        sample_count: result.sampleCount,
        duration_ms: Math.round(result.durationMs),
      });

      if (!state.asrFinal && state.activeRequestId === requestId) {
        state.requestStatus = "recognizing";
        startAsrTimer(requestId);
      }
    } catch (error) {
      state.requestStatus = "failed";
      state.lastError = describeTransportError(error);
      await cancelActiveRequest("client_timeout");
      throw error;
    }
  }

  async function cancelActiveRequest(reason = "user_cancelled") {
    clearRequestTimers();
    player.stop("stopped");
    const requestId = state.activeRequestId;
    if (!client || !requestId) {
      state.requestStatus = "idle";
      return;
    }

    state.requestStatus = "cancelling";
    try {
      await client.cancelRequest(requestId, reason);
    } catch (error) {
      state.lastError = describeTransportError(error);
    } finally {
      if (state.activeRequestId === requestId) {
        state.activeRequestId = null;
        state.requestStatus = "idle";
      }
    }
  }

  async function interruptPlayback() {
    player.stop("stopped");
    if (state.activeRequestId) {
      await cancelActiveRequest("user_interrupted");
    }
  }

  function setInferenceOption(kind: InferenceOptionKind, id: string) {
    const hello = state.serverHello;
    if (!hello) {
      return;
    }

    const options = hello.inference_options[kind];
    if (!options.some((option) => option.id === id)) {
      return;
    }

    setSelectedOption(kind, id);
    localStorage.setItem(OPTION_STORAGE_KEYS[kind], id);
  }

  function setMode(mode: VoiceInteractionMode) {
    if (!["dictation", "assistant", "mixed"].includes(mode)) {
      return false;
    }
    if (state.activeRequestId) {
      return false;
    }
    state.selectedMode = mode;
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    void syncTrayMode(mode);
    return true;
  }

  function setAutoInjection(mode: VoiceInteractionMode, enabled: boolean) {
    state.autoInjection[mode] = enabled;
    localStorage.setItem(AUTO_INJECTION_STORAGE_KEYS[mode], String(enabled));
  }

  function setInjectionMaxCodePoints(value: number) {
    const normalized = Math.trunc(value);
    if (!Number.isFinite(normalized) || normalized < 1 || normalized > 8_000) {
      return;
    }
    state.injectionMaxCodePoints = normalized;
    localStorage.setItem(INJECTION_LIMIT_STORAGE_KEY, String(normalized));
  }

  function setOverlayPosition(position: OverlayPosition) {
    if (!["left", "center", "right"].includes(position)) {
      return;
    }
    state.overlayPosition = position;
    localStorage.setItem(OVERLAY_POSITION_STORAGE_KEY, position);
    void setOverlayWindowPosition(position);
  }

  function setOverlayEnabled(enabled: boolean) {
    state.overlayEnabled = enabled;
    localStorage.setItem(OVERLAY_ENABLED_STORAGE_KEY, String(enabled));
    if (!enabled) {
      void hideOverlayWindow();
    }
  }

  async function initializeRecordShortcut() {
    const result = await registerRecordShortcut(state.shortcutBinding);
    if (result.ok) {
      applyShortcutStatus(result.data);
      setTimeout(() => {
        void refreshShortcutStatus();
      }, 250);
      return;
    }

    state.shortcutEnabled = false;
    const shortcutError = describeShortcutError(result.error.code);
    const disabled = await unregisterRecordShortcut();
    if (disabled.ok) {
      applyShortcutStatus(disabled.data);
    }
    state.shortcutError = shortcutError;
  }

  async function configureRecordShortcut(binding: ShortcutBinding) {
    state.shortcutError = "";
    const result = await registerRecordShortcut(binding);
    if (!result.ok) {
      state.shortcutError = describeShortcutError(result.error.code);
      return false;
    }
    applyShortcutStatus(result.data);
    localStorage.setItem(SHORTCUT_STORAGE_KEY, binding);
    return true;
  }

  async function setRecordShortcutEnabled(enabled: boolean) {
    state.shortcutError = "";
    const result = enabled
      ? await registerRecordShortcut(state.shortcutBinding)
      : await unregisterRecordShortcut();
    if (!result.ok) {
      state.shortcutError = describeShortcutError(result.error.code);
      return;
    }
    applyShortcutStatus(result.data);
  }

  function noteShortcutEvent(timestampMs: number) {
    state.shortcutLastEventAt = timestampMs;
    state.shortcutError = "";
  }

  return {
    beginRequest,
    cancelActiveRequest,
    commitInput,
    connect,
    connectionLabel,
    disconnect,
    markRecording,
    retryConnection,
    dismissInjectionResult,
    injectText: requestTextInjection,
    initializeRecordShortcut,
    interruptPlayback,
    configureRecordShortcut,
    noteShortcutEvent,
    retryInjection,
    sendAudioFrame,
    setInferenceOption,
    setAutoInjection,
    setInjectionMaxCodePoints,
    setMode,
    setOverlayEnabled,
    setOverlayPosition,
    setRecordShortcutEnabled,
    state: readonly(state),
  };
}

function handleControlMessage(message: ControlEnvelope<unknown>) {
  if (message.request_id && message.request_id !== state.activeRequestId) {
    return;
  }

  switch (message.type) {
    case "asr.partial": {
      const payload = message.payload as AsrPartialPayload;
      if (
        typeof payload.text === "string" &&
        Number.isInteger(payload.revision) &&
        payload.revision > state.asrRevision
      ) {
        state.asrPartial = payload.text;
        state.asrRevision = payload.revision;
      }
      break;
    }
    case "asr.final": {
      const payload = message.payload as AsrFinalPayload;
      if (typeof payload.text === "string") {
        clearAsrTimer();
        state.asrFinal = payload.text;
        state.asrPartial = "";
        state.asrLanguage = payload.language;
        if (state.selectedMode !== "dictation") {
          state.requestStatus = "thinking";
          startLlmTimer(message.request_id);
        } else if (state.autoInjection.dictation) {
          void requestTextInjection(payload.text);
        }
      }
      break;
    }
    case "assistant.text.delta": {
      const expectedSequence = state.assistantLastSequence + 1;
      try {
        const payload = validateAssistantTextDelta(message.payload, expectedSequence);
        clearLlmTimer();
        state.assistantStreaming += payload.delta;
        state.assistantLastSequence = payload.sequence;
        state.requestStatus = "responding";
      } catch {
        failAssistantStream(`回复文本分片序号异常：期望 ${expectedSequence}`);
      }
      break;
    }
    case "assistant.text.done": {
      clearLlmTimer();
      try {
        const payload = validateAssistantTextDone(
          message.payload,
          state.assistantLastSequence,
        );
        if (payload.text !== state.assistantStreaming) {
          state.assistantWarning = "流式文本与最终文本不一致，已采用最终结果";
        }
        state.assistantFinal = payload.text;
        state.assistantStreaming = payload.text;
        if (
          state.selectedMode !== "dictation" &&
          state.autoInjection[state.selectedMode]
        ) {
          void requestTextInjection(payload.text);
        }
      } catch {
        failAssistantStream("回复文本结束消息与已接收分片不一致");
      }
      break;
    }
    case "output.audio.start": {
      try {
        const payload = validateOutputAudioStart(
          message.payload,
        ) as OutputAudioStartPayload;
        if (!message.request_id) {
          throw new Error("output audio request ID is missing");
        }
        state.playbackError = "";
        player.start(message.request_id, payload);
      } catch {
        state.playbackError = "服务端返回了不受支持的语音格式";
        state.assistantWarning = state.playbackError;
        if (state.activeRequestId) {
          void client?.cancelRequest(state.activeRequestId, "protocol_error");
        }
      }
      break;
    }
    case "output.audio.done": {
      try {
        const payload = validateOutputAudioDone(
          message.payload,
        ) as OutputAudioDonePayload;
        player.finish(payload);
      } catch {
        state.playbackError = "语音分片统计不一致，已停止播放";
        state.assistantWarning = state.playbackError;
        player.stop("error");
      }
      break;
    }
    case "request.done": {
      clearRequestTimers();
      if (state.selectedMode !== "dictation" && !state.assistantFinal) {
        state.lastError = "请求提前结束，未收到完整的助手回复";
        state.requestStatus = "failed";
        state.activeRequestId = null;
        break;
      }
      state.requestStatus = "done";
      state.activeRequestId = null;
      break;
    }
    case "request.cancelled":
      clearRequestTimers();
      player.stop("stopped");
      state.requestStatus = "idle";
      state.activeRequestId = null;
      break;
    case "error": {
      const payload = message.payload as ProtocolErrorPayload;
      if (payload.stage === "tts" && !payload.fatal) {
        state.playbackError = payload.message || payload.code;
        state.assistantWarning = `语音播放不可用：${state.playbackError}`;
        player.stop("error");
        break;
      }
      state.lastError = payload.message || payload.code;
      if (payload.fatal && message.request_id) {
        clearRequestTimers();
        player.stop("error");
        state.requestStatus = "failed";
        state.activeRequestId = null;
      }
      break;
    }
  }
}

function resetTranscripts() {
  clearRequestTimers();
  state.assistantFinal = "";
  state.assistantLastSequence = -1;
  state.assistantStreaming = "";
  state.assistantWarning = "";
  state.asrFinal = "";
  state.asrLanguage = "";
  state.asrPartial = "";
  state.asrRevision = -1;
  state.networkCongested = false;
  state.playbackError = "";
  state.playbackMetrics = {
    firstChunkAt: null,
    playbackStartedAt: null,
    playbackCompletedAt: null,
    receivedChunks: 0,
    receivedSamples: 0,
    underrunCount: 0,
  };
  state.playbackStatus = "idle";
}

function readStoredMode(): VoiceInteractionMode {
  if (typeof localStorage === "undefined") {
    return "dictation";
  }
  const stored = localStorage.getItem(MODE_STORAGE_KEY);
  return stored === "assistant" || stored === "mixed" ? stored : "dictation";
}

function readOverlayPosition(): OverlayPosition {
  if (typeof localStorage === "undefined") {
    return "center";
  }
  const stored = localStorage.getItem(OVERLAY_POSITION_STORAGE_KEY);
  return stored === "left" || stored === "right" ? stored : "center";
}

function readAutoInjectionPreferences(): Record<VoiceInteractionMode, boolean> {
  return {
    dictation: readStoredBoolean(AUTO_INJECTION_STORAGE_KEYS.dictation, true),
    assistant: readStoredBoolean(AUTO_INJECTION_STORAGE_KEYS.assistant, false),
    mixed: readStoredBoolean(AUTO_INJECTION_STORAGE_KEYS.mixed, false),
  };
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof localStorage === "undefined") {
    return fallback;
  }
  const value = localStorage.getItem(key);
  return value === null ? fallback : value === "true";
}

function readInjectionLimit() {
  if (typeof localStorage === "undefined") {
    return 8_000;
  }
  const value = Number(localStorage.getItem(INJECTION_LIMIT_STORAGE_KEY));
  return Number.isInteger(value) && value >= 1 && value <= 8_000 ? value : 8_000;
}

function readStoredShortcut(): ShortcutBinding {
  if (typeof localStorage === "undefined") {
    return "ctrl_win";
  }
  const stored = localStorage.getItem(SHORTCUT_STORAGE_KEY);
  return stored === "ctrl_alt_space" ||
    stored === "ctrl_shift_space" ||
    stored === "ctrl_win_space"
    ? stored
    : "ctrl_win";
}

function hydrateInferenceSelections(payload: ServerHelloPayload) {
  for (const kind of Object.keys(OPTION_STORAGE_KEYS) as InferenceOptionKind[]) {
    const options = payload.inference_options[kind];
    const saved = localStorage.getItem(OPTION_STORAGE_KEYS[kind]);
    const selected =
      saved && options.some((option) => option.id === saved)
        ? saved
        : payload.inference_options.defaults[kind];
    setSelectedOption(kind, selected);
  }
}

function setSelectedOption(kind: InferenceOptionKind, id: string) {
  if (kind === "asr") {
    state.selectedAsrId = id;
  } else if (kind === "llm") {
    state.selectedLlmId = id;
  } else if (kind === "tts") {
    state.selectedTtsId = id;
  } else {
    state.selectedOutputAudioId = id;
  }
}

function startAsrTimer(requestId: string) {
  clearAsrTimer();
  asrTimer = setTimeout(() => {
    if (state.activeRequestId !== requestId || state.asrFinal) {
      return;
    }
    state.lastError = "等待最终识别结果超时";
    state.requestStatus = "failed";
    void client?.cancelRequest(requestId, "client_timeout");
  }, ASR_FINAL_TIMEOUT_MS);
}

function clearAsrTimer() {
  if (asrTimer) {
    clearTimeout(asrTimer);
    asrTimer = null;
  }
}

function startLlmTimer(requestId: string | null) {
  clearLlmTimer();
  if (!requestId) {
    return;
  }
  llmTimer = setTimeout(() => {
    if (state.activeRequestId !== requestId || state.assistantLastSequence >= 0) {
      return;
    }
    state.lastError = "等待助手回复首个文本分片超时";
    state.requestStatus = "failed";
    void client?.cancelRequest(requestId, "client_timeout");
  }, LLM_FIRST_TOKEN_TIMEOUT_MS);
}

function clearLlmTimer() {
  if (llmTimer) {
    clearTimeout(llmTimer);
    llmTimer = null;
  }
}

function clearRequestTimers() {
  clearAsrTimer();
  clearLlmTimer();
}

async function requestTextInjection(text: string, delayMs = 0) {
  if (!text) {
    return;
  }
  if (state.injectionStatus === "waiting" || state.injectionStatus === "injecting") {
    state.injectionError = "已有文本正在等待注入";
    return;
  }
  if (
    state.injectionRemainingText &&
    state.injectionRemainingText !== text &&
    ["partial", "failed"].includes(state.injectionStatus)
  ) {
    state.injectionError = "上次文本仍待处理，请先重试或放弃后再注入新文本";
    return;
  }

  state.injectionError = "";
  state.injectionRemainingText = text;
  state.injectionReport = null;
  const sequence = ++injectionSequence;

  if (delayMs > 0) {
    state.injectionStatus = "waiting";
    await new Promise<void>((resolve) => {
      injectionDelayResolve = resolve;
      injectionTimer = setTimeout(() => {
        injectionTimer = null;
        injectionDelayResolve = null;
        resolve();
      }, delayMs);
    });
    if (sequence !== injectionSequence) {
      return;
    }
  }

  state.injectionStatus = "injecting";
  const result = await injectTextIntoForegroundWindow(
    text,
    state.injectionMaxCodePoints,
  );
  if (!result.ok) {
    state.injectionStatus = "failed";
    state.injectionError = describeInjectionError(result.error.code);
    return;
  }

  state.injectionReport = result.data;
  state.injectionRemainingText = result.data.remainingText;
  if (result.data.complete) {
    state.injectionStatus = "succeeded";
    state.injectionError = "";
  } else {
    state.injectionStatus = "partial";
    state.injectionError = describeInjectionError(
      result.data.errorCode ?? "injection_partial",
    );
  }
}

async function retryInjection(delayMs = 1_500) {
  const remaining = state.injectionRemainingText;
  if (!remaining) {
    return;
  }
  state.injectionStatus = "idle";
  await requestTextInjection(remaining, delayMs);
}

function dismissInjectionResult() {
  injectionSequence += 1;
  clearInjectionTimer();
  state.injectionStatus = "idle";
  state.injectionError = "";
  state.injectionRemainingText = "";
  state.injectionReport = null;
}

function clearInjectionTimer() {
  if (injectionTimer) {
    clearTimeout(injectionTimer);
    injectionTimer = null;
  }
  injectionDelayResolve?.();
  injectionDelayResolve = null;
}

function describeInjectionError(code: string) {
  const messages: Record<string, string> = {
    empty_injection_text: "没有可以注入的文本",
    accessibility_required: "请先在系统设置中授予辅助功能权限",
    injection_blocked: "系统阻止了文本注入，目标应用可能不支持模拟输入",
    injection_modifiers_pressed: "录音快捷键尚未完全释放，请稍后重试",
    injection_partial: "仅注入了部分文本，剩余内容已保留",
    injection_target_closed: "目标窗口已关闭，剩余内容已保留",
    injection_target_changed: "注入期间前台窗口发生变化，剩余内容已保留",
    injection_target_is_self: "请切换到其他应用的输入位置后重试",
    injection_target_unavailable: "没有可用的前台目标窗口",
    injection_text_too_long: "文本超过当前注入长度限制",
    invalid_injection_limit: "注入长度限制无效",
    text_injection_unavailable: "系统文本注入功能当前不可用",
    unsupported_platform: "当前平台不支持文本注入",
  };
  return messages[code] ?? "文本注入失败，内容已保留";
}

function applyShortcutStatus(status: ShortcutStatus) {
  state.shortcutBinding = status.binding;
  state.shortcutDisplay = status.display;
  state.shortcutEnabled = status.enabled;
  state.shortcutListenerStatus = status.listenerStatus;
  state.shortcutError =
    status.listenerStatus === "error" || status.lastError
      ? status.lastError || "系统全局键盘监听器启动失败"
      : "";
}

async function refreshShortcutStatus() {
  const result = await getRecordShortcutStatus();
  if (result.ok) {
    applyShortcutStatus(result.data);
  } else {
    state.shortcutError = describeShortcutError(result.error.code);
  }
}

function describeShortcutError(code: string) {
  const messages: Record<string, string> = {
    input_monitoring_required: "请先在系统设置中授予输入监控权限",
    shortcut_conflict: "该快捷键已被系统或其他程序占用，请选择其他组合",
    shortcut_listener_unavailable: "系统全局快捷键监听器不可用",
    shortcut_state_unavailable: "快捷键状态暂时不可用，请重试",
    unsupported_platform: "当前平台不支持全局快捷键",
  };
  return messages[code] ?? "快捷键配置失败，请选择其他组合";
}

function failAssistantStream(message: string) {
  clearLlmTimer();
  state.lastError = message;
  state.requestStatus = "failed";
  const requestId = state.activeRequestId;
  if (requestId) {
    void client?.cancelRequest(requestId, "protocol_error");
  }
}

function describeTransportError(error: unknown) {
  return error instanceof Error ? error.message : "语音服务请求失败";
}

import { reactive, readonly } from "vue";

import { settingsRepository } from "../services/settings/settingsRepository";
import type { ServerHelloPayload } from "../types/protocol";
import type { ShortcutBinding, ShortcutStatus } from "../types/shortcut";
import type { OverlayPosition, VoiceInteractionMode } from "../types/voice";

const KEYS = {
  mode: "mindsurf.voice.mode",
  injectionLimit: "mindsurf.injection.maxCodePoints",
  shortcut: "mindsurf.shortcut.record",
  shortcutEnabled: "mindsurf.shortcut.enabled",
  overlayEnabled: "mindsurf.overlay.enabled",
  overlayPosition: "mindsurf.overlay.position",
  autoInjection: {
    dictation: "mindsurf.injection.auto.dictation",
    assistant: "mindsurf.injection.auto.assistant",
    mixed: "mindsurf.injection.auto.mixed",
  },
  inference: {
    asr: "mindsurf.inference.asr",
    llm: "mindsurf.inference.llm",
    tts: "mindsurf.inference.tts",
    output_audio: "mindsurf.inference.output_audio",
  },
} as const;

export type InferenceOptionKind = keyof typeof KEYS.inference;

function readBoolean(key: string, fallback: boolean) {
  const value = settingsRepository.get(key);
  return value === null ? fallback : value === "true";
}

function readMode(): VoiceInteractionMode {
  const value = settingsRepository.get(KEYS.mode);
  return value === "assistant" || value === "mixed" ? value : "dictation";
}

function readOverlayPosition(): OverlayPosition {
  const value = settingsRepository.get(KEYS.overlayPosition);
  return value === "left" || value === "right" ? value : "center";
}

function readInjectionLimit() {
  const value = Number(settingsRepository.get(KEYS.injectionLimit));
  return Number.isInteger(value) && value >= 1 && value <= 8_000 ? value : 8_000;
}

function readShortcut(): ShortcutBinding {
  const stored = settingsRepository.get(KEYS.shortcut);
  if (
    typeof navigator !== "undefined" &&
    navigator.userAgent.includes("Mac OS") &&
    (stored === null || stored === "ctrl_win")
  ) {
    return "ctrl_win_space";
  }
  return stored === "ctrl_alt_space" ||
    stored === "ctrl_shift_space" ||
    stored === "ctrl_win_space"
    ? stored
    : "ctrl_win";
}

export function shortcutDisplay(binding: ShortcutBinding) {
  const isMacOS =
    typeof navigator !== "undefined" && navigator.userAgent.includes("Mac OS");
  const modifier = isMacOS ? "Control + Command" : "Ctrl + Win";
  const labels: Record<ShortcutBinding, string> = {
    ctrl_win: isMacOS ? `${modifier} + Space` : modifier,
    ctrl_alt_space: isMacOS ? "Control + Option + Space" : "Ctrl + Alt + Space",
    ctrl_shift_space: isMacOS ? "Control + Shift + Space" : "Ctrl + Shift + Space",
    ctrl_win_space: `${modifier} + Space`,
  };
  return labels[binding];
}

const initialShortcut = readShortcut();
const state = reactive({
  selectedMode: readMode(),
  autoInjection: {
    dictation: readBoolean(KEYS.autoInjection.dictation, true),
    assistant: readBoolean(KEYS.autoInjection.assistant, false),
    mixed: readBoolean(KEYS.autoInjection.mixed, false),
  } as Record<VoiceInteractionMode, boolean>,
  injectionMaxCodePoints: readInjectionLimit(),
  overlayEnabled: readBoolean(KEYS.overlayEnabled, true),
  overlayPosition: readOverlayPosition(),
  shortcutBinding: initialShortcut,
  shortcutDesiredEnabled: readBoolean(KEYS.shortcutEnabled, true),
  shortcutDisplay: shortcutDisplay(initialShortcut),
  shortcutError: "",
  shortcutLastEventAt: null as number | null,
  shortcutListenerStatus: "starting" as ShortcutStatus["listenerStatus"],
  shortcutRegistered: false,
  selectedAsrId: "",
  selectedLlmId: "",
  selectedOutputAudioId: "",
  selectedTtsId: "",
});

function setSelectedOption(kind: InferenceOptionKind, id: string) {
  if (kind === "asr") state.selectedAsrId = id;
  else if (kind === "llm") state.selectedLlmId = id;
  else if (kind === "tts") state.selectedTtsId = id;
  else state.selectedOutputAudioId = id;
}

export const settingsStoreActions = {
  applyShortcutStatus(status: ShortcutStatus) {
    if (status.enabled) {
      state.shortcutBinding = status.binding;
      state.shortcutDisplay = status.display;
    }
    state.shortcutRegistered = status.enabled;
    state.shortcutListenerStatus = status.listenerStatus;
    state.shortcutError =
      status.listenerStatus === "error" || status.lastError
        ? status.lastError || "系统全局键盘监听器启动失败"
        : "";
  },
  hydrateInferenceSelections(hello: ServerHelloPayload) {
    for (const kind of Object.keys(KEYS.inference) as InferenceOptionKind[]) {
      const options = hello.inference_options[kind];
      const saved = settingsRepository.get(KEYS.inference[kind]);
      const selected =
        saved && options.some((option) => option.id === saved)
          ? saved
          : hello.inference_options.defaults[kind];
      setSelectedOption(kind, selected);
    }
  },
  noteShortcutEvent(timestampMs: number) {
    state.shortcutLastEventAt = timestampMs;
    state.shortcutError = "";
  },
  setAutoInjection(mode: VoiceInteractionMode, enabled: boolean) {
    state.autoInjection[mode] = enabled;
    settingsRepository.set(KEYS.autoInjection[mode], String(enabled));
  },
  setInferenceOption(kind: InferenceOptionKind, id: string) {
    setSelectedOption(kind, id);
    settingsRepository.set(KEYS.inference[kind], id);
  },
  setInjectionMaxCodePoints(value: number) {
    state.injectionMaxCodePoints = value;
    settingsRepository.set(KEYS.injectionLimit, String(value));
  },
  setMode(mode: VoiceInteractionMode) {
    state.selectedMode = mode;
    settingsRepository.set(KEYS.mode, mode);
  },
  setOverlayEnabled(enabled: boolean) {
    state.overlayEnabled = enabled;
    settingsRepository.set(KEYS.overlayEnabled, String(enabled));
  },
  setOverlayPosition(position: OverlayPosition) {
    state.overlayPosition = position;
    settingsRepository.set(KEYS.overlayPosition, position);
  },
  setShortcutBinding(binding: ShortcutBinding) {
    state.shortcutBinding = binding;
    state.shortcutDisplay = shortcutDisplay(binding);
    settingsRepository.set(KEYS.shortcut, binding);
  },
  setShortcutDesiredEnabled(enabled: boolean) {
    state.shortcutDesiredEnabled = enabled;
    settingsRepository.set(KEYS.shortcutEnabled, String(enabled));
  },
  setShortcutError(message: string) {
    state.shortcutError = message;
  },
};

export function useSettingsStore() {
  return { state: readonly(state) };
}

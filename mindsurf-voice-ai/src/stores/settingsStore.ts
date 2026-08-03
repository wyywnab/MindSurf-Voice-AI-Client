import { reactive, readonly } from "vue";

import { getCredentialStatus } from "../services/settings/credentials";
import { setLocale } from "../services/i18n";
import {
  defaultShortcutBinding,
  formatShortcutBinding,
} from "../services/shortcutBinding";
import { diagnosticsStoreActions } from "./diagnosticsStore";
import { settingsRepository } from "../services/settings/settingsRepository";
import type { ServerHelloPayload } from "../types/protocol";
import type { ShortcutBinding, ShortcutStatus } from "../types/shortcut";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AudioInputDevice,
  type ServiceProfile,
  type ServiceConnectionTestResult,
} from "../types/settings";
import type { OverlayPosition, VoiceInteractionMode } from "../types/voice";

export type InferenceOptionKind = "asr" | "llm" | "tts" | "output_audio";

const defaults = structuredClone(DEFAULT_APP_SETTINGS);
const defaultProfile = defaults.serviceProfiles[0]!;
const initialShortcut = platformDefaultShortcut(defaults.shortcut.binding);
const state = reactive({
  initialized: false,
  saveError: "",
  serviceProfiles: defaults.serviceProfiles as ServiceProfile[],
  activeServiceProfileId: defaults.activeServiceProfileId,
  serviceUrl: defaultProfile.websocketUrl,
  tokenConfigured: false,
  autoConnect: defaultProfile.autoConnect,
  connectionTestStatus: "idle" as "idle" | "testing" | "succeeded" | "failed",
  connectionTestError: "",
  connectionTestResult: null as ServiceConnectionTestResult | null,
  inputDeviceId: defaults.audio.inputDeviceId,
  audioInputDevices: [] as AudioInputDevice[],
  audioDevicesLoading: false,
  audioDevicesError: "",
  language: defaults.audio.language,
  audioResponseEnabled: defaults.audio.audioResponseEnabled,
  voice: defaults.audio.voice,
  playbackVolume: defaults.audio.playbackVolume,
  selectedMode: defaults.interaction.defaultMode,
  autoInjection: defaults.interaction.autoInjection,
  injectionMaxCodePoints: defaults.interaction.injectionMaxCodePoints,
  overlayEnabled: defaults.overlay.enabled,
  overlayPosition: defaults.overlay.position,
  shortcutBinding: initialShortcut,
  shortcutDesiredEnabled: defaults.shortcut.enabled,
  shortcutDisplay: shortcutDisplay(initialShortcut),
  shortcutError: "",
  shortcutLastEventAt: null as number | null,
  shortcutListenerStatus: "starting" as ShortcutStatus["listenerStatus"],
  shortcutRegistered: false,
  shortcutEnvironment: "unsupported" as ShortcutStatus["environment"],
  shortcutSupportsModifierOnly: false,
  selectedAsrId: defaults.inference.asrId,
  selectedLlmId: defaults.inference.llmId,
  selectedOutputAudioId: defaults.inference.outputAudioId,
  selectedTtsId: defaults.inference.ttsId,
  developerModeEnabled: defaults.developer.enabled,
  developerUseWebViewContextMenu: defaults.developer.useWebViewContextMenu,
  developerShowDiagnosticsPage: defaults.developer.showDiagnosticsPage,
  interfaceLocale: defaults.interface.locale,
});

function platformDefaultShortcut(binding: ShortcutBinding): ShortcutBinding {
  return binding === defaults.shortcut.binding
    ? defaultShortcutBinding(shortcutPlatform())
    : binding;
}

export function shortcutDisplay(binding: ShortcutBinding) {
  return formatShortcutBinding(binding, shortcutPlatform());
}

function shortcutPlatform() {
  if (typeof navigator === "undefined") return "windows";
  if (navigator.userAgent.includes("Mac OS")) return "macos";
  if (navigator.userAgent.includes("Windows")) return "windows";
  return "unsupported";
}

function applySettings(settings: AppSettings) {
  state.serviceProfiles = settings.serviceProfiles.map((profile) => ({ ...profile }));
  state.activeServiceProfileId = settings.activeServiceProfileId;
  syncActiveServiceProfile();
  state.inputDeviceId = settings.audio.inputDeviceId;
  state.language = settings.audio.language;
  state.audioResponseEnabled = settings.audio.audioResponseEnabled;
  state.voice = settings.audio.voice;
  state.playbackVolume = settings.audio.playbackVolume;
  state.selectedMode = settings.interaction.defaultMode;
  state.autoInjection = { ...settings.interaction.autoInjection };
  state.injectionMaxCodePoints = settings.interaction.injectionMaxCodePoints;
  state.shortcutDesiredEnabled = settings.shortcut.enabled;
  state.shortcutBinding = platformDefaultShortcut(settings.shortcut.binding);
  state.shortcutDisplay = shortcutDisplay(state.shortcutBinding);
  state.overlayEnabled = settings.overlay.enabled;
  state.overlayPosition = settings.overlay.position;
  state.selectedAsrId = settings.inference.asrId;
  state.selectedLlmId = settings.inference.llmId;
  state.selectedTtsId = settings.inference.ttsId;
  state.selectedOutputAudioId = settings.inference.outputAudioId;
  state.developerModeEnabled = settings.developer.enabled;
  state.developerUseWebViewContextMenu = settings.developer.useWebViewContextMenu;
  state.developerShowDiagnosticsPage = settings.developer.showDiagnosticsPage;
  state.interfaceLocale = settings.interface.locale;
  setLocale(settings.interface.locale);
}

function snapshot(): AppSettings {
  return {
    schemaVersion: 1,
    activeServiceProfileId: state.activeServiceProfileId,
    serviceProfiles: state.serviceProfiles.map((profile) => ({ ...profile })),
    audio: {
      inputDeviceId: state.inputDeviceId,
      language: state.language,
      audioResponseEnabled: state.audioResponseEnabled,
      voice: state.voice,
      playbackVolume: state.playbackVolume,
    },
    interaction: {
      defaultMode: state.selectedMode,
      autoInjection: { ...state.autoInjection },
      injectionMaxCodePoints: state.injectionMaxCodePoints,
    },
    shortcut: {
      enabled: state.shortcutDesiredEnabled,
      binding: state.shortcutBinding,
    },
    overlay: {
      enabled: state.overlayEnabled,
      position: state.overlayPosition,
    },
    inference: {
      asrId: state.selectedAsrId,
      llmId: state.selectedLlmId,
      ttsId: state.selectedTtsId,
      outputAudioId: state.selectedOutputAudioId,
    },
    developer: {
      enabled: state.developerModeEnabled,
      useWebViewContextMenu: state.developerUseWebViewContextMenu,
      showDiagnosticsPage: state.developerShowDiagnosticsPage,
    },
    interface: {
      locale: state.interfaceLocale,
    },
  };
}

function activeServiceProfile() {
  return (
    state.serviceProfiles.find(
      (profile) => profile.id === state.activeServiceProfileId,
    ) ?? state.serviceProfiles[0]!
  );
}

function syncActiveServiceProfile() {
  const profile = activeServiceProfile();
  state.activeServiceProfileId = profile.id;
  state.serviceUrl = profile.websocketUrl;
  state.autoConnect = profile.autoConnect;
}

async function persist() {
  try {
    await settingsRepository.save(snapshot());
    state.saveError = "";
  } catch (error) {
    state.saveError = error instanceof Error ? error.message : "设置保存失败";
    diagnosticsStoreActions.log(
      "error",
      "settings",
      "settings.save_failed",
      state.saveError,
    );
  }
}

function persistSoon() {
  void persist();
}

function setSelectedOption(kind: InferenceOptionKind, id: string) {
  if (kind === "asr") state.selectedAsrId = id;
  else if (kind === "llm") state.selectedLlmId = id;
  else if (kind === "tts") state.selectedTtsId = id;
  else state.selectedOutputAudioId = id;
}

export const settingsStoreActions = {
  async initialize() {
    try {
      applySettings(await settingsRepository.load());
      state.tokenConfigured = await getCredentialStatus(state.activeServiceProfileId);
      state.saveError = "";
      diagnosticsStoreActions.log(
        "info",
        "settings",
        "settings.loaded",
        "应用设置加载完成",
      );
    } catch (error) {
      state.saveError = error instanceof Error ? error.message : "设置读取失败";
      diagnosticsStoreActions.log(
        "error",
        "settings",
        "settings.load_failed",
        state.saveError,
      );
    } finally {
      state.initialized = true;
    }
  },
  applyShortcutStatus(status: ShortcutStatus) {
    if (status.enabled) {
      state.shortcutBinding = status.binding;
      state.shortcutDisplay = status.display;
    }
    state.shortcutRegistered = status.enabled;
    state.shortcutEnvironment = status.environment;
    state.shortcutSupportsModifierOnly = status.supportsModifierOnly;
    state.shortcutListenerStatus = status.listenerStatus;
    state.shortcutError =
      status.listenerStatus === "error" || status.lastError
        ? status.lastError || "系统全局键盘监听器启动失败"
        : "";
  },
  hydrateInferenceSelections(hello: ServerHelloPayload) {
    for (const kind of ["asr", "llm", "tts", "output_audio"] as const) {
      const selected =
        kind === "asr"
          ? state.selectedAsrId
          : kind === "llm"
            ? state.selectedLlmId
            : kind === "tts"
              ? state.selectedTtsId
              : state.selectedOutputAudioId;
      const valid = hello.inference_options[kind].some(
        (option) => option.id === selected,
      );
      setSelectedOption(
        kind,
        valid ? selected : hello.inference_options.defaults[kind],
      );
    }
    const languages = hello.recognition_languages ?? [];
    if (languages.length && !languages.some((item) => item.id === state.language)) {
      state.language = languages[0]?.id ?? "auto";
    }
    const voices = hello.voices ?? [];
    if (voices.length && !voices.some((item) => item.id === state.voice)) {
      state.voice = voices[0]?.id ?? "default";
    }
    persistSoon();
  },
  noteShortcutEvent(timestampMs: number) {
    state.shortcutLastEventAt = timestampMs;
    state.shortcutError = "";
  },
  setAudioDevices(devices: AudioInputDevice[], error = "") {
    const selectedDeviceMissing =
      Boolean(state.inputDeviceId) &&
      !devices.some((device) => device.id === state.inputDeviceId);
    state.audioInputDevices = devices;
    state.audioDevicesError = selectedDeviceMissing
      ? "已选择的麦克风不可用，已回退到系统默认设备"
      : error;
    state.audioDevicesLoading = false;
    if (error) {
      diagnosticsStoreActions.log(
        "warn",
        "recorder",
        "input_device.list_failed",
        error,
      );
    }
    if (selectedDeviceMissing) {
      diagnosticsStoreActions.log(
        "warn",
        "recorder",
        "input_device.fallback",
        "已选择的麦克风不可用，已回退到系统默认设备",
      );
      state.inputDeviceId = null;
      persistSoon();
    }
  },
  setAudioDevicesLoading() {
    state.audioDevicesLoading = true;
    state.audioDevicesError = "";
  },
  setAutoInjection(mode: VoiceInteractionMode, enabled: boolean) {
    state.autoInjection[mode] = enabled;
    persistSoon();
  },
  setAudioResponseEnabled(enabled: boolean) {
    state.audioResponseEnabled = enabled;
    persistSoon();
  },
  setConnectionTest(
    status: typeof state.connectionTestStatus,
    result: ServiceConnectionTestResult | null = null,
    error = "",
  ) {
    state.connectionTestStatus = status;
    state.connectionTestResult = result;
    state.connectionTestError = error;
  },
  setDeveloperMode(enabled: boolean) {
    state.developerModeEnabled = enabled;
    persistSoon();
  },
  setDeveloperUseWebViewContextMenu(enabled: boolean) {
    state.developerUseWebViewContextMenu = enabled;
    persistSoon();
  },
  setDeveloperShowDiagnosticsPage(enabled: boolean) {
    state.developerShowDiagnosticsPage = enabled;
    persistSoon();
  },
  setInterfaceLocale(locale: AppSettings["interface"]["locale"]) {
    state.interfaceLocale = locale;
    setLocale(locale);
    persistSoon();
  },
  setInferenceOption(kind: InferenceOptionKind, id: string) {
    setSelectedOption(kind, id);
    persistSoon();
  },
  setInjectionMaxCodePoints(value: number) {
    state.injectionMaxCodePoints = value;
    persistSoon();
  },
  setInputDeviceId(id: string | null) {
    state.inputDeviceId = id;
    persistSoon();
  },
  setLanguage(language: string) {
    state.language = language;
    persistSoon();
  },
  setMode(mode: VoiceInteractionMode) {
    state.selectedMode = mode;
    persistSoon();
  },
  setOverlayEnabled(enabled: boolean) {
    state.overlayEnabled = enabled;
    persistSoon();
  },
  setOverlayPosition(position: OverlayPosition) {
    state.overlayPosition = position;
    persistSoon();
  },
  setPlaybackVolume(volume: number) {
    state.playbackVolume = Math.min(1, Math.max(0, volume));
    persistSoon();
  },
  setService(input: {
    name: string;
    url: string;
    autoConnect: boolean;
    authMode: ServiceProfile["authMode"];
    preferredPipeline: ServiceProfile["preferredPipeline"];
  }) {
    const profile = activeServiceProfile();
    profile.name = input.name;
    profile.websocketUrl = input.url;
    profile.autoConnect = input.autoConnect;
    profile.authMode = input.authMode;
    profile.preferredPipeline = input.preferredPipeline;
    profile.updatedAt = Date.now();
    syncActiveServiceProfile();
    diagnosticsStoreActions.log(
      "info",
      "settings",
      "service_settings.changed",
      "服务连接设置已更新",
      { fields: { autoConnect: input.autoConnect, profileId: profile.id } },
    );
    persistSoon();
  },
  addServiceProfile(profile: ServiceProfile) {
    state.serviceProfiles.push({ ...profile });
    state.activeServiceProfileId = profile.id;
    syncActiveServiceProfile();
    state.tokenConfigured = false;
    persistSoon();
  },
  duplicateServiceProfile(sourceId: string, profile: ServiceProfile) {
    const source = state.serviceProfiles.find((item) => item.id === sourceId);
    if (!source) return false;
    state.serviceProfiles.push({ ...source, ...profile });
    state.activeServiceProfileId = profile.id;
    syncActiveServiceProfile();
    state.tokenConfigured = false;
    persistSoon();
    return true;
  },
  removeServiceProfile(profileId: string) {
    if (state.serviceProfiles.length <= 1) return false;
    const index = state.serviceProfiles.findIndex((item) => item.id === profileId);
    if (index < 0) return false;
    state.serviceProfiles.splice(index, 1);
    if (state.activeServiceProfileId === profileId) {
      state.activeServiceProfileId = state.serviceProfiles[0]!.id;
      syncActiveServiceProfile();
    }
    persistSoon();
    return true;
  },
  selectServiceProfile(profileId: string) {
    if (!state.serviceProfiles.some((profile) => profile.id === profileId)) {
      return false;
    }
    state.activeServiceProfileId = profileId;
    syncActiveServiceProfile();
    state.connectionTestStatus = "idle";
    state.connectionTestResult = null;
    state.connectionTestError = "";
    persistSoon();
    return true;
  },
  setShortcutBinding(binding: ShortcutBinding) {
    state.shortcutBinding = binding;
    state.shortcutDisplay = shortcutDisplay(binding);
    persistSoon();
  },
  setShortcutDesiredEnabled(enabled: boolean) {
    state.shortcutDesiredEnabled = enabled;
    persistSoon();
  },
  setShortcutError(message: string) {
    state.shortcutError = message;
    if (message) {
      diagnosticsStoreActions.log(
        "error",
        "shortcut",
        "shortcut.registration_failed",
        message,
      );
    }
  },
  setTokenConfigured(configured: boolean) {
    state.tokenConfigured = configured;
  },
  setVoice(voice: string) {
    state.voice = voice;
    persistSoon();
  },
};

export function useSettingsStore() {
  return { state: readonly(state) };
}

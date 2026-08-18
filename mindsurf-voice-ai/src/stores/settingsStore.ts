import { reactive, readonly } from "vue";

import { setLocale } from "../services/i18n";
import {
  defaultShortcutBinding,
  formatShortcutBinding,
} from "../services/shortcutBinding";
import { settingsRepository } from "../services/settings/settingsRepository";
import { applyInterfaceTheme } from "../services/theme";
import { toast } from "../services/toast";
import type { VoiceModeV2 } from "../types/httpApi";
import type { ShortcutBinding, ShortcutStatus } from "../types/shortcut";
import {
  DEFAULT_APP_SETTINGS,
  type AppSettings,
  type AudioInputDevice,
} from "../types/settings";
import type { OverlayPosition } from "../types/voice";
import { diagnosticsStoreActions } from "./diagnosticsStore";

const defaults = structuredClone(DEFAULT_APP_SETTINGS);
const initialShortcut = platformDefaultShortcut(defaults.shortcut.binding);
const state = reactive({
  initialized: false,
  voiceApiOrigin: defaults.voiceApiOrigin,
  saveError: "",
  inputDeviceId: defaults.audio.inputDeviceId,
  audioInputDevices: [] as AudioInputDevice[],
  audioDevicesLoading: false,
  audioDevicesError: "",
  selectedMode: defaults.interaction.defaultMode,
  autoInjection: { ...defaults.interaction.autoInjection },
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
  developerModeEnabled: defaults.developer.enabled,
  developerUseWebViewContextMenu: defaults.developer.useWebViewContextMenu,
  developerShowDiagnosticsPage: defaults.developer.showDiagnosticsPage,
  interfaceLocale: defaults.interface.locale,
  interfaceTheme: defaults.interface.theme,
  autostartEnabled: false,
  autostartStatus: "loading" as "loading" | "ready" | "saving" | "unavailable",
  autostartError: "",
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
  state.voiceApiOrigin = settings.voiceApiOrigin;
  state.inputDeviceId = settings.audio.inputDeviceId;
  state.selectedMode = settings.interaction.defaultMode;
  state.autoInjection = { ...settings.interaction.autoInjection };
  state.injectionMaxCodePoints = settings.interaction.injectionMaxCodePoints;
  state.shortcutDesiredEnabled = settings.shortcut.enabled;
  state.shortcutBinding = platformDefaultShortcut(settings.shortcut.binding);
  state.shortcutDisplay = shortcutDisplay(state.shortcutBinding);
  state.overlayEnabled = settings.overlay.enabled;
  state.overlayPosition = settings.overlay.position;
  state.developerModeEnabled = settings.developer.enabled;
  state.developerUseWebViewContextMenu = settings.developer.useWebViewContextMenu;
  state.developerShowDiagnosticsPage = settings.developer.showDiagnosticsPage;
  state.interfaceLocale = settings.interface.locale;
  state.interfaceTheme = settings.interface.theme;
  setLocale(settings.interface.locale);
  applyInterfaceTheme(settings.interface.theme);
}

function snapshot(): AppSettings {
  return {
    schemaVersion: 2,
    voiceApiOrigin: state.voiceApiOrigin,
    audio: { inputDeviceId: state.inputDeviceId },
    interaction: {
      defaultMode: state.selectedMode,
      autoInjection: { ...state.autoInjection },
      injectionMaxCodePoints: state.injectionMaxCodePoints,
    },
    shortcut: { enabled: state.shortcutDesiredEnabled, binding: state.shortcutBinding },
    overlay: { enabled: state.overlayEnabled, position: state.overlayPosition },
    developer: {
      enabled: state.developerModeEnabled,
      useWebViewContextMenu: state.developerUseWebViewContextMenu,
      showDiagnosticsPage: state.developerShowDiagnosticsPage,
    },
    interface: { locale: state.interfaceLocale, theme: state.interfaceTheme },
  };
}

async function persist() {
  try {
    await settingsRepository.save(snapshot());
    state.saveError = "";
  } catch (error) {
    state.saveError = error instanceof Error ? error.message : "设置保存失败";
    toast.error(state.saveError, { title: "设置保存失败", durationMs: 0 });
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

export const settingsStoreActions = {
  async initialize() {
    try {
      applySettings(await settingsRepository.load());
      state.saveError = "";
    } catch (error) {
      state.saveError = error instanceof Error ? error.message : "设置读取失败";
      toast.error(state.saveError, { title: "设置读取失败", durationMs: 0 });
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
  noteShortcutEvent(timestampMs: number) {
    state.shortcutLastEventAt = timestampMs;
    state.shortcutError = "";
  },
  setAudioDevices(devices: AudioInputDevice[], error = "") {
    const missing =
      Boolean(state.inputDeviceId) &&
      !devices.some((device) => device.id === state.inputDeviceId);
    state.audioInputDevices = devices;
    state.audioDevicesError = missing
      ? "已选择的麦克风不可用，已回退到系统默认设备"
      : error;
    state.audioDevicesLoading = false;
    if (missing) {
      state.inputDeviceId = null;
      persistSoon();
    }
  },
  setAudioDevicesLoading() {
    state.audioDevicesLoading = true;
    state.audioDevicesError = "";
  },
  setAutoInjection(mode: VoiceModeV2, enabled: boolean) {
    state.autoInjection[mode] = enabled;
    persistSoon();
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
  setInterfaceTheme(theme: AppSettings["interface"]["theme"]) {
    state.interfaceTheme = theme;
    applyInterfaceTheme(theme);
    persistSoon();
  },
  setAutostartLoading() {
    state.autostartStatus = "loading";
    state.autostartError = "";
  },
  setAutostartSaving() {
    state.autostartStatus = "saving";
    state.autostartError = "";
  },
  setAutostartState(enabled: boolean) {
    state.autostartEnabled = enabled;
    state.autostartStatus = "ready";
    state.autostartError = "";
  },
  setAutostartUnavailable(message: string) {
    state.autostartStatus = "unavailable";
    state.autostartError = message;
  },
  setInjectionMaxCodePoints(value: number) {
    state.injectionMaxCodePoints = value;
    persistSoon();
  },
  setInputDeviceId(id: string | null) {
    state.inputDeviceId = id;
    persistSoon();
  },
  setMode(mode: VoiceModeV2) {
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
  setVoiceApiOrigin(origin: string) {
    state.voiceApiOrigin = origin;
    persistSoon();
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
  },
};

export function useSettingsStore() {
  return { state: readonly(state) };
}

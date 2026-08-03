import { isTauri } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../types/settings";
import { parseShortcutBinding } from "../shortcutBinding";

const STORE_PATH = "settings.json";
const SETTINGS_KEY = "settings";

export interface SettingsRepository {
  load(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}

class TauriSettingsRepository implements SettingsRepository {
  private storePromise: Promise<Store> | null = null;

  async load() {
    if (!isTauri()) return structuredClone(DEFAULT_APP_SETTINGS);
    const stored = await (await this.store()).get<unknown>(SETTINGS_KEY);
    return parseSettings(stored);
  }

  async save(settings: AppSettings) {
    if (!isTauri()) return;
    const store = await this.store();
    await store.set(SETTINGS_KEY, settings);
    await store.save();
  }

  private store() {
    this.storePromise ??= load(STORE_PATH, { autoSave: 100 });
    return this.storePromise;
  }
}

export function parseSettings(value: unknown): AppSettings {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return structuredClone(DEFAULT_APP_SETTINGS);
  }
  const defaults = DEFAULT_APP_SETTINGS;
  const serviceProfiles = Array.isArray(value.serviceProfiles)
    ? value.serviceProfiles.flatMap(parseServiceProfile)
    : [];
  const profiles = serviceProfiles.length
    ? serviceProfiles
    : structuredClone(defaults.serviceProfiles);
  const activeServiceProfileId =
    typeof value.activeServiceProfileId === "string" &&
    profiles.some((profile) => profile.id === value.activeServiceProfileId)
      ? value.activeServiceProfileId
      : profiles[0]!.id;
  const audio = isRecord(value.audio) ? value.audio : {};
  const interaction = isRecord(value.interaction) ? value.interaction : {};
  const shortcut = isRecord(value.shortcut) ? value.shortcut : {};
  const overlay = isRecord(value.overlay) ? value.overlay : {};
  const inference = isRecord(value.inference) ? value.inference : {};
  const developer = isRecord(value.developer) ? value.developer : {};
  const interfaceSettings = isRecord(value.interface) ? value.interface : {};
  const autoInjection = isRecord(interaction.autoInjection)
    ? interaction.autoInjection
    : {};
  return {
    schemaVersion: 1,
    activeServiceProfileId,
    serviceProfiles: profiles,
    audio: {
      inputDeviceId:
        typeof audio.inputDeviceId === "string" ? audio.inputDeviceId : null,
      language: stringValue(audio.language, defaults.audio.language),
      audioResponseEnabled: booleanValue(
        audio.audioResponseEnabled,
        defaults.audio.audioResponseEnabled,
      ),
      voice: stringValue(audio.voice, defaults.audio.voice),
      playbackVolume: numberValue(audio.playbackVolume, 0, 1, 1),
    },
    interaction: {
      defaultMode: isVoiceMode(interaction.defaultMode)
        ? interaction.defaultMode
        : defaults.interaction.defaultMode,
      autoInjection: {
        dictation: booleanValue(autoInjection.dictation, true),
        assistant: booleanValue(autoInjection.assistant, false),
        mixed: booleanValue(autoInjection.mixed, false),
      },
      injectionMaxCodePoints: numberValue(
        interaction.injectionMaxCodePoints,
        1,
        8_000,
        8_000,
      ),
    },
    shortcut: {
      enabled: booleanValue(shortcut.enabled, true),
      binding: isShortcutBinding(shortcut.binding)
        ? shortcut.binding
        : defaults.shortcut.binding,
    },
    overlay: {
      enabled: booleanValue(overlay.enabled, true),
      position: isOverlayPosition(overlay.position)
        ? overlay.position
        : defaults.overlay.position,
    },
    inference: {
      asrId: stringValue(inference.asrId, ""),
      llmId: stringValue(inference.llmId, ""),
      ttsId: stringValue(inference.ttsId, ""),
      outputAudioId: stringValue(inference.outputAudioId, ""),
    },
    developer: {
      enabled: booleanValue(developer.enabled, false),
      useWebViewContextMenu: booleanValue(developer.useWebViewContextMenu, false),
      showDiagnosticsPage: booleanValue(developer.showDiagnosticsPage, false),
    },
    interface: {
      locale: isAppLocale(interfaceSettings.locale)
        ? interfaceSettings.locale
        : defaults.interface.locale,
    },
  };
}

function isAppLocale(value: unknown): value is AppSettings["interface"]["locale"] {
  return value === "zh-CN" || value === "en-US";
}

function parseServiceProfile(value: unknown) {
  if (!isRecord(value)) return [];
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const websocketUrl =
    typeof value.websocketUrl === "string" ? value.websocketUrl.trim() : "";
  if (!id || !name || !websocketUrl) return [];
  return [
    {
      id,
      name,
      websocketUrl,
      autoConnect: booleanValue(value.autoConnect, false),
      authMode: value.authMode === "bearer" ? ("bearer" as const) : ("none" as const),
      preferredPipeline:
        value.preferredPipeline === "cascade" ||
        value.preferredPipeline === "native_audio"
          ? (value.preferredPipeline as "cascade" | "native_audio")
          : ("auto" as const),
      createdAt: numberValue(value.createdAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
      updatedAt: numberValue(value.updatedAt, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function isVoiceMode(
  value: unknown,
): value is AppSettings["interaction"]["defaultMode"] {
  return value === "dictation" || value === "assistant" || value === "mixed";
}

function isShortcutBinding(
  value: unknown,
): value is AppSettings["shortcut"]["binding"] {
  if (typeof value !== "string") return false;
  try {
    parseShortcutBinding(value);
    return true;
  } catch {
    return false;
  }
}

function isOverlayPosition(
  value: unknown,
): value is AppSettings["overlay"]["position"] {
  return value === "left" || value === "center" || value === "right";
}

export const settingsRepository: SettingsRepository = new TauriSettingsRepository();

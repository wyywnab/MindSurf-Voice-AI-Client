import { isTauri } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../types/settings";

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
  const service = isRecord(value.service) ? value.service : {};
  const audio = isRecord(value.audio) ? value.audio : {};
  const interaction = isRecord(value.interaction) ? value.interaction : {};
  const shortcut = isRecord(value.shortcut) ? value.shortcut : {};
  const overlay = isRecord(value.overlay) ? value.overlay : {};
  const inference = isRecord(value.inference) ? value.inference : {};
  const autoInjection = isRecord(interaction.autoInjection)
    ? interaction.autoInjection
    : {};
  return {
    schemaVersion: 1,
    service: {
      url: stringValue(service.url, defaults.service.url),
      tokenConfigured: false,
      autoConnect: booleanValue(service.autoConnect, defaults.service.autoConnect),
    },
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
  };
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
  return (
    value === "ctrl_win" ||
    value === "ctrl_alt_space" ||
    value === "ctrl_shift_space" ||
    value === "ctrl_win_space"
  );
}

function isOverlayPosition(
  value: unknown,
): value is AppSettings["overlay"]["position"] {
  return value === "left" || value === "center" || value === "right";
}

export const settingsRepository: SettingsRepository = new TauriSettingsRepository();

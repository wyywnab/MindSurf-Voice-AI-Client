import { isTauri } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../types/settings";
import { validateApiOrigin } from "../http/apiOrigin";
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
    return parseSettings(await (await this.store()).get<unknown>(SETTINGS_KEY));
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
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    return structuredClone(DEFAULT_APP_SETTINGS);
  }
  const defaults = DEFAULT_APP_SETTINGS;
  const audio = recordOrEmpty(value.audio);
  const interaction = recordOrEmpty(value.interaction);
  const shortcut = recordOrEmpty(value.shortcut);
  const overlay = recordOrEmpty(value.overlay);
  const developer = recordOrEmpty(value.developer);
  const interfaceSettings = recordOrEmpty(value.interface);
  const autoInjection = recordOrEmpty(interaction.autoInjection);
  return {
    schemaVersion: 2,
    voiceApiOrigin: apiOriginValue(value.voiceApiOrigin, defaults.voiceApiOrigin),
    audio: {
      inputDeviceId:
        typeof audio.inputDeviceId === "string" ? audio.inputDeviceId : null,
    },
    interaction: {
      defaultMode: interaction.defaultMode === "asr_llm" ? "asr_llm" : "asr_only",
      autoInjection: {
        asr_only: booleanValue(autoInjection.asr_only, true),
        asr_llm: booleanValue(autoInjection.asr_llm, false),
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
    developer: {
      enabled: booleanValue(developer.enabled, false),
      useWebViewContextMenu: booleanValue(developer.useWebViewContextMenu, false),
      showDiagnosticsPage: booleanValue(developer.showDiagnosticsPage, false),
    },
    interface: {
      locale:
        interfaceSettings.locale === "en-US" ? "en-US" : defaults.interface.locale,
      theme: isInterfaceTheme(interfaceSettings.theme)
        ? interfaceSettings.theme
        : defaults.interface.theme,
    },
  };
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function apiOriginValue(value: unknown, fallback: string) {
  if (typeof value !== "string") return fallback;
  try {
    return validateApiOrigin(value);
  } catch {
    return fallback;
  }
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
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

function isInterfaceTheme(value: unknown): value is AppSettings["interface"]["theme"] {
  return value === "system" || value === "light" || value === "dark";
}

export const settingsRepository: SettingsRepository = new TauriSettingsRepository();

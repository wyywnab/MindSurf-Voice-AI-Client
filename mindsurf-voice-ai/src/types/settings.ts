import type { VoiceModeV2 } from "./httpApi";
import type { ShortcutBinding } from "./shortcut";
import type { OverlayPosition } from "./voice";

export type InterfaceTheme = "system" | "light" | "dark";

export interface AppSettings {
  schemaVersion: 2;
  voiceApiOrigin: string;
  audio: { inputDeviceId: string | null };
  interaction: {
    defaultMode: VoiceModeV2;
    autoInjection: Record<VoiceModeV2, boolean>;
    injectionMaxCodePoints: number;
  };
  shortcut: { enabled: boolean; binding: ShortcutBinding };
  overlay: { enabled: boolean; position: OverlayPosition };
  developer: {
    enabled: boolean;
    useWebViewContextMenu: boolean;
    showDiagnosticsPage: boolean;
  };
  interface: { locale: "zh-CN" | "en-US"; theme: InterfaceTheme };
}

export interface AudioInputDevice {
  id: string;
  label: string;
  isDefault: boolean;
  backend: "web_audio" | "native";
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: 2,
  voiceApiOrigin: "http://127.0.0.1:8000",
  audio: { inputDeviceId: null },
  interaction: {
    defaultMode: "asr_only",
    autoInjection: { asr_only: true, asr_llm: false },
    injectionMaxCodePoints: 8_000,
  },
  shortcut: { enabled: true, binding: "control+super" },
  overlay: { enabled: true, position: "center" },
  developer: {
    enabled: false,
    useWebViewContextMenu: false,
    showDiagnosticsPage: false,
  },
  interface: { locale: "zh-CN", theme: "system" },
};

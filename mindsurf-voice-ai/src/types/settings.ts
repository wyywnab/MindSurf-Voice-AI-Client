import type { ShortcutBinding } from "./shortcut";
import type { OverlayPosition, VoiceInteractionMode } from "./voice";

export interface AppSettings {
  schemaVersion: 1;
  service: {
    url: string;
    tokenConfigured: boolean;
    autoConnect: boolean;
  };
  audio: {
    inputDeviceId: string | null;
    language: string;
    audioResponseEnabled: boolean;
    voice: string;
    playbackVolume: number;
  };
  interaction: {
    defaultMode: VoiceInteractionMode;
    autoInjection: Record<VoiceInteractionMode, boolean>;
    injectionMaxCodePoints: number;
  };
  shortcut: {
    enabled: boolean;
    binding: ShortcutBinding;
  };
  overlay: {
    enabled: boolean;
    position: OverlayPosition;
  };
  inference: {
    asrId: string;
    llmId: string;
    ttsId: string;
    outputAudioId: string;
  };
}

export interface AudioInputDevice {
  id: string;
  label: string;
  isDefault: boolean;
  backend: "web_audio" | "native";
}

export interface ServiceConnectionTestResult {
  elapsedMs: number;
  pipeline: string;
  protocolVersion: number;
  serverId: string;
  modelCount: number;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  schemaVersion: 1,
  service: {
    url: "ws://127.0.0.1:8000/v1/voice/ws",
    tokenConfigured: false,
    autoConnect: true,
  },
  audio: {
    inputDeviceId: null,
    language: "auto",
    audioResponseEnabled: true,
    voice: "default",
    playbackVolume: 1,
  },
  interaction: {
    defaultMode: "dictation",
    autoInjection: {
      dictation: true,
      assistant: false,
      mixed: false,
    },
    injectionMaxCodePoints: 8_000,
  },
  shortcut: {
    enabled: true,
    binding: "ctrl_win",
  },
  overlay: {
    enabled: true,
    position: "center",
  },
  inference: {
    asrId: "",
    llmId: "",
    ttsId: "",
    outputAudioId: "",
  },
};

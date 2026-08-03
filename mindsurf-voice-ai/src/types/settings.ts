import type { ShortcutBinding } from "./shortcut";
import type { OverlayPosition, VoiceInteractionMode } from "./voice";

export interface AppSettings {
  schemaVersion: 1;
  activeServiceProfileId: string;
  serviceProfiles: ServiceProfile[];
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
  developer: {
    enabled: boolean;
    useWebViewContextMenu: boolean;
    showDiagnosticsPage: boolean;
  };
  interface: {
    locale: "zh-CN" | "en-US";
  };
}

export interface ServiceProfile {
  id: string;
  name: string;
  websocketUrl: string;
  autoConnect: boolean;
  authMode: "none" | "bearer";
  preferredPipeline: "auto" | "cascade" | "native_audio";
  createdAt: number;
  updatedAt: number;
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
  activeServiceProfileId: "local-mock",
  serviceProfiles: [
    {
      id: "local-mock",
      name: "本地 Mock",
      websocketUrl: "ws://127.0.0.1:8000/v1/voice/ws",
      autoConnect: true,
      authMode: "none",
      preferredPipeline: "auto",
      createdAt: 0,
      updatedAt: 0,
    },
  ],
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
    binding: "control+super",
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
  developer: {
    enabled: false,
    useWebViewContextMenu: false,
    showDiagnosticsPage: false,
  },
  interface: {
    locale: "zh-CN",
  },
};

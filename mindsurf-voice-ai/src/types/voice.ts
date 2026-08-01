export type ServiceConnectionStatus =
  "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export type VoiceInteractionMode = "dictation" | "assistant" | "mixed";

export type OverlayPosition = "left" | "center" | "right";

export type PlaybackStatus =
  "idle" | "buffering" | "playing" | "done" | "stopped" | "error";

export interface PlaybackMetrics {
  firstChunkAt: number | null;
  playbackStartedAt: number | null;
  playbackCompletedAt: number | null;
  receivedChunks: number;
  receivedSamples: number;
  underrunCount: number;
}

export interface VoiceSessionState {
  activeRequestId: string | null;
  autoInjection: Record<VoiceInteractionMode, boolean>;
  assistantFinal: string;
  assistantLastSequence: number;
  assistantStreaming: string;
  assistantWarning: string;
  asrFinal: string;
  asrLanguage: string;
  asrPartial: string;
  asrRevision: number;
  connectionStatus: ServiceConnectionStatus;
  injectionError: string;
  injectionMaxCodePoints: number;
  injectionRemainingText: string;
  injectionReport: TextInjectionReport | null;
  injectionStatus: TextInjectionStatus;
  lastError: string;
  networkCongested: boolean;
  overlayEnabled: boolean;
  overlayPosition: OverlayPosition;
  playbackError: string;
  playbackMetrics: PlaybackMetrics;
  playbackStatus: PlaybackStatus;
  reconnectAttempt: number;
  requestStatus: RequestLifecycleStatus;
  shortcutBinding: ShortcutBinding;
  shortcutDesiredEnabled: boolean;
  shortcutDisplay: string;
  shortcutError: string;
  shortcutLastEventAt: number | null;
  shortcutListenerStatus: ShortcutListenerStatus;
  shortcutRegistered: boolean;
  selectedMode: VoiceInteractionMode;
  selectedAsrId: string;
  selectedLlmId: string;
  selectedOutputAudioId: string;
  selectedTtsId: string;
  serverHello: ServerHelloPayload | null;
  serviceUrl: string;
}

export const VOICE_MODE_LABELS: Record<VoiceInteractionMode, string> = {
  dictation: "听写",
  assistant: "助手",
  mixed: "混合",
};

export const CONNECTION_STATUS_LABELS: Record<ServiceConnectionStatus, string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "正在重连",
  error: "连接异常",
};
import type { RequestLifecycleStatus, ServerHelloPayload } from "./protocol";
import type { ShortcutBinding, ShortcutListenerStatus } from "./shortcut";
import type { TextInjectionReport, TextInjectionStatus } from "./injection";

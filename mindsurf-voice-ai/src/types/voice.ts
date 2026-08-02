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

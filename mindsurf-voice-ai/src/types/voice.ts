import type { VoiceModeV2 } from "./httpApi";

export type ServiceConnectionStatus =
  "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export type OverlayPosition = "left" | "center" | "right";

export const VOICE_MODE_LABELS: Record<VoiceModeV2, string> = {
  asr_only: "仅识别",
  asr_llm: "ASR + LLM 文本处理",
};

export const CONNECTION_STATUS_LABELS: Record<ServiceConnectionStatus, string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "正在重连",
  error: "连接异常",
};

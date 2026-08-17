import type { RequestLifecycleState } from "./request";
import type { VoiceModeV2 } from "./httpApi";

export type TimelineStage = "input" | "asr" | "llm" | "output" | "request";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RequestTimelineEvent {
  requestId: string;
  type: string;
  monotonicMs: number;
  wallClockMs: number;
  stage: TimelineStage;
  summary: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface RequestTimeline {
  requestId: string;
  mode: VoiceModeV2;
  startedAtMs: number;
  terminalState: RequestLifecycleState | null;
  recordingDurationMs: number | null;
  audioFramesSent: number;
  audioBytesSent: number;
  reconnectCount: number;
  events: RequestTimelineEvent[];
}

export interface LogEntry {
  timestampMs: number;
  level: LogLevel;
  module: string;
  event: string;
  message: string;
  requestId?: string;
  fields?: Record<string, string | number | boolean | null>;
}

export interface DiagnosticsExportResult {
  path: string;
  logFiles: number;
}

export interface TimelineMetric {
  label: string;
  durationMs: number;
}

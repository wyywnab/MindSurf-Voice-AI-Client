import type { VoiceInteractionMode } from "./voice";

export interface OverlaySnapshot {
  assistantText: string;
  cancellable: boolean;
  duration: string;
  durationMs: number;
  level: number;
  mode: VoiceInteractionMode;
  recording: boolean;
  status: string;
  transcript: string;
  updatedAtMs: number;
}

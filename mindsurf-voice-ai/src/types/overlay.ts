import type { VoiceInteractionMode } from "./voice";
import type { AppSettings } from "./settings";

export interface OverlaySnapshot {
  assistantText: string;
  cancellable: boolean;
  duration: string;
  durationMs: number;
  level: number;
  locale: AppSettings["interface"]["locale"];
  mode: VoiceInteractionMode;
  recording: boolean;
  status: string;
  transcript: string;
  updatedAtMs: number;
}

import type { VoiceModeV2 } from "./httpApi";
import type { AppSettings } from "./settings";

export interface OverlaySnapshot {
  cancellable: boolean;
  duration: string;
  durationMs: number;
  level: number;
  locale: AppSettings["interface"]["locale"];
  mode: VoiceModeV2;
  recording: boolean;
  status: string;
  transcript: string;
  updatedAtMs: number;
}

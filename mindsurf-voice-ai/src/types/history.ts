import type { VoiceModeV2 } from "./httpApi";

export interface RecognitionHistoryEntry {
  id: string;
  userId: string;
  completedAtMs: number;
  mode: VoiceModeV2;
  language: string;
  pipeline: string;
  durationMs: number;
  sourceText: string | null;
  resultText: string;
}

export type RecognitionHistoryModeFilter = "all" | VoiceModeV2;

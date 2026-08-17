import type { V2RequestStartPayload, V2TextStage } from "./realtimeV2";

export type RequestLifecycleState =
  | "idle"
  | "preparing"
  | "starting"
  | "recording"
  | "committing"
  | "processing_asr_final"
  | "processing_llm"
  | "ready_to_commit"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";

export type RequestTerminalState = "completed" | "cancelled" | "failed";

export interface RequestTransition {
  from: RequestLifecycleState;
  to: RequestLifecycleState;
  reason: string;
  atMonotonicMs: number;
}

export interface V2RequestOptionsSnapshot extends V2RequestStartPayload {
  autoInjectionEnabled: boolean;
  injectionMaxCodePoints: number;
}

export interface V2TemporaryTextState {
  temporaryText: string;
  stage: V2TextStage | null;
  asrNextSequence: number;
  llmNextSequence: number;
  finalSnapshotText: string | null;
  commitEligible: boolean;
  cancelRequested: boolean;
}

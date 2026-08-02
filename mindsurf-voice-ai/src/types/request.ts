import type { VoiceInteractionMode } from "./voice";

export type RequestLifecycleState =
  | "idle"
  | "preparing"
  | "recording"
  | "committing"
  | "recognizing"
  | "generating"
  | "playing"
  | "completed"
  | "cancelling"
  | "cancelled"
  | "failed";

export type RequestTerminalState = "completed" | "cancelled" | "failed";

export interface RequestOptionsSnapshot {
  autoInjectionEnabled: boolean;
  injectionMaxCodePoints: number;
  inputDeviceId: string | null;
  mode: VoiceInteractionMode;
  protocolMode: "dictation" | "assistant";
  language: string;
  wantsAudio: boolean;
  voice: string;
  playbackVolume: number;
  selection: {
    asr: string;
    llm: string | null;
    tts: string | null;
    outputAudio: string | null;
  };
}

export interface RequestTransition {
  from: RequestLifecycleState;
  to: RequestLifecycleState;
  reason: string;
  atMonotonicMs: number;
}

export type CancelReason =
  | "audio_backpressure"
  | "client_timeout"
  | "connection_lost"
  | "protocol_error"
  | "user_cancelled"
  | "user_interrupted";

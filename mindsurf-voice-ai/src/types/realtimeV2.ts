export interface V2ControlEnvelope<T = Record<string, unknown>> {
  v: 2;
  type: string;
  event_id: string;
  request_id: string | null;
  sent_at_ms: number;
  payload: T;
}

export interface V2ClientIdentity {
  version: string;
  platform: string;
  arch: string;
}

export interface V2ServerHello {
  session_id: string;
  protocol_version: 2;
  input_audio: {
    encoding: "pcm_s16le";
    sample_rate: 16000;
    channels: 1;
  };
  heartbeat_interval_ms: number;
  heartbeat_timeout_ms: number;
  input_idle_timeout_ms: number;
  limits: {
    max_control_bytes: number;
    max_binary_bytes: number;
    max_recording_ms: number;
  };
}

export interface V2SessionPing {
  nonce: string;
}

export interface V2ProtocolError {
  code: string;
  message: string;
  stage: string;
  terminal: boolean;
  retryable: boolean;
  fatal: boolean;
  details: Record<string, unknown>;
  usage?: Record<string, unknown>;
}

export type V2VoiceMode = "asr_only" | "asr_llm";
export type V2TextStage = "asr" | "llm";

export interface V2RequestStartPayload {
  mode: V2VoiceMode;
  pipeline: string;
  capabilities_revision: string;
  selection: { asr: string; llm: string | null };
  language: string;
  generation?: Record<string, number>;
}

export interface V2InputStatistics {
  last_sequence: number;
  chunk_count: number;
  sample_count: number;
  duration_ms: number;
}

export type V2CancelReason =
  "user_cancelled" | "client_timeout" | "network_congestion" | "protocol_error";

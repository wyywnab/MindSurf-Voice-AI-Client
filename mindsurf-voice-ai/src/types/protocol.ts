export const PROTOCOL_VERSION = 1;
export const VOICE_SUBPROTOCOL = "mindsurf.voice.v1";

export interface ControlEnvelope<TPayload = Record<string, unknown>> {
  v: number;
  type: string;
  event_id: string;
  request_id: string | null;
  sent_at_ms: number;
  payload: TPayload;
}

export interface InferenceOption {
  id: string;
  name: string;
  description: string;
}

export interface NamedProtocolOption {
  id: string;
  name: string;
}

export interface OutputAudioOption extends InferenceOption {
  encoding: "pcm_s16le";
  sample_rate: 16_000 | 24_000;
  channels: 1;
}

export interface ServerHelloPayload {
  session_id: string;
  protocol_version: number;
  pipeline: string;
  limits: {
    max_recording_ms: number;
    max_json_bytes: number;
    max_binary_bytes: number;
  };
  features: {
    streaming_asr: boolean;
    streaming_text: boolean;
    streaming_audio: boolean;
    cancellation: boolean;
  };
  inference_options: {
    defaults: {
      asr: string;
      llm: string;
      tts: string;
      output_audio: string;
    };
    asr: InferenceOption[];
    llm: InferenceOption[];
    tts: InferenceOption[];
    output_audio: OutputAudioOption[];
  };
  recognition_languages?: NamedProtocolOption[];
  voices?: NamedProtocolOption[];
  heartbeat: {
    interval_ms: number;
    timeout_ms: number;
  };
}

export interface RequestAcceptedPayload {
  mode: "dictation" | "assistant";
  language: string;
  selection: {
    asr: string;
    llm: string | null;
    tts: string | null;
    output_audio: string | null;
  };
  voice: string;
  max_recording_ms: number;
}

export interface AsrPartialPayload {
  text: string;
  revision: number;
  stable_prefix_length: number;
}

export interface AsrFinalPayload {
  text: string;
  language: string;
  confidence: number | null;
  duration_ms: number;
}

export interface AssistantTextDeltaPayload {
  sequence: number;
  delta: string;
}

export interface AssistantTextDonePayload {
  text: string;
  last_sequence: number;
  finish_reason: "stop" | "length" | "content_filter";
  usage: {
    input_tokens: number;
    output_tokens: number;
  } | null;
}

export interface OutputAudioStartPayload {
  encoding: "pcm_s16le";
  sample_rate: 16_000 | 24_000;
  channels: 1;
  voice: string;
}

export interface OutputAudioDonePayload {
  last_sequence: number;
  chunk_count: number;
  sample_count: number;
  duration_ms: number;
}

export interface OutputAudioFrame {
  requestId: string;
  sequence: number;
  timestampUs: number;
  samples: Int16Array;
}

export interface ProtocolErrorPayload {
  code: string;
  message: string;
  stage: "session" | "input" | "asr" | "llm" | "tts" | "protocol";
  recoverable: boolean;
  fatal: boolean;
  details?: Record<string, unknown>;
}

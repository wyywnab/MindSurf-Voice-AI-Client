export type VoiceModeV2 = "asr_only" | "asr_llm";

export interface ApiErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details: Record<string, unknown>;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
  app_version: string;
}

export interface AuthorizationCodeInput {
  grant_type: "authorization_code";
  client_id: "mindsurf-desktop";
  code: string;
  code_verifier: string;
  redirect_uri: "mindsurf://auth/callback";
  device: DeviceInfo;
}

export interface TokenPair {
  token_type: "Bearer";
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
}

export interface VoiceUser {
  user_id: string;
  display_name: string;
  login: string;
  status: "active" | "suspended";
  plan: string;
  created_at_ms: number;
}

export interface PolishPromptConstraints {
  max_code_points: number;
  max_utf8_bytes: number;
}

export interface PolishPromptConfiguration {
  revision: string;
  source: "default" | "custom";
  prompt: string;
  updated_at_ms: number;
  constraints: PolishPromptConstraints;
}

export interface PolishPromptResource {
  configuration: PolishPromptConfiguration;
  etag: string;
}

export interface ResourceUsage {
  input_audio_ms: number;
  llm_input_tokens: number;
  llm_output_tokens: number;
  asr_credits_charged: number;
  llm_credits_charged: number;
  credits_charged: number;
}

export interface Quota {
  plan: string;
  pricing_revision: string;
  period: { starts_at_ms: number; ends_at_ms: number };
  credits: { limit: number; used: number; reserved: number; remaining: number };
  usage: ResourceUsage;
}

export interface UsageEntry extends ResourceUsage {
  request_id: string;
  mode: VoiceModeV2;
  settled_at_ms: number;
  pricing_revision: string;
}

export interface NamedOption {
  id: string;
  name: string;
}

export interface GenerationControl {
  type: "number" | "integer";
  minimum: number;
  maximum: number;
  default: number;
}

export interface PipelineCapability {
  id: string;
  name: string;
  description: string;
  modes: VoiceModeV2[];
  max_recording_ms: number;
  asr_options: string[];
  llm_options: string[];
  generation_controls: Record<string, GenerationControl>;
}

export interface ModeDefaultSelection {
  pipeline: string;
  selection: { asr: string; llm: string | null };
}

export interface Capabilities {
  protocol_version: 2;
  revision: string;
  realtime: {
    websocket_path: string;
    ticket_path: "/v2/realtime/tickets";
    subprotocol: "mindsurf.voice.v2";
    persistent: true;
  };
  modes: VoiceModeV2[];
  pipelines: PipelineCapability[];
  asr_options: NamedOption[];
  llm_options: NamedOption[];
  recognition_languages: string[];
  defaults: Record<VoiceModeV2, ModeDefaultSelection>;
}

export interface AuthData {
  tokens: TokenPair;
  user: VoiceUser;
}

export interface RealtimeTicket {
  ticket: string;
  expires_at_ms: number;
  websocket_path: string;
  subprotocol: "mindsurf.voice.v2";
}

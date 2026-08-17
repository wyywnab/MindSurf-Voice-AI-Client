import type {
  V2ClientIdentity,
  V2ControlEnvelope,
  V2ProtocolError,
  V2CancelReason,
  V2InputStatistics,
  V2RequestStartPayload,
  V2ServerHello,
  V2SessionPing,
} from "../../types/realtimeV2";

export const VOICE_SUBPROTOCOL_V2 = "mindsurf.voice.v2";
export const PRE_HELLO_MAX_CONTROL_BYTES = 65_536;

const SERVER_MESSAGE_TYPES = new Set([
  "server.hello",
  "session.ping",
  "request.accepted",
  "input.committed",
  "output.text.delta",
  "output.text.snapshot",
  "request.done",
  "request.cancelled",
  "error",
]);

const REQUEST_MESSAGE_TYPES = new Set([
  "request.accepted",
  "input.committed",
  "output.text.delta",
  "output.text.snapshot",
  "request.done",
  "request.cancelled",
]);

const ERROR_CODES = new Set([
  "invalid_message",
  "unsupported_message_type",
  "protocol_version_mismatch",
  "handshake_required",
  "request_in_progress",
  "request_not_found",
  "request_id_reused",
  "capabilities_stale",
  "pipeline_unavailable",
  "unsupported_mode",
  "invalid_selection",
  "quota_exhausted",
  "rate_limit_exceeded",
  "input_empty",
  "input_idle_timeout",
  "invalid_audio_frame",
  "input_statistics_mismatch",
  "recording_limit_exceeded",
  "asr_failed",
  "llm_failed",
  "request_timeout",
  "upstream_unavailable",
  "session_revoked",
  "server_error",
]);

const ERROR_STAGES = new Set([
  "protocol",
  "authorization",
  "quota",
  "routing",
  "request",
  "input",
  "asr",
  "llm",
  "internal",
]);

export class ProtocolV2Error extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolV2Error";
  }
}

export function createClientHello(identity: V2ClientIdentity) {
  return createSessionEnvelope("client.hello", {
    client: { name: "mindsurf-voice-ai", ...identity },
    protocol_versions: [2],
    input_audio: [{ encoding: "pcm_s16le", sample_rate: 16_000, channels: 1 }],
  });
}

export function createSessionPong(nonce: string) {
  if (!nonce || nonce.length > 256) {
    throw new ProtocolV2Error("invalid_message", "心跳 nonce 无效");
  }
  return createSessionEnvelope("session.pong", { nonce });
}

export function createRequestStart(requestId: string, payload: V2RequestStartPayload) {
  return createRequestEnvelope("request.start", requestId, { ...payload });
}

export function createInputCommit(requestId: string, payload: V2InputStatistics) {
  return createRequestEnvelope("input.commit", requestId, { ...payload });
}

export function createRequestCancel(requestId: string, reason: V2CancelReason) {
  return createRequestEnvelope("request.cancel", requestId, { reason });
}

export function parseServerControlMessage(
  raw: string,
  maxBytes: number,
): V2ControlEnvelope {
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new ProtocolV2Error("control_message_too_large", "控制消息超过协商上限");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolV2Error("invalid_message", "控制消息不是合法 JSON");
  }
  const envelope = record(value, "控制消息");
  exactKeys(
    envelope,
    ["v", "type", "event_id", "request_id", "sent_at_ms", "payload"],
    "控制消息",
  );
  if (
    envelope.v !== 2 ||
    typeof envelope.type !== "string" ||
    !SERVER_MESSAGE_TYPES.has(envelope.type) ||
    !isUuid(envelope.event_id) ||
    (envelope.request_id !== null && !isUuid(envelope.request_id)) ||
    !isNonNegativeInteger(envelope.sent_at_ms)
  ) {
    throw new ProtocolV2Error("invalid_message", "控制消息信封字段无效");
  }
  const payload = record(envelope.payload, "payload");
  const requestScoped = REQUEST_MESSAGE_TYPES.has(envelope.type);
  if (envelope.type !== "error" && requestScoped !== (envelope.request_id !== null)) {
    throw new ProtocolV2Error("invalid_message", "控制消息 scope 无效");
  }
  if (
    (envelope.type === "server.hello" || envelope.type === "session.ping") &&
    envelope.request_id !== null
  ) {
    throw new ProtocolV2Error("invalid_message", "session 消息不能携带 request ID");
  }
  if (envelope.type === "server.hello") parseServerHello(payload);
  if (envelope.type === "session.ping") parseSessionPing(payload);
  if (envelope.type === "error") parseProtocolError(payload, envelope.request_id);
  if (envelope.type === "request.accepted") parseRequestAccepted(payload);
  if (envelope.type === "input.committed") parseInputStatistics(payload);
  if (envelope.type === "output.text.delta") parseTextDelta(payload);
  if (envelope.type === "output.text.snapshot") parseTextSnapshot(payload);
  if (envelope.type === "request.done") parseRequestDone(payload);
  if (envelope.type === "request.cancelled") parseRequestCancelled(payload);
  return {
    v: 2,
    type: envelope.type,
    event_id: envelope.event_id as string,
    request_id: envelope.request_id as string | null,
    sent_at_ms: envelope.sent_at_ms as number,
    payload,
  };
}

export function parseServerHello(value: unknown): V2ServerHello {
  const payload = record(value, "server.hello payload");
  const input = record(payload.input_audio, "server.hello input_audio");
  const limits = record(payload.limits, "server.hello limits");
  if (
    !isUuid(payload.session_id) ||
    payload.protocol_version !== 2 ||
    input.encoding !== "pcm_s16le" ||
    input.sample_rate !== 16_000 ||
    input.channels !== 1 ||
    !isIntegerAtLeast(payload.heartbeat_interval_ms, 1_000) ||
    !isIntegerAtLeast(payload.heartbeat_timeout_ms, 1_000) ||
    !isIntegerAtLeast(payload.input_idle_timeout_ms, 1_000) ||
    (payload.heartbeat_timeout_ms as number) >=
      (payload.heartbeat_interval_ms as number) ||
    !isIntegerAtLeast(limits.max_control_bytes, 1_024) ||
    !isIntegerAtLeast(limits.max_binary_bytes, 50) ||
    !isIntegerAtLeast(limits.max_recording_ms, 1)
  ) {
    throw new ProtocolV2Error("invalid_message", "server.hello 参数无效");
  }
  return payload as unknown as V2ServerHello;
}

export function parseSessionPing(value: unknown): V2SessionPing {
  const payload = record(value, "session.ping payload");
  if (
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 1 ||
    payload.nonce.length > 256
  ) {
    throw new ProtocolV2Error("invalid_message", "session.ping nonce 无效");
  }
  return { nonce: payload.nonce };
}

export function parseProtocolError(
  value: unknown,
  requestId: string | null,
): V2ProtocolError {
  const payload = record(value, "error payload");
  if (
    typeof payload.code !== "string" ||
    !ERROR_CODES.has(payload.code) ||
    typeof payload.message !== "string" ||
    !payload.message ||
    typeof payload.stage !== "string" ||
    !ERROR_STAGES.has(payload.stage) ||
    typeof payload.terminal !== "boolean" ||
    typeof payload.retryable !== "boolean" ||
    typeof payload.fatal !== "boolean" ||
    !isRecord(payload.details)
  ) {
    throw new ProtocolV2Error("invalid_message", "error payload 无效");
  }
  if (requestId === null) {
    if (payload.terminal || payload.usage !== undefined) {
      throw new ProtocolV2Error("invalid_message", "session error 终态字段无效");
    }
  } else if (!payload.terminal || payload.fatal || !isRecord(payload.usage)) {
    throw new ProtocolV2Error("invalid_message", "request error 终态字段无效");
  }
  if (
    payload.code === "session_revoked" &&
    (requestId !== null ||
      payload.stage !== "authorization" ||
      payload.terminal ||
      payload.retryable ||
      !payload.fatal)
  ) {
    throw new ProtocolV2Error("invalid_message", "session_revoked 组合无效");
  }
  const expectedStage = errorStage(payload.code as string);
  if (expectedStage && payload.stage !== expectedStage) {
    throw new ProtocolV2Error("invalid_message", "error stage 与 code 不匹配");
  }
  const alwaysRetryable = new Set([
    "capabilities_stale",
    "pipeline_unavailable",
    "rate_limit_exceeded",
    "asr_failed",
    "llm_failed",
    "request_timeout",
    "upstream_unavailable",
    "server_error",
  ]);
  const neverRetryable = new Set([
    "invalid_message",
    "unsupported_message_type",
    "protocol_version_mismatch",
    "handshake_required",
    "request_in_progress",
    "request_not_found",
    "request_id_reused",
    "unsupported_mode",
    "invalid_selection",
    "quota_exhausted",
    "input_empty",
    "input_idle_timeout",
    "invalid_audio_frame",
    "input_statistics_mismatch",
    "recording_limit_exceeded",
    "session_revoked",
  ]);
  if (
    (alwaysRetryable.has(payload.code) && !payload.retryable) ||
    (neverRetryable.has(payload.code) && payload.retryable)
  ) {
    throw new ProtocolV2Error("invalid_message", "error retryable 与 code 不匹配");
  }
  if (
    (["protocol_version_mismatch", "handshake_required"].includes(payload.code) &&
      (!payload.fatal || requestId !== null)) ||
    (["invalid_message", "unsupported_message_type"].includes(payload.code) &&
      payload.fatal) ||
    (payload.code === "server_error" && requestId === null && !payload.fatal)
  ) {
    throw new ProtocolV2Error("invalid_message", "error fatal 与 scope 不匹配");
  }
  const requestOnly = new Set([
    "request_in_progress",
    "request_not_found",
    "request_id_reused",
    "capabilities_stale",
    "pipeline_unavailable",
    "unsupported_mode",
    "invalid_selection",
    "quota_exhausted",
    "rate_limit_exceeded",
    "invalid_audio_frame",
    "input_empty",
    "input_idle_timeout",
    "input_statistics_mismatch",
    "recording_limit_exceeded",
    "asr_failed",
    "llm_failed",
    "request_timeout",
    "upstream_unavailable",
  ]);
  if (requestOnly.has(payload.code) && requestId === null) {
    throw new ProtocolV2Error("invalid_message", "request error 缺少 request ID");
  }
  if (payload.code === "rate_limit_exceeded") {
    if (!isIntegerAtLeast(payload.details.retry_after_ms, 1)) {
      throw new ProtocolV2Error("invalid_message", "rate limit details 无效");
    }
  }
  if (
    payload.code === "invalid_selection" &&
    (typeof payload.details.field !== "string" || !payload.details.field)
  ) {
    throw new ProtocolV2Error("invalid_message", "invalid selection details 无效");
  }
  if (payload.usage !== undefined) parseUsage(payload.usage);
  return payload as unknown as V2ProtocolError;
}

function parseRequestAccepted(payload: Record<string, unknown>) {
  const removedContextKey = ["conversation", "id"].join("_");
  if ("task" in payload || removedContextKey in payload || "response" in payload) {
    invalidPayload("request.accepted");
  }
  for (const key of [
    "mode",
    "pipeline",
    "capabilities_revision",
    "selection",
    "language",
    "max_recording_ms",
    "quota_reservation",
  ]) {
    if (!(key in payload)) invalidPayload("request.accepted");
  }
  const mode = parseMode(payload.mode);
  if (
    typeof payload.pipeline !== "string" ||
    !payload.pipeline ||
    typeof payload.capabilities_revision !== "string" ||
    !payload.capabilities_revision ||
    typeof payload.language !== "string" ||
    !payload.language ||
    !isIntegerAtLeast(payload.max_recording_ms, 1)
  )
    invalidPayload("request.accepted");
  const selection = parseSelection(payload.selection);
  if (
    (mode === "asr_only" &&
      (selection.llm !== null || payload.generation !== undefined)) ||
    (mode === "asr_llm" && selection.llm === null)
  )
    invalidPayload("request.accepted mode selection");
  if (payload.generation !== undefined) parseGeneration(payload.generation);
  const reservation = record(payload.quota_reservation, "quota reservation");
  exactKeys(
    reservation,
    ["asr_credits", "llm_credits", "credits"],
    "quota reservation",
  );
  if (
    !isNonNegativeInteger(reservation.asr_credits) ||
    !isNonNegativeInteger(reservation.llm_credits) ||
    !isNonNegativeInteger(reservation.credits)
  )
    invalidPayload("quota reservation");
  const asrCredits = reservation.asr_credits as number;
  const llmCredits = reservation.llm_credits as number;
  const credits = reservation.credits as number;
  if (credits !== asrCredits + llmCredits || (mode === "asr_only" && llmCredits !== 0))
    invalidPayload("quota reservation");
}

function parseInputStatistics(payload: Record<string, unknown>) {
  exactKeys(
    payload,
    ["last_sequence", "chunk_count", "sample_count", "duration_ms"],
    "input statistics",
  );
  if (
    !isNonNegativeInteger(payload.last_sequence) ||
    !isIntegerAtLeast(payload.chunk_count, 1) ||
    !isIntegerAtLeast(payload.sample_count, 1) ||
    !isIntegerAtLeast(payload.duration_ms, 1)
  )
    invalidPayload("input statistics");
  if ((payload.last_sequence as number) !== (payload.chunk_count as number) - 1)
    invalidPayload("input statistics");
}

function parseTextDelta(payload: Record<string, unknown>) {
  if (
    (payload.stage !== "asr" && payload.stage !== "llm") ||
    !isNonNegativeInteger(payload.sequence) ||
    typeof payload.delta !== "string"
  )
    invalidPayload("output.text.delta");
}

function parseTextSnapshot(payload: Record<string, unknown>) {
  if (
    (payload.stage !== "asr" && payload.stage !== "llm") ||
    typeof payload.text !== "string" ||
    typeof payload.final !== "boolean" ||
    (payload.stage === "llm" && payload.final === false && payload.text !== "")
  )
    invalidPayload("output.text.snapshot");
}

function parseRequestDone(payload: Record<string, unknown>) {
  if (
    payload.result !== "success" ||
    (payload.mode !== "asr_only" && payload.mode !== "asr_llm") ||
    typeof payload.final_text !== "string"
  )
    invalidPayload("request.done");
  parseUsage(payload.usage);
}

function parseRequestCancelled(payload: Record<string, unknown>) {
  if (
    ![
      "user_cancelled",
      "client_timeout",
      "network_congestion",
      "protocol_error",
    ].includes(payload.reason as string)
  )
    invalidPayload("request.cancelled");
  parseUsage(payload.usage);
}

function parseSelection(value: unknown) {
  const selection = record(value, "selection");
  exactKeys(selection, ["asr", "llm"], "selection");
  if (
    typeof selection.asr !== "string" ||
    !selection.asr ||
    (selection.llm !== null && (typeof selection.llm !== "string" || !selection.llm))
  )
    invalidPayload("selection");
  return selection as { asr: string; llm: string | null };
}

function parseGeneration(value: unknown) {
  const generation = record(value, "generation");
  if (
    Object.values(generation).some(
      (item) => typeof item !== "number" || !Number.isFinite(item),
    )
  )
    invalidPayload("generation");
}

function parseUsage(value: unknown) {
  const usage = record(value, "usage");
  exactKeys(
    usage,
    [
      "input_audio_ms",
      "llm_input_tokens",
      "llm_output_tokens",
      "asr_credits_charged",
      "llm_credits_charged",
      "credits_charged",
    ],
    "usage",
  );
  if (Object.values(usage).some((item) => !isNonNegativeInteger(item)))
    invalidPayload("usage");
  if (
    (usage.credits_charged as number) !==
    (usage.asr_credits_charged as number) + (usage.llm_credits_charged as number)
  )
    invalidPayload("usage");
}

function parseMode(value: unknown) {
  if (value !== "asr_only" && value !== "asr_llm") invalidPayload("mode");
  return value;
}

function errorStage(code: string) {
  if (
    [
      "invalid_message",
      "unsupported_message_type",
      "protocol_version_mismatch",
      "handshake_required",
      "invalid_audio_frame",
    ].includes(code)
  )
    return "protocol";
  if (
    [
      "request_in_progress",
      "request_not_found",
      "request_id_reused",
      "request_timeout",
    ].includes(code)
  )
    return "request";
  if (
    [
      "capabilities_stale",
      "pipeline_unavailable",
      "unsupported_mode",
      "invalid_selection",
      "upstream_unavailable",
    ].includes(code)
  )
    return "routing";
  if (["quota_exhausted", "rate_limit_exceeded"].includes(code)) return "quota";
  if (
    [
      "input_empty",
      "input_idle_timeout",
      "input_statistics_mismatch",
      "recording_limit_exceeded",
    ].includes(code)
  )
    return "input";
  if (code === "asr_failed") return "asr";
  if (code === "llm_failed") return "llm";
  if (code === "server_error") return "internal";
  if (code === "session_revoked") return "authorization";
  return null;
}

function invalidPayload(label: string): never {
  throw new ProtocolV2Error("invalid_message", `${label} payload 无效`);
}

function createSessionEnvelope(type: string, payload: Record<string, unknown>) {
  const envelope: V2ControlEnvelope = {
    v: 2,
    type,
    event_id: globalThis.crypto.randomUUID(),
    request_id: null,
    sent_at_ms: Date.now(),
    payload,
  };
  return envelope;
}

function createRequestEnvelope(
  type: string,
  requestId: string,
  payload: Record<string, unknown>,
) {
  if (!isUuid(requestId)) {
    throw new ProtocolV2Error("invalid_message", "request ID 无效");
  }
  const envelope: V2ControlEnvelope = {
    v: 2,
    type,
    event_id: globalThis.crypto.randomUUID(),
    request_id: requestId,
    sent_at_ms: Date.now(),
    payload,
  };
  return envelope;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProtocolV2Error("invalid_message", `${label} 必须是 object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new ProtocolV2Error("invalid_message", `${label} 顶层字段无效`);
  }
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIntegerAtLeast(value: unknown, minimum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

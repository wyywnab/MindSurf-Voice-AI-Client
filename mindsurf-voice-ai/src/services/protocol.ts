import {
  PROTOCOL_VERSION,
  type AssistantTextDeltaPayload,
  type AssistantTextDonePayload,
  type ControlEnvelope,
  type OutputAudioDonePayload,
  type OutputAudioFrame,
  type OutputAudioStartPayload,
  type ServerHelloPayload,
} from "../types/protocol";

export const AUDIO_HEADER_LENGTH = 48;
export const INPUT_AUDIO_KIND = 0x01;
export const OUTPUT_AUDIO_KIND = 0x02;
export const MAX_JSON_BYTES = 65_536;

export class ProtocolValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProtocolValidationError";
  }
}

export function createControlEnvelope<TPayload>(
  type: string,
  requestId: string | null,
  payload: TPayload,
): ControlEnvelope<TPayload> {
  return {
    v: PROTOCOL_VERSION,
    type,
    event_id: crypto.randomUUID(),
    request_id: requestId,
    sent_at_ms: Date.now(),
    payload,
  };
}

export function parseControlEnvelope(data: string): ControlEnvelope<unknown> {
  if (new TextEncoder().encode(data).byteLength > MAX_JSON_BYTES) {
    throw new ProtocolValidationError("invalid_message", "JSON message exceeds 64 KiB");
  }

  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ProtocolValidationError("invalid_json", "message is not valid JSON");
  }

  if (!isRecord(value)) {
    throw new ProtocolValidationError("invalid_message", "message must be an object");
  }

  if (
    value.v !== PROTOCOL_VERSION ||
    typeof value.type !== "string" ||
    typeof value.event_id !== "string" ||
    !(typeof value.request_id === "string" || value.request_id === null) ||
    typeof value.sent_at_ms !== "number" ||
    !Number.isFinite(value.sent_at_ms) ||
    !isRecord(value.payload)
  ) {
    throw new ProtocolValidationError("invalid_message", "message envelope is invalid");
  }

  return value as unknown as ControlEnvelope<unknown>;
}

export function validateServerHello(
  payload: unknown,
): asserts payload is ServerHelloPayload {
  if (!isRecord(payload)) {
    throw new ProtocolValidationError(
      "invalid_message",
      "server.hello payload is invalid",
    );
  }

  const limits = payload.limits;
  const features = payload.features;
  const heartbeat = payload.heartbeat;
  const options = payload.inference_options;

  if (
    typeof payload.session_id !== "string" ||
    payload.protocol_version !== PROTOCOL_VERSION ||
    payload.pipeline !== "cascade" ||
    !isRecord(limits) ||
    typeof limits.max_recording_ms !== "number" ||
    !isRecord(features) ||
    typeof features.streaming_asr !== "boolean" ||
    !isRecord(heartbeat) ||
    typeof heartbeat.interval_ms !== "number" ||
    typeof heartbeat.timeout_ms !== "number" ||
    !isRecord(options) ||
    !isRecord(options.defaults) ||
    !Array.isArray(options.asr) ||
    !Array.isArray(options.llm) ||
    !Array.isArray(options.tts) ||
    !Array.isArray(options.output_audio)
  ) {
    throw new ProtocolValidationError(
      "invalid_message",
      "server.hello fields are invalid",
    );
  }

  const defaults = options.defaults;
  validateDefaultOption(options.asr, defaults.asr, "asr");
  validateDefaultOption(options.llm, defaults.llm, "llm");
  validateDefaultOption(options.tts, defaults.tts, "tts");
  validateDefaultOption(options.output_audio, defaults.output_audio, "output_audio");
  validateNamedOptions(payload.recognition_languages, "recognition_languages");
  validateNamedOptions(payload.voices, "voices");
}

export function validateAssistantTextDelta(
  payload: unknown,
  expectedSequence: number,
): AssistantTextDeltaPayload {
  if (
    !isRecord(payload) ||
    !Number.isInteger(payload.sequence) ||
    payload.sequence !== expectedSequence ||
    typeof payload.delta !== "string"
  ) {
    throw new ProtocolValidationError(
      "invalid_text_sequence",
      `assistant text delta must have sequence ${expectedSequence}`,
    );
  }
  return payload as unknown as AssistantTextDeltaPayload;
}

export function validateAssistantTextDone(
  payload: unknown,
  lastSequence: number,
): AssistantTextDonePayload {
  if (
    !isRecord(payload) ||
    typeof payload.text !== "string" ||
    !Number.isInteger(payload.last_sequence) ||
    payload.last_sequence !== lastSequence ||
    !["stop", "length", "content_filter"].includes(String(payload.finish_reason)) ||
    !(
      payload.usage === null ||
      (isRecord(payload.usage) &&
        Number.isInteger(payload.usage.input_tokens) &&
        Number.isInteger(payload.usage.output_tokens))
    )
  ) {
    throw new ProtocolValidationError(
      "invalid_text_sequence",
      "assistant text done payload does not match the received stream",
    );
  }
  return payload as unknown as AssistantTextDonePayload;
}

export function encodeInputAudioFrame(
  requestId: string,
  sequence: number,
  timestampUs: number,
  payload: Int16Array,
): ArrayBuffer {
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 0xffff_ffff) {
    throw new RangeError("audio sequence must be a u32");
  }
  if (!Number.isSafeInteger(timestampUs) || timestampUs < 0) {
    throw new RangeError("audio timestamp must be a non-negative safe integer");
  }
  if (payload.length === 0) {
    throw new RangeError("audio payload cannot be empty");
  }

  const payloadLength = payload.length * Int16Array.BYTES_PER_ELEMENT;
  const buffer = new ArrayBuffer(AUDIO_HEADER_LENGTH + payloadLength);
  const view = new DataView(buffer);

  view.setUint8(0, "M".charCodeAt(0));
  view.setUint8(1, "S".charCodeAt(0));
  view.setUint8(2, "V".charCodeAt(0));
  view.setUint8(3, "A".charCodeAt(0));
  view.setUint8(4, PROTOCOL_VERSION);
  view.setUint8(5, INPUT_AUDIO_KIND);
  view.setUint16(6, 0);
  view.setUint16(8, AUDIO_HEADER_LENGTH);
  view.setUint16(10, 0);
  view.setUint32(12, sequence);
  view.setBigUint64(16, BigInt(timestampUs));
  view.setUint32(24, payloadLength);
  view.setUint32(28, 0);

  const requestBytes = uuidToBytes(requestId);
  new Uint8Array(buffer, 32, 16).set(requestBytes);

  for (let index = 0; index < payload.length; index += 1) {
    view.setInt16(
      AUDIO_HEADER_LENGTH + index * Int16Array.BYTES_PER_ELEMENT,
      payload[index] ?? 0,
      true,
    );
  }

  return buffer;
}

export function decodeAudioFrameHeader(buffer: ArrayBuffer) {
  if (buffer.byteLength < AUDIO_HEADER_LENGTH) {
    throw new ProtocolValidationError(
      "invalid_audio_frame",
      "audio frame is shorter than its header",
    );
  }

  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0),
    view.getUint8(1),
    view.getUint8(2),
    view.getUint8(3),
  );
  const headerLength = view.getUint16(8);
  const payloadLength = view.getUint32(24);

  if (
    magic !== "MSVA" ||
    view.getUint8(4) !== PROTOCOL_VERSION ||
    headerLength !== AUDIO_HEADER_LENGTH ||
    buffer.byteLength !== headerLength + payloadLength
  ) {
    throw new ProtocolValidationError(
      "invalid_audio_frame",
      "audio frame header is invalid",
    );
  }

  return {
    kind: view.getUint8(5),
    sequence: view.getUint32(12),
    timestampUs: Number(view.getBigUint64(16)),
    payloadLength,
    requestId: bytesToUuid(new Uint8Array(buffer, 32, 16)),
  };
}

export function decodeOutputAudioFrame(buffer: ArrayBuffer): OutputAudioFrame {
  const header = decodeAudioFrameHeader(buffer);
  if (header.kind !== OUTPUT_AUDIO_KIND) {
    throw new ProtocolValidationError(
      "unsupported_audio_kind",
      "binary frame is not OUTPUT_PCM",
    );
  }
  if (header.payloadLength === 0 || header.payloadLength % 2 !== 0) {
    throw new ProtocolValidationError(
      "invalid_audio_frame",
      "output PCM payload must contain complete 16-bit samples",
    );
  }

  const view = new DataView(buffer);
  const samples = new Int16Array(header.payloadLength / 2);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(AUDIO_HEADER_LENGTH + index * 2, true);
  }

  return {
    requestId: header.requestId,
    sequence: header.sequence,
    timestampUs: header.timestampUs,
    samples,
  };
}

export function validateOutputAudioStart(payload: unknown): OutputAudioStartPayload {
  if (
    !isRecord(payload) ||
    payload.encoding !== "pcm_s16le" ||
    ![16_000, 24_000].includes(Number(payload.sample_rate)) ||
    payload.channels !== 1 ||
    typeof payload.voice !== "string"
  ) {
    throw new ProtocolValidationError(
      "unsupported_audio_format",
      "output audio format is not supported",
    );
  }
  return payload as unknown as OutputAudioStartPayload;
}

export function validateOutputAudioDone(payload: unknown): OutputAudioDonePayload {
  if (
    !isRecord(payload) ||
    typeof payload.last_sequence !== "number" ||
    !Number.isInteger(payload.last_sequence) ||
    typeof payload.chunk_count !== "number" ||
    !Number.isInteger(payload.chunk_count) ||
    typeof payload.sample_count !== "number" ||
    !Number.isInteger(payload.sample_count) ||
    typeof payload.duration_ms !== "number" ||
    payload.last_sequence < 0 ||
    payload.chunk_count !== payload.last_sequence + 1 ||
    payload.sample_count <= 0 ||
    payload.duration_ms <= 0
  ) {
    throw new ProtocolValidationError(
      "invalid_audio_frame",
      "output.audio.done statistics are invalid",
    );
  }
  return payload as unknown as OutputAudioDonePayload;
}

function validateDefaultOption(options: unknown[], defaultId: unknown, name: string) {
  if (
    typeof defaultId !== "string" ||
    !options.some((option) => isRecord(option) && option.id === defaultId)
  ) {
    throw new ProtocolValidationError(
      "invalid_message",
      `server.hello ${name} default is invalid`,
    );
  }
}

function validateNamedOptions(options: unknown, name: string) {
  if (options === undefined) return;
  if (
    !Array.isArray(options) ||
    options.some(
      (option) =>
        !isRecord(option) ||
        typeof option.id !== "string" ||
        typeof option.name !== "string",
    )
  ) {
    throw new ProtocolValidationError("invalid_message", `${name} options are invalid`);
  }
}

function uuidToBytes(uuid: string) {
  const compact = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(compact)) {
    throw new ProtocolValidationError(
      "invalid_message",
      "request_id must be a lowercase UUID",
    );
  }

  return Uint8Array.from(
    compact.match(/.{2}/g)?.map((pair) => Number.parseInt(pair, 16)) ?? [],
  );
}

function bytesToUuid(bytes: Uint8Array) {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

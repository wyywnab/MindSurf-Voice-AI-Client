import type { V2InputStatistics } from "../../types/realtimeV2";

export const INPUT_PCM_HEADER_BYTES = 48;
export const INPUT_PCM_SAMPLE_RATE = 16_000;

export interface InputPcmFrameInput {
  requestId: string;
  sequence: number;
  samplesBefore: number;
  samples: Int16Array;
  maxBinaryBytes: number;
}

export function encodeInputPcmFrame(input: InputPcmFrameInput) {
  const payloadBytes = input.samples.length * 2;
  const totalBytes = INPUT_PCM_HEADER_BYTES + payloadBytes;
  if (
    input.samples.length === 0 ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence < 0 ||
    !Number.isSafeInteger(input.samplesBefore) ||
    input.samplesBefore < 0 ||
    totalBytes > input.maxBinaryBytes
  ) {
    throw new Error("invalid_audio_frame");
  }

  const requestBytes = uuidToBytes(input.requestId);
  const buffer = new ArrayBuffer(totalBytes);
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  bytes.set([0x4d, 0x53, 0x56, 0x41], 0);
  view.setUint8(4, 2);
  view.setUint8(5, 1);
  view.setUint16(6, 0, false);
  view.setUint16(8, INPUT_PCM_HEADER_BYTES, false);
  view.setUint16(10, 0, false);
  view.setUint32(12, input.sequence, false);
  view.setBigUint64(
    16,
    BigInt(Math.floor((input.samplesBefore * 1_000_000) / INPUT_PCM_SAMPLE_RATE)),
    false,
  );
  view.setUint32(24, payloadBytes, false);
  view.setUint32(28, 0, false);
  bytes.set(requestBytes, 32);
  for (let index = 0; index < input.samples.length; index += 1) {
    view.setInt16(INPUT_PCM_HEADER_BYTES + index * 2, input.samples[index]!, true);
  }
  return buffer;
}

export function inputStatistics(
  chunkCount: number,
  sampleCount: number,
): V2InputStatistics {
  if (chunkCount < 1 || sampleCount < 1) throw new Error("input_empty");
  return {
    last_sequence: chunkCount - 1,
    chunk_count: chunkCount,
    sample_count: sampleCount,
    duration_ms: Math.ceil((sampleCount * 1_000) / INPUT_PCM_SAMPLE_RATE),
  };
}

function uuidToBytes(value: string) {
  const compact = value.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(compact)) throw new Error("invalid_request_id");
  return Uint8Array.from(
    compact.match(/.{2}/g)!.map((part: string) => Number.parseInt(part, 16)),
  );
}

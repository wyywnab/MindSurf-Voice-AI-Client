import { describe, expect, it } from "vitest";
import { encodeInputPcmFrame, inputStatistics } from "./inputPcmV2";

const requestId = "00112233-4455-6677-8899-aabbccddeeff";

function hex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

describe("Voice v2 INPUT_PCM", () => {
  it("matches the frozen binary frame vectors", () => {
    expect(
      hex(
        encodeInputPcmFrame({
          requestId,
          sequence: 0,
          samplesBefore: 0,
          samples: new Int16Array([0, 32767]),
          maxBinaryBytes: 65_584,
        }),
      ),
    ).toBe(
      "4d5356410201000000300000000000000000000000000000000000040000000000112233445566778899aabbccddeeff0000ff7f",
    );
    expect(
      hex(
        encodeInputPcmFrame({
          requestId,
          sequence: 1,
          samplesBefore: 2,
          samples: new Int16Array([-1, 256]),
          maxBinaryBytes: 65_584,
        }),
      ),
    ).toBe(
      "4d535641020100000030000000000001000000000000007d000000040000000000112233445566778899aabbccddeeffffff0001",
    );
  });

  it("derives canonical commit statistics and rejects empty input", () => {
    expect(inputStatistics(2, 4)).toEqual({
      last_sequence: 1,
      chunk_count: 2,
      sample_count: 4,
      duration_ms: 1,
    });
    expect(() => inputStatistics(0, 0)).toThrow("input_empty");
  });

  it("rejects frames above the negotiated binary limit", () => {
    expect(() =>
      encodeInputPcmFrame({
        requestId,
        sequence: 0,
        samplesBefore: 0,
        samples: new Int16Array([1]),
        maxBinaryBytes: 49,
      }),
    ).toThrow("invalid_audio_frame");
  });
});

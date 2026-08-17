import { describe, expect, it } from "vitest";
import { parseCapabilities } from "./validators";

function catalog() {
  return {
    protocol_version: 2,
    revision: "cap-1",
    realtime: {
      websocket_path: "/v2/voice/ws",
      ticket_path: "/v2/realtime/tickets",
      subprotocol: "mindsurf.voice.v2",
      persistent: true,
    },
    modes: ["asr_only", "asr_llm"],
    pipelines: [
      {
        id: "opaque",
        name: "Default",
        description: "",
        modes: ["asr_only", "asr_llm"],
        max_recording_ms: 60_000,
        asr_options: ["asr"],
        llm_options: ["llm"],
        generation_controls: {
          temperature: { type: "number", minimum: 0, maximum: 1, default: 0.2 },
        },
      },
    ],
    asr_options: [{ id: "asr", name: "ASR" }],
    llm_options: [{ id: "llm", name: "LLM" }],
    recognition_languages: ["auto"],
    defaults: {
      asr_only: { pipeline: "opaque", selection: { asr: "asr", llm: null } },
      asr_llm: { pipeline: "opaque", selection: { asr: "asr", llm: "llm" } },
    },
  };
}

describe("parseCapabilities", () => {
  it("accepts a complete internally consistent revision", () => {
    expect(parseCapabilities(catalog()).revision).toBe("cap-1");
  });

  it("invalidates the whole revision for dangling references or unknown fields", () => {
    const dangling = catalog();
    dangling.pipelines[0]!.asr_options = ["missing"];
    expect(() => parseCapabilities(dangling)).toThrow();
    expect(() => parseCapabilities({ ...catalog(), extra: true })).toThrow();
  });

  it("rejects an asr_only default carrying an LLM", () => {
    const source = catalog();
    const invalid = {
      ...source,
      defaults: {
        ...source.defaults,
        asr_only: {
          ...source.defaults.asr_only,
          selection: { asr: "asr", llm: "llm" },
        },
      },
    };
    expect(() => parseCapabilities(invalid)).toThrow();
  });
});

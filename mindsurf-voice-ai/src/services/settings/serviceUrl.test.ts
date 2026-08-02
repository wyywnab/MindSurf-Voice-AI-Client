import { describe, expect, it } from "vitest";

import { InvalidServiceUrlError, validateServiceUrl } from "./serviceUrl";

describe("validateServiceUrl", () => {
  it("allows loopback ws and remote wss endpoints", () => {
    expect(validateServiceUrl("ws://127.0.0.1:8000/v1/voice/ws")).toBe(
      "ws://127.0.0.1:8000/v1/voice/ws",
    );
    expect(validateServiceUrl("wss://voice.example.com/v1/voice/ws")).toBe(
      "wss://voice.example.com/v1/voice/ws",
    );
  });

  it("rejects insecure remote endpoints and credential-bearing URLs", () => {
    expect(() => validateServiceUrl("ws://voice.example.com/ws")).toThrow(
      InvalidServiceUrlError,
    );
    expect(() => validateServiceUrl("wss://example.com/ws?token=secret")).toThrow(
      InvalidServiceUrlError,
    );
    expect(() => validateServiceUrl("wss://user:secret@example.com/ws")).toThrow(
      InvalidServiceUrlError,
    );
  });
});

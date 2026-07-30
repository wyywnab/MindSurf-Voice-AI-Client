import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { injectTextIntoForegroundWindow } from "./textInjection";

describe("text injection service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("passes text and the configured limit to the Tauri command", async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      data: {
        requestedCodePoints: 3,
        injectedCodePoints: 3,
        remainingText: "",
        elapsedMs: 2,
        complete: true,
        errorCode: null,
      },
    });

    const result = await injectTextIntoForegroundWindow("中😀\n", 8_000);

    expect(invokeMock).toHaveBeenCalledWith("inject_text", {
      text: "中😀\n",
      maxCodePoints: 8_000,
    });
    expect(result.ok).toBe(true);
  });

  it("returns a recoverable stable error when invoke is unavailable", async () => {
    invokeMock.mockRejectedValue(new Error("not running in Tauri"));

    await expect(injectTextIntoForegroundWindow("text", 8_000)).resolves.toEqual({
      ok: false,
      error: {
        code: "text_injection_unavailable",
        message: "无法调用系统文本注入功能",
        recoverable: true,
      },
    });
  });
});

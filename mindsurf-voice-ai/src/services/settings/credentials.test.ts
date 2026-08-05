import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, isTauri } = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke, isTauri }));

import { clearServiceToken, saveServiceToken } from "./credentials";

describe("credential settings", () => {
  beforeEach(() => {
    invoke.mockReset();
    isTauri.mockReset();
  });

  it("skips token writes in a browser preview", async () => {
    isTauri.mockReturnValue(false);

    await expect(saveServiceToken("local-mock", "secret")).resolves.toBe(false);
    await expect(clearServiceToken("local-mock")).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses desktop credential commands under Tauri", async () => {
    isTauri.mockReturnValue(true);
    invoke
      .mockResolvedValueOnce({ ok: true, data: { configured: true } })
      .mockResolvedValueOnce({ ok: true, data: { configured: false } });

    await expect(saveServiceToken("production", "secret")).resolves.toBe(true);
    await expect(clearServiceToken("production")).resolves.toBe(false);
    expect(invoke).toHaveBeenNthCalledWith(1, "save_service_token", {
      profileId: "production",
      token: "secret",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "clear_service_token", {
      profileId: "production",
    });
  });
});

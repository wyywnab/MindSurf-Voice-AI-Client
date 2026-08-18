import { beforeEach, describe, expect, it, vi } from "vitest";

const autostartMocks = vi.hoisted(() => ({
  disable: vi.fn(),
  enable: vi.fn(),
  isEnabled: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-autostart", () => autostartMocks);

import { isAutostartEnabled, setAutostartEnabled } from "./autostart";

describe("autostart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the system registration state", async () => {
    autostartMocks.isEnabled.mockResolvedValue(true);

    await expect(isAutostartEnabled()).resolves.toBe(true);
  });

  it("enables and disables the system registration", async () => {
    await setAutostartEnabled(true);
    await setAutostartEnabled(false);

    expect(autostartMocks.enable).toHaveBeenCalledTimes(1);
    expect(autostartMocks.disable).toHaveBeenCalledTimes(1);
  });
});

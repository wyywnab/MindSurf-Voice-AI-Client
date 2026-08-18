import { beforeEach, describe, expect, it, vi } from "vitest";

const autostartMocks = vi.hoisted(() => ({
  isAutostartEnabled: vi.fn(),
  setAutostartEnabled: vi.fn(),
}));

vi.mock("../services/autostart", () => autostartMocks);

import { useSettingsStore } from "../stores/settingsStore";
import { SettingsController } from "./settingsController";

describe("SettingsController autostart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the registration state from the operating system", async () => {
    autostartMocks.isAutostartEnabled.mockResolvedValue(true);

    await new SettingsController().refreshAutostart();

    expect(useSettingsStore().state.autostartEnabled).toBe(true);
    expect(useSettingsStore().state.autostartStatus).toBe("ready");
  });

  it("changes and verifies the registration state", async () => {
    autostartMocks.setAutostartEnabled.mockResolvedValue(undefined);
    autostartMocks.isAutostartEnabled.mockResolvedValue(false);

    await expect(new SettingsController().setAutostartEnabled(false)).resolves.toBe(
      true,
    );

    expect(autostartMocks.setAutostartEnabled).toHaveBeenCalledWith(false);
    expect(useSettingsStore().state.autostartEnabled).toBe(false);
  });

  it("surfaces plugin failures without changing the last known state", async () => {
    autostartMocks.setAutostartEnabled.mockRejectedValue(new Error("denied"));

    await expect(new SettingsController().setAutostartEnabled(true)).resolves.toBe(
      false,
    );

    expect(useSettingsStore().state.autostartStatus).toBe("unavailable");
    expect(useSettingsStore().state.autostartError).toContain("denied");
  });

  it("rejects a registration state that does not match the requested value", async () => {
    autostartMocks.setAutostartEnabled.mockResolvedValue(undefined);
    autostartMocks.isAutostartEnabled.mockResolvedValue(false);

    await expect(new SettingsController().setAutostartEnabled(true)).resolves.toBe(
      false,
    );

    expect(useSettingsStore().state.autostartEnabled).toBe(false);
    expect(useSettingsStore().state.autostartStatus).toBe("unavailable");
  });
});

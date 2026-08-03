import { beforeEach, describe, expect, it, vi } from "vitest";

import { settingsStoreActions, useSettingsStore } from "../stores/settingsStore";
import type { ServiceProfile } from "../types/settings";
import { SettingsController } from "./settingsController";

const { clearServiceToken, getCredentialStatus, reconnectWithCurrentSettings } =
  vi.hoisted(() => ({
    clearServiceToken: vi.fn().mockResolvedValue(false),
    getCredentialStatus: vi.fn().mockResolvedValue(false),
    reconnectWithCurrentSettings: vi.fn(),
  }));

vi.mock("../services/settings/credentials", () => ({
  clearServiceToken,
  getCredentialStatus,
  saveServiceToken: vi.fn(),
}));

vi.mock("./voiceRequestController", () => ({
  voiceRequestController: { reconnectWithCurrentSettings },
}));

describe("SettingsController service profile deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the requested profile and protects the final profile", async () => {
    const profile: ServiceProfile = {
      id: "profile-to-delete",
      name: "待删除服务",
      websocketUrl: "wss://voice.example.com/v1/voice/ws",
      autoConnect: false,
      authMode: "none",
      preferredPipeline: "auto",
      createdAt: 1,
      updatedAt: 1,
    };
    settingsStoreActions.addServiceProfile(profile);
    const controller = new SettingsController();

    await controller.deleteServiceProfile(profile.id);

    const settings = useSettingsStore().state;
    expect(settings.serviceProfiles.map((item) => item.id)).toEqual(["local-mock"]);
    expect(settings.activeServiceProfileId).toBe("local-mock");
    expect(clearServiceToken).toHaveBeenCalledWith(profile.id);
    expect(getCredentialStatus).toHaveBeenCalledWith("local-mock");
    expect(reconnectWithCurrentSettings).toHaveBeenCalledOnce();
    await expect(controller.deleteServiceProfile("local-mock")).rejects.toThrow(
      "至少保留一个服务配置",
    );
  });
});

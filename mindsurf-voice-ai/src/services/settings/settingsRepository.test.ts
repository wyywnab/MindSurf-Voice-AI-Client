import { describe, expect, it } from "vitest";

import { DEFAULT_APP_SETTINGS } from "../../types/settings";
import { parseSettings } from "./settingsRepository";

describe("parseSettings", () => {
  it("uses new defaults for an absent or obsolete schema", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(parseSettings({ schemaVersion: 0 })).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("falls back when the active service profile is missing", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.activeServiceProfileId = "missing";
    expect(parseSettings(settings).activeServiceProfileId).toBe("local-mock");
  });

  it("bounds playback volume and injection length", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.audio.playbackVolume = 4;
    settings.interaction.injectionMaxCodePoints = 99_999;
    const parsed = parseSettings(settings);
    expect(parsed.audio.playbackVolume).toBe(1);
    expect(parsed.interaction.injectionMaxCodePoints).toBe(8_000);
  });

  it("loads developer mode only when explicitly enabled", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.developer.enabled = true;
    settings.developer.useWebViewContextMenu = true;
    settings.developer.showDiagnosticsPage = true;
    expect(parseSettings(settings).developer).toEqual({
      enabled: true,
      useWebViewContextMenu: true,
      showDiagnosticsPage: true,
    });

    const legacy = structuredClone(DEFAULT_APP_SETTINGS) as unknown as Record<
      string,
      unknown
    >;
    delete legacy.developer;
    expect(parseSettings(legacy).developer).toEqual(DEFAULT_APP_SETTINGS.developer);
  });

  it("loads a supported interface locale and falls back for legacy settings", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.interface.locale = "en-US";
    expect(parseSettings(settings).interface.locale).toBe("en-US");

    const legacy = structuredClone(DEFAULT_APP_SETTINGS) as unknown as Record<
      string,
      unknown
    >;
    delete legacy.interface;
    expect(parseSettings(legacy).interface.locale).toBe("zh-CN");
  });

  it("keeps valid service profiles and rejects malformed entries", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS) as unknown as Record<
      string,
      unknown
    >;
    settings.serviceProfiles = [
      {
        ...DEFAULT_APP_SETTINGS.serviceProfiles[0],
        id: "production",
        name: "正式服务",
        websocketUrl: "wss://voice.example.com/v1/voice/ws",
      },
      { id: "", name: "无效", websocketUrl: "" },
    ];
    settings.activeServiceProfileId = "production";
    const parsed = parseSettings(settings);
    expect(parsed.activeServiceProfileId).toBe("production");
    expect(parsed.serviceProfiles).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";

import { DEFAULT_APP_SETTINGS } from "../../types/settings";
import { parseSettings } from "./settingsRepository";

describe("parseSettings", () => {
  it("uses v2 defaults for absent or unsupported settings", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(parseSettings({ schemaVersion: 0 })).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("bounds the injection limit and accepts only v2 modes", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.interaction.injectionMaxCodePoints = 99_999;
    settings.interaction.defaultMode = "asr_llm";
    const parsed = parseSettings(settings);
    expect(parsed.interaction.injectionMaxCodePoints).toBe(8_000);
    expect(parsed.interaction.defaultMode).toBe("asr_llm");
  });

  it("accepts supported themes and falls back to the system theme", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.interface.theme = "dark";
    expect(parseSettings(settings).interface.theme).toBe("dark");

    const invalid = structuredClone(settings) as unknown as {
      interface: { theme: string };
    };
    invalid.interface.theme = "sepia";
    expect(parseSettings(invalid).interface.theme).toBe("system");
  });

  it("migrates safe common fields from schema 1 without preserving removed fields", () => {
    const parsed = parseSettings({
      schemaVersion: 1,
      voiceApiOrigin: "https://voice.example.com",
      audio: { inputDeviceId: "microphone" },
      interaction: { injectionMaxCodePoints: 512 },
      overlay: { enabled: false, position: "left" },
      shortcut: { enabled: false, binding: "control+shift+KeyV" },
      interface: { locale: "en-US" },
    });
    expect(parsed).toMatchObject({
      schemaVersion: 2,
      voiceApiOrigin: "https://voice.example.com",
      audio: { inputDeviceId: "microphone" },
      interaction: { defaultMode: "asr_only", injectionMaxCodePoints: 512 },
      overlay: { enabled: false, position: "left" },
      interface: { locale: "en-US", theme: "system" },
    });
    expect(parsed).not.toHaveProperty("serviceProfiles");
    expect(parsed.audio).toEqual({ inputDeviceId: "microphone" });
  });
});

import { describe, expect, it } from "vitest";

import { DEFAULT_APP_SETTINGS } from "../../types/settings";
import { parseSettings } from "./settingsRepository";

describe("parseSettings", () => {
  it("uses new defaults for an absent or obsolete schema", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(parseSettings({ schemaVersion: 0 })).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("never trusts persisted tokenConfigured state", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.service.tokenConfigured = true;
    expect(parseSettings(settings).service.tokenConfigured).toBe(false);
  });

  it("bounds playback volume and injection length", () => {
    const settings = structuredClone(DEFAULT_APP_SETTINGS);
    settings.audio.playbackVolume = 4;
    settings.interaction.injectionMaxCodePoints = 99_999;
    const parsed = parseSettings(settings);
    expect(parsed.audio.playbackVolume).toBe(1);
    expect(parsed.interaction.injectionMaxCodePoints).toBe(8_000);
  });
});

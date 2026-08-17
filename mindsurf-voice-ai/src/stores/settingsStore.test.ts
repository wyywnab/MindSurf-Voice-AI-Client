import { describe, expect, it } from "vitest";

import { settingsStoreActions, useSettingsStore } from "./settingsStore";

describe("settingsStore", () => {
  it("stores v2 modes and injection preferences", () => {
    settingsStoreActions.setMode("asr_llm");
    settingsStoreActions.setAutoInjection("asr_llm", true);
    expect(useSettingsStore().state.selectedMode).toBe("asr_llm");
    expect(useSettingsStore().state.autoInjection.asr_llm).toBe(true);
  });

  it("falls back when the selected microphone disappears", () => {
    settingsStoreActions.setInputDeviceId("removed-device");
    settingsStoreActions.setAudioDevices([
      {
        id: "available-device",
        label: "Available",
        isDefault: true,
        backend: "web_audio",
      },
    ]);
    expect(useSettingsStore().state.inputDeviceId).toBeNull();
  });
});

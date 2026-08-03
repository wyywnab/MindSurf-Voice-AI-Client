import { describe, expect, it } from "vitest";

import type { ServerHelloPayload } from "../types/protocol";
import { settingsStoreActions, useSettingsStore } from "./settingsStore";

describe("settingsStore runtime fallbacks", () => {
  it("stores the developer master switch and its feature toggles separately", () => {
    settingsStoreActions.setDeveloperMode(true);
    settingsStoreActions.setDeveloperUseWebViewContextMenu(true);
    settingsStoreActions.setDeveloperShowDiagnosticsPage(true);

    const settings = useSettingsStore().state;
    expect(settings.developerModeEnabled).toBe(true);
    expect(settings.developerUseWebViewContextMenu).toBe(true);
    expect(settings.developerShowDiagnosticsPage).toBe(true);
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
    expect(useSettingsStore().state.audioDevicesError).toContain("系统默认设备");
  });

  it("falls back to advertised language, voice and inference defaults", () => {
    settingsStoreActions.setLanguage("removed-language");
    settingsStoreActions.setVoice("removed-voice");
    settingsStoreActions.hydrateInferenceSelections(serverHello());
    const settings = useSettingsStore().state;
    expect(settings.language).toBe("zh-CN");
    expect(settings.voice).toBe("voice-default");
    expect(settings.selectedAsrId).toBe("asr-default");
  });
});

function serverHello(): ServerHelloPayload {
  return {
    session_id: crypto.randomUUID(),
    protocol_version: 1,
    pipeline: "cascade",
    limits: {
      max_recording_ms: 60_000,
      max_json_bytes: 65_536,
      max_binary_bytes: 65_536,
    },
    features: {
      streaming_asr: true,
      streaming_text: true,
      streaming_audio: true,
      cancellation: true,
    },
    inference_options: {
      defaults: {
        asr: "asr-default",
        llm: "llm-default",
        tts: "tts-default",
        output_audio: "audio-default",
      },
      asr: [{ id: "asr-default", name: "ASR", description: "Default" }],
      llm: [{ id: "llm-default", name: "LLM", description: "Default" }],
      tts: [{ id: "tts-default", name: "TTS", description: "Default" }],
      output_audio: [
        {
          id: "audio-default",
          name: "Audio",
          description: "Default",
          encoding: "pcm_s16le",
          sample_rate: 24_000,
          channels: 1,
        },
      ],
    },
    recognition_languages: [{ id: "zh-CN", name: "简体中文" }],
    voices: [{ id: "voice-default", name: "默认音色" }],
    heartbeat: { interval_ms: 15_000, timeout_ms: 10_000 },
  };
}

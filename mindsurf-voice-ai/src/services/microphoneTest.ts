import { invoke, isTauri } from "@tauri-apps/api/core";

import type { CommandResult } from "../types/app";
import { getNativeAudioRecordingMeter } from "./nativeRecorder";

const TEST_DURATION_MS = 1_500;

export async function runMicrophoneTest(
  inputDeviceId: string | null,
  onLevel: (level: number) => void,
) {
  if (
    isTauri() &&
    /Macintosh|Mac OS X/.test(navigator.userAgent) &&
    (!inputDeviceId || inputDeviceId === "default")
  ) {
    const started = await invoke<CommandResult<void>>("start_native_audio_recording");
    if (!started.ok) throw new Error(started.error.message);
    try {
      const startedAt = performance.now();
      while (performance.now() - startedAt < TEST_DURATION_MS) {
        const meter = await getNativeAudioRecordingMeter();
        onLevel(meter?.level ?? 0);
        await delay(50);
      }
    } finally {
      await invoke("cancel_native_audio_recording");
      onLevel(0);
    }
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio:
      inputDeviceId && inputDeviceId !== "default"
        ? { deviceId: { exact: inputDeviceId } }
        : true,
    video: false,
  });
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  const samples = new Float32Array(analyser.fftSize);
  source.connect(analyser);
  try {
    const startedAt = performance.now();
    while (performance.now() - startedAt < TEST_DURATION_MS) {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      onLevel(Math.min(1, Math.sqrt(sum / samples.length) * 4));
      await delay(50);
    }
  } finally {
    source.disconnect();
    for (const track of stream.getTracks()) track.stop();
    await context.close();
    onLevel(0);
  }
}

function delay(durationMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
}

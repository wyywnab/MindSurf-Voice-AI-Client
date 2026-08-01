import { invoke } from "@tauri-apps/api/core";

import { createPcm16Wav, float32ToPcm16, TARGET_SAMPLE_RATE } from "../audio/pcm";
import { StreamingLinearResampler } from "../audio/resampler";
import type { CommandResult } from "../types/app";
import type { RecorderCallbacks, RecordingResult } from "./recorder";

interface NativeRecordingPayload {
  durationMs: number;
  frameCount: number;
  pcmSamples: number[];
  sampleCount: number;
  sampleRate: number;
  wavBytes: number[];
}

export interface NativeRecordingMeter {
  active: boolean;
  durationMs: number;
  level: number;
}

const SAMPLES_PER_FRAME = TARGET_SAMPLE_RATE / 50;
const METER_UPDATE_INTERVAL_MS = 33;

export async function getNativeAudioRecordingLevel() {
  const meter = await getNativeAudioRecordingMeter();
  return meter?.level ?? null;
}

export async function getNativeAudioRecordingMeter() {
  try {
    const result = await invoke<CommandResult<NativeRecordingMeter>>(
      "native_audio_recording_meter",
    );
    if (!result.ok) {
      return null;
    }
    return {
      ...result.data,
      durationMs: Math.max(0, result.data.durationMs),
      level: Math.max(0, Math.min(1, result.data.level)),
    };
  } catch {
    return null;
  }
}

export class NativeMicrophoneRecorder {
  private acceptingAudio = false;
  private callbacks: RecorderCallbacks = {};
  private durationTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private levelPollInFlight = false;
  private prepared = false;
  private startedAt = 0;

  get isRecording() {
    return this.acceptingAudio;
  }

  get isPrepared() {
    return this.prepared;
  }

  async prepare() {
    if (this.acceptingAudio) {
      throw new Error("recording_already_active");
    }
    this.prepared = true;
  }

  async start(callbacks: RecorderCallbacks = {}) {
    if (this.acceptingAudio) {
      throw new Error("recording_already_active");
    }

    const result = await invoke<CommandResult<void>>("start_native_audio_recording");
    if (!result.ok) {
      this.prepared = false;
      throw new Error(result.error.message);
    }

    this.callbacks = callbacks;
    this.acceptingAudio = true;
    this.prepared = true;
    this.startedAt = performance.now();
    this.durationTimer = globalThis.setInterval(() => {
      this.callbacks.onDuration?.(performance.now() - this.startedAt);
      void this.pollLevel();
    }, METER_UPDATE_INTERVAL_MS);
    void this.pollLevel();
  }

  async stop(): Promise<RecordingResult> {
    if (!this.acceptingAudio) {
      throw new Error("recording_not_active");
    }

    this.acceptingAudio = false;
    this.clearDurationTimer();
    const result = await invoke<CommandResult<NativeRecordingPayload>>(
      "stop_native_audio_recording",
    );
    this.prepared = false;
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const pcm = normalizeSampleRate(result.data.pcmSamples, result.data.sampleRate);
    let frameCount = 0;
    for (let offset = 0; offset < pcm.length; offset += SAMPLES_PER_FRAME) {
      this.callbacks.onFrame?.(
        pcm.slice(offset, Math.min(offset + SAMPLES_PER_FRAME, pcm.length)),
        frameCount,
      );
      frameCount += 1;
    }

    const durationMs = (pcm.length / TARGET_SAMPLE_RATE) * 1_000;
    this.callbacks.onDuration?.(durationMs);
    this.callbacks.onLevel?.(0);
    this.callbacks = {};
    const wavBytes =
      result.data.sampleRate === TARGET_SAMPLE_RATE
        ? Uint8Array.from(result.data.wavBytes)
        : createPcm16Wav([pcm]);

    return {
      durationMs,
      frameCount,
      liveTracksAfterCleanup: 0,
      sampleCount: pcm.length,
      sampleRate: TARGET_SAMPLE_RATE,
      sourceSampleRate: result.data.sampleRate,
      wavBytes,
    };
  }

  async cancel() {
    this.acceptingAudio = false;
    this.prepared = false;
    this.clearDurationTimer();
    this.callbacks.onDuration?.(0);
    this.callbacks.onLevel?.(0);
    this.callbacks = {};
    try {
      await invoke("cancel_native_audio_recording");
    } catch {
      // Browser previews and older native builds do not expose this command.
    }
  }

  async dispose() {
    await this.cancel();
  }

  private clearDurationTimer() {
    if (this.durationTimer) {
      globalThis.clearInterval(this.durationTimer);
      this.durationTimer = null;
    }
  }

  private async pollLevel() {
    if (!this.acceptingAudio || this.levelPollInFlight) {
      return;
    }

    this.levelPollInFlight = true;
    try {
      const level = await getNativeAudioRecordingLevel();
      if (this.acceptingAudio && level !== null) {
        this.callbacks.onLevel?.(level);
      }
    } catch {
      // Metering is cosmetic; recording must continue if a level poll fails.
    } finally {
      this.levelPollInFlight = false;
    }
  }
}

function normalizeSampleRate(samples: number[], sampleRate: number) {
  const source = Int16Array.from(samples);
  if (sampleRate === TARGET_SAMPLE_RATE) {
    return source;
  }

  const input = Float32Array.from(source, (sample) => sample / 32_768);
  const resampler = new StreamingLinearResampler(sampleRate, TARGET_SAMPLE_RATE);
  const body = resampler.process(input);
  const tail = resampler.flush();
  const combined = new Float32Array(body.length + tail.length);
  combined.set(body);
  combined.set(tail, body.length);
  return float32ToPcm16(combined);
}

import {
  PcmFrameAssembler,
  TARGET_SAMPLE_RATE,
  createPcm16Wav,
  float32ToPcm16,
} from "../audio/pcm";
import { StreamingLinearResampler } from "../audio/resampler";

export interface RecorderCallbacks {
  onDuration?: (durationMs: number) => void;
  onFrame?: (frame: Int16Array, sequence: number) => void;
  onLevel?: (level: number) => void;
}

export interface RecordingResult {
  durationMs: number;
  frameCount: number;
  liveTracksAfterCleanup: number;
  sampleCount: number;
  sampleRate: number;
  sourceSampleRate: number;
  wavBytes: Uint8Array;
}

export const MICROPHONE_ACCESS_CHANGED_EVENT = "mindsurf:microphone-access-changed";

export type MicrophoneAccessState = "unknown" | "checking" | "ready" | "failed";

let microphoneAccessState: MicrophoneAccessState = "unknown";

export function getMicrophoneAccessState(): MicrophoneAccessState {
  return microphoneAccessState;
}

function setMicrophoneAccessState(state: MicrophoneAccessState) {
  if (microphoneAccessState === state) return;
  microphoneAccessState = state;
  if (typeof globalThis.dispatchEvent === "function") {
    globalThis.dispatchEvent(new Event(MICROPHONE_ACCESS_CHANGED_EVENT));
  }
}

export function observedMicrophonePermission(state: PermissionState): PermissionState {
  // WebView2 can report `granted` before this unpackaged desktop app has ever
  // attempted capture. Treat that as permission to ask, not proof of access.
  return state === "granted" && microphoneAccessState !== "ready" ? "prompt" : state;
}

export async function prepareMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setMicrophoneAccessState("failed");
    throw new Error("media_devices_unavailable");
  }

  setMicrophoneAccessState("checking");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: false,
    });
    setMicrophoneAccessState("ready");
  } catch (error) {
    setMicrophoneAccessState("failed");
    throw error;
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

export function describeRecorderError(
  error: unknown,
  context: { nativePermissionGranted?: boolean } = {},
) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError") {
      if (context.nativePermissionGranted) {
        return "macOS 已允许麦克风，但 WebView 无法取得音频流，请重启应用后重试。";
      }
      return "麦克风权限被拒绝，请在系统设置中允许访问后重试。";
    }
    if (error.name === "NotFoundError") {
      return "没有找到可用的麦克风设备。";
    }
    if (error.name === "NotReadableError") {
      return "麦克风正被其他应用占用，或设备暂时不可用。";
    }
  }

  if (error instanceof Error && error.message === "media_devices_unavailable") {
    return "当前运行环境不支持麦克风采集。";
  }

  return "录音初始化失败，请检查麦克风和系统权限后重试。";
}

export class MicrophoneRecorder {
  private acceptingAudio = false;
  private audioContext: AudioContext | null = null;
  private callbacks: RecorderCallbacks = {};
  private frameAssembler = new PcmFrameAssembler();
  private frameCount = 0;
  private pcmChunks: Int16Array[] = [];
  private processor: AudioWorkletNode | null = null;
  private resampler: StreamingLinearResampler | null = null;
  private silentOutput: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private totalSamples = 0;
  private inputDeviceId: string | null = null;

  get isRecording() {
    return this.acceptingAudio;
  }

  get isPrepared() {
    return Boolean(
      this.stream &&
      this.stream.getTracks().some((track) => track.readyState === "live") &&
      this.audioContext &&
      this.audioContext.state !== "closed" &&
      this.source &&
      this.processor &&
      this.silentOutput &&
      this.resampler,
    );
  }

  async prepare(inputDeviceId: string | null = null) {
    if (this.acceptingAudio) {
      throw new Error("recording_already_active");
    }
    if (this.isPrepared && this.inputDeviceId === inputDeviceId) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneAccessState("failed");
      throw new Error("media_devices_unavailable");
    }

    setMicrophoneAccessState("checking");
    try {
      if (
        this.stream ||
        this.audioContext ||
        this.source ||
        this.processor ||
        this.silentOutput
      ) {
        await this.cleanup();
      }
      this.inputDeviceId = inputDeviceId;
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(inputDeviceId && inputDeviceId !== "default"
            ? { deviceId: { exact: inputDeviceId } }
            : {}),
          channelCount: { ideal: 1 },
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      setMicrophoneAccessState("ready");

      this.audioContext = new AudioContext({ latencyHint: "interactive" });
      await this.audioContext.audioWorklet.addModule(
        new URL("audio/pcm-capture.worklet.js", document.baseURI).href,
      );

      this.resampler = new StreamingLinearResampler(
        this.audioContext.sampleRate,
        TARGET_SAMPLE_RATE,
      );
      this.source = this.audioContext.createMediaStreamSource(this.stream);
      this.processor = new AudioWorkletNode(this.audioContext, "mindsurf-pcm-capture", {
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.silentOutput = this.audioContext.createGain();
      this.silentOutput.gain.value = 0;
      this.processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
        this.handleAudioChunk(event.data);
      };

      this.source
        .connect(this.processor)
        .connect(this.silentOutput)
        .connect(this.audioContext.destination);
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
    } catch (error) {
      setMicrophoneAccessState("failed");
      await this.cleanup();
      throw error;
    }
  }

  async start(callbacks: RecorderCallbacks = {}) {
    if (this.acceptingAudio) {
      throw new Error("recording_already_active");
    }
    if (!this.isPrepared) {
      await this.prepare();
    }

    this.resetSession();
    this.resampler = new StreamingLinearResampler(
      this.audioContext!.sampleRate,
      TARGET_SAMPLE_RATE,
    );
    this.callbacks = callbacks;
    this.acceptingAudio = true;
  }

  async stop(): Promise<RecordingResult> {
    if (!this.acceptingAudio || !this.audioContext || !this.resampler) {
      throw new Error("recording_not_active");
    }

    this.acceptingAudio = false;
    const sourceSampleRate = this.audioContext.sampleRate;
    this.appendResampled(this.resampler.flush());
    const finalFrame = this.frameAssembler.takePending();
    if (finalFrame.length > 0) {
      this.callbacks.onFrame?.(finalFrame, this.frameCount);
      this.frameCount += 1;
    }
    const wavBytes = createPcm16Wav(this.pcmChunks);
    const liveTracksAfterCleanup = await this.cleanup();
    this.callbacks.onLevel?.(0);
    this.callbacks = {};

    return {
      durationMs: (this.totalSamples / TARGET_SAMPLE_RATE) * 1_000,
      frameCount: this.frameCount,
      liveTracksAfterCleanup,
      sampleCount: this.totalSamples,
      sampleRate: TARGET_SAMPLE_RATE,
      sourceSampleRate,
      wavBytes,
    };
  }

  async cancel() {
    this.acceptingAudio = false;
    await this.cleanup();
    this.resetSession();
    this.callbacks.onLevel?.(0);
    this.callbacks.onDuration?.(0);
    this.callbacks = {};
  }

  async dispose() {
    this.acceptingAudio = false;
    this.resetSession();
    this.callbacks = {};
    await this.cleanup();
  }

  private handleAudioChunk(input: Float32Array) {
    if (!this.acceptingAudio || !this.resampler) {
      return;
    }

    let sumOfSquares = 0;
    for (const sample of input) {
      sumOfSquares += sample * sample;
    }
    const rms = input.length > 0 ? Math.sqrt(sumOfSquares / input.length) : 0;
    this.callbacks.onLevel?.(Math.min(1, rms * 4));

    this.appendResampled(this.resampler.process(input));
  }

  private appendResampled(samples: Float32Array) {
    if (samples.length === 0) {
      return;
    }

    const pcm = float32ToPcm16(samples);
    this.pcmChunks.push(pcm);
    this.totalSamples += pcm.length;

    for (const frame of this.frameAssembler.push(pcm)) {
      this.callbacks.onFrame?.(frame, this.frameCount);
      this.frameCount += 1;
    }

    this.callbacks.onDuration?.((this.totalSamples / TARGET_SAMPLE_RATE) * 1_000);
  }

  private async cleanup() {
    const tracks = this.stream?.getTracks() ?? [];

    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.disconnect();
    }
    this.source?.disconnect();
    this.silentOutput?.disconnect();

    for (const track of tracks) {
      track.stop();
    }

    if (this.audioContext && this.audioContext.state !== "closed") {
      await this.audioContext.close();
    }

    this.processor = null;
    this.source = null;
    this.silentOutput = null;
    this.audioContext = null;
    this.stream = null;
    this.resampler = null;

    return tracks.filter((track) => track.readyState === "live").length;
  }

  private resetSession() {
    this.frameAssembler.reset();
    this.frameCount = 0;
    this.pcmChunks = [];
    this.totalSamples = 0;
  }
}

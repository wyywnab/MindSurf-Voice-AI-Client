import type {
  OutputAudioDonePayload,
  OutputAudioFrame,
  OutputAudioStartPayload,
} from "../types/protocol";
import type { PlaybackMetrics, PlaybackStatus } from "../types/voice";

const START_BUFFER_MS = 160;
const SCHEDULE_LEAD_SECONDS = 0.04;

export interface StreamingAudioPlayerCallbacks {
  onError: (message: string) => void;
  onMetrics: (metrics: PlaybackMetrics) => void;
  onStatusChange: (status: PlaybackStatus) => void;
}

export class StreamingAudioPlayer {
  private activeSources = new Set<AudioBufferSourceNode>();
  private context: AudioContext | null = null;
  private expectedSequence = 0;
  private format: OutputAudioStartPayload | null = null;
  private generation = 0;
  private metrics = emptyMetrics();
  private outputGain: GainNode | null = null;
  private volume = 1;
  private nextStartTime = 0;
  private outputDone = false;
  private pendingFrames = new Map<number, OutputAudioFrame>();
  private queuedFrames: OutputAudioFrame[] = [];
  private queuedSamples = 0;
  private requestId: string | null = null;
  private started = false;

  constructor(private readonly callbacks: StreamingAudioPlayerCallbacks) {}

  prepare() {
    try {
      this.context ??= new AudioContext({ latencyHint: "interactive" });
      if (!this.outputGain) {
        this.outputGain = this.context.createGain();
        this.outputGain.gain.value = this.volume;
        this.outputGain.connect(this.context.destination);
      }
      void this.context.resume().catch(() => {
        this.fail("无法启动音频输出，请检查系统播放设备");
      });
      return true;
    } catch {
      this.fail("当前环境不支持流式音频播放");
      return false;
    }
  }

  start(requestId: string, format: OutputAudioStartPayload) {
    this.stop("stopped");
    this.generation += 1;
    this.requestId = requestId;
    this.format = format;
    this.metrics = emptyMetrics();
    this.expectedSequence = 0;
    this.outputDone = false;
    this.started = false;
    this.callbacks.onMetrics({ ...this.metrics });
    this.callbacks.onStatusChange("buffering");

    this.prepare();
  }

  enqueue(frame: OutputAudioFrame) {
    if (!this.format || frame.requestId !== this.requestId || this.outputDone) {
      return;
    }
    if (
      frame.sequence < this.expectedSequence ||
      this.pendingFrames.has(frame.sequence)
    ) {
      this.fail(`收到重复的语音分片 sequence=${frame.sequence}`);
      return;
    }

    this.metrics.firstChunkAt ??= Date.now();
    this.metrics.receivedChunks += 1;
    this.metrics.receivedSamples += frame.samples.length;
    this.pendingFrames.set(frame.sequence, frame);
    this.drainOrderedFrames();
    this.callbacks.onMetrics({ ...this.metrics });
  }

  finish(payload: OutputAudioDonePayload) {
    if (!this.format || !this.requestId) {
      this.fail("收到语音结束消息前未初始化播放流");
      return;
    }
    if (
      payload.chunk_count !== this.metrics.receivedChunks ||
      payload.sample_count !== this.metrics.receivedSamples ||
      payload.last_sequence !== this.expectedSequence - 1 ||
      this.pendingFrames.size > 0
    ) {
      this.fail("语音结束统计与已接收分片不一致");
      return;
    }

    this.outputDone = true;
    this.scheduleQueuedFrames(true);
    this.completeIfReady();
  }

  stop(status: PlaybackStatus = "stopped") {
    this.generation += 1;
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // The source may already have reached its natural end.
      }
      source.disconnect();
    }
    this.activeSources.clear();
    this.pendingFrames.clear();
    this.queuedFrames = [];
    this.queuedSamples = 0;
    this.requestId = null;
    this.format = null;
    this.outputDone = false;
    this.started = false;
    this.nextStartTime = 0;
    if (status !== "stopped" || this.metrics.firstChunkAt !== null) {
      this.callbacks.onStatusChange(status);
    }
  }

  dispose() {
    this.stop("idle");
    this.outputGain?.disconnect();
    this.outputGain = null;
    void this.context?.close();
    this.context = null;
  }

  setVolume(volume: number) {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.outputGain) this.outputGain.gain.value = this.volume;
  }

  private drainOrderedFrames() {
    while (this.pendingFrames.has(this.expectedSequence)) {
      const frame = this.pendingFrames.get(this.expectedSequence);
      if (!frame) {
        break;
      }
      this.pendingFrames.delete(this.expectedSequence);
      this.queuedFrames.push(frame);
      this.queuedSamples += frame.samples.length;
      this.expectedSequence += 1;
    }
    this.scheduleQueuedFrames(false);
  }

  private scheduleQueuedFrames(force: boolean) {
    const context = this.context;
    const format = this.format;
    if (!context || !format || this.queuedFrames.length === 0) {
      return;
    }

    const bufferedMs = (this.queuedSamples / format.sample_rate) * 1_000;
    if (!this.started && !force && bufferedMs < START_BUFFER_MS) {
      return;
    }

    if (!this.started) {
      this.started = true;
      this.metrics.playbackStartedAt = Date.now();
      this.nextStartTime = context.currentTime + SCHEDULE_LEAD_SECONDS;
      this.callbacks.onStatusChange("playing");
      this.callbacks.onMetrics({ ...this.metrics });
    } else if (this.nextStartTime <= context.currentTime + 0.005) {
      this.metrics.underrunCount += 1;
      this.started = false;
      this.nextStartTime = 0;
      this.callbacks.onStatusChange("buffering");
      this.callbacks.onMetrics({ ...this.metrics });
      if (!force && bufferedMs < START_BUFFER_MS) {
        return;
      }
      this.started = true;
      this.metrics.playbackStartedAt ??= Date.now();
      this.nextStartTime = context.currentTime + SCHEDULE_LEAD_SECONDS;
      this.callbacks.onStatusChange("playing");
    }

    const generation = this.generation;
    for (const frame of this.queuedFrames) {
      const buffer = context.createBuffer(1, frame.samples.length, format.sample_rate);
      const channel = buffer.getChannelData(0);
      for (let index = 0; index < frame.samples.length; index += 1) {
        channel[index] = (frame.samples[index] ?? 0) / 32_768;
      }

      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.outputGain ?? context.destination);
      source.onended = () => {
        source.disconnect();
        if (generation !== this.generation) {
          return;
        }
        this.activeSources.delete(source);
        this.completeIfReady();
      };
      this.activeSources.add(source);
      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;
    }
    this.queuedFrames = [];
    this.queuedSamples = 0;
  }

  private completeIfReady() {
    if (
      !this.outputDone ||
      this.pendingFrames.size > 0 ||
      this.queuedFrames.length > 0 ||
      this.activeSources.size > 0
    ) {
      return;
    }
    this.metrics.playbackCompletedAt = Date.now();
    this.callbacks.onMetrics({ ...this.metrics });
    this.callbacks.onStatusChange("done");
    this.requestId = null;
    this.format = null;
  }

  private fail(message: string) {
    this.callbacks.onError(message);
    this.stop("error");
  }
}

function emptyMetrics(): PlaybackMetrics {
  return {
    firstChunkAt: null,
    playbackStartedAt: null,
    playbackCompletedAt: null,
    receivedChunks: 0,
    receivedSamples: 0,
    underrunCount: 0,
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeRecorderError,
  getMicrophoneAccessState,
  MicrophoneRecorder,
  observedMicrophonePermission,
  prepareMicrophone,
} from "./recorder";

class FakeTrack {
  readyState: MediaStreamTrackState = "live";

  stop() {
    this.readyState = "ended";
  }
}

class FakeStream {
  readonly track = new FakeTrack();

  getTracks() {
    return [this.track] as unknown as MediaStreamTrack[];
  }
}

class FakeAudioNode {
  connect<T>(node: T) {
    return node;
  }

  disconnect() {}
}

class FakeGainNode extends FakeAudioNode {
  gain = { value: 1 };
}

class FakeAudioWorkletNode extends FakeAudioNode {
  port = {
    onmessage: null as ((event: MessageEvent<Float32Array>) => void) | null,
  };
}

class FakeAudioContext {
  readonly audioWorklet = {
    addModule: vi.fn(async () => undefined),
  };
  readonly destination = new FakeAudioNode();
  readonly sampleRate = 48_000;
  state: AudioContextState = "running";

  createGain() {
    return new FakeGainNode();
  }

  createMediaStreamSource() {
    return new FakeAudioNode();
  }

  async close() {
    this.state = "closed";
  }

  async resume() {
    this.state = "running";
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MicrophoneRecorder cleanup", () => {
  it("does not report WebView2 preflight access as granted before capture", () => {
    expect(getMicrophoneAccessState()).toBe("unknown");
    expect(observedMicrophonePermission("granted")).toBe("prompt");
  });

  it("prepares microphone access and immediately releases every track", async () => {
    const stream = new FakeStream();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await prepareMicrophone();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(stream.track.readyState).toBe("ended");
    expect(getMicrophoneAccessState()).toBe("ready");
    expect(observedMicrophonePermission("granted")).toBe("granted");
  });

  it("distinguishes native denial from a WebView capture failure", () => {
    const error = new DOMException("not allowed", "NotAllowedError");

    expect(describeRecorderError(error)).toContain("权限被拒绝");
    expect(describeRecorderError(error, { nativePermissionGranted: true })).toContain(
      "WebView 无法取得音频流",
    );
  });

  it("prepares the audio pipeline before recording without opening a second stream", async () => {
    const stream = new FakeStream();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("document", { baseURI: "http://localhost/" });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const recorder = new MicrophoneRecorder();
    await recorder.prepare();

    expect(recorder.isPrepared).toBe(true);
    expect(recorder.isRecording).toBe(false);

    await recorder.start();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(recorder.isRecording).toBe(true);

    await recorder.stop();
    expect(recorder.isPrepared).toBe(false);

    await recorder.dispose();
    expect(recorder.isPrepared).toBe(false);
  });

  it("releases every stream between recording cycles", async () => {
    vi.stubGlobal("document", { baseURI: "http://localhost/" });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    const streams: FakeStream[] = [];
    const getUserMedia = vi.fn(async () => {
      const stream = new FakeStream();
      streams.push(stream);
      return stream;
    });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    const recorder = new MicrophoneRecorder();

    for (let cycle = 0; cycle < 20; cycle += 1) {
      await recorder.start();
      expect(recorder.isRecording).toBe(true);

      const result = await recorder.stop();
      expect(result.liveTracksAfterCleanup).toBe(0);
      expect(recorder.isRecording).toBe(false);
      expect(recorder.isPrepared).toBe(false);
    }

    expect(getUserMedia).toHaveBeenCalledTimes(20);
    expect(streams.every((stream) => stream.track.readyState === "ended")).toBe(true);
    await recorder.dispose();
    expect(recorder.isPrepared).toBe(false);
  });
});

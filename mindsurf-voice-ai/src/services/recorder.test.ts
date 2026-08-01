import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeRecorderError,
  MicrophoneRecorder,
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
  it("prepares microphone access and immediately releases every track", async () => {
    const stream = new FakeStream();
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    await prepareMicrophone();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: false });
    expect(stream.track.readyState).toBe("ended");
  });

  it("distinguishes native denial from a WebView capture failure", () => {
    const error = new DOMException("not allowed", "NotAllowedError");

    expect(describeRecorderError(error)).toContain("权限被拒绝");
    expect(describeRecorderError(error, { nativePermissionGranted: true })).toContain(
      "WebView 无法取得音频流",
    );
  });

  it("releases every MediaStream track over twenty recording cycles", async () => {
    vi.stubGlobal("document", { baseURI: "http://localhost/" });
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeStream()),
      },
    });

    const recorder = new MicrophoneRecorder();

    for (let cycle = 0; cycle < 20; cycle += 1) {
      await recorder.start();
      expect(recorder.isRecording).toBe(true);

      const result = await recorder.stop();
      expect(result.liveTracksAfterCleanup).toBe(0);
      expect(recorder.isRecording).toBe(false);
    }
  });
});

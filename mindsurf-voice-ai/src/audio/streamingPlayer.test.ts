import { afterEach, describe, expect, it, vi } from "vitest";

import { StreamingAudioPlayer } from "./streamingPlayer";

const requestId = "019c8db8-0fff-781f-8329-cc2f48c65013";

class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt = -1;
  stopped = false;

  connect() {}
  disconnect() {}

  start(when: number) {
    this.startedAt = when;
  }

  stop() {
    this.stopped = true;
  }
}

class FakeAudioContext {
  currentTime = 1;
  destination = {};
  sources: FakeSource[] = [];

  close() {
    return Promise.resolve();
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect: () => undefined,
      disconnect: () => undefined,
    };
  }

  createBuffer(_channels: number, length: number, sampleRate: number) {
    return {
      duration: length / sampleRate,
      getChannelData: () => new Float32Array(length),
    };
  }

  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }

  resume() {
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StreamingAudioPlayer", () => {
  it("starts after 160 ms, schedules chunks continuously, and stops immediately", () => {
    const context = new FakeAudioContext();
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          return context;
        }
      },
    );
    const statuses: string[] = [];
    const player = new StreamingAudioPlayer({
      onError: vi.fn(),
      onMetrics: vi.fn(),
      onStatusChange: (status) => statuses.push(status),
    });

    player.start(requestId, {
      encoding: "pcm_s16le",
      sample_rate: 24_000,
      channels: 1,
      voice: "test",
    });
    player.enqueue({
      requestId,
      sequence: 0,
      timestampUs: 0,
      samples: new Int16Array(1_920),
    });
    expect(statuses).not.toContain("playing");

    player.enqueue({
      requestId,
      sequence: 1,
      timestampUs: 80_000,
      samples: new Int16Array(1_920),
    });

    expect(statuses).toContain("playing");
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1]?.startedAt).toBeCloseTo(
      (context.sources[0]?.startedAt ?? 0) + 0.08,
    );

    player.stop();
    expect(context.sources.every((source) => source.stopped)).toBe(true);
    expect(statuses[statuses.length - 1]).toBe("stopped");
  });
});

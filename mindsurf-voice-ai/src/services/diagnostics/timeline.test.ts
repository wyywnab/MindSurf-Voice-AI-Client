import { describe, expect, it } from "vitest";

import type { RequestTimelineEvent } from "../../types/diagnostics";
import { calculateTimelineMetrics } from "./timeline";

describe("calculateTimelineMetrics", () => {
  it("calculates only metrics supported by the recorded events", () => {
    const events = [
      event("request.triggered", 10),
      event("recording.prepare_started", 20),
      event("recording.started", 45),
      event("request.done", 210),
    ];

    expect(calculateTimelineMetrics({ events })).toEqual([
      { label: "录音准备", durationMs: 25 },
      { label: "总请求", durationMs: 200 },
    ]);
  });
});

function event(type: string, monotonicMs: number): RequestTimelineEvent {
  return {
    requestId: "request-id",
    type,
    monotonicMs,
    wallClockMs: monotonicMs,
    stage: "request",
    summary: type,
  };
}

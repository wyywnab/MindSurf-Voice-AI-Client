import type { RequestTimelineEvent, TimelineMetric } from "../../types/diagnostics";

const METRIC_DEFINITIONS = [
  ["录音准备", "recording.prepare_started", "recording.started"],
  ["提交确认", "input.commit_sent", "input.committed"],
  ["最终识别", "input.commit_sent", "asr.final"],
  ["首 Token", "input.commit_sent", "assistant.first_token"],
  ["首音频到达", "input.commit_sent", "output.first_chunk"],
  ["首次播放", "input.commit_sent", "output.playback_started"],
] as const;

export function calculateTimelineMetrics(timeline: {
  events: readonly RequestTimelineEvent[];
}): TimelineMetric[] {
  const metrics: TimelineMetric[] = METRIC_DEFINITIONS.flatMap(([label, from, to]) => {
    const durationMs = durationBetween(timeline.events, from, to);
    return durationMs === null ? [] : [{ label, durationMs }];
  });
  const terminal = timeline.events.find((event) =>
    ["request.done", "request.cancelled", "request.failed"].includes(event.type),
  );
  if (terminal) {
    metrics.push({
      label: "总请求",
      durationMs: Math.max(0, terminal.monotonicMs - timeline.events[0].monotonicMs),
    });
  }
  return metrics;
}

function durationBetween(
  events: readonly RequestTimelineEvent[],
  from: string,
  to: string,
) {
  const start = events.find((event) => event.type === from);
  const end = events.find((event) => event.type === to);
  return start && end ? Math.max(0, end.monotonicMs - start.monotonicMs) : null;
}

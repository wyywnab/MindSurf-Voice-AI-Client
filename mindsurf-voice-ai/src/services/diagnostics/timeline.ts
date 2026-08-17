import type { RequestTimelineEvent, TimelineMetric } from "../../types/diagnostics";

const METRIC_DEFINITIONS = [
  ["录音准备", "recording.prepare_started", "recording.started"],
  ["请求接受", "request.start", "recording.started"],
  ["处理完成", "recording.stopped", "request.done"],
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

import { describe, expect, it } from "vitest";

import type { UsageEntry } from "../types/httpApi";
import {
  dailyUsageCells,
  monthMarkers,
  usageRange,
  weeklyUsageCells,
} from "./usageAggregation";

describe("usage aggregation", () => {
  it("aggregates settled credits into a fixed 53-week heatmap", () => {
    const now = new Date(2026, 7, 18, 12);
    const range = usageRange(now);
    const entry: UsageEntry = {
      request_id: "019d643e-1550-761a-b7a0-471791bcaf22",
      mode: "asr_only",
      settled_at_ms: new Date(2026, 7, 18, 8).getTime(),
      pricing_revision: "test",
      input_audio_ms: 1_000,
      llm_input_tokens: 0,
      llm_output_tokens: 0,
      asr_credits_charged: 4,
      llm_credits_charged: 0,
      credits_charged: 4,
    };

    const daily = dailyUsageCells([entry], range.start, now);
    expect(daily).toHaveLength(371);
    expect(daily.find((cell) => cell.key === "2026-08-18")?.value).toBe(4);
    expect(weeklyUsageCells(daily)).toHaveLength(53);
    expect(monthMarkers(range.start).length).toBeGreaterThanOrEqual(12);
  });

  it("builds a monotonic cumulative weekly series", () => {
    const now = new Date(2026, 7, 18, 12);
    const range = usageRange(now);
    const cumulative = weeklyUsageCells(
      dailyUsageCells([], range.start, now).map((cell, index) => ({
        ...cell,
        value: index === 0 || index === 8 ? 2 : 0,
      })),
      true,
    );
    expect(cumulative[0]?.value).toBe(2);
    expect(cumulative[1]?.value).toBe(4);
    expect(cumulative[cumulative.length - 1]?.value).toBe(4);
  });
});

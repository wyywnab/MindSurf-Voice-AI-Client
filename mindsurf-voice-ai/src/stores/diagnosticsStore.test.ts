import { describe, expect, it } from "vitest";

import { diagnosticsStoreActions, useDiagnosticsStore } from "./diagnosticsStore";

describe("diagnosticsStore timeline", () => {
  it("records each semantic event only once", () => {
    diagnosticsStoreActions.beginTimeline("asr_only");
    expect(
      diagnosticsStoreActions.recordTimeline("asr.final", "asr", "收到最终识别结果"),
    ).toBe(true);
    expect(
      diagnosticsStoreActions.recordTimeline("asr.final", "asr", "重复的最终识别结果"),
    ).toBe(false);
    expect(
      useDiagnosticsStore().currentTimeline.value?.events.filter(
        (event) => event.type === "asr.final",
      ),
    ).toHaveLength(1);
  });
});

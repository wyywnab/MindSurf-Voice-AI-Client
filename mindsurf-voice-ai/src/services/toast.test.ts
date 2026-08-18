import { afterEach, describe, expect, it, vi } from "vitest";

import { clearToasts, dismissToast, showToast, toast, useToasts } from "./toast";

describe("toast service", () => {
  afterEach(() => {
    clearToasts();
    vi.useRealTimers();
  });

  it("adds typed notifications and allows manual dismissal", () => {
    const id = toast.success("设置已保存", { title: "完成", durationMs: 0 });

    expect(useToasts().items).toEqual([
      expect.objectContaining({
        id,
        message: "设置已保存",
        title: "完成",
        type: "success",
      }),
    ]);
    dismissToast(id!);
    expect(useToasts().items).toHaveLength(0);
  });

  it("automatically dismisses a notification after its duration", () => {
    vi.useFakeTimers();
    showToast({ message: "连接失败", type: "error", durationMs: 1_000 });

    vi.advanceTimersByTime(999);
    expect(useToasts().items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToasts().items).toHaveLength(0);
  });

  it("keeps at most five visible notifications", () => {
    for (let index = 0; index < 6; index += 1) {
      showToast({ message: `通知 ${index}`, durationMs: 0 });
    }

    expect(useToasts().items.map((item) => item.message)).toEqual([
      "通知 1",
      "通知 2",
      "通知 3",
      "通知 4",
      "通知 5",
    ]);
  });
});

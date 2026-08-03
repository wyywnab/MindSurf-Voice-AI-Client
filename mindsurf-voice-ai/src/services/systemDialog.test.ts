import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => false }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  confirm: vi.fn(),
  message: vi.fn(),
}));

import {
  resolveBrowserDialog,
  showConfirm,
  showMessage,
  useBrowserDialog,
} from "./systemDialog";

describe("systemDialog browser fallback", () => {
  it("queues dialogs and resolves them in order", async () => {
    const first = showConfirm("确认操作？", { title: "确认", kind: "warning" });
    const second = showMessage("操作完成");
    const state = useBrowserDialog();

    expect(state.current?.message).toBe("确认操作？");
    resolveBrowserDialog(false);
    await expect(first).resolves.toBe(false);
    expect(state.current?.message).toBe("操作完成");
    resolveBrowserDialog(true);
    await expect(second).resolves.toBeUndefined();
    expect(state.current).toBeNull();
  });
});

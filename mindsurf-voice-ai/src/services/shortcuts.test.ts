import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: listenMock,
}));

import { registerRecordShortcut, subscribeShortcutEvents } from "./shortcuts";

describe("shortcut service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it("registers the selected binding through the Tauri command", async () => {
    invokeMock.mockResolvedValue({
      ok: true,
      data: {
        binding: "shift+control+Space",
        display: "Ctrl + Shift + Space",
        enabled: true,
        listenerStatus: "running",
        lastError: null,
      },
    });

    const result = await registerRecordShortcut("shift+control+Space");

    expect(invokeMock).toHaveBeenCalledWith("register_record_shortcut", {
      binding: "shift+control+Space",
    });
    expect(result.ok).toBe(true);
  });

  it("unsubscribes every native event listener", async () => {
    const unlisteners = [vi.fn(), vi.fn(), vi.fn()];
    listenMock
      .mockResolvedValueOnce(unlisteners[0])
      .mockResolvedValueOnce(unlisteners[1])
      .mockResolvedValueOnce(unlisteners[2]);

    const unlisten = await subscribeShortcutEvents({
      onCancel: vi.fn(),
      onRecordPressed: vi.fn(),
      onRecordReleased: vi.fn(),
    });
    unlisten();

    expect(listenMock).toHaveBeenCalledTimes(3);
    for (const removeListener of unlisteners) {
      expect(removeListener).toHaveBeenCalledOnce();
    }
  });
});

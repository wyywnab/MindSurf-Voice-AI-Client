import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen, listeners } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, (event: { payload: string }) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { subscribeTrayActions, syncTrayConfiguration } from "./tray";

describe("tray", () => {
  beforeEach(() => {
    listeners.clear();
    invoke.mockReset();
    listen.mockReset();
    listen.mockImplementation(
      async (event: string, callback: (event: { payload: string }) => void) => {
        listeners.set(event, callback);
        return vi.fn();
      },
    );
  });

  it("syncs locale and diagnostics availability", async () => {
    invoke.mockResolvedValue({ ok: true });

    await expect(
      syncTrayConfiguration({ locale: "en-US", diagnosticsEnabled: false }),
    ).resolves.toBe(true);

    expect(invoke).toHaveBeenCalledWith("configure_tray_menu", {
      locale: "en-US",
      diagnosticsEnabled: false,
    });
  });

  it("accepts all top-level application pages from tray events", async () => {
    const onNavigate = vi.fn();
    await subscribeTrayActions({ onNavigate, onMode: vi.fn() });

    for (const page of ["record", "history", "connection", "settings"]) {
      listeners.get("tray://navigate")?.({ payload: page });
    }
    listeners.get("tray://navigate")?.({ payload: "unknown" });

    expect(onNavigate.mock.calls.map(([page]) => page)).toEqual([
      "record",
      "history",
      "connection",
      "settings",
    ]);
  });
});

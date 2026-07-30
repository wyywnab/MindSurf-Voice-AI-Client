import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import {
  getSystemPermissionStatus,
  openSystemPermissionSettings,
  requestSystemPermission,
} from "./permissions";

describe("system permission service", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({
      ok: true,
      data: {
        permission: "input_monitoring",
        status: "granted",
      },
    });
  });

  it("queries and requests a named macOS permission", async () => {
    await getSystemPermissionStatus("input_monitoring");
    await requestSystemPermission("input_monitoring");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "get_system_permission_status", {
      permission: "input_monitoring",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "request_system_permission", {
      permission: "input_monitoring",
    });
  });

  it("opens the matching system settings pane", async () => {
    await openSystemPermissionSettings("accessibility");

    expect(invokeMock).toHaveBeenCalledWith("open_permission_settings", {
      permission: "accessibility",
    });
  });
});

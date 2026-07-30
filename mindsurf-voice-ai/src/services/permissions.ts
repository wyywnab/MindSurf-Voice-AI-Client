import { invoke } from "@tauri-apps/api/core";

import type { CommandResult } from "../types/app";
import type { SystemPermission, SystemPermissionStatus } from "../types/permissions";

function unavailable<T>(): CommandResult<T> {
  return {
    ok: false,
    error: {
      code: "permission_settings_unavailable",
      message: "无法调用系统权限功能",
      recoverable: true,
    },
  };
}

export async function getSystemPermissionStatus(
  permission: SystemPermission,
): Promise<CommandResult<SystemPermissionStatus>> {
  try {
    return await invoke<CommandResult<SystemPermissionStatus>>(
      "get_system_permission_status",
      { permission },
    );
  } catch {
    return unavailable();
  }
}

export async function requestSystemPermission(
  permission: SystemPermission,
): Promise<CommandResult<SystemPermissionStatus>> {
  try {
    return await invoke<CommandResult<SystemPermissionStatus>>(
      "request_system_permission",
      { permission },
    );
  } catch {
    return unavailable();
  }
}

export async function openSystemPermissionSettings(
  permission: SystemPermission,
): Promise<CommandResult<null>> {
  try {
    return await invoke<CommandResult<null>>("open_permission_settings", {
      permission,
    });
  } catch {
    return unavailable();
  }
}

export function openMicrophonePermissionSettings() {
  return openSystemPermissionSettings("microphone");
}

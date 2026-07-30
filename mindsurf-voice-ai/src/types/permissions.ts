export type SystemPermission = "microphone" | "accessibility" | "input_monitoring";

export type SystemPermissionState = "granted" | "denied" | "unknown";

export interface SystemPermissionStatus {
  permission: SystemPermission;
  status: SystemPermissionState;
}

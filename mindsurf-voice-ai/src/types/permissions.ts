export type SystemPermission = "microphone" | "accessibility" | "input_monitoring";

export type SystemPermissionState =
  "not_determined" | "restricted" | "granted" | "denied" | "unknown";

export interface SystemPermissionStatus {
  permission: SystemPermission;
  status: SystemPermissionState;
}

export type ShortcutBinding = string;

export type ShortcutListenerStatus = "starting" | "running" | "error";
export type ShortcutPlatformEnvironment = "windows" | "macos" | "unsupported";

export interface ShortcutStatus {
  binding: ShortcutBinding;
  display: string;
  enabled: boolean;
  listenerStatus: ShortcutListenerStatus;
  lastError: string | null;
  environment: ShortcutPlatformEnvironment;
  supportsModifierOnly: boolean;
}

export interface RecordShortcutEvent {
  shortcut: string;
  timestamp_ms: number;
}

export interface CancelShortcutEvent {
  timestamp_ms: number;
}

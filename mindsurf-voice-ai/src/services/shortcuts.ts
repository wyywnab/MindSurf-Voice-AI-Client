import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { CommandResult } from "../types/app";
import type {
  CancelShortcutEvent,
  RecordShortcutEvent,
  ShortcutBinding,
  ShortcutStatus,
} from "../types/shortcut";

const UNAVAILABLE_RESULT: CommandResult<never> = {
  ok: false,
  error: {
    code: "shortcut_listener_unavailable",
    message: "无法调用系统全局快捷键功能",
    recoverable: true,
  },
};

export async function getRecordShortcutStatus(): Promise<
  CommandResult<ShortcutStatus>
> {
  try {
    return await invoke<CommandResult<ShortcutStatus>>("get_record_shortcut_status");
  } catch {
    return UNAVAILABLE_RESULT;
  }
}

export async function registerRecordShortcut(
  binding: ShortcutBinding,
): Promise<CommandResult<ShortcutStatus>> {
  try {
    return await invoke<CommandResult<ShortcutStatus>>("register_record_shortcut", {
      binding,
    });
  } catch {
    return UNAVAILABLE_RESULT;
  }
}

export async function unregisterRecordShortcut(): Promise<
  CommandResult<ShortcutStatus>
> {
  try {
    return await invoke<CommandResult<ShortcutStatus>>("unregister_record_shortcut");
  } catch {
    return UNAVAILABLE_RESULT;
  }
}

export async function reportShortcutEventHandled(details: {
  phase: "pressed" | "released";
  canStart: boolean;
  recorderState: string;
  requestStatus: string;
}): Promise<void> {
  try {
    await invoke("report_shortcut_event_handled", details);
  } catch {
    // Runtime diagnostics must never interfere with shortcut handling.
  }
}

export async function subscribeShortcutEvents(callbacks: {
  onCancel: (event: CancelShortcutEvent) => void;
  onRecordPressed: (event: RecordShortcutEvent) => void;
  onRecordReleased: (event: RecordShortcutEvent) => void;
}): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  try {
    unlisteners.push(
      await listen<RecordShortcutEvent>("shortcut://record-pressed", (event) => {
        callbacks.onRecordPressed(event.payload);
      }),
    );
    unlisteners.push(
      await listen<RecordShortcutEvent>("shortcut://record-released", (event) => {
        callbacks.onRecordReleased(event.payload);
      }),
    );
    unlisteners.push(
      await listen<CancelShortcutEvent>("shortcut://cancel", (event) => {
        callbacks.onCancel(event.payload);
      }),
    );
  } catch (error) {
    for (const unlisten of unlisteners) {
      unlisten();
    }
    throw error;
  }

  return () => {
    for (const unlisten of unlisteners) {
      unlisten();
    }
  };
}

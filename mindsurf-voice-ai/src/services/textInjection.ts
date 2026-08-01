import { invoke } from "@tauri-apps/api/core";

import type { CommandResult } from "../types/app";
import type { TextInjectionReport } from "../types/injection";

export async function prepareTextInjectionTarget(): Promise<void> {
  try {
    await invoke("prepare_text_injection_target");
  } catch {
    // Browser previews and older native builds do not expose this optional hint.
  }
}

export async function injectTextIntoForegroundWindow(
  text: string,
  maxCodePoints: number,
): Promise<CommandResult<TextInjectionReport>> {
  try {
    return await invoke<CommandResult<TextInjectionReport>>("inject_text", {
      text,
      maxCodePoints,
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "text_injection_unavailable",
        message: "无法调用系统文本注入功能",
        recoverable: true,
      },
    };
  }
}

import { invoke, isTauri } from "@tauri-apps/api/core";

import type { CommandResult } from "../../types/app";

export interface ClearedLocalData {
  settings: boolean;
  credentials: boolean;
  diagnosticLogs: boolean;
}

export async function clearLocalApplicationData() {
  if (!isTauri()) throw new Error("浏览器预览不支持清除桌面应用数据");
  const result = await invoke<CommandResult<ClearedLocalData>>(
    "clear_local_application_data",
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

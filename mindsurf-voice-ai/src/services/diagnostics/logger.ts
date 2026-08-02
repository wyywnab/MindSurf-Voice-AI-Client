import { invoke, isTauri } from "@tauri-apps/api/core";

import type { CommandResult } from "../../types/app";
import type {
  DiagnosticsExportResult,
  LogEntry,
  RequestTimeline,
} from "../../types/diagnostics";

export async function persistLogEntry(entry: LogEntry) {
  if (!isTauri()) return;
  const result = await invoke<CommandResult<null>>("write_log_entry", { entry });
  if (!result.ok) throw new Error(result.error.message);
}

export async function readRecentLogEntries(limit = 200, beforeTimestampMs?: number) {
  if (!isTauri()) return [];
  const result = await invoke<CommandResult<LogEntry[]>>("read_recent_log_entries", {
    limit,
    beforeTimestampMs,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

export async function exportDiagnostics(input: {
  serviceUrl: string;
  timelines: RequestTimeline[];
}) {
  if (!isTauri()) throw new Error("浏览器预览不支持导出诊断包");
  const url = new URL(input.serviceUrl);
  url.search = "";
  url.hash = "";
  const result = await invoke<CommandResult<DiagnosticsExportResult>>(
    "export_diagnostics",
    {
      summary: {
        exportedAtMs: Date.now(),
        serviceUrl: url.toString(),
        timelineCount: input.timelines.length,
      },
      timelines: input.timelines,
    },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

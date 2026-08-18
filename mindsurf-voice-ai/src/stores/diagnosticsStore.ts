import { computed, reactive, readonly } from "vue";

import {
  clearDiagnosticLogs,
  exportDiagnostics,
  openDiagnosticLogDirectory,
  persistLogEntry,
  readRecentLogEntries,
} from "../services/diagnostics/logger";
import type {
  LogEntry,
  LogLevel,
  RequestTimeline,
  TimelineStage,
} from "../types/diagnostics";
import type { RequestLifecycleState, RequestTransition } from "../types/request";
import type { VoiceModeV2 } from "../types/httpApi";
import { toast } from "../services/toast";

const MAX_VISIBLE_TRANSITIONS = 100;
const MAX_TIMELINES = 20;
const MAX_VISIBLE_LOGS = 1_000;

const state = reactive({
  requestTransitions: [] as RequestTransition[],
  timelines: [] as RequestTimeline[],
  currentRequestId: null as string | null,
  logs: [] as LogEntry[],
  logsLoading: false,
  logsExhausted: false,
  storageWarning: "",
  exportStatus: "idle" as "idle" | "exporting" | "succeeded" | "failed",
  exportPath: "",
  exportError: "",
});

function currentTimeline() {
  return state.timelines.find(
    (timeline) => timeline.requestId === state.currentRequestId,
  );
}

export const diagnosticsStoreActions = {
  beginTimeline(mode: VoiceModeV2) {
    const requestId = `pending-${crypto.randomUUID()}`;
    const timeline: RequestTimeline = {
      requestId,
      mode,
      startedAtMs: Date.now(),
      terminalState: null,
      recordingDurationMs: null,
      audioFramesSent: 0,
      audioBytesSent: 0,
      reconnectCount: 0,
      events: [],
    };
    state.timelines.unshift(timeline);
    state.timelines.splice(MAX_TIMELINES);
    state.currentRequestId = requestId;
    diagnosticsStoreActions.recordTimeline(
      "request.triggered",
      "request",
      "请求已触发",
    );
    diagnosticsStoreActions.log("info", "request", "request.triggered", "请求已触发", {
      requestId,
      fields: { mode },
    });
    return requestId;
  },
  bindRequestId(requestId: string) {
    const timeline = currentTimeline();
    if (!timeline || timeline.terminalState) return;
    const oldRequestId = timeline.requestId;
    timeline.requestId = requestId;
    for (const event of timeline.events) event.requestId = requestId;
    state.currentRequestId = requestId;
    for (const entry of state.logs) {
      if (entry.requestId === oldRequestId) entry.requestId = requestId;
    }
  },
  recordTimeline(
    type: string,
    stage: TimelineStage,
    summary: string,
    details?: Record<string, string | number | boolean | null>,
    requestId?: string,
  ) {
    const timeline = requestId
      ? state.timelines.find((item) => item.requestId === requestId)
      : currentTimeline();
    if (!timeline) return false;
    if (timeline.events.some((event) => event.type === type)) return false;
    timeline.events.push({
      requestId: timeline.requestId,
      type,
      monotonicMs: performance.now(),
      wallClockMs: Date.now(),
      stage,
      summary,
      details,
    });
    if (type === "recording.stopped" && typeof details?.durationMs === "number") {
      timeline.recordingDurationMs = details.durationMs;
      timeline.audioFramesSent = Number(details.frameCount ?? 0);
      timeline.audioBytesSent = Number(details.sampleCount ?? 0) * 2;
    }
    return true;
  },
  updateRuntimeMetrics(input: { requestId?: string | null; reconnectCount?: number }) {
    const timeline = input.requestId
      ? state.timelines.find((item) => item.requestId === input.requestId)
      : currentTimeline();
    if (!timeline) return;
    if (typeof input.reconnectCount === "number") {
      timeline.reconnectCount = Math.max(timeline.reconnectCount, input.reconnectCount);
    }
  },
  finishTimeline(
    type: "request.done" | "request.cancelled" | "request.failed",
    terminalState: RequestLifecycleState,
    summary: string,
    details?: Record<string, string | number | boolean | null>,
  ) {
    const timeline = currentTimeline();
    if (!timeline || timeline.terminalState) return;
    diagnosticsStoreActions.recordTimeline(type, "request", summary, details);
    timeline.terminalState = terminalState;
    diagnosticsStoreActions.log(
      terminalState === "failed" ? "error" : "info",
      "request",
      type,
      summary,
      { requestId: timeline.requestId, fields: details },
    );
  },
  recordTransition(transition: RequestTransition) {
    state.requestTransitions.push(transition);
    if (state.requestTransitions.length > MAX_VISIBLE_TRANSITIONS) {
      state.requestTransitions.splice(
        0,
        state.requestTransitions.length - MAX_VISIBLE_TRANSITIONS,
      );
    }
    diagnosticsStoreActions.log(
      transition.to === "failed" ? "error" : "debug",
      "request",
      "state.transition",
      `${transition.from} -> ${transition.to}`,
      {
        requestId: state.currentRequestId ?? undefined,
        fields: { from: transition.from, to: transition.to, reason: transition.reason },
      },
    );
  },
  log(
    level: LogLevel,
    module: string,
    event: string,
    message: string,
    context: {
      requestId?: string;
      fields?: Record<string, string | number | boolean | null>;
    } = {},
  ) {
    if (!import.meta.env.DEV && level === "debug") return;
    const entry: LogEntry = {
      timestampMs: Date.now(),
      level,
      module,
      event,
      message,
      requestId: context.requestId,
      fields: context.fields,
    };
    state.logs.unshift(entry);
    state.logs.splice(MAX_VISIBLE_LOGS);
    void persistLogEntry(entry).catch(() => {
      if (!state.storageWarning) state.storageWarning = "运行日志暂时无法写入磁盘";
    });
  },
  async refreshLogs() {
    state.logsLoading = true;
    try {
      state.logs = await readRecentLogEntries(200);
      state.logsExhausted = state.logs.length < 200;
      return true;
    } catch (error) {
      state.storageWarning =
        error instanceof Error ? error.message : "无法读取运行日志";
      return false;
    } finally {
      state.logsLoading = false;
    }
  },
  async loadOlderLogs() {
    if (state.logsLoading || state.logsExhausted) return true;
    state.logsLoading = true;
    try {
      const oldest = state.logs[state.logs.length - 1]?.timestampMs;
      const entries = await readRecentLogEntries(200, oldest);
      state.logs.push(...entries);
      state.logs.splice(MAX_VISIBLE_LOGS);
      state.logsExhausted = entries.length < 200;
      return true;
    } catch (error) {
      state.storageWarning =
        error instanceof Error ? error.message : "无法读取更多日志";
      return false;
    } finally {
      state.logsLoading = false;
    }
  },
  async export(settings: Record<string, unknown>) {
    state.exportStatus = "exporting";
    state.exportError = "";
    try {
      const result = await exportDiagnostics({
        settings,
        timelines: state.timelines,
      });
      state.exportPath = result.path;
      state.exportStatus = "succeeded";
      toast.success(`诊断包已导出到 ${result.path}`, { title: "导出成功" });
    } catch (error) {
      state.exportStatus = "failed";
      state.exportError = error instanceof Error ? error.message : "导出诊断包失败";
      toast.error(state.exportError, { title: "诊断包导出失败", durationMs: 0 });
    }
  },
  async clearLogs() {
    try {
      await clearDiagnosticLogs();
      state.logs = [];
      state.logsExhausted = true;
      state.storageWarning = "";
      toast.success("本地运行日志已清空");
    } catch (error) {
      state.storageWarning =
        error instanceof Error ? error.message : "无法清空运行日志";
      toast.error(state.storageWarning, { title: "清空日志失败", durationMs: 0 });
    }
  },
  async openLogDirectory() {
    try {
      const path = await openDiagnosticLogDirectory();
      toast.success(path ? `已打开日志目录：${path}` : "已打开日志目录");
      return path;
    } catch (error) {
      state.storageWarning =
        error instanceof Error ? error.message : "无法打开日志目录";
      toast.error(state.storageWarning, { title: "打开日志目录失败", durationMs: 0 });
      return "";
    }
  },
};

export function useDiagnosticsStore() {
  return {
    state: readonly(state),
    currentTimeline: computed(() => currentTimeline() ?? state.timelines[0] ?? null),
  };
}

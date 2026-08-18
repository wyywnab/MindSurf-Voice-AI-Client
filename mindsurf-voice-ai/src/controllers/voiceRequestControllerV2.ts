import { createTextOutputBackend } from "../services/text-output/backendFactory";
import {
  encodeInputPcmFrame,
  INPUT_PCM_HEADER_BYTES,
  inputStatistics,
} from "../services/realtime/inputPcmV2";
import {
  createInputCommit,
  createRequestCancel,
  createRequestStart,
  parseProtocolError,
} from "../services/realtime/protocolV2";
import {
  capabilitiesStoreActions,
  useCapabilitiesStore,
} from "../stores/capabilitiesStore";
import { diagnosticsStoreActions } from "../stores/diagnosticsStore";
import { requestStoreActions, useRequestStore } from "../stores/requestStore";
import { useAccountStore } from "../stores/accountStore";
import { historyStoreActions } from "../stores/historyStore";
import { useSettingsStore } from "../stores/settingsStore";
import type {
  V2CancelReason,
  V2ControlEnvelope,
  V2InputStatistics,
  V2RequestStartPayload,
  V2TextStage,
} from "../types/realtimeV2";
import type { V2RequestOptionsSnapshot } from "../types/request";
import { isTerminalRequestState } from "./requestStateMachine";
import { realtimeConnectionController } from "./realtimeConnectionController";
import { TextOutputController } from "./textOutputController";

const ACCEPTED_TIMEOUT_MS = 3_000;
const TERMINAL_AFTER_CANCEL_TIMEOUT_MS = 2_000;

export class VoiceRequestControllerV2 {
  private acceptedTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelTerminalTimer: ReturnType<typeof setTimeout> | null = null;
  private inputIdleTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveAccepted: ((maxRecordingMs: number) => void) | null = null;
  private rejectAccepted: ((error: Error) => void) | null = null;
  private chunkCount = 0;
  private sampleCount = 0;
  private committedStatistics: V2InputStatistics | null = null;
  private asrSnapshotAfterCommit = false;
  private llmStarted = false;
  private asrSourceText: string | null = null;
  private outputCommitted = false;
  private readonly account = useAccountStore();
  private readonly capabilities = useCapabilitiesStore();
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();
  readonly textOutput = new TextOutputController(createTextOutputBackend());

  constructor() {
    realtimeConnectionController.setRequestListener({
      onMessage: (message) => this.handleMessage(message),
      onConnectionLost: () => this.handleConnectionLost(),
    });
  }

  async startRequest() {
    if (this.request.state.activeRequestId) throw new Error("已有请求正在处理");
    const hello = realtimeConnectionController.serverHello;
    if (!hello) throw new Error("实时连接尚未完成握手");
    const snapshot = this.createOptionsSnapshot();
    const requestId = globalThis.crypto.randomUUID();
    this.resetRuntime();
    requestStoreActions.beginV2(snapshot, requestId);
    diagnosticsStoreActions.bindRequestId(requestId);
    diagnosticsStoreActions.recordTimeline(
      "request.start",
      "input",
      "已发送 Voice v2 请求",
      { mode: snapshot.mode, pipeline: snapshot.pipeline },
      requestId,
    );

    try {
      realtimeConnectionController.sendControl(
        createRequestStart(requestId, requestPayload(snapshot)),
      );
    } catch (error) {
      this.fail(describeError(error), "request_start_failed");
      throw error;
    }
    const accepted = new Promise<number>((resolve, reject) => {
      this.resolveAccepted = resolve;
      this.rejectAccepted = reject;
    });
    this.acceptedTimer = globalThis.setTimeout(() => {
      if (this.request.state.activeRequestId !== requestId) return;
      this.rejectAccepted?.(new Error("等待 request.accepted 超时"));
      this.rejectAccepted = null;
      this.resolveAccepted = null;
      void this.cancelCurrentRequest("client_timeout");
    }, ACCEPTED_TIMEOUT_MS);
    return accepted;
  }

  markRecording() {
    if (this.request.state.status !== "recording") {
      this.protocolFailure("request.accepted 前启动了录音");
    }
  }

  sendAudioFrame(samples: Int16Array) {
    const requestId = this.request.state.activeRequestId;
    const hello = realtimeConnectionController.serverHello;
    if (!requestId || !hello || this.request.state.status !== "recording") return false;
    try {
      const maxSamples = Math.floor(
        (hello.limits.max_binary_bytes - INPUT_PCM_HEADER_BYTES) / 2,
      );
      if (samples.length === 0 || maxSamples < 1)
        throw new Error("invalid_audio_frame");
      for (let offset = 0; offset < samples.length; offset += maxSamples) {
        const chunk = samples.subarray(offset, offset + maxSamples);
        const frame = encodeInputPcmFrame({
          requestId,
          sequence: this.chunkCount,
          samplesBefore: this.sampleCount,
          samples: chunk,
          maxBinaryBytes: hello.limits.max_binary_bytes,
        });
        realtimeConnectionController.sendBinary(frame);
        this.chunkCount += 1;
        this.sampleCount += chunk.length;
      }
      this.armInputIdleTimer(requestId);
      return true;
    } catch (error) {
      this.protocolFailure(describeError(error));
      return false;
    }
  }

  async commitInput() {
    const requestId = this.request.state.activeRequestId;
    if (!requestId || this.request.state.status !== "recording") return;
    this.clearInputIdleTimer();
    try {
      this.committedStatistics = inputStatistics(this.chunkCount, this.sampleCount);
      realtimeConnectionController.sendControl(
        createInputCommit(requestId, this.committedStatistics),
      );
      requestStoreActions.transition("committing", "input_commit_sent");
    } catch (error) {
      await this.cancelCurrentRequest("protocol_error");
      requestStoreActions.setError(
        describeError(error) === "input_empty"
          ? "录音中没有可提交的音频"
          : describeError(error),
      );
    }
  }

  async cancelCurrentRequest(reason: V2CancelReason = "user_cancelled") {
    const requestId = this.request.state.activeRequestId;
    if (!requestId || isTerminalRequestState(this.request.state.status)) return;
    this.clearAcceptedTimer();
    this.clearInputIdleTimer();
    this.rejectAccepted?.(new Error("请求已取消"));
    this.rejectAccepted = null;
    this.resolveAccepted = null;
    requestStoreActions.revokeCommit(true);
    if (this.request.state.status !== "cancelling") {
      requestStoreActions.transition("cancelling", reason);
    }
    try {
      realtimeConnectionController.sendControl(createRequestCancel(requestId, reason));
    } catch (error) {
      this.fail(describeError(error), "cancel_send_failed");
      return;
    }
    this.cancelTerminalTimer ??= globalThis.setTimeout(() => {
      if (this.request.state.activeRequestId !== requestId) return;
      this.fail("取消请求后未收到服务端终态", "cancel_timeout");
      realtimeConnectionController.recycleConnection("cancel terminal timeout");
    }, TERMINAL_AFTER_CANCEL_TIMEOUT_MS);
  }

  private createOptionsSnapshot(): V2RequestOptionsSnapshot {
    const capabilities = this.capabilities.state.capabilities;
    if (!capabilities) throw new Error("服务能力目录不可用");
    const mode = this.capabilities.state.selectedMode;
    const defaults = capabilities.defaults[mode];
    const pipeline = capabilities.pipelines.find(
      (item) => item.id === this.capabilities.state.selectedPipeline,
    );
    if (!pipeline || !pipeline.modes.includes(mode)) {
      throw new Error("所选 Pipeline 已不可用，请刷新能力目录");
    }
    const language = capabilities.recognition_languages.includes(
      this.capabilities.state.language,
    )
      ? this.capabilities.state.language
      : capabilities.recognition_languages[0]!;
    return Object.freeze({
      mode,
      pipeline: pipeline.id,
      capabilities_revision: capabilities.revision,
      selection: Object.freeze({
        asr: this.capabilities.state.selectedAsr || defaults.selection.asr,
        llm:
          mode === "asr_only"
            ? null
            : this.capabilities.state.selectedLlm || defaults.selection.llm,
      }),
      language,
      autoInjectionEnabled: this.settings.state.autoInjection[mode],
      injectionMaxCodePoints: this.settings.state.injectionMaxCodePoints,
    });
  }

  private handleMessage(message: V2ControlEnvelope) {
    const requestId = this.request.state.activeRequestId;
    if (!requestId || message.request_id !== requestId) {
      diagnosticsStoreActions.log(
        "warn",
        "realtime_v2",
        "message.stale_request",
        "已忽略非当前请求的 Voice v2 消息",
        { requestId: message.request_id ?? undefined },
      );
      return;
    }
    if (isTerminalRequestState(this.request.state.status)) return;
    if (
      this.request.state.status === "ready_to_commit" &&
      message.type !== "request.done"
    ) {
      this.protocolFailure("final snapshot 后的下一条请求消息不是 request.done");
      return;
    }
    switch (message.type) {
      case "request.accepted":
        this.handleAccepted(message.payload);
        break;
      case "input.committed":
        this.handleInputCommitted(message.payload);
        break;
      case "output.text.delta":
        this.handleDelta(message.payload);
        break;
      case "output.text.snapshot":
        this.handleSnapshot(message.payload);
        break;
      case "request.done":
        this.handleDone(message.payload);
        break;
      case "request.cancelled":
        this.handleCancelled();
        break;
      case "error":
        this.handleRequestError(message);
        break;
      default:
        this.protocolFailure(`当前请求收到不支持的消息 ${message.type}`);
    }
  }

  private handleAccepted(payload: Record<string, unknown>) {
    const snapshot = this.request.state.v2OptionsSnapshot;
    const hello = realtimeConnectionController.serverHello;
    if (this.request.state.status !== "starting" || !snapshot || !hello) {
      this.protocolFailure("request.accepted 顺序无效");
      return;
    }
    const pipeline = this.capabilities.state.capabilities?.pipelines.find(
      (item) => item.id === snapshot.pipeline,
    );
    const expectedMax = pipeline
      ? Math.min(hello.limits.max_recording_ms, pipeline.max_recording_ms)
      : -1;
    const echoed = {
      mode: payload.mode,
      pipeline: payload.pipeline,
      capabilities_revision: payload.capabilities_revision,
      selection: payload.selection,
      language: payload.language,
      ...(payload.generation === undefined ? {} : { generation: payload.generation }),
    };
    if (
      !deepEqual(echoed, requestPayload(snapshot)) ||
      payload.max_recording_ms !== expectedMax
    ) {
      this.protocolFailure("request.accepted 与请求选择或录音上限不一致");
      return;
    }
    this.clearAcceptedTimer();
    requestStoreActions.setAcceptedMaxRecordingMs(expectedMax);
    requestStoreActions.transition("recording", "request_accepted");
    this.armInputIdleTimer(this.request.state.activeRequestId!);
    this.resolveAccepted?.(expectedMax);
    this.resolveAccepted = null;
    this.rejectAccepted = null;
  }

  private handleInputCommitted(payload: Record<string, unknown>) {
    if (this.request.state.status !== "committing" || !this.committedStatistics) {
      this.protocolFailure("input.committed 顺序无效");
      return;
    }
    if (!deepEqual(payload, this.committedStatistics)) {
      this.protocolFailure("服务端音频统计与本地成功发送统计不一致");
      return;
    }
    requestStoreActions.transition("processing_asr_final", "input_committed");
  }

  private handleDelta(payload: Record<string, unknown>) {
    const stage = payload.stage as V2TextStage;
    const sequence = payload.sequence as number;
    const delta = payload.delta as string;
    if (
      !this.outputAllowed(stage) ||
      (stage === "llm" && !this.llmStarted) ||
      sequence !== this.nextSequence(stage)
    ) {
      this.protocolFailure(`${stage} 文本分片顺序无效`);
      return;
    }
    if (stage === "asr" && this.request.state.status === "processing_asr_final") {
      this.asrSnapshotAfterCommit = false;
    }
    requestStoreActions.appendTemporaryText(stage, delta, sequence);
  }

  private handleSnapshot(payload: Record<string, unknown>) {
    const stage = payload.stage as V2TextStage;
    const text = payload.text as string;
    const final = payload.final as boolean;
    const mode = this.request.state.v2OptionsSnapshot?.mode;
    if (!mode || !this.outputAllowed(stage)) {
      this.protocolFailure(`${stage} 文本快照顺序无效`);
      return;
    }
    if (stage === "asr") {
      if (mode === "asr_llm" && final) {
        this.protocolFailure("asr_llm 不允许最终 ASR 快照");
        return;
      }
      if (final && this.request.state.status !== "processing_asr_final") {
        this.protocolFailure("input.committed 前收到最终 ASR 快照");
        return;
      }
      if (this.request.state.status === "processing_asr_final") {
        this.asrSnapshotAfterCommit = true;
      }
      requestStoreActions.replaceTemporaryText("asr", text);
      if (final) this.acceptFinalSnapshot(text);
      return;
    }
    if (mode !== "asr_llm") {
      this.protocolFailure("asr_only 收到 LLM 输出");
      return;
    }
    if (!this.llmStarted) {
      if (
        this.request.state.status !== "processing_asr_final" ||
        !this.asrSnapshotAfterCommit ||
        final ||
        text !== ""
      ) {
        this.protocolFailure("LLM stage 切换快照无效");
        return;
      }
      this.llmStarted = true;
      this.asrSourceText = this.request.state.temporaryText;
      requestStoreActions.replaceTemporaryText("llm", "");
      requestStoreActions.transition("processing_llm", "llm_stage_started");
      return;
    }
    requestStoreActions.replaceTemporaryText("llm", text);
    if (final) this.acceptFinalSnapshot(text);
  }

  private handleDone(payload: Record<string, unknown>) {
    const snapshot = this.request.state.v2OptionsSnapshot;
    const finalText = this.request.state.finalSnapshotText;
    if (
      !["ready_to_commit", "cancelling"].includes(this.request.state.status) ||
      !snapshot ||
      payload.mode !== snapshot.mode ||
      payload.final_text !== finalText
    ) {
      this.protocolFailure("request.done 与最终快照不一致");
      return;
    }
    const mayOutput =
      this.request.state.commitEligible &&
      !this.request.state.cancelRequested &&
      !this.outputCommitted;
    const requestId = this.request.state.activeRequestId;
    const userId = this.account.state.user?.user_id;
    if (mayOutput && requestId && userId && finalText !== null) {
      void historyStoreActions.add({
        id: requestId,
        userId,
        completedAtMs: Date.now(),
        mode: snapshot.mode,
        language: snapshot.language,
        pipeline: snapshot.pipeline,
        durationMs: this.committedStatistics?.duration_ms ?? 0,
        sourceText: snapshot.mode === "asr_llm" ? this.asrSourceText : null,
        resultText: finalText,
      });
    }
    this.outputCommitted = true;
    this.finishTerminal("completed", "request_done", true);
    if (mayOutput && snapshot.autoInjectionEnabled) {
      void this.textOutput.output(finalText ?? "", 0, snapshot.injectionMaxCodePoints);
    }
  }

  private handleCancelled() {
    if (
      !this.request.state.cancelRequested ||
      this.request.state.finalSnapshotText !== null
    ) {
      this.protocolFailure("未发送 cancel 却收到 request.cancelled");
      return;
    }
    this.finishTerminal("cancelled", "server_cancelled", true);
  }

  private handleRequestError(message: V2ControlEnvelope) {
    const payload = parseProtocolError(message.payload, message.request_id);
    requestStoreActions.revokeCommit();
    requestStoreActions.setError(safeRequestError(payload.code));
    this.finishTerminal("failed", payload.code, true);
    if (
      payload.code === "capabilities_stale" ||
      payload.code === "pipeline_unavailable"
    ) {
      capabilitiesStoreActions.requireSelectionConfirmation(
        "服务能力已变化；刷新后请确认请求模式",
      );
    }
  }

  private outputAllowed(stage: V2TextStage) {
    const status = this.request.state.status;
    if (stage === "asr") {
      return (
        !this.llmStarted &&
        ["recording", "committing", "processing_asr_final"].includes(status)
      );
    }
    return (
      this.request.state.v2OptionsSnapshot?.mode === "asr_llm" &&
      ["processing_asr_final", "processing_llm"].includes(status)
    );
  }

  private nextSequence(stage: V2TextStage) {
    return stage === "asr"
      ? this.request.state.asrNextSequence
      : this.request.state.llmNextSequence;
  }

  private acceptFinalSnapshot(text: string) {
    requestStoreActions.setFinalSnapshot(text);
    requestStoreActions.transition("ready_to_commit", "final_snapshot");
  }

  private protocolFailure(message: string) {
    const requestId = this.request.state.activeRequestId;
    requestStoreActions.revokeCommit();
    requestStoreActions.setError(message);
    if (requestId) {
      try {
        realtimeConnectionController.sendControl(
          createRequestCancel(requestId, "protocol_error"),
        );
      } catch {
        // The local terminal state is authoritative for commit eligibility.
      }
    }
    this.fail(message, "protocol_error");
    realtimeConnectionController.recycleConnection("request protocol violation");
  }

  private handleConnectionLost() {
    if (!this.request.state.activeRequestId) return;
    requestStoreActions.revokeCommit();
    this.fail("实时连接中断，本次录音不会自动重放或提交", "connection_lost");
  }

  private fail(message: string, reason: string) {
    requestStoreActions.revokeCommit();
    requestStoreActions.setError(message);
    this.rejectAccepted?.(new Error(message));
    this.rejectAccepted = null;
    this.resolveAccepted = null;
    this.finishTerminal("failed", reason);
  }

  private finishTerminal(
    status: "completed" | "cancelled" | "failed",
    reason: string,
    refreshAccount = false,
  ) {
    this.clearTimers();
    if (!isTerminalRequestState(this.request.state.status)) {
      requestStoreActions.transition(status, reason);
    }
    diagnosticsStoreActions.finishTimeline(
      status === "completed" ? "request.done" : `request.${status}`,
      status,
      status === "completed" ? "Voice v2 请求已完成" : requestStoreMessage(status),
      { reason },
    );
    requestStoreActions.clearActiveRequest();
    if (refreshAccount) realtimeConnectionController.notifyRequestTerminal();
  }

  private armInputIdleTimer(requestId: string) {
    this.clearInputIdleTimer();
    const idleMs = realtimeConnectionController.serverHello?.input_idle_timeout_ms;
    if (!idleMs) return;
    this.inputIdleTimer = globalThis.setTimeout(() => {
      if (
        this.request.state.activeRequestId === requestId &&
        this.request.state.status === "recording"
      ) {
        requestStoreActions.setError("音频输入已空闲，正在等待服务端结束请求");
        void this.cancelCurrentRequest("client_timeout");
      }
    }, idleMs);
  }

  private resetRuntime() {
    this.clearTimers();
    this.chunkCount = 0;
    this.sampleCount = 0;
    this.committedStatistics = null;
    this.asrSnapshotAfterCommit = false;
    this.llmStarted = false;
    this.asrSourceText = null;
    this.outputCommitted = false;
  }

  private clearTimers() {
    this.clearAcceptedTimer();
    this.clearInputIdleTimer();
    if (this.cancelTerminalTimer) globalThis.clearTimeout(this.cancelTerminalTimer);
    this.cancelTerminalTimer = null;
  }

  private clearAcceptedTimer() {
    if (this.acceptedTimer) globalThis.clearTimeout(this.acceptedTimer);
    this.acceptedTimer = null;
  }

  private clearInputIdleTimer() {
    if (this.inputIdleTimer) globalThis.clearTimeout(this.inputIdleTimer);
    this.inputIdleTimer = null;
  }
}

function requestPayload(snapshot: V2RequestOptionsSnapshot): V2RequestStartPayload {
  return {
    mode: snapshot.mode,
    pipeline: snapshot.pipeline,
    capabilities_revision: snapshot.capabilities_revision,
    selection: { ...snapshot.selection },
    language: snapshot.language,
    ...(snapshot.generation ? { generation: { ...snapshot.generation } } : {}),
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord).sort();
  if (keys.join("\0") !== Object.keys(rightRecord).sort().join("\0")) return false;
  return keys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}

function safeRequestError(code: string) {
  const messages: Record<string, string> = {
    capabilities_stale: "服务能力已更新，请刷新后重试",
    pipeline_unavailable: "所选 Pipeline 暂时不可用",
    quota_exhausted: "可用额度不足",
    input_empty: "没有检测到有效语音",
    input_idle_timeout: "音频输入等待超时",
    asr_failed: "语音识别失败，请重试",
    llm_failed: "文本处理失败；识别草稿不会自动提交",
  };
  return messages[code] ?? `语音请求失败（${code}）`;
}

function requestStoreMessage(status: "cancelled" | "failed") {
  return status === "cancelled" ? "Voice v2 请求已取消" : "Voice v2 请求失败";
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "Voice v2 请求失败";
}

export const voiceRequestControllerV2 = new VoiceRequestControllerV2();

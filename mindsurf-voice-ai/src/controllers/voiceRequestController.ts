import { StreamingAudioPlayer } from "../audio/streamingPlayer";
import {
  validateAssistantTextDelta,
  validateAssistantTextDone,
  validateOutputAudioDone,
  validateOutputAudioStart,
} from "../services/protocol";
import type { RecordingResult } from "../services/recorder";
import { createTextOutputBackend } from "../services/text-output/backendFactory";
import { readServiceTokenForConnection } from "../services/settings/credentials";
import { ProtocolEventRouter } from "../services/transport/protocolEventRouter";
import {
  VoiceTransport,
  VoiceTransportError,
  type VoiceClientIdentity,
} from "../services/transport/voiceTransport";
import { connectionStoreActions, useConnectionStore } from "../stores/connectionStore";
import { diagnosticsStoreActions } from "../stores/diagnosticsStore";
import { requestStoreActions, useRequestStore } from "../stores/requestStore";
import { settingsStoreActions, useSettingsStore } from "../stores/settingsStore";
import type {
  AsrFinalPayload,
  AsrPartialPayload,
  ControlEnvelope,
  OutputAudioDonePayload,
  OutputAudioStartPayload,
  ProtocolErrorPayload,
} from "../types/protocol";
import type { CancelReason, RequestOptionsSnapshot } from "../types/request";
import { isTerminalRequestState } from "./requestStateMachine";
import { TextOutputController } from "./textOutputController";

const ASR_FINAL_TIMEOUT_MS = 10_000;
const LLM_FIRST_TOKEN_TIMEOUT_MS = 15_000;
const REQUEST_DONE_TIMEOUT_MS = 30_000;

export class VoiceRequestController {
  private asrTimer: ReturnType<typeof setTimeout> | null = null;
  private focusListenerAttached = false;
  private llmTimer: ReturnType<typeof setTimeout> | null = null;
  private transport: VoiceTransport | null = null;
  private identity: VoiceClientIdentity | null = null;
  private lastLoggedUnderrunCount = 0;
  private playbackRequestId: string | null = null;
  private requestDoneTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly connection = useConnectionStore();
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();
  readonly textOutput = new TextOutputController(createTextOutputBackend());
  private readonly player = new StreamingAudioPlayer({
    onError: (message) => {
      requestStoreActions.setPlaybackError(message);
      requestStoreActions.setAssistantWarning(message);
      diagnosticsStoreActions.log("error", "player", "player.error", message, {
        requestId: this.request.state.activeRequestId ?? undefined,
      });
    },
    onMetrics: (metrics) => {
      requestStoreActions.setPlaybackMetrics(metrics);
      diagnosticsStoreActions.updateRuntimeMetrics({
        requestId: this.request.state.activeRequestId,
        underrunCount: metrics.underrunCount,
      });
      if (metrics.underrunCount > this.lastLoggedUnderrunCount) {
        this.lastLoggedUnderrunCount = metrics.underrunCount;
        diagnosticsStoreActions.log(
          "warn",
          "player",
          "player.underrun",
          "播放器发生缓冲中断",
          {
            requestId: this.request.state.activeRequestId ?? undefined,
            fields: { underrunCount: metrics.underrunCount },
          },
        );
      }
    },
    onStatusChange: (status) => {
      requestStoreActions.setPlaybackStatus(status);
      if (status === "playing") {
        diagnosticsStoreActions.recordTimeline(
          "output.playback_started",
          "output",
          "语音开始播放",
          undefined,
          this.playbackRequestId ?? undefined,
        );
      } else if (status === "done") {
        diagnosticsStoreActions.recordTimeline(
          "output.playback_done",
          "output",
          "语音播放完成",
          undefined,
          this.playbackRequestId ?? undefined,
        );
        this.playbackRequestId = null;
      }
    },
  });
  private readonly router = new ProtocolEventRouter({
    onConnectionEvent: (message) => this.handleConnectionEvent(message),
    onRequestEvent: (message) => this.handleRequestEvent(message),
  });

  connect(identity: VoiceClientIdentity) {
    this.identity = identity;
    if (this.transport) {
      this.transport.connect();
      return;
    }
    this.transport = new VoiceTransport(
      this.settings.state.serviceUrl,
      identity,
      {
        onAudioFrame: (frame) => {
          if (
            frame.requestId === this.request.state.activeRequestId &&
            !isTerminalRequestState(this.request.state.status)
          ) {
            diagnosticsStoreActions.noteOutputAudioChunk(frame.requestId);
            diagnosticsStoreActions.recordTimeline(
              "output.first_chunk",
              "tts",
              "收到首个语音分片",
            );
            this.player.enqueue(frame);
          }
        },
        onControlMessage: (message) => {
          const route = this.router.route(
            message,
            this.request.state.activeRequestId,
            isTerminalRequestState(this.request.state.status),
          );
          if (
            ["duplicate", "stale_request", "terminal_request", "unknown"].includes(
              route,
            )
          ) {
            diagnosticsStoreActions.log(
              "warn",
              "protocol",
              `message.${route}`,
              `协议消息未进入业务处理：${message.type}`,
              {
                requestId: message.request_id ?? undefined,
                fields: { route, messageType: message.type },
              },
            );
          }
        },
        onReconnectAttempt: (attempt) => {
          connectionStoreActions.setReconnectAttempt(attempt);
          diagnosticsStoreActions.updateRuntimeMetrics({ reconnectCount: attempt });
          diagnosticsStoreActions.log(
            "warn",
            "connection",
            "connection.reconnect",
            "服务连接正在重试",
            { fields: { attempt } },
          );
        },
        onServerHello: (hello) => {
          const preferredPipeline = this.settings.state.serviceProfiles.find(
            (profile) => profile.id === this.settings.state.activeServiceProfileId,
          )?.preferredPipeline;
          if (
            preferredPipeline &&
            preferredPipeline !== "auto" &&
            hello.pipeline !== preferredPipeline
          ) {
            const message = `服务 Pipeline 为 ${hello.pipeline}，与档案要求的 ${preferredPipeline} 不一致`;
            diagnosticsStoreActions.log(
              "error",
              "connection",
              "connection.pipeline_mismatch",
              message,
            );
            this.transport?.disconnect();
            connectionStoreActions.setServerHello(null);
            connectionStoreActions.setError(message);
            return;
          }
          connectionStoreActions.setServerHello(hello);
          settingsStoreActions.hydrateInferenceSelections(hello);
          diagnosticsStoreActions.log(
            "info",
            "connection",
            "connection.handshake_succeeded",
            "服务握手成功",
            {
              fields: {
                protocolVersion: hello.protocol_version,
                pipeline: hello.pipeline,
              },
            },
          );
        },
        onStatusChange: (status) => {
          connectionStoreActions.setStatus(status);
          diagnosticsStoreActions.log(
            status === "error" ? "error" : "info",
            "connection",
            `connection.${status}`,
            `连接状态变更为 ${status}`,
          );
          if (status !== "connected" && this.request.state.activeRequestId) {
            this.fail("连接已断开，当前录音请求无法恢复", "connection_lost");
          }
        },
        onTransportError: (error) => {
          connectionStoreActions.setError(error.message);
          diagnosticsStoreActions.log("error", "protocol", error.code, error.message);
        },
      },
      {
        tokenProvider: () =>
          this.settings.state.serviceProfiles.find(
            (profile) => profile.id === this.settings.state.activeServiceProfileId,
          )?.authMode === "bearer"
            ? readServiceTokenForConnection(this.settings.state.activeServiceProfileId)
            : Promise.resolve(null),
      },
    );
    this.transport.connect();
    if (!this.focusListenerAttached) {
      window.addEventListener("focus", this.retryConnection);
      this.focusListenerAttached = true;
    }
  }

  setIdentity(identity: VoiceClientIdentity) {
    this.identity = identity;
  }

  connectConfiguredService() {
    if (this.identity) this.connect(this.identity);
  }

  disconnect() {
    this.clearRequestTimers();
    this.player.dispose();
    this.textOutput.dispose();
    this.transport?.disconnect();
    this.transport = null;
    connectionStoreActions.setServerHello(null);
    if (this.focusListenerAttached) {
      window.removeEventListener("focus", this.retryConnection);
      this.focusListenerAttached = false;
    }
  }

  reconnectWithCurrentSettings() {
    const identity = this.identity;
    if (!identity) return;
    this.disconnect();
    this.identity = identity;
    if (this.settings.state.autoConnect) this.connect(identity);
  }

  setPlaybackVolume(volume: number) {
    this.player.setVolume(volume);
  }

  readonly retryConnection = () => {
    connectionStoreActions.setError("");
    this.transport?.retryNow();
  };

  async startRequest() {
    const hello = this.connection.state.serverHello;
    if (!this.transport || this.connection.state.status !== "connected" || !hello) {
      throw new VoiceTransportError("connection_not_ready", "请先等待推理服务连接完成");
    }
    if (this.request.state.activeRequestId) {
      throw new VoiceTransportError("request_already_active", "已有录音请求正在进行");
    }

    this.player.stop("idle");
    this.playbackRequestId = null;
    this.lastLoggedUnderrunCount = 0;
    const snapshot = this.createOptionsSnapshot();
    requestStoreActions.setOptionsSnapshot(snapshot);
    if (snapshot.protocolMode === "assistant" && !hello.features.streaming_text) {
      const error = new VoiceTransportError(
        "streaming_text_unsupported",
        "当前服务不支持助手文本流",
      );
      this.fail(error.message, "protocol_error");
      throw error;
    }

    try {
      const accepted = await this.transport.startRequest({
        mode: snapshot.protocolMode,
        language: snapshot.language,
        conversation_id: null,
        selection: {
          asr: snapshot.selection.asr,
          llm: snapshot.selection.llm,
          tts: snapshot.selection.tts,
          output_audio: snapshot.selection.outputAudio,
        },
        input_audio: {
          encoding: "pcm_s16le",
          sample_rate: 16_000,
          channels: 1,
          frame_duration_ms: 20,
        },
        response: {
          text: snapshot.protocolMode === "assistant",
          audio: snapshot.wantsAudio,
          voice: snapshot.voice,
        },
      });
      requestStoreActions.setActiveRequest(accepted.requestId);
      diagnosticsStoreActions.bindRequestId(accepted.requestId);
      diagnosticsStoreActions.log(
        "info",
        "request",
        "request.accepted",
        "服务端已接受请求",
        { requestId: accepted.requestId },
      );
      return accepted.requestId;
    } catch (error) {
      this.fail(describeTransportError(error), "protocol_error");
      throw error;
    }
  }

  markRecording() {
    if (this.request.state.activeRequestId) {
      requestStoreActions.transition("recording", "recording_started");
    }
  }

  sendAudioFrame(frame: Int16Array, sequence: number) {
    const requestId = this.request.state.activeRequestId;
    if (!this.transport || !requestId || this.request.state.status !== "recording") {
      return false;
    }
    try {
      requestStoreActions.setNetworkCongested(
        this.transport.sendInputAudio(requestId, sequence, sequence * 20_000, frame),
      );
      if (sequence === 0) {
        diagnosticsStoreActions.recordTimeline(
          "audio.first_frame_sent",
          "input",
          "首个音频帧已发送",
        );
      }
      return true;
    } catch (error) {
      requestStoreActions.setNetworkCongested(false);
      this.fail(describeTransportError(error), "audio_backpressure");
      void this.transport.cancelRequest(requestId, "audio_backpressure");
      return false;
    }
  }

  async commitInput(result: RecordingResult) {
    const requestId = this.request.state.activeRequestId;
    if (!this.transport || !requestId) {
      throw new VoiceTransportError("request_not_found", "没有可以提交的录音请求");
    }
    requestStoreActions.transition("committing", "recording_stopped");
    requestStoreActions.setNetworkCongested(false);
    try {
      diagnosticsStoreActions.recordTimeline(
        "input.commit_sent",
        "input",
        "录音提交已发送",
      );
      await this.transport.commitInput(requestId, {
        last_sequence: result.frameCount > 0 ? result.frameCount - 1 : null,
        frame_count: result.frameCount,
        sample_count: result.sampleCount,
        duration_ms: Math.round(result.durationMs),
      });
      if (
        this.request.state.activeRequestId === requestId &&
        this.request.state.status === "committing"
      ) {
        requestStoreActions.transition("recognizing", "input_committed");
        diagnosticsStoreActions.recordTimeline(
          "input.committed",
          "input",
          "服务端已确认音频提交",
        );
        this.startAsrTimer(requestId);
        this.startRequestDoneTimer(requestId);
      }
    } catch (error) {
      this.fail(describeTransportError(error), "client_timeout");
      void this.transport.cancelRequest(requestId, "client_timeout");
      throw error;
    }
  }

  async cancelCurrentRequest(reason: CancelReason = "user_cancelled") {
    this.clearRequestTimers();
    this.player.stop("stopped");
    const requestId = this.request.state.activeRequestId;
    if (isTerminalRequestState(this.request.state.status)) return;
    if (this.request.state.status === "idle") return;
    requestStoreActions.transition("cancelling", reason);
    if (this.transport && requestId) {
      diagnosticsStoreActions.recordTimeline(
        "request.cancel_sent",
        "request",
        "取消请求已发送",
        { reason },
      );
    }
    try {
      if (this.transport && requestId) {
        await this.transport.cancelRequest(requestId, reason);
      }
    } catch (error) {
      requestStoreActions.setError(describeTransportError(error));
    } finally {
      if (!isTerminalRequestState(this.request.state.status)) {
        requestStoreActions.transition("cancelled", "local_cleanup_completed");
      }
      diagnosticsStoreActions.finishTimeline(
        "request.cancelled",
        "cancelled",
        "请求已取消",
        { reason },
      );
      requestStoreActions.clearActiveRequest();
    }
  }

  async interruptPlayback() {
    this.player.stop("stopped");
    if (this.request.state.activeRequestId) {
      await this.cancelCurrentRequest("user_interrupted");
    }
  }

  private createOptionsSnapshot(): RequestOptionsSnapshot {
    const hello = this.connection.state.serverHello;
    if (!hello) throw new Error("server.hello 不可用");
    const defaults = hello.inference_options.defaults;
    const protocolMode =
      this.settings.state.selectedMode === "dictation" ? "dictation" : "assistant";
    let wantsAudio = protocolMode === "assistant" && hello.features.streaming_audio;
    wantsAudio = wantsAudio && this.settings.state.audioResponseEnabled;
    if (wantsAudio && !this.player.prepare()) wantsAudio = false;
    this.player.setVolume(this.settings.state.playbackVolume);
    return Object.freeze({
      autoInjectionEnabled:
        this.settings.state.autoInjection[this.settings.state.selectedMode],
      injectionMaxCodePoints: this.settings.state.injectionMaxCodePoints,
      inputDeviceId: this.settings.state.inputDeviceId,
      mode: this.settings.state.selectedMode,
      protocolMode,
      language: this.settings.state.language,
      wantsAudio,
      voice: this.settings.state.voice,
      playbackVolume: this.settings.state.playbackVolume,
      selection: Object.freeze({
        asr: this.settings.state.selectedAsrId || defaults.asr,
        llm:
          protocolMode === "assistant"
            ? this.settings.state.selectedLlmId || defaults.llm
            : null,
        tts: wantsAudio ? this.settings.state.selectedTtsId || defaults.tts : null,
        outputAudio: wantsAudio
          ? this.settings.state.selectedOutputAudioId || defaults.output_audio
          : null,
      }),
    });
  }

  private handleConnectionEvent(message: ControlEnvelope<unknown>) {
    if (message.type !== "error") return;
    const payload = message.payload as ProtocolErrorPayload;
    connectionStoreActions.setError(payload.message || payload.code);
    diagnosticsStoreActions.log(
      "error",
      "protocol",
      payload.code,
      payload.message || payload.code,
    );
  }

  private handleRequestEvent(message: ControlEnvelope<unknown>) {
    switch (message.type) {
      case "asr.partial": {
        const payload = message.payload as AsrPartialPayload;
        if (
          typeof payload.text === "string" &&
          Number.isInteger(payload.revision) &&
          payload.revision > this.request.state.asrRevision
        ) {
          requestStoreActions.setAsrPartial(payload.text, payload.revision);
          diagnosticsStoreActions.recordTimeline(
            "asr.first_partial",
            "asr",
            "收到首个临时识别结果",
          );
        }
        break;
      }
      case "asr.final":
        this.handleAsrFinal(message);
        break;
      case "assistant.text.delta":
        this.handleAssistantDelta(message);
        break;
      case "assistant.text.done":
        this.handleAssistantDone(message);
        break;
      case "output.audio.start":
        this.handleAudioStart(message);
        break;
      case "output.audio.done":
        this.handleAudioDone(message);
        break;
      case "request.done":
        this.completeRequest();
        break;
      case "request.cancelled":
        this.clearRequestTimers();
        this.player.stop("stopped");
        if (this.request.state.status !== "cancelling") {
          this.fail("请求取消消息顺序无效", "protocol_error");
          break;
        }
        requestStoreActions.transition("cancelled", "server_cancelled");
        diagnosticsStoreActions.finishTimeline(
          "request.cancelled",
          "cancelled",
          "服务端已确认取消请求",
        );
        requestStoreActions.clearActiveRequest();
        break;
      case "error":
        this.handleRequestError(message.payload as ProtocolErrorPayload);
        break;
    }
  }

  private handleAsrFinal(message: ControlEnvelope<unknown>) {
    const payload = message.payload as AsrFinalPayload;
    if (typeof payload.text !== "string") return;
    if (!["committing", "recognizing"].includes(this.request.state.status)) {
      this.fail("最终识别消息顺序无效", "protocol_error");
      return;
    }
    this.clearAsrTimer();
    if (this.request.state.status === "committing") {
      requestStoreActions.transition("recognizing", "asr_final_before_commit_ack");
    }
    requestStoreActions.setAsrFinal(payload.text, payload.language);
    diagnosticsStoreActions.recordTimeline("asr.final", "asr", "收到最终识别结果", {
      language: payload.language,
    });
    const snapshot = this.request.state.optionsSnapshot;
    if (snapshot?.protocolMode === "assistant") {
      requestStoreActions.transition("generating", "asr_final");
      this.startLlmTimer(message.request_id);
    } else if (snapshot?.autoInjectionEnabled) {
      void this.textOutput.output(payload.text, 0, snapshot.injectionMaxCodePoints);
    }
  }

  private handleAssistantDelta(message: ControlEnvelope<unknown>) {
    if (!["recognizing", "generating", "playing"].includes(this.request.state.status)) {
      this.fail("助手文本消息顺序无效", "protocol_error");
      return;
    }
    const expectedSequence = this.request.state.assistantLastSequence + 1;
    try {
      const payload = validateAssistantTextDelta(message.payload, expectedSequence);
      this.clearLlmTimer();
      if (this.request.state.status === "recognizing") {
        requestStoreActions.transition("generating", "assistant_first_token");
      }
      requestStoreActions.setAssistantDelta(payload.delta, payload.sequence);
      diagnosticsStoreActions.recordTimeline(
        "assistant.first_token",
        "llm",
        "收到助手首个文本分片",
      );
    } catch {
      this.fail(`回复文本分片序号异常：期望 ${expectedSequence}`, "protocol_error");
    }
  }

  private handleAssistantDone(message: ControlEnvelope<unknown>) {
    if (!["generating", "playing"].includes(this.request.state.status)) {
      this.fail("助手文本结束消息顺序无效", "protocol_error");
      return;
    }
    this.clearLlmTimer();
    try {
      const payload = validateAssistantTextDone(
        message.payload,
        this.request.state.assistantLastSequence,
      );
      if (payload.text !== this.request.state.assistantStreaming) {
        requestStoreActions.setAssistantWarning(
          "流式文本与最终文本不一致，已采用最终结果",
        );
      }
      requestStoreActions.setAssistantFinal(payload.text);
      diagnosticsStoreActions.recordTimeline(
        "assistant.text_done",
        "llm",
        "助手文本接收完成",
      );
      const snapshot = this.request.state.optionsSnapshot;
      if (snapshot?.autoInjectionEnabled) {
        void this.textOutput.output(payload.text, 0, snapshot.injectionMaxCodePoints);
      }
    } catch {
      this.fail("回复文本结束消息与已接收分片不一致", "protocol_error");
    }
  }

  private handleAudioStart(message: ControlEnvelope<unknown>) {
    try {
      const payload = validateOutputAudioStart(
        message.payload,
      ) as OutputAudioStartPayload;
      if (!message.request_id) throw new Error("output audio request ID is missing");
      if (this.request.state.status === "recognizing") {
        requestStoreActions.transition("generating", "audio_started_before_text");
      }
      requestStoreActions.transition("playing", "output_audio_started");
      requestStoreActions.setPlaybackError("");
      this.playbackRequestId = message.request_id;
      this.player.start(message.request_id, payload);
    } catch {
      requestStoreActions.setPlaybackError("服务端返回了不受支持的语音格式");
      requestStoreActions.setAssistantWarning("服务端返回了不受支持的语音格式");
      this.fail("服务端返回了不受支持的语音格式", "protocol_error");
    }
  }

  private handleAudioDone(message: ControlEnvelope<unknown>) {
    if (this.request.state.status !== "playing") {
      this.fail("语音结束消息顺序无效", "protocol_error");
      return;
    }
    try {
      this.player.finish(
        validateOutputAudioDone(message.payload) as OutputAudioDonePayload,
      );
    } catch {
      requestStoreActions.setPlaybackError("语音分片统计不一致，已停止播放");
      requestStoreActions.setAssistantWarning("语音分片统计不一致，已停止播放");
      this.player.stop("error");
    }
  }

  private handleRequestError(payload: ProtocolErrorPayload) {
    if (payload.stage === "tts" && !payload.fatal) {
      const message = payload.message || payload.code;
      requestStoreActions.setPlaybackError(message);
      requestStoreActions.setAssistantWarning(`语音播放不可用：${message}`);
      this.player.stop("error");
      return;
    }
    requestStoreActions.setError(payload.message || payload.code);
    if (payload.fatal) this.fail(payload.message || payload.code, "protocol_error");
  }

  private completeRequest() {
    this.clearRequestTimers();
    if (!["recognizing", "generating", "playing"].includes(this.request.state.status)) {
      this.fail("请求结束消息顺序无效", "protocol_error");
      return;
    }
    const snapshot = this.request.state.optionsSnapshot;
    if (!this.request.state.asrFinal) {
      this.fail("请求提前结束，未收到最终识别结果", "protocol_error");
      return;
    }
    if (snapshot?.protocolMode === "assistant" && !this.request.state.assistantFinal) {
      this.fail("请求提前结束，未收到完整的助手回复", "protocol_error");
      return;
    }
    requestStoreActions.transition("completed", "request_done");
    diagnosticsStoreActions.finishTimeline("request.done", "completed", "请求已完成");
    requestStoreActions.clearActiveRequest();
  }

  private fail(message: string, reason: CancelReason) {
    this.clearRequestTimers();
    this.player.stop("error");
    requestStoreActions.setError(message);
    if (!isTerminalRequestState(this.request.state.status)) {
      requestStoreActions.transition("failed", reason);
    }
    diagnosticsStoreActions.finishTimeline("request.failed", "failed", message, {
      reason,
    });
    requestStoreActions.clearActiveRequest();
  }

  private startAsrTimer(requestId: string) {
    this.clearAsrTimer();
    this.asrTimer = setTimeout(() => {
      if (
        this.request.state.activeRequestId === requestId &&
        !this.request.state.asrFinal
      ) {
        this.fail("等待最终识别结果超时", "client_timeout");
        void this.transport?.cancelRequest(requestId, "client_timeout");
      }
    }, ASR_FINAL_TIMEOUT_MS);
  }

  private startLlmTimer(requestId: string | null) {
    this.clearLlmTimer();
    if (!requestId) return;
    this.llmTimer = setTimeout(() => {
      if (
        this.request.state.activeRequestId === requestId &&
        this.request.state.assistantLastSequence < 0
      ) {
        this.fail("等待助手回复首个文本分片超时", "client_timeout");
        void this.transport?.cancelRequest(requestId, "client_timeout");
      }
    }, LLM_FIRST_TOKEN_TIMEOUT_MS);
  }

  private clearAsrTimer() {
    if (this.asrTimer) clearTimeout(this.asrTimer);
    this.asrTimer = null;
  }

  private clearLlmTimer() {
    if (this.llmTimer) clearTimeout(this.llmTimer);
    this.llmTimer = null;
  }

  private clearRequestTimers() {
    this.clearAsrTimer();
    this.clearLlmTimer();
    if (this.requestDoneTimer) clearTimeout(this.requestDoneTimer);
    this.requestDoneTimer = null;
  }

  private startRequestDoneTimer(requestId: string) {
    if (this.requestDoneTimer) clearTimeout(this.requestDoneTimer);
    this.requestDoneTimer = setTimeout(() => {
      if (this.request.state.activeRequestId === requestId) {
        this.fail("等待请求结束消息超时", "client_timeout");
        void this.transport?.cancelRequest(requestId, "client_timeout");
      }
    }, REQUEST_DONE_TIMEOUT_MS);
  }
}

function describeTransportError(error: unknown) {
  return error instanceof Error ? error.message : "语音服务请求失败";
}

export const voiceRequestController = new VoiceRequestController();

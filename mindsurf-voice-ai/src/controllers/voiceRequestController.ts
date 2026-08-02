import { StreamingAudioPlayer } from "../audio/streamingPlayer";
import {
  validateAssistantTextDelta,
  validateAssistantTextDone,
  validateOutputAudioDone,
  validateOutputAudioStart,
} from "../services/protocol";
import type { RecordingResult } from "../services/recorder";
import { DirectInjectionBackend } from "../services/text-output/directInjectionBackend";
import { ProtocolEventRouter } from "../services/transport/protocolEventRouter";
import {
  VoiceTransport,
  VoiceTransportError,
  type VoiceClientIdentity,
} from "../services/transport/voiceTransport";
import { connectionStoreActions, useConnectionStore } from "../stores/connectionStore";
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

export class VoiceRequestController {
  private asrTimer: ReturnType<typeof setTimeout> | null = null;
  private focusListenerAttached = false;
  private llmTimer: ReturnType<typeof setTimeout> | null = null;
  private transport: VoiceTransport | null = null;
  private readonly connection = useConnectionStore();
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();
  readonly textOutput = new TextOutputController(new DirectInjectionBackend());
  private readonly player = new StreamingAudioPlayer({
    onError: (message) => {
      requestStoreActions.setPlaybackError(message);
      requestStoreActions.setAssistantWarning(message);
    },
    onMetrics: requestStoreActions.setPlaybackMetrics,
    onStatusChange: requestStoreActions.setPlaybackStatus,
  });
  private readonly router = new ProtocolEventRouter({
    onConnectionEvent: (message) => this.handleConnectionEvent(message),
    onRequestEvent: (message) => this.handleRequestEvent(message),
  });

  connect(identity: VoiceClientIdentity) {
    if (this.transport) {
      this.transport.connect();
      return;
    }
    this.transport = new VoiceTransport(this.connection.state.serviceUrl, identity, {
      onAudioFrame: (frame) => {
        if (
          frame.requestId === this.request.state.activeRequestId &&
          !isTerminalRequestState(this.request.state.status)
        ) {
          this.player.enqueue(frame);
        }
      },
      onControlMessage: (message) => {
        this.router.route(
          message,
          this.request.state.activeRequestId,
          isTerminalRequestState(this.request.state.status),
        );
      },
      onReconnectAttempt: connectionStoreActions.setReconnectAttempt,
      onServerHello: (hello) => {
        connectionStoreActions.setServerHello(hello);
        settingsStoreActions.hydrateInferenceSelections(hello);
      },
      onStatusChange: (status) => {
        connectionStoreActions.setStatus(status);
        if (status !== "connected" && this.request.state.activeRequestId) {
          this.fail("连接已断开，当前录音请求无法恢复", "connection_lost");
        }
      },
      onTransportError: (error) => connectionStoreActions.setError(error.message),
    });
    this.transport.connect();
    if (!this.focusListenerAttached) {
      window.addEventListener("focus", this.retryConnection);
      this.focusListenerAttached = true;
    }
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
    const snapshot = this.createOptionsSnapshot();
    requestStoreActions.begin(snapshot);
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
        this.startAsrTimer(requestId);
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
    if (wantsAudio && !this.player.prepare()) wantsAudio = false;
    return Object.freeze({
      autoInjectionEnabled:
        this.settings.state.autoInjection[this.settings.state.selectedMode],
      injectionMaxCodePoints: this.settings.state.injectionMaxCodePoints,
      mode: this.settings.state.selectedMode,
      protocolMode,
      language: "zh-CN",
      wantsAudio,
      voice: "default",
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
    if (snapshot?.protocolMode === "assistant" && !this.request.state.assistantFinal) {
      this.fail("请求提前结束，未收到完整的助手回复", "protocol_error");
      return;
    }
    requestStoreActions.transition("completed", "request_done");
    requestStoreActions.clearActiveRequest();
  }

  private fail(message: string, reason: CancelReason) {
    this.clearRequestTimers();
    this.player.stop("error");
    requestStoreActions.setError(message);
    if (!isTerminalRequestState(this.request.state.status)) {
      requestStoreActions.transition("failed", reason);
    }
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
  }
}

function describeTransportError(error: unknown) {
  return error instanceof Error ? error.message : "语音服务请求失败";
}

export const voiceRequestController = new VoiceRequestController();

import {
  createControlEnvelope,
  decodeOutputAudioFrame,
  encodeInputAudioFrame,
  parseControlEnvelope,
  ProtocolValidationError,
  validateServerHello,
} from "./protocol";
import {
  VOICE_SUBPROTOCOL,
  type ControlEnvelope,
  type OutputAudioFrame,
  type ProtocolErrorPayload,
  type RequestAcceptedPayload,
  type ServerHelloPayload,
} from "../types/protocol";
import type { ServiceConnectionStatus } from "../types/voice";

const CONNECT_TIMEOUT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 3_000;
const REQUEST_ACCEPT_TIMEOUT_MS = 2_000;
const INPUT_COMMIT_TIMEOUT_MS = 2_000;
const CANCEL_TIMEOUT_MS = 2_000;
const CONGESTED_THRESHOLD_BYTES = 256 * 1_024;
const FATAL_BACKPRESSURE_BYTES = 1_024 * 1_024;
const MAX_CONGESTION_MS = 2_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

export interface VoiceClientIdentity {
  version: string;
  platform: string;
  arch: string;
}

export interface VoiceWebSocketCallbacks {
  onAudioFrame: (frame: OutputAudioFrame) => void;
  onControlMessage: (message: ControlEnvelope<unknown>) => void;
  onReconnectAttempt: (attempt: number) => void;
  onServerHello: (payload: ServerHelloPayload) => void;
  onStatusChange: (status: ServiceConnectionStatus) => void;
  onTransportError: (error: VoiceTransportError) => void;
}

export interface VoiceTransportOptions {
  autoReconnect?: boolean;
  tokenProvider?: () => Promise<string | null>;
}

interface MessageWaiter {
  requestId: string;
  type: string;
  resolve: (message: ControlEnvelope<unknown>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class VoiceTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable = true,
  ) {
    super(message);
    this.name = "VoiceTransportError";
  }
}

export class VoiceWebSocketClient {
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private congestionStartedAt: number | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private serverHello: ServerHelloPayload | null = null;
  private socket: WebSocket | null = null;
  private status: ServiceConnectionStatus = "disconnected";
  private userClosed = false;
  private waiters = new Set<MessageWaiter>();

  constructor(
    private readonly url: string,
    private readonly identity: VoiceClientIdentity,
    private readonly callbacks: VoiceWebSocketCallbacks,
    private readonly options: VoiceTransportOptions = {},
  ) {}

  get negotiatedServerHello() {
    return this.serverHello;
  }

  get connectionStatus() {
    return this.status;
  }

  connect() {
    if (
      this.socket?.readyState === WebSocket.OPEN ||
      this.socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }

    this.userClosed = false;
    this.clearReconnectTimer();
    this.setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    try {
      this.socket = new WebSocket(this.url, VOICE_SUBPROTOCOL);
    } catch {
      this.handleConnectionFailure(
        new VoiceTransportError("connection_failed", "无法创建 WebSocket 连接"),
      );
      return;
    }

    this.socket.binaryType = "arraybuffer";
    this.connectTimer = setTimeout(() => {
      this.callbacks.onTransportError(
        new VoiceTransportError("connection_timeout", "连接推理服务超时"),
      );
      this.socket?.close();
    }, CONNECT_TIMEOUT_MS);

    this.socket.onopen = () => void this.handleOpen();
    this.socket.onmessage = (event) => this.handleMessage(event);
    this.socket.onerror = () => {
      this.callbacks.onTransportError(
        new VoiceTransportError("connection_failed", "推理服务连接异常"),
      );
    };
    this.socket.onclose = (event) => this.handleClose(event);
  }

  disconnect() {
    this.userClosed = true;
    this.clearAllTimers();
    this.rejectWaiters(
      new VoiceTransportError("connection_closed", "WebSocket 已关闭"),
    );
    this.socket?.close(1_000, "app shutdown");
    this.socket = null;
    this.serverHello = null;
    this.setStatus("disconnected");
  }

  retryNow() {
    if (this.status === "connected" || this.status === "connecting") {
      return;
    }

    this.clearReconnectTimer();
    this.connect();
  }

  async startRequest(payload: Record<string, unknown>) {
    this.assertReady();
    const requestId = crypto.randomUUID();
    const accepted = this.waitForMessage(
      requestId,
      "request.accepted",
      REQUEST_ACCEPT_TIMEOUT_MS,
    );
    this.sendControl("request.start", requestId, payload);

    const message = await accepted;
    return {
      requestId,
      payload: message.payload as RequestAcceptedPayload,
    };
  }

  sendInputAudio(
    requestId: string,
    sequence: number,
    timestampUs: number,
    payload: Int16Array,
  ) {
    this.assertReady();
    const socket = this.socket;
    if (!socket) {
      throw new VoiceTransportError("connection_closed", "WebSocket 未连接");
    }

    if (socket.bufferedAmount > FATAL_BACKPRESSURE_BYTES) {
      throw new VoiceTransportError("audio_backpressure", "音频发送队列超过 1 MiB");
    }

    const now = Date.now();
    if (socket.bufferedAmount >= CONGESTED_THRESHOLD_BYTES) {
      this.congestionStartedAt ??= now;
      if (now - this.congestionStartedAt > MAX_CONGESTION_MS) {
        throw new VoiceTransportError(
          "audio_backpressure",
          "音频发送队列持续拥塞超过 2 秒",
        );
      }
    } else {
      this.congestionStartedAt = null;
    }

    socket.send(encodeInputAudioFrame(requestId, sequence, timestampUs, payload));
    return socket.bufferedAmount >= CONGESTED_THRESHOLD_BYTES;
  }

  async commitInput(requestId: string, payload: Record<string, unknown>) {
    const committed = this.waitForMessage(
      requestId,
      "input.committed",
      INPUT_COMMIT_TIMEOUT_MS,
    );
    this.sendControl("input.commit", requestId, payload);
    return committed;
  }

  async cancelRequest(requestId: string, reason: string) {
    if (this.status !== "connected") {
      return;
    }

    const cancelled = this.waitForMessage(
      requestId,
      "request.cancelled",
      CANCEL_TIMEOUT_MS,
    );
    this.sendControl("request.cancel", requestId, { reason });
    await cancelled;
  }

  private async handleOpen() {
    this.clearTimer("connect");

    if (this.socket?.protocol !== VOICE_SUBPROTOCOL) {
      this.callbacks.onTransportError(
        new VoiceTransportError(
          "protocol_mismatch",
          "服务端未接受 MindSurf Voice 子协议",
          false,
        ),
      );
      this.socket?.close(1_002, "subprotocol mismatch");
      return;
    }

    this.handshakeTimer = setTimeout(() => {
      this.callbacks.onTransportError(
        new VoiceTransportError("handshake_timeout", "协议握手超时"),
      );
      this.socket?.close(4_001, "handshake timeout");
    }, HANDSHAKE_TIMEOUT_MS);

    let token: string | null;
    try {
      token = this.options.tokenProvider
        ? ((await this.options.tokenProvider()) ?? null)
        : null;
    } catch (error) {
      this.callbacks.onTransportError(
        new VoiceTransportError(
          "credential_unavailable",
          error instanceof Error ? error.message : "无法读取服务 Token",
          false,
        ),
      );
      this.userClosed = true;
      this.setStatus("error");
      this.socket?.close(4_003, "credential unavailable");
      return;
    }
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.sendControl("client.hello", null, {
      client: {
        name: "mindsurf-voice-ai",
        version: this.identity.version,
        platform: this.identity.platform,
        arch: this.identity.arch,
      },
      protocol_versions: [1],
      pipelines: ["cascade"],
      input_audio: [
        {
          encoding: "pcm_s16le",
          sample_rate: 16_000,
          channels: 1,
        },
      ],
      output_audio: [
        {
          encoding: "pcm_s16le",
          sample_rates: [16_000, 24_000],
          channels: 1,
        },
      ],
      ...(token
        ? {
            auth: {
              scheme: "bearer",
              token,
            },
          }
        : {}),
    });
  }

  private handleMessage(event: MessageEvent) {
    if (typeof event.data !== "string") {
      if (!(event.data instanceof ArrayBuffer)) {
        this.callbacks.onTransportError(
          new VoiceTransportError("invalid_audio_frame", "服务端二进制消息格式无效"),
        );
        return;
      }
      if (!this.serverHello) {
        this.sendProtocolError("handshake_required", "握手完成前收到二进制音频");
        this.socket?.close(1_002, "handshake required");
        return;
      }
      if (event.data.byteLength > this.serverHello.limits.max_binary_bytes) {
        this.sendProtocolError("invalid_audio_frame", "服务端音频分片超过协商上限");
        this.socket?.close(1_009, "binary message too large");
        return;
      }
      try {
        this.callbacks.onAudioFrame(decodeOutputAudioFrame(event.data));
        this.scheduleHeartbeatWatchdog();
      } catch (error) {
        const validationError =
          error instanceof ProtocolValidationError
            ? error
            : new ProtocolValidationError("invalid_audio_frame", "音频分片解析失败");
        this.sendProtocolError(validationError.code, validationError.message);
        this.callbacks.onTransportError(
          new VoiceTransportError(validationError.code, validationError.message),
        );
      }
      return;
    }

    let message: ControlEnvelope<unknown>;
    try {
      message = parseControlEnvelope(event.data);
    } catch (error) {
      const validationError =
        error instanceof ProtocolValidationError
          ? error
          : new ProtocolValidationError("invalid_message", "消息解析失败");
      this.sendProtocolError(validationError.code, validationError.message);
      this.callbacks.onTransportError(
        new VoiceTransportError(validationError.code, validationError.message),
      );
      return;
    }

    if (message.type === "server.hello") {
      try {
        validateServerHello(message.payload);
      } catch (error) {
        const validationError =
          error instanceof ProtocolValidationError
            ? error
            : new ProtocolValidationError("invalid_message", "server.hello 无效");
        this.sendProtocolError(validationError.code, validationError.message);
        this.socket?.close(1_002, "invalid server hello");
        return;
      }

      this.clearTimer("handshake");
      this.serverHello = message.payload;
      this.reconnectAttempt = 0;
      this.setStatus("connected");
      this.callbacks.onServerHello(message.payload);
      this.scheduleHeartbeatWatchdog();
    } else if (!this.serverHello && message.type !== "error") {
      this.sendProtocolError("handshake_required", "握手完成前收到业务消息");
      this.socket?.close(1_002, "handshake required");
      return;
    } else {
      this.scheduleHeartbeatWatchdog();
    }

    if (message.type === "session.ping") {
      const payload = message.payload as { nonce?: unknown };
      if (typeof payload.nonce === "string") {
        this.sendControl("session.pong", null, { nonce: payload.nonce });
      }
    }

    if (message.type === "error") {
      const payload = message.payload as Partial<ProtocolErrorPayload>;
      if (
        payload.fatal &&
        ["authentication_required", "authentication_failed", "token_expired"].includes(
          payload.code ?? "",
        )
      ) {
        this.userClosed = true;
        this.setStatus("error");
        this.socket?.close(4_003, "authentication failed");
      }
      this.rejectMatchingWaiters(
        message.request_id,
        new VoiceTransportError(
          payload.code ?? "server_error",
          payload.message ?? "服务端返回错误",
          payload.recoverable ?? true,
        ),
      );
    } else {
      this.resolveWaiters(message);
    }

    this.callbacks.onControlMessage(message);
  }

  private handleClose(event?: CloseEvent) {
    this.clearTimer("connect");
    this.clearTimer("handshake");
    this.clearTimer("heartbeat");
    this.socket = null;
    this.serverHello = null;
    this.congestionStartedAt = null;
    this.rejectWaiters(
      new VoiceTransportError("connection_closed", "WebSocket 连接已断开"),
    );

    if (this.userClosed) {
      if (this.status !== "error") this.setStatus("disconnected");
      return;
    }

    const closeReason = event?.reason
      ? `WebSocket 已断开：${event.reason} (${event.code})`
      : `WebSocket 已断开 (${event?.code ?? 1006})`;
    this.callbacks.onTransportError(
      new VoiceTransportError("connection_closed", closeReason),
    );
    this.scheduleReconnect();
  }

  private handleConnectionFailure(error: VoiceTransportError) {
    this.callbacks.onTransportError(error);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.options.autoReconnect === false) {
      this.setStatus("error");
      return;
    }
    this.setStatus("reconnecting");
    const delay =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ] ?? 15_000;
    this.reconnectAttempt += 1;
    this.callbacks.onReconnectAttempt(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private scheduleHeartbeatWatchdog() {
    this.clearTimer("heartbeat");
    if (!this.serverHello) {
      return;
    }

    const heartbeatWindow =
      (this.serverHello.heartbeat.interval_ms + this.serverHello.heartbeat.timeout_ms) *
      2;
    this.heartbeatTimer = setTimeout(() => {
      this.callbacks.onTransportError(
        new VoiceTransportError("heartbeat_timeout", "服务端心跳超时"),
      );
      this.socket?.close();
    }, heartbeatWindow);
  }

  private sendControl<TPayload>(
    type: string,
    requestId: string | null,
    payload: TPayload,
  ) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new VoiceTransportError("connection_closed", "WebSocket 未连接");
    }
    this.socket.send(JSON.stringify(createControlEnvelope(type, requestId, payload)));
  }

  private sendProtocolError(
    code: string,
    message: string,
    requestId: string | null = null,
  ) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return;
    }
    this.sendControl("error", requestId, {
      code,
      message,
      stage: "protocol",
      recoverable: true,
      fatal: false,
      details: {},
    });
  }

  private waitForMessage(requestId: string, type: string, timeoutMs: number) {
    return new Promise<ControlEnvelope<unknown>>((resolve, reject) => {
      const waiter: MessageWaiter = {
        requestId,
        type,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new VoiceTransportError(`${type}_timeout`, `等待 ${type} 超时`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private resolveWaiters(message: ControlEnvelope<unknown>) {
    for (const waiter of this.waiters) {
      if (waiter.requestId === message.request_id && waiter.type === message.type) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.resolve(message);
      }
    }
  }

  private rejectMatchingWaiters(requestId: string | null, error: Error) {
    for (const waiter of this.waiters) {
      if (requestId === null || waiter.requestId === requestId) {
        clearTimeout(waiter.timer);
        this.waiters.delete(waiter);
        waiter.reject(error);
      }
    }
  }

  private rejectWaiters(error: Error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }

  private assertReady() {
    if (this.status !== "connected" || !this.serverHello) {
      throw new VoiceTransportError("connection_not_ready", "推理服务尚未连接");
    }
  }

  private setStatus(status: ServiceConnectionStatus) {
    if (this.status === status) {
      return;
    }
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  private clearAllTimers() {
    this.clearTimer("connect");
    this.clearTimer("handshake");
    this.clearTimer("heartbeat");
    this.clearReconnectTimer();
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTimer(timer: "connect" | "handshake" | "heartbeat") {
    const current =
      timer === "connect"
        ? this.connectTimer
        : timer === "handshake"
          ? this.handshakeTimer
          : this.heartbeatTimer;
    if (current) {
      clearTimeout(current);
    }

    if (timer === "connect") {
      this.connectTimer = null;
    } else if (timer === "handshake") {
      this.handshakeTimer = null;
    } else {
      this.heartbeatTimer = null;
    }
  }
}

import type {
  V2ClientIdentity,
  V2ControlEnvelope,
  V2ProtocolError,
  V2ServerHello,
} from "../../types/realtimeV2";
import type { ServiceConnectionStatus } from "../../types/voice";
import { VoiceApiError } from "../http/voiceApiClient";
import {
  createClientHello,
  createSessionPong,
  parseProtocolError,
  parseServerControlMessage,
  parseServerHello,
  parseSessionPing,
  PRE_HELLO_MAX_CONTROL_BYTES,
  ProtocolV2Error,
  VOICE_SUBPROTOCOL_V2,
} from "./protocolV2";
import { RealtimeTicketError, RealtimeTicketProvider } from "./realtimeTicketProvider";

const CONNECT_TIMEOUT_MS = 8_000;
const HELLO_TIMEOUT_MS = 3_000;
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];
const MAX_SESSION_EVENT_IDS = 100_000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

type SocketFactory = (url: string, protocol: string) => WebSocket;

export interface VoiceTransportV2Callbacks {
  onStatusChange(status: ServiceConnectionStatus): void;
  onServerHello(hello: V2ServerHello): void;
  onControlMessage(message: V2ControlEnvelope): void;
  onError(error: VoiceTransportV2Error): void;
  onReconnectAttempt(attempt: number): void;
  onDuplicateEvent?(eventId: string): void;
  onSessionRevoked?(): void;
}

export class VoiceTransportV2Error extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
  ) {
    super(message);
    this.name = "VoiceTransportV2Error";
  }
}

export class VoiceTransportV2 {
  private socket: WebSocket | null = null;
  private status: ServiceConnectionStatus = "disconnected";
  private serverHello: V2ServerHello | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private userClosed = true;
  private forceReconnectAfterClose = false;
  private closeErrorAlreadyReported = false;
  private connectInFlight: Promise<void> | null = null;
  private readonly eventIds = new Set<string>();

  constructor(
    private readonly tickets: RealtimeTicketProvider,
    private readonly identity: V2ClientIdentity,
    private readonly callbacks: VoiceTransportV2Callbacks,
    private readonly socketFactory: SocketFactory = (url, protocol) =>
      new WebSocket(url, protocol),
    private readonly random: () => number = Math.random,
  ) {}

  get connectionStatus() {
    return this.status;
  }

  get negotiatedServerHello() {
    return this.serverHello;
  }

  sendControl(message: V2ControlEnvelope) {
    const socket = this.requireReadySocket();
    const serialized = JSON.stringify(message);
    const limit = this.serverHello!.limits.max_control_bytes;
    if (new TextEncoder().encode(serialized).byteLength > limit) {
      throw new VoiceTransportV2Error(
        "control_message_too_large",
        "控制消息超过协商上限",
        false,
      );
    }
    socket.send(serialized);
  }

  sendBinary(frame: ArrayBuffer) {
    const socket = this.requireReadySocket();
    if (frame.byteLength > this.serverHello!.limits.max_binary_bytes) {
      throw new VoiceTransportV2Error(
        "binary_message_too_large",
        "音频帧超过协商上限",
        false,
      );
    }
    socket.send(frame);
  }

  recycleConnection(reason = "active request timeout") {
    if (!this.socket) return;
    this.forceReconnectAfterClose = true;
    this.socket.close(4_002, reason);
  }

  connect() {
    if (
      this.socket?.readyState === WS_OPEN ||
      this.socket?.readyState === WS_CONNECTING ||
      this.connectInFlight
    ) {
      return this.connectInFlight ?? Promise.resolve();
    }
    this.userClosed = false;
    this.clearReconnectTimer();
    const generation = ++this.generation;
    this.setStatus(this.reconnectAttempt ? "reconnecting" : "connecting");
    const attempt = this.openWithFreshTicket(generation);
    this.connectInFlight = attempt;
    void attempt.finally(() => {
      if (this.connectInFlight === attempt) this.connectInFlight = null;
    });
    return attempt;
  }

  disconnect(reason = "client disconnect") {
    this.userClosed = true;
    this.generation += 1;
    this.clearTimers();
    this.connectInFlight = null;
    this.eventIds.clear();
    this.serverHello = null;
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === WS_OPEN || socket?.readyState === WS_CONNECTING) {
      socket.close(1_000, reason);
    }
    this.setStatus("disconnected");
  }

  retryNow() {
    if (this.status === "connected") return Promise.resolve();
    this.generation += 1;
    this.clearTimers();
    this.connectInFlight = null;
    this.eventIds.clear();
    this.serverHello = null;
    this.forceReconnectAfterClose = false;
    this.closeErrorAlreadyReported = false;
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === WS_OPEN || socket?.readyState === WS_CONNECTING) {
      socket.close(1_000, "manual retry");
    }
    this.reconnectAttempt = 0;
    this.setStatus("disconnected");
    return this.connect();
  }

  private async openWithFreshTicket(generation: number) {
    try {
      const ticket = await this.tickets.acquire();
      if (this.userClosed || generation !== this.generation) return;
      if (ticket.expiresAtMs <= Date.now()) {
        throw new RealtimeTicketError(
          "realtime_ticket_expired",
          "实时连接凭据在使用前已过期",
        );
      }
      let socket: WebSocket;
      try {
        socket = this.socketFactory(ticket.url, ticket.subprotocol);
      } catch (error) {
        throw new VoiceTransportV2Error(
          "connection_failed",
          describeWebSocketCreationFailure(error),
          true,
        );
      }
      this.socket = socket;
      this.closeErrorAlreadyReported = false;
      socket.binaryType = "arraybuffer";
      this.connectTimer = globalThis.setTimeout(() => {
        this.reportError("connection_timeout", "实时服务连接超时", true);
        this.closeErrorAlreadyReported = true;
        socket.close();
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => this.handleOpen(socket);
      socket.onmessage = (event) => this.handleMessage(socket, event);
      socket.onerror = () => {
        // The close event owns retry decisions and avoids duplicate user feedback.
      };
      socket.onclose = (event) => this.handleClose(socket, event);
    } catch (error) {
      if (this.userClosed || generation !== this.generation) return;
      this.handleAcquisitionFailure(error);
    }
  }

  private handleOpen(socket: WebSocket) {
    if (socket !== this.socket || this.userClosed) return;
    this.clearTimer("connect");
    if (socket.protocol !== VOICE_SUBPROTOCOL_V2) {
      this.reportError(
        "websocket_subprotocol_required",
        "服务端未接受 Voice v2 子协议",
        false,
      );
      this.closeErrorAlreadyReported = true;
      socket.close(1_002, "subprotocol mismatch");
      return;
    }
    try {
      socket.send(JSON.stringify(createClientHello(this.identity)));
    } catch {
      this.reportError("hello_send_failed", "发送客户端握手失败", true);
      this.closeErrorAlreadyReported = true;
      socket.close();
      return;
    }
    this.helloTimer = globalThis.setTimeout(() => {
      this.reportError("hello_timeout", "等待 server.hello 超时", false);
      this.closeErrorAlreadyReported = true;
      socket.close(4_001, "hello timeout");
    }, HELLO_TIMEOUT_MS);
  }

  private handleMessage(socket: WebSocket, event: MessageEvent) {
    if (socket !== this.socket || this.userClosed) return;
    if (typeof event.data !== "string") {
      this.protocolViolation(
        "server_binary_not_allowed",
        "v2 服务端不得发送二进制消息",
      );
      return;
    }
    let message: V2ControlEnvelope;
    try {
      message = parseServerControlMessage(
        event.data,
        this.serverHello?.limits.max_control_bytes ?? PRE_HELLO_MAX_CONTROL_BYTES,
      );
    } catch (error) {
      const protocolError =
        error instanceof ProtocolV2Error
          ? error
          : new ProtocolV2Error("invalid_message", "控制消息解析失败");
      this.protocolViolation(protocolError.code, protocolError.message);
      return;
    }
    if (this.eventIds.has(message.event_id)) {
      this.callbacks.onDuplicateEvent?.(message.event_id);
      return;
    }
    if (this.eventIds.size >= MAX_SESSION_EVENT_IDS) {
      this.forceReconnectAfterClose = true;
      this.reportError(
        "event_id_safety_limit",
        "会话事件数量达到安全上限，正在重建连接",
        true,
      );
      this.closeErrorAlreadyReported = true;
      socket.close(4_002, "session safety limit");
      return;
    }
    this.eventIds.add(message.event_id);

    if (!this.serverHello) {
      if (message.type === "error") {
        this.handleErrorMessage(message);
        return;
      }
      if (message.type !== "server.hello") {
        this.protocolViolation("handshake_required", "server.hello 前收到其他消息");
        return;
      }
      const hello = parseServerHello(message.payload);
      this.clearTimer("hello");
      this.serverHello = hello;
      this.reconnectAttempt = 0;
      this.setStatus("connected");
      this.callbacks.onServerHello(hello);
      this.scheduleHeartbeatWatchdog();
      return;
    }

    if (message.type === "server.hello") {
      this.protocolViolation("invalid_message", "同一 session 重复收到 server.hello");
      return;
    }
    if (message.type === "session.ping") {
      const ping = parseSessionPing(message.payload);
      try {
        socket.send(JSON.stringify(createSessionPong(ping.nonce)));
      } catch {
        socket.close();
        return;
      }
      this.scheduleHeartbeatWatchdog();
    } else if (message.type === "error") {
      this.handleErrorMessage(message);
      return;
    }
    this.callbacks.onControlMessage(message);
  }

  private handleErrorMessage(message: V2ControlEnvelope) {
    const payload = parseProtocolError(message.payload, message.request_id);
    this.callbacks.onControlMessage(message);
    this.reportError(payload.code, safeServerErrorMessage(payload), payload.retryable);
    if (!payload.fatal) return;
    this.closeErrorAlreadyReported = true;
    if (payload.code === "session_revoked") {
      this.userClosed = true;
      this.callbacks.onSessionRevoked?.();
      this.socket?.close(4_003, "session revoked");
      return;
    }
    const closeCode = payload.retryable ? 1_011 : 1_002;
    this.socket?.close(closeCode, "fatal server error");
  }

  private handleClose(socket: WebSocket, event: CloseEvent) {
    if (socket !== this.socket) return;
    this.clearTimer("connect");
    this.clearTimer("hello");
    this.clearTimer("heartbeat");
    this.socket = null;
    this.serverHello = null;
    this.eventIds.clear();
    if (this.userClosed) {
      this.setStatus("disconnected");
      return;
    }
    const reconnect =
      this.forceReconnectAfterClose || shouldReconnectAfterClose(event.code);
    this.forceReconnectAfterClose = false;
    if (!reconnect) {
      if (!this.closeErrorAlreadyReported) {
        this.reportError(
          closeErrorCode(event.code),
          `实时连接已关闭（${event.code}）`,
          false,
        );
      }
      this.closeErrorAlreadyReported = false;
      this.setStatus("error");
      return;
    }
    if (!this.closeErrorAlreadyReported) {
      this.reportError(
        closeErrorCode(event.code),
        `实时连接中断（${event.code}），准备重连`,
        true,
      );
    }
    this.closeErrorAlreadyReported = false;
    this.scheduleReconnect();
  }

  private handleAcquisitionFailure(error: unknown) {
    const code =
      error instanceof VoiceApiError ||
      error instanceof RealtimeTicketError ||
      error instanceof VoiceTransportV2Error
        ? error.code
        : "ticket_request_failed";
    const message = error instanceof Error ? error.message : "申请实时连接凭据失败";
    const terminal = [
      "account_suspended",
      "authentication_required",
      "origin_not_allowed",
      "realtime_ticket_authority_mismatch",
      "realtime_ticket_path_invalid",
      "websocket_subprotocol_required",
    ].includes(code);
    this.reportError(code, message, !terminal);
    if (terminal) this.setStatus("error");
    else this.scheduleReconnect();
  }

  private scheduleHeartbeatWatchdog() {
    this.clearTimer("heartbeat");
    const hello = this.serverHello;
    if (!hello) return;
    this.heartbeatTimer = globalThis.setTimeout(() => {
      this.reportError("heartbeat_timeout", "服务端心跳超时，正在重建连接", true);
      this.forceReconnectAfterClose = true;
      this.closeErrorAlreadyReported = true;
      this.socket?.close(4_002, "heartbeat timeout");
    }, hello.heartbeat_interval_ms + hello.heartbeat_timeout_ms);
  }

  private scheduleReconnect() {
    if (this.userClosed || this.reconnectTimer) return;
    this.setStatus("reconnecting");
    const base =
      RECONNECT_DELAYS_MS[
        Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)
      ]!;
    const jitter = 0.8 + this.random() * 0.4;
    this.reconnectAttempt += 1;
    this.callbacks.onReconnectAttempt(this.reconnectAttempt);
    this.reconnectTimer = globalThis.setTimeout(
      () => {
        this.reconnectTimer = null;
        void this.connect();
      },
      Math.round(base * jitter),
    );
  }

  private protocolViolation(code: string, message: string) {
    this.reportError(code, message, false);
    this.closeErrorAlreadyReported = true;
    this.socket?.close(1_002, "protocol violation");
  }

  private reportError(code: string, message: string, recoverable: boolean) {
    this.callbacks.onError(new VoiceTransportV2Error(code, message, recoverable));
  }

  private requireReadySocket() {
    if (
      this.status !== "connected" ||
      !this.serverHello ||
      this.socket?.readyState !== WS_OPEN
    ) {
      throw new VoiceTransportV2Error(
        "connection_not_ready",
        "实时连接尚未完成握手",
        true,
      );
    }
    return this.socket;
  }

  private setStatus(status: ServiceConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.callbacks.onStatusChange(status);
  }

  private clearTimers() {
    this.clearTimer("connect");
    this.clearTimer("hello");
    this.clearTimer("heartbeat");
    this.clearReconnectTimer();
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) globalThis.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearTimer(timer: "connect" | "hello" | "heartbeat") {
    const current =
      timer === "connect"
        ? this.connectTimer
        : timer === "hello"
          ? this.helloTimer
          : this.heartbeatTimer;
    if (current) globalThis.clearTimeout(current);
    if (timer === "connect") this.connectTimer = null;
    else if (timer === "hello") this.helloTimer = null;
    else this.heartbeatTimer = null;
  }
}

export function shouldReconnectAfterClose(code: number) {
  return code !== 1_000 && code !== 1_002 && code !== 4_001;
}

function closeErrorCode(code: number) {
  if (code === 1_002) return "protocol_error";
  if (code === 4_001) return "hello_rejected";
  if (code === 4_002) return "heartbeat_timeout";
  if (code === 4_003) return "session_unavailable";
  return "connection_closed";
}

function safeServerErrorMessage(payload: V2ProtocolError) {
  const messages: Record<string, string> = {
    session_revoked: "登录 session 已被服务端撤销",
    server_error: "实时服务内部错误",
    rate_limit_exceeded: "实时请求过于频繁，请稍后重试",
    capabilities_stale: "服务能力目录已更新，需要刷新",
    pipeline_unavailable: "所选 Pipeline 暂时不可用",
  };
  return messages[payload.code] ?? `实时服务返回错误（${payload.code}）`;
}

function describeWebSocketCreationFailure(error: unknown) {
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : "unknown";
  if (name === "SecurityError") return "浏览器安全策略阻止创建实时连接";
  if (name === "SyntaxError") return "实时连接地址或子协议无效";
  if (name === "InvalidStateError") return "当前 WebView 状态无法创建实时连接";
  return name === "unknown" ? "无法创建实时连接" : `无法创建实时连接（${name}）`;
}

import type {
  V2ClientIdentity,
  V2ControlEnvelope,
  V2ServerHello,
} from "../types/realtimeV2";
import { diagnosticsStoreActions } from "../stores/diagnosticsStore";
import { realtimeConnectionStoreActions } from "../stores/realtimeConnectionStore";
import { RealtimeTicketProvider } from "../services/realtime/realtimeTicketProvider";
import { VoiceTransportV2 } from "../services/realtime/voiceTransportV2";
import { toast } from "../services/toast";

export class RealtimeConnectionController {
  private transport: VoiceTransportV2 | null = null;
  private lastNotifiedConnectionError = "";
  private onRequestTerminal: (() => void) | null = null;
  private requestListener: {
    onMessage(message: V2ControlEnvelope): void;
    onConnectionLost(): void;
  } | null = null;

  configure(
    tickets: RealtimeTicketProvider,
    identity: V2ClientIdentity,
    onSessionRevoked: () => void,
    onRequestTerminal: () => void,
  ) {
    this.disconnect();
    this.onRequestTerminal = onRequestTerminal;
    this.transport = new VoiceTransportV2(tickets, identity, {
      onStatusChange: (status) => {
        realtimeConnectionStoreActions.setStatus(status);
        diagnosticsStoreActions.log(
          status === "error" ? "error" : "info",
          "realtime_v2",
          `connection.${status}`,
          `Voice v2 连接状态变更为 ${status}`,
        );
        if (status !== "connected") this.requestListener?.onConnectionLost();
      },
      onServerHello: (hello) => {
        const recovered = Boolean(this.lastNotifiedConnectionError);
        this.lastNotifiedConnectionError = "";
        realtimeConnectionStoreActions.setServerHello(hello);
        realtimeConnectionStoreActions.setReconnectAttempt(0);
        diagnosticsStoreActions.log(
          "info",
          "realtime_v2",
          "connection.hello_succeeded",
          "Voice v2 长连接握手成功",
          {
            fields: {
              protocolVersion: hello.protocol_version,
              heartbeatIntervalMs: hello.heartbeat_interval_ms,
              maxControlBytes: hello.limits.max_control_bytes,
            },
          },
        );
        toast.success(recovered ? "实时服务连接已恢复" : "实时服务连接已建立", {
          title: recovered ? "连接已恢复" : "连接成功",
        });
      },
      onControlMessage: (message) => {
        if (message.type !== "session.ping") {
          diagnosticsStoreActions.log(
            "info",
            "realtime_v2",
            `message.${message.type}`,
            `收到 Voice v2 控制消息 ${message.type}`,
            { requestId: message.request_id ?? undefined },
          );
        }
        if (message.request_id !== null) this.requestListener?.onMessage(message);
      },
      onError: (error) => {
        realtimeConnectionStoreActions.setError(error.message);
        diagnosticsStoreActions.log(
          error.recoverable ? "warn" : "error",
          "realtime_v2",
          error.code,
          error.message,
        );
        if (error.message !== this.lastNotifiedConnectionError) {
          this.lastNotifiedConnectionError = error.message;
          const notify = error.recoverable ? toast.warning : toast.error;
          notify(error.message, {
            title: error.recoverable ? "连接异常，正在重试" : "连接失败",
            durationMs: error.recoverable ? 6_000 : 0,
          });
        }
      },
      onReconnectAttempt: (attempt) => {
        realtimeConnectionStoreActions.setReconnectAttempt(attempt);
      },
      onDuplicateEvent: () => {
        diagnosticsStoreActions.log(
          "warn",
          "realtime_v2",
          "message.duplicate",
          "已忽略重复的 Voice v2 event ID",
        );
      },
      onSessionRevoked,
    });
  }

  connect() {
    return this.transport?.connect() ?? Promise.resolve();
  }

  retryNow() {
    return this.transport?.retryNow() ?? Promise.resolve();
  }

  get serverHello(): V2ServerHello | null {
    return this.transport?.negotiatedServerHello ?? null;
  }

  setRequestListener(listener: RealtimeConnectionController["requestListener"]) {
    this.requestListener = listener;
  }

  sendControl(message: V2ControlEnvelope) {
    this.transport?.sendControl(message);
    if (!this.transport) throw new Error("实时连接尚未配置");
  }

  sendBinary(frame: ArrayBuffer) {
    this.transport?.sendBinary(frame);
    if (!this.transport) throw new Error("实时连接尚未配置");
  }

  recycleConnection(reason?: string) {
    this.transport?.recycleConnection(reason);
  }

  notifyRequestTerminal() {
    this.onRequestTerminal?.();
  }

  disconnect() {
    this.transport?.disconnect();
    this.lastNotifiedConnectionError = "";
    realtimeConnectionStoreActions.reset();
  }
}

export const realtimeConnectionController = new RealtimeConnectionController();

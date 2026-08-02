import { computed, reactive, readonly } from "vue";

import type { ServerHelloPayload } from "../types/protocol";
import { CONNECTION_STATUS_LABELS, type ServiceConnectionStatus } from "../types/voice";

export const DEFAULT_SERVICE_URL =
  import.meta.env.VITE_VOICE_SERVICE_URL ?? "ws://127.0.0.1:8000/v1/voice/ws";

const state = reactive({
  status: "disconnected" as ServiceConnectionStatus,
  serviceUrl: DEFAULT_SERVICE_URL,
  reconnectAttempt: 0,
  lastError: "",
  serverHello: null as ServerHelloPayload | null,
});

export const connectionStoreActions = {
  setError(message: string) {
    state.lastError = message;
  },
  setReconnectAttempt(attempt: number) {
    state.reconnectAttempt = attempt;
  },
  setServerHello(hello: ServerHelloPayload | null) {
    state.serverHello = hello;
    if (hello) {
      state.lastError = "";
    }
  },
  setStatus(status: ServiceConnectionStatus) {
    state.status = status;
  },
};

export function useConnectionStore() {
  return {
    connectionLabel: computed(() => CONNECTION_STATUS_LABELS[state.status]),
    state: readonly(state),
  };
}

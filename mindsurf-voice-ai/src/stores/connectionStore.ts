import { computed, reactive, readonly } from "vue";

import type { ServerHelloPayload } from "../types/protocol";
import { CONNECTION_STATUS_LABELS, type ServiceConnectionStatus } from "../types/voice";

const state = reactive({
  status: "disconnected" as ServiceConnectionStatus,
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

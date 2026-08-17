import { reactive, readonly } from "vue";
import type { V2ServerHello } from "../types/realtimeV2";
import type { ServiceConnectionStatus } from "../types/voice";

const state = reactive({
  status: "disconnected" as ServiceConnectionStatus,
  reconnectAttempt: 0,
  lastError: "",
  serverHello: null as V2ServerHello | null,
});

export const realtimeConnectionStoreActions = {
  setStatus(status: ServiceConnectionStatus) {
    state.status = status;
  },
  setReconnectAttempt(attempt: number) {
    state.reconnectAttempt = attempt;
  },
  setError(error: string) {
    state.lastError = error;
  },
  setServerHello(hello: V2ServerHello | null) {
    state.serverHello = hello;
    if (hello) state.lastError = "";
  },
  reset() {
    state.status = "disconnected";
    state.reconnectAttempt = 0;
    state.lastError = "";
    state.serverHello = null;
  },
};

export function useRealtimeConnectionStore() {
  return { state: readonly(state) };
}

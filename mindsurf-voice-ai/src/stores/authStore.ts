import { reactive, readonly } from "vue";

export type AuthStatus =
  | "signed_out"
  | "authorizing"
  | "exchanging"
  | "restoring"
  | "loading_account"
  | "authenticated"
  | "signing_out"
  | "error";

const state = reactive({
  status: "signed_out" as AuthStatus,
  error: "",
  refreshTokenConfigured: false,
});

export const authStoreActions = {
  setStatus(status: AuthStatus, error = "") {
    state.status = status;
    state.error = error;
  },
  setRefreshTokenConfigured(configured: boolean) {
    state.refreshTokenConfigured = configured;
  },
};

export function useAuthStore() {
  return { state: readonly(state) };
}

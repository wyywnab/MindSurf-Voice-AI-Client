import { reactive, readonly } from "vue";
import type { Quota } from "../types/httpApi";

const state = reactive({ quota: null as Quota | null, loading: false, error: "" });

export const quotaStoreActions = {
  setLoading() {
    state.loading = true;
    state.error = "";
  },
  setQuota(quota: Quota | null) {
    state.quota = quota;
    state.loading = false;
    state.error = "";
  },
  setError(error: string) {
    state.loading = false;
    state.error = error;
  },
};

export function useQuotaStore() {
  return { state: readonly(state) };
}

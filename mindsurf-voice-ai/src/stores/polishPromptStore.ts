import { reactive, readonly } from "vue";
import type { PolishPromptResource } from "../types/httpApi";

export type PolishPromptStatus =
  "idle" | "loading" | "ready" | "saving" | "unsupported" | "error";

const state = reactive({
  status: "idle" as PolishPromptStatus,
  resource: null as PolishPromptResource | null,
  error: "",
  revisionConflict: false,
});

export const polishPromptStoreActions = {
  setLoading() {
    state.status = "loading";
    state.error = "";
    state.revisionConflict = false;
  },
  setSaving() {
    state.status = "saving";
    state.error = "";
  },
  setResource(resource: PolishPromptResource, revisionConflict = false) {
    state.status = "ready";
    state.resource = resource;
    state.error = "";
    state.revisionConflict = revisionConflict;
  },
  clearConflict() {
    state.revisionConflict = false;
  },
  setUnsupported() {
    state.status = "unsupported";
    state.resource = null;
    state.error = "当前服务端不支持润色提示词管理";
    state.revisionConflict = false;
  },
  setError(message: string) {
    state.status = "error";
    state.error = message;
  },
  reset() {
    state.status = "idle";
    state.resource = null;
    state.error = "";
    state.revisionConflict = false;
  },
};

export function usePolishPromptStore() {
  return { state: readonly(state) };
}

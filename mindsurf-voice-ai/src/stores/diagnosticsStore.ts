import { reactive, readonly } from "vue";

import type { RequestTransition } from "../types/request";

const MAX_VISIBLE_TRANSITIONS = 100;

const state = reactive({
  requestTransitions: [] as RequestTransition[],
});

export const diagnosticsStoreActions = {
  recordTransition(transition: RequestTransition) {
    state.requestTransitions.push(transition);
    if (state.requestTransitions.length > MAX_VISIBLE_TRANSITIONS) {
      state.requestTransitions.splice(
        0,
        state.requestTransitions.length - MAX_VISIBLE_TRANSITIONS,
      );
    }
  },
};

export function useDiagnosticsStore() {
  return { state: readonly(state) };
}

import { reactive, readonly } from "vue";

import { createRequestTransition } from "../controllers/requestStateMachine";
import type { TextInjectionReport, TextInjectionStatus } from "../types/injection";
import type { V2TextStage } from "../types/realtimeV2";
import type { RequestLifecycleState, V2RequestOptionsSnapshot } from "../types/request";
import { diagnosticsStoreActions } from "./diagnosticsStore";

const state = reactive({
  activeRequestId: null as string | null,
  v2OptionsSnapshot: null as V2RequestOptionsSnapshot | null,
  status: "idle" as RequestLifecycleState,
  lastError: "",
  networkCongested: false,
  injectionError: "",
  injectionRemainingText: "",
  injectionReport: null as TextInjectionReport | null,
  injectionStatus: "idle" as TextInjectionStatus,
  temporaryText: "",
  stage: null as V2TextStage | null,
  asrNextSequence: 0,
  llmNextSequence: 0,
  finalSnapshotText: null as string | null,
  commitEligible: false,
  cancelRequested: false,
  acceptedMaxRecordingMs: null as number | null,
});

export const requestStoreActions = {
  beginPreparation() {
    requestStoreActions.resetResult();
    requestStoreActions.transition("preparing", "request_started");
  },
  beginV2(snapshot: V2RequestOptionsSnapshot, requestId: string) {
    requestStoreActions.resetResult();
    state.v2OptionsSnapshot = snapshot;
    state.activeRequestId = requestId;
    state.commitEligible = true;
    requestStoreActions.transition("starting", "request_start_sent");
  },
  clearActiveRequest() {
    state.activeRequestId = null;
  },
  resetResult() {
    state.lastError = "";
    state.networkCongested = false;
    state.temporaryText = "";
    state.stage = null;
    state.asrNextSequence = 0;
    state.llmNextSequence = 0;
    state.finalSnapshotText = null;
    state.commitEligible = false;
    state.cancelRequested = false;
    state.acceptedMaxRecordingMs = null;
  },
  setError(message: string) {
    state.lastError = message;
  },
  setInjectionResult(input: {
    status: TextInjectionStatus;
    error?: string;
    remainingText?: string;
    report?: TextInjectionReport | null;
  }) {
    state.injectionStatus = input.status;
    if (input.error !== undefined) state.injectionError = input.error;
    if (input.remainingText !== undefined)
      state.injectionRemainingText = input.remainingText;
    if (input.report !== undefined) state.injectionReport = input.report;
  },
  setNetworkCongested(congested: boolean) {
    state.networkCongested = congested;
  },
  setAcceptedMaxRecordingMs(value: number) {
    state.acceptedMaxRecordingMs = value;
  },
  appendTemporaryText(stage: V2TextStage, delta: string, sequence: number) {
    state.stage = stage;
    state.temporaryText += delta;
    if (stage === "asr") state.asrNextSequence = sequence + 1;
    else state.llmNextSequence = sequence + 1;
  },
  replaceTemporaryText(stage: V2TextStage, text: string) {
    state.stage = stage;
    state.temporaryText = text;
  },
  setFinalSnapshot(text: string) {
    state.finalSnapshotText = text;
  },
  revokeCommit(cancelRequested = false) {
    state.commitEligible = false;
    if (cancelRequested) state.cancelRequested = true;
  },
  transition(to: RequestLifecycleState, reason: string) {
    if (state.status === to) return true;
    try {
      const transition = createRequestTransition(state.status, to, reason);
      state.status = to;
      diagnosticsStoreActions.recordTransition(transition);
      return true;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : "请求状态异常";
      if (import.meta.env.DEV) throw error;
      const transition = {
        from: state.status,
        to: "failed" as const,
        reason: "illegal_transition",
        atMonotonicMs: performance.now(),
      };
      state.status = "failed";
      state.activeRequestId = null;
      diagnosticsStoreActions.recordTransition(transition);
      return false;
    }
  },
};

export function useRequestStore() {
  return { state: readonly(state) };
}

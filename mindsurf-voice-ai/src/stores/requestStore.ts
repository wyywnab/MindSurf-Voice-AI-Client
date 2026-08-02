import { reactive, readonly } from "vue";

import { createRequestTransition } from "../controllers/requestStateMachine";
import type { TextInjectionReport, TextInjectionStatus } from "../types/injection";
import type { RequestLifecycleState, RequestOptionsSnapshot } from "../types/request";
import type { PlaybackMetrics, PlaybackStatus } from "../types/voice";
import { diagnosticsStoreActions } from "./diagnosticsStore";

function emptyPlaybackMetrics(): PlaybackMetrics {
  return {
    firstChunkAt: null,
    playbackStartedAt: null,
    playbackCompletedAt: null,
    receivedChunks: 0,
    receivedSamples: 0,
    underrunCount: 0,
  };
}

const state = reactive({
  activeRequestId: null as string | null,
  optionsSnapshot: null as RequestOptionsSnapshot | null,
  status: "idle" as RequestLifecycleState,
  asrFinal: "",
  asrLanguage: "",
  asrPartial: "",
  asrRevision: -1,
  assistantFinal: "",
  assistantLastSequence: -1,
  assistantStreaming: "",
  assistantWarning: "",
  lastError: "",
  networkCongested: false,
  playbackError: "",
  playbackMetrics: emptyPlaybackMetrics(),
  playbackStatus: "idle" as PlaybackStatus,
  injectionError: "",
  injectionRemainingText: "",
  injectionReport: null as TextInjectionReport | null,
  injectionStatus: "idle" as TextInjectionStatus,
});

export const requestStoreActions = {
  beginPreparation() {
    requestStoreActions.resetResult();
    state.optionsSnapshot = null;
    requestStoreActions.transition("preparing", "request_started");
  },
  begin(snapshot: RequestOptionsSnapshot) {
    requestStoreActions.beginPreparation();
    state.optionsSnapshot = snapshot;
  },
  clearActiveRequest() {
    state.activeRequestId = null;
  },
  resetResult() {
    state.asrFinal = "";
    state.asrLanguage = "";
    state.asrPartial = "";
    state.asrRevision = -1;
    state.assistantFinal = "";
    state.assistantLastSequence = -1;
    state.assistantStreaming = "";
    state.assistantWarning = "";
    state.lastError = "";
    state.networkCongested = false;
    state.playbackError = "";
    state.playbackMetrics = emptyPlaybackMetrics();
    state.playbackStatus = "idle";
  },
  setActiveRequest(requestId: string | null) {
    state.activeRequestId = requestId;
  },
  setAsrFinal(text: string, language: string) {
    state.asrFinal = text;
    state.asrPartial = "";
    state.asrLanguage = language;
  },
  setAsrPartial(text: string, revision: number) {
    state.asrPartial = text;
    state.asrRevision = revision;
  },
  setAssistantDelta(text: string, sequence: number) {
    state.assistantStreaming += text;
    state.assistantLastSequence = sequence;
  },
  setAssistantFinal(text: string) {
    state.assistantFinal = text;
    state.assistantStreaming = text;
  },
  setAssistantWarning(message: string) {
    state.assistantWarning = message;
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
    if (input.remainingText !== undefined) {
      state.injectionRemainingText = input.remainingText;
    }
    if (input.report !== undefined) state.injectionReport = input.report;
  },
  setNetworkCongested(congested: boolean) {
    state.networkCongested = congested;
  },
  setOptionsSnapshot(snapshot: RequestOptionsSnapshot) {
    state.optionsSnapshot = snapshot;
  },
  setPlaybackError(message: string) {
    state.playbackError = message;
  },
  setPlaybackMetrics(metrics: PlaybackMetrics) {
    state.playbackMetrics = metrics;
  },
  setPlaybackStatus(status: PlaybackStatus) {
    state.playbackStatus = status;
  },
  transition(to: RequestLifecycleState, reason: string) {
    if (state.status === to) {
      return true;
    }
    try {
      const transition = createRequestTransition(state.status, to, reason);
      state.status = to;
      diagnosticsStoreActions.recordTransition(transition);
      return true;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : "请求状态异常";
      if (import.meta.env.DEV) {
        throw error;
      }
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

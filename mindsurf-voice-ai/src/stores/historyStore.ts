import { computed, reactive, readonly } from "vue";

import { recognitionHistoryRepository } from "../services/history/historyRepository";
import type { RecognitionHistoryEntry } from "../types/history";
import { diagnosticsStoreActions } from "./diagnosticsStore";

const state = reactive({
  userId: "",
  entries: [] as RecognitionHistoryEntry[],
  loading: false,
  mutating: false,
  error: "",
});

export const historyStoreActions = {
  async load(userId: string) {
    state.userId = userId;
    state.loading = true;
    state.error = "";
    try {
      const entries = await recognitionHistoryRepository.list(userId);
      if (state.userId === userId) state.entries = entries;
    } catch {
      if (state.userId === userId) state.error = describeError();
    } finally {
      if (state.userId === userId) state.loading = false;
    }
  },
  async add(entry: RecognitionHistoryEntry) {
    try {
      const entries = await recognitionHistoryRepository.add(entry);
      if (state.userId === entry.userId) state.entries = entries;
    } catch {
      state.error = describeError();
      diagnosticsStoreActions.log(
        "warn",
        "history",
        "history.write_failed",
        "识别历史写入失败",
      );
    }
  },
  async remove(userId: string, id: string) {
    state.mutating = true;
    state.error = "";
    try {
      const entries = await recognitionHistoryRepository.remove(userId, id);
      if (state.userId === userId) state.entries = entries;
      return true;
    } catch {
      state.error = describeError();
      return false;
    } finally {
      state.mutating = false;
    }
  },
  async clearUser(userId: string) {
    state.mutating = true;
    state.error = "";
    try {
      await recognitionHistoryRepository.clearUser(userId);
      if (state.userId === userId) state.entries = [];
      return true;
    } catch {
      state.error = describeError();
      return false;
    } finally {
      state.mutating = false;
    }
  },
  reset() {
    state.userId = "";
    state.entries = [];
    state.loading = false;
    state.mutating = false;
    state.error = "";
  },
};

export function useHistoryStore() {
  return {
    state: readonly(state),
    count: computed(() => state.entries.length),
  };
}

function describeError() {
  return "无法读写识别历史";
}

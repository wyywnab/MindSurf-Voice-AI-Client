import { reactive, readonly } from "vue";
import type { VoiceUser } from "../types/httpApi";

const state = reactive({ user: null as VoiceUser | null });

export const accountStoreActions = {
  setUser(user: VoiceUser | null) {
    state.user = user;
  },
};

export function useAccountStore() {
  return { state: readonly(state) };
}

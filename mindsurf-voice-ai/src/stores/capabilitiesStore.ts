import { reactive, readonly } from "vue";
import type { Capabilities, VoiceModeV2 } from "../types/httpApi";

const state = reactive({
  capabilities: null as Capabilities | null,
  loading: false,
  error: "",
  selectedMode: "asr_only" as VoiceModeV2,
  selectedPipeline: "",
  selectedAsr: "",
  selectedLlm: null as string | null,
  language: "",
  selectionConfirmationRequired: false,
});

function applyDefaultSelection(capabilities: Capabilities, mode: VoiceModeV2) {
  const supportedMode = capabilities.modes.includes(mode)
    ? mode
    : capabilities.modes[0]!;
  const defaults = capabilities.defaults[supportedMode];
  state.selectedMode = supportedMode;
  state.selectedPipeline = defaults.pipeline;
  state.selectedAsr = defaults.selection.asr;
  state.selectedLlm = defaults.selection.llm;
  state.language = capabilities.recognition_languages[0]!;
}

export const capabilitiesStoreActions = {
  setLoading() {
    state.loading = true;
    state.error = "";
  },
  setCapabilities(capabilities: Capabilities | null) {
    const confirmationRequired = state.selectionConfirmationRequired;
    state.capabilities = capabilities;
    state.loading = false;
    state.error = "";
    if (capabilities) {
      applyDefaultSelection(capabilities, state.selectedMode);
      if (confirmationRequired) {
        state.selectionConfirmationRequired = true;
        state.error = "服务能力已更新，请确认请求模式后重试";
      }
    } else {
      state.selectedPipeline = "";
      state.selectedAsr = "";
      state.selectedLlm = null;
      state.language = "";
      state.selectionConfirmationRequired = false;
    }
  },
  selectMode(mode: VoiceModeV2) {
    if (!state.capabilities?.modes.includes(mode)) return false;
    applyDefaultSelection(state.capabilities, mode);
    state.selectionConfirmationRequired = false;
    state.error = "";
    return true;
  },
  selectPipeline(id: string) {
    const pipeline = state.capabilities?.pipelines.find(
      (item) => item.id === id && item.modes.includes(state.selectedMode),
    );
    if (!pipeline) return false;
    state.selectedPipeline = id;
    if (!pipeline.asr_options.includes(state.selectedAsr)) {
      state.selectedAsr = pipeline.asr_options[0]!;
    }
    state.selectedLlm =
      state.selectedMode === "asr_llm"
        ? pipeline.llm_options.includes(state.selectedLlm ?? "")
          ? state.selectedLlm
          : pipeline.llm_options[0]!
        : null;
    return true;
  },
  selectAsr(id: string) {
    const pipeline = state.capabilities?.pipelines.find(
      (item) => item.id === state.selectedPipeline,
    );
    if (!pipeline?.asr_options.includes(id)) return false;
    state.selectedAsr = id;
    return true;
  },
  selectLlm(id: string) {
    const pipeline = state.capabilities?.pipelines.find(
      (item) => item.id === state.selectedPipeline,
    );
    if (state.selectedMode !== "asr_llm" || !pipeline?.llm_options.includes(id)) {
      return false;
    }
    state.selectedLlm = id;
    return true;
  },
  selectLanguage(language: string) {
    if (!state.capabilities?.recognition_languages.includes(language)) return false;
    state.language = language;
    return true;
  },
  requireSelectionConfirmation(error: string) {
    state.capabilities = null;
    state.loading = false;
    state.error = error;
    state.selectionConfirmationRequired = true;
  },
  requireCurrentSelectionConfirmation(error: string) {
    state.error = error;
    state.selectionConfirmationRequired = true;
  },
  invalidate(error: string) {
    state.capabilities = null;
    state.loading = false;
    state.error = error;
    state.selectionConfirmationRequired = false;
  },
};

export function useCapabilitiesStore() {
  return { state: readonly(state) };
}

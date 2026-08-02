import { hideOverlayWindow, setOverlayWindowPosition } from "../services/overlay";
import { clearServiceToken, saveServiceToken } from "../services/settings/credentials";
import { validateServiceUrl } from "../services/settings/serviceUrl";
import {
  getRecordShortcutStatus,
  registerRecordShortcut,
  unregisterRecordShortcut,
} from "../services/shortcuts";
import { testVoiceServiceConnection } from "../services/transport/testConnection";
import type { VoiceClientIdentity } from "../services/transport/voiceTransport";
import { syncTrayMode } from "../services/tray";
import { listAudioInputDevices } from "../services/audioInputDevices";
import { isTerminalRequestState } from "./requestStateMachine";
import { useConnectionStore } from "../stores/connectionStore";
import { useRequestStore } from "../stores/requestStore";
import {
  settingsStoreActions,
  type InferenceOptionKind,
  useSettingsStore,
} from "../stores/settingsStore";
import type { ShortcutBinding } from "../types/shortcut";
import type { OverlayPosition, VoiceInteractionMode } from "../types/voice";
import { voiceRequestController } from "./voiceRequestController";

export class SettingsController {
  private readonly connection = useConnectionStore();
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();

  initialize() {
    return settingsStoreActions.initialize();
  }

  async saveServiceSettings(input: {
    url: string;
    autoConnect: boolean;
    token?: string;
  }) {
    if (this.request.state.activeRequestId) {
      throw new Error("请求进行中不能修改服务配置");
    }
    const url = validateServiceUrl(input.url);
    const connectionChanged =
      url !== this.settings.state.serviceUrl ||
      input.autoConnect !== this.settings.state.autoConnect;
    let tokenChanged = false;
    if (input.token?.trim()) {
      settingsStoreActions.setTokenConfigured(
        await saveServiceToken(input.token.trim()),
      );
      tokenChanged = true;
    }
    settingsStoreActions.setService(url, input.autoConnect);
    if (connectionChanged || tokenChanged) {
      voiceRequestController.reconnectWithCurrentSettings();
    }
  }

  async clearToken() {
    settingsStoreActions.setTokenConfigured(await clearServiceToken());
    voiceRequestController.reconnectWithCurrentSettings();
  }

  async testConnection(url: string, identity: VoiceClientIdentity) {
    const validatedUrl = validateServiceUrl(url);
    settingsStoreActions.setConnectionTest("testing");
    try {
      const result = await testVoiceServiceConnection(validatedUrl, identity);
      settingsStoreActions.setConnectionTest("succeeded", result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接测试失败";
      settingsStoreActions.setConnectionTest("failed", null, message);
      throw error;
    }
  }

  async refreshAudioInputDevices() {
    settingsStoreActions.setAudioDevicesLoading();
    try {
      settingsStoreActions.setAudioDevices(await listAudioInputDevices());
    } catch (error) {
      settingsStoreActions.setAudioDevices(
        [],
        error instanceof Error ? error.message : "无法读取麦克风设备",
      );
    }
  }

  setInputDevice(id: string | null) {
    if (this.request.state.status === "recording") return false;
    settingsStoreActions.setInputDeviceId(id);
    return true;
  }

  setLanguage(language: string) {
    settingsStoreActions.setLanguage(language);
  }

  setAudioResponseEnabled(enabled: boolean) {
    settingsStoreActions.setAudioResponseEnabled(enabled);
  }

  setVoice(voice: string) {
    settingsStoreActions.setVoice(voice);
  }

  setPlaybackVolume(volume: number) {
    settingsStoreActions.setPlaybackVolume(volume);
    voiceRequestController.setPlaybackVolume(volume);
  }

  setInferenceOption(kind: InferenceOptionKind, id: string) {
    const hello = this.connection.state.serverHello;
    if (!hello || !hello.inference_options[kind].some((option) => option.id === id)) {
      return;
    }
    settingsStoreActions.setInferenceOption(kind, id);
  }

  setMode(mode: VoiceInteractionMode) {
    if (!(["dictation", "assistant", "mixed"] as const).includes(mode)) return false;
    if (
      this.request.state.activeRequestId ||
      (this.request.state.status !== "idle" &&
        !isTerminalRequestState(this.request.state.status))
    ) {
      return false;
    }
    settingsStoreActions.setMode(mode);
    void syncTrayMode(mode);
    return true;
  }

  setAutoInjection(mode: VoiceInteractionMode, enabled: boolean) {
    settingsStoreActions.setAutoInjection(mode, enabled);
  }

  setInjectionMaxCodePoints(value: number) {
    const normalized = Math.trunc(value);
    if (!Number.isFinite(normalized) || normalized < 1 || normalized > 8_000) return;
    settingsStoreActions.setInjectionMaxCodePoints(normalized);
  }

  setOverlayPosition(position: OverlayPosition) {
    if (!(["left", "center", "right"] as const).includes(position)) return;
    settingsStoreActions.setOverlayPosition(position);
    void setOverlayWindowPosition(position);
  }

  setOverlayEnabled(enabled: boolean) {
    settingsStoreActions.setOverlayEnabled(enabled);
    if (!enabled) void hideOverlayWindow();
  }

  async initializeRecordShortcut() {
    if (!this.settings.state.shortcutDesiredEnabled) {
      const result = await unregisterRecordShortcut();
      if (result.ok) settingsStoreActions.applyShortcutStatus(result.data);
      else
        settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
      return;
    }
    const result = await registerRecordShortcut(this.settings.state.shortcutBinding);
    if (result.ok) {
      settingsStoreActions.applyShortcutStatus(result.data);
      setTimeout(() => void this.refreshShortcutStatus(), 250);
      return;
    }
    const message = describeShortcutError(result.error.code);
    const disabled = await unregisterRecordShortcut();
    if (disabled.ok) settingsStoreActions.applyShortcutStatus(disabled.data);
    settingsStoreActions.setShortcutError(message);
  }

  async configureRecordShortcut(binding: ShortcutBinding) {
    settingsStoreActions.setShortcutError("");
    if (!this.settings.state.shortcutDesiredEnabled) {
      settingsStoreActions.setShortcutBinding(binding);
      return true;
    }
    const result = await registerRecordShortcut(binding);
    if (!result.ok) {
      settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
      return false;
    }
    settingsStoreActions.applyShortcutStatus(result.data);
    settingsStoreActions.setShortcutBinding(binding);
    return true;
  }

  async setRecordShortcutEnabled(enabled: boolean) {
    settingsStoreActions.setShortcutError("");
    settingsStoreActions.setShortcutDesiredEnabled(enabled);
    const result = enabled
      ? await registerRecordShortcut(this.settings.state.shortcutBinding)
      : await unregisterRecordShortcut();
    if (result.ok) settingsStoreActions.applyShortcutStatus(result.data);
    else
      settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
  }

  private async refreshShortcutStatus() {
    const result = await getRecordShortcutStatus();
    if (result.ok) settingsStoreActions.applyShortcutStatus(result.data);
    else
      settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
  }
}

function describeShortcutError(code: string) {
  const messages: Record<string, string> = {
    accessibility_required: "请先在系统设置中授予辅助功能权限",
    shortcut_conflict: "该快捷键已被系统或其他程序占用，请选择其他组合",
    shortcut_listener_unavailable: "系统全局快捷键监听器不可用",
    shortcut_state_unavailable: "快捷键状态暂时不可用，请重试",
    unsupported_platform: "当前平台不支持全局快捷键",
  };
  return messages[code] ?? "快捷键配置失败，请选择其他组合";
}

export const settingsController = new SettingsController();

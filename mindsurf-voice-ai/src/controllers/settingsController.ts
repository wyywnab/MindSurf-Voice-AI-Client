import { hideOverlayWindow, setOverlayWindowPosition } from "../services/overlay";
import {
  clearServiceToken,
  getCredentialStatus,
  saveServiceToken,
} from "../services/settings/credentials";
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
import {
  ShortcutBindingError,
  validateShortcutBinding,
} from "../services/shortcutBinding";
import { isTerminalRequestState } from "./requestStateMachine";
import { useConnectionStore } from "../stores/connectionStore";
import { useRequestStore } from "../stores/requestStore";
import {
  settingsStoreActions,
  type InferenceOptionKind,
  useSettingsStore,
} from "../stores/settingsStore";
import type { ShortcutBinding } from "../types/shortcut";
import type { AppSettings, ServiceProfile } from "../types/settings";
import type { OverlayPosition, VoiceInteractionMode } from "../types/voice";
import { voiceRequestController } from "./voiceRequestController";

export class SettingsController {
  private shortcutCapture: {
    binding: ShortcutBinding;
    enabled: boolean;
  } | null = null;
  private readonly connection = useConnectionStore();
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();

  initialize() {
    return settingsStoreActions.initialize();
  }

  async saveServiceSettings(input: {
    name: string;
    url: string;
    autoConnect: boolean;
    authMode: ServiceProfile["authMode"];
    preferredPipeline: ServiceProfile["preferredPipeline"];
    token?: string;
  }) {
    if (this.request.state.activeRequestId) {
      throw new Error("请求进行中不能修改服务配置");
    }
    const name = input.name.trim();
    if (!name) throw new Error("服务档案名称不能为空");
    const url = validateServiceUrl(input.url);
    const currentProfile = this.settings.state.serviceProfiles.find(
      (profile) => profile.id === this.settings.state.activeServiceProfileId,
    );
    const connectionChanged =
      url !== this.settings.state.serviceUrl ||
      input.autoConnect !== this.settings.state.autoConnect ||
      input.authMode !== currentProfile?.authMode ||
      input.preferredPipeline !== currentProfile?.preferredPipeline;
    let tokenChanged = false;
    if (input.token?.trim()) {
      settingsStoreActions.setTokenConfigured(
        await saveServiceToken(
          this.settings.state.activeServiceProfileId,
          input.token.trim(),
        ),
      );
      tokenChanged = true;
    }
    settingsStoreActions.setService({ ...input, name, url });
    if (connectionChanged || tokenChanged) {
      voiceRequestController.reconnectWithCurrentSettings();
    }
  }

  async clearToken() {
    settingsStoreActions.setTokenConfigured(
      await clearServiceToken(this.settings.state.activeServiceProfileId),
    );
    voiceRequestController.reconnectWithCurrentSettings();
  }

  async createServiceProfile(copyCurrent = false) {
    if (this.request.state.activeRequestId) {
      throw new Error("请求进行中不能切换服务配置");
    }
    const now = Date.now();
    const id = globalThis.crypto.randomUUID();
    const profile: ServiceProfile = {
      id,
      name: copyCurrent ? "当前配置副本" : "新服务",
      websocketUrl: copyCurrent
        ? this.settings.state.serviceUrl
        : "wss://example.com/v1/voice/ws",
      autoConnect: false,
      authMode: copyCurrent ? "bearer" : "none",
      preferredPipeline: "auto",
      createdAt: now,
      updatedAt: now,
    };
    if (copyCurrent) {
      settingsStoreActions.duplicateServiceProfile(
        this.settings.state.activeServiceProfileId,
        profile,
      );
    } else {
      settingsStoreActions.addServiceProfile(profile);
    }
    settingsStoreActions.setTokenConfigured(false);
    voiceRequestController.reconnectWithCurrentSettings();
    return id;
  }

  async selectServiceProfile(profileId: string) {
    if (this.request.state.activeRequestId) {
      throw new Error("请求进行中不能切换服务配置");
    }
    if (!settingsStoreActions.selectServiceProfile(profileId)) return false;
    settingsStoreActions.setTokenConfigured(await getCredentialStatus(profileId));
    voiceRequestController.reconnectWithCurrentSettings();
    return true;
  }

  async deleteServiceProfile(profileId: string) {
    if (this.request.state.activeRequestId) {
      throw new Error("请求进行中不能删除服务配置");
    }
    if (!settingsStoreActions.removeServiceProfile(profileId)) {
      throw new Error("至少保留一个服务配置");
    }
    await clearServiceToken(profileId);
    settingsStoreActions.setTokenConfigured(
      await getCredentialStatus(this.settings.state.activeServiceProfileId),
    );
    voiceRequestController.reconnectWithCurrentSettings();
  }

  async testConnection(
    url: string,
    identity: VoiceClientIdentity,
    authMode: ServiceProfile["authMode"],
    preferredPipeline: ServiceProfile["preferredPipeline"],
  ) {
    const validatedUrl = validateServiceUrl(url);
    settingsStoreActions.setConnectionTest("testing");
    try {
      const result = await testVoiceServiceConnection(
        validatedUrl,
        identity,
        this.settings.state.activeServiceProfileId,
        authMode === "bearer",
        preferredPipeline,
      );
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

  setDeveloperMode(enabled: boolean) {
    settingsStoreActions.setDeveloperMode(enabled);
  }

  setDeveloperUseWebViewContextMenu(enabled: boolean) {
    settingsStoreActions.setDeveloperUseWebViewContextMenu(enabled);
  }

  setDeveloperShowDiagnosticsPage(enabled: boolean) {
    settingsStoreActions.setDeveloperShowDiagnosticsPage(enabled);
  }

  setInterfaceLocale(locale: AppSettings["interface"]["locale"]) {
    settingsStoreActions.setInterfaceLocale(locale);
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

  async beginRecordShortcutCapture() {
    if (this.request.state.activeRequestId) {
      throw new ShortcutBindingError(
        "shortcut_request_active",
        "请求进行中不能录制快捷键",
      );
    }
    if (this.shortcutCapture) {
      throw new ShortcutBindingError("shortcut_capture_active", "快捷键录制已经开始");
    }
    settingsStoreActions.setShortcutError("");
    const capture = {
      binding: this.settings.state.shortcutBinding,
      enabled: this.settings.state.shortcutDesiredEnabled,
    };
    const paused = await unregisterRecordShortcut();
    if (!paused.ok) {
      throw new ShortcutBindingError(
        paused.error.code,
        describeShortcutError(paused.error.code),
      );
    }
    settingsStoreActions.applyShortcutStatus(paused.data);
    this.shortcutCapture = capture;
    return capture;
  }

  async commitRecordedShortcut(binding: ShortcutBinding, platform: string) {
    const capture = this.shortcutCapture;
    if (!capture) {
      throw new ShortcutBindingError(
        "shortcut_capture_not_started",
        "请先开始录制快捷键",
      );
    }
    this.shortcutCapture = null;
    try {
      if (binding === capture.binding) {
        throw new ShortcutBindingError(
          "shortcut_duplicate_binding",
          "新快捷键与当前绑定相同",
        );
      }
      validateShortcutBinding(
        binding,
        platform,
        { 取消当前请求: "Escape" },
        "按住说话",
      );
      const result = await registerRecordShortcut(binding);
      if (!result.ok) {
        throw new ShortcutBindingError(
          result.error.code,
          describeShortcutError(result.error.code),
        );
      }
      if (!capture.enabled) {
        const disabled = await unregisterRecordShortcut();
        if (!disabled.ok) {
          throw new ShortcutBindingError(
            disabled.error.code,
            describeShortcutError(disabled.error.code),
          );
        }
        settingsStoreActions.applyShortcutStatus(disabled.data);
      } else {
        settingsStoreActions.applyShortcutStatus(result.data);
      }
      settingsStoreActions.setShortcutBinding(binding);
      return result.data.display;
    } catch (error) {
      const restored = await this.restoreShortcutCapture(capture);
      const message = restored
        ? error instanceof Error
          ? error.message
          : "快捷键配置失败"
        : describeShortcutError("shortcut_restore_failed");
      settingsStoreActions.setShortcutError(message);
      if (!restored) {
        throw new ShortcutBindingError("shortcut_restore_failed", message);
      }
      throw error;
    }
  }

  async cancelRecordShortcutCapture() {
    const capture = this.shortcutCapture;
    if (!capture) return;
    this.shortcutCapture = null;
    await this.restoreShortcutCapture(capture);
  }

  private async restoreShortcutCapture(capture: {
    binding: ShortcutBinding;
    enabled: boolean;
  }) {
    const result = capture.enabled
      ? await registerRecordShortcut(capture.binding)
      : await unregisterRecordShortcut();
    if (!result.ok) {
      settingsStoreActions.setShortcutError(
        describeShortcutError("shortcut_restore_failed"),
      );
      return false;
    }
    settingsStoreActions.applyShortcutStatus(result.data);
    return true;
  }

  async setRecordShortcutEnabled(enabled: boolean) {
    settingsStoreActions.setShortcutError("");
    const previous = this.settings.state.shortcutDesiredEnabled;
    const result = enabled
      ? await registerRecordShortcut(this.settings.state.shortcutBinding)
      : await unregisterRecordShortcut();
    if (result.ok) {
      settingsStoreActions.setShortcutDesiredEnabled(enabled);
      settingsStoreActions.applyShortcutStatus(result.data);
    } else {
      settingsStoreActions.setShortcutDesiredEnabled(previous);
      settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
    }
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
    shortcut_duplicate_binding: "新快捷键与当前绑定相同",
    shortcut_internal_conflict: "该组合已绑定到其他应用动作",
    shortcut_invalid: "快捷键格式无效",
    shortcut_key_unsupported: "该按键暂不支持全局绑定",
    shortcut_modifier_required: "快捷键必须包含至少一个修饰键",
    shortcut_modifier_only_invalid: "仅修饰键组合至少需要两个修饰键",
    shortcut_modifier_only_unsupported: "当前平台不支持仅修饰键的全局组合",
    shortcut_system_reserved: "该组合由系统保留，请选择其他组合",
    shortcut_restore_failed: "快捷键注册失败，且旧配置未能恢复，请重新启用",
    shortcut_listener_unavailable: "系统全局快捷键监听器不可用",
    shortcut_state_unavailable: "快捷键状态暂时不可用，请重试",
    unsupported_platform: "当前平台不支持全局快捷键",
  };
  return messages[code] ?? "快捷键配置失败，请选择其他组合";
}

export const settingsController = new SettingsController();

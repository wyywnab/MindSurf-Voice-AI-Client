import { hideOverlayWindow, setOverlayWindowPosition } from "../services/overlay";
import {
  isAutostartEnabled,
  setAutostartEnabled as setSystemAutostartEnabled,
} from "../services/autostart";
import { listAudioInputDevices } from "../services/audioInputDevices";
import {
  ShortcutBindingError,
  validateShortcutBinding,
} from "../services/shortcutBinding";
import {
  getRecordShortcutStatus,
  registerRecordShortcut,
  unregisterRecordShortcut,
} from "../services/shortcuts";
import {
  capabilitiesStoreActions,
  useCapabilitiesStore,
} from "../stores/capabilitiesStore";
import { useRequestStore } from "../stores/requestStore";
import { settingsStoreActions, useSettingsStore } from "../stores/settingsStore";
import type { VoiceModeV2 } from "../types/httpApi";
import type { ShortcutBinding } from "../types/shortcut";
import type { AppSettings } from "../types/settings";
import type { OverlayPosition } from "../types/voice";
import { isTerminalRequestState } from "./requestStateMachine";
import { syncTrayMode } from "../services/tray";

export class SettingsController {
  private shortcutCapture: { binding: ShortcutBinding; enabled: boolean } | null = null;
  private readonly capabilities = useCapabilitiesStore();
  private readonly request = useRequestStore();
  private readonly settings = useSettingsStore();

  initialize() {
    return settingsStoreActions.initialize();
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

  setMode(mode: VoiceModeV2) {
    if (!this.capabilities.state.capabilities?.modes.includes(mode)) return false;
    if (
      this.request.state.activeRequestId ||
      (this.request.state.status !== "idle" &&
        !isTerminalRequestState(this.request.state.status))
    ) {
      return false;
    }
    if (!capabilitiesStoreActions.selectMode(mode)) return false;
    settingsStoreActions.setMode(mode);
    void syncTrayMode(mode);
    return true;
  }

  setAutoInjection(mode: VoiceModeV2, enabled: boolean) {
    settingsStoreActions.setAutoInjection(mode, enabled);
  }

  setInjectionMaxCodePoints(value: number) {
    const normalized = Math.trunc(value);
    if (Number.isFinite(normalized) && normalized >= 1 && normalized <= 8_000) {
      settingsStoreActions.setInjectionMaxCodePoints(normalized);
    }
  }

  async setOverlayPosition(position: OverlayPosition) {
    settingsStoreActions.setOverlayPosition(position);
    return setOverlayWindowPosition(position);
  }

  async setOverlayEnabled(enabled: boolean) {
    settingsStoreActions.setOverlayEnabled(enabled);
    return enabled ? true : hideOverlayWindow();
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

  setInterfaceTheme(theme: AppSettings["interface"]["theme"]) {
    settingsStoreActions.setInterfaceTheme(theme);
  }

  async refreshAutostart() {
    settingsStoreActions.setAutostartLoading();
    try {
      settingsStoreActions.setAutostartState(await isAutostartEnabled());
    } catch (error) {
      settingsStoreActions.setAutostartUnavailable(describeAutostartError(error));
    }
  }

  async setAutostartEnabled(enabled: boolean) {
    settingsStoreActions.setAutostartSaving();
    try {
      await setSystemAutostartEnabled(enabled);
      const registered = await isAutostartEnabled();
      settingsStoreActions.setAutostartState(registered);
      if (registered !== enabled) {
        settingsStoreActions.setAutostartUnavailable("系统未能保存自动启动设置");
        return false;
      }
      return true;
    } catch (error) {
      settingsStoreActions.setAutostartUnavailable(describeAutostartError(error));
      return false;
    }
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
    const disabled = await unregisterRecordShortcut();
    if (disabled.ok) settingsStoreActions.applyShortcutStatus(disabled.data);
    settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
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
    const capture = {
      binding: this.settings.state.shortcutBinding,
      enabled: this.settings.state.shortcutDesiredEnabled,
    };
    const paused = await unregisterRecordShortcut();
    if (!paused.ok)
      throw new ShortcutBindingError(paused.error.code, paused.error.message);
    settingsStoreActions.applyShortcutStatus(paused.data);
    this.shortcutCapture = capture;
    return capture;
  }

  async commitRecordedShortcut(binding: ShortcutBinding, platform: string) {
    const capture = this.shortcutCapture;
    if (!capture)
      throw new ShortcutBindingError(
        "shortcut_capture_not_started",
        "请先开始录制快捷键",
      );
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
      if (!result.ok)
        throw new ShortcutBindingError(result.error.code, result.error.message);
      if (!capture.enabled) {
        const disabled = await unregisterRecordShortcut();
        if (!disabled.ok)
          throw new ShortcutBindingError(disabled.error.code, disabled.error.message);
        settingsStoreActions.applyShortcutStatus(disabled.data);
      } else settingsStoreActions.applyShortcutStatus(result.data);
      settingsStoreActions.setShortcutBinding(binding);
      return result.data.display;
    } catch (error) {
      await this.restoreShortcutCapture(capture);
      throw error;
    }
  }

  async cancelRecordShortcutCapture() {
    const capture = this.shortcutCapture;
    if (!capture) return;
    this.shortcutCapture = null;
    await this.restoreShortcutCapture(capture);
  }

  async setRecordShortcutEnabled(enabled: boolean) {
    const previous = this.settings.state.shortcutDesiredEnabled;
    const result = enabled
      ? await registerRecordShortcut(this.settings.state.shortcutBinding)
      : await unregisterRecordShortcut();
    if (result.ok) {
      settingsStoreActions.setShortcutDesiredEnabled(enabled);
      settingsStoreActions.applyShortcutStatus(result.data);
      return true;
    } else {
      settingsStoreActions.setShortcutDesiredEnabled(previous);
      settingsStoreActions.setShortcutError(describeShortcutError(result.error.code));
      return false;
    }
  }

  private async restoreShortcutCapture(capture: {
    binding: ShortcutBinding;
    enabled: boolean;
  }) {
    const result = capture.enabled
      ? await registerRecordShortcut(capture.binding)
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
    shortcut_duplicate_binding: "新快捷键与当前绑定相同",
    shortcut_invalid: "快捷键格式无效",
    shortcut_modifier_required: "快捷键必须包含至少一个修饰键",
    shortcut_modifier_only_unsupported: "当前平台不支持仅修饰键的全局组合",
    shortcut_system_reserved: "该组合由系统保留，请选择其他组合",
  };
  return messages[code] ?? "快捷键配置失败";
}

function describeAutostartError(error: unknown) {
  const detail = error instanceof Error ? error.message : String(error || "");
  return detail ? `无法访问系统自动启动设置：${detail}` : "无法访问系统自动启动设置";
}

export const settingsController = new SettingsController();

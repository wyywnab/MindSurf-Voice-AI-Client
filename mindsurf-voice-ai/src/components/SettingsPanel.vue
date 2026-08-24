<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { settingsController } from "../controllers/settingsController";
import { authController } from "../controllers/authController";
import { subscribeAudioDeviceChanges } from "../services/audioInputDevices";
import { validateApiOrigin } from "../services/http/apiOrigin";
import { useI18n } from "../services/i18n";
import { runMicrophoneTest } from "../services/microphoneTest";
import { formatShortcutBinding } from "../services/shortcutBinding";
import { recordShortcutBinding } from "../services/shortcutRecorder";
import { clearLocalApplicationData } from "../services/settings/privacy";
import { showConfirm } from "../services/systemDialog";
import { toast } from "../services/toast";
import {
  capabilitiesStoreActions,
  useCapabilitiesStore,
} from "../stores/capabilitiesStore";
import { useRequestStore } from "../stores/requestStore";
import { useAccountStore } from "../stores/accountStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { AppInfo } from "../types/app";
import type { VoiceModeV2 } from "../types/httpApi";
import type { InterfaceTheme } from "../types/settings";
import { VOICE_MODE_LABELS, type OverlayPosition } from "../types/voice";

const props = defineProps<{ appInfo: AppInfo | null; appInfoError: string }>();
const emit = defineEmits<{ openPermissions: []; openPolishPrompt: [] }>();
const { t } = useI18n();
const capabilities = useCapabilitiesStore().state;
const account = useAccountStore().state;
const request = useRequestStore().state;
const settings = useSettingsStore().state;
const shortcutStatus = ref<"idle" | "recording" | "saving">("idle");
const shortcutPreview = ref("");
const microphoneStatus = ref<"idle" | "testing" | "succeeded" | "failed">("idle");
const microphoneLevel = ref(0);
const microphoneError = ref("");
const clearError = ref("");
const apiOrigin = ref(settings.voiceApiOrigin);
const apiOriginSaving = ref(false);
let captureAbort: InstanceType<typeof globalThis.AbortController> | null = null;
let unsubscribeDevices: (() => void) | null = null;

const pipelines = computed(
  () =>
    capabilities.capabilities?.pipelines.filter((item) =>
      item.modes.includes(capabilities.selectedMode),
    ) ?? [],
);
const selectedPipeline = computed(() =>
  pipelines.value.find((item) => item.id === capabilities.selectedPipeline),
);
const asrOptions = computed(
  () =>
    capabilities.capabilities?.asr_options.filter((item) =>
      selectedPipeline.value?.asr_options.includes(item.id),
    ) ?? [],
);
const llmOptions = computed(
  () =>
    capabilities.capabilities?.llm_options.filter((item) =>
      selectedPipeline.value?.llm_options.includes(item.id),
    ) ?? [],
);

function checked(event: Event) {
  return (event.target as unknown as { checked: boolean }).checked;
}

async function captureShortcut() {
  shortcutStatus.value = "recording";
  shortcutPreview.value = t("请按下组合键，按 Escape 取消");
  captureAbort = new globalThis.AbortController();
  try {
    await settingsController.beginRecordShortcutCapture();
    const binding = await recordShortcutBinding({
      signal: captureAbort.signal,
      onPreview: (value) => {
        shortcutPreview.value = formatShortcutBinding(
          value,
          props.appInfo?.platform ?? "unknown",
        );
      },
    });
    if (!binding) {
      await settingsController.cancelRecordShortcutCapture();
      return;
    }
    shortcutStatus.value = "saving";
    shortcutPreview.value = await settingsController.commitRecordedShortcut(
      binding,
      props.appInfo?.platform ?? "unknown",
    );
    toast.success(`全局快捷键已设置为 ${shortcutPreview.value}`, {
      title: "快捷键设置成功",
    });
  } catch (error) {
    shortcutPreview.value =
      error instanceof Error ? error.message : t("快捷键配置失败");
    toast.error(shortcutPreview.value, { title: "快捷键设置失败", durationMs: 0 });
  } finally {
    captureAbort = null;
    shortcutStatus.value = "idle";
  }
}

async function testMicrophone() {
  microphoneStatus.value = "testing";
  microphoneError.value = "";
  try {
    await runMicrophoneTest(settings.inputDeviceId, (level) => {
      microphoneLevel.value = level;
    });
    microphoneStatus.value = "succeeded";
    toast.success("麦克风输入和音量检测正常", { title: "麦克风测试通过" });
  } catch (error) {
    microphoneStatus.value = "failed";
    microphoneError.value =
      error instanceof Error ? error.message : t("麦克风测试失败");
    toast.error(microphoneError.value, { title: "麦克风测试失败", durationMs: 0 });
  } finally {
    microphoneLevel.value = 0;
  }
}

async function clearLocalData() {
  if (
    !(await showConfirm(t("确认清除本地设置、日志和登录凭据？"), {
      title: t("清除本地数据"),
      kind: "warning",
      confirmLabel: t("清除"),
    }))
  )
    return;
  try {
    await clearLocalApplicationData();
    clearError.value = "";
    toast.success("本地设置、日志、识别历史和登录凭据已清除", {
      title: "本地数据已清除",
    });
  } catch (error) {
    clearError.value = error instanceof Error ? error.message : t("清除本地数据失败");
    toast.error(clearError.value, { title: "清除本地数据失败", durationMs: 0 });
  }
}

async function setShortcutEnabled(enabled: boolean) {
  const succeeded = await settingsController.setRecordShortcutEnabled(enabled);
  if (succeeded) {
    toast.success(enabled ? "全局快捷键已启用" : "全局快捷键已关闭");
  } else {
    toast.error(settings.shortcutError || t("快捷键配置失败"), {
      title: enabled ? "无法启用全局快捷键" : "无法关闭全局快捷键",
      durationMs: 0,
    });
  }
}

async function setAutostartEnabled(enabled: boolean) {
  const succeeded = await settingsController.setAutostartEnabled(enabled);
  if (succeeded) {
    toast.success(enabled ? "登录时自动启动已启用" : "登录时自动启动已关闭");
  } else {
    toast.error(settings.autostartError || t("自动启动设置失败"), {
      title: t("自动启动设置失败"),
      durationMs: 0,
    });
  }
}

async function setOverlayEnabled(enabled: boolean) {
  const succeeded = await settingsController.setOverlayEnabled(enabled);
  if (succeeded) {
    toast.success(enabled ? "悬浮窗已启用" : "悬浮窗已关闭");
  } else {
    toast.error(enabled ? "无法启用悬浮窗" : "无法关闭悬浮窗", {
      durationMs: 0,
    });
  }
}

async function setOverlayPosition(position: OverlayPosition) {
  const succeeded = await settingsController.setOverlayPosition(position);
  if (succeeded) toast.success("悬浮窗位置已更新");
  else toast.error("无法更新悬浮窗位置", { durationMs: 0 });
}

async function saveApiOrigin() {
  apiOriginSaving.value = true;
  try {
    const validated = validateApiOrigin(apiOrigin.value);
    await authController.changeApiOrigin(validated);
    apiOrigin.value = validated;
    toast.success(`服务地址已保存：${validated}`, { title: "保存成功" });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "API 地址保存失败", {
      title: "服务地址保存失败",
      durationMs: 0,
    });
  } finally {
    apiOriginSaving.value = false;
  }
}

onMounted(() => {
  void settingsController.refreshAutostart();
  void settingsController.refreshAudioInputDevices();
  unsubscribeDevices = subscribeAudioDeviceChanges(() =>
    settingsController.refreshAudioInputDevices(),
  );
});

onBeforeUnmount(() => {
  captureAbort?.abort();
  unsubscribeDevices?.();
});
</script>

<template>
  <section class="panel settings-panel" aria-labelledby="settings-title">
    <header class="panel-heading">
      <div>
        <h1 id="settings-title">{{ t("设置") }}</h1>
        <p class="panel-description">
          {{ t("配置 Voice API v2 请求、录音、快捷键和界面。") }}
        </p>
      </div>
    </header>

    <div class="panel-body settings-grid">
      <article class="settings-card settings-card-connection">
        <h2>{{ t("服务连接") }}</h2>
        <label>
          <span>Voice API origin</span>
          <input v-model="apiOrigin" type="url" :disabled="apiOriginSaving" />
        </label>
        <p class="settings-hint">
          生产环境仅允许 HTTPS；HTTP 仅限本机开发服务。修改地址会退出当前登录。
        </p>
        <button
          class="button button-secondary"
          type="button"
          :disabled="apiOriginSaving"
          @click="saveApiOrigin"
        >
          {{ apiOriginSaving ? "正在保存…" : "保存服务地址" }}
        </button>
      </article>

      <article class="settings-card settings-card-request">
        <h2>{{ t("请求") }}</h2>
        <label>
          <span>{{ t("模式") }}</span>
          <select
            :value="capabilities.selectedMode"
            :disabled="Boolean(request.activeRequestId)"
            @change="
              settingsController.setMode(
                ($event.target as HTMLSelectElement).value as VoiceModeV2,
              )
            "
          >
            <option
              v-for="mode in capabilities.capabilities?.modes ?? []"
              :key="mode"
              :value="mode"
            >
              {{ t(VOICE_MODE_LABELS[mode]) }}
            </option>
          </select>
        </label>
        <label>
          <span>Pipeline</span>
          <select
            :value="capabilities.selectedPipeline"
            :disabled="Boolean(request.activeRequestId)"
            @change="
              capabilitiesStoreActions.selectPipeline(
                ($event.target as HTMLSelectElement).value,
              )
            "
          >
            <option v-for="item in pipelines" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select>
        </label>
        <label>
          <span>ASR</span>
          <select
            :value="capabilities.selectedAsr"
            @change="
              capabilitiesStoreActions.selectAsr(
                ($event.target as HTMLSelectElement).value,
              )
            "
          >
            <option v-for="item in asrOptions" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select>
        </label>
        <label v-if="capabilities.selectedMode === 'asr_llm'">
          <span>LLM</span>
          <select
            :value="capabilities.selectedLlm ?? ''"
            @change="
              capabilitiesStoreActions.selectLlm(
                ($event.target as HTMLSelectElement).value,
              )
            "
          >
            <option v-for="item in llmOptions" :key="item.id" :value="item.id">
              {{ item.name }}
            </option>
          </select>
        </label>
        <label>
          <span>{{ t("识别语言") }}</span>
          <select
            :value="capabilities.language"
            @change="
              capabilitiesStoreActions.selectLanguage(
                ($event.target as HTMLSelectElement).value,
              )
            "
          >
            <option
              v-for="language in capabilities.capabilities?.recognition_languages ?? []"
              :key="language"
              :value="language"
            >
              {{ language }}
            </option>
          </select>
        </label>
        <label
          v-for="(label, mode) in VOICE_MODE_LABELS"
          :key="mode"
          class="toggle-row"
        >
          <span>{{ t(label) }} · {{ t("完成后注入") }}</span>
          <input
            type="checkbox"
            :checked="settings.autoInjection[mode]"
            @change="settingsController.setAutoInjection(mode, checked($event))"
          />
        </label>
        <label>
          <span>{{ t("单次注入字符上限") }}</span>
          <input
            type="number"
            min="1"
            max="8000"
            :value="settings.injectionMaxCodePoints"
            @change="
              settingsController.setInjectionMaxCodePoints(
                Number(($event.target as HTMLInputElement).value),
              )
            "
          />
        </label>
      </article>

      <article class="settings-card settings-card-recording">
        <h2>{{ t("常规与快捷键") }}</h2>
        <label>
          <span>{{ t("输入设备") }}</span>
          <select
            :value="settings.inputDeviceId ?? ''"
            :disabled="request.status === 'recording' || settings.audioDevicesLoading"
            @change="
              settingsController.setInputDevice(
                ($event.target as HTMLSelectElement).value || null,
              )
            "
          >
            <option value="">{{ t("系统默认麦克风") }}</option>
            <option
              v-for="device in settings.audioInputDevices"
              :key="device.id"
              :value="device.id"
            >
              {{ device.label }}
            </option>
          </select>
        </label>
        <button
          class="button button-secondary"
          type="button"
          :disabled="microphoneStatus === 'testing'"
          @click="testMicrophone"
        >
          {{ microphoneStatus === "testing" ? t("测试中…") : t("测试麦克风") }}
        </button>
        <div class="audio-meter">
          <span :style="{ width: `${microphoneLevel * 100}%` }"></span>
        </div>
        <label class="toggle-row">
          <span>{{ t("启用全局快捷键") }}</span>
          <input
            type="checkbox"
            :checked="settings.shortcutDesiredEnabled"
            @change="setShortcutEnabled(checked($event))"
          />
        </label>
        <button class="button button-secondary" type="button" @click="captureShortcut">
          {{
            shortcutStatus === "recording" ? shortcutPreview : settings.shortcutDisplay
          }}
        </button>
        <label class="toggle-row">
          <span>{{ t("登录时自动启动") }}</span>
          <input
            type="checkbox"
            :checked="settings.autostartEnabled"
            :disabled="
              settings.autostartStatus === 'loading' ||
              settings.autostartStatus === 'saving'
            "
            @change="setAutostartEnabled(checked($event))"
          />
        </label>
        <p v-if="settings.autostartError" class="inline-error">
          {{ t(settings.autostartError) }}
        </p>
      </article>

      <article class="settings-card settings-card-permissions">
        <h2>{{ t("系统权限") }}</h2>
        <p class="settings-hint">
          {{ t("集中检查和配置录音、全局快捷键及文本注入所需权限。") }}
        </p>
        <button
          class="button button-secondary"
          type="button"
          @click="emit('openPermissions')"
        >
          {{ t("管理系统权限") }}
        </button>
      </article>

      <article class="settings-card settings-card-account">
        <h2>{{ t("账户配置") }}</h2>
        <p class="settings-hint">
          {{
            account.user
              ? "润色提示词保存在账户中，并在登录同一账户的所有设备间共享。"
              : "登录后可管理在所有设备间共享的润色提示词。"
          }}
        </p>
        <button
          class="button button-secondary"
          type="button"
          :disabled="!account.user"
          @click="emit('openPolishPrompt')"
        >
          管理润色提示词
        </button>
      </article>

      <article class="settings-card settings-card-interface">
        <h2>{{ t("界面") }}</h2>
        <label>
          <span>{{ t("界面语言") }}</span>
          <select
            :value="settings.interfaceLocale"
            @change="
              settingsController.setInterfaceLocale(
                ($event.target as HTMLSelectElement).value as 'zh-CN' | 'en-US',
              )
            "
          >
            <option value="zh-CN">简体中文</option>
            <option value="en-US">English</option>
          </select>
        </label>
        <label>
          <span>{{ t("界面主题") }}</span>
          <select
            :value="settings.interfaceTheme"
            @change="
              settingsController.setInterfaceTheme(
                ($event.target as HTMLSelectElement).value as InterfaceTheme,
              )
            "
          >
            <option value="system">{{ t("跟随系统") }}</option>
            <option value="light">{{ t("浅色") }}</option>
            <option value="dark">{{ t("深色") }}</option>
          </select>
        </label>
        <label class="toggle-row">
          <span>{{ t("启用悬浮窗") }}</span>
          <input
            type="checkbox"
            :checked="settings.overlayEnabled"
            @change="setOverlayEnabled(checked($event))"
          />
        </label>
        <label>
          <span>{{ t("悬浮窗位置") }}</span>
          <select
            :value="settings.overlayPosition"
            @change="
              setOverlayPosition(
                ($event.target as HTMLSelectElement).value as OverlayPosition,
              )
            "
          >
            <option value="left">{{ t("左侧") }}</option>
            <option value="center">{{ t("居中") }}</option>
            <option value="right">{{ t("右侧") }}</option>
          </select>
        </label>
      </article>

      <article class="settings-card settings-card-developer">
        <h2>{{ t("开发与隐私") }}</h2>
        <label class="toggle-row">
          <span>{{ t("开发者模式") }}</span>
          <input
            type="checkbox"
            :checked="settings.developerModeEnabled"
            @change="settingsController.setDeveloperMode(checked($event))"
          />
        </label>
        <label v-if="settings.developerModeEnabled" class="toggle-row">
          <span>{{ t("显示诊断页面") }}</span>
          <input
            type="checkbox"
            :checked="settings.developerShowDiagnosticsPage"
            @change="
              settingsController.setDeveloperShowDiagnosticsPage(checked($event))
            "
          />
        </label>
        <label v-if="settings.developerModeEnabled" class="toggle-row">
          <span>{{ t("启用 WebView 上下文菜单") }}</span>
          <input
            type="checkbox"
            :checked="settings.developerUseWebViewContextMenu"
            @change="
              settingsController.setDeveloperUseWebViewContextMenu(checked($event))
            "
          />
        </label>
        <button class="button button-danger" type="button" @click="clearLocalData">
          {{ t("清除本地数据") }}
        </button>
      </article>

      <p v-if="capabilities.error" class="inline-error">{{ t(capabilities.error) }}</p>
      <p v-if="settings.audioDevicesError" class="inline-error">
        {{ t(settings.audioDevicesError) }}
      </p>
      <p v-if="settings.shortcutError" class="inline-error">
        {{ t(settings.shortcutError) }}
      </p>
      <p v-if="microphoneError" class="inline-error">{{ t(microphoneError) }}</p>
      <p v-if="settings.saveError" class="inline-error">{{ t(settings.saveError) }}</p>
      <p v-if="clearError" class="inline-error">{{ t(clearError) }}</p>
      <p v-if="props.appInfoError" class="inline-error">{{ t(props.appInfoError) }}</p>
    </div>
  </section>
</template>

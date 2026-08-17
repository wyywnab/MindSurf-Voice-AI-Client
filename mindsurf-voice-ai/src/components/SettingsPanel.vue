<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

import { settingsController } from "../controllers/settingsController";
import { subscribeAudioDeviceChanges } from "../services/audioInputDevices";
import { useI18n } from "../services/i18n";
import { runMicrophoneTest } from "../services/microphoneTest";
import { formatShortcutBinding } from "../services/shortcutBinding";
import { recordShortcutBinding } from "../services/shortcutRecorder";
import { clearLocalApplicationData } from "../services/settings/privacy";
import { showConfirm } from "../services/systemDialog";
import {
  capabilitiesStoreActions,
  useCapabilitiesStore,
} from "../stores/capabilitiesStore";
import { useRequestStore } from "../stores/requestStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { AppInfo } from "../types/app";
import type { VoiceModeV2 } from "../types/httpApi";
import { VOICE_MODE_LABELS, type OverlayPosition } from "../types/voice";

const props = defineProps<{ appInfo: AppInfo | null; appInfoError: string }>();
const { t } = useI18n();
const capabilities = useCapabilitiesStore().state;
const request = useRequestStore().state;
const settings = useSettingsStore().state;
const shortcutStatus = ref<"idle" | "recording" | "saving">("idle");
const shortcutPreview = ref("");
const microphoneStatus = ref<"idle" | "testing" | "succeeded" | "failed">("idle");
const microphoneLevel = ref(0);
const microphoneError = ref("");
const clearError = ref("");
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
  } catch (error) {
    shortcutPreview.value =
      error instanceof Error ? error.message : t("快捷键配置失败");
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
  } catch (error) {
    microphoneStatus.value = "failed";
    microphoneError.value =
      error instanceof Error ? error.message : t("麦克风测试失败");
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
  } catch (error) {
    clearError.value = error instanceof Error ? error.message : t("清除本地数据失败");
  }
}

onMounted(() => {
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
      <article class="settings-card">
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

      <article class="settings-card">
        <h2>{{ t("录音与快捷键") }}</h2>
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
        <button class="button button-secondary" type="button" @click="testMicrophone">
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
            @change="settingsController.setRecordShortcutEnabled(checked($event))"
          />
        </label>
        <button class="button button-secondary" type="button" @click="captureShortcut">
          {{
            shortcutStatus === "recording" ? shortcutPreview : settings.shortcutDisplay
          }}
        </button>
      </article>

      <article class="settings-card">
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
        <label class="toggle-row">
          <span>{{ t("启用悬浮窗") }}</span>
          <input
            type="checkbox"
            :checked="settings.overlayEnabled"
            @change="settingsController.setOverlayEnabled(checked($event))"
          />
        </label>
        <label>
          <span>{{ t("悬浮窗位置") }}</span>
          <select
            :value="settings.overlayPosition"
            @change="
              settingsController.setOverlayPosition(
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

      <article class="settings-card">
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

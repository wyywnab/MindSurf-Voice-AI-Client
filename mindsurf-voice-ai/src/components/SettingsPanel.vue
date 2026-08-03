<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { settingsController } from "../controllers/settingsController";
import { useI18n } from "../services/i18n";
import { subscribeAudioDeviceChanges } from "../services/audioInputDevices";
import { runMicrophoneTest } from "../services/microphoneTest";
import { formatShortcutBinding } from "../services/shortcutBinding";
import { recordShortcutBinding } from "../services/shortcutRecorder";
import { clearLocalApplicationData } from "../services/settings/privacy";
import { showConfirm } from "../services/systemDialog";
import { useConnectionStore } from "../stores/connectionStore";
import { useRequestStore } from "../stores/requestStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { AppInfo } from "../types/app";
import type { ServiceProfile } from "../types/settings";
import {
  VOICE_MODE_LABELS,
  type OverlayPosition,
  type VoiceInteractionMode,
} from "../types/voice";

const props = defineProps<{
  appInfo: AppInfo | null;
  appInfoError: string;
}>();
const { t } = useI18n();

const connectionState = useConnectionStore().state;
const requestState = useRequestStore().state;
const settingsState = useSettingsStore().state;
const activeServiceProfile = computed(() =>
  settingsState.serviceProfiles.find(
    (profile) => profile.id === settingsState.activeServiceProfileId,
  ),
);
const serviceNameInput = ref(activeServiceProfile.value?.name ?? "");
const serviceUrlInput = ref(settingsState.serviceUrl);
const tokenInput = ref("");
const autoConnectInput = ref(settingsState.autoConnect);
const authModeInput = ref<ServiceProfile["authMode"]>(
  activeServiceProfile.value?.authMode ?? "none",
);
const preferredPipelineInput = ref<ServiceProfile["preferredPipeline"]>(
  activeServiceProfile.value?.preferredPipeline ?? "auto",
);
const serviceSaveError = ref("");
const serviceSaveStatus = ref("");
const microphoneTestStatus = ref<"idle" | "testing" | "succeeded" | "failed">("idle");
const microphoneTestLevel = ref(0);
const microphoneTestError = ref("");
const shortcutCaptureStatus = ref<"idle" | "recording" | "saving">("idle");
const shortcutCapturePreview = ref("");
const shortcutCaptureMessage = ref("");
const localDataClearStatus = ref<"idle" | "clearing" | "failed">("idle");
const localDataClearError = ref("");
let unsubscribeDeviceChanges: (() => void) | null = null;
let shortcutCaptureAbort: InstanceType<typeof globalThis.AbortController> | null = null;
const languageOptions = computed(
  () =>
    connectionState.serverHello?.recognition_languages ?? [
      { id: "auto", name: t("自动识别") },
    ],
);
const voiceOptions = computed(
  () => connectionState.serverHello?.voices ?? [{ id: "default", name: t("默认音色") }],
);
const recordingLimitSeconds = computed(() =>
  Math.round(
    Math.min(60_000, connectionState.serverHello?.limits.max_recording_ms ?? 60_000) /
      1_000,
  ),
);
function updateOption(kind: "asr" | "llm" | "tts" | "output_audio", event: Event) {
  settingsController.setInferenceOption(
    kind,
    (event.target as HTMLSelectElement).value,
  );
}

function updateMode(event: Event) {
  settingsController.setMode(
    (event.target as HTMLSelectElement).value as VoiceInteractionMode,
  );
}

function updateOverlayPosition(event: Event) {
  settingsController.setOverlayPosition(
    (event.target as HTMLSelectElement).value as OverlayPosition,
  );
}

function updateOverlayEnabled(event: Event) {
  settingsController.setOverlayEnabled(
    (event.target as unknown as { checked: boolean }).checked,
  );
}

function updateAutoInjection(mode: VoiceInteractionMode, event: Event) {
  settingsController.setAutoInjection(
    mode,
    (event.target as unknown as { checked: boolean }).checked,
  );
}

function updateInjectionLimit(event: Event) {
  settingsController.setInjectionMaxCodePoints(
    Number((event.target as unknown as { value: string }).value),
  );
}

async function captureShortcut() {
  shortcutCaptureMessage.value = "";
  shortcutCapturePreview.value = t("请按下组合键，按 Escape 取消");
  shortcutCaptureStatus.value = "recording";
  shortcutCaptureAbort = new globalThis.AbortController();
  try {
    await settingsController.beginRecordShortcutCapture();
    if (shortcutCaptureAbort.signal.aborted) {
      await settingsController.cancelRecordShortcutCapture();
      return;
    }
    const binding = await recordShortcutBinding({
      signal: shortcutCaptureAbort.signal,
      onPreview: (preview) => {
        shortcutCapturePreview.value = formatShortcutBinding(
          preview,
          props.appInfo?.platform ?? "windows",
        );
      },
    });
    if (!binding) {
      await settingsController.cancelRecordShortcutCapture();
      shortcutCaptureMessage.value = t("已取消快捷键录制，旧配置保持不变");
      return;
    }
    shortcutCaptureStatus.value = "saving";
    const display = await settingsController.commitRecordedShortcut(
      binding,
      props.appInfo?.platform ?? "windows",
    );
    shortcutCaptureMessage.value = t("已保存：{value}", { value: display });
  } catch (error) {
    await settingsController.cancelRecordShortcutCapture();
    shortcutCaptureMessage.value =
      error instanceof Error ? error.message : t("快捷键录制失败");
  } finally {
    shortcutCaptureAbort = null;
    shortcutCaptureStatus.value = "idle";
    shortcutCapturePreview.value = "";
  }
}

async function updateShortcutEnabled(event: Event) {
  const target = event.target as unknown as { checked: boolean };
  await settingsController.setRecordShortcutEnabled(target.checked);
  target.checked = settingsState.shortcutDesiredEnabled;
}

async function saveService() {
  serviceSaveError.value = "";
  serviceSaveStatus.value = "";
  try {
    await settingsController.saveServiceSettings({
      name: serviceNameInput.value.trim(),
      url: serviceUrlInput.value,
      autoConnect: autoConnectInput.value,
      authMode: authModeInput.value,
      preferredPipeline: preferredPipelineInput.value,
      token: tokenInput.value,
    });
    tokenInput.value = "";
    serviceSaveStatus.value = t("服务配置已保存");
  } catch (error) {
    serviceSaveError.value = error instanceof Error ? error.message : t("保存失败");
  }
}

async function selectServiceProfile(event: Event) {
  serviceSaveError.value = "";
  try {
    await settingsController.selectServiceProfile(
      (event.target as HTMLSelectElement).value,
    );
  } catch (error) {
    serviceSaveError.value = error instanceof Error ? error.message : t("切换失败");
  }
}

async function createServiceProfile(copyCurrent: boolean) {
  serviceSaveError.value = "";
  try {
    await settingsController.createServiceProfile(copyCurrent);
    serviceSaveStatus.value = copyCurrent ? t("配置已复制") : t("已创建新配置");
  } catch (error) {
    serviceSaveError.value = error instanceof Error ? error.message : t("创建失败");
  }
}

async function deleteServiceProfile() {
  const profile = activeServiceProfile.value;
  const profileId = profile?.id;
  if (!profileId) return;
  const confirmed = await showConfirm(t("确认删除“{name}”？", { name: profile.name }), {
    title: t("删除服务档案"),
    kind: "warning",
    confirmLabel: t("删除"),
  });
  if (!confirmed) return;
  serviceSaveError.value = "";
  serviceSaveStatus.value = "";
  try {
    await settingsController.deleteServiceProfile(profileId);
    serviceSaveStatus.value = t("配置已删除");
  } catch (error) {
    serviceSaveError.value = error instanceof Error ? error.message : t("删除失败");
  }
}

async function clearToken() {
  serviceSaveError.value = "";
  try {
    await settingsController.clearToken();
    tokenInput.value = "";
    serviceSaveStatus.value = t("Token 已清除");
  } catch (error) {
    serviceSaveError.value = error instanceof Error ? error.message : t("清除失败");
  }
}

async function testConnection() {
  serviceSaveError.value = "";
  const info = props.appInfo;
  try {
    await settingsController.testConnection(
      serviceUrlInput.value,
      {
        version: info?.version ?? "0.1.0",
        platform: info?.platform ?? "unknown",
        arch: info?.arch ?? "unknown",
      },
      authModeInput.value,
      preferredPipelineInput.value,
    );
  } catch {
    // Store: 连接测试错误由 settingsStore 展示。
  }
}

function updateInputDevice(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  settingsController.setInputDevice(value || null);
}

function updateRecognitionLanguage(event: Event) {
  settingsController.setLanguage((event.target as HTMLSelectElement).value);
}

function updateInterfaceLocale(event: Event) {
  settingsController.setInterfaceLocale(
    (event.target as HTMLSelectElement).value as "zh-CN" | "en-US",
  );
}

function updateAudioResponse(event: Event) {
  settingsController.setAudioResponseEnabled(
    (event.target as unknown as { checked: boolean }).checked,
  );
}

function updateVoice(event: Event) {
  settingsController.setVoice((event.target as HTMLSelectElement).value);
}

function updatePlaybackVolume(event: Event) {
  settingsController.setPlaybackVolume(
    Number((event.target as unknown as { value: string }).value),
  );
}

function updateDeveloperMode(event: Event) {
  settingsController.setDeveloperMode(
    (event.target as unknown as { checked: boolean }).checked,
  );
}

function updateDeveloperUseWebViewContextMenu(event: Event) {
  settingsController.setDeveloperUseWebViewContextMenu(
    (event.target as unknown as { checked: boolean }).checked,
  );
}

function updateDeveloperShowDiagnosticsPage(event: Event) {
  settingsController.setDeveloperShowDiagnosticsPage(
    (event.target as unknown as { checked: boolean }).checked,
  );
}

async function testMicrophone() {
  microphoneTestStatus.value = "testing";
  microphoneTestError.value = "";
  try {
    await runMicrophoneTest(settingsState.inputDeviceId, (level) => {
      microphoneTestLevel.value = level;
    });
    microphoneTestStatus.value = "succeeded";
  } catch (error) {
    microphoneTestStatus.value = "failed";
    microphoneTestError.value =
      error instanceof Error ? error.message : t("麦克风测试失败");
  }
}

async function clearLocalData() {
  const confirmed = await showConfirm(
    t(
      "确认清除全部本地数据？这会重置所有设置和服务档案，删除已保存的 Token 与诊断日志，且无法撤销。",
    ),
    { title: t("清除本地数据确认"), kind: "warning", confirmLabel: t("清除") },
  );
  if (!confirmed) return;
  localDataClearStatus.value = "clearing";
  localDataClearError.value = "";
  try {
    await clearLocalApplicationData();
    globalThis.location.reload();
  } catch (error) {
    localDataClearStatus.value = "failed";
    localDataClearError.value =
      error instanceof Error ? error.message : t("本地数据清除失败");
  }
}

watch(
  () =>
    [
      settingsState.activeServiceProfileId,
      settingsState.serviceUrl,
      settingsState.autoConnect,
    ] as const,
  ([, url, autoConnect]) => {
    const profile = activeServiceProfile.value;
    serviceNameInput.value = profile?.name ?? "";
    serviceUrlInput.value = url;
    autoConnectInput.value = autoConnect;
    authModeInput.value = profile?.authMode ?? "none";
    preferredPipelineInput.value = profile?.preferredPipeline ?? "auto";
    tokenInput.value = "";
  },
  { immediate: true },
);

onMounted(() => {
  void settingsController.refreshAudioInputDevices();
  unsubscribeDeviceChanges = subscribeAudioDeviceChanges(() => {
    void settingsController.refreshAudioInputDevices();
  });
});

onBeforeUnmount(() => {
  if (shortcutCaptureStatus.value !== "idle") {
    shortcutCaptureAbort?.abort();
    void settingsController.cancelRecordShortcutCapture();
  }
  unsubscribeDeviceChanges?.();
  unsubscribeDeviceChanges = null;
});
</script>

<template>
  <section class="panel" aria-labelledby="settings-title">
    <header class="panel-heading">
      <div>
        <h1 id="settings-title">{{ t("常规设置") }}</h1>
        <p class="panel-description">{{ t("当前阶段的客户端默认值。") }}</p>
      </div>
    </header>

    <div class="panel-body">
      <div class="settings-list">
        <h2 class="settings-category">{{ t("语言与地区") }}</h2>
        <article>
          <span>{{ t("界面语言") }}</span>
          <select
            :value="settingsState.interfaceLocale"
            @change="updateInterfaceLocale"
          >
            <option value="zh-CN">{{ t("简体中文") }}</option>
            <option value="en-US">{{ t("English") }}</option>
          </select>
          <small>{{ t("切换后立即应用，并保存在本机。") }}</small>
        </article>
        <h2 class="settings-category">{{ t("服务连接") }}</h2>
        <article>
          <span>{{ t("服务档案") }}</span>
          <div class="shortcut-setting">
            <select
              :value="settingsState.activeServiceProfileId"
              :disabled="Boolean(requestState.activeRequestId)"
              @change="selectServiceProfile"
            >
              <option
                v-for="profile in settingsState.serviceProfiles"
                :key="profile.id"
                :value="profile.id"
              >
                {{ profile.name }}
              </option>
            </select>
            <button
              class="button button-secondary"
              type="button"
              @click="createServiceProfile(false)"
            >
              {{ t("新建") }}
            </button>
            <button
              class="button button-secondary"
              type="button"
              @click="createServiceProfile(true)"
            >
              {{ t("复制配置") }}
            </button>
            <button
              class="button button-ghost"
              type="button"
              :disabled="settingsState.serviceProfiles.length <= 1"
              @click="deleteServiceProfile"
            >
              {{ t("删除") }}
            </button>
          </div>
        </article>
        <article>
          <span>{{ t("档案名称") }}</span>
          <input v-model="serviceNameInput" maxlength="80" />
        </article>
        <article>
          <span>WebSocket {{ t("地址") }}</span>
          <input
            v-model="serviceUrlInput"
            type="url"
            spellcheck="false"
            :disabled="Boolean(requestState.activeRequestId)"
            placeholder="wss://example.com/v1/voice/ws"
          />
        </article>
        <article>
          <span>{{ t("鉴权方式") }}</span>
          <select v-model="authModeInput">
            <option value="none">{{ t("无鉴权") }}</option>
            <option value="bearer">Bearer Token</option>
          </select>
        </article>
        <article>
          <span>{{ t("首选 Pipeline") }}</span>
          <select v-model="preferredPipelineInput">
            <option value="auto">{{ t("自动协商") }}</option>
            <option value="cascade">Cascade</option>
            <option value="native_audio">Native Audio</option>
          </select>
        </article>
        <article>
          <span>{{ t("服务 Token") }}</span>
          <div class="shortcut-setting">
            <input
              v-model="tokenInput"
              type="password"
              autocomplete="new-password"
              :placeholder="
                settingsState.tokenConfigured ? t('已配置，留空则不修改') : t('未配置')
              "
            />
            <button
              v-if="settingsState.tokenConfigured"
              class="button button-secondary"
              type="button"
              @click="clearToken"
            >
              {{ t("清除") }}
            </button>
          </div>
        </article>
        <article>
          <span>{{ t("自动连接") }}</span>
          <label class="setting-toggle">
            <input v-model="autoConnectInput" type="checkbox" />
            {{ t("应用启动后连接服务") }}
          </label>
        </article>
        <article>
          <span>{{ t("配置操作") }}</span>
          <div class="shortcut-setting">
            <button class="button button-primary" type="button" @click="saveService">
              {{ t("保存配置") }}
            </button>
            <button
              class="button button-secondary"
              type="button"
              :disabled="settingsState.connectionTestStatus === 'testing'"
              @click="testConnection"
            >
              {{
                settingsState.connectionTestStatus === "testing"
                  ? t("测试中…")
                  : t("测试连接")
              }}
            </button>
          </div>
          <small v-if="serviceSaveStatus">{{ serviceSaveStatus }}</small>
        </article>
        <article v-if="settingsState.connectionTestResult">
          <span>{{ t("测试结果") }}</span>
          <strong>
            v{{ settingsState.connectionTestResult.protocolVersion }} ·
            {{ settingsState.connectionTestResult.pipeline }} ·
            {{ settingsState.connectionTestResult.elapsedMs }} ms ·
            {{
              t("{count} 个模型", {
                count: settingsState.connectionTestResult.modelCount,
              })
            }}
          </strong>
        </article>
        <h2 class="settings-category">{{ t("操作与界面") }}</h2>
        <article>
          <span>{{ t("默认模式") }}</span>
          <select
            :value="settingsState.selectedMode"
            :disabled="Boolean(requestState.activeRequestId)"
            @change="updateMode"
          >
            <option
              v-for="(label, mode) in VOICE_MODE_LABELS"
              :key="mode"
              :value="mode"
            >
              {{ t("{mode}模式", { mode: t(label) }) }}
            </option>
          </select>
        </article>
        <article>
          <span>{{ t("按住说话快捷键") }}</span>
          <div class="shortcut-setting">
            <kbd>{{ shortcutCapturePreview || settingsState.shortcutDisplay }}</kbd>
            <button
              class="button button-secondary"
              type="button"
              :disabled="
                shortcutCaptureStatus !== 'idle' ||
                Boolean(requestState.activeRequestId)
              "
              @click="captureShortcut"
            >
              {{
                shortcutCaptureStatus === "recording" ? t("录制中…") : t("录制快捷键")
              }}
            </button>
            <label>
              <input
                type="checkbox"
                :checked="settingsState.shortcutDesiredEnabled"
                @change="updateShortcutEnabled"
              />
              {{ t("启用") }}
            </label>
          </div>
          <small v-if="shortcutCaptureMessage">{{ shortcutCaptureMessage }}</small>
          <small v-else>
            {{ settingsState.shortcutEnvironment }} ·
            {{
              settingsState.shortcutSupportsModifierOnly
                ? t("支持仅修饰键组合")
                : t("需要一个普通按键")
            }}
          </small>
        </article>
        <article>
          <span>{{ t("输入悬浮窗位置") }}</span>
          <select
            :value="settingsState.overlayPosition"
            :disabled="!settingsState.overlayEnabled"
            @change="updateOverlayPosition"
          >
            <option value="left">{{ t("底部左侧") }}</option>
            <option value="center">{{ t("底部居中") }}</option>
            <option value="right">{{ t("底部右侧") }}</option>
          </select>
        </article>
        <article>
          <span>{{ t("输入悬浮窗") }}</span>
          <label class="setting-toggle">
            <input
              type="checkbox"
              :checked="settingsState.overlayEnabled"
              @change="updateOverlayEnabled"
            />
            {{ t("录音及处理期间显示") }}
          </label>
        </article>
        <article>
          <span>{{ t("快捷键状态") }}</span>
          <strong
            class="shortcut-status"
            :data-status="settingsState.shortcutListenerStatus"
          >
            {{
              !settingsState.shortcutDesiredEnabled
                ? settingsState.shortcutRegistered
                  ? t("关闭失败")
                  : t("用户已关闭")
                : settingsState.shortcutRegistered &&
                    settingsState.shortcutListenerStatus === "running"
                  ? t("全局监听正常")
                  : settingsState.shortcutListenerStatus === "starting"
                    ? t("监听器启动中")
                    : settingsState.shortcutRegistered
                      ? t("监听器异常")
                      : t("等待注册")
            }}
          </strong>
          <small v-if="settingsState.shortcutLastEventAt">
            {{ t("最近触发：") }}
            {{
              new Date(settingsState.shortcutLastEventAt).toLocaleTimeString(
                settingsState.interfaceLocale,
              )
            }}
          </small>
        </article>
        <h2 class="settings-category">{{ t("录音与文本注入") }}</h2>
        <article>
          <span>{{ t("麦克风") }}</span>
          <select
            :value="settingsState.inputDeviceId ?? ''"
            :disabled="
              requestState.status === 'recording' || settingsState.audioDevicesLoading
            "
            @change="updateInputDevice"
          >
            <option value="">{{ t("系统默认麦克风") }}</option>
            <option
              v-for="device in settingsState.audioInputDevices"
              :key="device.id"
              :value="device.id"
            >
              {{ device.label }}
            </option>
          </select>
        </article>
        <article>
          <span>{{ t("单次录音上限") }}</span>
          <strong>{{ t("{count} 秒", { count: recordingLimitSeconds }) }}</strong>
        </article>
        <article>
          <span>{{ t("麦克风测试") }}</span>
          <div class="shortcut-setting">
            <button
              class="button button-secondary"
              type="button"
              :disabled="
                microphoneTestStatus === 'testing' ||
                requestState.status === 'recording'
              "
              @click="testMicrophone"
            >
              {{ microphoneTestStatus === "testing" ? t("测试中…") : t("开始测试") }}
            </button>
            <progress :value="microphoneTestLevel" max="1" />
          </div>
          <small v-if="microphoneTestStatus === 'succeeded'">{{
            t("麦克风测试完成")
          }}</small>
        </article>
        <article>
          <span>{{ t("识别语言") }}</span>
          <select :value="settingsState.language" @change="updateRecognitionLanguage">
            <option
              v-for="option in languageOptions"
              :key="option.id"
              :value="option.id"
            >
              {{ t(option.name) }}
            </option>
          </select>
        </article>
        <article>
          <span>{{ t("语音回复") }}</span>
          <label class="setting-toggle">
            <input
              type="checkbox"
              :checked="settingsState.audioResponseEnabled"
              @change="updateAudioResponse"
            />
            {{ t("请求并播放 TTS 音频") }}
          </label>
        </article>
        <article>
          <span>{{ t("音色") }}</span>
          <select
            :value="settingsState.voice"
            :disabled="!settingsState.audioResponseEnabled"
            @change="updateVoice"
          >
            <option v-for="option in voiceOptions" :key="option.id" :value="option.id">
              {{ t(option.name) }}
            </option>
          </select>
        </article>
        <article>
          <span>{{ t("播放音量") }}</span>
          <div class="number-setting">
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              :value="settingsState.playbackVolume"
              @input="updatePlaybackVolume"
            />
            <small>{{ Math.round(settingsState.playbackVolume * 100) }}%</small>
          </div>
        </article>
        <article>
          <span>{{ t("自动注入") }}</span>
          <div class="checkbox-row">
            <label v-for="(label, mode) in VOICE_MODE_LABELS" :key="mode">
              <input
                type="checkbox"
                :checked="settingsState.autoInjection[mode]"
                @change="updateAutoInjection(mode, $event)"
              />
              {{ t(label) }}
            </label>
          </div>
        </article>
        <article>
          <span>{{ t("注入长度上限") }}</span>
          <div class="number-setting">
            <input
              type="number"
              min="1"
              max="8000"
              step="100"
              :value="settingsState.injectionMaxCodePoints"
              @change="updateInjectionLimit"
            />
            <small>{{ t("Unicode 字符，最大 8000") }}</small>
          </div>
        </article>
        <h2 class="settings-category">{{ t("语音模型") }}</h2>
        <article>
          <span>ASR</span>
          <select
            :value="settingsState.selectedAsrId"
            :disabled="!connectionState.serverHello"
            @change="updateOption('asr', $event)"
          >
            <option
              v-for="option in connectionState.serverHello?.inference_options.asr ?? []"
              :key="option.id"
              :value="option.id"
              :title="option.description"
            >
              {{ option.name }}
            </option>
          </select>
        </article>
        <article>
          <span>LLM</span>
          <select
            :value="settingsState.selectedLlmId"
            :disabled="!connectionState.serverHello"
            @change="updateOption('llm', $event)"
          >
            <option
              v-for="option in connectionState.serverHello?.inference_options.llm ?? []"
              :key="option.id"
              :value="option.id"
              :title="option.description"
            >
              {{ option.name }}
            </option>
          </select>
        </article>
        <article>
          <span>TTS</span>
          <select
            :value="settingsState.selectedTtsId"
            :disabled="!connectionState.serverHello"
            @change="updateOption('tts', $event)"
          >
            <option
              v-for="option in connectionState.serverHello?.inference_options.tts ?? []"
              :key="option.id"
              :value="option.id"
              :title="option.description"
            >
              {{ option.name }}
            </option>
          </select>
        </article>
        <article>
          <span>{{ t("输出音频") }}</span>
          <select
            :value="settingsState.selectedOutputAudioId"
            :disabled="!connectionState.serverHello"
            @change="updateOption('output_audio', $event)"
          >
            <option
              v-for="option in connectionState.serverHello?.inference_options
                .output_audio ?? []"
              :key="option.id"
              :value="option.id"
              :title="option.description"
            >
              {{ option.name }}
            </option>
          </select>
        </article>
        <h2 class="settings-category">{{ t("关于") }}</h2>
        <article>
          <span>{{ t("客户端版本") }}</span>
          <strong v-if="appInfo">
            {{ appInfo.version }} · {{ appInfo.platform }} · {{ appInfo.arch }}
          </strong>
          <strong v-else>{{
            (appInfoError && t(appInfoError)) || t("读取中…")
          }}</strong>
        </article>
        <h2 class="settings-category">{{ t("隐私与本地数据") }}</h2>
        <article>
          <span>{{ t("本地数据") }}</span>
          <div class="shortcut-setting">
            <button
              class="button button-secondary"
              type="button"
              :disabled="
                localDataClearStatus === 'clearing' ||
                Boolean(requestState.activeRequestId)
              "
              @click="clearLocalData"
            >
              {{
                localDataClearStatus === "clearing" ? t("清除中…") : t("清除本地数据")
              }}
            </button>
          </div>
          <small>{{ t("设置、全部服务 Token 与诊断日志") }}</small>
        </article>
        <h2 class="settings-category">{{ t("开发") }}</h2>
        <article>
          <span>{{ t("开发模式") }}</span>
          <label class="setting-toggle">
            <input
              :checked="settingsState.developerModeEnabled"
              type="checkbox"
              @change="updateDeveloperMode"
            />
            {{ t("启用开发功能") }}
          </label>
          <small>{{ t("开启后可配置调试右键菜单和诊断页面") }}</small>
        </article>
        <article v-if="settingsState.developerModeEnabled">
          <span>{{ t("右键菜单") }}</span>
          <label class="setting-toggle">
            <input
              :checked="settingsState.developerUseWebViewContextMenu"
              type="checkbox"
              @change="updateDeveloperUseWebViewContextMenu"
            />
            {{ t("使用 WebView 默认右键菜单") }}
          </label>
          <small>{{ t("关闭时使用应用原生编辑菜单") }}</small>
        </article>
        <article v-if="settingsState.developerModeEnabled">
          <span>{{ t("诊断页面") }}</span>
          <label class="setting-toggle">
            <input
              :checked="settingsState.developerShowDiagnosticsPage"
              type="checkbox"
              @change="updateDeveloperShowDiagnosticsPage"
            />
            {{ t("显示诊断页面") }}
          </label>
          <small>{{ t("在主导航中显示连接与诊断工具") }}</small>
        </article>
      </div>
      <p v-if="serviceSaveError" class="inline-error" role="alert">
        {{ t(serviceSaveError) }}
      </p>
      <p v-if="settingsState.connectionTestError" class="inline-error" role="alert">
        {{ t(settingsState.connectionTestError) }}
      </p>
      <p v-if="settingsState.audioDevicesError" class="inline-error" role="alert">
        {{ t(settingsState.audioDevicesError) }}
      </p>
      <p v-if="microphoneTestError" class="inline-error" role="alert">
        {{ t(microphoneTestError) }}
      </p>
      <p v-if="settingsState.shortcutError" class="inline-error" role="alert">
        {{ t(settingsState.shortcutError) }}
      </p>
      <p v-if="settingsState.saveError" class="inline-error" role="alert">
        {{ t(settingsState.saveError) }}
      </p>
      <p v-if="localDataClearError" class="inline-error" role="alert">
        {{ t(localDataClearError) }}
      </p>
    </div>
  </section>
</template>

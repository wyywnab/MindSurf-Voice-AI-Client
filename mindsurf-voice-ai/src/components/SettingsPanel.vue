<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { settingsController } from "../controllers/settingsController";
import { subscribeAudioDeviceChanges } from "../services/audioInputDevices";
import { runMicrophoneTest } from "../services/microphoneTest";
import { useConnectionStore } from "../stores/connectionStore";
import { useRequestStore } from "../stores/requestStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { AppInfo } from "../types/app";
import {
  VOICE_MODE_LABELS,
  type OverlayPosition,
  type VoiceInteractionMode,
} from "../types/voice";
import type { ShortcutBinding } from "../types/shortcut";

const props = defineProps<{
  appInfo: AppInfo | null;
  appInfoError: string;
}>();

const connectionState = useConnectionStore().state;
const requestState = useRequestStore().state;
const settingsState = useSettingsStore().state;
const serviceUrlInput = ref(settingsState.serviceUrl);
const tokenInput = ref("");
const autoConnectInput = ref(settingsState.autoConnect);
const serviceSaveError = ref("");
const serviceSaveStatus = ref("");
const microphoneTestStatus = ref<"idle" | "testing" | "succeeded" | "failed">("idle");
const microphoneTestLevel = ref(0);
const microphoneTestError = ref("");
let unsubscribeDeviceChanges: (() => void) | null = null;
const isMacOS = computed(() => props.appInfo?.platform === "macos");
const shortcutOptions = computed<Array<{ value: ShortcutBinding; label: string }>>(
  () =>
    isMacOS.value
      ? [
          { value: "ctrl_win_space", label: "Control + Command + Space" },
          { value: "ctrl_alt_space", label: "Control + Option + Space" },
          { value: "ctrl_shift_space", label: "Control + Shift + Space" },
        ]
      : [
          { value: "ctrl_win", label: "Ctrl + Win" },
          { value: "ctrl_alt_space", label: "Ctrl + Alt + Space" },
          { value: "ctrl_shift_space", label: "Ctrl + Shift + Space" },
          { value: "ctrl_win_space", label: "Ctrl + Win + Space" },
        ],
);
const languageOptions = computed(
  () =>
    connectionState.serverHello?.recognition_languages ?? [
      { id: "auto", name: "自动识别" },
    ],
);
const voiceOptions = computed(
  () => connectionState.serverHello?.voices ?? [{ id: "default", name: "默认音色" }],
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

async function updateShortcut(event: Event) {
  const target = event.target as HTMLSelectElement;
  const updated = await settingsController.configureRecordShortcut(
    target.value as ShortcutBinding,
  );
  if (!updated) {
    target.value = settingsState.shortcutBinding;
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
      url: serviceUrlInput.value,
      autoConnect: autoConnectInput.value,
      token: tokenInput.value,
    });
    tokenInput.value = "";
    serviceSaveStatus.value = "服务配置已保存";
  } catch (error) {
    serviceSaveError.value = error instanceof Error ? error.message : "保存失败";
  }
}

async function clearToken() {
  serviceSaveError.value = "";
  try {
    await settingsController.clearToken();
    tokenInput.value = "";
    serviceSaveStatus.value = "Token 已清除";
  } catch (error) {
    serviceSaveError.value = error instanceof Error ? error.message : "清除失败";
  }
}

async function testConnection() {
  serviceSaveError.value = "";
  const info = props.appInfo;
  try {
    await settingsController.testConnection(serviceUrlInput.value, {
      version: info?.version ?? "0.1.0",
      platform: info?.platform ?? "unknown",
      arch: info?.arch ?? "unknown",
    });
  } catch {
    // Store: 连接测试错误由 settingsStore 展示。
  }
}

function updateInputDevice(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  settingsController.setInputDevice(value || null);
}

function updateLanguage(event: Event) {
  settingsController.setLanguage((event.target as HTMLSelectElement).value);
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
      error instanceof Error ? error.message : "麦克风测试失败";
  }
}

watch(
  () => [settingsState.serviceUrl, settingsState.autoConnect] as const,
  ([url, autoConnect]) => {
    serviceUrlInput.value = url;
    autoConnectInput.value = autoConnect;
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
  unsubscribeDeviceChanges?.();
  unsubscribeDeviceChanges = null;
});
</script>

<template>
  <section class="panel" aria-labelledby="settings-title">
    <header class="panel-heading">
      <div>
        <h1 id="settings-title">常规设置</h1>
        <p class="panel-description">当前阶段的客户端默认值。</p>
      </div>
    </header>

    <div class="panel-body">
      <div class="settings-list">
        <h2 class="settings-category">服务连接</h2>
        <article>
          <span>WebSocket 地址</span>
          <input
            v-model="serviceUrlInput"
            type="url"
            spellcheck="false"
            :disabled="Boolean(requestState.activeRequestId)"
            placeholder="wss://example.com/v1/voice/ws"
          />
        </article>
        <article>
          <span>服务 Token</span>
          <div class="shortcut-setting">
            <input
              v-model="tokenInput"
              type="password"
              autocomplete="new-password"
              :placeholder="
                settingsState.tokenConfigured ? '已配置，留空则不修改' : '未配置'
              "
            />
            <button
              v-if="settingsState.tokenConfigured"
              class="button button-secondary"
              type="button"
              @click="clearToken"
            >
              清除
            </button>
          </div>
        </article>
        <article>
          <span>自动连接</span>
          <label class="setting-toggle">
            <input v-model="autoConnectInput" type="checkbox" />
            应用启动后连接服务
          </label>
        </article>
        <article>
          <span>配置操作</span>
          <div class="shortcut-setting">
            <button class="button button-primary" type="button" @click="saveService">
              保存配置
            </button>
            <button
              class="button button-secondary"
              type="button"
              :disabled="settingsState.connectionTestStatus === 'testing'"
              @click="testConnection"
            >
              {{
                settingsState.connectionTestStatus === "testing"
                  ? "测试中…"
                  : "测试连接"
              }}
            </button>
          </div>
          <small v-if="serviceSaveStatus">{{ serviceSaveStatus }}</small>
        </article>
        <article v-if="settingsState.connectionTestResult">
          <span>测试结果</span>
          <strong>
            v{{ settingsState.connectionTestResult.protocolVersion }} ·
            {{ settingsState.connectionTestResult.pipeline }} ·
            {{ settingsState.connectionTestResult.elapsedMs }} ms ·
            {{ settingsState.connectionTestResult.modelCount }} 个模型
          </strong>
        </article>
        <h2 class="settings-category">操作与界面</h2>
        <article>
          <span>默认模式</span>
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
              {{ label }}模式
            </option>
          </select>
        </article>
        <article>
          <span>按住说话快捷键</span>
          <div class="shortcut-setting">
            <select :value="settingsState.shortcutBinding" @change="updateShortcut">
              <option
                v-for="option in shortcutOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ option.label }}
              </option>
            </select>
            <label>
              <input
                type="checkbox"
                :checked="settingsState.shortcutDesiredEnabled"
                @change="updateShortcutEnabled"
              />
              启用
            </label>
          </div>
        </article>
        <article>
          <span>输入悬浮窗位置</span>
          <select
            :value="settingsState.overlayPosition"
            :disabled="!settingsState.overlayEnabled"
            @change="updateOverlayPosition"
          >
            <option value="left">底部左侧</option>
            <option value="center">底部居中</option>
            <option value="right">底部右侧</option>
          </select>
        </article>
        <article>
          <span>输入悬浮窗</span>
          <label class="setting-toggle">
            <input
              type="checkbox"
              :checked="settingsState.overlayEnabled"
              @change="updateOverlayEnabled"
            />
            录音及处理期间显示
          </label>
        </article>
        <article>
          <span>快捷键状态</span>
          <strong
            class="shortcut-status"
            :data-status="settingsState.shortcutListenerStatus"
          >
            {{
              !settingsState.shortcutDesiredEnabled
                ? settingsState.shortcutRegistered
                  ? "关闭失败"
                  : "用户已关闭"
                : settingsState.shortcutRegistered &&
                    settingsState.shortcutListenerStatus === "running"
                  ? "全局监听正常"
                  : settingsState.shortcutListenerStatus === "starting"
                    ? "监听器启动中"
                    : settingsState.shortcutRegistered
                      ? "监听器异常"
                      : "等待注册"
            }}
          </strong>
          <small v-if="settingsState.shortcutLastEventAt">
            最近触发：
            {{ new Date(settingsState.shortcutLastEventAt).toLocaleTimeString() }}
          </small>
        </article>
        <h2 class="settings-category">录音与文本注入</h2>
        <article>
          <span>麦克风</span>
          <select
            :value="settingsState.inputDeviceId ?? ''"
            :disabled="
              requestState.status === 'recording' || settingsState.audioDevicesLoading
            "
            @change="updateInputDevice"
          >
            <option value="">系统默认麦克风</option>
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
          <span>单次录音上限</span>
          <strong>{{ recordingLimitSeconds }} 秒</strong>
        </article>
        <article>
          <span>麦克风测试</span>
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
              {{ microphoneTestStatus === "testing" ? "测试中…" : "开始测试" }}
            </button>
            <progress :value="microphoneTestLevel" max="1" />
          </div>
          <small v-if="microphoneTestStatus === 'succeeded'">麦克风测试完成</small>
        </article>
        <article>
          <span>识别语言</span>
          <select :value="settingsState.language" @change="updateLanguage">
            <option
              v-for="option in languageOptions"
              :key="option.id"
              :value="option.id"
            >
              {{ option.name }}
            </option>
          </select>
        </article>
        <article>
          <span>语音回复</span>
          <label class="setting-toggle">
            <input
              type="checkbox"
              :checked="settingsState.audioResponseEnabled"
              @change="updateAudioResponse"
            />
            请求并播放 TTS 音频
          </label>
        </article>
        <article>
          <span>音色</span>
          <select
            :value="settingsState.voice"
            :disabled="!settingsState.audioResponseEnabled"
            @change="updateVoice"
          >
            <option v-for="option in voiceOptions" :key="option.id" :value="option.id">
              {{ option.name }}
            </option>
          </select>
        </article>
        <article>
          <span>播放音量</span>
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
          <span>自动注入</span>
          <div class="checkbox-row">
            <label v-for="(label, mode) in VOICE_MODE_LABELS" :key="mode">
              <input
                type="checkbox"
                :checked="settingsState.autoInjection[mode]"
                @change="updateAutoInjection(mode, $event)"
              />
              {{ label }}
            </label>
          </div>
        </article>
        <article>
          <span>注入长度上限</span>
          <div class="number-setting">
            <input
              type="number"
              min="1"
              max="8000"
              step="100"
              :value="settingsState.injectionMaxCodePoints"
              @change="updateInjectionLimit"
            />
            <small>Unicode 字符，最大 8000</small>
          </div>
        </article>
        <h2 class="settings-category">语音模型</h2>
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
          <span>输出音频</span>
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
        <h2 class="settings-category">关于</h2>
        <article>
          <span>客户端版本</span>
          <strong v-if="appInfo">
            {{ appInfo.version }} · {{ appInfo.platform }} · {{ appInfo.arch }}
          </strong>
          <strong v-else>{{ appInfoError || "读取中…" }}</strong>
        </article>
      </div>
      <p v-if="serviceSaveError" class="inline-error" role="alert">
        {{ serviceSaveError }}
      </p>
      <p v-if="settingsState.connectionTestError" class="inline-error" role="alert">
        {{ settingsState.connectionTestError }}
      </p>
      <p v-if="settingsState.audioDevicesError" class="inline-error" role="alert">
        {{ settingsState.audioDevicesError }}
      </p>
      <p v-if="microphoneTestError" class="inline-error" role="alert">
        {{ microphoneTestError }}
      </p>
      <p v-if="settingsState.shortcutError" class="inline-error" role="alert">
        {{ settingsState.shortcutError }}
      </p>
      <p v-if="settingsState.saveError" class="inline-error" role="alert">
        {{ settingsState.saveError }}
      </p>
    </div>
  </section>
</template>

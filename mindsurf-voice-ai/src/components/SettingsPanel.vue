<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import {
  getSystemPermissionStatus,
  openSystemPermissionSettings,
  requestSystemPermission,
} from "../services/permissions";
import { useVoiceSessionStore } from "../stores/voiceSession";
import type { AppInfo } from "../types/app";
import type { SystemPermission, SystemPermissionState } from "../types/permissions";
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

const session = useVoiceSessionStore();
const isMacOS = computed(() => props.appInfo?.platform === "macos");
const shortcutOptions = computed<Array<{ value: ShortcutBinding; label: string }>>(
  () =>
    isMacOS.value
      ? [
          { value: "ctrl_win", label: "Control + Command" },
          { value: "ctrl_alt_space", label: "Control + Option + Space" },
          { value: "ctrl_shift_space", label: "Control + Shift + Space" },
          { value: "ctrl_win_space", label: "Control + Command + Space" },
        ]
      : [
          { value: "ctrl_win", label: "Ctrl + Win" },
          { value: "ctrl_alt_space", label: "Ctrl + Alt + Space" },
          { value: "ctrl_shift_space", label: "Ctrl + Shift + Space" },
          { value: "ctrl_win_space", label: "Ctrl + Win + Space" },
        ],
);
const macPermissionStates = reactive<
  Record<"accessibility" | "input_monitoring", SystemPermissionState>
>({
  accessibility: "unknown",
  input_monitoring: "unknown",
});
const permissionBusy = ref<SystemPermission | null>(null);
const permissionError = ref("");

function permissionStatusLabel(status: SystemPermissionState) {
  return {
    granted: "已授权",
    denied: "未授权",
    unknown: "检查中",
  }[status];
}

async function refreshMacPermission(permission: "accessibility" | "input_monitoring") {
  const result = await getSystemPermissionStatus(permission);
  if (result.ok) {
    macPermissionStates[permission] = result.data.status;
    if (
      permission === "input_monitoring" &&
      result.data.status === "granted" &&
      session.state.shortcutListenerStatus !== "running"
    ) {
      await session.initializeRecordShortcut();
    }
  } else {
    permissionError.value = result.error.message;
  }
}

function refreshMacPermissions() {
  if (!isMacOS.value) {
    return;
  }
  void refreshMacPermission("accessibility");
  void refreshMacPermission("input_monitoring");
}

async function requestMacPermission(permission: "accessibility" | "input_monitoring") {
  permissionBusy.value = permission;
  permissionError.value = "";
  const result = await requestSystemPermission(permission);
  permissionBusy.value = null;
  if (!result.ok) {
    permissionError.value = result.error.message;
    return;
  }
  macPermissionStates[permission] = result.data.status;
  if (permission === "input_monitoring" && result.data.status === "granted") {
    await session.initializeRecordShortcut();
  }
}

async function openMacPermissionSettings(
  permission: "accessibility" | "input_monitoring",
) {
  const result = await openSystemPermissionSettings(permission);
  if (!result.ok) {
    permissionError.value = result.error.message;
  }
}

watch(
  isMacOS,
  (enabled) => {
    if (enabled) {
      refreshMacPermissions();
    }
  },
  { immediate: true },
);

onMounted(() => {
  globalThis.addEventListener("focus", refreshMacPermissions);
});

onBeforeUnmount(() => {
  globalThis.removeEventListener("focus", refreshMacPermissions);
});

function updateOption(kind: "asr" | "llm" | "tts" | "output_audio", event: Event) {
  session.setInferenceOption(kind, (event.target as HTMLSelectElement).value);
}

function updateMode(event: Event) {
  session.setMode((event.target as HTMLSelectElement).value as VoiceInteractionMode);
}

function updateOverlayPosition(event: Event) {
  session.setOverlayPosition(
    (event.target as HTMLSelectElement).value as OverlayPosition,
  );
}

function updateOverlayEnabled(event: Event) {
  session.setOverlayEnabled((event.target as unknown as { checked: boolean }).checked);
}

function updateAutoInjection(mode: VoiceInteractionMode, event: Event) {
  session.setAutoInjection(
    mode,
    (event.target as unknown as { checked: boolean }).checked,
  );
}

function updateInjectionLimit(event: Event) {
  session.setInjectionMaxCodePoints(
    Number((event.target as unknown as { value: string }).value),
  );
}

async function updateShortcut(event: Event) {
  const target = event.target as HTMLSelectElement;
  const updated = await session.configureRecordShortcut(
    target.value as ShortcutBinding,
  );
  if (!updated) {
    target.value = session.state.shortcutBinding;
  }
}

async function updateShortcutEnabled(event: Event) {
  const target = event.target as unknown as { checked: boolean };
  await session.setRecordShortcutEnabled(target.checked);
  target.checked = session.state.shortcutEnabled;
}
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
        <h2 class="settings-category">操作与界面</h2>
        <article>
          <span>默认模式</span>
          <select
            :value="session.state.selectedMode"
            :disabled="Boolean(session.state.activeRequestId)"
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
            <select :value="session.state.shortcutBinding" @change="updateShortcut">
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
                :checked="session.state.shortcutEnabled"
                @change="updateShortcutEnabled"
              />
              启用
            </label>
          </div>
        </article>
        <article>
          <span>输入悬浮窗位置</span>
          <select
            :value="session.state.overlayPosition"
            :disabled="!session.state.overlayEnabled"
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
              :checked="session.state.overlayEnabled"
              @change="updateOverlayEnabled"
            />
            录音及处理期间显示
          </label>
        </article>
        <article>
          <span>快捷键状态</span>
          <strong
            class="shortcut-status"
            :data-status="session.state.shortcutListenerStatus"
          >
            {{
              session.state.shortcutListenerStatus === "running"
                ? "全局监听正常"
                : session.state.shortcutListenerStatus === "starting"
                  ? "监听器启动中"
                  : "监听器异常"
            }}
          </strong>
          <small v-if="session.state.shortcutLastEventAt">
            最近触发：
            {{ new Date(session.state.shortcutLastEventAt).toLocaleTimeString() }}
          </small>
        </article>
        <h2 class="settings-category">录音与文本注入</h2>
        <article>
          <span>录音格式</span>
          <strong>16 kHz / Mono / PCM16LE</strong>
        </article>
        <article>
          <span>单次录音上限</span>
          <strong>60 秒</strong>
        </article>
        <article>
          <span>自动注入</span>
          <div class="checkbox-row">
            <label v-for="(label, mode) in VOICE_MODE_LABELS" :key="mode">
              <input
                type="checkbox"
                :checked="session.state.autoInjection[mode]"
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
              :value="session.state.injectionMaxCodePoints"
              @change="updateInjectionLimit"
            />
            <small>Unicode 字符，最大 8000</small>
          </div>
        </article>
        <template v-if="isMacOS">
          <h2 class="settings-category">macOS 系统权限</h2>
          <article>
            <span>辅助功能</span>
            <div class="permission-setting">
              <strong :data-status="macPermissionStates.accessibility">
                {{ permissionStatusLabel(macPermissionStates.accessibility) }}
              </strong>
              <small>用于向当前应用的光标位置输入识别结果</small>
              <div>
                <button
                  v-if="macPermissionStates.accessibility !== 'granted'"
                  class="button button-primary button-compact"
                  type="button"
                  :disabled="permissionBusy === 'accessibility'"
                  @click="requestMacPermission('accessibility')"
                >
                  请求授权
                </button>
                <button
                  class="button button-secondary button-compact"
                  type="button"
                  @click="openMacPermissionSettings('accessibility')"
                >
                  打开系统设置
                </button>
              </div>
            </div>
          </article>
          <article>
            <span>输入监控</span>
            <div class="permission-setting">
              <strong :data-status="macPermissionStates.input_monitoring">
                {{ permissionStatusLabel(macPermissionStates.input_monitoring) }}
              </strong>
              <small>用于在其他应用处于前台时监听按住说话快捷键</small>
              <div>
                <button
                  v-if="macPermissionStates.input_monitoring !== 'granted'"
                  class="button button-primary button-compact"
                  type="button"
                  :disabled="permissionBusy === 'input_monitoring'"
                  @click="requestMacPermission('input_monitoring')"
                >
                  请求授权
                </button>
                <button
                  class="button button-secondary button-compact"
                  type="button"
                  @click="openMacPermissionSettings('input_monitoring')"
                >
                  打开系统设置
                </button>
              </div>
            </div>
          </article>
        </template>
        <h2 class="settings-category">语音模型</h2>
        <article>
          <span>ASR</span>
          <select
            :value="session.state.selectedAsrId"
            :disabled="!session.state.serverHello"
            @change="updateOption('asr', $event)"
          >
            <option
              v-for="option in session.state.serverHello?.inference_options.asr ?? []"
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
            :value="session.state.selectedLlmId"
            :disabled="!session.state.serverHello"
            @change="updateOption('llm', $event)"
          >
            <option
              v-for="option in session.state.serverHello?.inference_options.llm ?? []"
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
            :value="session.state.selectedTtsId"
            :disabled="!session.state.serverHello"
            @change="updateOption('tts', $event)"
          >
            <option
              v-for="option in session.state.serverHello?.inference_options.tts ?? []"
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
            :value="session.state.selectedOutputAudioId"
            :disabled="!session.state.serverHello"
            @change="updateOption('output_audio', $event)"
          >
            <option
              v-for="option in session.state.serverHello?.inference_options
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
      <p v-if="session.state.shortcutError" class="inline-error" role="alert">
        {{ session.state.shortcutError }}
      </p>
      <p v-if="permissionError" class="inline-error" role="alert">
        {{ permissionError }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";

import {
  getSystemPermissionStatus,
  openSystemPermissionSettings,
  requestSystemPermission,
} from "../services/permissions";
import { describeRecorderError, prepareMicrophone } from "../services/recorder";
import { useI18n } from "../services/i18n";
import { settingsController } from "../controllers/settingsController";
import { useSettingsStore } from "../stores/settingsStore";
import type { AppInfo } from "../types/app";
import type { SystemPermission, SystemPermissionState } from "../types/permissions";

const props = defineProps<{
  appInfo: AppInfo | null;
}>();
const { t } = useI18n();

const settings = useSettingsStore();
const isMacOS = computed(
  () =>
    props.appInfo?.platform === "macos" ||
    (!props.appInfo && globalThis.navigator.userAgent.includes("Mac OS")),
);
const macPermissions: readonly SystemPermission[] = ["microphone", "accessibility"];
const permissionStates = reactive<Record<SystemPermission, SystemPermissionState>>({
  microphone: "unknown",
  accessibility: "unknown",
  input_monitoring: "unknown",
});
const permissionBusy = ref<SystemPermission | null>(null);
const permissionInitializationBusy = ref(false);
const permissionError = ref("");
const microphoneProbeState = ref<"unknown" | "checking" | "ready" | "failed">(
  "unknown",
);
const shortcutReady = computed(
  () =>
    !settings.state.shortcutDesiredEnabled ||
    (settings.state.shortcutRegistered &&
      settings.state.shortcutListenerStatus === "running"),
);

const permissionsReady = computed(
  () =>
    (!isMacOS.value ||
      macPermissions.every(
        (permission) => permissionStates[permission] === "granted",
      )) &&
    microphoneProbeState.value === "ready" &&
    shortcutReady.value,
);

const permissionInitializationLabel = computed(() => {
  if (permissionInitializationBusy.value) {
    return t("正在按顺序初始化…");
  }
  if (permissionsReady.value) {
    return t("录音、快捷键和文本注入均已就绪");
  }
  return t("尚未完成全部权限初始化");
});

const microphoneProbeLabel = computed(() =>
  t(
    {
      unknown: "WebView 录音能力尚未检查",
      checking: "正在检查 WebView 录音能力",
      ready: "WebView 录音能力正常",
      failed: "WebView 录音能力检查失败",
    }[microphoneProbeState.value],
  ),
);

function permissionStatusLabel(status: SystemPermissionState) {
  return t(
    {
      granted: "已授权",
      denied: "未授权",
      not_determined: "等待授权",
      restricted: "受系统限制",
      unknown: "检查中",
    }[status],
  );
}

async function refreshPermission(permission: SystemPermission) {
  const result = await getSystemPermissionStatus(permission);
  if (result.ok) {
    permissionStates[permission] = result.data.status;
    if (permission === "microphone" && result.data.status !== "granted") {
      microphoneProbeState.value = "unknown";
    }
  } else {
    permissionError.value = result.error.message;
  }
}

async function refreshPermissions() {
  if (!isMacOS.value) {
    return;
  }
  await Promise.all(macPermissions.map(refreshPermission));
}

async function prepareWebViewMicrophone() {
  microphoneProbeState.value = "checking";
  try {
    await prepareMicrophone();
    microphoneProbeState.value = "ready";
    return true;
  } catch (error) {
    microphoneProbeState.value = "failed";
    permissionError.value = describeRecorderError(error, {
      nativePermissionGranted: permissionStates.microphone === "granted",
    });
    return false;
  }
}

async function requestPermission(permission: SystemPermission) {
  permissionBusy.value = permission;
  permissionError.value = "";
  const result = await requestSystemPermission(permission);
  if (!result.ok) {
    permissionBusy.value = null;
    permissionError.value = result.error.message;
    return false;
  }
  permissionStates[permission] = result.data.status;
  if (permission === "microphone" && result.data.status === "granted") {
    await prepareWebViewMicrophone();
  }
  permissionBusy.value = null;
  return result.data.status === "granted";
}

async function initializePermissions() {
  if (permissionInitializationBusy.value) {
    return;
  }

  permissionInitializationBusy.value = true;
  permissionError.value = "";
  let firstError = "";
  try {
    if (isMacOS.value) {
      await settingsController.initializeRecordShortcut();
      for (const permission of macPermissions) {
        await refreshPermission(permission);
        if (permissionStates[permission] !== "granted") {
          await requestPermission(permission);
        } else if (
          permission === "microphone" &&
          microphoneProbeState.value !== "ready"
        ) {
          await prepareWebViewMicrophone();
        }
        firstError ||= permissionError.value;
      }
      await refreshPermissions();
    } else {
      await prepareWebViewMicrophone();
      firstError = permissionError.value;
    }
  } finally {
    permissionInitializationBusy.value = false;
  }

  if (firstError) {
    permissionError.value = firstError;
  } else if (!permissionsReady.value) {
    permissionError.value = t(
      "仍有权限未授权，请打开对应的系统设置；完成后返回应用会自动刷新状态。",
    );
  }
}

async function openPermissionSettings(permission: SystemPermission) {
  const result = await openSystemPermissionSettings(permission);
  if (!result.ok) {
    permissionError.value = result.error.message;
  }
}

watch(
  isMacOS,
  (enabled) => {
    if (enabled) {
      void refreshPermissions();
    }
  },
  { immediate: true },
);

onMounted(() => {
  globalThis.addEventListener("focus", refreshPermissions);
});

onBeforeUnmount(() => {
  globalThis.removeEventListener("focus", refreshPermissions);
});
</script>

<template>
  <section class="panel" aria-labelledby="permissions-title">
    <header class="panel-heading">
      <div>
        <h1 id="permissions-title">{{ t("系统权限") }}</h1>
        <p class="panel-description">
          {{ t("集中检查和配置录音、全局快捷键及文本注入所需权限。") }}
        </p>
      </div>
    </header>

    <div class="panel-body">
      <div class="settings-list">
        <h2 class="settings-category">{{ t("权限状态") }}</h2>
        <article class="permission-initializer">
          <span>{{ t("统一权限初始化") }}</span>
          <div>
            <strong :data-ready="permissionsReady">
              {{ permissionInitializationLabel }}
            </strong>
            <small v-if="isMacOS">
              {{ t("将依次检查麦克风和辅助功能，并验证实际录音与全局快捷键监听器。") }}
            </small>
            <small v-else>{{
              t("检查并申请麦克风权限，同时验证实际录音能力。")
            }}</small>
            <button
              class="button button-primary button-compact"
              type="button"
              :disabled="permissionInitializationBusy || permissionBusy !== null"
              @click="initializePermissions"
            >
              {{
                permissionInitializationBusy
                  ? t("正在初始化…")
                  : permissionsReady
                    ? t("重新检查全部权限")
                    : t("初始化系统权限")
              }}
            </button>
          </div>
        </article>
        <article>
          <span>{{ t("麦克风") }}</span>
          <div class="permission-setting">
            <strong v-if="isMacOS" :data-status="permissionStates.microphone">
              {{ permissionStatusLabel(permissionStates.microphone) }}
            </strong>
            <strong v-else :data-status="microphoneProbeState">
              {{ microphoneProbeState === "ready" ? t("已授权") : t("待检查") }}
            </strong>
            <small>{{
              t("用于录制语音；{status}", { status: microphoneProbeLabel })
            }}</small>
            <div>
              <button
                v-if="
                  !isMacOS ||
                  permissionStates.microphone !== 'granted' ||
                  microphoneProbeState !== 'ready'
                "
                class="button button-primary button-compact"
                type="button"
                :disabled="
                  permissionInitializationBusy || permissionBusy === 'microphone'
                "
                @click="
                  isMacOS ? requestPermission('microphone') : prepareWebViewMicrophone()
                "
              >
                {{ t("检查并授权") }}
              </button>
              <button
                class="button button-secondary button-compact"
                type="button"
                :disabled="permissionInitializationBusy"
                @click="openPermissionSettings('microphone')"
              >
                {{ t("打开系统设置") }}
              </button>
            </div>
          </div>
        </article>
        <template v-if="isMacOS">
          <article>
            <span>{{ t("辅助功能") }}</span>
            <div class="permission-setting">
              <strong :data-status="permissionStates.accessibility">
                {{ permissionStatusLabel(permissionStates.accessibility) }}
              </strong>
              <small>{{ t("用于向当前应用的光标位置输入识别结果") }}</small>
              <div>
                <button
                  v-if="permissionStates.accessibility !== 'granted'"
                  class="button button-primary button-compact"
                  type="button"
                  :disabled="
                    permissionInitializationBusy || permissionBusy === 'accessibility'
                  "
                  @click="requestPermission('accessibility')"
                >
                  {{ t("请求授权") }}
                </button>
                <button
                  class="button button-secondary button-compact"
                  type="button"
                  :disabled="permissionInitializationBusy"
                  @click="openPermissionSettings('accessibility')"
                >
                  {{ t("打开系统设置") }}
                </button>
              </div>
            </div>
          </article>
          <article>
            <span>{{ t("全局快捷键") }}</span>
            <div class="permission-setting">
              <strong
                :data-status="
                  shortcutReady
                    ? 'granted'
                    : settings.state.shortcutListenerStatus === 'error'
                      ? 'denied'
                      : 'unknown'
                "
              >
                {{
                  !settings.state.shortcutDesiredEnabled
                    ? t("已关闭")
                    : shortcutReady
                      ? t("监听器运行中")
                      : settings.state.shortcutListenerStatus === "error"
                        ? t("监听器启动失败")
                        : t("监听器启动中")
                }}
              </strong>
              <small>{{
                t("使用 macOS 系统全局热键注册，不依赖“输入监控”权限")
              }}</small>
              <small v-if="settings.state.shortcutError" class="inline-error">
                {{ t(settings.state.shortcutError) }}
              </small>
              <div>
                <button
                  v-if="settings.state.shortcutDesiredEnabled && !shortcutReady"
                  class="button button-primary button-compact"
                  type="button"
                  :disabled="permissionInitializationBusy"
                  @click="settingsController.initializeRecordShortcut()"
                >
                  {{ t("重新启动监听器") }}
                </button>
              </div>
            </div>
          </article>
        </template>
      </div>
      <p v-if="permissionError" class="inline-error" role="alert">
        {{ t(permissionError) }}
      </p>
    </div>
  </section>
</template>

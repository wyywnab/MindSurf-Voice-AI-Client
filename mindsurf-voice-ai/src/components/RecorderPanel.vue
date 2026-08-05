<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";

import { useRecorder } from "../composables/useRecorder";
import { useI18n } from "../services/i18n";
import { RecordingController } from "../controllers/recordingController";
import { OverlaySyncController } from "../controllers/overlaySyncController";
import { settingsController } from "../controllers/settingsController";
import { voiceRequestController } from "../controllers/voiceRequestController";
import {
  reportShortcutEventHandled,
  subscribeShortcutEvents,
} from "../services/shortcuts";
import { useConnectionStore } from "../stores/connectionStore";
import { useRequestStore } from "../stores/requestStore";
import { settingsStoreActions, useSettingsStore } from "../stores/settingsStore";
import type { OverlaySnapshot } from "../types/overlay";
import { VOICE_MODE_LABELS, type VoiceInteractionMode } from "../types/voice";
import AudioMeter from "./AudioMeter.vue";

const { t } = useI18n();

const recorder = useRecorder();
const recordingController = new RecordingController(recorder);
const connectionState = useConnectionStore().state;
const requestState = useRequestStore().state;
const settingsState = useSettingsStore().state;
let shortcutAction = Promise.resolve();
let shortcutDisposed = false;
let shortcutHeld = false;
let unlistenShortcuts: (() => void) | null = null;
let recordingAttempt = 0;

const canStart = computed(
  () =>
    connectionState.status === "connected" &&
    !requestState.activeRequestId &&
    recordingController.canStart(),
);

const formattedDuration = computed(() => {
  const totalSeconds = recorder.durationMs.value / 1_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const tenths = Math.floor((totalSeconds % 1) * 10);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${tenths}`;
});

const permissionLabel = computed(() =>
  t(
    {
      unknown: "检查中",
      prompt: "等待授权",
      granted: "已授权",
      denied: "已拒绝",
      unsupported: "不支持",
    }[recorder.permissionState.value],
  ),
);

const stateLabel = computed(() => {
  if (recorder.state.value === "ready") {
    if (requestState.status === "committing") {
      return t("正在提交录音");
    }
    if (requestState.status === "recognizing") {
      return t("正在等待最终识别");
    }
    if (requestState.status === "generating") {
      return t("正在生成回复");
    }
    if (requestState.status === "playing") {
      return t("正在播放回复");
    }
    if (requestState.status === "completed") {
      return t("识别完成");
    }
  }

  return t(
    {
      idle: "准备录音",
      requesting: "正在请求麦克风权限",
      prepared: "麦克风已就绪，正在创建请求",
      recording: "正在录音",
      stopping: "正在处理音频",
      ready: "录音已完成",
      error: "录音不可用",
    }[recorder.state.value],
  );
});

const transcript = computed(() => requestState.asrFinal || requestState.asrPartial);
const assistantText = computed(
  () => requestState.assistantFinal || requestState.assistantStreaming,
);
const playbackActive = computed(() =>
  ["buffering", "playing"].includes(requestState.playbackStatus),
);
const playbackStatusLabel = computed(() =>
  t(
    {
      idle: "等待语音",
      buffering: "正在缓冲",
      playing: "正在播放",
      done: "播放完成",
      stopped: "已停止",
      error: "播放失败",
    }[requestState.playbackStatus],
  ),
);
const firstPlaybackDelay = computed(() => {
  const { firstChunkAt, playbackStartedAt } = requestState.playbackMetrics;
  return firstChunkAt !== null && playbackStartedAt !== null
    ? `${playbackStartedAt - firstChunkAt} ms`
    : "—";
});
const injectionStatusLabel = computed(() =>
  t(
    {
      idle: "",
      waiting: "请切换到目标窗口，稍后开始注入…",
      injecting: "正在向当前前台窗口注入文本…",
      succeeded: "文本注入完成",
      partial: "部分文本未能注入",
      failed: "文本注入失败",
    }[requestState.injectionStatus],
  ),
);
const overlayActive = computed(
  () =>
    settingsState.overlayEnabled &&
    (recorder.isBusy.value ||
      Boolean(requestState.activeRequestId) ||
      playbackActive.value),
);

function createOverlaySnapshot(): OverlaySnapshot {
  return {
    assistantText: assistantText.value,
    cancellable: recorder.isBusy.value || Boolean(requestState.activeRequestId),
    duration: formattedDuration.value,
    durationMs: recorder.durationMs.value,
    level: recorder.level.value,
    locale: settingsState.interfaceLocale,
    mode: settingsState.selectedMode,
    recording: recorder.isRecording.value,
    status:
      requestState.status === "failed"
        ? t("处理失败")
        : playbackActive.value
          ? playbackStatusLabel.value
          : stateLabel.value,
    transcript: transcript.value,
    updatedAtMs: Date.now(),
  };
}

const overlaySync = new OverlaySyncController({
  createSnapshot: createOverlaySnapshot,
  isEnabled: () => settingsState.overlayEnabled,
  isTerminal: () => ["completed", "cancelled", "failed"].includes(requestState.status),
  onCancel: () => {
    if (recorder.isBusy.value || requestState.activeRequestId) {
      enqueueShortcutAction(cancelNetworkRecording);
    }
  },
});

async function startNetworkRecording(
  shouldContinue: () => boolean = () => true,
  fromGlobalShortcut = false,
) {
  const attempt = ++recordingAttempt;
  if (fromGlobalShortcut) {
    await overlaySync.showBeforeShortcut();
  }
  if (attempt === recordingAttempt) {
    await recordingController.startPushToTalk(
      () => attempt === recordingAttempt && shouldContinue(),
    );
  }
}

function selectMode(mode: VoiceInteractionMode) {
  settingsController.setMode(mode);
}

function injectManually(text: string) {
  void voiceRequestController.textOutput.output(text, 1_500);
}

async function stopNetworkRecording() {
  await recordingController.stopPushToTalk();
}

async function cancelNetworkRecording() {
  recordingAttempt += 1;
  await recordingController.cancelCurrentRequest();
}

function enqueueShortcutAction(action: () => Promise<void>) {
  shortcutAction = shortcutAction.then(action).catch(() => {
    // Recorder and session stores expose actionable errors in the UI.
  });
}

function handleShortcutPressed(timestampMs: number) {
  settingsStoreActions.noteShortcutEvent(timestampMs);
  void reportShortcutEventHandled({
    phase: "pressed",
    canStart: canStart.value,
    recorderState: recorder.state.value,
    requestStatus: requestState.status,
  });
  if (shortcutHeld) {
    return;
  }
  shortcutHeld = true;
  enqueueShortcutAction(async () => {
    if (playbackActive.value) {
      await recordingController.interruptPlayback();
    }
    if (!canStart.value) {
      return;
    }
    await startNetworkRecording(() => shortcutHeld, true);
    if (!shortcutHeld && recorder.isRecording.value) {
      await stopNetworkRecording();
    }
  });
}

function handleShortcutReleased(timestampMs: number) {
  settingsStoreActions.noteShortcutEvent(timestampMs);
  void reportShortcutEventHandled({
    phase: "released",
    canStart: canStart.value,
    recorderState: recorder.state.value,
    requestStatus: requestState.status,
  });
  if (!shortcutHeld) {
    return;
  }
  shortcutHeld = false;
  enqueueShortcutAction(async () => {
    if (recorder.isRecording.value) {
      await stopNetworkRecording();
    }
  });
}

function handleShortcutCancel(timestampMs: number) {
  settingsStoreActions.noteShortcutEvent(timestampMs);
  shortcutHeld = false;
  if (!recorder.isBusy.value && !requestState.activeRequestId) {
    return;
  }
  enqueueShortcutAction(cancelNetworkRecording);
}

onMounted(() => {
  void recorder.refreshPermissionState();
  overlaySync.start();
  void subscribeShortcutEvents({
    onCancel: (event) => {
      handleShortcutCancel(event.timestamp_ms);
    },
    onRecordPressed: (event) => {
      handleShortcutPressed(event.timestamp_ms);
    },
    onRecordReleased: (event) => {
      handleShortcutReleased(event.timestamp_ms);
    },
  })
    .then((unlisten) => {
      if (shortcutDisposed) {
        unlisten();
      } else {
        unlistenShortcuts = unlisten;
      }
    })
    .catch(() => {
      // Shortcut initialization reports the platform error in Settings.
    });
});

watch(
  [overlayActive, () => requestState.status],
  ([active]) => {
    overlaySync.syncVisibility(active);
  },
  { immediate: true },
);

watch(
  [
    transcript,
    assistantText,
    () => settingsState.selectedMode,
    () => settingsState.interfaceLocale,
    () => requestState.playbackStatus,
  ],
  () => overlaySync.publish(),
);

onBeforeUnmount(() => {
  shortcutDisposed = true;
  shortcutHeld = false;
  overlaySync.dispose();
  unlistenShortcuts?.();
  unlistenShortcuts = null;
});
</script>

<template>
  <section class="panel recorder-panel" aria-labelledby="recording-title">
    <header class="panel-heading recorder-heading">
      <div>
        <h1 id="recording-title">{{ t("录音控制") }}</h1>
        <p class="panel-description">
          {{
            t("按住 {shortcut} 说话，松开后提交录音。", {
              shortcut: settingsState.shortcutDisplay,
            })
          }}
        </p>
      </div>
      <div class="mode-selector" :aria-label="t('交互模式')">
        <button
          v-for="(label, mode) in VOICE_MODE_LABELS"
          :key="mode"
          type="button"
          :class="{ 'is-active': settingsState.selectedMode === mode }"
          :disabled="Boolean(requestState.activeRequestId)"
          @click="selectMode(mode)"
        >
          {{ t(label) }}
        </button>
      </div>
      <div class="permission-chip" :data-state="recorder.permissionState.value">
        <span class="status-dot"></span>
        {{ t("麦克风") }} {{ permissionLabel }}
      </div>
    </header>

    <div class="panel-body">
      <div class="recording-workspace">
        <div
          class="capture-card"
          :class="{ 'is-recording': recorder.isRecording.value }"
        >
          <div class="recording-state">
            <span class="recording-indicator" aria-hidden="true"></span>
            {{ stateLabel }}
          </div>

          <div class="recording-time" aria-live="polite">
            {{ formattedDuration }}
          </div>

          <AudioMeter :level="recorder.level.value" />

          <div class="recording-actions">
            <button
              v-if="!recorder.isRecording.value"
              class="button button-primary"
              type="button"
              :disabled="!canStart"
              @click="startNetworkRecording()"
            >
              {{
                connectionState.status !== "connected"
                  ? t("等待服务连接")
                  : recorder.state.value === "requesting"
                    ? t("正在授权…")
                    : t("开始录音")
              }}
            </button>
            <button
              v-else
              class="button button-primary button-stop"
              type="button"
              @click="stopNetworkRecording"
            >
              {{ t("停止并生成 WAV") }}
            </button>
            <button
              class="button button-secondary"
              type="button"
              :disabled="!recorder.isBusy.value"
              @click="cancelNetworkRecording"
            >
              {{ t("取消") }}
            </button>
          </div>
        </div>

        <section
          class="transcript-card primary-transcript"
          aria-labelledby="transcript-title"
        >
          <header>
            <strong id="transcript-title">{{ t("识别文本") }}</strong>
            <span v-if="requestState.networkCongested" class="warning-text">
              {{ t("网络拥塞") }}
            </span>
            <span v-else>
              {{
                requestState.asrFinal
                  ? requestState.asrLanguage || t("已完成")
                  : requestState.asrPartial
                    ? `revision ${requestState.asrRevision}`
                    : t("等待录音")
              }}
            </span>
          </header>
          <p :class="{ 'is-partial': !requestState.asrFinal }">
            {{ transcript || t("录音过程中将在这里显示临时识别结果。") }}
          </p>
          <div v-if="requestState.asrFinal" class="transcript-actions">
            <button
              class="button button-secondary button-compact"
              type="button"
              :disabled="
                ['waiting', 'injecting'].includes(requestState.injectionStatus)
              "
              @click="injectManually(requestState.asrFinal)"
            >
              {{ t("切换窗口后注入") }}
            </button>
          </div>
        </section>
      </div>

      <p v-if="recorder.errorMessage.value" class="inline-error" role="alert">
        {{ t(recorder.errorMessage.value) }}
        <button
          v-if="recorder.permissionState.value === 'denied'"
          class="inline-action"
          type="button"
          @click="recorder.openPermissionSettings"
        >
          {{ t("打开麦克风设置") }}
        </button>
      </p>

      <p v-if="requestState.lastError" class="inline-error" role="alert">
        {{ t(requestState.lastError) }}
      </p>

      <section
        v-if="settingsState.selectedMode !== 'dictation'"
        class="transcript-card assistant-card"
        aria-labelledby="assistant-title"
      >
        <header>
          <strong id="assistant-title">{{ t("助手回复") }}</strong>
          <span>
            {{
              requestState.assistantFinal
                ? t("已完成")
                : requestState.assistantStreaming
                  ? t("片段 {count}", { count: requestState.assistantLastSequence + 1 })
                  : requestState.status === "generating"
                    ? t("正在思考")
                    : t("等待识别")
            }}
          </span>
        </header>
        <p :class="{ 'is-partial': !requestState.assistantFinal }">
          {{ assistantText || t("识别完成后将在这里流式显示回复。") }}
        </p>
        <small v-if="requestState.assistantWarning" class="warning-text">
          {{ t(requestState.assistantWarning) }}
        </small>
        <div v-if="requestState.assistantFinal" class="transcript-actions">
          <button
            class="button button-secondary button-compact"
            type="button"
            :disabled="['waiting', 'injecting'].includes(requestState.injectionStatus)"
            @click="injectManually(requestState.assistantFinal)"
          >
            {{ t("切换窗口后注入") }}
          </button>
        </div>
      </section>

      <section
        v-if="
          settingsState.selectedMode !== 'dictation' &&
          requestState.playbackStatus !== 'idle'
        "
        class="playback-card"
        :data-status="requestState.playbackStatus"
        aria-live="polite"
      >
        <div>
          <strong>{{ t("语音播放") }}</strong>
          <span>{{ playbackStatusLabel }}</span>
        </div>
        <dl>
          <div>
            <dt>{{ t("首包至首播") }}</dt>
            <dd>{{ firstPlaybackDelay }}</dd>
          </div>
          <div>
            <dt>{{ t("分片") }}</dt>
            <dd>{{ requestState.playbackMetrics.receivedChunks }}</dd>
          </div>
          <div>
            <dt>{{ t("欠载") }}</dt>
            <dd>{{ requestState.playbackMetrics.underrunCount }}</dd>
          </div>
        </dl>
        <button
          v-if="playbackActive"
          class="button button-secondary button-compact"
          type="button"
          @click="recordingController.interruptPlayback"
        >
          {{ t("停止播放") }}
        </button>
      </section>

      <section
        v-if="requestState.injectionStatus !== 'idle'"
        class="injection-card"
        :data-status="requestState.injectionStatus"
        aria-live="polite"
      >
        <div>
          <strong>{{ injectionStatusLabel }}</strong>
          <span v-if="requestState.injectionReport">
            {{
              t("已注入 {injected} / {requested} 字符，耗时 {elapsed} ms", {
                injected: requestState.injectionReport.injectedCodePoints,
                requested: requestState.injectionReport.requestedCodePoints,
                elapsed: requestState.injectionReport.elapsedMs,
              })
            }}
          </span>
          <span v-if="requestState.injectionError">
            {{ t(requestState.injectionError) }}
          </span>
        </div>
        <p
          v-if="
            requestState.injectionRemainingText &&
            ['partial', 'failed'].includes(requestState.injectionStatus)
          "
        >
          {{ requestState.injectionRemainingText }}
        </p>
        <div class="injection-actions">
          <button
            v-if="
              requestState.injectionRemainingText &&
              ['partial', 'failed'].includes(requestState.injectionStatus)
            "
            class="button button-primary button-compact"
            type="button"
            @click="voiceRequestController.textOutput.retry()"
          >
            {{ t("切换窗口后重试剩余文本") }}
          </button>
          <button
            v-if="!['waiting', 'injecting'].includes(requestState.injectionStatus)"
            class="button button-secondary button-compact"
            type="button"
            @click="voiceRequestController.textOutput.dismiss"
          >
            {{ requestState.injectionRemainingText ? t("放弃待注入文本") : t("关闭") }}
          </button>
        </div>
      </section>

      <div class="metrics-grid">
        <article class="metric-card">
          <span>{{ t("目标格式") }}</span>
          <strong>16 kHz · PCM16</strong>
          <small>{{ t("单声道 / 20 ms 分帧") }}</small>
        </article>
        <article class="metric-card">
          <span>{{ t("已完成录音") }}</span>
          <strong>{{ recorder.completedRecordingCount.value }}</strong>
          <small>{{
            t("当前活动 Track：{count}", { count: recorder.activeTrackCount.value })
          }}</small>
        </article>
        <article class="metric-card">
          <span>{{ t("最近结果") }}</span>
          <strong>
            {{
              recorder.latestRecording.value
                ? t("{count} 帧", { count: recorder.latestRecording.value.frameCount })
                : t("暂无")
            }}
          </strong>
          <small v-if="recorder.latestRecording.value">
            {{
              t("输入 {rate} Hz · {count} samples", {
                rate: recorder.latestRecording.value.sourceSampleRate,
                count: recorder.latestRecording.value.sampleCount,
              })
            }}
          </small>
          <small v-else>{{ t("停止录音后显示统计") }}</small>
        </article>
      </div>

      <footer v-if="recorder.latestRecording.value" class="result-bar">
        <div>
          <strong>{{ t("WAV 已在内存中生成") }}</strong>
          <span>{{ t("导出后可进行离线播放和格式检查") }}</span>
        </div>
        <button
          class="button button-secondary"
          type="button"
          @click="recorder.downloadLatestRecording"
        >
          {{ t("导出 WAV") }}
        </button>
      </footer>
    </div>
  </section>
</template>

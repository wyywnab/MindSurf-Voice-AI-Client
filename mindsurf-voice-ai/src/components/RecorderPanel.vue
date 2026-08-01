<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";

import { useRecorder } from "../composables/useRecorder";
import {
  hideOverlayWindow,
  publishOverlaySnapshot,
  showOverlayWindow,
  subscribeOverlayActions,
} from "../services/overlay";
import {
  reportShortcutEventHandled,
  subscribeShortcutEvents,
} from "../services/shortcuts";
import { prepareTextInjectionTarget } from "../services/textInjection";
import { useVoiceSessionStore } from "../stores/voiceSession";
import type { OverlaySnapshot } from "../types/overlay";
import { VOICE_MODE_LABELS, type VoiceInteractionMode } from "../types/voice";
import AudioMeter from "./AudioMeter.vue";

const recorder = useRecorder();
const session = useVoiceSessionStore();
let shortcutAction = Promise.resolve();
let shortcutDisposed = false;
let shortcutHeld = false;
let unlistenShortcuts: (() => void) | null = null;
let unlistenOverlay: (() => void) | null = null;
let overlayPublishTimer: ReturnType<typeof globalThis.setInterval> | null = null;
let overlayPublishInFlight = false;
let pendingOverlaySnapshot: OverlaySnapshot | null = null;
let overlayHideTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let overlayShown = false;
let recordingAttempt = 0;

const canStart = computed(
  () =>
    session.state.connectionStatus === "connected" &&
    !session.state.activeRequestId &&
    ["idle", "done", "failed"].includes(session.state.requestStatus) &&
    !recorder.isBusy.value,
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

const permissionLabel = computed(
  () =>
    ({
      unknown: "检查中",
      prompt: "等待授权",
      granted: "已授权",
      denied: "已拒绝",
      unsupported: "不支持",
    })[recorder.permissionState.value],
);

const stateLabel = computed(() => {
  if (recorder.state.value === "ready") {
    if (session.state.requestStatus === "committing") {
      return "正在提交录音";
    }
    if (session.state.requestStatus === "recognizing") {
      return "正在等待最终识别";
    }
    if (session.state.requestStatus === "thinking") {
      return "正在生成回复";
    }
    if (session.state.requestStatus === "responding") {
      return "正在接收回复";
    }
    if (session.state.requestStatus === "done") {
      return "识别完成";
    }
  }

  return {
    idle: "准备录音",
    requesting: "正在请求麦克风权限",
    prepared: "麦克风已就绪，正在创建请求",
    recording: "正在录音",
    stopping: "正在处理音频",
    ready: "录音已完成",
    error: "录音不可用",
  }[recorder.state.value];
});

const transcript = computed(() => session.state.asrFinal || session.state.asrPartial);
const assistantText = computed(
  () => session.state.assistantFinal || session.state.assistantStreaming,
);
const playbackActive = computed(() =>
  ["buffering", "playing"].includes(session.state.playbackStatus),
);
const playbackStatusLabel = computed(
  () =>
    ({
      idle: "等待语音",
      buffering: "正在缓冲",
      playing: "正在播放",
      done: "播放完成",
      stopped: "已停止",
      error: "播放失败",
    })[session.state.playbackStatus],
);
const firstPlaybackDelay = computed(() => {
  const { firstChunkAt, playbackStartedAt } = session.state.playbackMetrics;
  return firstChunkAt !== null && playbackStartedAt !== null
    ? `${playbackStartedAt - firstChunkAt} ms`
    : "—";
});
const injectionStatusLabel = computed(
  () =>
    ({
      idle: "",
      waiting: "请切换到目标窗口，稍后开始注入…",
      injecting: "正在向当前前台窗口注入文本…",
      succeeded: "文本注入完成",
      partial: "部分文本未能注入",
      failed: "文本注入失败",
    })[session.state.injectionStatus],
);
const overlayActive = computed(
  () =>
    session.state.overlayEnabled &&
    (recorder.isBusy.value ||
      Boolean(session.state.activeRequestId) ||
      playbackActive.value),
);

function createOverlaySnapshot(): OverlaySnapshot {
  return {
    assistantText: assistantText.value,
    cancellable: recorder.isBusy.value || Boolean(session.state.activeRequestId),
    duration: formattedDuration.value,
    durationMs: recorder.durationMs.value,
    level: recorder.level.value,
    mode: session.state.selectedMode,
    recording: recorder.isRecording.value,
    status:
      session.state.requestStatus === "failed"
        ? "处理失败"
        : playbackActive.value
          ? playbackStatusLabel.value
          : stateLabel.value,
    transcript: transcript.value,
    updatedAtMs: Date.now(),
  };
}

function publishCurrentOverlayState() {
  if (shortcutDisposed) {
    return;
  }
  pendingOverlaySnapshot = createOverlaySnapshot();
  void flushOverlaySnapshot();
}

async function flushOverlaySnapshot() {
  if (overlayPublishInFlight) {
    return;
  }

  overlayPublishInFlight = true;
  try {
    while (pendingOverlaySnapshot && !shortcutDisposed) {
      const snapshot = pendingOverlaySnapshot;
      pendingOverlaySnapshot = null;
      await publishOverlaySnapshot(snapshot);
    }
  } finally {
    overlayPublishInFlight = false;
    if (pendingOverlaySnapshot && !shortcutDisposed) {
      void flushOverlaySnapshot();
    }
  }
}

function clearOverlayHideTimer() {
  if (overlayHideTimer) {
    globalThis.clearTimeout(overlayHideTimer);
    overlayHideTimer = null;
  }
}

function hideOverlayNow() {
  clearOverlayHideTimer();
  overlayShown = false;
  void hideOverlayWindow();
}

function syncOverlayVisibility(active: boolean) {
  clearOverlayHideTimer();
  if (!session.state.overlayEnabled) {
    hideOverlayNow();
    return;
  }

  if (["done", "failed"].includes(session.state.requestStatus)) {
    overlayShown = true;
    publishCurrentOverlayState();
    overlayHideTimer = globalThis.setTimeout(hideOverlayNow, 2_000);
    return;
  }

  if (active) {
    overlayShown = true;
    publishCurrentOverlayState();
    void showOverlayWindow();
    return;
  }

  hideOverlayNow();
}

async function startNetworkRecording(
  shouldContinue: () => boolean = () => true,
  fromGlobalShortcut = false,
) {
  const attempt = ++recordingAttempt;
  if (fromGlobalShortcut) {
    if (session.state.overlayEnabled) {
      overlayShown = true;
      publishCurrentOverlayState();
      await showOverlayWindow();
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 120));
    }
  }
  const prepared = await recorder.prepareRecording();
  if (!prepared || attempt !== recordingAttempt || !shouldContinue()) {
    await recorder.cancelRecording();
    return;
  }

  if (session.state.autoInjection[session.state.selectedMode]) {
    await prepareTextInjectionTarget();
  }

  try {
    await session.beginRequest();
  } catch {
    await recorder.cancelRecording();
    return;
  }

  if (attempt !== recordingAttempt || !shouldContinue()) {
    await recorder.cancelRecording();
    await session.cancelActiveRequest("user_cancelled");
    return;
  }

  const started = await recorder.startRecording({
    onAutoStop: () => {
      void stopNetworkRecording();
    },
    onFrame: (frame, sequence) => {
      session.sendAudioFrame(frame, sequence);
    },
  });

  if (started) {
    session.markRecording();
  } else {
    await session.cancelActiveRequest("user_cancelled");
  }
}

function selectMode(mode: VoiceInteractionMode) {
  session.setMode(mode);
}

function injectManually(text: string) {
  void session.injectText(text, 1_500);
}

async function stopNetworkRecording() {
  const result = await recorder.stopRecording();
  if (!result) {
    await session.cancelActiveRequest("user_cancelled");
    return;
  }

  try {
    await session.commitInput(result);
  } catch {
    // The session store exposes the recoverable error in the UI.
  }
}

async function cancelNetworkRecording() {
  recordingAttempt += 1;
  await recorder.cancelRecording();
  await session.cancelActiveRequest("user_cancelled");
}

function enqueueShortcutAction(action: () => Promise<void>) {
  shortcutAction = shortcutAction.then(action).catch(() => {
    // Recorder and session stores expose actionable errors in the UI.
  });
}

function handleShortcutPressed(timestampMs: number) {
  session.noteShortcutEvent(timestampMs);
  void reportShortcutEventHandled({
    phase: "pressed",
    canStart: canStart.value,
    recorderState: recorder.state.value,
    requestStatus: session.state.requestStatus,
  });
  if (shortcutHeld) {
    return;
  }
  shortcutHeld = true;
  enqueueShortcutAction(async () => {
    if (playbackActive.value) {
      await session.interruptPlayback();
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
  session.noteShortcutEvent(timestampMs);
  void reportShortcutEventHandled({
    phase: "released",
    canStart: canStart.value,
    recorderState: recorder.state.value,
    requestStatus: session.state.requestStatus,
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
  session.noteShortcutEvent(timestampMs);
  shortcutHeld = false;
  if (!recorder.isBusy.value && !session.state.activeRequestId) {
    return;
  }
  enqueueShortcutAction(cancelNetworkRecording);
}

onMounted(() => {
  void recorder.refreshPermissionState();
  overlayPublishTimer = globalThis.setInterval(() => {
    if (overlayShown) {
      publishCurrentOverlayState();
    }
  }, 33);
  void subscribeOverlayActions({
    onCancel: () => {
      if (recorder.isBusy.value || session.state.activeRequestId) {
        enqueueShortcutAction(cancelNetworkRecording);
      }
    },
    onReady: publishCurrentOverlayState,
  })
    .then((unlisten) => {
      if (shortcutDisposed) {
        unlisten();
      } else {
        unlistenOverlay = unlisten;
      }
    })
    .catch(() => {
      // Overlay events are unavailable in a regular browser preview.
    });
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
  [overlayActive, () => session.state.requestStatus],
  ([active]) => {
    syncOverlayVisibility(active);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  shortcutDisposed = true;
  pendingOverlaySnapshot = null;
  shortcutHeld = false;
  clearOverlayHideTimer();
  if (overlayPublishTimer) {
    globalThis.clearInterval(overlayPublishTimer);
    overlayPublishTimer = null;
  }
  overlayShown = false;
  void hideOverlayWindow();
  unlistenOverlay?.();
  unlistenOverlay = null;
  unlistenShortcuts?.();
  unlistenShortcuts = null;
});
</script>

<template>
  <section class="panel recorder-panel" aria-labelledby="recording-title">
    <header class="panel-heading recorder-heading">
      <div>
        <h1 id="recording-title">录音控制</h1>
        <p class="panel-description">
          按住 {{ session.state.shortcutDisplay }} 说话，松开后提交录音。
        </p>
      </div>
      <div class="mode-selector" aria-label="交互模式">
        <button
          v-for="(label, mode) in VOICE_MODE_LABELS"
          :key="mode"
          type="button"
          :class="{ 'is-active': session.state.selectedMode === mode }"
          :disabled="Boolean(session.state.activeRequestId)"
          @click="selectMode(mode)"
        >
          {{ label }}
        </button>
      </div>
      <div class="permission-chip" :data-state="recorder.permissionState.value">
        <span class="status-dot"></span>
        麦克风 {{ permissionLabel }}
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
                session.state.connectionStatus !== "connected"
                  ? "等待服务连接"
                  : recorder.state.value === "requesting"
                    ? "正在授权…"
                    : "开始录音"
              }}
            </button>
            <button
              v-else
              class="button button-primary button-stop"
              type="button"
              @click="stopNetworkRecording"
            >
              停止并生成 WAV
            </button>
            <button
              class="button button-secondary"
              type="button"
              :disabled="!recorder.isBusy.value"
              @click="cancelNetworkRecording"
            >
              取消
            </button>
          </div>
        </div>

        <section
          class="transcript-card primary-transcript"
          aria-labelledby="transcript-title"
        >
          <header>
            <strong id="transcript-title">识别文本</strong>
            <span v-if="session.state.networkCongested" class="warning-text">
              网络拥塞
            </span>
            <span v-else>
              {{
                session.state.asrFinal
                  ? session.state.asrLanguage || "已完成"
                  : session.state.asrPartial
                    ? `revision ${session.state.asrRevision}`
                    : "等待录音"
              }}
            </span>
          </header>
          <p :class="{ 'is-partial': !session.state.asrFinal }">
            {{ transcript || "录音过程中将在这里显示临时识别结果。" }}
          </p>
          <div v-if="session.state.asrFinal" class="transcript-actions">
            <button
              class="button button-secondary button-compact"
              type="button"
              :disabled="
                ['waiting', 'injecting'].includes(session.state.injectionStatus)
              "
              @click="injectManually(session.state.asrFinal)"
            >
              切换窗口后注入
            </button>
          </div>
        </section>
      </div>

      <p v-if="recorder.errorMessage.value" class="inline-error" role="alert">
        {{ recorder.errorMessage }}
        <button
          v-if="recorder.permissionState.value === 'denied'"
          class="inline-action"
          type="button"
          @click="recorder.openPermissionSettings"
        >
          打开麦克风设置
        </button>
      </p>

      <p v-if="session.state.lastError" class="inline-error" role="alert">
        {{ session.state.lastError }}
      </p>

      <section
        v-if="session.state.selectedMode !== 'dictation'"
        class="transcript-card assistant-card"
        aria-labelledby="assistant-title"
      >
        <header>
          <strong id="assistant-title">助手回复</strong>
          <span>
            {{
              session.state.assistantFinal
                ? "已完成"
                : session.state.assistantStreaming
                  ? `片段 ${session.state.assistantLastSequence + 1}`
                  : session.state.requestStatus === "thinking"
                    ? "正在思考"
                    : "等待识别"
            }}
          </span>
        </header>
        <p :class="{ 'is-partial': !session.state.assistantFinal }">
          {{ assistantText || "识别完成后将在这里流式显示回复。" }}
        </p>
        <small v-if="session.state.assistantWarning" class="warning-text">
          {{ session.state.assistantWarning }}
        </small>
        <div v-if="session.state.assistantFinal" class="transcript-actions">
          <button
            class="button button-secondary button-compact"
            type="button"
            :disabled="['waiting', 'injecting'].includes(session.state.injectionStatus)"
            @click="injectManually(session.state.assistantFinal)"
          >
            切换窗口后注入
          </button>
        </div>
      </section>

      <section
        v-if="
          session.state.selectedMode !== 'dictation' &&
          session.state.playbackStatus !== 'idle'
        "
        class="playback-card"
        :data-status="session.state.playbackStatus"
        aria-live="polite"
      >
        <div>
          <strong>语音播放</strong>
          <span>{{ playbackStatusLabel }}</span>
        </div>
        <dl>
          <div>
            <dt>首包至首播</dt>
            <dd>{{ firstPlaybackDelay }}</dd>
          </div>
          <div>
            <dt>分片</dt>
            <dd>{{ session.state.playbackMetrics.receivedChunks }}</dd>
          </div>
          <div>
            <dt>欠载</dt>
            <dd>{{ session.state.playbackMetrics.underrunCount }}</dd>
          </div>
        </dl>
        <button
          v-if="playbackActive"
          class="button button-secondary button-compact"
          type="button"
          @click="session.interruptPlayback"
        >
          停止播放
        </button>
      </section>

      <section
        v-if="session.state.injectionStatus !== 'idle'"
        class="injection-card"
        :data-status="session.state.injectionStatus"
        aria-live="polite"
      >
        <div>
          <strong>{{ injectionStatusLabel }}</strong>
          <span v-if="session.state.injectionReport">
            已注入 {{ session.state.injectionReport.injectedCodePoints }} /
            {{ session.state.injectionReport.requestedCodePoints }} 字符，耗时
            {{ session.state.injectionReport.elapsedMs }} ms
          </span>
          <span v-if="session.state.injectionError">
            {{ session.state.injectionError }}
          </span>
        </div>
        <p
          v-if="
            session.state.injectionRemainingText &&
            ['partial', 'failed'].includes(session.state.injectionStatus)
          "
        >
          {{ session.state.injectionRemainingText }}
        </p>
        <div class="injection-actions">
          <button
            v-if="
              session.state.injectionRemainingText &&
              ['partial', 'failed'].includes(session.state.injectionStatus)
            "
            class="button button-primary button-compact"
            type="button"
            @click="session.retryInjection()"
          >
            切换窗口后重试剩余文本
          </button>
          <button
            v-if="!['waiting', 'injecting'].includes(session.state.injectionStatus)"
            class="button button-secondary button-compact"
            type="button"
            @click="session.dismissInjectionResult"
          >
            {{ session.state.injectionRemainingText ? "放弃待注入文本" : "关闭" }}
          </button>
        </div>
      </section>

      <div class="metrics-grid">
        <article class="metric-card">
          <span>目标格式</span>
          <strong>16 kHz · PCM16</strong>
          <small>单声道 / 20 ms 分帧</small>
        </article>
        <article class="metric-card">
          <span>已完成录音</span>
          <strong>{{ recorder.completedRecordingCount.value }}</strong>
          <small>当前活动 Track：{{ recorder.activeTrackCount.value }}</small>
        </article>
        <article class="metric-card">
          <span>最近结果</span>
          <strong>
            {{
              recorder.latestRecording.value
                ? `${recorder.latestRecording.value.frameCount} 帧`
                : "暂无"
            }}
          </strong>
          <small v-if="recorder.latestRecording.value">
            输入 {{ recorder.latestRecording.value.sourceSampleRate }} Hz ·
            {{ recorder.latestRecording.value.sampleCount }} samples
          </small>
          <small v-else>停止录音后显示统计</small>
        </article>
      </div>

      <footer v-if="recorder.latestRecording.value" class="result-bar">
        <div>
          <strong>WAV 已在内存中生成</strong>
          <span>导出后可进行离线播放和格式检查</span>
        </div>
        <button
          class="button button-secondary"
          type="button"
          @click="recorder.downloadLatestRecording"
        >
          导出 WAV
        </button>
      </footer>
    </div>
  </section>
</template>

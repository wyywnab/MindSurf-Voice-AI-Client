<script setup lang="ts">
import { isTauri } from "@tauri-apps/api/core";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

import { getNativeAudioRecordingMeter } from "./services/nativeRecorder";
import { setLocale, useI18n } from "./services/i18n";
import {
  notifyOverlayReady,
  requestOverlayCancel,
  subscribeOverlayState,
} from "./services/overlay";
import type { OverlaySnapshot } from "./types/overlay";
import { VOICE_MODE_LABELS } from "./types/voice";

const { t } = useI18n();

const snapshot = reactive<OverlaySnapshot>({
  assistantText: "",
  cancellable: false,
  duration: "00:00.0",
  durationMs: 0,
  level: 0,
  locale: "zh-CN",
  mode: "dictation",
  recording: false,
  status: "准备录音",
  transcript: "",
  updatedAtMs: Date.now(),
});
const displayedDurationMs = ref(0);
const displayedLevel = ref(0);
const nativeRecordingActive = ref(false);
const usesNativeMeter =
  isTauri() && /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? "");
let disposed = false;
let animationFrame: number | null = null;
let durationBaseAt = globalThis.performance.now();
let durationBaseMs = 0;
let lastAnimationAt = globalThis.performance.now();
let levelPollTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
let targetLevel = 0;
let unlisten: (() => void) | null = null;

const displayText = computed(
  () => snapshot.assistantText || snapshot.transcript || t("正在等待语音输入…"),
);
const displayedDuration = computed(() => formatDuration(displayedDurationMs.value));
const meterWidth = computed(() => `${Math.max(4, displayedLevel.value * 100)}%`);

function formatDuration(durationMs: number) {
  const totalSeconds = durationMs / 1_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const tenths = Math.floor((totalSeconds % 1) * 10);
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}.${tenths}`;
}

function updateLocalSnapshot(next: OverlaySnapshot) {
  setLocale(next.locale);
  Object.assign(snapshot, next);
  if (!usesNativeMeter || !nativeRecordingActive.value) {
    const deliveryDelayMs = next.recording
      ? Math.max(0, Date.now() - next.updatedAtMs)
      : 0;
    durationBaseMs = next.durationMs + deliveryDelayMs;
    durationBaseAt = globalThis.performance.now();
    displayedDurationMs.value = durationBaseMs;
  }
  if (!usesNativeMeter) {
    targetLevel = next.recording ? next.level : 0;
  }
}

function animate(now: number) {
  if (disposed) {
    animationFrame = null;
    return;
  }
  const elapsedMs = Math.min(100, Math.max(0, now - lastAnimationAt));
  lastAnimationAt = now;
  const recording = usesNativeMeter ? nativeRecordingActive.value : snapshot.recording;
  if (recording) {
    displayedDurationMs.value = durationBaseMs + (now - durationBaseAt);
  }

  const smoothingMs = targetLevel > displayedLevel.value ? 45 : 90;
  const blend = 1 - Math.exp(-elapsedMs / smoothingMs);
  displayedLevel.value += (targetLevel - displayedLevel.value) * blend;
  if (!recording && displayedLevel.value < 0.001) {
    displayedLevel.value = 0;
  }
  animationFrame = globalThis.requestAnimationFrame(animate);
}

async function pollNativeMeter() {
  if (disposed || !usesNativeMeter) {
    return;
  }
  const meter = await getNativeAudioRecordingMeter();
  if (disposed) {
    return;
  }
  if (meter !== null) {
    const wasActive = nativeRecordingActive.value;
    nativeRecordingActive.value = meter.active;
    targetLevel = meter.active ? meter.level : 0;
    if (meter.active) {
      durationBaseMs = meter.durationMs;
      durationBaseAt = globalThis.performance.now();
      displayedDurationMs.value = durationBaseMs;
    } else if (wasActive) {
      displayedDurationMs.value =
        durationBaseMs + (globalThis.performance.now() - durationBaseAt);
    }
  }
  levelPollTimer = globalThis.setTimeout(
    pollNativeMeter,
    nativeRecordingActive.value ? 33 : 100,
  );
}

onMounted(() => {
  lastAnimationAt = globalThis.performance.now();
  animationFrame = globalThis.requestAnimationFrame(animate);
  if (usesNativeMeter) {
    void pollNativeMeter();
  }
  void subscribeOverlayState((next) => {
    updateLocalSnapshot(next);
  }).then((stop) => {
    if (disposed) {
      stop();
    } else {
      unlisten = stop;
      void notifyOverlayReady();
    }
  });
});

onBeforeUnmount(() => {
  disposed = true;
  if (animationFrame !== null) {
    globalThis.cancelAnimationFrame(animationFrame);
    animationFrame = null;
  }
  if (levelPollTimer) {
    globalThis.clearTimeout(levelPollTimer);
    levelPollTimer = null;
  }
  unlisten?.();
});
</script>

<template>
  <main class="voice-overlay" :data-active="snapshot.cancellable">
    <div class="overlay-status">
      <span class="overlay-status-dot" aria-hidden="true"></span>
      <strong>{{ t(snapshot.status) }}</strong>
      <span>{{ t(VOICE_MODE_LABELS[snapshot.mode]) }}</span>
      <time>{{ displayedDuration }}</time>
    </div>

    <p :title="displayText">{{ displayText }}</p>

    <div class="overlay-footer">
      <div class="overlay-meter" :aria-label="t('输入音量')">
        <span :style="{ width: meterWidth }"></span>
      </div>
      <button v-if="snapshot.cancellable" type="button" @click="requestOverlayCancel">
        {{ t("取消") }}
      </button>
    </div>
  </main>
</template>

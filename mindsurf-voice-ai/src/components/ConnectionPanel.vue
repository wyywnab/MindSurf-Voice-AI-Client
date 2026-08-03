<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { voiceRequestController } from "../controllers/voiceRequestController";
import { calculateTimelineMetrics } from "../services/diagnostics/timeline";
import { useI18n } from "../services/i18n";
import { showConfirm } from "../services/systemDialog";
import { useConnectionStore } from "../stores/connectionStore";
import {
  diagnosticsStoreActions,
  useDiagnosticsStore,
} from "../stores/diagnosticsStore";
import { useSettingsStore } from "../stores/settingsStore";
import type { LogLevel } from "../types/diagnostics";
import { VOICE_MODE_LABELS } from "../types/voice";
import ConnectionBadge from "./ConnectionBadge.vue";

const connection = useConnectionStore();
const { t } = useI18n();
const diagnostics = useDiagnosticsStore();
const settings = useSettingsStore();
const connectionLabel = computed(() => t(connection.connectionLabel.value));
const selectedRequestId = ref("");
const logLevel = ref<LogLevel | "all">("all");
const logModule = ref("all");
const logRequestId = ref("");
const logFrom = ref("");
const logTo = ref("");

const timeline = computed(() => {
  if (selectedRequestId.value) {
    return (
      diagnostics.state.timelines.find(
        (item) => item.requestId === selectedRequestId.value,
      ) ?? null
    );
  }
  return diagnostics.currentTimeline.value;
});
const metrics = computed(() =>
  timeline.value ? calculateTimelineMetrics(timeline.value) : [],
);
const logModules = computed(() => [
  ...new Set(diagnostics.state.logs.map((entry) => entry.module)),
]);
const filteredLogs = computed(() =>
  diagnostics.state.logs.filter(
    (entry) =>
      (logLevel.value === "all" || entry.level === logLevel.value) &&
      (logModule.value === "all" || entry.module === logModule.value) &&
      (!logRequestId.value || entry.requestId?.includes(logRequestId.value)) &&
      (!logFrom.value || entry.timestampMs >= new Date(logFrom.value).getTime()) &&
      (!logTo.value || entry.timestampMs <= new Date(logTo.value).getTime()),
  ),
);

function relativeTime(monotonicMs: number) {
  const start = timeline.value?.events[0]?.monotonicMs ?? monotonicMs;
  return `+${Math.max(0, monotonicMs - start).toFixed(0)} ms`;
}

function formatClock(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString(settings.state.interfaceLocale, {
    hour12: false,
  });
}

function formatFields(fields: Record<string, unknown> | undefined) {
  return fields ? JSON.stringify(fields) : "";
}

function serviceOrigin(value: string) {
  try {
    return new globalThis.URL(value).origin;
  } catch {
    return "<invalid-url>";
  }
}

async function confirmExport() {
  const confirmed = await showConfirm(
    t(
      "诊断包将包含应用信息、脱敏后的服务地址、请求时间线和轮转日志；不会包含 Token、完整转录、完整回复或音频。确认导出？",
    ),
    { title: t("导出诊断包"), kind: "warning", confirmLabel: t("导出") },
  );
  if (confirmed) {
    await diagnosticsStoreActions.export({
      activeServiceProfileId: settings.state.activeServiceProfileId,
      serviceProfiles: settings.state.serviceProfiles.map((profile) => ({
        ...profile,
        websocketUrl: serviceOrigin(profile.websocketUrl),
      })),
      audio: {
        inputDeviceConfigured: Boolean(settings.state.inputDeviceId),
        language: settings.state.language,
        audioResponseEnabled: settings.state.audioResponseEnabled,
        playbackVolume: settings.state.playbackVolume,
      },
    });
  }
}

function selectLogRequest(requestId: string | undefined) {
  if (!requestId) return;
  selectedRequestId.value = requestId;
}

async function clearLogs() {
  if (
    await showConfirm(t("确认清空全部本地运行日志？"), {
      title: t("清空运行日志"),
      kind: "warning",
      confirmLabel: t("清空"),
    })
  ) {
    await diagnosticsStoreActions.clearLogs();
  }
}

onMounted(() => void diagnosticsStoreActions.refreshLogs());
</script>

<template>
  <section class="panel diagnostics-panel" aria-labelledby="diagnostics-title">
    <header class="panel-heading">
      <div>
        <h1 id="diagnostics-title">{{ t("连接与诊断") }}</h1>
        <p class="panel-description">
          {{ t("查看服务状态、请求时间线和脱敏运行日志。") }}
        </p>
      </div>
      <ConnectionBadge :status="connection.state.status" />
    </header>

    <div class="panel-body diagnostics-body">
      <section class="diagnostics-section" aria-labelledby="service-status-title">
        <div class="section-title-row">
          <h2 id="service-status-title">{{ t("服务状态") }}</h2>
          <button
            v-if="
              connection.state.status === 'disconnected' && !connection.state.lastError
            "
            class="button button-secondary"
            type="button"
            @click="voiceRequestController.connectConfiguredService()"
          >
            {{ t("连接服务") }}
          </button>
        </div>
        <div class="connection-grid">
          <article class="detail-card">
            <span class="detail-label">{{ t("服务地址") }}</span>
            <code>{{ settings.state.serviceUrl }}</code>
          </article>
          <article class="detail-card">
            <span class="detail-label">{{ t("协议状态") }}</span>
            <strong v-if="connection.state.serverHello">
              v{{ connection.state.serverHello.protocol_version }} ·
              {{ connection.state.serverHello.pipeline }}
            </strong>
            <strong v-else>{{ connectionLabel }}</strong>
          </article>
          <article class="detail-card">
            <span class="detail-label">{{ t("会话") }}</span>
            <strong>{{
              connection.state.serverHello?.session_id ?? t("尚未建立")
            }}</strong>
          </article>
          <article class="detail-card">
            <span class="detail-label">{{ t("重连次数") }}</span>
            <strong>{{ connection.state.reconnectAttempt }}</strong>
          </article>
        </div>
        <div v-if="connection.state.lastError" class="connection-error">
          <span>{{ t(connection.state.lastError) }}</span>
          <button
            class="button button-secondary"
            type="button"
            @click="
              connection.state.status === 'disconnected'
                ? voiceRequestController.connectConfiguredService()
                : voiceRequestController.retryConnection()
            "
          >
            {{ t("立即重试") }}
          </button>
        </div>
      </section>

      <section class="diagnostics-section" aria-labelledby="timeline-title">
        <div class="section-title-row">
          <div>
            <h2 id="timeline-title">{{ t("请求时间线") }}</h2>
            <small>{{ t("最多保留最近 20 次请求，不记录正文或音频。") }}</small>
          </div>
          <select v-model="selectedRequestId" :aria-label="t('选择请求')">
            <option value="">{{ t("当前或最近一次请求") }}</option>
            <option
              v-for="item in diagnostics.state.timelines"
              :key="item.requestId"
              :value="item.requestId"
            >
              {{ item.requestId.slice(0, 12) }} · {{ t(VOICE_MODE_LABELS[item.mode]) }}
            </option>
          </select>
        </div>

        <div v-if="timeline" class="timeline-summary">
          <span
            ><b>{{ t("请求") }}</b> {{ timeline.requestId }}</span
          >
          <span
            ><b>{{ t("模式") }}</b> {{ t(VOICE_MODE_LABELS[timeline.mode]) }}</span
          >
          <span
            ><b>{{ t("录音") }}</b> {{ timeline.recordingDurationMs ?? "—" }} ms</span
          >
          <span
            ><b>{{ t("终态") }}</b> {{ timeline.terminalState ?? t("进行中") }}</span
          >
          <span
            ><b>{{ t("上行") }}</b> {{ timeline.audioFramesSent }} {{ t("帧") }} /
            {{ timeline.audioBytesSent }} B</span
          >
          <span
            ><b>{{ t("下行") }}</b> {{ timeline.audioChunksReceived }}
            {{ t("分片") }}</span
          >
          <span><b>Underrun</b> {{ timeline.underrunCount }}</span>
          <span
            ><b>{{ t("重连") }}</b> {{ timeline.reconnectCount }}</span
          >
        </div>
        <div v-if="metrics.length" class="metric-strip">
          <span v-for="metric in metrics" :key="metric.label">
            {{ t(metric.label) }} <b>{{ metric.durationMs.toFixed(0) }} ms</b>
          </span>
        </div>
        <ol v-if="timeline" class="timeline-list">
          <li v-for="event in timeline.events" :key="event.type">
            <time>{{ relativeTime(event.monotonicMs) }}</time>
            <span class="timeline-dot" :data-stage="event.stage"></span>
            <div>
              <strong>{{ t(event.summary) }}</strong>
              <code>{{ event.type }}</code>
              <small v-if="event.details">{{ formatFields(event.details) }}</small>
            </div>
          </li>
        </ol>
        <p v-else class="empty-state">
          {{ t("完成一次语音请求后，这里会显示关键节点和耗时。") }}
        </p>
      </section>

      <section class="diagnostics-section" aria-labelledby="logs-title">
        <div class="section-title-row">
          <div>
            <h2 id="logs-title">{{ t("运行日志") }}</h2>
            <small>{{ t("日志按 5 MiB 轮转，最多保留 5 个文件。") }}</small>
          </div>
          <button
            class="button button-secondary"
            type="button"
            :disabled="diagnostics.state.exportStatus === 'exporting'"
            @click="confirmExport"
          >
            {{
              diagnostics.state.exportStatus === "exporting"
                ? t("正在导出")
                : t("导出诊断包")
            }}
          </button>
        </div>
        <div class="log-filters">
          <select v-model="logLevel" :aria-label="t('日志级别')">
            <option value="all">{{ t("全部级别") }}</option>
            <option value="debug">Debug</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
          <select v-model="logModule" :aria-label="t('日志模块')">
            <option value="all">{{ t("全部模块") }}</option>
            <option v-for="module in logModules" :key="module" :value="module">
              {{ module }}
            </option>
          </select>
          <input v-model.trim="logRequestId" :placeholder="t('筛选 request ID')" />
          <input
            v-model="logFrom"
            type="datetime-local"
            :aria-label="t('日志开始时间')"
          />
          <input
            v-model="logTo"
            type="datetime-local"
            :aria-label="t('日志结束时间')"
          />
          <button
            class="button button-ghost"
            type="button"
            @click="diagnosticsStoreActions.refreshLogs()"
          >
            {{ t("刷新") }}
          </button>
          <button
            class="button button-ghost"
            type="button"
            @click="diagnosticsStoreActions.openLogDirectory()"
          >
            {{ t("打开目录") }}
          </button>
          <button class="button button-ghost" type="button" @click="clearLogs">
            {{ t("清空日志") }}
          </button>
        </div>
        <p v-if="diagnostics.state.storageWarning" class="inline-warning">
          {{ t(diagnostics.state.storageWarning) }}
        </p>
        <p v-if="diagnostics.state.exportPath" class="inline-success">
          {{ t("已导出到 {path}", { path: diagnostics.state.exportPath }) }}
        </p>
        <p v-if="diagnostics.state.exportError" class="inline-warning">
          {{ t(diagnostics.state.exportError) }}
        </p>
        <div class="log-list">
          <article
            v-for="(entry, index) in filteredLogs"
            :key="`${entry.timestampMs}-${index}`"
          >
            <time>{{ formatClock(entry.timestampMs) }}</time>
            <span class="log-level" :data-level="entry.level">{{ entry.level }}</span>
            <code>{{ entry.module }}.{{ entry.event }}</code>
            <span>{{ t(entry.message) }}</span>
            <button
              v-if="entry.requestId"
              class="log-request-link"
              type="button"
              @click="selectLogRequest(entry.requestId)"
            >
              {{ entry.requestId }}
            </button>
          </article>
          <p v-if="!filteredLogs.length" class="empty-state">
            {{ t("没有符合筛选条件的日志。") }}
          </p>
        </div>
        <button
          v-if="!diagnostics.state.logsExhausted"
          class="button button-ghost"
          type="button"
          :disabled="diagnostics.state.logsLoading"
          @click="diagnosticsStoreActions.loadOlderLogs()"
        >
          {{ t("加载更早日志") }}
        </button>
      </section>
    </div>
  </section>
</template>

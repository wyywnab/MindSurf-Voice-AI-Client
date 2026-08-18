<script setup lang="ts">
import { computed, ref, watch } from "vue";

import { voiceRequestControllerV2 } from "../controllers/voiceRequestControllerV2";
import { useI18n } from "../services/i18n";
import { showConfirm } from "../services/systemDialog";
import { toast } from "../services/toast";
import { useAccountStore } from "../stores/accountStore";
import { historyStoreActions, useHistoryStore } from "../stores/historyStore";
import { useRequestStore } from "../stores/requestStore";
import { useSettingsStore } from "../stores/settingsStore";
import type {
  RecognitionHistoryEntry,
  RecognitionHistoryModeFilter,
} from "../types/history";
import { VOICE_MODE_LABELS } from "../types/voice";

const { t } = useI18n();
const account = useAccountStore().state;
const history = useHistoryStore().state;
const request = useRequestStore().state;
const settings = useSettingsStore().state;
const query = ref("");
const mode = ref<RecognitionHistoryModeFilter>("all");
const selectedId = ref("");
const feedback = ref("");
const actionBusy = ref(false);

const selectedEntry = computed(
  () => history.entries.find((entry) => entry.id === selectedId.value) ?? null,
);
const filteredEntries = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase(settings.interfaceLocale);
  return history.entries.filter(
    (entry) =>
      (mode.value === "all" || entry.mode === mode.value) &&
      (!needle ||
        entry.resultText.toLocaleLowerCase(settings.interfaceLocale).includes(needle) ||
        entry.sourceText?.toLocaleLowerCase(settings.interfaceLocale).includes(needle)),
  );
});
const groupedEntries = computed(() => {
  const groups: Array<{
    key: string;
    label: string;
    entries: RecognitionHistoryEntry[];
  }> = [];
  for (const entry of filteredEntries.value) {
    const date = new Date(entry.completedAtMs);
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const current = groups[groups.length - 1];
    if (current?.key === key) current.entries.push(entry);
    else groups.push({ key, label: dateLabel(date), entries: [entry] });
  }
  return groups;
});

watch(
  () => account.user?.user_id,
  (userId) => {
    selectedId.value = "";
    feedback.value = "";
    if (userId) void historyStoreActions.load(userId);
    else historyStoreActions.reset();
  },
  { immediate: true },
);

function dateLabel(date: Date) {
  const today = new Date();
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  ).getTime();
  const target = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const days = Math.round((start - target) / 86_400_000);
  if (days === 0) return t("今天");
  if (days === 1) return t("昨天");
  return date.toLocaleDateString(settings.interfaceLocale, {
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
    month: "long",
    day: "numeric",
  });
}

function timeLabel(timestampMs: number) {
  return new Date(timestampMs).toLocaleTimeString(settings.interfaceLocale, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function durationLabel(durationMs: number) {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
    : `${seconds} ${t("秒")}`;
}

async function copyEntry(entry: RecognitionHistoryEntry) {
  feedback.value = "";
  try {
    await globalThis.navigator.clipboard.writeText(entry.resultText);
    feedback.value = t("已复制到剪贴板");
    toast.success(feedback.value);
  } catch {
    feedback.value = t("复制失败");
    toast.error(feedback.value, { durationMs: 0 });
  }
}

async function injectEntry(entry: RecognitionHistoryEntry) {
  if (request.activeRequestId || actionBusy.value) return;
  actionBusy.value = true;
  feedback.value = t("请切换到目标窗口，稍后开始注入…");
  try {
    await voiceRequestControllerV2.textOutput.prepareTarget();
    await voiceRequestControllerV2.textOutput.output(
      entry.resultText,
      1_500,
      settings.injectionMaxCodePoints,
    );
    feedback.value =
      request.injectionStatus === "succeeded"
        ? t("文本注入完成")
        : request.injectionError || t("文本注入失败");
  } catch (error) {
    feedback.value = error instanceof Error ? error.message : t("文本注入失败");
    toast.error(feedback.value, { title: t("文本注入失败"), durationMs: 0 });
  } finally {
    actionBusy.value = false;
  }
}

async function removeEntry(entry: RecognitionHistoryEntry) {
  const userId = account.user?.user_id;
  if (!userId || actionBusy.value) return;
  if (
    !(await showConfirm(t("确认删除这条识别历史？"), {
      title: t("删除识别历史"),
      kind: "warning",
      confirmLabel: t("删除"),
    }))
  ) {
    return;
  }
  actionBusy.value = true;
  if (await historyStoreActions.remove(userId, entry.id)) {
    selectedId.value = "";
    feedback.value = t("识别历史已删除");
    toast.success(feedback.value);
  } else {
    feedback.value = history.error || t("无法读写识别历史");
    toast.error(feedback.value, { title: t("删除失败"), durationMs: 0 });
  }
  actionBusy.value = false;
}

async function clearHistory() {
  const userId = account.user?.user_id;
  if (!userId || history.entries.length === 0 || actionBusy.value) return;
  if (
    !(await showConfirm(t("确认清空当前账户的全部识别历史？此操作不可恢复。"), {
      title: t("清空识别历史"),
      kind: "warning",
      confirmLabel: t("清空"),
    }))
  ) {
    return;
  }
  actionBusy.value = true;
  if (await historyStoreActions.clearUser(userId)) {
    selectedId.value = "";
    feedback.value = t("识别历史已清空");
    toast.success(feedback.value);
  } else {
    feedback.value = history.error || t("无法读写识别历史");
    toast.error(feedback.value, { title: t("清空失败"), durationMs: 0 });
  }
  actionBusy.value = false;
}
</script>

<template>
  <section class="panel history-panel" aria-labelledby="history-title">
    <header class="panel-heading">
      <div>
        <h1 id="history-title">
          {{ selectedEntry ? t("历史详情") : t("识别历史") }}
        </h1>
        <p class="panel-description">
          {{ t("成功结果以本地明文保存在当前设备，不包含音频。") }}
        </p>
      </div>
      <button
        v-if="selectedEntry"
        class="button button-secondary button-compact"
        type="button"
        @click="selectedId = ''"
      >
        {{ t("返回") }}
      </button>
      <button
        v-else
        class="button button-secondary button-compact"
        type="button"
        :disabled="history.entries.length === 0 || history.mutating || actionBusy"
        @click="clearHistory"
      >
        {{ t("清空历史") }}
      </button>
    </header>

    <div v-if="selectedEntry" class="panel-body history-detail">
      <div class="history-detail-meta">
        <span class="history-mode">{{ t(VOICE_MODE_LABELS[selectedEntry.mode]) }}</span>
        <time>{{ new Date(selectedEntry.completedAtMs).toLocaleString() }}</time>
        <span>{{ durationLabel(selectedEntry.durationMs) }}</span>
        <span>{{ selectedEntry.language }}</span>
      </div>
      <section v-if="selectedEntry.sourceText" class="history-text-card">
        <h2>{{ t("识别原文") }}</h2>
        <p>{{ selectedEntry.sourceText }}</p>
      </section>
      <section class="history-text-card">
        <h2>{{ t(selectedEntry.mode === "asr_llm" ? "润色结果" : "识别结果") }}</h2>
        <p>{{ selectedEntry.resultText }}</p>
      </section>
      <div class="history-detail-actions">
        <button
          class="button button-secondary"
          type="button"
          @click="copyEntry(selectedEntry)"
        >
          {{ t("复制") }}
        </button>
        <button
          class="button button-primary"
          type="button"
          :disabled="Boolean(request.activeRequestId) || actionBusy"
          @click="injectEntry(selectedEntry)"
        >
          {{ actionBusy ? t("处理中…") : t("重新注入") }}
        </button>
        <button
          class="button button-danger"
          type="button"
          :disabled="actionBusy"
          @click="removeEntry(selectedEntry)"
        >
          {{ t("删除") }}
        </button>
      </div>
    </div>

    <div v-else class="panel-body history-body">
      <div class="history-toolbar">
        <input v-model="query" type="search" :placeholder="t('搜索识别历史')" />
        <select v-model="mode">
          <option value="all">{{ t("全部模式") }}</option>
          <option value="asr_only">{{ t("识别") }}</option>
          <option value="asr_llm">{{ t("润色") }}</option>
        </select>
      </div>

      <p v-if="!account.user" class="history-empty">{{ t("登录后查看识别历史") }}</p>
      <p v-else-if="history.loading" class="history-empty">{{ t("正在加载…") }}</p>
      <p v-else-if="history.error" class="inline-error">{{ t(history.error) }}</p>
      <p v-else-if="filteredEntries.length === 0" class="history-empty">
        {{ query || mode !== "all" ? t("没有匹配的识别历史") : t("暂无识别历史") }}
      </p>

      <section v-for="group in groupedEntries" :key="group.key" class="history-group">
        <h2>{{ group.label }}</h2>
        <button
          v-for="entry in group.entries"
          :key="entry.id"
          class="history-row"
          type="button"
          @click="selectedId = entry.id"
        >
          <span class="history-row-meta">
            <time>{{ timeLabel(entry.completedAtMs) }}</time>
            <span class="history-mode">{{ t(VOICE_MODE_LABELS[entry.mode]) }}</span>
            <span>{{ durationLabel(entry.durationMs) }}</span>
          </span>
          <span class="history-preview">{{ entry.resultText || t("空结果") }}</span>
        </button>
      </section>
    </div>

    <p v-if="feedback" class="history-feedback" aria-live="polite">{{ feedback }}</p>
  </section>
</template>

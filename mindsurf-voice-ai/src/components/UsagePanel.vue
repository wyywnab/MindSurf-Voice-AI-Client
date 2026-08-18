<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { authController } from "../controllers/authController";
import {
  dailyUsageCells,
  monthMarkers,
  usageRange,
  weeklyUsageCells,
  type UsageView,
} from "../services/usageAggregation";
import { useQuotaStore } from "../stores/quotaStore";
import { toast } from "../services/toast";
import type { UsageEntry } from "../types/httpApi";

const emit = defineEmits<{ close: [] }>();
const quota = useQuotaStore().state;
const entries = ref<UsageEntry[]>([]);
const loading = ref(false);
const error = ref("");
const view = ref<UsageView>("daily");
const range = usageRange();

const dailyCells = computed(() => dailyUsageCells(entries.value, range.start));
const visibleCells = computed(() =>
  view.value === "daily"
    ? dailyCells.value
    : weeklyUsageCells(dailyCells.value, view.value === "cumulative"),
);
const markers = monthMarkers(range.start);
const requestCount = computed(() => entries.value.length);
const tokenCount = computed(() =>
  entries.value.reduce(
    (sum, item) => sum + item.llm_input_tokens + item.llm_output_tokens,
    0,
  ),
);
const audioMs = computed(() =>
  entries.value.reduce((sum, item) => sum + item.input_audio_ms, 0),
);
const periodLabel = computed(() => {
  const period = quota.quota?.period;
  if (!period) return "—";
  return `${new Date(period.starts_at_ms).toLocaleDateString()} – ${new Date(period.ends_at_ms).toLocaleDateString()}`;
});
const summary = computed(() => [
  { value: compact(quota.quota?.credits.limit), label: "本期总额度" },
  { value: compact(quota.quota?.credits.used), label: "已用额度" },
  { value: compact(quota.quota?.credits.remaining), label: "剩余额度" },
  { value: requestCount.value.toLocaleString(), label: "请求次数" },
  { value: compact(tokenCount.value), label: "文本 Tokens" },
]);

async function load(notify = false) {
  loading.value = true;
  error.value = "";
  try {
    await authController.refreshAccount();
    entries.value = await authController.listUsage(range.fromMs, range.toMs);
    if (notify) toast.success("额度和用量数据已刷新");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "用量数据加载失败";
    if (notify) toast.error(error.value, { title: "用量刷新失败", durationMs: 0 });
  } finally {
    loading.value = false;
  }
}

function compact(value: number | undefined) {
  if (value === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function duration(value: number) {
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor((value % 60_000) / 1_000);
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

onMounted(() => void load());
</script>

<template>
  <section class="panel usage-panel" aria-labelledby="usage-title">
    <header class="usage-heading">
      <div>
        <h1 id="usage-title">用量</h1>
        <p class="panel-description">查看额度余额与最近一年的 Voice API 消耗。</p>
      </div>
      <div class="usage-period">
        <span>{{ periodLabel }}</span>
        <button
          class="button button-secondary button-compact"
          :disabled="loading"
          @click="load(true)"
        >
          {{ loading ? "刷新中…" : "刷新" }}
        </button>
        <button class="button button-secondary button-compact" @click="emit('close')">
          返回
        </button>
      </div>
    </header>

    <div class="panel-body usage-body">
      <div class="usage-summary" aria-label="用量摘要">
        <article v-for="item in summary" :key="item.label">
          <strong>{{ item.value }}</strong>
          <span>{{ item.label }}</span>
        </article>
      </div>

      <div class="usage-detail-line">
        <span>语音输入 {{ duration(audioMs) }}</span>
        <span>ASR {{ compact(quota.quota?.usage.asr_credits_charged) }} credits</span>
        <span>LLM {{ compact(quota.quota?.usage.llm_credits_charged) }} credits</span>
      </div>

      <p v-if="error" class="inline-error">{{ error }}</p>

      <section class="activity-card" aria-labelledby="activity-title">
        <header>
          <h2 id="activity-title">额度活动</h2>
          <div class="usage-view-switch" aria-label="聚合方式">
            <button :class="{ 'is-active': view === 'daily' }" @click="view = 'daily'">
              按日
            </button>
            <button
              :class="{ 'is-active': view === 'weekly' }"
              @click="view = 'weekly'"
            >
              按周
            </button>
            <button
              :class="{ 'is-active': view === 'cumulative' }"
              @click="view = 'cumulative'"
            >
              累计
            </button>
          </div>
        </header>

        <div
          class="usage-heatmap"
          :class="{ 'is-weekly': view !== 'daily' }"
          :aria-label="view === 'daily' ? '每日额度活动热力图' : '每周额度活动热力图'"
        >
          <span
            v-for="cell in visibleCells"
            :key="cell.key"
            class="usage-cell"
            :class="[`level-${cell.level}`, { 'is-future': cell.future }]"
            :title="cell.label"
          />
        </div>
        <div class="usage-months" aria-hidden="true">
          <span
            v-for="marker in markers"
            :key="`${marker.label}-${marker.column}`"
            :style="{ gridColumn: marker.column }"
            >{{ marker.label }}</span
          >
        </div>
        <p v-if="!loading && entries.length === 0" class="usage-empty">
          当前查询区间还没有已结算的用量记录。
        </p>
      </section>
    </div>
  </section>
</template>

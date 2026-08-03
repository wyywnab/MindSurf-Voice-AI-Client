<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "../services/i18n";

const { t } = useI18n();

const props = defineProps<{
  level: number;
}>();

const normalizedLevel = computed(() =>
  Math.round(Math.max(0, Math.min(1, props.level)) * 100),
);
const meterStyle = computed(() => ({
  "--meter-scale": Math.max(0.14, normalizedLevel.value / 100).toString(),
}));
</script>

<template>
  <div
    class="audio-meter"
    role="meter"
    :aria-label="t('麦克风音量')"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuenow="normalizedLevel"
    :style="meterStyle"
  >
    <span v-for="bar in 24" :key="bar" class="audio-meter-bar"></span>
  </div>
</template>

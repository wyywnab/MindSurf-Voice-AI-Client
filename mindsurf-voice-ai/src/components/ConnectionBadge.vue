<script setup lang="ts">
import { computed } from "vue";

import { CONNECTION_STATUS_LABELS, type ServiceConnectionStatus } from "../types/voice";
import { useI18n } from "../services/i18n";

const props = defineProps<{
  status: ServiceConnectionStatus;
  interactive?: boolean;
}>();

const emit = defineEmits<{
  retry: [];
}>();

const { t } = useI18n();
const label = computed(() => t(CONNECTION_STATUS_LABELS[props.status]));
</script>

<template>
  <button
    v-if="interactive"
    class="connection-badge connection-badge-button"
    type="button"
    :data-status="status"
    :title="t('立即重试')"
    @click="emit('retry')"
  >
    <span class="connection-dot" aria-hidden="true"></span>
    <span role="status">{{ label }}</span>
  </button>
  <div v-else class="connection-badge" :data-status="status" role="status">
    <span class="connection-dot" aria-hidden="true"></span>
    <span>{{ label }}</span>
  </div>
</template>

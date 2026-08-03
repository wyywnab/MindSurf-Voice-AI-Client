<script setup lang="ts">
import { computed } from "vue";

import { CONNECTION_STATUS_LABELS, type ServiceConnectionStatus } from "../types/voice";
import { useI18n } from "../services/i18n";

const props = defineProps<{
  status: ServiceConnectionStatus;
}>();

const { t } = useI18n();
const label = computed(() => t(CONNECTION_STATUS_LABELS[props.status]));
</script>

<template>
  <div class="connection-badge" :data-status="status" role="status">
    <span class="connection-dot" aria-hidden="true"></span>
    <span>{{ label }}</span>
  </div>
</template>

<script setup lang="ts">
import {
  activateToast,
  dismissToast,
  useToasts,
  type ToastType,
} from "../services/toast";

const toasts = useToasts();
const typeLabels: Record<ToastType, string> = {
  success: "成功",
  error: "操作失败",
  warning: "注意",
  info: "提示",
};
</script>

<template>
  <Teleport to="body">
    <div class="toast-viewport" aria-label="操作通知">
      <TransitionGroup name="toast" tag="div" class="toast-stack">
        <article
          v-for="item in toasts.items"
          :key="item.id"
          class="toast-item"
          :data-type="item.type"
          :role="item.type === 'error' || item.type === 'warning' ? 'alert' : 'status'"
          aria-atomic="true"
        >
          <span class="toast-icon" aria-hidden="true">
            <svg v-if="item.type === 'success'" viewBox="0 0 20 20">
              <path d="m4 10 3.5 3.5L16 5.5" />
            </svg>
            <svg v-else-if="item.type === 'error'" viewBox="0 0 20 20">
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
            <svg v-else-if="item.type === 'warning'" viewBox="0 0 20 20">
              <path d="M10 3 18 17H2L10 3Z" />
              <path d="M10 7v5m0 2.5v.1" />
            </svg>
            <svg v-else viewBox="0 0 20 20">
              <circle cx="10" cy="10" r="7" />
              <path d="M10 9v5m0-8v.1" />
            </svg>
          </span>
          <div class="toast-content">
            <strong>{{ item.title || typeLabels[item.type] }}</strong>
            <p>{{ item.message }}</p>
            <button
              v-if="item.actionLabel"
              class="toast-action"
              type="button"
              @click="activateToast(item.id)"
            >
              {{ item.actionLabel }}
            </button>
          </div>
          <button
            class="toast-close"
            type="button"
            aria-label="关闭通知"
            @click="dismissToast(item.id)"
          >
            ×
          </button>
        </article>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

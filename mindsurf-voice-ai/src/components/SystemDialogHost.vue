<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";

import { resolveBrowserDialog, useBrowserDialog } from "../services/systemDialog";

const dialog = useBrowserDialog();

function handleKeydown(event: InstanceType<typeof globalThis.KeyboardEvent>) {
  if (!dialog.current) return;
  if (event.key === "Escape" && dialog.current.type !== "message") {
    event.preventDefault();
    resolveBrowserDialog(false);
  } else if (event.key === "Enter") {
    event.preventDefault();
    resolveBrowserDialog(true);
  }
}

onMounted(() => globalThis.addEventListener("keydown", handleKeydown));
onBeforeUnmount(() => globalThis.removeEventListener("keydown", handleKeydown));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="dialog.current"
      class="system-dialog-backdrop"
      role="presentation"
      @click.self="dialog.current.type !== 'message' && resolveBrowserDialog(false)"
    >
      <section
        class="system-dialog"
        :data-kind="dialog.current.kind"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="system-dialog-title"
        aria-describedby="system-dialog-message"
      >
        <h2 id="system-dialog-title">{{ dialog.current.title }}</h2>
        <p id="system-dialog-message">{{ dialog.current.message }}</p>
        <div class="system-dialog-actions">
          <button
            v-if="dialog.current.type !== 'message'"
            class="button button-secondary"
            type="button"
            @click="resolveBrowserDialog(false)"
          >
            {{ dialog.current.cancelLabel }}
          </button>
          <button
            class="button"
            :class="dialog.current.kind === 'error' ? 'button-stop' : 'button-primary'"
            type="button"
            autofocus
            @click="resolveBrowserDialog(true)"
          >
            {{ dialog.current.confirmLabel }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

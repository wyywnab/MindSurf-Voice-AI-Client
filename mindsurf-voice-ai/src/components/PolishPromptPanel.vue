<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  PolishPromptValidationError,
  polishPromptController,
  validatePolishPrompt,
} from "../controllers/polishPromptController";
import { showConfirm } from "../services/systemDialog";
import { toast } from "../services/toast";
import { usePolishPromptStore } from "../stores/polishPromptStore";

const emit = defineEmits<{ close: [] }>();
const promptState = usePolishPromptStore().state;
const draft = ref("");
const localError = ref("");
const conflictAction = ref<"save" | "reset" | null>(null);

const configuration = computed(() => promptState.resource?.configuration ?? null);
const codePointCount = computed(() => [...draft.value].length);
const utf8ByteCount = computed(
  () => new globalThis.TextEncoder().encode(draft.value).byteLength,
);
const dirty = computed(
  () => configuration.value !== null && draft.value !== configuration.value.prompt,
);
const busy = computed(
  () => promptState.status === "loading" || promptState.status === "saving",
);
const validationMessage = computed(() => {
  const constraints = configuration.value?.constraints;
  if (!constraints) return "";
  try {
    validatePolishPrompt(draft.value, constraints);
    return "";
  } catch (error) {
    return error instanceof PolishPromptValidationError ? error.message : "提示词无效";
  }
});

async function load(force = false) {
  localError.value = "";
  conflictAction.value = null;
  await polishPromptController.load(force);
  if (promptState.resource) draft.value = promptState.resource.configuration.prompt;
}

async function refresh() {
  if (
    dirty.value &&
    !(await showConfirm("刷新会放弃尚未保存的修改，是否继续？", {
      title: "刷新账户提示词",
      kind: "warning",
      confirmLabel: "刷新",
    }))
  ) {
    return;
  }
  await load(true);
}

async function close() {
  if (
    (dirty.value || promptState.revisionConflict) &&
    !(await showConfirm("当前修改尚未保存，确认离开？", {
      title: "放弃提示词修改",
      kind: "warning",
      confirmLabel: "离开",
    }))
  ) {
    return;
  }
  emit("close");
}

async function save() {
  localError.value = "";
  const candidate = draft.value;
  try {
    const result = await polishPromptController.save(candidate);
    if (result === "conflict") {
      conflictAction.value = "save";
      draft.value = candidate;
      toast.warning("其他设备已更新配置，请选择保留远端内容或覆盖", {
        title: "提示词版本冲突",
        durationMs: 0,
      });
      return;
    }
    conflictAction.value = null;
    draft.value = promptState.resource?.configuration.prompt ?? candidate;
    toast.success("润色提示词已同步到当前账户", { title: "保存成功" });
  } catch (error) {
    localError.value = describeError(error);
    toast.error(localError.value, { title: "保存失败", durationMs: 0 });
  }
}

async function resetToDefault() {
  if (
    !(await showConfirm("确认删除自定义提示词并恢复服务端默认值？", {
      title: "恢复默认提示词",
      kind: "warning",
      confirmLabel: "恢复默认",
    }))
  ) {
    return;
  }
  await performReset();
}

async function performReset() {
  localError.value = "";
  try {
    const result = await polishPromptController.resetToDefault();
    if (result === "conflict") {
      conflictAction.value = "reset";
      toast.warning("其他设备已更新配置，请确认最新内容后再次操作", {
        title: "提示词版本冲突",
        durationMs: 0,
      });
      return;
    }
    conflictAction.value = null;
    draft.value = promptState.resource?.configuration.prompt ?? "";
    toast.success("已恢复服务端默认提示词", { title: "恢复成功" });
  } catch (error) {
    localError.value = describeError(error);
    toast.error(localError.value, { title: "恢复失败", durationMs: 0 });
  }
}

function acceptRemote() {
  draft.value = configuration.value?.prompt ?? "";
  conflictAction.value = null;
  polishPromptController.acceptRemote();
}

async function retryConflictAction() {
  const action = conflictAction.value;
  conflictAction.value = null;
  polishPromptController.acceptRemote();
  if (action === "save") await save();
  else if (action === "reset") await performReset();
}

function discardDraft() {
  draft.value = configuration.value?.prompt ?? "";
  localError.value = "";
}

function describeError(error: unknown) {
  return error instanceof Error && error.message
    ? error.message
    : "润色提示词操作失败，请稍后重试";
}

onMounted(() => void load());
</script>

<template>
  <section class="panel polish-prompt-panel" aria-labelledby="polish-prompt-title">
    <header class="panel-heading">
      <div>
        <h1 id="polish-prompt-title">润色提示词</h1>
        <p class="panel-description">
          管理当前账户在所有设备上共用的语音润色指令，仅影响“识别并润色”模式。
        </p>
      </div>
      <div class="polish-prompt-heading-actions">
        <button
          class="button button-secondary button-compact"
          type="button"
          :disabled="busy"
          @click="refresh"
        >
          {{ promptState.status === "loading" ? "刷新中…" : "刷新" }}
        </button>
        <button
          class="button button-secondary button-compact"
          type="button"
          @click="close"
        >
          返回
        </button>
      </div>
    </header>

    <div class="panel-body polish-prompt-body">
      <div v-if="promptState.status === 'loading'" class="polish-prompt-state">
        正在加载账户提示词…
      </div>

      <div v-else-if="promptState.status === 'unsupported'" class="polish-prompt-state">
        <strong>当前服务端暂不支持此功能</strong>
        <p>语音识别和润色仍可正常使用，客户端将继续采用服务端默认行为。</p>
      </div>

      <div v-else-if="!configuration" class="polish-prompt-state">
        <strong>无法加载润色提示词</strong>
        <p>{{ promptState.error || "请检查网络连接后重试。" }}</p>
        <button class="button button-secondary" type="button" @click="load(true)">
          重新加载
        </button>
      </div>

      <template v-else>
        <section class="polish-prompt-editor-card">
          <div class="polish-prompt-meta">
            <span class="polish-prompt-source" :data-source="configuration.source">
              {{ configuration.source === "custom" ? "账户自定义" : "服务端默认" }}
            </span>
            <span
              >更新于 {{ new Date(configuration.updated_at_ms).toLocaleString() }}</span
            >
          </div>

          <label for="polish-prompt-input">润色指令</label>
          <textarea
            id="polish-prompt-input"
            v-model="draft"
            :disabled="busy"
            spellcheck="true"
            placeholder="说明希望如何整理和润色语音识别结果"
          />

          <div class="polish-prompt-counts" :class="{ 'has-error': validationMessage }">
            <span>
              {{ codePointCount }} /
              {{ configuration.constraints.max_code_points }} 字符
            </span>
            <span>
              {{ utf8ByteCount }} / {{ configuration.constraints.max_utf8_bytes }} 字节
            </span>
          </div>

          <p class="settings-hint">
            内容会按原样保存，可以使用换行和制表符，无需加入 transcript
            模板占位符。提示词正文不会写入客户端诊断日志或识别历史。
          </p>
          <p v-if="validationMessage" class="inline-error" role="alert">
            {{ validationMessage }}
          </p>
          <p
            v-else-if="localError || promptState.error"
            class="inline-error"
            role="alert"
          >
            {{ localError || promptState.error }}
          </p>

          <aside
            v-if="promptState.revisionConflict"
            class="polish-prompt-conflict"
            role="alert"
          >
            <strong>检测到其他设备上的更新</strong>
            <p>
              已获取账户的最新版本。你可以采用远端内容，或者基于最新版本再次提交当前操作。
            </p>
            <div class="polish-prompt-remote-preview">
              <span>远端当前内容</span>
              <pre>{{ configuration.prompt }}</pre>
            </div>
            <div>
              <button
                class="button button-secondary"
                type="button"
                @click="acceptRemote"
              >
                使用远端内容
              </button>
              <button
                class="button button-primary"
                type="button"
                @click="retryConflictAction"
              >
                {{ conflictAction === "reset" ? "仍然恢复默认" : "覆盖远端版本" }}
              </button>
            </div>
          </aside>

          <div class="polish-prompt-actions">
            <button
              class="button button-primary"
              type="button"
              :disabled="
                busy ||
                !dirty ||
                Boolean(validationMessage) ||
                promptState.revisionConflict
              "
              @click="save"
            >
              {{ promptState.status === "saving" ? "同步中…" : "保存到账户" }}
            </button>
            <button
              class="button button-secondary"
              type="button"
              :disabled="busy || !dirty || promptState.revisionConflict"
              @click="discardDraft"
            >
              放弃修改
            </button>
            <button
              class="button button-danger"
              type="button"
              :disabled="
                busy ||
                configuration.source !== 'custom' ||
                promptState.revisionConflict
              "
              @click="resetToDefault"
            >
              恢复默认
            </button>
          </div>
        </section>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { authController } from "../controllers/authController";
import { realtimeConnectionController } from "../controllers/realtimeConnectionController";
import { validateApiOrigin } from "../services/http/apiOrigin";
import { useAccountStore } from "../stores/accountStore";
import { useAuthStore } from "../stores/authStore";
import { useCapabilitiesStore } from "../stores/capabilitiesStore";
import { useQuotaStore } from "../stores/quotaStore";
import { useRealtimeConnectionStore } from "../stores/realtimeConnectionStore";
import { useSettingsStore } from "../stores/settingsStore";

const auth = useAuthStore();
const account = useAccountStore();
const quota = useQuotaStore();
const capabilities = useCapabilitiesStore();
const realtime = useRealtimeConnectionStore();
const settings = useSettingsStore();
const origin = ref(settings.state.voiceApiOrigin);
const localMessage = ref("");
const pending = computed(() =>
  ["authorizing", "exchanging", "restoring", "loading_account", "signing_out"].includes(
    auth.state.status,
  ),
);

watch(
  () => settings.state.voiceApiOrigin,
  (value) => (origin.value = value),
);

async function saveOrigin() {
  localMessage.value = "";
  try {
    const validated = validateApiOrigin(origin.value);
    await authController.changeApiOrigin(validated);
    origin.value = validated;
    localMessage.value = "API 地址已保存";
  } catch (error) {
    localMessage.value = error instanceof Error ? error.message : "API 地址保存失败";
  }
}

async function login() {
  localMessage.value = "";
  try {
    await authController.startAuthorization();
  } catch {
    // Auth store keeps the user-facing error.
  }
}

async function refreshAccount() {
  localMessage.value = "";
  try {
    await authController.refreshAccount();
    localMessage.value = "账户状态已刷新";
  } catch (error) {
    localMessage.value = error instanceof Error ? error.message : "刷新失败";
  }
}

async function logout() {
  await authController.logout();
  localMessage.value = "已退出登录并清除本地凭据";
}
</script>

<template>
  <section class="panel" aria-labelledby="account-title">
    <header class="panel-heading">
      <div>
        <h1 id="account-title">账户与 Voice API v2</h1>
        <p class="panel-description">
          通过系统浏览器安全登录，客户端不接触密码或验证码。
        </p>
      </div>
    </header>

    <div class="panel-body">
      <div class="settings-list">
        <section class="settings-section">
          <h2>服务地址</h2>
          <label class="field-label" for="voice-api-origin">HTTP API origin</label>
          <div class="inline-actions">
            <input
              id="voice-api-origin"
              v-model="origin"
              type="url"
              :disabled="pending"
            />
            <button type="button" :disabled="pending" @click="saveOrigin">保存</button>
          </div>
          <p class="field-hint">生产环境仅允许 HTTPS；HTTP 仅限本机开发服务。</p>
        </section>

        <section class="settings-section" aria-live="polite">
          <h2>登录状态</h2>
          <template v-if="account.state.user">
            <dl class="metric-grid">
              <div>
                <dt>用户</dt>
                <dd>{{ account.state.user.display_name }}</dd>
              </div>
              <div>
                <dt>登录标识</dt>
                <dd>{{ account.state.user.login }}</dd>
              </div>
              <div>
                <dt>套餐</dt>
                <dd>{{ account.state.user.plan }}</dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>{{ account.state.user.status }}</dd>
              </div>
            </dl>
            <div class="inline-actions">
              <button type="button" :disabled="pending" @click="refreshAccount">
                刷新账户状态
              </button>
              <button type="button" :disabled="pending" @click="logout">
                退出登录
              </button>
            </div>
          </template>
          <div v-else class="inline-actions">
            <button type="button" :disabled="pending" @click="login">
              {{ pending ? "登录处理中…" : "使用系统浏览器登录" }}
            </button>
          </div>
          <p v-if="auth.state.error" class="field-error">{{ auth.state.error }}</p>
          <p v-if="localMessage" class="field-hint">{{ localMessage }}</p>
        </section>

        <section v-if="quota.state.quota" class="settings-section">
          <h2>当前额度</h2>
          <dl class="metric-grid">
            <div>
              <dt>总额</dt>
              <dd>{{ quota.state.quota.credits.limit }}</dd>
            </div>
            <div>
              <dt>已用</dt>
              <dd>{{ quota.state.quota.credits.used }}</dd>
            </div>
            <div>
              <dt>预留</dt>
              <dd>{{ quota.state.quota.credits.reserved }}</dd>
            </div>
            <div>
              <dt>剩余</dt>
              <dd>{{ quota.state.quota.credits.remaining }}</dd>
            </div>
          </dl>
        </section>

        <section v-if="capabilities.state.capabilities" class="settings-section">
          <h2>服务能力</h2>
          <p class="field-hint">
            Revision {{ capabilities.state.capabilities.revision }} ·
            {{ capabilities.state.capabilities.pipelines.length }} 个 Pipeline
          </p>
        </section>

        <section v-if="account.state.user" class="settings-section" aria-live="polite">
          <h2>Voice v2 长连接</h2>
          <dl class="metric-grid">
            <div>
              <dt>状态</dt>
              <dd>{{ realtime.state.status }}</dd>
            </div>
            <div>
              <dt>重连次数</dt>
              <dd>{{ realtime.state.reconnectAttempt }}</dd>
            </div>
            <div>
              <dt>Session</dt>
              <dd>{{ realtime.state.serverHello ? "握手完成" : "尚未就绪" }}</dd>
            </div>
            <div>
              <dt>心跳间隔</dt>
              <dd>{{ realtime.state.serverHello?.heartbeat_interval_ms ?? "-" }} ms</dd>
            </div>
          </dl>
          <p v-if="realtime.state.lastError" class="field-error">
            {{ realtime.state.lastError }}
          </p>
          <div v-if="realtime.state.status === 'error'" class="inline-actions">
            <button type="button" @click="realtimeConnectionController.retryNow()">
              重新建立连接
            </button>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
.settings-list {
  display: grid;
  gap: 16px;
}

.settings-section {
  display: grid;
  gap: 10px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
}

.settings-section h2 {
  margin: 0;
  font-size: 0.9rem;
}

.inline-actions {
  display: flex;
  gap: 8px;
}

.inline-actions input {
  min-width: 0;
  flex: 1;
}

.metric-grid {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.metric-grid div {
  padding: 8px;
  border-radius: 6px;
  background: var(--surface-muted);
}

.metric-grid dt,
.field-hint {
  color: var(--text-secondary);
  font-size: 0.72rem;
}

.metric-grid dd {
  margin: 3px 0 0;
  overflow-wrap: anywhere;
}

.field-error {
  color: var(--danger);
}
</style>

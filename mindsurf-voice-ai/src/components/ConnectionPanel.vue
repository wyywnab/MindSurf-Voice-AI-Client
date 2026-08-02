<script setup lang="ts">
import { voiceRequestController } from "../controllers/voiceRequestController";
import { useConnectionStore } from "../stores/connectionStore";
import { useSettingsStore } from "../stores/settingsStore";
import ConnectionBadge from "./ConnectionBadge.vue";

const connection = useConnectionStore();
const settings = useSettingsStore();
</script>

<template>
  <section class="panel" aria-labelledby="connection-title">
    <header class="panel-heading">
      <div>
        <h1 id="connection-title">服务连接</h1>
        <p class="panel-description">WebSocket 协议版本、握手状态和重连信息。</p>
      </div>
      <ConnectionBadge :status="connection.state.status" />
    </header>

    <div class="panel-body">
      <div class="connection-grid">
        <article class="detail-card">
          <span class="detail-label">服务地址</span>
          <code>{{ settings.state.serviceUrl }}</code>
        </article>
        <article class="detail-card">
          <span class="detail-label">协议状态</span>
          <strong v-if="connection.state.serverHello">
            v{{ connection.state.serverHello.protocol_version }} ·
            {{ connection.state.serverHello.pipeline }}
          </strong>
          <strong v-else>{{ connection.connectionLabel }}</strong>
        </article>
        <article class="detail-card">
          <span class="detail-label">会话</span>
          <strong>
            {{ connection.state.serverHello?.session_id ?? "尚未建立" }}
          </strong>
        </article>
        <article class="detail-card">
          <span class="detail-label">重连次数</span>
          <strong>{{ connection.state.reconnectAttempt }}</strong>
        </article>
      </div>

      <div v-if="connection.state.lastError" class="connection-error">
        <span>{{ connection.state.lastError }}</span>
        <button
          class="button button-secondary"
          type="button"
          @click="
            connection.state.status === 'disconnected'
              ? voiceRequestController.connectConfiguredService()
              : voiceRequestController.retryConnection()
          "
        >
          立即重试
        </button>
      </div>

      <button
        v-else-if="connection.state.status === 'disconnected'"
        class="button button-secondary"
        type="button"
        @click="voiceRequestController.connectConfiguredService()"
      >
        连接服务
      </button>
    </div>
  </section>
</template>

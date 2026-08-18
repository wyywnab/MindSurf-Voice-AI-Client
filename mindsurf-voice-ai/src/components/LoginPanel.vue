<script setup lang="ts">
import { computed } from "vue";

import { authController } from "../controllers/authController";
import { useAuthStore } from "../stores/authStore";

const auth = useAuthStore();
const pending = computed(() =>
  ["authorizing", "exchanging", "restoring", "loading_account"].includes(
    auth.state.status,
  ),
);

async function login() {
  try {
    await authController.startAuthorization();
  } catch {
    // The controller exposes a user-facing error through the auth store.
  }
}
</script>

<template>
  <section class="login-panel" aria-labelledby="login-title">
    <div class="login-content">
      <div class="login-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" role="img">
          <path
            d="M12 12a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Zm-7.25 8.5c.42-4.02 3.27-6.25 7.25-6.25s6.83 2.23 7.25 6.25"
          />
        </svg>
      </div>
      <h1 id="login-title">登录 MindSurf</h1>
      <p>登录后即可使用语音识别与智能文本处理。密码和验证码只会在系统浏览器中输入。</p>
      <button
        class="button button-primary login-button"
        type="button"
        :disabled="pending"
        @click="login"
      >
        {{ pending ? "正在登录…" : "使用系统浏览器登录" }}
      </button>
      <p v-if="auth.state.error" class="login-error" role="alert">
        {{ auth.state.error }}
      </p>
    </div>
  </section>
</template>

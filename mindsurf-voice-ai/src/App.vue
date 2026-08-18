<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import ConnectionBadge from "./components/ConnectionBadge.vue";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import LoginPanel from "./components/LoginPanel.vue";
import PermissionsPanel from "./components/PermissionsPanel.vue";
import RecorderPanel from "./components/RecorderPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import UsagePanel from "./components/UsagePanel.vue";
import SystemDialogHost from "./components/SystemDialogHost.vue";
import TopTabs from "./components/TopTabs.vue";
import { settingsController } from "./controllers/settingsController";
import { authController } from "./controllers/authController";
import { getAppInfo } from "./services/appInfo";
import { syncMacOSAppMenu } from "./services/appMenu";
import { useI18n } from "./services/i18n";
import { hideOverlayWindow, setOverlayWindowPosition } from "./services/overlay";
import { getSystemPermissionStatus } from "./services/permissions";
import {
  subscribeTrayActions,
  syncTrayConfiguration,
  syncTrayMode,
} from "./services/tray";
import { useAuthStore } from "./stores/authStore";
import { useAccountStore } from "./stores/accountStore";
import { useRealtimeConnectionStore } from "./stores/realtimeConnectionStore";
import { diagnosticsStoreActions } from "./stores/diagnosticsStore";
import { useSettingsStore } from "./stores/settingsStore";
import type { AppInfo } from "./types/app";
import type { MainTab, MainTabId } from "./types/navigation";
import type { SystemPermission } from "./types/permissions";

const macPermissions: readonly SystemPermission[] = ["microphone", "accessibility"];

const activeTab = ref<MainTabId>("record");
const appInfo = ref<AppInfo | null>(null);
const appInfoError = ref("");
const auth = useAuthStore();
const account = useAccountStore();
const accountMenuOpen = ref(false);
const accountUsageOpen = ref(false);
const realtimeConnection = useRealtimeConnectionStore();
const visibleConnectionStatus = computed(() =>
  auth.state.status === "authenticated"
    ? realtimeConnection.state.status
    : "disconnected",
);
const { t } = useI18n();
const settings = useSettingsStore();
const diagnosticsPageVisible = computed(
  () =>
    settings.state.developerModeEnabled && settings.state.developerShowDiagnosticsPage,
);
const tabs = computed<readonly MainTab[]>(() => [
  { id: "record", label: t("录音") },
  ...(diagnosticsPageVisible.value
    ? ([{ id: "connection", label: t("诊断") }] satisfies MainTab[])
    : []),
  { id: "permissions", label: t("权限") },
  { id: "settings", label: t("设置") },
]);
let trayDisposed = false;
let unlistenTray: (() => void) | null = null;

watch(diagnosticsPageVisible, (visible) => {
  if (!visible && activeTab.value === "connection") {
    activeTab.value = "record";
  }
});

watch(
  [
    () => settings.state.initialized,
    () => settings.state.interfaceLocale,
    diagnosticsPageVisible,
  ],
  ([initialized]) => {
    if (!initialized) return;
    const menuOptions = {
      diagnosticsEnabled: diagnosticsPageVisible.value,
      locale: settings.state.interfaceLocale,
    };
    void syncTrayConfiguration(menuOptions);
    void syncMacOSAppMenu({
      diagnosticsEnabled: menuOptions.diagnosticsEnabled,
      onNavigate: navigateTo,
    }).catch((error) => {
      diagnosticsStoreActions.log(
        "warn",
        "menu",
        "app_menu.update_failed",
        error instanceof Error ? error.message : "应用菜单更新失败",
      );
    });
  },
  { immediate: true },
);

function navigateTo(page: MainTabId) {
  if (page === "connection" && !diagnosticsPageVisible.value) return;
  accountUsageOpen.value = false;
  activeTab.value = page;
}

async function logout() {
  accountMenuOpen.value = false;
  accountUsageOpen.value = false;
  activeTab.value = "record";
  await authController.logout();
}

async function configureStartupPermissions(platform: string) {
  if (platform !== "macos") {
    await settingsController.initializeRecordShortcut();
    return;
  }

  const checks = await Promise.all(
    macPermissions.map(async (permission) => ({
      permission,
      result: await getSystemPermissionStatus(permission),
    })),
  );
  const hasMissingPermission = checks.some(
    ({ result }) => !result.ok || result.data.status !== "granted",
  );
  for (const { permission, result } of checks) {
    if (!result.ok || result.data.status !== "granted") {
      diagnosticsStoreActions.log(
        "warn",
        "permissions",
        "permission.unavailable",
        `${permission} 权限尚未授权`,
        { fields: { permission } },
      );
    }
  }
  if (hasMissingPermission && account.state.user) {
    activeTab.value = "permissions";
  }
  await settingsController.initializeRecordShortcut();
}

onMounted(async () => {
  await settingsController.initialize();
  void subscribeTrayActions({
    onMode: (mode) => {
      if (!settingsController.setMode(mode)) {
        void syncTrayMode(settings.state.selectedMode);
      }
    },
    onNavigate: (page) => {
      navigateTo(page);
    },
  })
    .then((unlisten) => {
      if (trayDisposed) {
        unlisten();
      } else {
        unlistenTray = unlisten;
      }
    })
    .catch(() => {
      // Tray events are unavailable in a regular browser preview.
    });
  void syncTrayMode(settings.state.selectedMode);
  void setOverlayWindowPosition(settings.state.overlayPosition);
  if (!settings.state.overlayEnabled) {
    void hideOverlayWindow();
  }
  const result = await getAppInfo();

  if (result.ok) {
    appInfo.value = result.data;
    await authController.initialize(result.data);
    await configureStartupPermissions(result.data.platform);
  } else {
    appInfoError.value = result.error.message;
    await configureStartupPermissions(
      globalThis.navigator.userAgent.includes("Mac OS") ? "macos" : "unknown",
    );
    await authController.initialize({
      version: "0.1.0",
      platform: globalThis.navigator.userAgent.includes("Mac OS") ? "macos" : "unknown",
      arch: "unknown",
      buildProfile: "unknown",
    });
  }
});

onBeforeUnmount(() => {
  trayDisposed = true;
  unlistenTray?.();
  unlistenTray = null;
  authController.dispose();
});
</script>

<template>
  <div class="app-shell">
    <SystemDialogHost />
    <header class="app-header">
      <div class="account-anchor">
        <button
          class="account-trigger"
          type="button"
          :aria-expanded="accountMenuOpen"
          aria-haspopup="menu"
          @click="accountMenuOpen = !accountMenuOpen"
        >
          <span class="user-avatar" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path
                d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c.48-3.7 3.12-5.75 7-5.75s6.52 2.05 7 5.75"
              />
            </svg>
          </span>
          <strong>{{ account.state.user?.display_name ?? "未登录" }}</strong>
          <span class="account-chevron" aria-hidden="true">⌄</span>
        </button>
        <div v-if="accountMenuOpen" class="account-menu" role="menu">
          <template v-if="account.state.user">
            <strong>{{ account.state.user.display_name }}</strong>
            <span>{{ account.state.user.login }}</span>
            <span>{{ account.state.user.plan }}</span>
            <button
              type="button"
              role="menuitem"
              @click="
                accountMenuOpen = false;
                accountUsageOpen = true;
              "
            >
              用量与额度
            </button>
            <button
              type="button"
              role="menuitem"
              :disabled="auth.state.status === 'signing_out'"
              @click="logout"
            >
              {{ auth.state.status === "signing_out" ? "正在退出…" : "退出登录" }}
            </button>
          </template>
          <template v-else>
            <span>尚未登录 MindSurf</span>
            <button
              type="button"
              role="menuitem"
              @click="
                accountMenuOpen = false;
                activeTab = 'record';
              "
            >
              前往登录
            </button>
          </template>
        </div>
      </div>

      <TopTabs :model-value="activeTab" :tabs="tabs" @update:model-value="navigateTo" />

      <ConnectionBadge :status="visibleConnectionStatus" />
    </header>

    <main class="app-content">
      <UsagePanel
        v-if="accountUsageOpen && account.state.user"
        @close="accountUsageOpen = false"
      />
      <LoginPanel v-else-if="activeTab === 'record' && !account.state.user" />
      <RecorderPanel v-else-if="activeTab === 'record'" />
      <ConnectionPanel
        v-else-if="diagnosticsPageVisible && activeTab === 'connection'"
      />
      <PermissionsPanel v-else-if="activeTab === 'permissions'" :app-info="appInfo" />
      <SettingsPanel
        v-else-if="activeTab === 'settings'"
        :app-info="appInfo"
        :app-info-error="appInfoError"
      />
    </main>

    <footer class="app-footer">
      <span>{{ t("Phase 3 · Voice API v2 迁移") }}</span>
      <span v-if="appInfo">v{{ appInfo.version }} · {{ appInfo.buildProfile }}</span>
    </footer>
  </div>
</template>

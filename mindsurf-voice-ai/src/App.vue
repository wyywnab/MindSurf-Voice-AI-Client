<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import ConnectionBadge from "./components/ConnectionBadge.vue";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import PermissionsPanel from "./components/PermissionsPanel.vue";
import RecorderPanel from "./components/RecorderPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import SystemDialogHost from "./components/SystemDialogHost.vue";
import TopTabs from "./components/TopTabs.vue";
import { settingsController } from "./controllers/settingsController";
import { voiceRequestController } from "./controllers/voiceRequestController";
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
import { useConnectionStore } from "./stores/connectionStore";
import { diagnosticsStoreActions } from "./stores/diagnosticsStore";
import { useSettingsStore } from "./stores/settingsStore";
import type { AppInfo } from "./types/app";
import type { MainTab, MainTabId } from "./types/navigation";
import type { SystemPermission } from "./types/permissions";

const macPermissions: readonly SystemPermission[] = ["microphone", "accessibility"];

const activeTab = ref<MainTabId>("record");
const appInfo = ref<AppInfo | null>(null);
const appInfoError = ref("");
const connection = useConnectionStore();
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
  activeTab.value = page;
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
  if (hasMissingPermission) {
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
    await configureStartupPermissions(result.data.platform);
    voiceRequestController.setIdentity({
      version: result.data.version,
      platform: result.data.platform,
      arch: result.data.arch,
    });
    if (settings.state.autoConnect) {
      voiceRequestController.connectConfiguredService();
    }
  } else {
    appInfoError.value = result.error.message;
    await configureStartupPermissions(
      globalThis.navigator.userAgent.includes("Mac OS") ? "macos" : "unknown",
    );
    voiceRequestController.setIdentity({
      version: "0.1.0",
      platform: globalThis.navigator.userAgent.includes("Mac OS") ? "macos" : "unknown",
      arch: "unknown",
    });
    if (settings.state.autoConnect) {
      voiceRequestController.connectConfiguredService();
    }
  }
});

onBeforeUnmount(() => {
  trayDisposed = true;
  unlistenTray?.();
  unlistenTray = null;
  voiceRequestController.disconnect();
});
</script>

<template>
  <div class="app-shell">
    <SystemDialogHost />
    <header class="app-header">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">M</span>
        <strong>MindSurf Voice AI</strong>
      </div>

      <TopTabs v-model="activeTab" :tabs="tabs" />

      <ConnectionBadge :status="connection.state.status" />
    </header>

    <main class="app-content">
      <RecorderPanel v-show="activeTab === 'record'" />
      <ConnectionPanel v-if="diagnosticsPageVisible && activeTab === 'connection'" />
      <PermissionsPanel v-show="activeTab === 'permissions'" :app-info="appInfo" />
      <SettingsPanel
        v-show="activeTab === 'settings'"
        :app-info="appInfo"
        :app-info-error="appInfoError"
      />
    </main>

    <footer class="app-footer">
      <span>{{ t("Phase 2 · 服务档案与诊断增强") }}</span>
      <span v-if="appInfo">v{{ appInfo.version }} · {{ appInfo.buildProfile }}</span>
    </footer>
  </div>
</template>

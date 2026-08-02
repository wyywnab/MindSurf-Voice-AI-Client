<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import ConnectionBadge from "./components/ConnectionBadge.vue";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import PermissionsPanel from "./components/PermissionsPanel.vue";
import RecorderPanel from "./components/RecorderPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import TopTabs from "./components/TopTabs.vue";
import { settingsController } from "./controllers/settingsController";
import { voiceRequestController } from "./controllers/voiceRequestController";
import { getAppInfo } from "./services/appInfo";
import { hideOverlayWindow, setOverlayWindowPosition } from "./services/overlay";
import { getSystemPermissionStatus } from "./services/permissions";
import { subscribeTrayActions, syncTrayMode } from "./services/tray";
import { useConnectionStore } from "./stores/connectionStore";
import { diagnosticsStoreActions } from "./stores/diagnosticsStore";
import { useSettingsStore } from "./stores/settingsStore";
import type { AppInfo } from "./types/app";
import type { MainTab, MainTabId } from "./types/navigation";
import type { SystemPermission } from "./types/permissions";

const tabs: readonly MainTab[] = [
  { id: "record", label: "录音" },
  { id: "connection", label: "诊断" },
  { id: "permissions", label: "权限" },
  { id: "settings", label: "设置" },
];

const macPermissions: readonly SystemPermission[] = ["microphone", "accessibility"];

const activeTab = ref<MainTabId>("record");
const appInfo = ref<AppInfo | null>(null);
const appInfoError = ref("");
const connection = useConnectionStore();
const settings = useSettingsStore();
let trayDisposed = false;
let unlistenTray: (() => void) | null = null;

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
      activeTab.value = page;
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
      <ConnectionPanel v-show="activeTab === 'connection'" />
      <PermissionsPanel v-show="activeTab === 'permissions'" :app-info="appInfo" />
      <SettingsPanel
        v-show="activeTab === 'settings'"
        :app-info="appInfo"
        :app-info-error="appInfoError"
      />
    </main>

    <footer class="app-footer">
      <span>Phase 2 · M3 时间线与运行日志</span>
      <span v-if="appInfo">v{{ appInfo.version }} · {{ appInfo.buildProfile }}</span>
    </footer>
  </div>
</template>

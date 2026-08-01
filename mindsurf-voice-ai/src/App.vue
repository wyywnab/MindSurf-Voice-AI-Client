<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

import ConnectionBadge from "./components/ConnectionBadge.vue";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import PermissionsPanel from "./components/PermissionsPanel.vue";
import RecorderPanel from "./components/RecorderPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import TopTabs from "./components/TopTabs.vue";
import { getAppInfo } from "./services/appInfo";
import { hideOverlayWindow, setOverlayWindowPosition } from "./services/overlay";
import { getSystemPermissionStatus } from "./services/permissions";
import { subscribeTrayActions, syncTrayMode } from "./services/tray";
import { useVoiceSessionStore } from "./stores/voiceSession";
import type { AppInfo } from "./types/app";
import type { MainTab, MainTabId } from "./types/navigation";
import type { SystemPermission } from "./types/permissions";

const tabs: readonly MainTab[] = [
  { id: "record", label: "录音" },
  { id: "connection", label: "连接" },
  { id: "permissions", label: "权限" },
  { id: "settings", label: "设置" },
];

const macPermissions: readonly SystemPermission[] = ["microphone", "accessibility"];

const activeTab = ref<MainTabId>("record");
const appInfo = ref<AppInfo | null>(null);
const appInfoError = ref("");
const session = useVoiceSessionStore();
let trayDisposed = false;
let unlistenTray: (() => void) | null = null;

async function configureStartupPermissions(platform: string) {
  if (platform !== "macos") {
    await session.initializeRecordShortcut();
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
  if (hasMissingPermission) {
    activeTab.value = "permissions";
  }
  await session.initializeRecordShortcut();
}

onMounted(async () => {
  void subscribeTrayActions({
    onMode: (mode) => {
      if (!session.setMode(mode)) {
        void syncTrayMode(session.state.selectedMode);
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
  void syncTrayMode(session.state.selectedMode);
  void setOverlayWindowPosition(session.state.overlayPosition);
  if (!session.state.overlayEnabled) {
    void hideOverlayWindow();
  }
  const result = await getAppInfo();

  if (result.ok) {
    appInfo.value = result.data;
    await configureStartupPermissions(result.data.platform);
    session.connect({
      version: result.data.version,
      platform: result.data.platform,
      arch: result.data.arch,
    });
  } else {
    appInfoError.value = result.error.message;
    await configureStartupPermissions(
      globalThis.navigator.userAgent.includes("Mac OS") ? "macos" : "unknown",
    );
    session.connect({
      version: "0.1.0",
      platform: globalThis.navigator.userAgent.includes("Mac OS") ? "macos" : "unknown",
      arch: "unknown",
    });
  }
});

onBeforeUnmount(() => {
  trayDisposed = true;
  unlistenTray?.();
  unlistenTray = null;
  session.disconnect();
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

      <ConnectionBadge :status="session.state.connectionStatus" />
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
      <span>M5.2 · 输入悬浮窗</span>
      <span v-if="appInfo">v{{ appInfo.version }} · {{ appInfo.buildProfile }}</span>
    </footer>
  </div>
</template>

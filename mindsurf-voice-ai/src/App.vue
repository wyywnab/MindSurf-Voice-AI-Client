<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

import ConnectionBadge from "./components/ConnectionBadge.vue";
import ConnectionPanel from "./components/ConnectionPanel.vue";
import HistoryPanel from "./components/HistoryPanel.vue";
import LoginPanel from "./components/LoginPanel.vue";
import PermissionsPanel from "./components/PermissionsPanel.vue";
import PolishPromptPanel from "./components/PolishPromptPanel.vue";
import RecorderPanel from "./components/RecorderPanel.vue";
import SettingsPanel from "./components/SettingsPanel.vue";
import UsagePanel from "./components/UsagePanel.vue";
import SystemDialogHost from "./components/SystemDialogHost.vue";
import ToastHost from "./components/ToastHost.vue";
import TopTabs from "./components/TopTabs.vue";
import { settingsController } from "./controllers/settingsController";
import { authController } from "./controllers/authController";
import { realtimeConnectionController } from "./controllers/realtimeConnectionController";
import { getAppInfo } from "./services/appInfo";
import { syncMacOSAppMenu } from "./services/appMenu";
import { useI18n } from "./services/i18n";
import { hideOverlayWindow, setOverlayWindowPosition } from "./services/overlay";
import { getSystemPermissionStatus } from "./services/permissions";
import { describeRecorderError, prepareMicrophone } from "./services/recorder";
import {
  subscribeTrayActions,
  syncTrayConfiguration,
  syncTrayMode,
} from "./services/tray";
import { useAuthStore } from "./stores/authStore";
import { useAccountStore } from "./stores/accountStore";
import { useRealtimeConnectionStore } from "./stores/realtimeConnectionStore";
import { useRequestStore } from "./stores/requestStore";
import { diagnosticsStoreActions } from "./stores/diagnosticsStore";
import { useSettingsStore } from "./stores/settingsStore";
import { dismissToast, toast } from "./services/toast";
import type { AppInfo } from "./types/app";
import type { MainTab, MainTabId } from "./types/navigation";
import type { SystemPermission } from "./types/permissions";

const macPermissions: readonly SystemPermission[] = ["microphone", "accessibility"];

const activeTab = ref<MainTabId>("record");
const appInfo = ref<AppInfo | null>(null);
const appInfoError = ref("");
const auth = useAuthStore();
const account = useAccountStore();
const accountAnchor = ref<InstanceType<typeof globalThis.HTMLElement> | null>(null);
const accountMenu = ref<InstanceType<typeof globalThis.HTMLElement> | null>(null);
const accountMenuOpen = ref(false);
const accountTrigger = ref<InstanceType<typeof globalThis.HTMLButtonElement> | null>(
  null,
);
const accountPromptOpen = ref(false);
const accountUsageOpen = ref(false);
const permissionsReturnTab = ref<"record" | "settings">("settings");
const realtimeConnection = useRealtimeConnectionStore();
const request = useRequestStore();
const visibleConnectionStatus = computed(() =>
  auth.state.status === "authenticated"
    ? realtimeConnection.state.status
    : "disconnected",
);
const connectionBadgeInteractive = computed(
  () =>
    auth.state.status === "authenticated" &&
    realtimeConnection.state.status !== "connected",
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
  { id: "history", label: t("历史") },
  { id: "settings", label: t("设置") },
]);
const visibleActiveTab = computed<MainTabId>(() =>
  activeTab.value === "permissions" ? "settings" : activeTab.value,
);
let trayDisposed = false;
let unlistenTray: (() => void) | null = null;
let cancellationToastId: number | null = null;
let permissionToastId: number | null = null;

watch(diagnosticsPageVisible, (visible) => {
  if (!visible && activeTab.value === "connection") {
    activeTab.value = "record";
  }
});

watch(
  () => auth.state.status,
  (status, previous) => {
    if (status === "authenticated" && previous !== "authenticated") {
      toast.success("账户信息和服务能力已加载", { title: "登录成功" });
    } else if (status === "error" && auth.state.error) {
      toast.error(auth.state.error, { title: "登录失败", durationMs: 0 });
    } else if (status === "signed_out" && auth.state.error) {
      toast.warning(auth.state.error, { title: "登录状态已结束", durationMs: 0 });
    }
  },
);

watch(
  () => request.state.status,
  (status, previous) => {
    if (status === previous) return;
    if (status === "completed") {
      toast.success("语音识别结果已完成", { title: "处理完成" });
    } else if (status === "failed") {
      toast.error(request.state.lastError || "语音请求处理失败", {
        title: "处理失败",
        durationMs: 0,
      });
    } else if (status === "cancelled") {
      cancellationToastId = toast.info("当前录音和语音请求已取消");
    }
  },
);

watch(
  () => request.state.injectionStatus,
  (status, previous) => {
    if (status === previous) return;
    if (status === "succeeded") {
      toast.success("识别文本已注入目标窗口", { title: "文本注入完成" });
    } else if (status === "partial") {
      toast.warning(request.state.injectionError || "部分文本未能注入", {
        title: "文本仅部分注入",
        durationMs: 0,
      });
    } else if (status === "failed") {
      toast.error(request.state.injectionError || "文本注入失败，内容已保留", {
        title: "文本注入失败",
        durationMs: 0,
      });
    }
  },
);

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
  accountPromptOpen.value = false;
  activeTab.value = page;
}

function openPermissions(returnTab: "record" | "settings") {
  if (permissionToastId !== null) {
    dismissToast(permissionToastId);
    permissionToastId = null;
  }
  accountUsageOpen.value = false;
  permissionsReturnTab.value = returnTab;
  activeTab.value = "permissions";
}

function showPermissionGuidance() {
  if (cancellationToastId !== null) {
    dismissToast(cancellationToastId);
    cancellationToastId = null;
  }
  if (permissionToastId !== null) dismissToast(permissionToastId);
  permissionToastId = toast.warning(
    "录音需要麦克风权限，自动注入还需要辅助功能权限。",
    {
      title: "尚未完成系统授权",
      actionLabel: "去授权",
      durationMs: 0,
      onAction: () => openPermissions("record"),
    },
  );
}

function retryRealtimeConnection() {
  if (!connectionBadgeInteractive.value) return;
  void realtimeConnectionController.retryNow();
}

function handleAccountMenuPointerDown(
  event: InstanceType<typeof globalThis.PointerEvent>,
) {
  if (
    accountMenuOpen.value &&
    event.target instanceof globalThis.Node &&
    !accountAnchor.value?.contains(event.target)
  ) {
    accountMenuOpen.value = false;
  }
}

function handleAccountMenuKeydown(
  event: InstanceType<typeof globalThis.KeyboardEvent>,
) {
  if (event.key !== "Escape" || !accountMenuOpen.value) return;
  accountMenuOpen.value = false;
  accountTrigger.value?.focus();
}

async function handleAccountTriggerKeydown(
  event: InstanceType<typeof globalThis.KeyboardEvent>,
) {
  if (event.key !== "ArrowDown") return;
  event.preventDefault();
  accountMenuOpen.value = true;
  await nextTick();
  accountMenu.value
    ?.querySelector<InstanceType<typeof globalThis.HTMLButtonElement>>(
      "[role='menuitem']",
    )
    ?.focus();
}

function handleAccountMenuNavigation(
  event: InstanceType<typeof globalThis.KeyboardEvent>,
) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [
    ...(accountMenu.value?.querySelectorAll<
      InstanceType<typeof globalThis.HTMLButtonElement>
    >("[role='menuitem']:not(:disabled)") ?? []),
  ];
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(
    globalThis.document.activeElement as InstanceType<
      typeof globalThis.HTMLButtonElement
    >,
  );
  const index =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowUp"
          ? current <= 0
            ? items.length - 1
            : current - 1
          : current < 0 || current === items.length - 1
            ? 0
            : current + 1;
  items[index]?.focus();
}

async function logout() {
  accountMenuOpen.value = false;
  accountUsageOpen.value = false;
  accountPromptOpen.value = false;
  activeTab.value = "record";
  await authController.logout();
}

async function configureStartupPermissions(platform: string) {
  if (platform === "windows") {
    try {
      await prepareMicrophone();
    } catch (error) {
      diagnosticsStoreActions.log(
        "warn",
        "permissions",
        "permission.microphone_probe_failed",
        describeRecorderError(error),
      );
    }
    await settingsController.initializeRecordShortcut();
    return;
  }

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
    permissionsReturnTab.value = "record";
    activeTab.value = "permissions";
  }
  await settingsController.initializeRecordShortcut();
}

onMounted(async () => {
  globalThis.document.addEventListener("pointerdown", handleAccountMenuPointerDown);
  globalThis.document.addEventListener("keydown", handleAccountMenuKeydown);
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
      version: "0.2.0",
      platform: globalThis.navigator.userAgent.includes("Mac OS") ? "macos" : "unknown",
      arch: "unknown",
      buildProfile: "unknown",
    });
  }
});

onBeforeUnmount(() => {
  globalThis.document.removeEventListener("pointerdown", handleAccountMenuPointerDown);
  globalThis.document.removeEventListener("keydown", handleAccountMenuKeydown);
  trayDisposed = true;
  unlistenTray?.();
  unlistenTray = null;
  authController.dispose();
});
</script>

<template>
  <div class="app-shell">
    <SystemDialogHost />
    <ToastHost />
    <header class="app-header">
      <div ref="accountAnchor" class="account-anchor">
        <button
          ref="accountTrigger"
          class="account-trigger"
          :class="{ 'is-open': accountMenuOpen }"
          type="button"
          :aria-expanded="accountMenuOpen"
          :aria-controls="accountMenuOpen ? 'account-menu' : undefined"
          aria-haspopup="menu"
          @click="accountMenuOpen = !accountMenuOpen"
          @keydown="handleAccountTriggerKeydown"
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
        <div
          v-if="accountMenuOpen"
          id="account-menu"
          ref="accountMenu"
          class="account-menu"
          role="menu"
          aria-label="账户菜单"
          @keydown="handleAccountMenuNavigation"
        >
          <template v-if="account.state.user">
            <div class="account-menu-profile" role="presentation">
              <span class="account-menu-avatar" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c.48-3.7 3.12-5.75 7-5.75s6.52 2.05 7 5.75"
                  />
                </svg>
              </span>
              <span class="account-menu-identity">
                <strong>{{ account.state.user.display_name }}</strong>
                <small>{{ account.state.user.login }}</small>
              </span>
              <span class="account-plan">{{ account.state.user.plan }}</span>
            </div>
            <div class="account-menu-separator" role="separator"></div>
            <div class="account-menu-group" role="presentation">
              <button
                class="account-menu-item"
                type="button"
                role="menuitem"
                @click="
                  accountMenuOpen = false;
                  accountPromptOpen = false;
                  accountUsageOpen = true;
                "
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 19V9m7 10V5m7 14v-7" />
                </svg>
                <span class="account-menu-copy">
                  <strong>用量与额度</strong>
                  <small>查看当前周期的账户用量</small>
                </span>
              </button>
              <button
                class="account-menu-item"
                type="button"
                role="menuitem"
                @click="
                  accountMenuOpen = false;
                  accountUsageOpen = false;
                  accountPromptOpen = true;
                "
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="m4 20 4.2-1 10.9-10.9a2.1 2.1 0 0 0-3-3L5.2 16 4 20Zm10.6-13.4 3 3M12 3h.01M20 14h.01M6 8h.01"
                  />
                </svg>
                <span class="account-menu-copy">
                  <strong>润色提示词</strong>
                  <small>管理跨设备同步的账户指令</small>
                </span>
              </button>
            </div>
            <div class="account-menu-separator" role="separator"></div>
            <button
              class="account-menu-item account-menu-item-danger"
              type="button"
              role="menuitem"
              :disabled="auth.state.status === 'signing_out'"
              @click="logout"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10 5H5v14h5m4-4 4-3-4-3m4 3H9" />
              </svg>
              <span class="account-menu-copy">
                <strong>{{
                  auth.state.status === "signing_out" ? "正在退出…" : "退出登录"
                }}</strong>
              </span>
            </button>
          </template>
          <template v-else>
            <div class="account-menu-profile account-menu-profile-signed-out">
              <span class="account-menu-avatar" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path
                    d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8c.48-3.7 3.12-5.75 7-5.75s6.52 2.05 7 5.75"
                  />
                </svg>
              </span>
              <span class="account-menu-identity">
                <strong>尚未登录</strong>
                <small>登录后使用账户功能</small>
              </span>
            </div>
            <div class="account-menu-separator" role="separator"></div>
            <button
              class="account-menu-item"
              type="button"
              role="menuitem"
              @click="
                accountMenuOpen = false;
                activeTab = 'record';
              "
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 5h5v14h-5m-4-4-4-3 4-3m-4 3h9" />
              </svg>
              <span class="account-menu-copy">
                <strong>前往登录</strong>
                <small>连接 MindSurf 账户</small>
              </span>
            </button>
          </template>
        </div>
      </div>

      <TopTabs
        :model-value="visibleActiveTab"
        :tabs="tabs"
        @update:model-value="navigateTo"
      />

      <ConnectionBadge
        :status="visibleConnectionStatus"
        :interactive="connectionBadgeInteractive"
        @retry="retryRealtimeConnection"
      />
    </header>

    <main class="app-content">
      <UsagePanel
        v-if="accountUsageOpen && account.state.user"
        @close="accountUsageOpen = false"
      />
      <PolishPromptPanel
        v-else-if="accountPromptOpen && account.state.user"
        @close="accountPromptOpen = false"
      />
      <LoginPanel v-else-if="activeTab === 'record' && !account.state.user" />
      <RecorderPanel
        v-else-if="activeTab === 'record'"
        @open-permissions="openPermissions('record')"
        @permission-required="showPermissionGuidance"
      />
      <ConnectionPanel
        v-else-if="diagnosticsPageVisible && activeTab === 'connection'"
      />
      <HistoryPanel v-else-if="activeTab === 'history'" />
      <PermissionsPanel
        v-else-if="activeTab === 'permissions'"
        :app-info="appInfo"
        @close="activeTab = permissionsReturnTab"
      />
      <SettingsPanel
        v-else-if="activeTab === 'settings'"
        :app-info="appInfo"
        :app-info-error="appInfoError"
        @open-permissions="openPermissions('settings')"
        @open-polish-prompt="
          accountUsageOpen = false;
          accountPromptOpen = true;
        "
      />
    </main>

    <footer class="app-footer">
      <span>{{ t("Phase 3 · Voice API v2 迁移") }}</span>
      <span v-if="appInfo">v{{ appInfo.version }} · {{ appInfo.buildProfile }}</span>
    </footer>
  </div>
</template>

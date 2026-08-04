import { isTauri } from "@tauri-apps/api/core";
import {
  Menu,
  Submenu,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
} from "@tauri-apps/api/menu";

import type { MainTabId } from "../types/navigation";
import { translate as t } from "./i18n";
import { nativeEditMenuItems } from "./nativeEditMenu";

interface AppMenuOptions {
  diagnosticsEnabled: boolean;
  onNavigate: (page: MainTabId) => void;
}

let updateQueue: Promise<void> = Promise.resolve();

export function syncMacOSAppMenu(options: AppMenuOptions) {
  if (!isTauri() || !isMacOS()) return Promise.resolve();
  updateQueue = updateQueue.catch(() => undefined).then(() => replaceAppMenu(options));
  return updateQueue;
}

async function replaceAppMenu(options: AppMenuOptions) {
  const windowMenu = await Submenu.new({
    id: "window-menu",
    text: t("窗口"),
    items: [
      predefined("Minimize", "最小化"),
      predefined("Fullscreen", "进入全屏幕"),
      { item: "Separator" },
      predefined("CloseWindow", "关闭窗口"),
      predefined("BringAllToFront", "前置全部窗口"),
    ],
  });
  const helpMenu = await Submenu.new({
    id: "help-menu",
    text: t("帮助"),
    items: [],
  });
  const menu = await Menu.new({
    id: "main-app-menu",
    items: [
      {
        id: "application-menu",
        text: "MindSurf Voice AI",
        items: [
          {
            item: { About: { name: "MindSurf Voice AI" } },
            text: t("关于 MindSurf Voice AI"),
          },
          { item: "Separator" },
          predefined("Services", "服务"),
          { item: "Separator" },
          pageItem("app-settings", "设置…", "settings", options, "CmdOrCtrl+,"),
          { item: "Separator" },
          predefined("Hide", "隐藏 MindSurf Voice AI"),
          predefined("HideOthers", "隐藏其他"),
          predefined("ShowAll", "全部显示"),
          { item: "Separator" },
          predefined("Quit", "退出 MindSurf Voice AI"),
        ],
      },
      {
        id: "edit-menu",
        text: t("编辑"),
        items: nativeEditMenuItems(),
      },
      {
        id: "pages-menu",
        text: t("页面"),
        items: [
          pageItem("app-page-record", "录音", "record", options, "CmdOrCtrl+1"),
          pageItem(
            "app-page-permissions",
            "权限",
            "permissions",
            options,
            "CmdOrCtrl+2",
          ),
          pageItem(
            "app-page-diagnostics",
            "诊断",
            "connection",
            options,
            "CmdOrCtrl+3",
            options.diagnosticsEnabled,
          ),
          pageItem("app-page-settings", "设置", "settings", options, "CmdOrCtrl+4"),
        ],
      },
      windowMenu,
      helpMenu,
    ],
  });

  const previous = await menu.setAsAppMenu();
  await windowMenu.setAsWindowsMenuForNSApp();
  await helpMenu.setAsHelpMenuForNSApp();
  await previous?.close();
}

function pageItem(
  id: string,
  label: string,
  page: MainTabId,
  options: AppMenuOptions,
  accelerator?: string,
  enabled = true,
): MenuItemOptions {
  return {
    id,
    text: t(label),
    enabled,
    accelerator,
    action: () => options.onNavigate(page),
  };
}

function predefined(
  item: Exclude<PredefinedMenuItemOptions["item"], { About: unknown }>,
  label: string,
): PredefinedMenuItemOptions {
  return { item, text: t(label) };
}

function isMacOS() {
  return /Macintosh|Mac OS X/.test(globalThis.navigator?.userAgent ?? "");
}

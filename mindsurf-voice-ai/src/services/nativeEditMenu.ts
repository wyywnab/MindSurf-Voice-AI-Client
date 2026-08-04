import type { PredefinedMenuItemOptions } from "@tauri-apps/api/menu";

import { translate as t } from "./i18n";

export function nativeEditMenuItems(): PredefinedMenuItemOptions[] {
  return [
    { item: "Undo", text: t("撤销") },
    { item: "Redo", text: t("重做") },
    { item: "Separator" },
    { item: "Cut", text: t("剪切") },
    { item: "Copy", text: t("复制") },
    { item: "Paste", text: t("粘贴") },
    { item: "Separator" },
    { item: "SelectAll", text: t("全选") },
  ];
}

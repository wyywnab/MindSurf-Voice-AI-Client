import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { translate as t } from "./i18n";

interface ContextMenuEventTarget {
  addEventListener(type: "contextmenu", listener: (event: MouseEvent) => void): void;
  removeEventListener(type: "contextmenu", listener: (event: MouseEvent) => void): void;
}

function nativeEditMenu() {
  return Menu.new({
    items: [
      { item: "Undo", text: t("撤销") },
      { item: "Redo", text: t("重做") },
      { item: "Separator" },
      { item: "Cut", text: t("剪切") },
      { item: "Copy", text: t("复制") },
      { item: "Paste", text: t("粘贴") },
      { item: "Separator" },
      { item: "SelectAll", text: t("全选") },
    ],
  });
}

export function installNativeContextMenu(
  useWebViewDefaultMenu: () => boolean,
  eventTarget: ContextMenuEventTarget = globalThis,
) {
  const handleContextMenu = (event: MouseEvent) => {
    if (useWebViewDefaultMenu() || !isTauri()) return;
    event.preventDefault();
    void nativeEditMenu()
      .then((menu) => menu.popup())
      .catch((error) => {
        console.error("failed to show native context menu", error);
      });
  };
  eventTarget.addEventListener("contextmenu", handleContextMenu);
  return () => eventTarget.removeEventListener("contextmenu", handleContextMenu);
}

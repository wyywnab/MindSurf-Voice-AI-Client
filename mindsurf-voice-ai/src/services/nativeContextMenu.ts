import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";

let menuPromise: Promise<Menu> | null = null;

interface ContextMenuEventTarget {
  addEventListener(type: "contextmenu", listener: (event: MouseEvent) => void): void;
  removeEventListener(type: "contextmenu", listener: (event: MouseEvent) => void): void;
}

function nativeEditMenu() {
  menuPromise ??= Menu.new({
    items: [
      { item: "Undo", text: "撤销" },
      { item: "Redo", text: "重做" },
      { item: "Separator" },
      { item: "Cut", text: "剪切" },
      { item: "Copy", text: "复制" },
      { item: "Paste", text: "粘贴" },
      { item: "Separator" },
      { item: "SelectAll", text: "全选" },
    ],
  });
  return menuPromise;
}

export function installNativeContextMenu(
  developerMode: () => boolean,
  eventTarget: ContextMenuEventTarget = globalThis,
) {
  const handleContextMenu = (event: MouseEvent) => {
    if (developerMode() || !isTauri()) return;
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

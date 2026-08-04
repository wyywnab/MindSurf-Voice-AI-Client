import { isTauri } from "@tauri-apps/api/core";
import { Menu } from "@tauri-apps/api/menu";
import { nativeEditMenuItems } from "./nativeEditMenu";

interface ContextMenuEventTarget {
  addEventListener(type: "contextmenu", listener: (event: MouseEvent) => void): void;
  removeEventListener(type: "contextmenu", listener: (event: MouseEvent) => void): void;
}

function nativeEditMenu() {
  return Menu.new({
    items: nativeEditMenuItems(),
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

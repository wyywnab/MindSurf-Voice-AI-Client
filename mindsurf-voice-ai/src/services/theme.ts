import type { InterfaceTheme } from "../types/settings";

export function applyInterfaceTheme(theme: InterfaceTheme) {
  if (typeof document === "undefined") return;
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

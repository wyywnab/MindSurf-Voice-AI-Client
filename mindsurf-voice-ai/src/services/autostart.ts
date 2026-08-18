import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

export function isAutostartEnabled() {
  return isEnabled();
}

export async function setAutostartEnabled(enabled: boolean) {
  if (enabled) {
    await enable();
  } else {
    await disable();
  }
}

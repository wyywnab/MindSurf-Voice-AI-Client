import { isTauri } from "@tauri-apps/api/core";

import type { AudioInputDevice } from "../types/settings";

function isMacOSClient() {
  return isTauri() && /Macintosh|Mac OS X/.test(navigator.userAgent);
}

export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  let unnamed = 0;
  return devices
    .filter((device) => device.kind === "audioinput")
    .map((device) => ({
      id: device.deviceId,
      label: device.label || `麦克风 ${++unnamed}`,
      isDefault: device.deviceId === "default",
      backend:
        isMacOSClient() && device.deviceId === "default"
          ? ("native" as const)
          : ("web_audio" as const),
    }));
}

export function subscribeAudioDeviceChanges(callback: () => void) {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.addEventListener) return () => undefined;
  mediaDevices.addEventListener("devicechange", callback);
  return () => mediaDevices.removeEventListener("devicechange", callback);
}

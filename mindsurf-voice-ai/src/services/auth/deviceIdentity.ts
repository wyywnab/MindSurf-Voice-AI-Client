import { isTauri } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_PATH = "device.json";
const DEVICE_ID_KEY = "deviceId";
let storePromise: Promise<Store> | null = null;

export async function getOrCreateDeviceId() {
  if (!isTauri()) return "browser-preview-device";
  const store = await (storePromise ??= load(STORE_PATH, { autoSave: 100 }));
  const stored = await store.get<unknown>(DEVICE_ID_KEY);
  if (typeof stored === "string" && stored.length >= 1 && stored.length <= 128)
    return stored;
  const id = globalThis.crypto.randomUUID();
  await store.set(DEVICE_ID_KEY, id);
  await store.save();
  return id;
}

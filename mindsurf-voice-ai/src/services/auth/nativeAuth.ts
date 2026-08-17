import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";

export async function openSystemBrowser(url: string) {
  if (!isTauri()) {
    globalThis.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await openUrl(url);
}

export async function subscribeAuthCallbacks(handler: (url: string) => void) {
  if (!isTauri()) return () => undefined;
  const initial = await getCurrent();
  initial?.forEach(handler);
  return onOpenUrl((urls) => urls.forEach(handler));
}

export function parseAuthCallback(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "mindsurf:" ||
    url.hostname !== "auth" ||
    url.pathname !== "/callback"
  ) {
    return null;
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const state = url.searchParams.get("state");
  if (!state || (code ? Boolean(error) : !error)) return null;
  if (error && error !== "access_denied" && error !== "temporarily_unavailable")
    return null;
  return { code, error, state };
}

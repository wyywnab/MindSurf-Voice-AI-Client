import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { openUrl } from "@tauri-apps/plugin-opener";

export async function openSystemBrowser(url: string) {
  if (!isTauri()) {
    const opened = globalThis.open(url, "_blank", "noopener,noreferrer");
    if (!opened) throw new Error("浏览器窗口被拦截，请允许弹出窗口后重试");
    return;
  }
  try {
    await openUrl(url);
  } catch (error) {
    const browserError = new Error(`无法打开系统浏览器：${describeNativeError(error)}`);
    (browserError as Error & { cause: unknown }).cause = error;
    throw browserError;
  }
}

function describeNativeError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim()) return message;
    try {
      return JSON.stringify(error);
    } catch {
      // Fall through to the stable message below.
    }
  }
  return "系统未返回具体错误";
}

export async function subscribeAuthCallbacks(handler: (url: string) => void) {
  if (!isTauri()) return () => undefined;
  const delivered = new Set<string>();
  const deliver = (urls: string[] | null) => {
    urls?.forEach((url) => {
      if (delivered.has(url)) return;
      delivered.add(url);
      handler(url);
    });
  };
  const unlistenPlugin = await onOpenUrl(deliver);
  deliver(await getCurrent());

  return () => {
    unlistenPlugin();
  };
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

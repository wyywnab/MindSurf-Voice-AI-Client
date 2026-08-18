import { reactive, readonly } from "vue";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  message: string;
  type?: ToastType;
  title?: string;
  durationMs?: number;
}

export interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
  title?: string;
  durationMs: number;
}

const DEFAULT_DURATION_MS = 4_000;
const MAX_VISIBLE_TOASTS = 5;
const state = reactive<{ items: ToastItem[] }>({ items: [] });
const timers = new Map<number, ReturnType<typeof globalThis.setTimeout>>();
let nextToastId = 1;

export function showToast(options: ToastOptions | string) {
  const normalized = typeof options === "string" ? { message: options } : options;
  const message = normalized.message.trim();
  if (!message) return null;

  const item: ToastItem = {
    id: nextToastId++,
    message,
    type: normalized.type ?? "info",
    title: normalized.title?.trim() || undefined,
    durationMs: Math.max(0, normalized.durationMs ?? DEFAULT_DURATION_MS),
  };
  state.items.push(item);

  while (state.items.length > MAX_VISIBLE_TOASTS) {
    dismissToast(state.items[0]!.id);
  }
  if (item.durationMs > 0) {
    timers.set(
      item.id,
      globalThis.setTimeout(() => dismissToast(item.id), item.durationMs),
    );
  }
  return item.id;
}

export function dismissToast(id: number) {
  const timer = timers.get(id);
  if (timer) globalThis.clearTimeout(timer);
  timers.delete(id);
  const index = state.items.findIndex((item) => item.id === id);
  if (index >= 0) state.items.splice(index, 1);
}

export function clearToasts() {
  for (const timer of timers.values()) globalThis.clearTimeout(timer);
  timers.clear();
  state.items.splice(0);
}

export const toast = {
  success(message: string, options: Omit<ToastOptions, "message" | "type"> = {}) {
    return showToast({ ...options, message, type: "success" });
  },
  error(message: string, options: Omit<ToastOptions, "message" | "type"> = {}) {
    return showToast({ ...options, message, type: "error" });
  },
  warning(message: string, options: Omit<ToastOptions, "message" | "type"> = {}) {
    return showToast({ ...options, message, type: "warning" });
  },
  info(message: string, options: Omit<ToastOptions, "message" | "type"> = {}) {
    return showToast({ ...options, message, type: "info" });
  },
};

export function useToasts() {
  return readonly(state);
}

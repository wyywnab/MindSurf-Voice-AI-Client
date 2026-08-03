import { isTauri } from "@tauri-apps/api/core";
import {
  ask as nativeAsk,
  confirm as nativeConfirm,
  message as nativeMessage,
} from "@tauri-apps/plugin-dialog";
import { reactive, readonly } from "vue";
import { translate as t } from "./i18n";

export type SystemDialogKind = "info" | "warning" | "error";

export interface SystemDialogOptions {
  title?: string;
  kind?: SystemDialogKind;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface BrowserDialogRequest {
  id: number;
  type: "message" | "confirm" | "ask";
  message: string;
  title: string;
  kind: SystemDialogKind;
  confirmLabel: string;
  cancelLabel: string;
}

const browserDialogState = reactive<{
  current: BrowserDialogRequest | null;
}>({ current: null });
const browserDialogQueue: BrowserDialogRequest[] = [];
const browserDialogResolvers = new Map<number, (result: boolean) => void>();
let nextDialogId = 1;

function labels(type: BrowserDialogRequest["type"], options: SystemDialogOptions) {
  return {
    confirmLabel:
      options.confirmLabel ??
      (type === "ask" ? t("是") : type === "message" ? t("确定") : t("确认")),
    cancelLabel: options.cancelLabel ?? (type === "ask" ? t("否") : t("取消")),
  };
}

function showBrowserDialog(
  type: BrowserDialogRequest["type"],
  message: string,
  options: SystemDialogOptions,
) {
  const buttonLabels = labels(type, options);
  return new Promise<boolean>((resolve) => {
    const request: BrowserDialogRequest = {
      id: nextDialogId++,
      type,
      message,
      title: options.title ?? "MindSurf Voice AI",
      kind: options.kind ?? "info",
      ...buttonLabels,
    };
    browserDialogResolvers.set(request.id, resolve);
    browserDialogQueue.push(request);
    showNextBrowserDialog();
  });
}

function showNextBrowserDialog() {
  if (!browserDialogState.current) {
    browserDialogState.current = browserDialogQueue.shift() ?? null;
  }
}

export function resolveBrowserDialog(result: boolean) {
  const request = browserDialogState.current;
  if (!request) return;
  browserDialogResolvers.get(request.id)?.(result);
  browserDialogResolvers.delete(request.id);
  browserDialogState.current = null;
  showNextBrowserDialog();
}

export async function showMessage(text: string, options: SystemDialogOptions = {}) {
  if (isTauri()) {
    await nativeMessage(text, {
      title: options.title,
      kind: options.kind,
      buttons: { ok: options.confirmLabel ?? t("确定") },
    });
    return;
  }
  await showBrowserDialog("message", text, options);
}

export async function showConfirm(text: string, options: SystemDialogOptions = {}) {
  if (isTauri()) {
    return nativeConfirm(text, {
      title: options.title,
      kind: options.kind,
      okLabel: options.confirmLabel ?? t("确认"),
      cancelLabel: options.cancelLabel ?? t("取消"),
    });
  }
  return showBrowserDialog("confirm", text, options);
}

export async function showAsk(text: string, options: SystemDialogOptions = {}) {
  if (isTauri()) {
    return nativeAsk(text, {
      title: options.title,
      kind: options.kind,
      okLabel: options.confirmLabel ?? t("是"),
      cancelLabel: options.cancelLabel ?? t("否"),
    });
  }
  return showBrowserDialog("ask", text, options);
}

export function useBrowserDialog() {
  return readonly(browserDialogState);
}

import { modifierForCode, normalizeShortcutBinding } from "./shortcutBinding";

export interface ShortcutRecordingOptions {
  onPreview: (binding: string) => void;
  timeoutMs?: number;
  signal?: InstanceType<typeof globalThis.AbortController>["signal"];
}

export function recordShortcutBinding(
  options: ShortcutRecordingOptions,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const pressedModifiers = new Set<string>();
    const recordedModifiers = new Set<string>();
    let settled = false;
    const finish = (binding: string | null) => {
      if (settled) return;
      settled = true;
      globalThis.removeEventListener("keydown", onKeyDown, true);
      globalThis.removeEventListener("keyup", onKeyUp, true);
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      resolve(binding);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      globalThis.removeEventListener("keydown", onKeyDown, true);
      globalThis.removeEventListener("keyup", onKeyUp, true);
      options.signal?.removeEventListener("abort", onAbort);
      clearTimeout(timeout);
      reject(error);
    };
    const onAbort = () => finish(null);
    const preview = (code?: string | null) => {
      try {
        const binding = normalizeShortcutBinding({
          modifiers: recordedModifiers,
          code,
        });
        options.onPreview(binding);
        return binding;
      } catch {
        return null;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const modifier = modifierForCode(event.code);
      if (modifier) {
        pressedModifiers.add(modifier);
        recordedModifiers.add(modifier);
        preview();
        return;
      }
      if (event.code === "Escape") {
        finish(null);
        return;
      }
      try {
        const binding = normalizeShortcutBinding({
          modifiers: pressedModifiers,
          code: event.code,
        });
        options.onPreview(binding);
        finish(binding);
      } catch (error) {
        fail(error);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      const modifier = modifierForCode(event.code);
      if (!modifier) return;
      pressedModifiers.delete(modifier);
      if (pressedModifiers.size === 0) {
        const binding = preview();
        if (binding) finish(binding);
      }
    };
    globalThis.addEventListener("keydown", onKeyDown, true);
    globalThis.addEventListener("keyup", onKeyUp, true);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => finish(null), options.timeoutMs ?? 15_000);
    if (options.signal?.aborted) finish(null);
  });
}

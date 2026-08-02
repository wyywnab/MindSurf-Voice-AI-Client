import type { ShortcutBinding } from "../types/shortcut";

const MODIFIER_ORDER = ["shift", "control", "alt", "super"] as const;
const MODIFIER_CODES = new Map<string, string>([
  ["ShiftLeft", "shift"],
  ["ShiftRight", "shift"],
  ["ControlLeft", "control"],
  ["ControlRight", "control"],
  ["AltLeft", "alt"],
  ["AltRight", "alt"],
  ["MetaLeft", "super"],
  ["MetaRight", "super"],
] as const);
const ALLOWED_KEYS =
  /^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-2])|Space|Enter|Tab|Backspace|Delete|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Comma|Period|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/;

export class ShortcutBindingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ShortcutBindingError";
  }
}

export function normalizeShortcutBinding(input: {
  modifiers: Iterable<string>;
  code?: string | null;
}): ShortcutBinding {
  const modifiers = new Set(input.modifiers);
  const normalizedModifiers = MODIFIER_ORDER.filter((modifier) =>
    modifiers.has(modifier),
  );
  const code = input.code && !MODIFIER_CODES.has(input.code) ? input.code : null;
  if (code && !ALLOWED_KEYS.test(code)) {
    throw new ShortcutBindingError(
      "shortcut_key_unsupported",
      "该按键暂不支持全局绑定",
    );
  }
  if (normalizedModifiers.length === 0) {
    throw new ShortcutBindingError(
      "shortcut_modifier_required",
      "快捷键必须包含至少一个修饰键",
    );
  }
  if (!code && normalizedModifiers.length < 2) {
    throw new ShortcutBindingError(
      "shortcut_modifier_only_invalid",
      "仅修饰键组合至少需要两个修饰键",
    );
  }
  return [...normalizedModifiers, ...(code ? [code] : [])].join("+");
}

export function parseShortcutBinding(binding: string) {
  const parts = binding.split("+").filter(Boolean);
  const modifiers = parts.filter((part) =>
    (MODIFIER_ORDER as readonly string[]).includes(part),
  );
  const keys = parts.filter(
    (part) => !(MODIFIER_ORDER as readonly string[]).includes(part),
  );
  if (keys.length > 1 || modifiers.length + keys.length !== parts.length) {
    throw new ShortcutBindingError("shortcut_invalid", "快捷键格式无效");
  }
  const normalized = normalizeShortcutBinding({
    modifiers,
    code: keys[0] ?? null,
  });
  if (normalized !== binding) {
    throw new ShortcutBindingError("shortcut_invalid", "快捷键未规范化");
  }
  return { modifiers, code: keys[0] ?? null };
}

export function formatShortcutBinding(binding: string, platform: string) {
  const { modifiers, code } = parseShortcutBinding(binding);
  const isMacOS = platform === "macos";
  const labels: Record<string, string> = {
    shift: isMacOS ? "Shift" : "Shift",
    control: isMacOS ? "Control" : "Ctrl",
    alt: isMacOS ? "Option" : "Alt",
    super: isMacOS ? "Command" : platform === "windows" ? "Win" : "Super",
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
  };
  return [...modifiers.map((modifier) => labels[modifier] ?? modifier), code]
    .filter(Boolean)
    .map((part) => labels[part ?? ""] ?? part?.replace(/^Key/, ""))
    .join(" + ");
}

export function validateShortcutBinding(
  binding: string,
  platform: string,
  bindingsByAction: Record<string, string>,
  currentAction: string,
) {
  parseShortcutBinding(binding);
  for (const [action, existing] of Object.entries(bindingsByAction)) {
    if (action !== currentAction && existing === binding) {
      throw new ShortcutBindingError(
        "shortcut_internal_conflict",
        `该组合已用于“${action}”`,
      );
    }
  }
  const reserved = new Set(
    platform === "macos"
      ? ["super+KeyQ", "super+Space", "control+super+KeyQ"]
      : platform === "windows"
        ? ["alt+F4", "super+KeyL", "control+alt+Delete"]
        : ["control+alt+Delete"],
  );
  if (reserved.has(binding)) {
    throw new ShortcutBindingError(
      "shortcut_system_reserved",
      "该组合由系统保留，请录制其他组合",
    );
  }
  return binding;
}

export function modifierForCode(code: string) {
  return MODIFIER_CODES.get(code) ?? null;
}

export function defaultShortcutBinding(platform: string) {
  if (platform === "macos") return "control+super+Space";
  return "control+super";
}

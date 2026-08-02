import { describe, expect, it } from "vitest";

import {
  formatShortcutBinding,
  normalizeShortcutBinding,
  ShortcutBindingError,
  validateShortcutBinding,
} from "./shortcutBinding";

describe("shortcut binding", () => {
  it("normalizes modifiers and a physical key code", () => {
    const binding = normalizeShortcutBinding({
      modifiers: ["control", "shift"],
      code: "KeyR",
    });
    expect(binding).toBe("shift+control+KeyR");
    expect(formatShortcutBinding(binding, "windows")).toBe("Shift + Ctrl + R");
  });

  it("supports a modifier-only pair", () => {
    expect(normalizeShortcutBinding({ modifiers: ["super", "control"] })).toBe(
      "control+super",
    );
  });

  it("rejects system-reserved and application-conflicting bindings", () => {
    expect(() =>
      validateShortcutBinding("alt+F4", "windows", {}, "按住说话"),
    ).toThrowError(ShortcutBindingError);
    expect(() =>
      validateShortcutBinding(
        "control+KeyK",
        "windows",
        { 打开设置: "control+KeyK" },
        "按住说话",
      ),
    ).toThrowError(/打开设置/);
  });
});

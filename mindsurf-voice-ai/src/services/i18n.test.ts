import { afterEach, describe, expect, it } from "vitest";

import { setLocale, translate } from "./i18n";

describe("i18n", () => {
  afterEach(() => setLocale("zh-CN"));

  it("falls back to the Chinese source string", () => {
    setLocale("zh-CN");
    expect(translate("录音")).toBe("录音");
    expect(translate("服务端动态文案")).toBe("服务端动态文案");
  });

  it("translates messages and interpolates named parameters", () => {
    setLocale("en-US");
    expect(translate("录音")).toBe("Record");
    expect(translate("已保存：{value}", { value: "Control+Space" })).toBe(
      "Saved: Control+Space",
    );
  });
});

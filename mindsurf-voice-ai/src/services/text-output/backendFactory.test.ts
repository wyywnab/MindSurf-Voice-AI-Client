import { describe, expect, it } from "vitest";

import { createTextOutputBackend } from "./backendFactory";

describe("createTextOutputBackend", () => {
  it("selects direct injection and rejects the unimplemented input method", () => {
    expect(createTextOutputBackend().kind).toBe("direct_injection");
    expect(() => createTextOutputBackend("input_method")).toThrow(
      "文本输出 Backend 尚不可用",
    );
  });
});

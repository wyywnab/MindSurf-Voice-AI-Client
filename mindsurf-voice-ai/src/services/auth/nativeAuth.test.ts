import { describe, expect, it } from "vitest";
import { parseAuthCallback } from "./nativeAuth";

describe("parseAuthCallback", () => {
  it("accepts exactly one supported result", () => {
    expect(parseAuthCallback("mindsurf://auth/callback?code=one&state=state")).toEqual({
      code: "one",
      error: null,
      state: "state",
    });
    expect(
      parseAuthCallback("mindsurf://auth/callback?error=access_denied&state=state"),
    ).toEqual({ code: null, error: "access_denied", state: "state" });
  });

  it("rejects wrong routes, missing state, mixed results, and unknown errors", () => {
    expect(parseAuthCallback("other://auth/callback?code=x&state=y")).toBeNull();
    expect(parseAuthCallback("mindsurf://auth/callback?code=x")).toBeNull();
    expect(
      parseAuthCallback("mindsurf://auth/callback?code=x&error=access_denied&state=y"),
    ).toBeNull();
    expect(parseAuthCallback("mindsurf://auth/callback?error=bad&state=y")).toBeNull();
  });
});

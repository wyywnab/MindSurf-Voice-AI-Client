import { afterEach, describe, expect, it, vi } from "vitest";
import { openSystemBrowser, parseAuthCallback } from "./nativeAuth";

afterEach(() => vi.unstubAllGlobals());

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

  it("reports when a browser preview blocks the login popup", async () => {
    vi.stubGlobal(
      "open",
      vi.fn(() => null),
    );

    await expect(openSystemBrowser("https://voice.example.com/login")).rejects.toThrow(
      "浏览器窗口被拦截",
    );
  });
});

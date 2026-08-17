import { describe, expect, it } from "vitest";
import { validateApiOrigin } from "./apiOrigin";

describe("validateApiOrigin", () => {
  it("accepts production HTTPS and loopback HTTP origins", () => {
    expect(validateApiOrigin("https://api.example.com")).toBe(
      "https://api.example.com",
    );
    expect(validateApiOrigin("http://127.0.0.1:8000/")).toBe("http://127.0.0.1:8000");
  });

  it("rejects remote HTTP, paths, credentials and query strings", () => {
    expect(() => validateApiOrigin("http://api.example.com")).toThrow();
    expect(() => validateApiOrigin("https://api.example.com/v2")).toThrow();
    expect(() => validateApiOrigin("https://user@api.example.com")).toThrow();
    expect(() => validateApiOrigin("https://api.example.com?q=1")).toThrow();
  });
});

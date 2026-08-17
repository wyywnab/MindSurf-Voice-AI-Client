import { describe, expect, it } from "vitest";
import { constantTimeEqual, createPkceAttempt, isValidVerifier } from "./pkce";

describe("PKCE", () => {
  it("creates RFC 7636 S256 material from at least 32 random bytes", async () => {
    const attempt = await createPkceAttempt(123);
    expect(attempt.createdAt).toBe(123);
    expect(attempt.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempt.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isValidVerifier(attempt.verifier)).toBe(true);
    expect(attempt.challenge).not.toBe(attempt.verifier);
  });

  it("compares state without early length or character exits", () => {
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "samf")).toBe(false);
    expect(constantTimeEqual("same", "same-longer")).toBe(false);
  });
});

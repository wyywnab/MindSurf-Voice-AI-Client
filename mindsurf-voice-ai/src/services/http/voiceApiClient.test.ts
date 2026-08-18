import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceApiClient, VoiceApiError, VoiceApiNetworkError } from "./voiceApiClient";

const requestId = "019d643e-1550-761a-b7a0-471791bcaf20";
const user = {
  user_id: "019d643e-1550-761a-b7a0-471791bcaf21",
  display_name: "Alice",
  login: "alice@example.com",
  status: "active",
  plan: "free",
  created_at_ms: 1,
};

describe("VoiceApiClient", () => {
  afterEach(() => vi.useRealTimers());

  it("adds the in-memory bearer token only to protected requests", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer access-secret",
      );
      return new Response(JSON.stringify({ request_id: requestId, data: user }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const api = new VoiceApiClient(
      "https://api.example.com",
      () => "access-secret",
      fetcher,
    );
    await expect(api.getCurrentUser()).resolves.toEqual(user);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reuses the caller's idempotency key and exact token body", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(requestId);
      expect(JSON.parse(String(init?.body))).toEqual({
        refresh_token: "refresh-secret",
      });
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      return new Response(
        JSON.stringify({
          request_id: requestId,
          data: {
            tokens: {
              token_type: "Bearer",
              access_token: "access",
              expires_in: 60,
              refresh_token: "rotated",
              refresh_expires_in: 120,
            },
            user,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const api = new VoiceApiClient("https://api.example.com", () => null, fetcher);
    await api.refresh("refresh-secret", requestId);
  });

  it("does not expose server messages or details in thrown errors", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            request_id: requestId,
            error: {
              code: "authentication_failed",
              message: "raw server stack and secret",
              retryable: false,
              details: { token: "secret" },
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
    );
    const api = new VoiceApiClient("https://api.example.com", () => null, fetcher);
    const error = await api
      .refresh("refresh-secret", requestId)
      .catch((value) => value);
    expect(error).toBeInstanceOf(VoiceApiError);
    expect(error.message).toBe("登录凭据无效，请重新登录");
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("aborts a request that exceeds the configured timeout", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const api = new VoiceApiClient(
      "https://api.example.com",
      () => "access-secret",
      fetcher,
      1_000,
    );

    const request = api.getCurrentUser();
    const rejection = expect(request).rejects.toMatchObject({
      name: "VoiceApiNetworkError",
      message: "服务请求超时，请检查网络后重试",
    } satisfies Partial<VoiceApiNetworkError>);
    await vi.advanceTimersByTimeAsync(1_000);

    await rejection;
  });
});

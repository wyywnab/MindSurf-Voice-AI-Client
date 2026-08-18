import type {
  ApiErrorPayload,
  AuthorizationCodeInput,
  Capabilities,
  Quota,
  UsageEntry,
  VoiceUser,
} from "../../types/httpApi";
import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { validateApiOrigin } from "./apiOrigin";
import {
  InvalidApiResponseError,
  parseAuthData,
  parseCapabilities,
  parseQuota,
  parseRealtimeTicket,
  parseUsageList,
  parseUser,
} from "./validators";

type Fetch = typeof globalThis.fetch;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

const desktopFetch: Fetch = (input, init) =>
  isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);

export class VoiceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    readonly requestId: string | null,
    message: string,
  ) {
    super(message);
    this.name = "VoiceApiError";
  }
}

export class VoiceApiNetworkError extends Error {
  readonly uncertain = true;
  constructor(message = "无法确认服务是否已处理请求", cause?: unknown) {
    super(message);
    this.name = "VoiceApiNetworkError";
    (this as Error & { cause?: unknown }).cause = cause;
  }
}

export class VoiceApiClient {
  readonly origin: string;

  constructor(
    origin: string,
    private readonly accessToken: () => string | null,
    private readonly fetchImpl: Fetch = desktopFetch,
    private readonly requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.origin = validateApiOrigin(origin);
  }

  authorizeUrl(input: {
    codeChallenge: string;
    state: string;
    prompt?: "login" | "select_account";
  }) {
    const url = new URL("/v2/auth/authorize", this.origin);
    url.searchParams.set("client_id", "mindsurf-desktop");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", "mindsurf://auth/callback");
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", input.state);
    if (input.prompt) url.searchParams.set("prompt", input.prompt);
    return url.toString();
  }

  async exchangeAuthorizationCode(
    body: AuthorizationCodeInput,
    idempotencyKey: string,
  ) {
    return this.request(
      "/v2/auth/token",
      { method: "POST", body, idempotencyKey, protected: false },
      parseAuthData,
    );
  }

  async refresh(refreshToken: string, idempotencyKey: string) {
    return this.request(
      "/v2/auth/refresh",
      {
        method: "POST",
        body: { refresh_token: refreshToken },
        idempotencyKey,
        protected: false,
      },
      parseAuthData,
    );
  }

  async logout() {
    await this.rawRequest("/v2/auth/logout", {
      method: "POST",
      protected: true,
      expectEmpty: true,
    });
  }

  async getCurrentUser(): Promise<VoiceUser> {
    return this.request("/v2/users/me", { method: "GET", protected: true }, parseUser);
  }

  async getQuota(): Promise<Quota> {
    return this.request("/v2/quota", { method: "GET", protected: true }, parseQuota);
  }

  async getCapabilities(): Promise<Capabilities> {
    return this.request(
      "/v2/capabilities",
      { method: "GET", protected: true },
      parseCapabilities,
    );
  }

  async createRealtimeTicket() {
    return this.request(
      "/v2/realtime/tickets",
      { method: "POST", protected: true },
      parseRealtimeTicket,
    );
  }

  async listUsagePage(query: {
    fromMs: number;
    toMs: number;
    limit?: number;
    cursor?: string;
  }) {
    if (
      !Number.isSafeInteger(query.fromMs) ||
      !Number.isSafeInteger(query.toMs) ||
      query.fromMs < 0 ||
      query.toMs <= query.fromMs
    ) {
      throw new Error("用量查询时间区间无效");
    }
    const url = new URL("/v2/usage", this.origin);
    url.searchParams.set("from_ms", String(query.fromMs));
    url.searchParams.set("to_ms", String(query.toMs));
    if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
    if (query.cursor) url.searchParams.set("cursor", query.cursor);
    return this.requestUrl(url, { method: "GET", protected: true }, parseUsageList);
  }

  async listAllUsage(query: {
    fromMs: number;
    toMs: number;
    limit?: number;
  }): Promise<UsageEntry[]> {
    const items: UsageEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listUsagePage({ ...query, cursor });
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return items;
  }

  private async request<T>(
    path: string,
    options: RequestOptions,
    parse: (data: unknown) => T,
  ): Promise<T> {
    return this.requestUrl(new URL(path, this.origin), options, parse);
  }

  private async requestUrl<T>(
    url: URL,
    options: RequestOptions,
    parse: (data: unknown) => T,
  ) {
    const value = await this.rawRequest(url, options);
    const envelope = asRecord(value);
    if (
      Object.keys(envelope).length !== 2 ||
      typeof envelope.request_id !== "string" ||
      !isUuid(envelope.request_id) ||
      !("data" in envelope)
    ) {
      throw new InvalidApiResponseError("服务响应信封无效");
    }
    return parse(envelope.data);
  }

  private async rawRequest(
    path: string | URL,
    options: RequestOptions,
  ): Promise<unknown> {
    const headers = new Headers({ Accept: "application/json" });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    if (options.protected) {
      const token = this.accessToken();
      if (!token)
        throw new VoiceApiError(
          401,
          "authentication_required",
          false,
          null,
          "需要登录",
        );
      headers.set("Authorization", `Bearer ${token}`);
    }
    let response: Response;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(),
      this.requestTimeoutMs,
    );
    try {
      response = await this.fetchImpl(new URL(path, this.origin), {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new VoiceApiNetworkError("服务请求超时，请检查网络后重试", error);
      }
      throw new VoiceApiNetworkError(describeNetworkFailure(error), error);
    } finally {
      globalThis.clearTimeout(timeout);
    }
    if (options.expectEmpty && response.status === 204) return undefined;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new InvalidApiResponseError("服务返回了无法解析的响应");
    }
    if (!response.ok) throw parseApiError(response.status, payload);
    return payload;
  }
}

function describeNetworkFailure(error: unknown) {
  const detail =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "系统未返回具体错误";
  return `无法确认服务是否已处理请求：${detail.slice(0, 240)}`;
}

interface RequestOptions {
  method: "GET" | "POST";
  protected: boolean;
  body?: unknown;
  idempotencyKey?: string;
  expectEmpty?: boolean;
}

function parseApiError(status: number, value: unknown) {
  const envelope = asRecord(value);
  const error = asRecord(envelope.error) as Partial<ApiErrorPayload>;
  if (
    Object.keys(envelope).length !== 2 ||
    typeof envelope.request_id !== "string" ||
    !isUuid(envelope.request_id) ||
    typeof error.code !== "string" ||
    typeof error.message !== "string" ||
    typeof error.retryable !== "boolean" ||
    Object.keys(error).length !== 4 ||
    typeof error.details !== "object" ||
    error.details === null ||
    Array.isArray(error.details)
  ) {
    throw new InvalidApiResponseError("服务错误响应信封无效");
  }
  return new VoiceApiError(
    status,
    error.code,
    error.retryable,
    envelope.request_id,
    safeErrorMessage(error.code),
  );
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function safeErrorMessage(code: string) {
  const messages: Record<string, string> = {
    account_suspended: "账户已暂停，请联系支持",
    authentication_expired: "登录已过期，请重新登录",
    authentication_failed: "登录凭据无效，请重新登录",
    authorization_grant_invalid: "授权已失效，请重新登录",
    idempotency_conflict: "请求恢复信息冲突，请重新登录",
    idempotency_result_expired: "无法恢复登录结果，请重新登录",
    rate_limit_exceeded: "操作过于频繁，请稍后重试",
    refresh_token_reused: "检测到登录凭据重放，请重新登录",
    service_unavailable: "服务暂时不可用，请稍后重试",
  };
  return messages[code] ?? `服务请求失败（${code}）`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidApiResponseError("服务响应不是 JSON object");
  }
  return value as Record<string, unknown>;
}

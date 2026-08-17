import type { AuthData } from "../../types/httpApi";
import {
  clearRefreshToken,
  readRefreshToken,
  saveRefreshToken,
} from "../settings/credentials";
import {
  VoiceApiClient,
  VoiceApiError,
  VoiceApiNetworkError,
} from "../http/voiceApiClient";

const REFRESH_RECOVERY_WINDOW_MS = 120_000;
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];

export class ReauthenticationRequiredError extends Error {
  constructor(message = "登录状态无法安全恢复，请重新登录") {
    super(message);
    this.name = "ReauthenticationRequiredError";
  }
}

export class TokenManager {
  private accessToken: string | null = null;
  private accessExpiresAt = 0;
  private refreshInFlight: Promise<AuthData | null> | null = null;

  constructor(private readonly api: VoiceApiClient) {}

  getAccessToken() {
    return this.accessToken;
  }

  hasUsableAccessToken(now = Date.now()) {
    return Boolean(this.accessToken) && now + 30_000 < this.accessExpiresAt;
  }

  async acceptAuthData(data: AuthData) {
    try {
      await saveRefreshToken(data.tokens.refresh_token);
    } catch {
      this.clearAccessToken();
      try {
        await clearRefreshToken();
      } catch {
        // The original Keychain failure remains the actionable condition.
      }
      throw new ReauthenticationRequiredError("无法安全保存登录凭据，请重新登录");
    }
    this.accessToken = data.tokens.access_token;
    this.accessExpiresAt = Date.now() + data.tokens.expires_in * 1_000;
  }

  async restore(): Promise<AuthData | null> {
    return this.refresh();
  }

  async refresh(): Promise<AuthData | null> {
    this.refreshInFlight ??= this.performRefresh().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  async clear() {
    this.accessToken = null;
    this.accessExpiresAt = 0;
    await clearRefreshToken();
  }

  clearAccessToken() {
    this.accessToken = null;
    this.accessExpiresAt = 0;
  }

  private async performRefresh(): Promise<AuthData | null> {
    const refreshToken = await readRefreshToken();
    if (!refreshToken) return null;
    const idempotencyKey = globalThis.crypto.randomUUID();
    const startedAt = Date.now();
    let attempt = 0;
    while (true) {
      try {
        const data = await this.api.refresh(refreshToken, idempotencyKey);
        await this.acceptAuthData(data);
        return data;
      } catch (error) {
        if (
          error instanceof VoiceApiError &&
          [
            "account_suspended",
            "authentication_failed",
            "idempotency_conflict",
            "idempotency_result_expired",
            "refresh_token_reused",
          ].includes(error.code)
        ) {
          await this.clear();
          throw new ReauthenticationRequiredError();
        }
        if (
          !(error instanceof VoiceApiNetworkError) ||
          Date.now() - startedAt >= REFRESH_RECOVERY_WINDOW_MS
        ) {
          if (error instanceof VoiceApiNetworkError) {
            await this.clear();
            throw new ReauthenticationRequiredError();
          }
          throw error;
        }
        await delay(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
        attempt += 1;
      }
    }
  }
}

function delay(ms: number) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

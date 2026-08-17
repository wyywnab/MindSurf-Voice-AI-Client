import type { AppInfo } from "../types/app";
import type { AuthorizationCodeInput } from "../types/httpApi";
import { accountStoreActions } from "../stores/accountStore";
import { authStoreActions } from "../stores/authStore";
import { capabilitiesStoreActions } from "../stores/capabilitiesStore";
import { quotaStoreActions } from "../stores/quotaStore";
import { settingsStoreActions, useSettingsStore } from "../stores/settingsStore";
import { diagnosticsStoreActions } from "../stores/diagnosticsStore";
import { getOrCreateDeviceId } from "../services/auth/deviceIdentity";
import {
  openSystemBrowser,
  parseAuthCallback,
  subscribeAuthCallbacks,
} from "../services/auth/nativeAuth";
import {
  constantTimeEqual,
  createPkceAttempt,
  type PkceAttempt,
} from "../services/auth/pkce";
import {
  ReauthenticationRequiredError,
  TokenManager,
} from "../services/auth/tokenManager";
import { getRefreshTokenStatus } from "../services/settings/credentials";
import { VoiceApiClient, VoiceApiNetworkError } from "../services/http/voiceApiClient";
import { RealtimeTicketProvider } from "../services/realtime/realtimeTicketProvider";
import { realtimeConnectionController } from "./realtimeConnectionController";

const AUTH_TIMEOUT_MS = 15 * 60_000;
const TOKEN_RECOVERY_WINDOW_MS = 120_000;
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000];

export class AuthController {
  private api: VoiceApiClient | null = null;
  private tokens: TokenManager | null = null;
  private appInfo: AppInfo | null = null;
  private attempt: PkceAttempt | null = null;
  private attemptTimer: ReturnType<typeof setTimeout> | null = null;
  private authorizeInFlight: Promise<void> | null = null;
  private exchangeInFlight: Promise<void> | null = null;
  private initializationInFlight: Promise<void> | null = null;
  private logoutInFlight: Promise<void> | null = null;
  private accountRefreshInFlight: Promise<void> | null = null;
  private unsubscribeDeepLinks: (() => void) | null = null;
  private readonly settings = useSettingsStore();

  getAccessToken = () => this.tokens?.getAccessToken() ?? null;

  async initialize(appInfo: AppInfo) {
    this.appInfo = appInfo;
    this.configureApi();
    this.unsubscribeDeepLinks ??= await subscribeAuthCallbacks((url) => {
      void this.handleCallback(url);
    });
    this.initializationInFlight ??= this.restoreSession().finally(() => {
      this.initializationInFlight = null;
    });
    return this.initializationInFlight;
  }

  async startAuthorization(prompt?: "login" | "select_account") {
    if (this.attempt) return;
    if (this.authorizeInFlight) return this.authorizeInFlight;
    this.authorizeInFlight = this.beginAuthorization(prompt).finally(() => {
      this.authorizeInFlight = null;
    });
    return this.authorizeInFlight;
  }

  async refreshAccount() {
    this.accountRefreshInFlight ??= this.performAccountRefresh().finally(() => {
      this.accountRefreshInFlight = null;
    });
    return this.accountRefreshInFlight;
  }

  private async performAccountRefresh() {
    const { api, tokens } = this.requireConfigured();
    if (!tokens.hasUsableAccessToken()) {
      authStoreActions.setStatus("restoring");
      const restored = await tokens.refresh();
      if (!restored) {
        authStoreActions.setStatus("signed_out", "请先登录");
        return;
      }
    }
    await this.loadAccountData(api);
  }

  async logout() {
    if (this.logoutInFlight) return this.logoutInFlight;
    this.logoutInFlight = this.performLogout().finally(() => {
      this.logoutInFlight = null;
    });
    return this.logoutInFlight;
  }

  async changeApiOrigin(origin: string) {
    if (origin === this.settings.state.voiceApiOrigin) return;
    await this.performLogout();
    settingsStoreActions.setVoiceApiOrigin(origin);
    this.configureApi();
  }

  dispose() {
    realtimeConnectionController.disconnect();
    this.clearAttempt();
    this.unsubscribeDeepLinks?.();
    this.unsubscribeDeepLinks = null;
  }

  private configureApi() {
    const api = new VoiceApiClient(
      this.settings.state.voiceApiOrigin,
      () => this.tokens?.getAccessToken() ?? null,
    );
    this.api = api;
    this.tokens = new TokenManager(api);
    realtimeConnectionController.configure(
      new RealtimeTicketProvider(api, this.tokens),
      {
        version: this.appInfo!.version,
        platform: this.appInfo!.platform,
        arch: this.appInfo!.arch,
      },
      () => void this.handleSessionRevoked(),
      () => void this.refreshAccount(),
    );
  }

  private async restoreSession() {
    const { api, tokens } = this.requireConfigured();
    authStoreActions.setRefreshTokenConfigured(await getRefreshTokenStatus());
    authStoreActions.setStatus("restoring");
    try {
      const restored = await tokens.restore();
      if (!restored) {
        authStoreActions.setStatus("signed_out");
        return;
      }
      accountStoreActions.setUser(restored.user);
      authStoreActions.setRefreshTokenConfigured(true);
      await this.loadAccountData(api);
    } catch (error) {
      if (error instanceof ReauthenticationRequiredError) {
        this.clearAccountState();
        authStoreActions.setStatus("signed_out", error.message);
        return;
      }
      authStoreActions.setStatus("error", describeError(error));
    }
  }

  private async beginAuthorization(prompt?: "login" | "select_account") {
    const { api } = this.requireConfigured();
    this.clearAttempt();
    this.attempt = await createPkceAttempt();
    this.attemptTimer = globalThis.setTimeout(() => {
      this.clearAttempt();
      authStoreActions.setStatus("error", "登录等待已超时，请重试");
    }, AUTH_TIMEOUT_MS);
    authStoreActions.setStatus("authorizing");
    diagnosticsStoreActions.log(
      "info",
      "auth",
      "auth.browser_opened",
      "已打开系统浏览器进行登录",
    );
    try {
      await openSystemBrowser(
        api.authorizeUrl({
          codeChallenge: this.attempt.challenge,
          state: this.attempt.state,
          prompt,
        }),
      );
    } catch (error) {
      this.clearAttempt();
      authStoreActions.setStatus("error", describeError(error));
      throw error;
    }
  }

  private async handleCallback(value: string) {
    const callback = parseAuthCallback(value);
    const attempt = this.attempt;
    if (!callback || !attempt || Date.now() - attempt.createdAt > AUTH_TIMEOUT_MS) {
      diagnosticsStoreActions.log(
        "warn",
        "auth",
        "auth.callback_ignored",
        "已忽略无效或过期的登录回跳",
      );
      return;
    }
    if (!constantTimeEqual(callback.state, attempt.state)) {
      diagnosticsStoreActions.log(
        "warn",
        "auth",
        "auth.state_mismatch",
        "已忽略 state 不匹配的登录回跳",
      );
      return;
    }
    this.clearAttempt();
    if (callback.error) {
      authStoreActions.setStatus(
        callback.error === "access_denied" ? "signed_out" : "error",
        callback.error === "access_denied" ? "登录已取消" : "认证服务暂时不可用",
      );
      return;
    }
    if (!callback.code || this.exchangeInFlight) return;
    this.exchangeInFlight = this.exchangeCode(callback.code, attempt.verifier).finally(
      () => {
        this.exchangeInFlight = null;
      },
    );
    await this.exchangeInFlight;
  }

  private async exchangeCode(code: string, verifier: string) {
    const { api, tokens } = this.requireConfigured();
    const appInfo = this.appInfo!;
    const body: AuthorizationCodeInput = {
      grant_type: "authorization_code",
      client_id: "mindsurf-desktop",
      code,
      code_verifier: verifier,
      redirect_uri: "mindsurf://auth/callback",
      device: {
        id: await getOrCreateDeviceId(),
        name: "MindSurf Desktop",
        platform: appInfo.platform,
        app_version: appInfo.version,
      },
    };
    const idempotencyKey = globalThis.crypto.randomUUID();
    authStoreActions.setStatus("exchanging");
    try {
      const data = await retryUncertain(
        () => api.exchangeAuthorizationCode(body, idempotencyKey),
        TOKEN_RECOVERY_WINDOW_MS,
      );
      await tokens.acceptAuthData(data);
      accountStoreActions.setUser(data.user);
      authStoreActions.setRefreshTokenConfigured(true);
      await this.loadAccountData(api);
    } catch (error) {
      await tokens.clear();
      this.clearAccountState();
      authStoreActions.setStatus("error", describeError(error));
    }
  }

  private async loadAccountData(api: VoiceApiClient) {
    authStoreActions.setStatus("loading_account");
    quotaStoreActions.setLoading();
    capabilitiesStoreActions.setLoading();
    try {
      const [user, quota, capabilities] = await Promise.all([
        api.getCurrentUser(),
        api.getQuota(),
        api.getCapabilities(),
      ]);
      accountStoreActions.setUser(user);
      quotaStoreActions.setQuota(quota);
      capabilitiesStoreActions.setCapabilities(capabilities);
      if (!capabilitiesStoreActions.selectMode(this.settings.state.selectedMode)) {
        capabilitiesStoreActions.requireCurrentSelectionConfirmation(
          "保存的请求模式已不可用，请确认新的模式选择",
        );
      }
      authStoreActions.setStatus("authenticated");
      void realtimeConnectionController.connect();
    } catch (error) {
      const message = describeError(error);
      quotaStoreActions.setError(message);
      capabilitiesStoreActions.invalidate(message);
      authStoreActions.setStatus("error", message);
      throw error;
    }
  }

  private async performLogout(callServer = true) {
    const { api, tokens } = this.requireConfigured();
    authStoreActions.setStatus("signing_out");
    try {
      if (callServer && tokens.getAccessToken()) await api.logout();
    } catch (error) {
      diagnosticsStoreActions.log(
        "warn",
        "auth",
        "auth.logout_unconfirmed",
        "服务端登出结果未确认，已清除本地登录态",
        {
          fields: { reason: error instanceof Error ? error.name : "unknown" },
        },
      );
    } finally {
      realtimeConnectionController.disconnect();
      await tokens.clear();
      this.clearAttempt();
      this.clearAccountState();
      authStoreActions.setRefreshTokenConfigured(false);
      authStoreActions.setStatus("signed_out");
    }
  }

  private async handleSessionRevoked() {
    diagnosticsStoreActions.log(
      "warn",
      "auth",
      "auth.session_revoked",
      "服务端已撤销当前登录 session",
    );
    await this.performLogout(false);
    authStoreActions.setStatus("signed_out", "登录已被服务端撤销，请重新登录");
  }

  private clearAccountState() {
    accountStoreActions.setUser(null);
    quotaStoreActions.setQuota(null);
    capabilitiesStoreActions.setCapabilities(null);
  }

  private clearAttempt() {
    if (this.attemptTimer) globalThis.clearTimeout(this.attemptTimer);
    this.attemptTimer = null;
    this.attempt = null;
  }

  private requireConfigured() {
    if (!this.api || !this.tokens || !this.appInfo)
      throw new Error("认证服务尚未初始化");
    return { api: this.api, tokens: this.tokens };
  }
}

async function retryUncertain<T>(operation: () => Promise<T>, windowMs: number) {
  const startedAt = Date.now();
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof VoiceApiNetworkError) ||
        Date.now() - startedAt >= windowMs
      )
        throw error;
      await new Promise((resolve) =>
        globalThis.setTimeout(
          resolve,
          RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!,
        ),
      );
      attempt += 1;
    }
  }
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : "登录操作失败";
}

export const authController = new AuthController();

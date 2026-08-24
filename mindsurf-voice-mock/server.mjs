import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";
import { parseFaultConfiguration, printFaultHelp } from "./faults.mjs";

export const SUBPROTOCOL = "mindsurf.voice.v2";
export const WEBSOCKET_PATH = "/v2/voice/ws";
export const CAPABILITIES_REVISION = "mock-cap-2026-08-17-1";

const ACCESS_LIFETIME_SECONDS = 900;
const REFRESH_LIFETIME_SECONDS = 86_400;
const TICKET_LIFETIME_MS = 30_000;
const MAX_CONTROL_BYTES = 65_536;
const MAX_BINARY_BYTES = 65_584;
const MAX_RECORDING_MS = 120_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;
const INPUT_IDLE_TIMEOUT_MS = 10_000;
const POLISH_PROMPT_MAX_CODE_POINTS = 4_000;
const POLISH_PROMPT_MAX_UTF8_BYTES = 16_384;
const DEFAULT_POLISH_PROMPT =
  "请在保持原意的前提下，使文本更加通顺、简洁、自然。";
const USER = Object.freeze({
  user_id: "019d643e-1550-761a-b7a0-471791bcaf01",
  display_name: "Local Mock User",
  login: "mock@mindsurf.local",
  status: "active",
  plan: "mock",
  created_at_ms: 1_786_723_200_000,
});

const CAPABILITIES = Object.freeze({
  protocol_version: 2,
  revision: CAPABILITIES_REVISION,
  realtime: {
    websocket_path: WEBSOCKET_PATH,
    ticket_path: "/v2/realtime/tickets",
    subprotocol: SUBPROTOCOL,
    persistent: true,
  },
  modes: ["asr_only", "asr_llm"],
  pipelines: [
    {
      id: "mock-text-pipeline",
      name: "Mock Text Pipeline",
      description: "Deterministic local ASR and LLM text processing",
      modes: ["asr_only", "asr_llm"],
      max_recording_ms: 120_000,
      asr_options: ["mock-asr"],
      llm_options: ["mock-llm"],
      generation_controls: {
        temperature: { type: "number", minimum: 0, maximum: 1, default: 0.2 },
        max_tokens: { type: "integer", minimum: 1, maximum: 512, default: 128 },
      },
    },
  ],
  asr_options: [{ id: "mock-asr", name: "Mock ASR" }],
  llm_options: [{ id: "mock-llm", name: "Mock LLM" }],
  recognition_languages: ["auto", "zh-CN", "en-US"],
  defaults: {
    asr_only: {
      pipeline: "mock-text-pipeline",
      selection: { asr: "mock-asr", llm: null },
    },
    asr_llm: {
      pipeline: "mock-text-pipeline",
      selection: { asr: "mock-asr", llm: "mock-llm" },
    },
  },
});

export function createMockServer(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8000;
  const faults = options.faults ?? parseFaultConfiguration();
  const state = createState(faults);
  const websocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols(protocols) {
      return protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false;
    },
  });
  const server = createHttpServer((request, response) => {
    void handleHttpRequest(state, request, response).catch((error) => {
      console.error("Mock HTTP request failed:", safeErrorName(error));
      if (!response.headersSent) {
        sendHttpError(
          response,
          500,
          "server_error",
          "Mock internal error",
          true,
        );
      } else response.destroy();
    });
  });

  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(state, websocketServer, request, socket, head);
  });
  websocketServer.on("connection", (socket) => handleWebSocket(state, socket));

  return {
    host,
    port,
    state,
    async start() {
      await new Promise((resolveStart, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolveStart();
        });
      });
      const address = server.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async close() {
      for (const client of websocketServer.clients) client.terminate();
      await new Promise((resolveClose, reject) =>
        server.close((error) => (error ? reject(error) : resolveClose())),
      );
    },
  };
}

function createState(faults) {
  return {
    faults,
    authorizationCodes: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    rotatedRefreshTokens: new Set(),
    idempotency: new Map(),
    polishPrompt: {
      custom: null,
      defaultRevision: "polish-prompt-default-1",
      defaultUpdatedAtMs: Date.now(),
    },
    tickets: new Map(),
    usedRequestIds: new Set(),
    usage: [],
    creditsLimit: 10_000,
    creditsUsed: 0,
    creditsReserved: 0,
    destroyedTokenResponse: false,
    destroyedRefreshResponse: false,
    destroyedPolishPromptResponse: false,
  };
}

async function handleHttpRequest(state, request, response) {
  const url = new URL(request.url ?? "/", "http://mock.local");
  if (request.method === "GET" && url.pathname === "/v2/auth/authorize") {
    return authorize(state, url, response);
  }
  if (request.method === "POST" && url.pathname === "/v2/auth/token") {
    return exchangeToken(state, request, response);
  }
  if (request.method === "POST" && url.pathname === "/v2/auth/refresh") {
    return refreshToken(state, request, response);
  }

  const session = authenticate(state, request, response);
  if (!session) return;
  if (request.method === "POST" && url.pathname === "/v2/auth/logout") {
    revokeSession(state, session.sessionId);
    response.writeHead(204).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/v2/users/me") {
    return sendData(response, USER);
  }
  if (url.pathname === "/v2/users/me/polish-prompt") {
    if (request.method === "GET") {
      return getPolishPrompt(state, response);
    }
    if (request.method === "PUT") {
      return setPolishPrompt(state, request, response);
    }
    if (request.method === "DELETE") {
      return resetPolishPrompt(state, request, response);
    }
  }
  if (request.method === "GET" && url.pathname === "/v2/quota") {
    return sendData(response, quotaFor(state));
  }
  if (request.method === "GET" && url.pathname === "/v2/usage") {
    return listUsage(state, url, response);
  }
  if (request.method === "GET" && url.pathname === "/v2/capabilities") {
    return sendData(response, CAPABILITIES);
  }
  if (request.method === "POST" && url.pathname === "/v2/realtime/tickets") {
    return issueTicket(state, session, response);
  }
  sendHttpError(response, 404, "invalid_request", "Unknown API route", false);
}

function authorize(state, url, response) {
  const stateValue = url.searchParams.get("state") ?? "";
  const challenge = url.searchParams.get("code_challenge") ?? "";
  const valid =
    url.searchParams.get("client_id") === "mindsurf-desktop" &&
    url.searchParams.get("response_type") === "code" &&
    url.searchParams.get("redirect_uri") === "mindsurf://auth/callback" &&
    url.searchParams.get("code_challenge_method") === "S256" &&
    /^[A-Za-z0-9_-]{43}$/.test(challenge) &&
    /^[A-Za-z0-9_-]{43,512}$/.test(stateValue) &&
    (!url.searchParams.has("prompt") ||
      ["login", "select_account"].includes(url.searchParams.get("prompt")));
  if (!valid) {
    sendHttpError(
      response,
      400,
      "invalid_request",
      "Invalid authorization request",
      false,
    );
    return;
  }
  const decision = url.searchParams.get("decision");
  if (!decision) {
    sendAuthorizationPage(url, response);
    return;
  }
  if (decision !== "approve" && decision !== "cancel") {
    sendHttpError(
      response,
      400,
      "invalid_request",
      "Invalid authorization decision",
      false,
    );
    return;
  }
  const callback = new URL("mindsurf://auth/callback");
  callback.searchParams.set("state", stateValue);
  if (decision === "cancel" || hasFault(state, "authorize_rejected")) {
    callback.searchParams.set("error", "access_denied");
  } else {
    const code = opaqueToken(32);
    state.authorizationCodes.set(code, {
      challenge,
      expiresAtMs: Date.now() + 60_000,
    });
    callback.searchParams.set("code", code);
  }
  sendCallbackPage(callback, decision === "cancel", response);
}

function sendAuthorizationPage(url, response) {
  const hiddenFields = [...url.searchParams.entries()]
    .filter(([name]) => name !== "decision")
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join("\n");
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>登录 MindSurf</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; padding: 24px; color: #172033; background: radial-gradient(circle at 50% 0%, #e8f1ff 0, #f5f7fb 42%, #eef1f6 100%); }
    main { width: min(420px, 100%); padding: 34px; border: 1px solid #dfe5ee; border-radius: 18px; background: rgba(255,255,255,.94); box-shadow: 0 22px 70px rgba(43,63,94,.14); text-align: center; }
    .logo { display: grid; width: 58px; height: 58px; margin: 0 auto 18px; place-items: center; border-radius: 16px; color: #fff; background: linear-gradient(145deg, #3478e5, #1959bd); font-size: 25px; font-weight: 750; box-shadow: 0 9px 24px rgba(37,99,201,.28); }
    h1 { margin: 0; font-size: 24px; letter-spacing: -.02em; }
    .lead { margin: 9px 0 25px; color: #667085; font-size: 14px; line-height: 1.6; }
    .account { display: flex; align-items: center; gap: 12px; padding: 14px; border: 1px solid #e2e7ef; border-radius: 12px; background: #f8faff; text-align: left; }
    .avatar { display: grid; width: 42px; height: 42px; flex: none; place-items: center; border-radius: 50%; color: #1d5fbe; background: #dfebff; font-size: 16px; font-weight: 700; }
    .account strong, .account span { display: block; }
    .account span { margin-top: 3px; color: #7a8495; font-size: 12px; }
    .scope { margin: 19px 0; color: #566174; font-size: 13px; line-height: 1.55; text-align: left; }
    .scope::before { content: "✓"; margin-right: 8px; color: #16855b; font-weight: 700; }
    form { display: grid; grid-template-columns: 1fr 1.5fr; gap: 10px; }
    button { min-height: 42px; border-radius: 9px; cursor: pointer; font: inherit; font-size: 14px; font-weight: 650; }
    .cancel { border: 1px solid #d7dde7; color: #4c5668; background: #fff; }
    .approve { border: 1px solid #2563c9; color: #fff; background: #2563c9; }
    .approve:hover { background: #1f56b2; }
    .hint { margin: 18px 0 0; color: #9098a6; font-size: 11px; line-height: 1.5; }
    @media (prefers-color-scheme: dark) {
      body { color: #f1f4f8; background: radial-gradient(circle at 50% 0%, #223553 0, #171a20 48%, #111318 100%); }
      main { border-color: #353b45; background: rgba(35,39,46,.96); }
      .lead, .scope { color: #b2bac7; }
      .account { border-color: #3b424d; background: #292e36; }
      .account span, .hint { color: #8e98a8; }
      .cancel { border-color: #454d59; color: #dce1e8; background: #2d323a; }
    }
  </style>
</head>
<body>
  <main>
    <div class="logo" aria-hidden="true">M</div>
    <h1>登录 MindSurf</h1>
    <p class="lead">MindSurf Voice AI 桌面端正在请求访问你的本地 Mock 账户。</p>
    <section class="account" aria-label="待登录账户">
      <div class="avatar" aria-hidden="true">LM</div>
      <div><strong>${escapeHtml(USER.display_name)}</strong><span>${escapeHtml(USER.login)} · ${escapeHtml(USER.plan)}</span></div>
    </section>
    <p class="scope">允许桌面端读取账户信息、额度，并建立 Voice API v2 连接</p>
    <form method="get" action="/v2/auth/authorize">
      ${hiddenFields}
      <button class="cancel" type="submit" name="decision" value="cancel">取消</button>
      <button class="approve" type="submit" name="decision" value="approve">登录并授权</button>
    </form>
    <p class="hint">这是仅用于本地开发的 Mock 登录页，不会收集密码。授权后浏览器将请求打开 MindSurf Voice AI。</p>
  </main>
</body>
</html>`;
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}

function sendCallbackPage(callback, cancelled, response) {
  const callbackUrl = escapeHtml(callback.toString());
  const html = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${cancelled ? "已取消登录" : "授权成功"} · MindSurf</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; padding: 24px; color: #172033; background: radial-gradient(circle at 50% 0%, #e8f1ff 0, #f5f7fb 42%, #eef1f6 100%); }
    main { width: min(420px, 100%); padding: 38px 34px; border: 1px solid #dfe5ee; border-radius: 18px; background: rgba(255,255,255,.94); box-shadow: 0 22px 70px rgba(43,63,94,.14); text-align: center; }
    .status { display: grid; width: 58px; height: 58px; margin: 0 auto 18px; place-items: center; border-radius: 50%; color: #fff; background: ${cancelled ? "#7a8495" : "#16855b"}; font-size: 26px; font-weight: 750; }
    h1 { margin: 0; font-size: 24px; letter-spacing: -.02em; }
    p { margin: 10px 0 24px; color: #667085; font-size: 14px; line-height: 1.65; }
    a { display: inline-flex; min-height: 44px; align-items: center; justify-content: center; padding: 0 22px; border: 1px solid #2563c9; border-radius: 9px; color: #fff; background: #2563c9; font-size: 14px; font-weight: 650; text-decoration: none; }
    a:hover { background: #1f56b2; }
    .hint { margin: 18px 0 0; color: #9098a6; font-size: 11px; }
    @media (prefers-color-scheme: dark) {
      body { color: #f1f4f8; background: radial-gradient(circle at 50% 0%, #223553 0, #171a20 48%, #111318 100%); }
      main { border-color: #353b45; background: rgba(35,39,46,.96); }
      p { color: #b2bac7; }
      .hint { color: #8e98a8; }
    }
  </style>
</head>
<body>
  <main>
    <div class="status" aria-hidden="true">${cancelled ? "×" : "✓"}</div>
    <h1>${cancelled ? "登录已取消" : "授权成功"}</h1>
    <p>${cancelled ? "返回 MindSurf Voice AI 完成本次取消操作。" : "本地 Mock 已完成授权。点击下方按钮返回桌面客户端并继续登录。"}</p>
    <a href="${callbackUrl}">打开 MindSurf Voice AI</a>
    <p class="hint">浏览器将请求使用 mindsurf:// 打开桌面应用；请在系统提示中确认。</p>
  </main>
</body>
</html>`;
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(html);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function exchangeToken(state, request, response) {
  const idempotencyKey = idempotencyHeader(request, response);
  if (!idempotencyKey) return;
  const body = await readJson(request, response);
  if (!body) return;
  const replay = idempotentReplay(
    state,
    idempotencyKey,
    "token",
    body,
    response,
  );
  if (replay) return;
  if (!validAuthorizationCodeInput(body)) {
    sendHttpError(
      response,
      400,
      "invalid_request",
      "Authorization token request is invalid",
      false,
    );
    return;
  }
  const grant = state.authorizationCodes.get(body.code);
  const verifierChallenge =
    typeof body.code_verifier === "string"
      ? sha256Base64Url(body.code_verifier)
      : "";
  if (
    body.grant_type !== "authorization_code" ||
    body.client_id !== "mindsurf-desktop" ||
    body.redirect_uri !== "mindsurf://auth/callback" ||
    !grant ||
    grant.expiresAtMs <= Date.now() ||
    !safeEqual(verifierChallenge, grant.challenge)
  ) {
    sendHttpError(
      response,
      400,
      "authorization_grant_invalid",
      "Authorization grant is invalid",
      false,
    );
    return;
  }
  state.authorizationCodes.delete(body.code);
  const data = createAuthData(state);
  rememberIdempotency(state, idempotencyKey, "token", body, data);
  if (
    hasFault(state, "token_response_uncertain") &&
    !state.destroyedTokenResponse
  ) {
    state.destroyedTokenResponse = true;
    response.destroy();
    return;
  }
  sendData(response, data);
}

async function refreshToken(state, request, response) {
  const idempotencyKey = idempotencyHeader(request, response);
  if (!idempotencyKey) return;
  const body = await readJson(request, response);
  if (!body) return;
  const replay = idempotentReplay(
    state,
    idempotencyKey,
    "refresh",
    body,
    response,
  );
  if (replay) return;
  if (
    Object.keys(body).length !== 1 ||
    typeof body.refresh_token !== "string" ||
    !body.refresh_token
  ) {
    sendHttpError(
      response,
      400,
      "invalid_request",
      "Refresh request is invalid",
      false,
    );
    return;
  }
  if (hasFault(state, "refresh_token_reused")) {
    sendHttpError(
      response,
      409,
      "refresh_token_reused",
      "Refresh token reuse detected",
      false,
    );
    return;
  }
  const current = state.refreshTokens.get(body.refresh_token);
  if (!current || current.expiresAtMs <= Date.now()) {
    const code = state.rotatedRefreshTokens.has(body.refresh_token)
      ? "refresh_token_reused"
      : "authentication_failed";
    sendHttpError(
      response,
      code === "refresh_token_reused" ? 409 : 401,
      code,
      "Refresh credential is invalid",
      false,
    );
    return;
  }
  state.refreshTokens.delete(body.refresh_token);
  state.rotatedRefreshTokens.add(body.refresh_token);
  const data = createAuthData(state, current.sessionId);
  rememberIdempotency(state, idempotencyKey, "refresh", body, data);
  if (
    hasFault(state, "refresh_response_uncertain") &&
    !state.destroyedRefreshResponse
  ) {
    state.destroyedRefreshResponse = true;
    response.destroy();
    return;
  }
  sendData(response, data);
}

function createAuthData(state, existingSessionId = randomUUID()) {
  const accessToken = opaqueToken(36);
  const refreshToken = opaqueToken(48);
  const now = Date.now();
  state.accessTokens.set(accessToken, {
    sessionId: existingSessionId,
    expiresAtMs: now + ACCESS_LIFETIME_SECONDS * 1_000,
  });
  state.refreshTokens.set(refreshToken, {
    sessionId: existingSessionId,
    expiresAtMs: now + REFRESH_LIFETIME_SECONDS * 1_000,
  });
  return {
    tokens: {
      token_type: "Bearer",
      access_token: accessToken,
      expires_in: ACCESS_LIFETIME_SECONDS,
      refresh_token: refreshToken,
      refresh_expires_in: REFRESH_LIFETIME_SECONDS,
    },
    user: USER,
  };
}

function authenticate(state, request, response) {
  const authorization = request.headers.authorization ?? "";
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) {
    sendHttpError(
      response,
      401,
      "authentication_required",
      "Bearer access token required",
      false,
    );
    return null;
  }
  const session = state.accessTokens.get(match[1]);
  if (!session) {
    sendHttpError(
      response,
      401,
      "authentication_failed",
      "Access token is invalid",
      false,
    );
    return null;
  }
  if (session.expiresAtMs <= Date.now()) {
    sendHttpError(
      response,
      401,
      "authentication_expired",
      "Access token expired",
      false,
    );
    return null;
  }
  return session;
}

function revokeSession(state, sessionId) {
  for (const [token, session] of state.accessTokens) {
    if (session.sessionId === sessionId) state.accessTokens.delete(token);
  }
  for (const [token, session] of state.refreshTokens) {
    if (session.sessionId === sessionId) state.refreshTokens.delete(token);
  }
  for (const ticket of state.tickets.values()) {
    if (ticket.sessionId === sessionId) ticket.revoked = true;
  }
}

function getPolishPrompt(state, response) {
  if (hasFault(state, "polish_prompt_unavailable")) {
    sendHttpError(
      response,
      503,
      "service_unavailable",
      "Polish prompt storage is unavailable",
      true,
    );
    return;
  }
  sendPolishPromptData(response, effectivePolishPrompt(state));
}

async function setPolishPrompt(state, request, response) {
  const idempotencyKey = idempotencyHeader(request, response);
  if (!idempotencyKey) return;
  const body = await readJson(request, response);
  if (!body) return;
  if (
    replayPolishPromptMutation(
      state,
      idempotencyKey,
      "polish-prompt-put",
      body,
      response,
    )
  ) {
    return;
  }
  if (hasFault(state, "polish_prompt_unavailable")) {
    sendHttpError(
      response,
      503,
      "service_unavailable",
      "Polish prompt storage is unavailable",
      true,
    );
    return;
  }
  if (!validPolishPromptInput(body)) {
    sendHttpError(
      response,
      400,
      "invalid_request",
      "Polish prompt is invalid",
      false,
    );
    return;
  }
  const ifMatch = requireIfMatch(request, response);
  if (!ifMatch) return;
  if (ifMatch !== polishPromptEtag(effectivePolishPrompt(state))) {
    sendHttpError(
      response,
      412,
      "polish_prompt_revision_conflict",
      "Polish prompt revision is stale",
      false,
    );
    return;
  }
  if (state.polishPrompt.custom?.prompt !== body.prompt) {
    state.polishPrompt.custom = {
      revision: `polish-prompt-${randomUUID()}`,
      source: "custom",
      prompt: body.prompt,
      updated_at_ms: Date.now(),
      constraints: polishPromptConstraints(),
    };
  }
  commitPolishPromptMutation(
    state,
    idempotencyKey,
    "polish-prompt-put",
    body,
    response,
  );
}

function resetPolishPrompt(state, request, response) {
  const idempotencyKey = idempotencyHeader(request, response);
  if (!idempotencyKey) return;
  if (
    replayPolishPromptMutation(
      state,
      idempotencyKey,
      "polish-prompt-delete",
      null,
      response,
    )
  ) {
    return;
  }
  if (hasFault(state, "polish_prompt_unavailable")) {
    sendHttpError(
      response,
      503,
      "service_unavailable",
      "Polish prompt storage is unavailable",
      true,
    );
    return;
  }
  const ifMatch = requireIfMatch(request, response);
  if (!ifMatch) return;
  if (ifMatch !== polishPromptEtag(effectivePolishPrompt(state))) {
    sendHttpError(
      response,
      412,
      "polish_prompt_revision_conflict",
      "Polish prompt revision is stale",
      false,
    );
    return;
  }
  state.polishPrompt.custom = null;
  commitPolishPromptMutation(
    state,
    idempotencyKey,
    "polish-prompt-delete",
    null,
    response,
  );
}

function effectivePolishPrompt(state) {
  return (
    state.polishPrompt.custom ?? {
      revision: state.polishPrompt.defaultRevision,
      source: "default",
      prompt: DEFAULT_POLISH_PROMPT,
      updated_at_ms: state.polishPrompt.defaultUpdatedAtMs,
      constraints: polishPromptConstraints(),
    }
  );
}

function polishPromptConstraints() {
  return {
    max_code_points: POLISH_PROMPT_MAX_CODE_POINTS,
    max_utf8_bytes: POLISH_PROMPT_MAX_UTF8_BYTES,
  };
}

function polishPromptEtag(configuration) {
  return JSON.stringify(configuration.revision);
}

function validPolishPromptInput(body) {
  if (
    Object.keys(body).length !== 1 ||
    typeof body.prompt !== "string" ||
    !body.prompt.trim() ||
    body.prompt.includes("\u0000")
  ) {
    return false;
  }
  return (
    [...body.prompt].length <= POLISH_PROMPT_MAX_CODE_POINTS &&
    Buffer.byteLength(body.prompt, "utf8") <= POLISH_PROMPT_MAX_UTF8_BYTES
  );
}

function requireIfMatch(request, response) {
  const value = request.headers["if-match"];
  if (typeof value !== "string" || !value) {
    sendHttpError(
      response,
      428,
      "precondition_required",
      "If-Match is required",
      false,
    );
    return null;
  }
  return value;
}

function replayPolishPromptMutation(state, key, operation, body, response) {
  const entry = state.idempotency.get(key);
  if (!entry) return false;
  if (entry.operation !== operation || entry.body !== stableJson(body)) {
    sendHttpError(
      response,
      409,
      "idempotency_conflict",
      "Idempotency key conflict",
      false,
    );
  } else {
    sendPolishPromptEnvelope(response, entry.envelope, entry.etag);
  }
  return true;
}

function commitPolishPromptMutation(state, key, operation, body, response) {
  const configuration = structuredClone(effectivePolishPrompt(state));
  const etag = polishPromptEtag(configuration);
  const envelope = dataEnvelope(configuration);
  state.idempotency.set(key, {
    operation,
    body: stableJson(body),
    envelope,
    etag,
  });
  if (
    hasFault(state, "polish_prompt_response_uncertain") &&
    !state.destroyedPolishPromptResponse
  ) {
    state.destroyedPolishPromptResponse = true;
    response.destroy();
    return;
  }
  sendPolishPromptEnvelope(response, envelope, etag);
}

function listUsage(state, url, response) {
  const fromMs = Number(url.searchParams.get("from_ms"));
  const toMs = Number(url.searchParams.get("to_ms"));
  const limit = Number(url.searchParams.get("limit") ?? 50);
  if (
    !Number.isSafeInteger(fromMs) ||
    !Number.isSafeInteger(toMs) ||
    toMs <= fromMs ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    sendHttpError(
      response,
      400,
      "invalid_request",
      "Invalid usage query",
      false,
    );
    return;
  }
  let offset = 0;
  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    try {
      const parsed = JSON.parse(
        Buffer.from(cursor, "base64url").toString("utf8"),
      );
      if (
        parsed.from_ms !== fromMs ||
        parsed.to_ms !== toMs ||
        parsed.limit !== limit ||
        !Number.isInteger(parsed.offset)
      )
        throw new Error();
      offset = parsed.offset;
    } catch {
      sendHttpError(
        response,
        400,
        "invalid_request",
        "Invalid usage cursor",
        false,
      );
      return;
    }
  }
  const matches = state.usage
    .filter((item) => item.settled_at_ms >= fromMs && item.settled_at_ms < toMs)
    .sort(
      (a, b) =>
        b.settled_at_ms - a.settled_at_ms ||
        a.request_id.localeCompare(b.request_id),
    );
  const items = matches.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const nextCursor =
    nextOffset < matches.length
      ? Buffer.from(
          JSON.stringify({
            from_ms: fromMs,
            to_ms: toMs,
            limit,
            offset: nextOffset,
          }),
        ).toString("base64url")
      : null;
  sendData(response, { items, next_cursor: nextCursor });
}

function issueTicket(state, session, response) {
  const ticket = opaqueToken(36);
  const expiresAtMs = hasFault(state, "ticket_expired")
    ? Date.now() - 1
    : Date.now() + TICKET_LIFETIME_MS;
  state.tickets.set(ticket, {
    sessionId: session.sessionId,
    expiresAtMs,
    consumed: hasFault(state, "ticket_consumed"),
    revoked: false,
  });
  sendData(
    response,
    {
      ticket,
      expires_at_ms: expiresAtMs,
      websocket_path: WEBSOCKET_PATH,
      subprotocol: SUBPROTOCOL,
    },
    201,
  );
}

function handleUpgrade(state, websocketServer, request, socket, head) {
  const url = new URL(request.url ?? "/", "http://mock.local");
  if (url.pathname !== WEBSOCKET_PATH)
    return rejectUpgrade(socket, 400, "invalid_request");
  if (
    [...url.searchParams.keys()].some((key) => key !== "ticket") ||
    url.searchParams.getAll("ticket").length !== 1
  ) {
    return rejectUpgrade(socket, 400, "invalid_request");
  }
  const origin = request.headers.origin;
  if (
    origin &&
    ![
      "http://127.0.0.1:1420",
      "http://localhost:1420",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "tauri://localhost",
    ].includes(origin)
  ) {
    return rejectUpgrade(socket, 403, "origin_not_allowed");
  }
  if (
    !(request.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((item) => item.trim())
      .includes(SUBPROTOCOL)
  ) {
    return rejectUpgrade(socket, 426, "websocket_subprotocol_required");
  }
  const ticketValue = url.searchParams.get("ticket");
  const ticket = ticketValue ? state.tickets.get(ticketValue) : null;
  if (!ticket || ticket.revoked)
    return rejectUpgrade(socket, 401, "realtime_ticket_invalid");
  if (ticket.expiresAtMs <= Date.now())
    return rejectUpgrade(socket, 401, "realtime_ticket_expired");
  if (ticket.consumed)
    return rejectUpgrade(socket, 409, "realtime_ticket_consumed");
  ticket.consumed = true;
  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    websocketServer.emit("connection", websocket, request);
  });
}

function rejectUpgrade(socket, status, code) {
  const body = JSON.stringify(errorEnvelope(code, code, false));
  socket.end(
    `HTTP/1.1 ${status} Upgrade Rejected\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function handleWebSocket(serverState, socket) {
  const state = {
    handshaken: false,
    request: null,
    seenEventIds: new Set(),
    outstandingPing: null,
    heartbeatTimer: null,
    heartbeatDeadline: null,
    helloTimer: setTimeout(() => socket.close(4001, "hello timeout"), 3_000),
  };
  socket.on("message", (data, isBinary) => {
    try {
      if (isBinary)
        handleAudioFrame(serverState, state, socket, Buffer.from(data));
      else handleControl(serverState, state, socket, data.toString("utf8"));
    } catch (error) {
      sendSessionError(socket, "invalid_message", safeErrorName(error), false);
      socket.close(1002, "protocol error");
    }
  });
  socket.on("close", () => {
    clearTimeout(state.helloTimer);
    clearInterval(state.heartbeatTimer);
    clearTimeout(state.heartbeatDeadline);
    clearTimeout(state.request?.idleTimer);
  });
}

function handleControl(serverState, state, socket, raw) {
  if (Buffer.byteLength(raw) > MAX_CONTROL_BYTES)
    throw new Error("control message too large");
  const message = JSON.parse(raw);
  validateEnvelope(message);
  if (state.seenEventIds.has(message.event_id)) return;
  state.seenEventIds.add(message.event_id);
  if (!state.handshaken) {
    if (message.type !== "client.hello" || message.request_id !== null) {
      sendSessionError(
        socket,
        "handshake_required",
        "client.hello required",
        true,
      );
      socket.close(4001, "handshake required");
      return;
    }
    if (!validClientHello(message.payload)) {
      sendSessionError(
        socket,
        "protocol_version_mismatch",
        "Voice v2 hello required",
        true,
      );
      socket.close(1002, "protocol mismatch");
      return;
    }
    clearTimeout(state.helloTimer);
    if (hasFault(serverState, "hello_timeout")) return;
    state.handshaken = true;
    sendControl(socket, "server.hello", null, serverHello());
    startHeartbeat(serverState, state, socket);
    return;
  }
  if (message.type === "session.pong") {
    if (
      message.request_id === null &&
      message.payload?.nonce === state.outstandingPing &&
      !hasFault(serverState, "heartbeat_timeout")
    ) {
      state.outstandingPing = null;
      clearTimeout(state.heartbeatDeadline);
    }
    return;
  }
  if (
    ["request.start", "input.commit", "request.cancel"].includes(
      message.type,
    ) &&
    message.request_id === null
  ) {
    sendSessionError(
      socket,
      "invalid_message",
      "Request message requires request_id",
      false,
    );
    socket.close(1002, "protocol error");
    return;
  }
  if (message.type === "request.start")
    return startRequest(serverState, state, socket, message);
  if (message.type === "input.commit")
    return commitInput(serverState, state, socket, message);
  if (message.type === "request.cancel")
    return cancelRequest(serverState, state, socket, message);
  sendSessionError(
    socket,
    "unsupported_message_type",
    "Unsupported client message",
    false,
  );
}

function startHeartbeat(serverState, state, socket) {
  state.heartbeatTimer = setInterval(() => {
    if (state.outstandingPing || socket.readyState !== WebSocket.OPEN) return;
    const nonce = opaqueToken(12);
    state.outstandingPing = nonce;
    sendControl(socket, "session.ping", null, { nonce });
    state.heartbeatDeadline = setTimeout(() => {
      if (state.outstandingPing === nonce)
        socket.close(4002, "heartbeat timeout");
    }, HEARTBEAT_TIMEOUT_MS);
  }, HEARTBEAT_INTERVAL_MS);
}

function startRequest(serverState, state, socket, message) {
  if (state.request)
    return sendRequestError(
      socket,
      message.request_id,
      "request_in_progress",
      "A request is already active",
      "request",
      false,
      zeroUsage(),
    );
  if (serverState.usedRequestIds.has(message.request_id))
    return sendRequestError(
      socket,
      message.request_id,
      "request_id_reused",
      "Request ID was already used",
      "request",
      false,
      zeroUsage(),
    );
  serverState.usedRequestIds.add(message.request_id);
  const validation = validateRequestStart(message.payload);
  if (validation)
    return sendRequestError(
      socket,
      message.request_id,
      validation.code,
      validation.message,
      validation.stage,
      validation.retryable,
      zeroUsage(),
      validation.details,
    );
  if (
    message.payload.mode === "asr_llm" &&
    hasFault(serverState, "polish_prompt_unavailable")
  ) {
    return sendRequestError(
      socket,
      message.request_id,
      "upstream_unavailable",
      "Polish prompt storage is unavailable",
      "routing",
      true,
      zeroUsage(),
    );
  }
  const request = {
    id: message.request_id,
    options: structuredClone(message.payload),
    polishPrompt:
      message.payload.mode === "asr_llm"
        ? structuredClone(effectivePolishPrompt(serverState))
        : null,
    sequence: 0,
    sampleCount: 0,
    chunkCount: 0,
    successLocked: false,
    accepted: false,
    terminal: false,
    idleTimer: null,
  };
  state.request = request;
  if (hasFault(serverState, "capabilities_stale")) {
    terminalError(
      serverState,
      state,
      socket,
      request,
      "capabilities_stale",
      "Capabilities revision changed",
      "routing",
      true,
    );
    return;
  }
  if (hasFault(serverState, "accepted_timeout")) return;
  const llmCredits = request.options.mode === "asr_llm" ? 4 : 0;
  serverState.creditsReserved += 8 + llmCredits;
  sendControl(socket, "request.accepted", request.id, {
    ...structuredClone(request.options),
    max_recording_ms: MAX_RECORDING_MS,
    quota_reservation: {
      asr_credits: 8,
      llm_credits: llmCredits,
      credits: 8 + llmCredits,
    },
  });
  request.accepted = true;
  armInputIdle(serverState, state, socket, request);
}

function handleAudioFrame(serverState, state, socket, frame) {
  const request = state.request;
  if (!state.handshaken || !request || !request.accepted || request.terminal) {
    throw new Error("binary frame outside accepted request");
  }
  if (
    frame.length < 50 ||
    frame.length > MAX_BINARY_BYTES ||
    frame.toString("ascii", 0, 4) !== "MSVA"
  ) {
    return terminalError(
      serverState,
      state,
      socket,
      request,
      "invalid_audio_frame",
      "Invalid audio frame",
      "protocol",
      false,
    );
  }
  const version = frame.readUInt8(4);
  const kind = frame.readUInt8(5);
  const flags = frame.readUInt16BE(6);
  const headerLength = frame.readUInt16BE(8);
  const reserved = frame.readUInt16BE(10);
  const sequence = frame.readUInt32BE(12);
  const timestampUs = frame.readBigUInt64BE(16);
  const payloadLength = frame.readUInt32BE(24);
  const reservedTail = frame.readUInt32BE(28);
  const requestId = bytesToUuid(frame.subarray(32, 48));
  const expectedTimestamp = BigInt(
    Math.floor((request.sampleCount * 1_000_000) / 16_000),
  );
  if (
    version !== 2 ||
    kind !== 1 ||
    flags !== 0 ||
    headerLength !== 48 ||
    reserved !== 0 ||
    reservedTail !== 0 ||
    sequence !== request.sequence ||
    timestampUs !== expectedTimestamp ||
    payloadLength < 2 ||
    payloadLength % 2 !== 0 ||
    frame.length !== 48 + payloadLength ||
    requestId !== request.id
  ) {
    return terminalError(
      serverState,
      state,
      socket,
      request,
      "invalid_audio_frame",
      "Invalid audio frame fields",
      "protocol",
      false,
    );
  }
  request.sequence += 1;
  request.chunkCount += 1;
  request.sampleCount += payloadLength / 2;
  armInputIdle(serverState, state, socket, request);
}

function commitInput(serverState, state, socket, message) {
  const request = state.request;
  if (!request || request.id !== message.request_id)
    return sendRequestError(
      socket,
      message.request_id,
      "request_not_found",
      "Request not found",
      "request",
      false,
      zeroUsage(),
    );
  if (!request.accepted) {
    return terminalError(
      serverState,
      state,
      socket,
      request,
      "invalid_message",
      "input.commit arrived before request.accepted",
      "protocol",
      false,
    );
  }
  clearTimeout(request.idleTimer);
  if (request.chunkCount === 0)
    return terminalError(
      serverState,
      state,
      socket,
      request,
      "input_empty",
      "No audio was received",
      "input",
      false,
    );
  const statistics = {
    last_sequence: request.chunkCount - 1,
    chunk_count: request.chunkCount,
    sample_count: request.sampleCount,
    duration_ms: Math.ceil((request.sampleCount * 1_000) / 16_000),
  };
  if (!sameStatistics(message.payload, statistics))
    return terminalError(
      serverState,
      state,
      socket,
      request,
      "input_statistics_mismatch",
      "Input statistics mismatch",
      "input",
      false,
    );
  sendControl(
    socket,
    "input.committed",
    request.id,
    hasFault(serverState, "input_statistics_mismatch")
      ? { ...statistics, sample_count: statistics.sample_count + 1 }
      : statistics,
  );
  if (hasFault(serverState, "disconnect_processing")) {
    socket.close(1011, "injected processing disconnect");
    return;
  }
  setTimeout(
    () => completeTextRequest(serverState, state, socket, request, statistics),
    20,
  );
}

function completeTextRequest(serverState, state, socket, request, statistics) {
  if (state.request !== request || request.terminal) return;
  if (hasFault(serverState, "asr_failed"))
    return terminalError(
      serverState,
      state,
      socket,
      request,
      "asr_failed",
      "Injected ASR failure",
      "asr",
      true,
    );
  const asrText = "这是来自 Voice API v2 Mock 的识别结果。";
  sendControl(socket, "output.text.delta", request.id, {
    stage: "asr",
    sequence: 0,
    delta: asrText,
  });
  if (request.options.mode === "asr_only") {
    lockAndFinish(
      serverState,
      state,
      socket,
      request,
      asrText,
      statistics,
      "asr",
    );
    return;
  }
  sendControl(socket, "output.text.snapshot", request.id, {
    stage: "asr",
    text: asrText,
    final: false,
  });
  sendControl(socket, "output.text.snapshot", request.id, {
    stage: "llm",
    text: "",
    final: false,
  });
  if (hasFault(serverState, "llm_failed"))
    return terminalError(
      serverState,
      state,
      socket,
      request,
      "llm_failed",
      "Injected LLM failure",
      "llm",
      true,
      usageFor(request, statistics, true),
    );
  const chunks =
    request.polishPrompt?.source === "custom"
      ? ["这是", "应用账户自定义提示词后的 ", "Mock 最终文本。"]
      : ["这是", "经过 Mock LLM 处理的", "最终文本。"];
  chunks.forEach((delta, sequence) =>
    sendControl(socket, "output.text.delta", request.id, {
      stage: "llm",
      sequence,
      delta,
    }),
  );
  lockAndFinish(
    serverState,
    state,
    socket,
    request,
    chunks.join(""),
    statistics,
    "llm",
  );
}

function lockAndFinish(
  serverState,
  state,
  socket,
  request,
  finalText,
  statistics,
  stage,
) {
  const usage = usageFor(request, statistics, stage === "llm");
  request.successLocked = true;
  request.finalText = finalText;
  request.finalUsage = usage;
  sendControl(socket, "output.text.snapshot", request.id, {
    stage,
    text: finalText,
    final: true,
  });
  if (hasFault(serverState, "request_done_missing")) return;
  const delay = hasFault(serverState, "cancel_race")
    ? serverState.faults.delayMs
    : 0;
  setTimeout(() => {
    if (state.request !== request || request.terminal) return;
    sendControl(socket, "request.done", request.id, {
      result: "success",
      mode: request.options.mode,
      final_text: hasFault(serverState, "final_done_mismatch")
        ? `${finalText}!`
        : finalText,
      usage,
    });
    settle(serverState, state, request, usage);
  }, delay);
}

function cancelRequest(serverState, state, socket, message) {
  const request = state.request;
  if (!request || request.id !== message.request_id)
    return sendRequestError(
      socket,
      message.request_id,
      "request_not_found",
      "Request not found",
      "request",
      false,
      zeroUsage(),
    );
  if (request.successLocked) return;
  const usage = usageFor(request, null, false);
  sendControl(socket, "request.cancelled", request.id, {
    reason: message.payload?.reason ?? "user_cancelled",
    usage,
  });
  settle(serverState, state, request, usage);
}

function terminalError(
  serverState,
  state,
  socket,
  request,
  code,
  message,
  stage,
  retryable,
  usage = usageFor(request, null, false),
) {
  sendRequestError(socket, request.id, code, message, stage, retryable, usage);
  settle(serverState, state, request, usage);
}

function settle(serverState, state, request, usage) {
  if (request.terminal) return;
  request.terminal = true;
  clearTimeout(request.idleTimer);
  const reserved = request.options.mode === "asr_llm" ? 12 : 8;
  serverState.creditsReserved = Math.max(
    0,
    serverState.creditsReserved - reserved,
  );
  serverState.creditsUsed += usage.credits_charged;
  serverState.usage.push({
    request_id: request.id,
    mode: request.options.mode,
    settled_at_ms: Date.now(),
    pricing_revision: "mock-pricing-1",
    ...usage,
  });
  if (state.request === request) state.request = null;
}

function armInputIdle(serverState, state, socket, request) {
  clearTimeout(request.idleTimer);
  request.idleTimer = setTimeout(() => {
    if (state.request === request && !request.terminal)
      terminalError(
        serverState,
        state,
        socket,
        request,
        "input_idle_timeout",
        "Input idle timeout",
        "input",
        false,
      );
  }, INPUT_IDLE_TIMEOUT_MS);
}

function validateRequestStart(payload) {
  if (!payload || typeof payload !== "object")
    return {
      code: "invalid_selection",
      message: "Request payload is invalid",
      stage: "routing",
      retryable: false,
      details: { field: "payload" },
    };
  const removedContextKey = ["conversation", "id"].join("_");
  const forbiddenKeys = [
    "task",
    removedContextKey,
    "response",
    "voice",
    "emotion",
    "output_audio",
  ];
  if (forbiddenKeys.some((key) => key in payload)) {
    return {
      code: "invalid_message",
      message: "Request contains a removed field",
      stage: "protocol",
      retryable: false,
    };
  }
  if (payload.capabilities_revision !== CAPABILITIES_REVISION)
    return {
      code: "capabilities_stale",
      message: "Capabilities revision is stale",
      stage: "routing",
      retryable: true,
    };
  if (payload.pipeline !== "mock-text-pipeline")
    return {
      code: "pipeline_unavailable",
      message: "Pipeline is unavailable",
      stage: "routing",
      retryable: true,
    };
  if (!CAPABILITIES.modes.includes(payload.mode))
    return {
      code: "unsupported_mode",
      message: "Mode is unsupported",
      stage: "routing",
      retryable: false,
    };
  if (!CAPABILITIES.recognition_languages.includes(payload.language))
    return {
      code: "invalid_selection",
      message: "Language is invalid",
      stage: "routing",
      retryable: false,
      details: { field: "language" },
    };
  const expectedLlm = payload.mode === "asr_llm" ? "mock-llm" : null;
  if (
    !payload.selection ||
    typeof payload.selection !== "object" ||
    Array.isArray(payload.selection) ||
    Object.keys(payload.selection).sort().join(",") !== "asr,llm" ||
    payload.selection?.asr !== "mock-asr" ||
    payload.selection?.llm !== expectedLlm
  )
    return {
      code: "invalid_selection",
      message: "Model selection is invalid",
      stage: "routing",
      retryable: false,
      details: { field: "selection" },
    };
  if (payload.mode === "asr_only" && payload.generation !== undefined)
    return {
      code: "invalid_selection",
      message: "Generation is not valid for asr_only",
      stage: "routing",
      retryable: false,
      details: { field: "generation" },
    };
  if (payload.generation !== undefined) {
    for (const [key, value] of Object.entries(payload.generation)) {
      const control = CAPABILITIES.pipelines[0].generation_controls[key];
      if (
        !control ||
        typeof value !== "number" ||
        value < control.minimum ||
        value > control.maximum ||
        (control.type === "integer" && !Number.isInteger(value))
      )
        return {
          code: "invalid_selection",
          message: "Generation control is invalid",
          stage: "routing",
          retryable: false,
          details: { field: `generation.${key}` },
        };
    }
  }
  return null;
}

function validClientHello(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    Array.isArray(payload.protocol_versions) &&
    payload.protocol_versions.includes(2) &&
    Array.isArray(payload.input_audio) &&
    payload.input_audio.some(
      (item) =>
        item?.encoding === "pcm_s16le" &&
        item.sample_rate === 16_000 &&
        item.channels === 1,
    ) &&
    !("auth" in payload) &&
    !("output_audio" in payload)
  );
}

function validAuthorizationCodeInput(body) {
  const device = body.device;
  return (
    Object.keys(body).sort().join(",") ===
      "client_id,code,code_verifier,device,grant_type,redirect_uri" &&
    body.grant_type === "authorization_code" &&
    body.client_id === "mindsurf-desktop" &&
    typeof body.code === "string" &&
    body.code.length >= 1 &&
    body.code.length <= 2_048 &&
    typeof body.code_verifier === "string" &&
    /^[A-Za-z0-9._~-]{43,128}$/.test(body.code_verifier) &&
    body.redirect_uri === "mindsurf://auth/callback" &&
    device &&
    typeof device === "object" &&
    !Array.isArray(device) &&
    Object.keys(device).sort().join(",") === "app_version,id,name,platform" &&
    [device.id, device.name, device.platform, device.app_version].every(
      (value) => typeof value === "string" && value.length >= 1,
    )
  );
}

function validateEnvelope(message) {
  if (!message || typeof message !== "object" || Array.isArray(message))
    throw new Error("control envelope is invalid");
  const keys = Object.keys(message).sort();
  const expected = [
    "event_id",
    "payload",
    "request_id",
    "sent_at_ms",
    "type",
    "v",
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index]) ||
    message.v !== 2 ||
    typeof message.type !== "string" ||
    !isUuid(message.event_id) ||
    (message.request_id !== null && !isUuid(message.request_id)) ||
    !Number.isSafeInteger(message.sent_at_ms) ||
    message.sent_at_ms < 0 ||
    !message.payload ||
    typeof message.payload !== "object" ||
    Array.isArray(message.payload)
  )
    throw new Error("control envelope is invalid");
}

function serverHello() {
  return {
    session_id: randomUUID(),
    protocol_version: 2,
    input_audio: { encoding: "pcm_s16le", sample_rate: 16_000, channels: 1 },
    heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
    heartbeat_timeout_ms: HEARTBEAT_TIMEOUT_MS,
    input_idle_timeout_ms: INPUT_IDLE_TIMEOUT_MS,
    limits: {
      max_control_bytes: MAX_CONTROL_BYTES,
      max_binary_bytes: MAX_BINARY_BYTES,
      max_recording_ms: MAX_RECORDING_MS,
    },
  };
}

function usageFor(request, statistics, llmStarted) {
  const inputAudioMs =
    statistics?.duration_ms ??
    Math.ceil((request.sampleCount * 1_000) / 16_000);
  const asrCredits =
    request.sampleCount > 0
      ? Math.min(8, Math.max(1, Math.ceil(inputAudioMs / 1_000)))
      : 0;
  const llmCredits = request.options.mode === "asr_llm" && llmStarted ? 4 : 0;
  return {
    input_audio_ms: inputAudioMs,
    llm_input_tokens: llmStarted ? 12 : 0,
    llm_output_tokens: llmStarted ? 16 : 0,
    asr_credits_charged: asrCredits,
    llm_credits_charged: llmCredits,
    credits_charged: asrCredits + llmCredits,
  };
}

function zeroUsage() {
  return {
    input_audio_ms: 0,
    llm_input_tokens: 0,
    llm_output_tokens: 0,
    asr_credits_charged: 0,
    llm_credits_charged: 0,
    credits_charged: 0,
  };
}

function quotaFor(state) {
  const used = state.creditsUsed;
  const reserved = state.creditsReserved;
  const usage = state.usage.reduce(
    (total, item) => ({
      input_audio_ms: total.input_audio_ms + item.input_audio_ms,
      llm_input_tokens: total.llm_input_tokens + item.llm_input_tokens,
      llm_output_tokens: total.llm_output_tokens + item.llm_output_tokens,
      asr_credits_charged: total.asr_credits_charged + item.asr_credits_charged,
      llm_credits_charged: total.llm_credits_charged + item.llm_credits_charged,
      credits_charged: total.credits_charged + item.credits_charged,
    }),
    zeroUsage(),
  );
  return {
    plan: "mock",
    pricing_revision: "mock-pricing-1",
    period: { starts_at_ms: 1_786_723_200_000, ends_at_ms: 1_789_401_600_000 },
    credits: {
      limit: state.creditsLimit,
      used,
      reserved,
      remaining: Math.max(0, state.creditsLimit - used - reserved),
    },
    usage,
  };
}

function sendControl(socket, type, requestId, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(
    JSON.stringify({
      v: 2,
      type,
      event_id: randomUUID(),
      request_id: requestId,
      sent_at_ms: Date.now(),
      payload,
    }),
  );
}

function sendSessionError(socket, code, message, fatal) {
  sendControl(socket, "error", null, {
    code,
    message,
    stage: code === "session_revoked" ? "authorization" : "protocol",
    terminal: false,
    retryable: false,
    fatal,
    details: {},
  });
}

function sendRequestError(
  socket,
  requestId,
  code,
  message,
  stage,
  retryable,
  usage,
  details = {},
) {
  sendControl(socket, "error", requestId, {
    code,
    message,
    stage,
    terminal: true,
    retryable,
    fatal: false,
    details,
    usage,
  });
}

function sameStatistics(left, right) {
  return (
    left &&
    typeof left === "object" &&
    !Array.isArray(left) &&
    Object.keys(left).sort().join(",") ===
      "chunk_count,duration_ms,last_sequence,sample_count" &&
    left.last_sequence === right.last_sequence &&
    left.chunk_count === right.chunk_count &&
    left.sample_count === right.sample_count &&
    left.duration_ms === right.duration_ms
  );
}

function bytesToUuid(bytes) {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idempotencyHeader(request, response) {
  const key = request.headers["idempotency-key"];
  if (typeof key !== "string" || !isUuid(key)) {
    sendHttpError(
      response,
      400,
      "invalid_request",
      "A UUID Idempotency-Key is required",
      false,
    );
    return null;
  }
  return key;
}

function idempotentReplay(state, key, operation, body, response) {
  const entry = state.idempotency.get(key);
  if (!entry) return false;
  if (entry.operation !== operation || entry.body !== stableJson(body)) {
    sendHttpError(
      response,
      409,
      "idempotency_conflict",
      "Idempotency key conflict",
      false,
    );
  } else sendData(response, entry.data);
  return true;
}

function rememberIdempotency(state, key, operation, body, data) {
  state.idempotency.set(key, { operation, body: stableJson(body), data });
}

async function readJson(request, response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1_024) {
      sendHttpError(
        response,
        400,
        "invalid_request",
        "Request body is too large",
        false,
      );
      return null;
    }
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    sendHttpError(
      response,
      400,
      "invalid_request",
      "Request body must be a JSON object",
      false,
    );
    return null;
  }
}

function sendData(response, data, status = 200) {
  sendJson(response, status, dataEnvelope(data));
}

function dataEnvelope(data) {
  return { request_id: randomUUID(), data };
}

function sendPolishPromptData(response, configuration) {
  sendPolishPromptEnvelope(
    response,
    dataEnvelope(configuration),
    polishPromptEtag(configuration),
  );
}

function sendPolishPromptEnvelope(response, envelope, etag) {
  sendJson(response, 200, envelope, {
    "Cache-Control": "private, no-cache",
    ETag: etag,
    "Access-Control-Expose-Headers": "ETag",
  });
}

function sendHttpError(response, status, code, message, retryable) {
  sendJson(response, status, errorEnvelope(code, message, retryable));
}

function errorEnvelope(code, message, retryable) {
  return {
    request_id: randomUUID(),
    error: { code, message, retryable, details: {} },
  };
}

function sendJson(response, status, body, headers = {}) {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(json);
}

function sha256Base64Url(value) {
  return createHash("sha256").update(value).digest("base64url");
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function opaqueToken(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function hasFault(state, name) {
  return state.faults.names.has(name);
}

function safeErrorName(error) {
  return error instanceof Error ? error.name : "UnknownError";
}

async function runCli() {
  if (process.argv.includes("--help")) {
    console.log(printFaultHelp());
    return;
  }
  const port = Number.parseInt(process.env.PORT ?? "8000", 10);
  const mock = createMockServer({ port });
  await mock.start();
  console.log(
    `MindSurf Voice API v2 mock listening on http://127.0.0.1:${port}`,
  );
  if (mock.state.faults.names.size)
    console.log(`Enabled faults: ${[...mock.state.faults.names].join(", ")}`);
  const stop = async () => {
    await mock.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runCli();
}

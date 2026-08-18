import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WebSocket } from "ws";
import {
  CAPABILITIES_REVISION,
  createMockServer,
  SUBPROTOCOL,
} from "./server.mjs";

const audioVectors = JSON.parse(
  readFileSync(
    new URL(
      "../docs/v2/test-vectors/binary/audio-frames.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("serves PKCE auth, token rotation, account, quota, usage and capabilities", async () => {
  await withMock(async ({ origin }) => {
    const auth = await authenticate(origin);
    const headers = { Authorization: `Bearer ${auth.tokens.access_token}` };

    const user = await getData(origin, "/v2/users/me", headers);
    assert.equal(user.login, "mock@mindsurf.local");
    const quota = await getData(origin, "/v2/quota", headers);
    assert.equal(quota.credits.remaining, 10_000);
    const capabilities = await getData(origin, "/v2/capabilities", headers);
    assert.deepEqual(capabilities.modes, ["asr_only", "asr_llm"]);
    assert.equal(capabilities.realtime.subprotocol, SUBPROTOCOL);

    const usage = await getData(
      origin,
      "/v2/usage?from_ms=0&to_ms=9999999999999&limit=1",
      headers,
    );
    assert.deepEqual(usage, { items: [], next_cursor: null });

    const refreshKey = randomUUID();
    const body = { refresh_token: auth.tokens.refresh_token };
    const first = await postData(origin, "/v2/auth/refresh", body, {
      "Idempotency-Key": refreshKey,
    });
    const replay = await postData(origin, "/v2/auth/refresh", body, {
      "Idempotency-Key": refreshKey,
    });
    assert.deepEqual(replay, first);
    const reused = await fetch(`${origin}/v2/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify(body),
    });
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).error.code, "refresh_token_reused");

    const unauthorized = await fetch(`${origin}/v2/users/me`);
    assert.equal(unauthorized.status, 401);
    assert.equal(
      (await unauthorized.json()).error.code,
      "authentication_required",
    );
  });
});

test("runs 100 requests including both modes over one long-lived connection", async () => {
  await withMock(async ({ origin }) => {
    const auth = await authenticate(origin);
    const accessToken = auth.tokens.access_token;
    const connection = await connect(origin, accessToken);
    try {
      const asrOnly = await runRequest(connection, "asr_only");
      assert.deepEqual(asrOnly.types, [
        "request.accepted",
        "input.committed",
        "output.text.delta",
        "output.text.snapshot",
        "request.done",
      ]);
      assert.equal(asrOnly.finalSnapshot.payload.final, true);
      assert.equal(
        asrOnly.done.payload.final_text,
        asrOnly.finalSnapshot.payload.text,
      );
      assert.equal(asrOnly.done.payload.usage.llm_credits_charged, 0);

      const asrLlm = await runRequest(connection, "asr_llm");
      const snapshots = asrLlm.messages.filter(
        (message) => message.type === "output.text.snapshot",
      );
      assert.deepEqual(
        snapshots.map((message) => [
          message.payload.stage,
          message.payload.text,
          message.payload.final,
        ]),
        [
          ["asr", "这是来自 Voice API v2 Mock 的识别结果。", false],
          ["llm", "", false],
          ["llm", "这是经过 Mock LLM 处理的最终文本。", true],
        ],
      );
      assert.equal(asrLlm.done.payload.mode, "asr_llm");
      assert.equal(asrLlm.done.payload.usage.llm_credits_charged, 4);

      for (let index = 2; index < 100; index += 1) {
        const result = await runRequest(connection, "asr_only");
        assert.equal(result.done.payload.result, "success");
      }

      const quota = await getData(origin, "/v2/quota", {
        Authorization: `Bearer ${accessToken}`,
      });
      assert.equal(quota.credits.used, 104);
      assert.equal(quota.credits.reserved, 0);
      const usage = await getData(
        origin,
        "/v2/usage?from_ms=0&to_ms=9999999999999&limit=10",
        { Authorization: `Bearer ${accessToken}` },
      );
      assert.equal(usage.items.length, 10);
      assert.ok(usage.next_cursor);
      let itemCount = usage.items.length;
      let cursor = usage.next_cursor;
      while (cursor) {
        const page = await getData(
          origin,
          `/v2/usage?from_ms=0&to_ms=9999999999999&limit=10&cursor=${encodeURIComponent(cursor)}`,
          { Authorization: `Bearer ${accessToken}` },
        );
        itemCount += page.items.length;
        cursor = page.next_cursor;
      }
      assert.equal(itemCount, 100);
    } finally {
      connection.close();
    }
  });
});

test("consumes realtime tickets once and supports cancellation without closing session", async () => {
  await withMock(async ({ origin }) => {
    const auth = await authenticate(origin);
    const ticket = await issueTicket(origin, auth.tokens.access_token);
    const url = `${origin.replace("http", "ws")}${ticket.websocket_path}?ticket=${encodeURIComponent(ticket.ticket)}`;
    const connection = await openConnection(url);
    await hello(connection);

    const repeatedStatus = await rejectedUpgradeStatus(url);
    assert.equal(repeatedStatus, 409);

    const requestId = randomUUID();
    connection.sendControl(
      "request.start",
      requestId,
      requestPayload("asr_only"),
    );
    await connection.next((message) => message.type === "request.accepted");
    connection.sendControl("request.cancel", requestId, {
      reason: "user_cancelled",
    });
    const cancelled = await connection.next(
      (message) => message.type === "request.cancelled",
    );
    assert.equal(cancelled.request_id, requestId);
    assert.equal(cancelled.payload.usage.credits_charged, 0);

    const completed = await runRequest(connection, "asr_only");
    assert.equal(completed.done.payload.result, "success");
    connection.close();
  });
});

test("accepts the frozen INPUT_PCM and commit vectors byte-for-byte", async () => {
  await withMock(async ({ origin }) => {
    const auth = await authenticate(origin);
    const connection = await connect(origin, auth.tokens.access_token);
    const requestId = audioVectors.request_id;
    connection.sendControl(
      "request.start",
      requestId,
      requestPayload("asr_only"),
    );
    await connection.next((message) => message.type === "request.accepted");
    for (const item of audioVectors.cases.filter(
      (candidate) => candidate.valid && candidate.stream === "input-a",
    )) {
      connection.socket.send(Buffer.from(item.frame_hex, "hex"));
    }
    connection.sendControl(
      "input.commit",
      requestId,
      audioVectors.commits.find((item) => item.valid).statistics,
    );
    const committed = await connection.next(
      (message) => message.type === "input.committed",
    );
    assert.deepEqual(
      committed.payload,
      audioVectors.commits.find((item) => item.valid).statistics,
    );
    const done = await connection.next(
      (message) => message.type === "request.done",
    );
    assert.equal(done.payload.usage.input_audio_ms, 1);
    connection.close();
  });
});

test("exposes capabilities stale and final/done mismatch fault paths", async () => {
  await withMock(
    async ({ origin }) => {
      const auth = await authenticate(origin);
      const connection = await connect(origin, auth.tokens.access_token);
      const requestId = randomUUID();
      connection.sendControl(
        "request.start",
        requestId,
        requestPayload("asr_only"),
      );
      const error = await connection.next(
        (message) => message.type === "error",
      );
      assert.equal(error.payload.code, "capabilities_stale");
      assert.equal(error.payload.terminal, true);
      connection.close();
    },
    ["capabilities_stale"],
  );

  await withMock(
    async ({ origin }) => {
      const auth = await authenticate(origin);
      const connection = await connect(origin, auth.tokens.access_token);
      const result = await runRequest(connection, "asr_only");
      assert.notEqual(
        result.done.payload.final_text,
        result.finalSnapshot.payload.text,
      );
      connection.close();
    },
    ["final_done_mismatch"],
  );
});

async function withMock(operation, faultNames = []) {
  const mock = createMockServer({
    port: 0,
    faults: { names: new Set(faultNames), delayMs: 30 },
  });
  const port = await mock.start();
  try {
    await operation({ origin: `http://127.0.0.1:${port}`, mock });
  } finally {
    await mock.close();
  }
}

async function authenticate(origin) {
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = "s".repeat(43);
  const authorize = new URL("/v2/auth/authorize", origin);
  authorize.search = new URLSearchParams({
    client_id: "mindsurf-desktop",
    response_type: "code",
    redirect_uri: "mindsurf://auth/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();
  const loginPage = await fetch(authorize, { redirect: "manual" });
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /登录并授权/);
  authorize.searchParams.set("decision", "approve");
  const response = await fetch(authorize, { redirect: "manual" });
  assert.equal(response.status, 200);
  const callbackPage = await response.text();
  assert.match(callbackPage, /授权成功/);
  const callbackHref = callbackPage
    .match(/href="([^"]+)"/)?.[1]
    .replaceAll("&amp;", "&");
  assert.ok(callbackHref);
  const callback = new URL(callbackHref);
  assert.equal(callback.searchParams.get("state"), state);
  const code = callback.searchParams.get("code");
  assert.ok(code);
  const body = {
    grant_type: "authorization_code",
    client_id: "mindsurf-desktop",
    code,
    code_verifier: verifier,
    redirect_uri: "mindsurf://auth/callback",
    device: {
      id: "mock-test-device",
      name: "Mock Test",
      platform: "test",
      app_version: "0.1.0",
    },
  };
  const key = randomUUID();
  const data = await postData(origin, "/v2/auth/token", body, {
    "Idempotency-Key": key,
  });
  const replay = await postData(origin, "/v2/auth/token", body, {
    "Idempotency-Key": key,
  });
  assert.deepEqual(replay, data);
  return data;
}

async function issueTicket(origin, accessToken) {
  return postData(origin, "/v2/realtime/tickets", undefined, {
    Authorization: `Bearer ${accessToken}`,
  });
}

async function connect(origin, accessToken) {
  const ticket = await issueTicket(origin, accessToken);
  const url = `${origin.replace("http", "ws")}${ticket.websocket_path}?ticket=${encodeURIComponent(ticket.ticket)}`;
  const connection = await openConnection(url);
  await hello(connection);
  return connection;
}

async function hello(connection) {
  connection.sendControl("client.hello", null, {
    client: {
      name: "mock-test",
      version: "0.1.0",
      platform: "test",
      arch: "test",
    },
    protocol_versions: [2],
    input_audio: [{ encoding: "pcm_s16le", sample_rate: 16_000, channels: 1 }],
  });
  const message = await connection.next(
    (candidate) => candidate.type === "server.hello",
  );
  assert.equal(message.payload.protocol_version, 2);
}

async function runRequest(connection, mode) {
  const requestId = randomUUID();
  connection.sendControl("request.start", requestId, requestPayload(mode));
  const messages = [];
  while (true) {
    const message = await connection.next(
      (candidate) =>
        candidate.request_id === requestId || candidate.type === "session.ping",
    );
    if (message.type === "session.ping") {
      connection.sendControl("session.pong", null, {
        nonce: message.payload.nonce,
      });
      continue;
    }
    messages.push(message);
    if (message.type === "request.accepted") {
      connection.socket.send(createAudioFrame(requestId));
      connection.sendControl("input.commit", requestId, {
        last_sequence: 0,
        chunk_count: 1,
        sample_count: 320,
        duration_ms: 20,
      });
    }
    if (message.type === "request.done") break;
    if (message.type === "error" || message.type === "request.cancelled") {
      throw new Error(`Unexpected request terminal: ${message.type}`);
    }
  }
  return {
    messages,
    types: messages.map((message) => message.type),
    finalSnapshot: messages.findLast(
      (message) =>
        message.type === "output.text.snapshot" && message.payload.final,
    ),
    done: messages.at(-1),
  };
}

function requestPayload(mode) {
  return {
    mode,
    pipeline: "mock-text-pipeline",
    capabilities_revision: CAPABILITIES_REVISION,
    selection: {
      asr: "mock-asr",
      llm: mode === "asr_llm" ? "mock-llm" : null,
    },
    language: "zh-CN",
    ...(mode === "asr_llm" ? { generation: { temperature: 0.2 } } : {}),
  };
}

function openConnection(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, SUBPROTOCOL);
    const queue = [];
    const waiters = [];
    socket.on("open", () => {
      resolve({
        socket,
        close: () => socket.close(),
        sendControl(type, requestId, payload) {
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
        },
        next(predicate = () => true, timeoutMs = 3_000) {
          const queuedIndex = queue.findIndex(predicate);
          if (queuedIndex >= 0)
            return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
          return new Promise((resolveNext, rejectNext) => {
            const waiter = { predicate, resolve: resolveNext };
            waiters.push(waiter);
            const timer = setTimeout(() => {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              rejectNext(new Error("Timed out waiting for WebSocket message"));
            }, timeoutMs);
            waiter.resolve = (message) => {
              clearTimeout(timer);
              resolveNext(message);
            };
          });
        },
      });
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary)
        return reject(new Error("v2 server sent unexpected binary data"));
      const message = JSON.parse(data.toString("utf8"));
      const index = waiters.findIndex((waiter) => waiter.predicate(message));
      if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
      else queue.push(message);
    });
    socket.on("error", reject);
  });
}

function rejectedUpgradeStatus(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, SUBPROTOCOL);
    socket.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode);
      response.resume();
    });
    socket.on("open", () =>
      reject(new Error("Consumed ticket unexpectedly connected")),
    );
    socket.on("error", () => {});
  });
}

function createAudioFrame(requestId) {
  const payloadBytes = 640;
  const frame = Buffer.alloc(48 + payloadBytes);
  frame.write("MSVA", 0, "ascii");
  frame.writeUInt8(2, 4);
  frame.writeUInt8(1, 5);
  frame.writeUInt16BE(0, 6);
  frame.writeUInt16BE(48, 8);
  frame.writeUInt16BE(0, 10);
  frame.writeUInt32BE(0, 12);
  frame.writeBigUInt64BE(0n, 16);
  frame.writeUInt32BE(payloadBytes, 24);
  frame.writeUInt32BE(0, 28);
  Buffer.from(requestId.replaceAll("-", ""), "hex").copy(frame, 32);
  return frame;
}

async function getData(origin, path, headers) {
  const response = await fetch(`${origin}${path}`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()).data;
}

async function postData(origin, path, body, headers = {}) {
  const response = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, `${path} returned ${response.status}`);
  return (await response.json()).data;
}

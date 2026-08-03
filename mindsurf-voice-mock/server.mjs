import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WebSocket, WebSocketServer } from "ws";
import { parseFaultConfiguration, printFaultHelp } from "./faults.mjs";

if (process.argv.includes("--help")) {
  console.log(printFaultHelp());
  process.exit(0);
}

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const path = "/v1/voice/ws";
const subprotocol = "mindsurf.voice.v1";
const outputSampleRate = 24_000;
const outputChunkDurationMs = 80;
const outputSendIntervalMs = 40;
const outputChunkBytes = (outputSampleRate * outputChunkDurationMs * 2) / 1_000;
const requiredToken = process.env.MOCK_AUTH_TOKEN ?? "";
const expiredToken = process.env.MOCK_EXPIRED_TOKEN ?? "expired-token";
const faultConfig = parseFaultConfiguration();
const mockPcm = loadMockAudio();

const server = new WebSocketServer({
  host: "127.0.0.1",
  port,
  path,
  handleProtocols(protocols) {
    return protocols.has(subprotocol) ? subprotocol : false;
  },
});

server.on("connection", (socket) => {
  console.log("Client connected.");
  const state = {
    handshaken: false,
    lastPongNonce: null,
    request: null,
  };

  const heartbeat = setInterval(() => {
    if (!state.handshaken || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const nonce = randomUUID();
    state.lastPongNonce = null;
    send(socket, "session.ping", null, { nonce });

    setTimeout(() => {
      if (
        socket.readyState === WebSocket.OPEN &&
        state.lastPongNonce !== nonce
      ) {
        socket.close(1_001, "heartbeat timeout");
      }
    }, 10_000);
  }, 15_000);

  socket.on("message", (data, isBinary) => {
    try {
      if (isBinary) {
        handleAudioFrame(socket, state, data);
      } else {
        handleControlMessage(socket, state, data.toString("utf8"));
      }
    } catch (error) {
      sendError(
        socket,
        state.request?.id ?? null,
        "internal_error",
        error instanceof Error ? error.message : "mock server error",
        true,
      );
    }
  });

  socket.on("close", () => {
    clearInterval(heartbeat);
  });
});

server.on("listening", () => {
  console.log(`MindSurf mock listening on ws://127.0.0.1:${port}${path}`);
  if (faultConfig.names.size) {
    console.log(`Enabled faults: ${[...faultConfig.names].join(", ")}`);
  }
});

function hasFault(name) {
  return faultConfig.names.has(name);
}

function handleControlMessage(socket, state, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    sendError(socket, null, "invalid_json", "JSON 解析失败", false);
    return;
  }

  if (!state.handshaken) {
    if (message.type !== "client.hello") {
      sendError(socket, null, "handshake_required", "需要先握手", true);
      socket.close(4_001, "handshake required");
      return;
    }

    const auth = message.payload?.auth;
    if (hasFault("auth_missing")) {
      sendError(
        socket,
        null,
        "authentication_required",
        "服务需要 Token",
        true,
      );
      socket.close(4_003, "authentication required");
      return;
    }
    if (hasFault("auth_invalid")) {
      sendError(socket, null, "authentication_failed", "Token 无效", true);
      socket.close(4_003, "authentication failed");
      return;
    }
    if (hasFault("auth_expired")) {
      sendError(socket, null, "token_expired", "Token 已过期", true);
      socket.close(4_003, "token expired");
      return;
    }
    if (requiredToken && !auth) {
      sendError(
        socket,
        null,
        "authentication_required",
        "服务需要 Token",
        true,
      );
      socket.close(4_003, "authentication required");
      return;
    }
    if (auth?.scheme !== undefined && auth.scheme !== "bearer") {
      sendError(socket, null, "authentication_failed", "鉴权方式无效", true);
      socket.close(4_003, "authentication failed");
      return;
    }
    if (auth?.token === expiredToken) {
      sendError(socket, null, "token_expired", "Token 已过期", true);
      socket.close(4_003, "token expired");
      return;
    }
    if (requiredToken && auth?.token !== requiredToken) {
      sendError(socket, null, "authentication_failed", "Token 无效", true);
      socket.close(4_003, "authentication failed");
      return;
    }

    if (hasFault("handshake_timeout")) return;
    const completeHandshake = () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      state.handshaken = true;
      console.log("Protocol handshake completed.");
      send(socket, "server.hello", null, createServerHello());
    };
    if (hasFault("handshake_delay")) {
      setTimeout(completeHandshake, faultConfig.delayMs);
    } else {
      completeHandshake();
    }
    return;
  }

  switch (message.type) {
    case "session.pong":
      state.lastPongNonce = message.payload?.nonce ?? null;
      break;
    case "request.start":
      startRequest(socket, state, message);
      break;
    case "input.commit":
      commitInput(socket, state, message);
      break;
    case "request.cancel":
      cancelRequest(socket, state, message);
      break;
    case "error":
      break;
    default:
      sendError(
        socket,
        message.request_id ?? null,
        "unsupported_message_type",
        `不支持消息类型 ${message.type}`,
        false,
      );
  }
}

function startRequest(socket, state, message) {
  if (state.request) {
    sendError(
      socket,
      message.request_id,
      "request_already_active",
      "已有活跃请求",
      true,
    );
    return;
  }

  const mode = message.payload?.mode;
  const selection = message.payload?.selection ?? {};
  const wantsText = message.payload?.response?.text === true;
  const wantsAudio = message.payload?.response?.audio === true;
  const language = message.payload?.language ?? "auto";
  const voice = message.payload?.response?.voice ?? "default";
  if (mode !== "dictation" && mode !== "assistant") {
    sendError(
      socket,
      message.request_id,
      "invalid_request",
      "请求模式无效",
      false,
    );
    return;
  }
  if (
    selection.asr !== "asr-mock" ||
    (mode === "assistant" && selection.llm !== "llm-mock") ||
    (mode === "assistant" &&
      wantsAudio &&
      (selection.tts !== "tts-mock" ||
        selection.output_audio !== "pcm16-24k-mono")) ||
    (mode === "assistant" &&
      !wantsAudio &&
      (selection.tts !== null || selection.output_audio !== null)) ||
    (mode === "dictation" &&
      (selection.llm !== null ||
        selection.tts !== null ||
        selection.output_audio !== null))
  ) {
    sendError(
      socket,
      message.request_id,
      "unsupported_inference_option",
      "请求的推理候选不可用",
      false,
    );
    return;
  }
  if (wantsText !== (mode === "assistant")) {
    sendError(
      socket,
      message.request_id,
      "invalid_request",
      "文本回复配置与请求模式不一致",
      false,
    );
    return;
  }
  if (mode === "dictation" && wantsAudio) {
    sendError(
      socket,
      message.request_id,
      "invalid_request",
      "语音回复配置与请求模式不一致",
      false,
    );
    return;
  }
  if (!["auto", "zh-CN", "en-US"].includes(language)) {
    sendError(
      socket,
      message.request_id,
      "invalid_request",
      "识别语言无效",
      false,
    );
    return;
  }
  if (!["default", "mock_audio"].includes(voice)) {
    sendError(
      socket,
      message.request_id,
      "invalid_request",
      "语音音色无效",
      false,
    );
    return;
  }

  state.request = {
    id: message.request_id,
    frameCount: 0,
    lastSequence: -1,
    revision: -1,
    sampleCount: 0,
    mode,
    wantsAudio,
    wantsText,
    voice,
  };

  if (hasFault("request_accepted_timeout")) return;

  send(socket, "request.accepted", message.request_id, {
    mode,
    language,
    selection: {
      asr: "asr-mock",
      llm: mode === "assistant" ? "llm-mock" : null,
      tts: wantsAudio ? "tts-mock" : null,
      output_audio: wantsAudio ? "pcm16-24k-mono" : null,
    },
    voice,
    max_recording_ms: 60_000,
  });
  console.log(`Request accepted (${mode}).`);
}

function handleAudioFrame(socket, state, data) {
  if (!state.request) {
    sendError(socket, null, "request_not_found", "没有活跃请求", false);
    return;
  }

  const frame = Buffer.from(data);
  if (frame.length < 48 || frame.toString("ascii", 0, 4) !== "MSVA") {
    sendError(
      socket,
      state.request.id,
      "invalid_audio_frame",
      "音频帧头无效",
      true,
    );
    state.request = null;
    return;
  }

  const version = frame.readUInt8(4);
  const kind = frame.readUInt8(5);
  const headerLength = frame.readUInt16BE(8);
  const sequence = frame.readUInt32BE(12);
  const payloadLength = frame.readUInt32BE(24);
  const requestId = bytesToUuid(frame.subarray(32, 48));

  if (
    version !== 1 ||
    kind !== 1 ||
    headerLength !== 48 ||
    frame.length !== headerLength + payloadLength ||
    requestId !== state.request.id ||
    sequence !== state.request.lastSequence + 1 ||
    payloadLength === 0 ||
    payloadLength % 2 !== 0
  ) {
    sendError(
      socket,
      state.request.id,
      "invalid_audio_frame",
      "音频帧字段或序号无效",
      true,
    );
    state.request = null;
    return;
  }

  state.request.lastSequence = sequence;
  state.request.frameCount += 1;
  state.request.sampleCount += payloadLength / 2;

  if (state.request.frameCount % 25 === 0) {
    state.request.revision += 1;
    const seconds = (state.request.sampleCount / 16_000).toFixed(1);
    send(socket, "asr.partial", state.request.id, {
      text: `正在识别，本地 Mock 已接收 ${seconds} 秒音频…`,
      revision: state.request.revision,
      stable_prefix_length: 4,
    });
  }
}

function commitInput(socket, state, message) {
  const request = state.request;
  if (!request || request.id !== message.request_id) {
    sendError(
      socket,
      message.request_id,
      "request_not_found",
      "请求不存在",
      false,
    );
    return;
  }

  const payload = message.payload ?? {};
  const matches =
    payload.last_sequence ===
      (request.frameCount > 0 ? request.lastSequence : null) &&
    payload.frame_count === request.frameCount &&
    payload.sample_count === request.sampleCount;

  if (!matches) {
    sendError(
      socket,
      request.id,
      "audio_commit_mismatch",
      "提交统计与音频帧不一致",
      true,
    );
    state.request = null;
    return;
  }

  if (hasFault("input_committed_timeout")) return;

  send(socket, "input.committed", request.id, {
    accepted_duration_ms: Math.round((request.sampleCount / 16_000) * 1_000),
  });
  console.log(`Input committed (${request.frameCount} frames).`);

  const requestId = request.id;
  const durationMs = Math.round((request.sampleCount / 16_000) * 1_000);
  injectProtocolFaults(socket, requestId);
  if (hasFault("disconnect_during_request")) {
    socket.close(1_011, "injected disconnect");
    return;
  }
  if (hasFault("request_done_early")) {
    sendRequestDone(socket, requestId, durationMs);
    state.request = null;
    return;
  }
  setTimeout(() => {
    if (state.request?.id !== requestId) {
      return;
    }
    if (hasFault("asr_final_missing")) return;
    send(socket, "asr.final", requestId, {
      text: "这是来自本地 Mock 服务的识别结果。",
      language: "zh-CN",
      confidence: 0.99,
      duration_ms: durationMs,
    });
  }, 250);

  if (request.mode === "assistant") {
    const deltas = ["这是", "来自本地 Mock 服务的", "流式助手回复。"];
    const llmDelay = hasFault("llm_first_token_delay")
      ? faultConfig.delayMs
      : 350;
    deltas.forEach((delta, sequence) => {
      setTimeout(
        () => {
          if (state.request?.id !== requestId) {
            return;
          }
          send(socket, "assistant.text.delta", requestId, {
            sequence,
            delta,
          });
        },
        llmDelay + sequence * 80,
      );
    });

    setTimeout(
      () => {
        if (state.request?.id !== requestId) {
          return;
        }
        send(socket, "assistant.text.done", requestId, {
          text: deltas.join(""),
          last_sequence: deltas.length - 1,
          finish_reason: "stop",
          usage: {
            input_tokens: 12,
            output_tokens: 18,
          },
        });
      },
      llmDelay + deltas.length * 80,
    );

    if (request.wantsAudio) {
      setTimeout(
        () => {
          if (state.request?.id !== requestId) {
            return;
          }
          streamMockAudio(socket, state, requestId, durationMs);
        },
        Math.max(430, llmDelay + 80),
      );
    } else {
      setTimeout(
        () => {
          if (state.request?.id !== requestId) {
            return;
          }
          if (hasFault("request_done_missing")) return;
          sendRequestDone(socket, requestId, durationMs, llmDelay);
          state.request = null;
        },
        Math.max(650, llmDelay + deltas.length * 80 + 50),
      );
    }
    return;
  }

  setTimeout(() => {
    if (state.request?.id !== requestId) {
      return;
    }
    if (hasFault("request_done_missing")) return;
    sendRequestDone(socket, requestId, durationMs);
    state.request = null;
  }, 300);
}

function cancelRequest(socket, state, message) {
  if (hasFault("cancellation_timeout")) return;
  if (state.request?.id === message.request_id) {
    state.request = null;
  }
  send(socket, "request.cancelled", message.request_id, {
    reason: message.payload?.reason ?? "user_cancelled",
  });
  console.log("Request cancelled.");
}

function createServerHello() {
  return {
    session_id: randomUUID(),
    protocol_version: 1,
    pipeline: "cascade",
    limits: {
      max_recording_ms: 60_000,
      max_json_bytes: 65_536,
      max_binary_bytes: 65_536,
    },
    features: {
      streaming_asr: true,
      streaming_text: true,
      streaming_audio: true,
      cancellation: true,
    },
    inference_options: {
      defaults: {
        asr: "asr-mock",
        llm: "llm-mock",
        tts: "tts-mock",
        output_audio: "pcm16-24k-mono",
      },
      asr: [
        {
          id: "asr-mock",
          name: "Mock ASR",
          description: "Deterministic local protocol test recognizer",
        },
      ],
      llm: [
        {
          id: "llm-mock",
          name: "Mock LLM",
          description: "Deterministic streaming text generator",
        },
      ],
      tts: [
        {
          id: "tts-mock",
          name: "Mock TTS",
          description: "Placeholder for capability negotiation",
        },
      ],
      output_audio: [
        {
          id: "pcm16-24k-mono",
          name: "PCM 24 kHz Mono",
          description: "Mock output audio capability",
          encoding: "pcm_s16le",
          sample_rate: 24_000,
          channels: 1,
        },
      ],
    },
    recognition_languages: [
      { id: "auto", name: "自动识别" },
      { id: "zh-CN", name: "简体中文" },
      { id: "en-US", name: "English" },
    ],
    voices: [
      { id: "default", name: "默认音色" },
      { id: "mock_audio", name: "Mock Audio" },
    ],
    heartbeat: {
      interval_ms: 15_000,
      timeout_ms: 10_000,
    },
  };
}

function streamMockAudio(socket, state, requestId, inputDurationMs) {
  send(socket, "output.audio.start", requestId, {
    encoding: "pcm_s16le",
    sample_rate: outputSampleRate,
    channels: 1,
    voice: state.request?.voice ?? "default",
  });

  const chunkCount = Math.ceil(mockPcm.length / outputChunkBytes);
  let sequence = 0;
  const sendNext = () => {
    if (
      state.request?.id !== requestId ||
      socket.readyState !== WebSocket.OPEN
    ) {
      return;
    }
    const start = sequence * outputChunkBytes;
    const end = Math.min(start + outputChunkBytes, mockPcm.length);
    let frame = createOutputAudioFrame(
      requestId,
      sequence,
      sequence * outputChunkDurationMs * 1_000,
      mockPcm.subarray(start, end),
    );
    if (hasFault("corrupt_audio_frame") && sequence === 0) {
      frame = Buffer.from(frame);
      frame.write("BAD!", 0, "ascii");
    }
    socket.send(frame);
    sequence += 1;

    if (hasFault("tts_midstream_failure") && sequence === 1) {
      sendProtocolError(
        socket,
        requestId,
        "tts_stream_failed",
        "注入的 TTS 中途失败",
        "tts",
        false,
      );
      setTimeout(() => {
        if (state.request?.id !== requestId) return;
        if (!hasFault("request_done_missing")) {
          sendRequestDone(socket, requestId, inputDurationMs);
        }
        state.request = null;
      }, 300);
      return;
    }

    if (sequence < chunkCount) {
      setTimeout(sendNext, outputSendIntervalMs);
      return;
    }

    const sampleCount = mockPcm.length / 2;
    const durationMs = Math.round((sampleCount / outputSampleRate) * 1_000);
    send(socket, "output.audio.done", requestId, {
      last_sequence: chunkCount - 1,
      chunk_count: chunkCount,
      sample_count: sampleCount,
      duration_ms: durationMs,
    });
    if (!hasFault("request_done_missing")) {
      sendRequestDone(socket, requestId, inputDurationMs, 350, {
        audio_first_chunk_after_commit: 430,
        server_total_after_commit:
          430 + (chunkCount - 1) * outputSendIntervalMs,
      });
    }
    state.request = null;
  };

  sendNext();
}

function createOutputAudioFrame(requestId, sequence, timestampUs, pcm) {
  const frame = Buffer.alloc(48 + pcm.length);
  frame.write("MSVA", 0, "ascii");
  frame.writeUInt8(1, 4);
  frame.writeUInt8(2, 5);
  frame.writeUInt16BE(48, 8);
  frame.writeUInt32BE(sequence, 12);
  frame.writeBigUInt64BE(BigInt(timestampUs), 16);
  frame.writeUInt32BE(pcm.length, 24);
  Buffer.from(requestId.replaceAll("-", ""), "hex").copy(frame, 32);
  pcm.copy(frame, 48);
  return frame;
}

function loadMockAudio() {
  const audioPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "mock_audio.m4a",
  );
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      audioPath,
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      String(outputSampleRate),
      "pipe:1",
    ],
    { encoding: null, maxBuffer: 16 * 1_024 * 1_024 },
  );
  if (result.error || result.status !== 0 || !result.stdout?.length) {
    const detail = result.stderr?.toString("utf8").trim();
    throw new Error(
      `无法解码 mock_audio.m4a，请确认 ffmpeg 可用${detail ? `：${detail}` : ""}`,
    );
  }
  if (result.stdout.length % 2 !== 0) {
    throw new Error("mock_audio.m4a 解码后的 PCM 长度无效");
  }
  console.log(
    `Loaded mock_audio.m4a (${(result.stdout.length / 2 / outputSampleRate).toFixed(2)} s).`,
  );
  return result.stdout;
}

function send(socket, type, requestId, payload, eventId = randomUUID()) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(
    JSON.stringify({
      v: 1,
      type,
      event_id: eventId,
      request_id: requestId,
      sent_at_ms: Date.now(),
      payload,
    }),
  );
}

function sendError(socket, requestId, code, message, fatal) {
  sendProtocolError(
    socket,
    requestId,
    code,
    message,
    requestId ? "input" : "protocol",
    fatal,
  );
}

function sendProtocolError(socket, requestId, code, message, stage, fatal) {
  send(socket, "error", requestId, {
    code,
    message,
    stage,
    recoverable: !fatal,
    fatal,
    details: {},
  });
}

function sendRequestDone(
  socket,
  requestId,
  inputDuration,
  llmFirstToken = 350,
  extra = {},
) {
  send(socket, "request.done", requestId, {
    result: "success",
    timing_ms: {
      input_duration: inputDuration,
      asr_final_after_commit: 250,
      llm_first_token_after_commit: llmFirstToken,
      server_total_after_commit: Math.max(300, llmFirstToken + 300),
      ...extra,
    },
  });
}

function injectProtocolFaults(socket, requestId) {
  if (hasFault("duplicate_event_id")) {
    const eventId = randomUUID();
    send(
      socket,
      "asr.partial",
      requestId,
      { text: "重复事件", revision: 0 },
      eventId,
    );
    send(
      socket,
      "asr.partial",
      requestId,
      { text: "重复事件", revision: 0 },
      eventId,
    );
  }
  if (hasFault("stale_request_id")) {
    send(socket, "asr.partial", randomUUID(), {
      text: "过期请求",
      revision: 0,
    });
  }
  if (hasFault("unknown_message_type")) {
    send(socket, "mock.unknown", requestId, { injected: true });
  }
  if (hasFault("out_of_order_control")) {
    send(socket, "output.audio.done", requestId, {
      last_sequence: 0,
      chunk_count: 1,
      sample_count: 1,
      duration_ms: 1,
    });
  }
}

function bytesToUuid(bytes) {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

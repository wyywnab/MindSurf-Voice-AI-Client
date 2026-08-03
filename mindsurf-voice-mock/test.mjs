import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import { WebSocket } from "ws";

const port = 18_000 + Math.floor(Math.random() * 1_000);
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: import.meta.dirname,
  env: { ...process.env, PORT: String(port), MOCK_AUTH_TOKEN: "test-token" },
  stdio: ["ignore", "pipe", "inherit"],
});

try {
  await waitForListening(child);
  await runProtocolFlow(port, "dictation");
  await runProtocolFlow(port, "assistant");
  await runAuthenticationFailure(port, "wrong-token", "authentication_failed");
  await runAuthenticationFailure(port, null, "authentication_required");
  await runAuthenticationFailure(port, "expired-token", "token_expired");
} finally {
  child.kill();
}

const faultPort = port + 1_000;
const faultChild = spawn(
  process.execPath,
  [
    "server.mjs",
    "--fault",
    "duplicate_event_id,stale_request_id,unknown_message_type,out_of_order_control",
  ],
  {
    cwd: import.meta.dirname,
    env: { ...process.env, PORT: String(faultPort) },
    stdio: ["ignore", "pipe", "inherit"],
  },
);
try {
  await waitForListening(faultChild);
  await runInjectedProtocolMessages(faultPort);
  console.log("Mock normal and injected protocol flows passed.");
} finally {
  faultChild.kill();
}

function runProtocolFlow(serverPort, mode) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const socket = new WebSocket(
      `ws://127.0.0.1:${serverPort}/v1/voice/ws`,
      "mindsurf.voice.v1",
    );
    let committed = false;
    let finalReceived = false;
    let assistantDone = false;
    let assistantText = "";
    let assistantSequence = -1;
    let audioStarted = false;
    let audioDone = false;
    let audioSequence = -1;
    let audioSamples = 0;

    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("mock protocol test timed out"));
    }, 15_000);

    socket.on("open", () => {
      send(socket, "client.hello", null, {
        client: {
          name: "mock-test",
          version: "0.1.0",
          platform: "windows",
          arch: "x86_64",
        },
        protocol_versions: [1],
        pipelines: ["cascade"],
        input_audio: [
          { encoding: "pcm_s16le", sample_rate: 16_000, channels: 1 },
        ],
        output_audio: [
          {
            encoding: "pcm_s16le",
            sample_rates: [16_000, 24_000],
            channels: 1,
          },
        ],
        auth: { scheme: "bearer", token: "test-token" },
      });
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.from(data);
        if (
          !audioStarted ||
          frame.readUInt8(5) !== 2 ||
          frame.readUInt32BE(12) !== audioSequence + 1
        ) {
          reject(new Error("output audio frame is invalid"));
          return;
        }
        audioSequence = frame.readUInt32BE(12);
        audioSamples += frame.readUInt32BE(24) / 2;
        return;
      }
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "server.hello") {
        send(socket, "request.start", requestId, {
          mode,
          language: "zh-CN",
          conversation_id: null,
          selection: {
            asr: "asr-mock",
            llm: mode === "assistant" ? "llm-mock" : null,
            tts: mode === "assistant" ? "tts-mock" : null,
            output_audio: mode === "assistant" ? "pcm16-24k-mono" : null,
          },
          input_audio: {
            encoding: "pcm_s16le",
            sample_rate: 16_000,
            channels: 1,
            frame_duration_ms: 20,
          },
          response: {
            text: mode === "assistant",
            audio: mode === "assistant",
            voice: "default",
          },
        });
      } else if (message.type === "request.accepted") {
        socket.send(createAudioFrame(requestId));
        send(socket, "input.commit", requestId, {
          last_sequence: 0,
          frame_count: 1,
          sample_count: 320,
          duration_ms: 20,
        });
      } else if (message.type === "input.committed") {
        committed = true;
      } else if (message.type === "asr.final") {
        finalReceived = true;
      } else if (message.type === "assistant.text.delta") {
        if (message.payload.sequence !== assistantSequence + 1) {
          reject(new Error("assistant delta sequence is invalid"));
          return;
        }
        assistantSequence = message.payload.sequence;
        assistantText += message.payload.delta;
      } else if (message.type === "assistant.text.done") {
        assistantDone =
          message.payload.last_sequence === assistantSequence &&
          message.payload.text === assistantText;
      } else if (message.type === "output.audio.start") {
        audioStarted =
          message.payload.encoding === "pcm_s16le" &&
          message.payload.sample_rate === 24_000 &&
          message.payload.channels === 1;
      } else if (message.type === "output.audio.done") {
        audioDone =
          message.payload.last_sequence === audioSequence &&
          message.payload.chunk_count === audioSequence + 1 &&
          message.payload.sample_count === audioSamples;
      } else if (message.type === "request.done") {
        clearTimeout(timeout);
        socket.close();
        if (
          committed &&
          finalReceived &&
          (mode === "dictation" || (assistantDone && audioStarted && audioDone))
        ) {
          resolve();
        } else {
          reject(new Error("mock response sequence is incomplete"));
        }
      } else if (message.type === "error") {
        clearTimeout(timeout);
        socket.close();
        reject(
          new Error(`${message.payload.code}: ${message.payload.message}`),
        );
      }
    });

    socket.on("error", reject);
  });
}

function runAuthenticationFailure(serverPort, token, expectedCode) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${serverPort}/v1/voice/ws`,
      "mindsurf.voice.v1",
    );
    const timeout = setTimeout(
      () => reject(new Error("auth test timed out")),
      3_000,
    );
    socket.on("open", () => {
      send(socket, "client.hello", null, {
        client: {
          name: "mock-test",
          version: "0.1.0",
          platform: "windows",
          arch: "x86_64",
        },
        protocol_versions: [1],
        pipelines: ["cascade"],
        input_audio: [],
        output_audio: [],
        ...(token ? { auth: { scheme: "bearer", token } } : {}),
      });
    });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.type === "error") {
        clearTimeout(timeout);
        socket.close();
        if (message.payload.code === expectedCode) resolve();
        else
          reject(new Error(`unexpected auth error: ${message.payload.code}`));
      }
    });
    socket.on("error", reject);
  });
}

function runInjectedProtocolMessages(serverPort) {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const socket = new WebSocket(
      `ws://127.0.0.1:${serverPort}/v1/voice/ws`,
      "mindsurf.voice.v1",
    );
    const received = [];
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("fault injection test timed out"));
    }, 5_000);
    socket.on("open", () => {
      send(socket, "client.hello", null, {
        client: {
          name: "fault-test",
          version: "0.1.0",
          platform: "windows",
          arch: "x86_64",
        },
        protocol_versions: [1],
        pipelines: ["cascade"],
        input_audio: [],
        output_audio: [],
      });
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = JSON.parse(data.toString("utf8"));
      received.push(message);
      if (message.type === "server.hello") {
        send(socket, "request.start", requestId, {
          mode: "dictation",
          language: "auto",
          selection: {
            asr: "asr-mock",
            llm: null,
            tts: null,
            output_audio: null,
          },
          response: { text: false, audio: false, voice: "default" },
        });
      } else if (message.type === "request.accepted") {
        send(socket, "input.commit", requestId, {
          last_sequence: null,
          frame_count: 0,
          sample_count: 0,
          duration_ms: 0,
        });
      }
      const partials = received.filter(
        (item) => item.type === "asr.partial" && item.request_id === requestId,
      );
      const hasDuplicate =
        partials.length >= 2 && partials[0].event_id === partials[1].event_id;
      const hasStale = received.some(
        (item) => item.type === "asr.partial" && item.request_id !== requestId,
      );
      const hasUnknown = received.some((item) => item.type === "mock.unknown");
      const hasOutOfOrder = received.some(
        (item) => item.type === "output.audio.done",
      );
      if (hasDuplicate && hasStale && hasUnknown && hasOutOfOrder) {
        clearTimeout(timeout);
        socket.close();
        resolve();
      }
    });
    socket.on("error", reject);
  });
}

function createAudioFrame(requestId) {
  const buffer = Buffer.alloc(48 + 640);
  buffer.write("MSVA", 0, "ascii");
  buffer.writeUInt8(1, 4);
  buffer.writeUInt8(1, 5);
  buffer.writeUInt16BE(48, 8);
  buffer.writeUInt32BE(0, 12);
  buffer.writeBigUInt64BE(0n, 16);
  buffer.writeUInt32BE(640, 24);
  uuidBytes(requestId).copy(buffer, 32);
  return buffer;
}

function send(socket, type, requestId, payload) {
  socket.send(
    JSON.stringify({
      v: 1,
      type,
      event_id: randomUUID(),
      request_id: requestId,
      sent_at_ms: Date.now(),
      payload,
    }),
  );
}

function uuidBytes(uuid) {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

function waitForListening(processHandle) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("mock server did not start")),
      5_000,
    );
    processHandle.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("MindSurf mock listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    processHandle.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`mock server exited with code ${code}`));
    });
  });
}

import { readServiceTokenForConnection } from "../settings/credentials";
import type { ServiceConnectionTestResult } from "../../types/settings";
import { VoiceTransport, type VoiceClientIdentity } from "./voiceTransport";

export function testVoiceServiceConnection(
  url: string,
  identity: VoiceClientIdentity,
  profileId: string,
  useToken: boolean,
  preferredPipeline: "auto" | "cascade" | "native_audio",
): Promise<ServiceConnectionTestResult> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let settled = false;
    const finish = (
      action: () => void,
      transport: VoiceTransport,
      timer: ReturnType<typeof setTimeout>,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      transport.disconnect();
      action();
    };
    const transport = new VoiceTransport(
      url,
      identity,
      {
        onAudioFrame: () => undefined,
        onControlMessage: (message) => {
          if (message.type !== "error") return;
          const payload = message.payload as { code?: string; message?: string };
          finish(
            () => reject(new Error(payload.message || payload.code || "连接测试失败")),
            transport,
            timer,
          );
        },
        onReconnectAttempt: () => undefined,
        onServerHello: (hello) => {
          if (preferredPipeline !== "auto" && hello.pipeline !== preferredPipeline) {
            finish(
              () =>
                reject(
                  new Error(
                    `服务 Pipeline 为 ${hello.pipeline}，与档案要求的 ${preferredPipeline} 不一致`,
                  ),
                ),
              transport,
              timer,
            );
            return;
          }
          const modelCount =
            hello.inference_options.asr.length +
            hello.inference_options.llm.length +
            hello.inference_options.tts.length +
            hello.inference_options.output_audio.length;
          finish(
            () =>
              resolve({
                elapsedMs: Math.round(performance.now() - startedAt),
                pipeline: hello.pipeline,
                protocolVersion: hello.protocol_version,
                serverId: hello.session_id,
                modelCount,
              }),
            transport,
            timer,
          );
        },
        onStatusChange: () => undefined,
        onTransportError: (error) => {
          finish(() => reject(error), transport, timer);
        },
      },
      {
        autoReconnect: false,
        tokenProvider: () =>
          useToken ? readServiceTokenForConnection(profileId) : Promise.resolve(null),
      },
    );
    const timer = setTimeout(() => {
      finish(() => reject(new Error("连接测试超时")), transport, timer);
    }, 8_000);
    transport.connect();
  });
}

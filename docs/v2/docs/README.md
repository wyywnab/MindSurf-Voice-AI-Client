# v2 语义文档

MindSurf Voice API v2 是单轮实时语音文本协议，只支持：

- `asr_only`：ASR；
- `asr_llm`：ASR 后执行 LLM，作为一个完整流程。

两种模式都把流式文本写入客户端临时区域，并在阶段末用全量 snapshot 覆盖。只有最终
snapshot 后的 `request.done` 才允许客户端把临时文本写入真实目标。

- [HTTP API v2](./HTTP_API_V2.md)
- [WebSocket API v2](./WS_PROTOCOL_V2.md)
- [Request 生命周期](./request-lifecycle.md)
- [后端仓库接入](./backend-integration.md)

本版本不定义 Assistant、Conversation、TTS、下行音频、音色或情绪能力。

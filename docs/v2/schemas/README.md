# WebSocket JSON Schemas

- `client-messages.schema.json`：5 种客户端消息；
- `server-messages.schema.json`：9 种服务端消息；
- `envelope.schema.json`：固定信封；
- `common/audio.schema.json`：上行 PCM16；
- `common/request.schema.json`：mode、selection、统计和用量；
- `common/errors.schema.json`：稳定错误。

核心约束：

- mode 只允许 asr_only 和 asr_llm；
- asr_only 的 llm 必须为 null 且不能携带 generation；
- asr_llm 的 llm 必须非空；
- 两种模式共用 output.text.delta 和 output.text.snapshot；
- ASR 和 LLM 的 delta sequence 分别从 0 连续递增，snapshot 是临时区域全量覆盖；
- 录音期间允许 ASR delta 和 final=false 修订 snapshot，commit 后仍以完整 ASR snapshot 收口；
- asr_llm 使用空的 LLM final=false snapshot 切换输出阶段，随后允许 LLM delta，并以
  LLM final=true snapshot 收口；
- request.done 只允许 success，不定义 partial；
- quota reservation 和终态 usage 分别列出 ASR、LLM 润色和合计 credits；
- 请求级 terminal error 必须携带 usage，会话级 error 不得携带 usage；
- 会话级 error 使用 request_id=null、terminal=false；请求级 error 使用 UUID、terminal=true、fatal=false；
- error code 固定对应 stage、retryable、fatal 和作用域，限流与选择错误包含必需 details；
- client.hello 不含 auth，Upgrade 已通过一次性 ticket 认证。
- server.hello 的 heartbeat_timeout_ms 必须小于 heartbeat_interval_ms；该跨字段约束由测试向量校验。

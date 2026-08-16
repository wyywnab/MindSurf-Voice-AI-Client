# MindSurf Voice WebSocket 接口协议

> 协议版本：2
>
> 文档状态：Frozen
>
> 子协议：`mindsurf.voice.v2`
>
> 传输层：WebSocket（RFC 6455）

## 1. 范围

WebSocket v2 提供长期在线的单轮语音文本处理：

- `asr_only`：ASR 最终文本；
- `asr_llm`：ASR 后执行 LLM，最终 LLM 文本是完整流程结果。

两种模式都使用统一的 `output.text.*` 更新客户端临时文本区域。协议不把 ASR 和 LLM
建模为两个独立输出流。只有最终全量 snapshot 和 request.done 都到达后，客户端才把
临时文本写入真实目标。

系统浏览器授权、Token、额度、能力和 ticket 由 [HTTP API](./HTTP_API_V2.md) 定义；状态与提交语义见
[Request 生命周期](./request-lifecycle.md)。本协议不包含 Conversation、Assistant、TTS、
下行音频、音色或情绪。

## 2. 长期连接

客户端通过系统浏览器授权并换取 Token 后立即申请 ticket、建立 WebSocket，并在已登录可用期间保持在线：

```text
browser auth/token exchange or refresh -> realtime ticket -> Upgrade -> hello
                                          |
                                          +-- idle + heartbeat
                                          +-- request -> terminal -> idle
                                          +-- request -> terminal -> idle
```

- 空闲状态不得仅因没有请求而关闭连接；
- 请求结束后连接回到 idle 并继续复用；
- 同一连接最多一个活跃请求；
- 心跳在 idle 和请求期间都运行；
- 网络中断及 1001、1011、4002、4003 等可恢复关闭自动申请新 ticket 重连，但不得恢复或重放活跃请求；
  1002 和 4001 不自动重连；
- logout、账户禁用或 session 撤销后清除登录态，不自动重连。

## 3. Upgrade 鉴权

客户端用 HTTP access token 调用 `POST /v2/realtime/tickets`，随后立即连接：

```text
wss://api.example.com/v2/voice/ws?ticket=<one-time-ticket>
```

上式路径只是示例。客户端必须使用本次 `POST /v2/realtime/tickets` 响应中的
`websocket_path`，它是该 ticket 的唯一权威建连路径；不得硬编码示例路径，也不得以较早获取的
capabilities 路径覆盖 ticket 响应。客户端以签发 ticket 的 HTTP API origin 为 authority，
将 `https` 映射为 `wss`（显式本地开发的 `http` 映射为 `ws`），再解析该绝对路径并追加
percent-encoded ticket query；不得接受 ticket 响应指定其他 authority。

ticket 是一次性凭据，默认 30 秒过期、只消费一次、绑定用户，只能用于 Upgrade。应用、代理和后端访问
日志必须脱敏 ticket query。后端先校验 Origin、请求路径和子协议，再校验 ticket、用户状态与
连接限制；全部通过后，在提交 101 响应的同一原子边界消费 ticket。浏览器客户端必须携带受
允许的 Origin；原生客户端可以不携带 Origin，但只要携带就必须命中允许列表，不能通过伪造
空 Origin 绕过校验。

Upgrade 失败使用以下稳定 HTTP 结果；响应体使用 HTTP API 的 ErrorResponse。WebSocket API
可能无法向客户端暴露响应体，因此客户端行为必须至少能仅依据状态码安全降级。

| HTTP | code | ticket 是否消费 | 客户端行为 |
|---:|---|---:|---|
| 400 | `invalid_request` | 否 | 修正路径、Upgrade 头或请求格式后再连接 |
| 401 | `realtime_ticket_invalid` | 否 | ticket 缺失、无效或绑定不匹配；申请新 ticket |
| 401 | `realtime_ticket_expired` | 否 | ticket 已过期；申请新 ticket |
| 409 | `realtime_ticket_consumed` | 已消费 | 不复用，申请新 ticket |
| 403 | `origin_not_allowed` | 否 | 修正客户端 Origin 配置，不自动重试 |
| 403 | `account_suspended` | 否 | 清除可用态，不自动重连 |
| 426 | `websocket_subprotocol_required` | 否 | 修正为 `mindsurf.voice.v2`，不自动重试 |
| 429 | `realtime_connection_limit` | 否 | 关闭旧连接或退避后申请新 ticket |
| 503 | `service_unavailable` | 否 | 退避后申请新 ticket |

如果服务端已消费 ticket 并提交 101，但客户端未观察到成功，结果按异常断线处理；客户端不得
复用该 ticket，必须申请新 ticket。ticket 签发时可以预检查连接上限，但 Upgrade 时必须复查。

Upgrade 成功即表示 WS session 已认证，client.hello 不再携带 Bearer Token。access token
自然过期不关闭健康的长连接；logout、账户禁用和安全撤销必须发送 session_revoked fatal
error 并关闭现有连接。

允许自动重连的异常断线后，如果 access token 已过期则先 refresh，再申请新 ticket。建议重连退避为
250 ms、500 ms、1 s、2 s，之后上限 5 s 并加入随机抖动。

## 4. 控制信封

所有 Text Message 都是 UTF-8 JSON：

```json
{
  "v": 2,
  "type": "session.pong",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf0d",
  "request_id": null,
  "sent_at_ms": 1786723215001,
  "payload": {"nonce": "hb-1"}
}
```

- `v` 固定为 2；
- event_id 在当前 session 唯一，推荐 UUIDv7；
- request_id 由客户端为每次逻辑请求生成 UUID，并且在用户账户范围内永久不可复用；重试、
  重连和相同录音的再次提交也必须使用新 ID；
- 会话消息 request_id=null，请求消息必须携带 UUID；
- sent_at_ms 只用于诊断，不决定顺序；
- 顶层未知字段拒绝，payload 未知非关键字段忽略；
- 重复 event ID 静默忽略并记录。

## 5. Hello

打开后 3 秒内发送：

```json
{
  "v": 2,
  "type": "client.hello",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf0a",
  "request_id": null,
  "sent_at_ms": 1786723200000,
  "payload": {
    "client": {
      "name": "mindsurf-voice-ai",
      "version": "2.0.0",
      "platform": "macos",
      "arch": "aarch64"
    },
    "protocol_versions": [2],
    "input_audio": [{"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1}]
  }
}
```

后端 3 秒内返回：

```json
{
  "v": 2,
  "type": "server.hello",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf0b",
  "request_id": null,
  "sent_at_ms": 1786723200010,
  "payload": {
    "session_id": "019d643e-1550-761a-b7a0-471791bcaf0c",
    "protocol_version": 2,
    "input_audio": {"encoding": "pcm_s16le", "sample_rate": 16000, "channels": 1},
    "heartbeat_interval_ms": 15000,
    "heartbeat_timeout_ms": 5000,
    "input_idle_timeout_ms": 10000,
    "limits": {
      "max_control_bytes": 65536,
      "max_binary_bytes": 65584,
      "max_recording_ms": 120000
    }
  }
}
```

握手完成前不得发送请求或音频。

## 6. 心跳

后端定期发送：

```json
{
  "v": 2,
  "type": "session.ping",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf0e",
  "request_id": null,
  "sent_at_ms": 1786723215000,
  "payload": {"nonce": "hb-1"}
}
```

服务端在任一时刻最多允许一个尚未收到 pong 的 ping，并且必须保证
`heartbeat_timeout_ms < heartbeat_interval_ms`。服务端从发送 ping 时开始计算 pong deadline；
客户端收到 ping 后应立即返回相同 nonce 的 session.pong，业务消息不能替代 pong。服务端收到
匹配 pong 后清除 outstanding 状态；重复、过期或 nonce 不匹配的 pong 只记录诊断，不能满足
当前 heartbeat。下一次 ping 的发送时间不得早于上一次 ping 发送时间加
`heartbeat_interval_ms`。

服务端在 deadline 前没有收到匹配 pong 时关闭 `4002`。客户端从 `server.hello` 或最近一次
合法 ping 起，超过 `heartbeat_interval_ms + heartbeat_timeout_ms` 仍未收到下一次 ping 时，
也必须主动关闭连接并按异常断线恢复。这样两端都能发现半开连接，且实现不需要维护多个 nonce。

## 7. 输入音频

每个 Binary Message 是 `48 字节头部 + PCM16LE payload`：

| 偏移 | 长度 | 字段 | 编码 |
|---:|---:|---|---|
| 0 | 4 | magic `MSVA` | ASCII |
| 4 | 1 | version `2` | uint8 |
| 5 | 1 | kind `1` INPUT_PCM | uint8 |
| 6 | 2 | flags=0 | uint16 big-endian |
| 8 | 2 | header_length=48 | uint16 big-endian |
| 10 | 2 | reserved=0 | uint16 big-endian |
| 12 | 4 | sequence | uint32 big-endian |
| 16 | 8 | timestamp_us | uint64 big-endian |
| 24 | 4 | payload_length | uint32 big-endian |
| 28 | 4 | reserved=0 | uint32 big-endian |
| 32 | 16 | request UUID | RFC 4122 字节顺序 |
| 48 | N | PCM payload | signed 16-bit little-endian |

sequence 从 0 连续递增；payload 长度必须为正偶数且不得使整个 Binary Message 超过
`server.hello.limits.max_binary_bytes`；UUID 必须属于当前请求。v2 不定义下行二进制帧。

`timestamp_us` 是该帧首样本相对本请求首样本的媒体时间，不是采集设备墙钟。设本帧前
已发送的样本总数为 `samples_before`，则必须满足：

```text
timestamp_us = floor(samples_before * 1_000_000 / negotiated_sample_rate)
```

服务端必须校验 sequence、timestamp 和 UUID；任一不一致都以请求级 terminal
`invalid_audio_frame` 结束当前请求。WebSocket 保证同一连接内消息有序，因此客户端必须先
发送全部 INPUT_PCM，再发送 `input.commit`。

## 8. 请求开始

```json
{
  "v": 2,
  "type": "request.start",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf10",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723220000,
  "payload": {
    "mode": "asr_llm",
    "pipeline": "general-asr-llm",
    "capabilities_revision": "cap-2026-08-15-1",
    "selection": {"asr": "whisper-large-v3", "llm": "qwen-text"},
    "language": "zh-CN",
    "generation": {"temperature": 0.2}
  }
}
```

asr_only 必须使用 llm=null 并省略 generation；asr_llm 必须选择 LLM。

```json
{
  "v": 2,
  "type": "request.accepted",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf12",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723220010,
  "payload": {
    "mode": "asr_llm",
    "pipeline": "general-asr-llm",
    "capabilities_revision": "cap-2026-08-15-1",
    "selection": {"asr": "whisper-large-v3", "llm": "qwen-text"},
    "language": "zh-CN",
    "generation": {"temperature": 0.2},
    "max_recording_ms": 120000,
    "quota_reservation": {
      "asr_credits": 8,
      "llm_credits": 4,
      "credits": 12
    }
  }
}
```

accepted 必须原样回显选择，不能 fallback。

后端按 capabilities revision 校验 language、generation 的 key、数值类型和范围。generation
省略时使用该 Pipeline 在该 revision 中的默认值，但 accepted 仍保持省略，不能把默认值伪装
成客户端选择；实际采用的默认值由该 revision 唯一确定。未知 key、越界值和不支持的 language
统一返回 `invalid_selection`，并在 `details.field` 中返回稳定字段路径。

`quota_reservation` 分别给出本请求为 ASR 和 LLM 润色预留的额度上限，并满足
`credits = asr_credits + llm_credits`。`asr_only` 的 `llm_credits` 必须为 0；
`asr_llm` 分别预留两个阶段。后端只有在两项预留能够一次性原子完成时才能 accepted，
最终每一项的实际扣费都不得超过对应预留。

`request.accepted.max_recording_ms` 是本请求唯一有效的录音上限，并且必须等于：

```text
min(server.hello.limits.max_recording_ms, selected_pipeline.max_recording_ms)
```

客户端从 accepted 起按该值限制录音；capabilities 中的值只用于 accepted 前的界面提示。

## 9. 输入提交

```json
{
  "v": 2,
  "type": "input.commit",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf13",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723228000,
  "payload": {"last_sequence": 79, "chunk_count": 80, "sample_count": 128000, "duration_ms": 8000}
}
```

```json
{
  "v": 2,
  "type": "input.committed",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf14",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723228010,
  "payload": {"last_sequence": 79, "chunk_count": 80, "sample_count": 128000, "duration_ms": 8000}
}
```

提交统计必须满足：

```text
last_sequence = chunk_count - 1
sample_count = sum(INPUT_PCM.payload_length / 2)
duration_ms = ceil(sample_count * 1000 / negotiated_sample_rate)
```

`input.committed` 返回服务端根据实际接收帧重新计算的规范统计，不是无条件回显。客户端
声明与服务端计算不一致时，以请求级 terminal `input_statistics_mismatch` 结束请求。零帧
请求不得 commit；至少收到一帧但检测不到有效语音时使用请求级 terminal `input_empty`。

`input_idle_timeout_ms` 从 `request.accepted` 发出时开始计时，每收到一个合法 INPUT_PCM 后
重置，收到 `input.commit` 后停止；超时以请求级 terminal `input_idle_timeout` 结束请求。

录音期间允许服务端穿插发送 ASR `output.text.delta` 和 `final=false` 修订 snapshot。
`input.committed` 是输入完整性边界：它发出前不得发送最终 ASR snapshot、启动 LLM 或发送
任何 LLM 输出。

## 10. 临时文本更新

ASR 可以从 recording 阶段开始流式输出。delta 追加到临时区域：

```json
{
  "v": 2,
  "type": "output.text.delta",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf15",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723224000,
  "payload": {"stage": "asr", "sequence": 0, "delta": "帮我整理"}
}
```

流式 ASR 可以随时用 `final=false` snapshot 全量修订此前假设：

```json
{
  "v": 2,
  "type": "output.text.snapshot",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf16",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723225000,
  "payload": {
    "stage": "asr",
    "text": "帮我整理",
    "final": false
  }
}
```

ASR 和 LLM 的 delta sequence 分别从 0 连续递增，snapshot 不重置 sequence。非流式 ASR
可以在录音期间不发送任何文本事件；客户端不得根据输出频率推断模型类型。

`input.committed` 后，后端必须用完整 ASR snapshot 收口：asr_only 使用 `final=true`；
asr_llm 使用 `final=false`。LLM stage 切换前的最后一条 ASR 事件必须是 snapshot，并以其全文
作为唯一 LLM 输入。asr_llm 随后必须先发送空 snapshot，原子清空 ASR 临时文本并切换到
LLM stage：

```json
{
  "v": 2,
  "type": "output.text.snapshot",
  "event_id": "019d643e-1550-761a-b7a0-471791bcbf16",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723229000,
  "payload": {
    "stage": "asr",
    "text": "帮我整理这段话。",
    "final": false
  }
}
```

```json
{
  "v": 2,
  "type": "output.text.snapshot",
  "event_id": "019d643e-1550-761a-b7a0-471791bcbf17",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723229100,
  "payload": {
    "stage": "llm",
    "text": "",
    "final": false
  }
}
```

这条 stage 切换 snapshot 是 asr_llm 的第一条 LLM 事件。此后不得再发送 ASR 事件；LLM
token 使用独立的 sequence 从 0 开始追加：

```json
{
  "v": 2,
  "type": "output.text.delta",
  "event_id": "019d643e-1550-761a-b7a0-471791bcbf18",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723229200,
  "payload": {"stage": "llm", "sequence": 0, "delta": "请帮我"}
}
```

LLM 完成后发送全量 final snapshot，覆盖流式拼接的临时文本：

```json
{
  "v": 2,
  "type": "output.text.snapshot",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf17",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723229600,
  "payload": {
    "stage": "llm",
    "text": "请帮我整理这段文字。",
    "final": true
  }
}
```

snapshot 必须原子替换临时区域全文，不能追加。LLM 的 `final=false` snapshot 只能是上述
text 为空的 stage 切换边界。final=false 永远不能触发真实目标写入。即使上游 ASR 或 LLM
只能整段返回，也沿用同一消息时序，只是对应阶段可以不发送 delta。

## 11. 请求完成和目标提交

```json
{
  "v": 2,
  "type": "request.done",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf18",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723229700,
  "payload": {
    "result": "success",
    "mode": "asr_llm",
    "final_text": "请帮我整理这段文字。",
    "usage": {
      "input_audio_ms": 8000,
      "llm_input_tokens": 9,
      "llm_output_tokens": 11,
      "asr_credits_charged": 5,
      "llm_credits_charged": 4,
      "credits_charged": 9
    }
  }
}
```

客户端只有同时满足以下条件才能把临时区域写入真实目标：

1. 已收到该请求唯一的 final=true snapshot；
2. 同一 request ID 的下一条请求级事件是 request.done；
3. request.done.final_text 与临时区域全文完全一致；
4. 中间没有取消、terminal error 或连接断开。

`session.ping` 等 request_id=null 的会话消息可以在 final snapshot 和 request.done 之间
穿插。request.done 是该请求最后一条请求级事件，不是连接上的最后一条消息。v2 不定义 partial。

发送 final=true snapshot 之前，后端必须在持久化状态中原子锁定 success 终态及最终 usage；
final snapshot 是完成决策已经胜出的外部标志。它发出后，同 request ID 的下一条请求级事件
只能是 request.done。此后到达的 request.cancel 已输掉竞态，服务端忽略并记录，不得返回
request.cancelled 或 terminal error。若无法完成终态锁定，后端不得发送 final snapshot。

## 12. 取消

```json
{
  "v": 2,
  "type": "request.cancel",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf19",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723225000,
  "payload": {"reason": "user_cancelled"}
}
```

```json
{
  "v": 2,
  "type": "request.cancelled",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf1a",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723225010,
  "payload": {
    "reason": "user_cancelled",
    "usage": {
      "input_audio_ms": 3000,
      "llm_input_tokens": 0,
      "llm_output_tokens": 0,
      "asr_credits_charged": 3,
      "llm_credits_charged": 0,
      "credits_charged": 3
    }
  }
}
```

取消、失败和断线都撤销真实目标提交资格。

request.cancel 可以在 request.start 之后、服务端锁定 success 终态之前发送，包括
request.accepted 到达前。客户端无法直接观察锁定点，因此即使已收到 final snapshot 仍可发送
cancel，但该 cancel 必然输掉竞态，服务端继续发送 request.done。客户端发送 cancel 后必须
撤销本地提交资格，即使随后收到 request.done 也不得写入真实目标。
客户端发送 cancel 后必须立即停止发送 INPUT_PCM，且不得再发送 input.commit。客户端等待
最先到达的合法终态；已经排队的 accepted 或输出消息不能恢复提交资格。

## 13. 错误

```json
{
  "v": 2,
  "type": "error",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf1b",
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf11",
  "sent_at_ms": 1786723220020,
  "payload": {
    "code": "quota_exhausted",
    "message": "当前额度不足",
    "stage": "quota",
    "terminal": true,
    "retryable": false,
    "fatal": false,
    "details": {},
    "usage": {
      "input_audio_ms": 0,
      "llm_input_tokens": 0,
      "llm_output_tokens": 0,
      "asr_credits_charged": 0,
      "llm_credits_charged": 0,
      "credits_charged": 0
    }
  }
}
```

稳定错误：

| code | stage | 语义 |
|---|---|---|
| invalid_message | protocol | JSON 或状态非法 |
| unsupported_message_type | protocol | 未知客户端消息 |
| protocol_version_mismatch | protocol | 版本不兼容 |
| handshake_required | protocol | hello 前发送业务数据 |
| request_in_progress | request | 已有活跃请求 |
| request_not_found | request | request ID 不属于 session |
| request_id_reused | request | request ID 已被当前账户使用过 |
| capabilities_stale | routing | 能力 revision 已变化 |
| pipeline_unavailable | routing | Pipeline 不可用 |
| unsupported_mode | routing | Pipeline 不支持 mode |
| invalid_selection | routing | ASR/LLM 选择非法 |
| quota_exhausted | quota | 无法预留额度 |
| rate_limit_exceeded | quota | 请求频率超限 |
| input_empty | input | 没有有效语音 |
| input_idle_timeout | input | 输入帧空闲超时 |
| invalid_audio_frame | protocol | 二进制帧非法 |
| input_statistics_mismatch | input | commit 统计与实际接收帧不一致 |
| recording_limit_exceeded | input | 超过录音上限 |
| asr_failed | asr | ASR 阶段失败 |
| llm_failed | llm | asr_llm 的 LLM 阶段失败 |
| request_timeout | request | 请求总超时 |
| upstream_unavailable | routing | 上游暂不可用 |
| session_revoked | authorization | 登录或账户状态撤销 |
| server_error | internal | 未分类内部错误 |

错误作用域由 request_id 决定，布尔字段不得任意组合：

- 会话级错误：`request_id=null`、`terminal=false`。`fatal=false` 时只报告诊断并保持连接；
  `fatal=true` 时发送错误后立即按指定 close code 关闭连接；
- 请求级错误：`request_id` 是对应 UUID、`terminal=true`、`fatal=false`，并必须携带最终
  `usage`。它是该请求唯一终态，释放请求槽位但保持长期连接；
- request_id 非空且 terminal=false、或 request_id=null 且 terminal=true，均为非法服务端消息。

所有终态 usage 均满足：

```text
credits_charged = asr_credits_charged + llm_credits_charged
```

`asr_only` 的 `llm_input_tokens`、`llm_output_tokens` 和 `llm_credits_charged` 必须全部为 0。
ASR 与 LLM 润色独立计费：取消或失败时只扣已经实际执行阶段的费用；accepted 前被拒绝的
请求各项 usage 均为 0。会话级 error 不得携带 usage。

稳定策略如下；“可重试”始终表示使用新 request ID 重试，不允许重放原请求：

| code | 允许作用域 | retryable | 连接行为 |
|---|---|---:|---|
| invalid_message, unsupported_message_type | session 或 request | false | session 级保持连接；request 级结束请求 |
| protocol_version_mismatch, handshake_required | session/fatal | false | close 1002 |
| request_in_progress, request_not_found, request_id_reused | request | false | 结束被拒绝的 request ID，不影响原活跃请求 |
| capabilities_stale, pipeline_unavailable | request | true | 刷新 capabilities 后以新 ID 重试 |
| unsupported_mode, invalid_selection, quota_exhausted | request | false | 结束请求 |
| rate_limit_exceeded | request | true | 按 details.retry_after_ms 退避后以新 ID 重试 |
| input_empty, input_idle_timeout, invalid_audio_frame, input_statistics_mismatch, recording_limit_exceeded | request | false | 结束请求 |
| asr_failed, llm_failed, request_timeout, upstream_unavailable | request | true | 结束请求，可由用户以新 ID 重试 |
| session_revoked | session/fatal | false | close 4001，不自动重连 |
| server_error | session/fatal 或 request | true | session 级 close 1011；request 级结束请求 |

若无法从非法消息中可靠取得当前或被拒绝的 request ID，`invalid_message` 和
`unsupported_message_type` 必须使用非 fatal 会话级错误，不能误杀当前活跃请求。

错误表中的 code、stage、retryable、fatal 和作用域是一个整体，不允许跨行组合。
`rate_limit_exceeded` 必须携带正整数 `details.retry_after_ms`；`invalid_selection` 必须携带
非空字符串 `details.field`。这些约束同时由 JSON Schema 执行。

## 14. 关闭和超时

| code | 含义 | 行为 |
|---:|---|---|
| 1000 | 正常关闭 | 按用户动作决定是否重连 |
| 1001 | 服务端重启/迁移 | 新 ticket 自动重连 |
| 1002 | 协议错误 | 记录诊断，不自动重连；配置修正或客户端升级后才能重新连接 |
| 1009 | 消息过大 | 不重放请求，修正后重连 |
| 1011 | 会话级内部错误 | 退避后自动重连 |
| 4001 | session revoked | 清登录态，不自动重连 |
| 4002 | heartbeat timeout | 自动重连 |
| 4003 | service draining | 退避重连 |

Upgrade 5 秒；hello 各 3 秒；accepted 3 秒。客户端等待 accepted 超过 3 秒时发送
`request.cancel(reason=client_timeout)`；再等待 2 秒仍没有终态则关闭连接，按活跃请求断线
处理。长期连接没有业务 idle timeout。基础设施应避免在活跃请求期间主动断开。

## 15. 安全和实现检查

- 生产只允许 HTTPS/WSS；
- Token、Authorization Code、PKCE verifier 和 ticket 不写日志；
- ticket query 全链路脱敏；
- 使用 ticket 响应中的 websocket_path，不硬编码 capabilities 或示例路径；
- 取得 Token 后预连接，WS ready 前不开始录音；
- 临时区域与真实目标严格分离；
- 录音期间 ASR delta/snapshot 可以与 INPUT_PCM 交错，最终 ASR snapshot 只能在 input.committed 后发送；
- LLM 使用空 final=false snapshot 切换 stage，delta sequence 独立从 0 开始；
- snapshot 是全量原子覆盖；
- asr_llm 的 ASR snapshot 不提交；
- final snapshot 与 request.done 文本不一致时按协议错误关闭，不写真实目标；
- 断线不重放，普通请求终态后保持连接；
- 心跳最多一个 outstanding ping，两端按 interval + timeout 检测半开连接；
- 1002 是不可自动重试的协议错误；
- logout/禁用能跨节点关闭现有长连接。

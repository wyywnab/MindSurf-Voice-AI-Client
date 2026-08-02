# MindSurf Voice WebSocket 接口协议

> 协议名称：MindSurf Voice Protocol  
> 协议版本：1  
> 文档状态：Draft；Phase 1 客户端对接基线已冻结（2026-07-23）  
> 适用阶段：Phase 1 级联语音链路  
> 传输层：WebSocket（RFC 6455）

## 1. 文档目的

本文档是 MindSurf Voice AI 客户端与推理服务之间的唯一接口约定，定义：

- WebSocket 建连与版本协商。
- JSON 控制消息格式。
- 二进制音频帧格式。
- 录音、ASR、LLM 和 TTS 的消息时序。
- 请求取消、心跳、超时和断线行为。
- 错误码、关闭码和兼容策略。

本文档不规定服务端使用什么 ASR、LLM、TTS、框架或部署方式。服务端内部实现可以替换，只要满足这里规定的外部行为。

`PHASE1_IMPLEMENTATION.md` 中若存在与本文档冲突的接口描述，以本文档为准。

## 2. 规范用语

本文档使用以下术语：

- **必须**：协议实现不可省略，否则视为不兼容。
- **应该**：推荐行为；确有理由可以偏离，但要记录原因。
- **可以**：可选能力。
- **客户端**：Tauri 桌面应用中的 WebSocket 发起方。
- **服务端**：提供语音推理 WebSocket 的一方。
- **会话**：一条已经完成握手的 WebSocket 连接。
- **请求**：一次从录音开始到结果完成或取消的语音任务。
- **控制消息**：WebSocket Text Message 中的 UTF-8 JSON。
- **音频帧**：WebSocket Binary Message 中的二进制头部和音频载荷。
- **终态事件**：使请求不再产生任何有效事件的消息。

## 3. 版本 1 的约束

协议版本 1 采用以下约束降低实现复杂度：

1. 一条 WebSocket 连接同一时间最多有一个活跃请求。
2. 一次请求最多包含一条上行音频流和一条下行音频流。
3. 上行音频固定为 16 kHz、单声道、PCM signed 16-bit little-endian。
4. 下行音频必须在 `output.audio.start` 中声明格式。
5. 控制消息使用 JSON，音频使用二进制消息。
6. WebSocket 消息顺序即传输顺序；应用层仍使用序号检测重复和协议错误。
7. 不支持断线后恢复正在进行的请求。
8. 不支持同一请求中切换输入音频格式。

未来版本如需并行请求、多路音频或 Opus，可以在保持版本 1 兼容的前提下扩展。

## 4. 连接

### 4.1 地址

调试阶段默认 mock 地址：

```text
ws://127.0.0.1:8000/v1/voice/ws
```

要求：

- 本地 mock 服务必须默认绑定 `127.0.0.1` 或 `::1`。
- 发布环境连接远程服务且必须使用 `wss://`。
- 客户端必须允许用户配置地址；发布构建不内置 `ws://` 远程地址。
- URL 路径中的 `v1` 是 HTTP 接口版本，不替代握手中的协议版本协商。

### 4.2 WebSocket 子协议

客户端必须请求以下子协议：

```text
mindsurf.voice.v1
```

服务端必须在 HTTP Upgrade 响应中选择同一子协议。未返回子协议或返回其他子协议时，客户端必须关闭连接。

### 4.3 鉴权

Phase 2 在 `client.hello.payload.auth` 中支持可选的 Bearer Token。Token 不得出现在 URL、日志、错误详情或其他协议消息中；远程服务仍必须使用 `wss://`。

未配置 Token 时客户端省略 `auth`。不要求鉴权的服务端必须继续接受没有 `auth` 的版本 1 客户端；要求鉴权的服务端使用稳定的会话级 fatal error 拒绝缺失、无效或过期的 Token。鉴权失败后客户端不得自动重连，直到用户更新服务配置或手动重试。

### 4.4 建连时限

| 操作 | 默认时限 |
|---|---:|
| TCP/TLS/WebSocket 建连 | 5 秒 |
| WebSocket 打开后发送 `client.hello` | 3 秒 |
| `client.hello` 后收到 `server.hello` | 3 秒 |

握手未在时限内完成时，等待方必须关闭连接。

## 5. JSON 控制消息

### 5.1 通用信封

每条控制消息必须符合以下结构：

```json
{
  "v": 1,
  "type": "request.start",
  "event_id": "019c8db7-2014-7d52-89af-15b8a8fe6c11",
  "request_id": "019c8db7-1ff3-7501-b2d4-85e8418af53c",
  "sent_at_ms": 1784786401000,
  "payload": {}
}
```

字段定义：

| 字段 | 类型 | 必须 | 说明 |
|---|---|---:|---|
| `v` | integer | 是 | 协议主版本，当前固定为 `1` |
| `type` | string | 是 | 消息类型，使用小写点分格式 |
| `event_id` | UUID string | 是 | 本条消息的唯一 ID |
| `request_id` | UUID string/null | 是 | 请求消息为 UUID，会话消息为 `null` |
| `sent_at_ms` | integer | 是 | Unix epoch 毫秒时间戳 |
| `payload` | object | 是 | 消息负载，无字段时使用 `{}` |

约束：

- `event_id` 和 `request_id` 推荐使用 UUIDv7。
- UUID 文本必须使用带连字符的小写标准形式。
- 同一个 `event_id` 只处理一次；收到重复事件时应忽略并记录。
- 接收方不得使用 `sent_at_ms` 决定消息顺序。
- 接收方必须忽略无法识别的非关键 payload 字段。
- 接收方收到未知 `type` 时，必须返回 `unsupported_message_type`，但不必关闭连接。
- JSON 控制消息不得超过 64 KiB。
- 数字不得使用 `NaN`、`Infinity` 或 `-Infinity`。

### 5.2 会话级与请求级消息

会话级消息的 `request_id` 必须为 `null`：

- `client.hello`
- `server.hello`
- `session.ping`
- `session.pong`
- 会话级 `error`

其余消息必须携带当前活跃请求的 `request_id`。

## 6. 二进制音频帧

### 6.1 WebSocket 消息边界

每个 WebSocket Binary Message 必须只包含一个 MindSurf 音频帧：

```text
48 字节固定头部 + 音频载荷
```

发送方不得把多个协议音频帧拼接进同一个 WebSocket Binary Message。WebSocket 库可能在网络层分片，但接收方必须在获得完整 WebSocket Message 后解析。

### 6.2 固定头部

所有多字节整数使用网络字节序（big-endian）。

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|---:|---:|---|---|---|
| 0 | 4 | magic | bytes | 固定 ASCII `MSVA` |
| 4 | 1 | version | `u8` | 固定为 `1` |
| 5 | 1 | kind | `u8` | 音频帧类型 |
| 6 | 2 | flags | `u16` | 版本 1 固定为 `0` |
| 8 | 2 | header_length | `u16` | 固定为 `48` |
| 10 | 2 | reserved_1 | `u16` | 固定为 `0` |
| 12 | 4 | sequence | `u32` | 从 `0` 开始递增 |
| 16 | 8 | timestamp_us | `u64` | 相对该音频流起点的微秒数 |
| 24 | 4 | payload_length | `u32` | 音频载荷字节数 |
| 28 | 4 | reserved_2 | `u32` | 固定为 `0` |
| 32 | 16 | request_id | bytes | UUID 的 16 字节网络序表示 |

`kind`：

| 值 | 名称 | 方向 | 载荷 |
|---:|---|---|---|
| `0x01` | `INPUT_PCM` | 客户端 → 服务端 | PCM16LE |
| `0x02` | `OUTPUT_PCM` | 服务端 → 客户端 | PCM16LE |

版本 1 不定义其他 `kind`。收到未知值时，接收方必须返回 `unsupported_audio_kind`。

### 6.3 序号与时间戳

- 每条音频流的第一个帧 `sequence` 必须为 `0`。
- 后续帧必须严格加一。
- 上行与下行分别维护自己的序号。
- `timestamp_us` 从各自音频流第一个采样点开始计算。
- PCM 流的下一帧时间戳应该与累计采样数一致。
- WebSocket 基于 TCP，不允许应用层静默跳过乱序或缺失帧。
- 收到重复、倒序或跳号帧时，接收方必须终止当前请求并返回 `audio_sequence_error`。

### 6.4 长度校验

接收方必须验证：

```text
WebSocket Binary Message 长度 == header_length + payload_length
```

额外要求：

- `header_length` 不是 `48` 时，版本 1 实现必须拒绝该帧。
- `payload_length` 为 `0` 时必须拒绝。
- 单个二进制消息不得超过 64 KiB。
- `request_id` 必须等于当前活跃请求。
- 载荷长度必须满足 PCM 样本宽度与声道数的整数倍。

### 6.5 上行音频分片

上行固定格式：

| 属性 | 值 |
|---|---|
| 编码 | PCM signed 16-bit little-endian |
| 采样率 | 16,000 Hz |
| 声道 | 1 |
| 推荐分片 | 20 ms |
| 推荐样本数 | 320 |
| 推荐载荷长度 | 640 bytes |

客户端应该每 20 ms 发送一帧。最后一帧可以短于 20 ms，但必须包含完整的 16-bit 样本。

### 6.6 下行音频分片

下行音频的格式由 `output.audio.start` 指定。

版本 1 客户端必须支持：

- PCM signed 16-bit little-endian。
- 单声道。
- 16,000 Hz 和 24,000 Hz。

服务端应该按 40–160 ms 音频时长分片，推荐 80 ms。单个分片不得超过 64 KiB。

## 7. 会话握手

### 7.1 `client.hello`

WebSocket 打开后，客户端发送的第一条消息必须是 `client.hello`。

```json
{
  "v": 1,
  "type": "client.hello",
  "event_id": "019c8db7-1010-7b16-9d09-b3d98ac9e044",
  "request_id": null,
  "sent_at_ms": 1784786400000,
  "payload": {
    "client": {
      "name": "mindsurf-voice-ai",
      "version": "0.1.0",
      "platform": "windows",
      "arch": "x86_64"
    },
    "protocol_versions": [1],
    "pipelines": ["cascade"],
    "input_audio": [
      {
        "encoding": "pcm_s16le",
        "sample_rate": 16000,
        "channels": 1
      }
    ],
    "output_audio": [
      {
        "encoding": "pcm_s16le",
        "sample_rates": [16000, 24000],
        "channels": 1
      }
    ],
    "auth": {
      "scheme": "bearer",
      "token": "<token>"
    }
  }
}
```

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `client.name` | string | 客户端名称 |
| `client.version` | string | 客户端 SemVer |
| `client.platform` | enum | `windows`、`macos`、`linux` |
| `client.arch` | string | 如 `x86_64`、`aarch64` |
| `protocol_versions` | integer[] | 客户端支持的协议版本，降序排列 |
| `pipelines` | string[] | 当前支持 `cascade` |
| `input_audio` | object[] | 支持的上行格式 |
| `output_audio` | object[] | 支持的下行格式 |
| `auth` | object | 可选；应用层鉴权信息 |
| `auth.scheme` | string | 当前固定为 `bearer` |
| `auth.token` | string | Bearer Token；不得记录或回显 |

`auth` 字段是版本 1 的向后兼容可选扩展。服务端收到未知 `scheme` 时返回 `authentication_failed`，不得把收到的凭据放入 `error.details`。

### 7.2 `server.hello`

服务端接受连接后返回：

```json
{
  "v": 1,
  "type": "server.hello",
  "event_id": "019c8db7-1025-7973-8b02-5bf1525ed517",
  "request_id": null,
  "sent_at_ms": 1784786400018,
  "payload": {
    "session_id": "019c8db7-1024-77a0-83a9-442b87e67485",
    "protocol_version": 1,
    "pipeline": "cascade",
    "limits": {
      "max_recording_ms": 60000,
      "max_json_bytes": 65536,
      "max_binary_bytes": 65536
    },
    "features": {
      "streaming_asr": true,
      "streaming_text": true,
      "streaming_audio": true,
      "cancellation": true
    },
    "inference_options": {
      "defaults": {
        "asr": "asr-default",
        "llm": "llm-default",
        "tts": "tts-default",
        "output_audio": "pcm16-24k-mono"
      },
      "asr": [
        {
          "id": "asr-default",
          "name": "Default ASR",
          "description": "Default streaming speech recognition"
        }
      ],
      "llm": [
        {
          "id": "llm-default",
          "name": "Default LLM",
          "description": "Default assistant model"
        }
      ],
      "tts": [
        {
          "id": "tts-default",
          "name": "Default TTS",
          "description": "Default streaming speech synthesis"
        }
      ],
      "output_audio": [
        {
          "id": "pcm16-24k-mono",
          "name": "PCM 24 kHz Mono",
          "description": "Low-latency uncompressed output",
          "encoding": "pcm_s16le",
          "sample_rate": 24000,
          "channels": 1
        }
      ]
    },
    "heartbeat": {
      "interval_ms": 15000,
      "timeout_ms": 10000
    }
  }
}
```

客户端必须保存协商结果。服务端返回客户端不支持的协议、pipeline 或音频格式时，客户端必须发送会话级 `error` 并关闭连接。

`inference_options` 约束：

- 服务端必须为 `asr`、`llm`、`tts` 和 `output_audio` 提供至少一个候选，并为每个候选提供稳定 `id`、用户可读 `name` 和 `description`。
- `defaults` 中的 ID 必须存在于对应候选列表。
- `output_audio` 候选必须同时被 `client.hello.output_audio` 支持；不能协商出共同格式时必须终止握手。
- 客户端展示候选说明并持久化用户选择。已保存的 ID 不再存在时，客户端回退到服务端默认项并提示用户。
- 本地 mock 可以只提供每类一个候选，但字段结构必须与远程服务一致。

## 8. 心跳

浏览器环境无法稳定直接控制 WebSocket Ping Frame，因此版本 1 使用应用层心跳。

服务端在空闲达到 `heartbeat.interval_ms` 后发送：

```json
{
  "v": 1,
  "type": "session.ping",
  "event_id": "019c8db7-9000-7af8-b4c5-b0e129c8a4cc",
  "request_id": null,
  "sent_at_ms": 1784786415000,
  "payload": {
    "nonce": "019c8db7-8fff-72aa-a31a-b4081620fb67"
  }
}
```

客户端必须尽快原样返回 nonce：

```json
{
  "v": 1,
  "type": "session.pong",
  "event_id": "019c8db7-9002-7c05-ad10-40910bfd2341",
  "request_id": null,
  "sent_at_ms": 1784786415002,
  "payload": {
    "nonce": "019c8db7-8fff-72aa-a31a-b4081620fb67"
  }
}
```

在 `heartbeat.timeout_ms` 内未收到正确 pong 时，服务端可以关闭连接。连续两次心跳失败后，客户端必须将连接标记为断开并启动重连。

任意有效消息都可以重置空闲计时器，但不能替代对已发送 ping 的 pong。

## 9. 请求生命周期

### 9.1 请求状态

服务端和客户端都应按以下状态理解请求：

```text
NEW
  → ACCEPTED
  → RECEIVING_AUDIO
  → INPUT_COMMITTED
  → GENERATING
  → COMPLETED

任意非终态
  → CANCELLING
  → CANCELLED

任意非终态
  → FAILED
```

终态：

- `request.done`
- `request.cancelled`
- 请求级且 `fatal=true` 的 `error`

进入终态后，双方必须忽略该请求的迟到消息。相同 `request_id` 不得复用。

### 9.2 模式

版本 1 定义：

| 模式 | ASR | LLM 文本 | TTS 音频 |
|---|---:|---:|---:|
| `dictation` | 必须 | 不产生 | 不产生 |
| `assistant` | 必须 | 必须 | 按请求配置 |

“混合模式”是客户端 UI 行为，协议层使用 `assistant`。

## 10. 请求消息

### 10.1 `request.start`

客户端开始请求：

```json
{
  "v": 1,
  "type": "request.start",
  "event_id": "019c8db8-1000-7778-94bb-24dac7cd1fc6",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786420000,
  "payload": {
    "mode": "assistant",
    "language": "zh-CN",
    "conversation_id": "019c8db0-5d0a-7938-8757-f90c8322cb76",
    "selection": {
      "asr": "asr-default",
      "llm": "llm-default",
      "tts": "tts-default",
      "output_audio": "pcm16-24k-mono"
    },
    "input_audio": {
      "encoding": "pcm_s16le",
      "sample_rate": 16000,
      "channels": 1,
      "frame_duration_ms": 20
    },
    "response": {
      "text": true,
      "audio": true,
      "voice": "default"
    }
  }
}
```

约束：

- 当前已有活跃请求时，服务端必须拒绝新请求并返回 `request_already_active`。
- `language` 使用 BCP 47；自动检测时使用 `auto`。
- `conversation_id` 可以为 `null`，表示不使用对话历史。
- `selection` 中的 ID 必须来自当前 `server.hello.inference_options`。`dictation` 模式只要求 `asr`；不使用的 `llm`、`tts` 和 `output_audio` 可以为 `null`。
- `response.text` 在 `assistant` 模式必须为 `true`。
- `dictation` 模式下 `response.audio` 必须为 `false`。
- `voice` 由服务端定义；不支持时应回退默认音色并在 `request.accepted` 中返回实际音色。

### 10.2 `request.accepted`

服务端校验请求后返回：

```json
{
  "v": 1,
  "type": "request.accepted",
  "event_id": "019c8db8-1012-76ed-b280-00250950e469",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786420012,
  "payload": {
    "mode": "assistant",
    "language": "zh-CN",
    "selection": {
      "asr": "asr-default",
      "llm": "llm-default",
      "tts": "tts-default",
      "output_audio": "pcm16-24k-mono"
    },
    "voice": "default",
    "max_recording_ms": 60000
  }
}
```

客户端收到 `request.accepted` 后才能发送二进制音频帧。`selection` 是服务端接受的实际候选项，不得静默替换客户端选择；候选不可用时返回 `unsupported_inference_option`。客户端等待确认的默认超时为 2 秒。

### 10.3 上行音频

`request.accepted` 后，客户端发送 `kind=INPUT_PCM` 的二进制帧。

服务端可以在录音尚未结束时返回 `asr.partial`。客户端不得假设 ASR 事件一定在 `input.commit` 之后出现。

### 10.4 `input.commit`

用户结束录音后，客户端发送：

```json
{
  "v": 1,
  "type": "input.commit",
  "event_id": "019c8db8-4200-7e04-953c-a7d286c5265f",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786423200,
  "payload": {
    "last_sequence": 159,
    "frame_count": 160,
    "sample_count": 51200,
    "duration_ms": 3200
  }
}
```

约束：

- `last_sequence` 必须等于最后一个二进制输入帧的 sequence。
- 没有发送任何音频时，`last_sequence` 为 `null`，`frame_count` 和 `sample_count` 为 `0`。
- 发送 `input.commit` 后，客户端不得再发送该请求的输入音频帧。
- 服务端必须校验统计值；不一致时返回 `audio_commit_mismatch`。

### 10.5 `input.committed`

服务端完成输入流校验后返回：

```json
{
  "v": 1,
  "type": "input.committed",
  "event_id": "019c8db8-4210-731a-9099-e2ee8890d776",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786423210,
  "payload": {
    "accepted_duration_ms": 3200
  }
}
```

该消息表示服务端已完整接收输入，不表示 ASR 已完成。

## 11. ASR 事件

### 11.1 `asr.partial`

```json
{
  "v": 1,
  "type": "asr.partial",
  "event_id": "019c8db8-3500-734a-97d7-b31516ca5ac7",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786422500,
  "payload": {
    "text": "帮我总结",
    "revision": 3,
    "stable_prefix_length": 2
  }
}
```

规则：

- `text` 是截至当前的完整临时结果，不是增量字符串。
- `revision` 从 `0` 开始严格递增。
- 客户端必须使用更高 revision 的文本覆盖旧文本。
- `stable_prefix_length` 是 Unicode code point 数量，仅作为 UI 提示，不保证最终绝不变化。
- 客户端不得自动注入 partial 文本。

### 11.2 `asr.final`

```json
{
  "v": 1,
  "type": "asr.final",
  "event_id": "019c8db8-4550-7355-807d-2472404f4663",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786423550,
  "payload": {
    "text": "帮我总结这段内容。",
    "language": "zh-CN",
    "confidence": 0.94,
    "duration_ms": 3200
  }
}
```

规则：

- `confidence` 可以为 `null`。
- `asr.final` 每个请求最多发送一次。
- `dictation` 模式可以在此后直接发送 `request.done`。
- `assistant` 模式必须在 `asr.final` 后才能发送 assistant 事件。
- 文本为空时，服务端应返回 `asr_empty`，不发送空的 `asr.final`。

## 12. Assistant 文本事件

### 12.1 `assistant.text.delta`

```json
{
  "v": 1,
  "type": "assistant.text.delta",
  "event_id": "019c8db8-4900-7d33-8572-574cf364a63f",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786423900,
  "payload": {
    "sequence": 0,
    "delta": "这段内容"
  }
}
```

规则：

- `sequence` 从 `0` 开始严格递增。
- `delta` 是追加内容，客户端不得覆盖此前文本。
- `delta` 不得为空字符串。
- 收到重复 sequence 时忽略重复事件。
- 收到跳号或倒序时，客户端必须保留已收到的文本，并将请求标记为协议错误。

### 12.2 `assistant.text.done`

```json
{
  "v": 1,
  "type": "assistant.text.done",
  "event_id": "019c8db8-5700-7c18-96f1-0ec12058eb1b",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786424700,
  "payload": {
    "text": "这段内容主要介绍了第一阶段的实现方式。",
    "last_sequence": 8,
    "finish_reason": "stop",
    "usage": {
      "input_tokens": 26,
      "output_tokens": 58
    }
  }
}
```

规则：

- `text` 是最终完整文本。
- 客户端应校验拼接 delta 是否与最终 text 一致。
- 不一致时以 `assistant.text.done.text` 为准并记录告警。
- `finish_reason` 可为 `stop`、`length`、`content_filter`。
- `usage` 可以为 `null`。

## 13. Assistant 音频事件

### 13.1 `output.audio.start`

服务端发送任何下行音频帧前必须发送：

```json
{
  "v": 1,
  "type": "output.audio.start",
  "event_id": "019c8db8-5300-7e94-8b99-5a694dc336d6",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786424300,
  "payload": {
    "encoding": "pcm_s16le",
    "sample_rate": 24000,
    "channels": 1,
    "voice": "default"
  }
}
```

服务端可以在 `assistant.text.done` 之前开始发送音频，以降低首播延迟，但必须已发送至少一个 `assistant.text.delta`。

`encoding`、`sample_rate` 和 `channels` 必须与 `request.accepted.selection.output_audio` 指向的候选一致。客户端以本消息声明的实际格式初始化播放链路，不得硬编码下行采样率。

### 13.2 下行二进制音频

`output.audio.start` 后，服务端发送 `kind=OUTPUT_PCM` 的二进制帧。

客户端：

- 必须按 sequence 排序和校验。
- 应在累计 80–160 ms 音频后开始播放。
- 必须丢弃非当前 request ID 的音频。
- 收到取消或终态错误时必须停止并清空播放队列。

### 13.3 `output.audio.done`

```json
{
  "v": 1,
  "type": "output.audio.done",
  "event_id": "019c8db8-7200-70b3-8274-21badcf1d510",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786426200,
  "payload": {
    "last_sequence": 17,
    "chunk_count": 18,
    "sample_count": 98400,
    "duration_ms": 4100
  }
}
```

`output.audio.done` 表示服务端不再发送音频，不表示客户端已经播放完毕。客户端自行维护本地 `playback.done` 状态，不回传协议消息。

## 14. 请求完成

### 14.1 `request.done`

服务端完成所有请求输出后发送：

```json
{
  "v": 1,
  "type": "request.done",
  "event_id": "019c8db8-7210-7d09-baba-a9558839e5a2",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786426210,
  "payload": {
    "result": "success",
    "timing_ms": {
      "input_duration": 3200,
      "asr_final_after_commit": 350,
      "llm_first_token_after_commit": 700,
      "audio_first_chunk_after_commit": 1100,
      "server_total_after_commit": 3010
    }
  }
}
```

规则：

- `request.done` 是成功终态。
- `dictation` 模式必须在 `asr.final` 之后发送。
- 开启文本回复时，必须在 `assistant.text.done` 之后发送。
- 开启音频回复时，必须在 `output.audio.done` 之后发送。
- `request.done` 后发送的同请求消息都属于迟到消息，接收方必须忽略。
- 客户端收到 `request.done` 后仍可继续播放已经缓存的音频。

## 15. 取消与打断

### 15.1 `request.cancel`

客户端可以在任意非终态发送：

```json
{
  "v": 1,
  "type": "request.cancel",
  "event_id": "019c8db8-5000-733c-8e2c-0d54bc7fc56f",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786424000,
  "payload": {
    "reason": "user_interrupted"
  }
}
```

`reason`：

- `user_cancelled`
- `user_interrupted`
- `client_timeout`
- `audio_backpressure`
- `app_shutdown`

客户端发送取消后必须立即：

- 停止麦克风帧发送。
- 停止播放并清空音频队列。
- UI 进入 cancelling 或 idle。
- 忽略除 `request.cancelled` 和 fatal `error` 外的后续请求事件。

### 15.2 `request.cancelled`

服务端释放请求资源后返回：

```json
{
  "v": 1,
  "type": "request.cancelled",
  "event_id": "019c8db8-5050-7581-bbb9-94e6aa6bb9d0",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786424050,
  "payload": {
    "reason": "user_interrupted"
  }
}
```

规则：

- `request.cancelled` 是取消终态。
- 服务端应在 2 秒内返回。
- 超过 2 秒未确认时，客户端可关闭整条 WebSocket 连接以确保服务端停止接收后续数据。
- 对已经终态的请求重复 cancel，服务端可以再次返回同一终态，不应返回内部错误。

### 15.3 新请求打断旧请求

版本 1 不允许直接用新 `request.start` 抢占旧请求。

客户端必须：

1. 向旧请求发送 `request.cancel`。
2. 本地立即停止旧音频。
3. 等待 `request.cancelled`，或等待最多 2 秒。
4. 旧请求终态后再发送新的 `request.start`。

## 16. 错误

### 16.1 `error`

```json
{
  "v": 1,
  "type": "error",
  "event_id": "019c8db8-5100-7c44-a381-f615589ff008",
  "request_id": "019c8db8-0fff-781f-8329-cc2f48c65013",
  "sent_at_ms": 1784786424100,
  "payload": {
    "code": "asr_timeout",
    "message": "语音识别超时",
    "stage": "asr",
    "recoverable": true,
    "fatal": true,
    "details": {}
  }
}
```

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 稳定、可用于程序判断的错误码 |
| `message` | string | 面向用户或开发者的简短说明 |
| `stage` | string | `session`、`input`、`asr`、`llm`、`tts`、`protocol` |
| `recoverable` | boolean | 用户是否可以在不重启应用的情况下重试 |
| `fatal` | boolean | 是否立即终止当前请求或会话 |
| `details` | object | 可选诊断字段，不得包含敏感数据 |

请求级 `fatal=true` 的 error 是失败终态。会话级 `fatal=true` 的 error 后，服务端必须关闭连接。

### 16.2 标准错误码

| code | 范围 | fatal | 含义 |
|---|---|---:|---|
| `invalid_json` | session | 否 | JSON 无法解析 |
| `invalid_message` | request/session | 否 | 字段不符合 schema |
| `unsupported_message_type` | request/session | 否 | 未知消息类型 |
| `protocol_version_mismatch` | session | 是 | 无共同协议版本 |
| `handshake_required` | session | 是 | 握手前发送业务消息 |
| `handshake_timeout` | session | 是 | 握手超时 |
| `authentication_required` | session | 是 | 服务要求鉴权但客户端未提供 Token |
| `authentication_failed` | session | 是 | Token 或鉴权 scheme 无效 |
| `token_expired` | session | 是 | Token 已过期，需要用户重新配置 |
| `request_already_active` | request | 是 | 已有活跃请求 |
| `request_not_found` | request | 否 | request ID 不存在 |
| `request_state_error` | request | 是 | 当前状态不允许该消息 |
| `unsupported_inference_option` | request | 是 | 请求的 ASR、LLM、TTS 或输出音频候选不存在或当前不可用 |
| `unsupported_audio_kind` | request | 是 | 不支持的二进制 kind |
| `unsupported_audio_format` | request | 是 | 不支持的采样格式 |
| `invalid_audio_frame` | request | 是 | 二进制头或长度非法 |
| `audio_sequence_error` | request | 是 | 音频帧序号不连续 |
| `audio_commit_mismatch` | request | 是 | commit 统计与音频不符 |
| `audio_too_short` | request | 是 | 有效录音过短 |
| `audio_too_long` | request | 是 | 超过录音时长上限 |
| `asr_empty` | request | 是 | 未识别到有效文本 |
| `asr_timeout` | request | 是 | ASR 超时 |
| `asr_failed` | request | 是 | ASR 执行失败 |
| `llm_timeout` | request | 是 | LLM 首 token 或生成超时 |
| `llm_failed` | request | 是 | LLM 执行失败 |
| `tts_timeout` | request | 否 | TTS 超时，文本仍可用 |
| `tts_failed` | request | 否 | TTS 失败，文本仍可用 |
| `server_busy` | request/session | 是 | 服务资源不足 |
| `rate_limited` | request/session | 否 | 请求频率过高 |
| `internal_error` | request/session | 是 | 未分类内部错误 |

TTS 错误的特殊规则：

- 如果最终文本仍能完整返回，`tts_failed` 或 `tts_timeout` 应设置 `fatal=false`。
- 如果此前已经发送 `output.audio.start`，服务端必须先发送 `output.audio.done`，其中统计值反映实际已发送的音频。
- 服务端随后必须发送 `assistant.text.done` 和 `request.done`。
- `request.done.payload.result` 应为 `partial_success`。

## 17. WebSocket 关闭码

正常请求结束不关闭连接。关闭码只用于会话级终止：

| code | 含义 |
|---:|---|
| `1000` | 正常关闭或应用退出 |
| `1001` | 服务端关闭或重启 |
| `1002` | WebSocket/二进制协议错误 |
| `1009` | 消息超过大小限制 |
| `1011` | 服务端未处理异常 |
| `4001` | 握手超时 |
| `4002` | 协议版本不兼容 |
| `4003` | 鉴权失败 |
| `4004` | 来源或安全策略拒绝 |
| `4008` | 服务端忙，拒绝建立会话 |

关闭 reason 必须简短，不得包含堆栈、密钥、原始文本或其他敏感数据。

## 18. 超时规范

客户端默认超时：

| 阶段 | 起点 | 超时 |
|---|---|---:|
| 建连 | 调用 WebSocket 构造函数 | 5 秒 |
| 握手 | WebSocket open | 3 秒 |
| 请求接受 | 发送 `request.start` | 2 秒 |
| input 确认 | 发送 `input.commit` | 2 秒 |
| ASR final | 发送 `input.commit` | 10 秒 |
| LLM 首 token | 收到 `asr.final` | 15 秒 |
| TTS start | 首个文本 delta | 15 秒 |
| 请求总时长 | 发送 `input.commit` | 120 秒 |
| 取消确认 | 发送 `request.cancel` | 2 秒 |

服务端可以在 `server.hello` 中下发更严格的限制，但不得在请求开始后无通知地缩短。

超时行为：

- 客户端超时后发送 `request.cancel`。
- 取消确认仍超时，客户端关闭连接并重连。
- 服务端自身超时必须发送对应稳定错误码。

## 19. 背压与资源限制

客户端发送音频时必须监控 `WebSocket.bufferedAmount`：

| 阈值 | 建议行为 |
|---:|---|
| `< 256 KiB` | 正常发送 |
| `256 KiB–1 MiB` | 显示网络拥塞，最多临时缓存 2 秒音频 |
| `> 1 MiB` | 取消请求，reason=`audio_backpressure` |

要求：

- 不允许无限缓存麦克风数据。
- 不允许为了追赶进度而一次性突发发送数秒音频。
- 服务端必须限制 JSON 大小、二进制消息大小、录音总时长和消息速率。
- 达到资源限制时必须返回明确错误，不得无响应地丢弃音频。

## 20. 完整时序

### 20.1 Assistant 成功流程

```text
客户端                                      服务端
   │ WebSocket Upgrade                         │
   │ ────────────────────────────────────────> │
   │ client.hello                              │
   │ ────────────────────────────────────────> │
   │                              server.hello │
   │ <──────────────────────────────────────── │
   │                                           │
   │ request.start                             │
   │ ────────────────────────────────────────> │
   │                         request.accepted  │
   │ <──────────────────────────────────────── │
   │ INPUT_PCM seq=0                           │
   │ ────────────────────────────────────────> │
   │ INPUT_PCM seq=1...N                       │
   │ ────────────────────────────────────────> │
   │                              asr.partial  │
   │ <──────────────────────────────────────── │
   │ input.commit                              │
   │ ────────────────────────────────────────> │
   │                           input.committed │
   │ <──────────────────────────────────────── │
   │                                asr.final  │
   │ <──────────────────────────────────────── │
   │                    assistant.text.delta 0 │
   │ <──────────────────────────────────────── │
   │                        output.audio.start │
   │ <──────────────────────────────────────── │
   │                           OUTPUT_PCM seq=0│
   │ <──────────────────────────────────────── │
   │                    assistant.text.delta N │
   │ <──────────────────────────────────────── │
   │                         assistant.text.done│
   │ <──────────────────────────────────────── │
   │                           OUTPUT_PCM seq=N│
   │ <──────────────────────────────────────── │
   │                         output.audio.done │
   │ <──────────────────────────────────────── │
   │                              request.done │
   │ <──────────────────────────────────────── │
```

文本 delta、TTS start 和下行音频允许交错，但各自流内顺序必须保持。

### 20.2 Dictation 成功流程

```text
request.start(mode=dictation)
→ request.accepted
→ INPUT_PCM 0...N
→ input.commit
← input.committed
← asr.final
← request.done
```

### 20.3 播放中打断

```text
客户端停止本地播放
→ request.cancel(reason=user_interrupted)
← request.cancelled
→ 新 request.start
```

## 21. 兼容与扩展

### 21.1 版本规则

- `v` 是协议主版本。
- 主版本不同表示存在不兼容变化。
- 向 JSON payload 增加可选字段不提升主版本。
- 增加新消息类型不提升主版本，但接收方必须按未知消息规则处理。
- 修改既有字段含义、类型或必填性必须提升主版本。
- 修改二进制固定头布局必须提升主版本或使用新的 `kind`。

### 21.2 能力协商

客户端只能使用 `server.hello.features` 中声明支持的能力，并且只能提交 `server.hello.inference_options` 中存在的候选 ID。候选列表可以随服务端部署变化，但同一候选的 `id` 含义必须稳定。未来原生音频 pipeline 可以在 hello 中增加：

```json
{
  "pipelines": ["cascade", "native_audio"]
}
```

协议版本与 pipeline 相互独立。模型或推理链路改变不应无必要地修改 WebSocket 协议。

### 21.3 未知字段

双方必须忽略 JSON payload 中未知的可选字段，以允许向后兼容扩展。固定头部中的 reserved 字段在版本 1 必须为零；非零时必须拒绝，避免不同实现产生歧义。

## 22. 安全要求

- 本地服务默认只监听 loopback。
- 服务端必须验证 Origin；允许列表由部署配置决定。
- 远程连接只允许 `wss://`。
- 所有长度和枚举值在分配大块内存前校验。
- JSON parser 应限制嵌套深度。
- 日志不得记录二进制音频内容。
- 默认日志不得记录完整 ASR 或 LLM 文本。
- 错误 details 不得包含密钥、堆栈、用户音频或完整对话。
- `conversation_id` 不能直接用作文件路径或数据库语句。
- 服务端必须对连接数、请求频率和录音时长设置限制。

## 23. 客户端实现检查表

- [ ] 请求 `mindsurf.voice.v1` 子协议。
- [ ] open 后 3 秒内发送 `client.hello`。
- [ ] 校验 `server.hello` 的版本、pipeline 和限制。
- [ ] 展示并保存 `inference_options` 候选；失效的已保存 ID 回退到服务端默认项。
- [ ] 同时只创建一个活跃 request ID。
- [ ] 等待 `request.accepted` 后再发 PCM。
- [ ] 使用 48 字节大端二进制头。
- [ ] PCM 载荷保持 little-endian。
- [ ] 输入 sequence 从 0 严格递增。
- [ ] `input.commit` 后不再发送输入帧。
- [ ] partial ASR 按 revision 覆盖。
- [ ] 文本 delta 按 sequence 追加。
- [ ] `output.audio.start` 后才解析下行 PCM，并使用其中声明的实际格式。
- [ ] 终态后丢弃迟到消息。
- [ ] 取消时立即停止录音和播放。
- [ ] 监控 `bufferedAmount`，禁止无限缓存。
- [ ] 实现心跳响应、超时、断线和指数退避重连。
- [ ] 日志使用 request ID 关联，不记录音频和完整文本。

## 24. 服务端兼容性检查表

- [ ] Upgrade 时选择 `mindsurf.voice.v1`。
- [ ] 第一条业务消息只接受 `client.hello`。
- [ ] 返回明确的 `server.hello` 协商结果。
- [ ] 返回完整且默认 ID 有效的 `inference_options`。
- [ ] 每连接只允许一个活跃请求。
- [ ] 校验所有 JSON 和二进制长度。
- [ ] 校验 UUID、request ID、kind、sequence 和 timestamp。
- [ ] `request.accepted` 前不接受音频。
- [ ] 校验请求候选 ID，并在 `request.accepted` 中回显实际选择。
- [ ] `input.commit` 后不接受更多输入音频。
- [ ] 每个流事件的 revision/sequence 严格递增。
- [ ] TTS 音频前发送 `output.audio.start`。
- [ ] 所有成功请求以 `request.done` 结束。
- [ ] 取消请求在 2 秒内进入 `request.cancelled`。
- [ ] 使用本文档中的稳定错误码。
- [ ] 心跳失效和会话关闭时释放推理资源。
- [ ] 不将音频或完整文本写入默认日志。

## 25. 联调验收用例

双方实现至少通过以下用例：

1. 正常 assistant 请求，文本与音频均成功。
2. 正常 dictation 请求，只产生 ASR。
3. 录音过程中持续收到 ASR partial。
4. ASR partial 修订旧文本。
5. LLM 文本和 TTS 音频交错传输。
6. 录音过程中取消。
7. LLM 生成过程中取消。
8. TTS 播放过程中取消并开始新请求。
9. TTS 失败但最终文本成功。
10. ASR 空结果。
11. input sequence 跳号。
12. output sequence 重复。
13. commit 统计与二进制帧不一致。
14. 收到未知 JSON 字段。
15. 收到未知消息类型。
16. JSON 或二进制消息超过限制。
17. 服务端重启导致断线，客户端完成重连。
18. 心跳超时。
19. 协议版本不兼容。
20. 终态后到达迟到消息。
21. `server.hello.inference_options` 默认 ID 不存在，客户端拒绝握手。
22. 客户端提交不存在的候选 ID，服务端返回 `unsupported_inference_option`。
23. 已保存候选 ID 在重连后消失，客户端回退到新的服务端默认项并提示用户。

协议冻结前，应使用 mock server 自动覆盖这些场景。客户端与服务端只有在相同测试向量下得到一致结果，才能声明兼容协议版本 1。

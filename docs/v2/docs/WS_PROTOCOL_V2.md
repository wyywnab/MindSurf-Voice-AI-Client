# MindSurf Voice WebSocket 接口协议

> 协议体系：MindSurf Voice API v2
> 规范名称：MindSurf Voice WebSocket API
> 协议版本：2
> 文档状态：Draft；Omni 接入设计基线
> 适用阶段：级联与原生音频统一链路
> 传输层：WebSocket（RFC 6455）
> 同级 HTTP 规范：[`HTTP_API_V2.md`](./HTTP_API_V2.md)
> 客户端消息 Schema：[`../schemas/client-messages.schema.json`](../schemas/client-messages.schema.json)
> 服务端消息 Schema：[`../schemas/server-messages.schema.json`](../schemas/server-messages.schema.json)

## 1. 文档目的

MindSurf Voice API v2 由两份同级、互补的规范共同组成：

| 规范 | 职责 | 生命周期 |
|---|---|---|
| [`HTTP_API_V2.md`](./HTTP_API_V2.md)：HTTP API v2 | 业务能力发现、资源查询与资源变更 | 独立请求；资源状态可以长期存在 |
| 本文档：WebSocket API v2 | 实时音频和增量结果传输、请求控制 | 按需连接；连接和请求状态是临时的 |

两份规范共同构成客户端与 MindSurf 后端之间的完整版本 2 接口，互为同级边界定义；任何一份都不是另一份的附带文档或上游实现协议。业务状态以 HTTP 资源为准，当前实时连接的传输状态以 WebSocket 协商为准。

本文档定义其中的 WebSocket 实时传输部分，包括：

- WebSocket 建连、版本协商和客户端鉴权。
- JSON 控制消息与二进制音频帧格式。
- 当前连接的音频格式、限制、超时和心跳协商。
- 录音、输入转写、助手文本和助手音频的消息时序。
- 原生音频模型与级联模型在客户端侧的统一表现。
- 多轮会话、请求取消、实时打断、心跳、超时和断线行为。
- 错误码、关闭码、安全要求和兼容策略。

跨消息的对话与请求语义分别由 [`conversations.md`](./conversations.md) 和 [`request-lifecycle.md`](./request-lifecycle.md) 统一定义；本文档保留线上的消息与传输总览。

协议边界固定如下：

```text
MindSurf Voice Client  <-- MindSurf Voice API v2（HTTP + WebSocket） -->  MindSurf Backend
```

两份 v2 规范都只维护客户端与 MindSurf 后端之间的通信。以下内容明确不属于这套协议：

- 后端如何连接 `mindsurf-omni` 或其他推理服务。
- 后端是否使用 HTTP、WebSocket、RPC、消息队列或本地调用访问推理服务。
- 上游推理服务的 URL、鉴权方式、事件名、Base64 格式或内部会话 ID。
- 后端内部使用 `native`、`cascade`、fallback、重试或流量调度的具体实现。
- 推理服务的 OpenAI 兼容接口细节。

后端必须把上游差异转换成本协议定义的稳定事件。客户端不得直接连接推理服务，也不得依赖上游协议字段。

非实时能力发现和资源管理不使用 WebSocket。Pipeline、模型、组件、语言、默认选择、音色列表、音色克隆参考上传、处理状态、删除和对话清除由 [`HTTP_API_V2.md`](./HTTP_API_V2.md) 定义。

`WS_PROTOCOL.md` 继续定义版本 1。本文档在版本 1 的客户端实现基础上扩展；两个主版本不在线兼容。

## 2. 规范用语

本文档使用以下术语：

- **必须**：协议实现不可省略，否则视为不兼容。
- **应该**：推荐行为；确有理由可以偏离，但要记录原因。
- **可以**：可选能力。
- **客户端**：Tauri 桌面应用中的 WebSocket 发起方。
- **后端**：负责用户鉴权、权限校验、配额、路由、协议转换和请求管理的 MindSurf 服务。
- **推理服务**：由后端访问的模型服务，不直接暴露给客户端。
- **会话**：一条已经完成 `client.hello` / `server.hello` 握手的 WebSocket 连接。
- **请求**：一次从录音开始到结果完成、失败或取消的语音任务。
- **对话**：由后端管理、可以跨多个请求延续的上下文容器。
- **Pipeline**：后端暴露给客户端的推理能力配置，不等同于某个上游接口。
- **控制消息**：WebSocket Text Message 中的 UTF-8 JSON。
- **音频帧**：WebSocket Binary Message 中的二进制头部和音频载荷。
- **输入转写**：用户输入音频对应的可选文本结果。
- **终态事件**：使请求不再产生任何有效事件的消息。

## 3. 版本 2 的约束

协议版本 2 采用以下约束：

1. 客户端只连接 MindSurf 后端，不连接推理服务。
2. 一条 WebSocket 连接同一时间最多有一个活跃请求。
3. 一次请求最多包含一条上行音频流、一条输入转写流、一条助手文本流和一条下行音频流。
4. 上行音频固定为 16 kHz、单声道、PCM signed 16-bit little-endian。
5. 下行音频必须在 `output.audio.start` 中声明实际格式。
6. 控制消息使用 JSON，音频使用带请求 ID 的二进制消息。
7. Pipeline ID 是 HTTP capabilities 中的不透明业务配置 ID；其 `kind` 决定选择项结构，版本 2 当前定义 `cascade` 和 `native_audio` 两种 kind。
8. 客户端只依据协商能力处理事件，不依据 Pipeline 猜测事件顺序。
9. 输入转写在 Assistant 请求中可以缺失，也可以晚于助手输出。
10. 助手文本与音频是相互独立的输出流，可以交错或只出现其中一种。
11. 同一条连接可以承载多个顺序执行的请求，但客户端不需要在无请求时保持连接。
12. Pipeline、模型、语言、默认选择、音色和情绪通过 HTTP 发现；WebSocket hello 只协商当前连接的传输参数。
13. confirmed `conversation_id` 独立于连接，可以跨按需连接延续上下文；Dictation 和不支持 conversation 的 Pipeline 始终使用 `null`；`session_id` 仅属于当前连接。
14. 不支持断线后恢复正在进行的请求。只有断线前已经收到终态，或在 `input.commit`
    前断线且原 ID 已经 confirmed 时，下一请求才可以继续使用原对话 ID；commit 后、
    终态前断线必须按 `outcome_unknown` 开始新对话。
15. 后端必须屏蔽所有上游事件名、上游凭据和内部连接细节。

版本 2 相对版本 1 的主要变化：

| 方面 | 版本 1 | 版本 2 |
|---|---|---|
| 主要 Pipeline kind | `cascade` | `cascade` / `native_audio` |
| 能力发现 | WebSocket hello 承载候选目录 | HTTP capabilities 承载业务目录，hello 仅协商传输 |
| 连接生命周期 | 常驻连接与后台重连 | 按需连接，可选短时复用，空闲关闭不重连 |
| 模型选择 | ASR、LLM、TTS 分段选择 | HTTP 目录中的 Pipeline + 统一模型选择，分段组件可选 |
| 输入转写 | Assistant 流程必经 | 按能力与请求配置，可选且不阻塞输出 |
| 文本与音频顺序 | 音频至少晚于首个文本 delta | 两条输出流独立，无先后依赖 |
| 多轮上下文 | 字段预留 | 明确定义 `conversation_id` 生命周期 |
| 打断 | 先取消旧请求再开新请求 | 保持相同单请求约束，强化停止输出与计算要求 |
| 上游模型信息 | 未明确边界 | 明确由后端封装，客户端不可见 |

## 4. 连接

### 4.1 地址

客户端配置的是 MindSurf HTTP 后端 origin，并从 `GET /v2/capabilities` 的 `realtime.websocket_path` 生成 WebSocket 地址。调试阶段示例：

```text
HTTP origin: http://127.0.0.1:8000
WS path:     /v2/voice/ws
最终地址:    ws://127.0.0.1:8000/v2/voice/ws
```

要求：

- 客户端只配置 MindSurf 后端 HTTP origin，不把 v2 WebSocket URL 作为独立业务配置。
- WebSocket path 必须来自同源 HTTP capabilities；HTTPS/HTTP origin 分别只转换为 `wss://`/`ws://`。
- 客户端设置中不得出现推理服务地址、上游 API Key 或模型服务器 Token。
- 开发模式必须由应用构建或启动配置显式启用，不得根据目标主机是否为 localhost 自动推断。
- 非开发模式必须使用 `wss://`，并拒绝由 HTTP origin 生成的 `ws://` 地址。
- 开发模式可以使用 `ws://` 连接本地或非本地开发后端；未显式配置监听地址的本地开发后端仍必须默认绑定 `127.0.0.1` 或 `::1`。
- 开发模式下使用远程明文 WS 会暴露鉴权信息和音频内容，不得携带生产凭据或敏感数据。
- URL 路径中的 `v2` 是业务接口版本；握手仍必须验证协议版本。

### 4.2 WebSocket 子协议

客户端必须请求：

```text
mindsurf.voice.v2
```

后端必须在 HTTP Upgrade 响应中选择同一子协议。未返回子协议或返回其他子协议时，客户端必须关闭连接。

客户端不得在同一连接中同时请求 `mindsurf.voice.v1` 与 `mindsurf.voice.v2`，避免后端选择结果不确定。

### 4.3 鉴权

客户端鉴权属于本协议范围，由 MindSurf 后端验证。

版本 2 必须使用 `client.hello.payload.auth` 携带客户端 Bearer Token：

```json
{
  "auth": {
    "scheme": "bearer",
    "token": "<access-token>"
  }
}
```

要求：

- `auth` 不得省略。缺失时后端必须返回 `authentication_required`；本地开发环境同样必须使用专用开发 Token，v2 不接受匿名连接。
- Token 不得出现在 URL、WebSocket 子协议、日志、错误详情或关闭原因中。
- 非开发模式必须使用 `wss://`。开发模式可以使用 `ws://` 连接非本地开发地址，但不得携带生产凭据或敏感数据。
- 客户端只向用户配置的 MindSurf 后端发送 Token。
- 后端不得把客户端 Token 原样转发给推理服务。
- 后端可以在内部换取上游凭据，但该过程不属于本协议。
- 鉴权失败后客户端不得自动重连，直到用户更新凭据或手动重试。
- Token 过期时后端使用 `authentication_expired`；无效或权限不足时分别使用稳定错误码。

### 4.4 建连时限

| 操作 | 默认时限 |
|---|---:|
| TCP/TLS/WebSocket 建连 | 5 秒 |
| WebSocket 打开后发送 `client.hello` | 3 秒 |
| `client.hello` 后收到 `server.hello` | 3 秒 |

握手未在时限内完成时，等待方必须关闭连接。握手完成前不得发送请求或音频。

## 5. JSON 控制消息

### 5.1 通用信封

控制消息的字段级机器契约以 [`client-messages.schema.json`](../schemas/client-messages.schema.json) 和 [`server-messages.schema.json`](../schemas/server-messages.schema.json) 为准；本节解释信封语义。

每条控制消息必须符合以下结构：

```json
{
  "v": 2,
  "type": "session.pong",
  "event_id": "019d643e-1550-761a-b7a0-471791bcaf0a",
  "request_id": null,
  "sent_at_ms": 1785945601000,
  "payload": {"nonce": "example-envelope"}
}
```

字段定义：

| 字段 | 类型 | 必须 | 说明 |
|---|---|---:|---|
| `v` | integer | 是 | 协议主版本，固定为 `2` |
| `type` | string | 是 | 小写点分消息类型 |
| `event_id` | UUID string | 是 | 本条消息唯一 ID |
| `request_id` | UUID string/null | 是 | 请求消息为 UUID，会话消息为 `null` |
| `sent_at_ms` | integer | 是 | Unix epoch 毫秒时间戳 |
| `payload` | object | 是 | 消息负载，无字段时使用 `{}` |

约束：

- `event_id` 和 `request_id` 推荐使用 UUIDv7。
- `event_id` 的唯一性和去重范围是当前 WebSocket session。接收方必须保留本 session
  已处理的 event ID，直到连接关闭；跨 session 不延续去重表。
- 重复 `event_id` 必须静默忽略并记录，不得再次改变状态，也不得重放 accepted、
  committed、流事件或终态。客户端不得通过复用 event ID 重试控制消息；等待超时后
  应按对应的 cancel/关闭流程处理。
- `request_id` 在同一 session 内不得复用，包括原请求已经终态的情况；新连接也必须
  为新请求生成新的 request ID，版本 2 不支持用旧 ID 恢复或重放请求。
- 接收方不得使用 `sent_at_ms` 决定消息顺序。
- 接收方必须忽略未知的非关键 payload 字段。需要改变处理结果、权限、资源选择或终态
  语义的字段不属于非关键扩展，必须经过 capabilities 协商或提升协议版本。
- 后端收到未知客户端 `type` 时，必须向客户端返回 `unsupported_message_type`；客户端不得发送 `error`。
- 客户端收到未知服务端 `type` 时，必须按第 16.4 节处理，不得向后端返回 `error`。
- JSON 控制消息不得超过 64 KiB。
- 数字不得使用 `NaN`、`Infinity` 或 `-Infinity`。

### 5.2 会话级与请求级消息

会话级消息的 `request_id` 必须为 `null`：

- `client.hello`
- `server.hello`
- `session.ping`
- `session.pong`
- 会话级 `error`

其余消息均为请求级消息，必须携带其目标请求的 `request_id`：

- `request.start` 使用客户端为本次新请求生成的 ID，并使该 ID 进入 `starting` 状态。
- `request.accepted` 前拒绝该请求的请求级 `error` 必须回显同一 ID；此类错误不创建活跃请求。
- 请求被接受后，其他请求级消息必须携带当前活跃请求的 ID。
- 一条连接仍然最多只有一个 `starting` 或已接受但未终态的请求；这两种状态都占用单请求槽位。

## 6. 二进制音频帧

### 6.1 WebSocket 消息边界

每个 WebSocket Binary Message 必须只包含一个版本 2 音频帧：

```text
48 字节固定头部 + 音频载荷
```

版本 2 沿用版本 1 的固定头部布局，只有头部 `version` 改为 `2`。保留二进制音频可以继续使用客户端现有录音、背压、序号检查和流式播放器实现。

### 6.2 固定头部

所有多字节整数使用网络字节序（big-endian）。

| 偏移 | 长度 | 字段 | 类型 | 说明 |
|---:|---:|---|---|---|
| 0 | 4 | magic | bytes | 固定 ASCII `MSVA` |
| 4 | 1 | version | `u8` | 固定为 `2` |
| 5 | 1 | kind | `u8` | 音频帧类型 |
| 6 | 2 | flags | `u16` | 当前固定为 `0` |
| 8 | 2 | header_length | `u16` | 固定为 `48` |
| 10 | 2 | reserved_1 | `u16` | 固定为 `0` |
| 12 | 4 | sequence | `u32` | 每条音频流从 `0` 递增 |
| 16 | 8 | timestamp_us | `u64` | 相对该音频流起点的微秒数 |
| 24 | 4 | payload_length | `u32` | 音频载荷字节数 |
| 28 | 4 | reserved_2 | `u32` | 固定为 `0` |
| 32 | 16 | request_id | bytes | UUID 规范文本顺序的 16 字节表示 |

`kind`：

| 值 | 名称 | 方向 | 载荷 |
|---:|---|---|---|
| `0x01` | `INPUT_PCM` | 客户端 → 后端 | PCM16LE |
| `0x02` | `OUTPUT_PCM` | 后端 → 客户端 | PCM16LE |

客户端与后端之间不得传输模型 audio token、codec token、Base64 音频或上游私有二进制帧。

UUID 编码必须按规范字符串移除连字符后的 32 个十六进制数字，从左到右每两个数字编码为一个字节。例如 `00112233-4455-6677-8899-aabbccddeeff` 编码为 `00 11 22 33 44 55 66 77 88 99 aa bb cc dd ee ff`。不得使用 .NET `Guid.ToByteArray()` 等平台原生混合端序布局。

逐字节正反例见 [`test-vectors/binary/audio-frames.json`](../test-vectors/binary/audio-frames.json)。客户端和后端都必须用这些向量验证自己的 encoder 与 decoder。

### 6.3 序号、时间戳和长度

- 每条音频流的首帧 `sequence` 必须为 `0`，后续严格加一。
- 上行与下行分别维护序号。
- `timestamp_us` 是强校验字段，从各自音频流的第一个采样点开始；第一个帧固定为 `0`。
- 后续 PCM 帧的 `timestamp_us` 必须等于 `floor(此前累计样本数 × 1,000,000 / sample_rate)`。
- 后端收到重复、倒序或跳号的 `INPUT_PCM` 时，必须以请求级 `terminal=true` 的 `audio_sequence_error` 终止请求。
- 客户端收到重复、倒序或跳号的 `OUTPUT_PCM` 时，不得向后端发送 `error`；客户端必须停止播放，若连接仍可写则尽力发送 `request.cancel(reason=protocol_error)`，不等待取消终态，并以 WebSocket `1002` 关闭连接。
- WebSocket Binary Message 长度必须等于 `header_length + payload_length`。
- `payload_length` 必须大于 `0`，并满足样本宽度与声道数的整数倍。
- `limits.max_binary_bytes` 包含 48 字节头部与 payload；整个 WebSocket Binary Message 不得超过该值。
- `request_id` 必须等于当前活跃请求。
- commit 的 `frame_count` 必须等于 `last_sequence + 1`；无音频时不得 commit。
- `sample_count` 必须等于所有已接受输入帧的样本总数。
- `duration_ms` 必须按 `floor(sample_count × 1000 / sample_rate + 0.5)` 舍入到最近整数。

### 6.4 上行音频

固定格式：

| 属性 | 值 |
|---|---|
| 编码 | PCM signed 16-bit little-endian |
| 采样率 | 16,000 Hz |
| 声道 | 1 |
| 推荐分片 | 20 ms |
| 推荐样本数 | 320 |
| 推荐载荷 | 640 bytes |

该格式的协议稳定 ID 为 `pcm16_mono`，也是 hello 唯一允许的输入候选。

### 6.5 下行音频

下行格式由 `output.audio.start` 声明。版本 2 定义以下可协商的稳定候选；客户端可以
声明空集或任意子集，不要求支持全部候选：

| ID | encoding | sample_rate | channels |
|---|---|---:|---:|
| `pcm16_mono` | `pcm_s16le` | 16000 | 1 |
| `pcm24_mono` | `pcm_s16le` | 24000 | 1 |

后端必须负责把上游音频转换成客户端协商支持的格式。客户端不关心上游模型原始输出采样率或编码。

## 7. 会话握手

### 7.1 `client.hello`

WebSocket 打开后，客户端发送的第一条消息必须是：

```json
{
  "v": 2,
  "type": "client.hello",
  "event_id": "019d6441-a89a-7f57-9611-a12bb4c08f10",
  "request_id": null,
  "sent_at_ms": 1785945600000,
  "payload": {
    "client": {
      "name": "mindsurf-voice-ai",
      "version": "0.2.0",
      "platform": "macos",
      "arch": "aarch64"
    },
    "protocol_versions": [2],
    "input_audio": [{
      "id": "pcm16_mono",
      "encoding": "pcm_s16le",
      "sample_rate": 16000,
      "channels": 1
    }],
    "output_audio": [{
      "id": "pcm16_mono",
      "encoding": "pcm_s16le",
      "sample_rate": 16000,
      "channels": 1
    }, {
      "id": "pcm24_mono",
      "encoding": "pcm_s16le",
      "sample_rate": 24000,
      "channels": 1
    }],
    "auth": {
      "scheme": "bearer",
      "token": "<access-token>"
    }
  }
}
```

`client.hello` 只声明客户端身份、鉴权和当前连接能够收发的音频格式。Pipeline、模型、级联组件、语言、音色和默认选择来自 HTTP `GET /v2/capabilities` 与 `GET /v2/voices`，不得在 hello 中重复发送。

音频格式 ID 及其编码含义由本协议第 6 节定义，不依赖 HTTP 目录。同一 ID 的 encoding、sample rate 和 channels 不一致，或没有共同的必需输入格式时，后端必须发送会话级 fatal `transport_negotiation_failed` 并关闭连接。

### 7.2 `server.hello`

后端完成鉴权和传输格式协商后返回：

```json
{
  "v": 2,
  "type": "server.hello",
  "event_id": "019d6442-c659-7308-a496-0e2d74229ffc",
  "request_id": null,
  "sent_at_ms": 1785945600100,
  "payload": {
    "session_id": "019d6442-c5ef-766b-9c40-acba2e25f931",
    "server": {
      "id": "mindsurf-backend",
      "version": "0.2.0"
    },
    "protocol_version": 2,
    "input_audio": {
      "id": "pcm16_mono",
      "encoding": "pcm_s16le",
      "sample_rate": 16000,
      "channels": 1
    },
    "output_audio": [{
      "id": "pcm16_mono",
      "encoding": "pcm_s16le",
      "sample_rate": 16000,
      "channels": 1
    }, {
      "id": "pcm24_mono",
      "encoding": "pcm_s16le",
      "sample_rate": 24000,
      "channels": 1
    }],
    "limits": {
      "max_recording_ms": 120000,
      "max_json_bytes": 65536,
      "max_binary_bytes": 65536,
      "max_concurrent_requests": 1
    },
    "timeouts": {
      "request_accept_timeout_ms": 2000,
      "input_commit_timeout_ms": 2000,
      "input_idle_timeout_ms": 10000,
      "dictation_completion_timeout_ms": 10000,
      "assistant_first_output_timeout_ms": 15000,
      "assistant_first_audio_timeout_ms": 30000,
      "request_total_timeout_ms": 120000,
      "cancel_stop_target_ms": 200,
      "cancel_timeout_ms": 2000,
      "connection_idle_timeout_ms": 30000
    },
    "heartbeat": {
      "interval_ms": 15000,
      "timeout_ms": 5000
    }
  }
}
```

要求：

- `server.hello` 只描述当前 WebSocket 连接，不返回 Pipeline、模型、级联组件、语言、音色、默认选择或 HTTP 资源 URL。
- `input_audio` 必须是客户端声明且后端支持的一个格式。版本 2 当前必须协商为 16 kHz 单声道 PCM16LE。
- `output_audio` 是客户端与后端按本协议格式目录计算的交集，可以为空；为空时本连接仍可执行 Dictation 或纯文本 Assistant，但 `response.audio=true` 必须被拒绝。
- `output_audio` 按后端偏好排序。请求音频且客户端没有仍然有效的本地格式偏好时，默认选择数组第一项；该传输选择不属于 HTTP 业务默认值。
- 同一格式 ID 在 client hello 和 server hello 中的编码含义必须一致。
- `limits` 声明本连接的资源和消息硬上限；`timeouts` 声明握手完成后各请求阶段与连接空闲的实际期限，两个对象均为必填。
- `limits.max_recording_ms` 必须大于或等于当前用户、当前 capabilities revision 中所有
  可用 Pipeline 的 `max_recording_ms` 最大值。hello 不携带 Pipeline，因此后端不得按其
  猜测的客户端选择返回更小上限。客户端持有旧 revision 且旧目录上限更大时，应先刷新
  capabilities；只有当前 revision 的请求才可能被 accepted。
- 版本 2 的 `limits.max_json_bytes` 固定为 `65536`。`limits.max_binary_bytes` 至少为
  `50`，因为 48 字节头部加一个 PCM16 样本是最小合法音频帧；部署应该至少允许
  推荐的 20 ms 输入分片，即不小于 `688` 字节。
- `timeouts` 中所有值必须为正整数；`cancel_stop_target_ms` 不得大于 `cancel_timeout_ms`，各首输出和完成超时不得大于 `request_total_timeout_ms`。
- `input_idle_timeout_ms` 是 accepted 后等待首帧、以及输入帧之间允许的最大连续空闲；
  它不是 `input_commit_timeout_ms`，后者只计量 commit 已发送后的统计确认。
- 后端不得返回上游服务 URL、上游 Token、内部部署地址或内部会话 ID。

### 7.3 按需连接与连接复用

版本 2 不要求客户端在没有实时请求时保持 WebSocket：

- 推荐流程是应用启动或设置变更时通过 HTTP 获取能力与资源；用户触发录音时再建立 WebSocket。
- 用户触发录音后，客户端可以立即开始本地采集并写入有界内存预缓冲，同时完成建连、hello 和 `request.start`；`request.accepted` 前不得上传 PCM。
- 客户端也可以在用户明确启用、即将录音或需要降低首轮延迟时预连接。预连接和请求结束后的短时复用属于客户端策略，不是协议要求。
- `request.done`、`request.cancelled` 或请求级终态 error 后，客户端可以立即以 `1000/client_idle` 关闭连接，也可以在不超过本地保温策略和服务端 `connection_idle_timeout_ms` 的范围内复用。
- 后端在不存在 starting/活跃请求，且连续 `connection_idle_timeout_ms` 没有业务请求时，必须以 `1000/idle_timeout` 正常关闭连接。心跳消息不延长该业务空闲期限。
- 因 `client_idle` 或 `idle_timeout` 正常关闭时，客户端不得立即后台重连；下一次用户请求或明确的预连接动作再建立新连接。
- 活跃请求期间意外断线会使该请求失败，不支持恢复或自动重放录音。下一次用户动作使用新的 request ID 和新连接；若已有可继续的 `conversation_id`，可以跨连接携带。
- `session_id` 只在当前 WebSocket 连接内有效；`conversation_id` 独立于连接，可以跨多个按需连接延续。

冷启动预缓冲要求：

- 预缓冲只保存在内存，不得写入磁盘或日志。
- 客户端必须设置 `cold_start_buffer_limit_ms`，默认至少 15000 ms；它不是协商字段。
- 建连、握手和请求接受期间持续计入该上限。到达上限仍未 accepted 时，客户端必须停止本次录音、关闭连接并提示重试，不得丢弃最早音频后继续上传。
- 收到 hello 后，如果剩余预缓冲容量不足以覆盖 `request_accept_timeout_ms + client_safety_margin_ms`，客户端不得启动请求。`client_safety_margin_ms` 默认 1000 ms。
- accepted 后，客户端先按录制顺序发送全部预缓冲 PCM，再发送实时 PCM；sequence 从 0 连续递增，timestamp 以用户开始本次录音的时刻为流起点。

## 8. 心跳

后端在网络收发空闲达到 `heartbeat.interval_ms` 后发送 `session.ping`：

```json
{
  "v": 2,
  "type": "session.ping",
  "event_id": "019d6444-87b1-7cbb-aadc-af18702f9e51",
  "request_id": null,
  "sent_at_ms": 1785945615000,
  "payload": {"nonce": "f8083d0b"}
}
```

客户端必须使用相同 nonce 回复 `session.pong`。心跳不得携带鉴权信息或业务数据。

```json
{
  "v": 2,
  "type": "session.pong",
  "event_id": "019d6444-8b61-75a1-bc1f-ae6a12a79c21",
  "request_id": null,
  "sent_at_ms": 1785945615010,
  "payload": {"nonce": "f8083d0b"}
}
```

心跳只用于判断一条仍被保留的连接是否存活，不要求客户端常驻连接。状态规则：

- “网络收发空闲”表示后端在连续 `heartbeat.interval_ms` 内既未发送也未收到任何有效 WebSocket Text/Binary Message。
- 任一有效消息会重置心跳的网络收发空闲计时；WebSocket 控制帧不替代本协议心跳。
- 同一时刻最多允许一个尚未确认的 ping。未收到匹配 pong 前不得发送第二个 ping。
- ping 发出后，普通业务消息不能替代 pong；客户端仍必须回复匹配 nonce。
- `heartbeat.timeout_ms` 内未收到匹配 pong 时，后端使用关闭码 `4004` 关闭连接。
- 重复、未知或 nonce 不匹配的 pong 必须忽略并记录，但不得清除当前心跳超时。
- 心跳计时与 `connection_idle_timeout_ms` 的业务空闲计时相互独立。`session.ping`、`session.pong` 和 WebSocket 控制帧均不得重置业务空闲计时，也不得阻止正常 idle close。

## 9. 请求生命周期

### 9.1 请求状态

本节是总览；事件屏障、流完成和终态不变量以 [`request-lifecycle.md`](./request-lifecycle.md) 为准。

```text
idle -> starting -> recording -> committing -> processing -> streaming
          |            |            |             |           |
          +------------+------------+-------------+-----------+
                                   -> cancelling -> cancelled

starting -----------------------------------------------> failed
recording / committing / processing / streaming -------> completed | failed
```

`starting` 从客户端发送 `request.start` 开始，到收到 `request.accepted` 或请求级终态错误结束。客户端可以在 `starting` 以及任意已接受但未终态的状态发送 `request.cancel`。取消与正常完成竞态时，最终状态也可以是 `completed` 或 `failed`。

终态事件：

- `request.done`
- `request.cancelled`
- 请求级且 `terminal=true` 的 `error`

终态后同请求事件必须忽略并记录。

### 9.2 模式

| mode | 输入转写 | 助手文本 | 助手音频 | 说明 |
|---|---|---|---|---|
| `dictation` | 必须 | 不允许 | 不允许 | 语音转文字 |
| `assistant` | 可选 | 至少一种输出 | 至少一种输出 | 语音助手 |

当前客户端 `mixed` 交互模式在协议层映射为 `assistant`，差异由本地文本输出策略处理。

客户端只能选择 Pipeline 声明支持的 mode。

## 10. 请求消息

### 10.1 `request.start`

请求中的业务选择必须来自最近一次 HTTP capabilities 和 voices 查询。客户端无需为了浏览或修改这些选择而建立 WebSocket；只有准备开始实时请求时才按第 7.3 节确保连接并完成握手。

```json
{
  "v": 2,
  "type": "request.start",
  "event_id": "019d6446-0172-7df9-8f0b-ecce3a2b40df",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945620000,
  "payload": {
    "mode": "assistant",
    "pipeline": "native_audio",
    "capabilities_revision": "cap_019d64c1",
    "selection": {
      "model": "mindsurf-omni",
      "asr": null,
      "llm": null,
      "tts": null
    },
    "conversation_id": null,
    "language": "auto",
    "response": {
      "input_transcription": false,
      "text": true,
      "audio": true,
      "output_audio": "pcm24_mono",
      "voice": "serena",
      "emotion": "neutral"
    },
    "generation": {
      "text": {
        "temperature": 0.7,
        "top_p": 0.9,
        "max_output_tokens": 512
      },
      "audio": {}
    }
  }
}
```

字段定义：

| 字段 | 类型 | 必须 | 说明 |
|---|---|---:|---|
| `mode` | enum | 是 | `dictation` 或 `assistant` |
| `pipeline` | string | 是 | 来自 HTTP `GET /v2/capabilities` 的不透明 Pipeline ID；不得从其文本推断 kind |
| `capabilities_revision` | string | 是 | 构造本请求所使用的 capabilities `revision` |
| `selection.model` | string/null | 是 | 原生或统一模型 ID；来自 HTTP capabilities |
| `selection.asr` | string/null | 是 | 级联 ASR ID；原生 Pipeline 为 `null` |
| `selection.llm` | string/null | 是 | 级联 LLM ID；不使用时为 `null` |
| `selection.tts` | string/null | 是 | 级联 TTS ID；不使用时为 `null` |
| `conversation_id` | UUID/null | 是 | 支持 conversation 的 Assistant 中，UUID 延续 confirmed 对话、`null` 创建新对话；其他请求固定为 `null` |
| `language` | string | 是 | 识别语言或 `auto` |
| `response.input_transcription` | boolean | 是 | 是否需要输入转写 |
| `response.text` | boolean | 是 | 是否需要助手文本 |
| `response.audio` | boolean | 是 | 是否需要助手音频 |
| `response.output_audio` | string/null | 是 | 本连接 `server.hello.output_audio` 中的格式 ID |
| `response.voice` | string/null | 是 | HTTP 音色资源中的可选音色 ID |
| `response.emotion` | string/null | 是 | 该 Pipeline 与音色共同支持的情绪 ID |
| `generation.text` | object | 否 | capabilities 中 `generation_controls.text` 声明的参数 |
| `generation.audio` | object | 否 | capabilities 中 `generation_controls.audio` 声明的参数 |

约束：

- `dictation` 必须请求输入转写，且不得请求助手文本或音频。
- `capabilities_revision` 必须等于后端当前用户能力目录 revision；不一致时在 accepted 前
  返回请求级 terminal、retryable 的 `capabilities_stale`，客户端刷新 capabilities 后以
  新 request ID 重试。后端不需要保留或猜测历史目录。
- 所有 `INPUT_PCM` 均使用本连接 `server.hello.input_audio` 已确认的格式；请求不得重复携带或覆盖输入格式。
- `assistant` 必须至少请求文本或音频之一。
- Dictation 不创建或更新 conversation，必须发送 `conversation_id=null`。
- `features.conversation=false` 的 Assistant 必须发送 `conversation_id=null`；accepted、done 和 cancelled 也返回 `null`。
- 复用 conversation 时 Pipeline 以及原生 model/级联 LLM 必须与创建时一致，否则返回 `conversation_configuration_mismatch`。完整绑定规则见 [`conversations.md`](./conversations.md)。
- 客户端和后端必须先在 `capabilities_revision` 指定的能力快照中按 `pipeline` ID 查找
  Pipeline，再读取其 `kind`；必须先校验 revision，不能用另一 revision 的 ID→kind 映射
  解释请求，也不得根据 ID、名称、默认选择或候选分布推断 kind。
- 所选 Pipeline 的 `kind=native_audio` 时必须为 Assistant，选择 `model`，并把
  `asr`、`llm`、`tts` 设为 `null`。
- 所选 Pipeline 的 `kind=cascade` 时必须把 `model` 设为 `null` 并选择 `asr`。
- `kind=cascade` 的 Dictation 必须把 `llm`、`tts` 设为 `null`，并且必须省略 `generation`。
- `kind=cascade` 的 Assistant 必须选择 `llm`；请求音频时必须选择 `tts`，不请求音频时
  `tts` 必须为 `null`。
- `response.audio=false` 时，`output_audio`、`voice`、`emotion` 必须全部为 `null`。
- `response.audio=true` 时，`output_audio` 必须非空。`voice_control=none` 时 `voice` 必须
  为 `null`；`voice_control=preset` 或 `reference_clone` 时 `voice` 必须非空。
  `emotion` 按下方 Pipeline/voice 兼容矩阵决定是否非空。
- 客户端必须显式发送最终 `emotion` 值或 `null`；HTTP 音色资源的 `default_emotion` 只用于初始化客户端选择，服务端不得在 `request.start` 中对缺失字段做隐式补值。
- 纯 Dictation 请求不得携带任何文本或音频生成参数。
- Pipeline 不支持输入转写时，Assistant 请求必须把它设为 `false`。
- `features.outputs.text.supported=false` 时必须令 `response.text=false`；
  `features.outputs.audio.supported=false` 时必须令 `response.audio=false`，违反时返回
  `unsupported_feature`。文本 supported 但 streaming=false 时只发送无 delta 的
  `assistant.text.done(last_sequence=null)`。
- `voice` 必须处于 `ready` 且 `selectable=true`；客户端不得提交仍在处理、预览或禁用的音色。
- Pipeline `emotion_control=none` 时，`emotion` 必须为 `null`；所选 voice 的
  `emotion_control` 也必须为 `none`。
- Pipeline `emotion_control=preset` 时，所选 voice 的 `emotion_control` 必须为 `preset`，
  `emotion` 必须非空并属于该 voice 的 `supported_emotions`；该数组是版本 2 的预设枚举
  权威来源。
- Pipeline `emotion_control=reference_variant` 时，所选 voice 的 `emotion_control` 必须为
  `reference_variant`，`emotion` 必须非空并对应一条 `status=ready` 的参考；不允许用
  数值强度模拟情绪旋钮。
- Pipeline 与 voice 的 `emotion_control` 不匹配时返回 `unsupported_feature`；匹配但指定
  emotion 不存在、未 ready 或无权访问时返回 `emotion_reference_not_found`。客户端必须
  在发送前使用 voices 最新资源机械校验上述矩阵。
- 客户端不得假定文本生成参数会改变音频表现。
- `generation` 存在时，其键只能是 `text` 和/或 `audio`，且值必须为对象；各对象只允许发送
  HTTP capabilities 对应通道声明的参数。未知参数、错误通道参数及旧版扁平结构均
  返回 `invalid_message`，后端不得在两个通道间猜测或搬移参数。
- `generation.text` 只允许在 `response.text=true` 时发送；`generation.audio` 只允许在
  `response.audio=true` 时发送。省略 `generation` 表示采用 capabilities 中的默认值。
- 后端必须验证当前用户是否有权使用所选 Pipeline、模型和音色。
- 选择的 voice 不存在或越权时返回 `voice_not_found`；未 ready、不可选择或缺少 ready 情绪参考时分别返回 `voice_not_ready`、`voice_not_selectable`、`emotion_reference_not_found`。
- 不在本连接传输格式交集内的输出格式返回 `unsupported_output_audio`；HTTP 目录已经变化、识别语言或 ASR/LLM/TTS 选项不再存在或不适用时分别返回对应稳定错误。后者要求客户端刷新 HTTP capabilities，不得依赖 hello 获取业务目录。
- 后端如何把这些字段转换成上游请求不属于本协议。

### 10.2 `request.accepted`

```json
{
  "v": 2,
  "type": "request.accepted",
  "event_id": "019d6446-5727-7714-8efb-8e8be5d7023b",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945620050,
  "payload": {
    "mode": "assistant",
    "pipeline": "native_audio",
    "capabilities_revision": "cap_019d64c1",
    "selection": {
      "model": "mindsurf-omni",
      "asr": null,
      "llm": null,
      "tts": null
    },
    "conversation_id": "019d6446-56e6-7529-820e-e2ea51f232b5",
    "language": "auto",
    "response": {
      "input_transcription": false,
      "text": true,
      "audio": true,
      "output_audio": "pcm24_mono",
      "voice": "serena",
      "emotion": "neutral"
    },
    "generation": {
      "text": {
        "temperature": 0.7,
        "top_p": 0.9,
        "max_output_tokens": 512
      },
      "audio": {}
    },
    "max_recording_ms": 120000
  }
}
```

要求：

- 客户端收到 accepted 后才能发送二进制音频。
- 后端确认 Pipeline、选择项、对话 ID 和输出配置。
- accepted 中当前 v2 定义的 mode、Pipeline、capabilities revision、selection、language、response 已知语义字段
  必须严格等于 start；start 携带 generation 时 accepted 必须逐字段原样回显已知参数，
  start 省略时 accepted 也必须省略。未知非关键扩展字段可以忽略且不要求回显，客户端
  不得仅因该类字段未回显而判定协议错误。版本 2 不允许通过回显不同已知值实现 fallback。
- `max_recording_ms` 是本请求的不可变录音样本时长上限，必须严格等于所选 Pipeline 在
  客户端本次构造请求所依据的 HTTP capabilities 中声明的值，并且不得大于
  `server.hello.limits.max_recording_ms`。后端不得在 accepted 阶段临时缩短该值；若
  能力目录已过期且当前上限不同，必须在 accepted 前以 `pipeline_unavailable` 拒绝。
  对 16 kHz 输入，最大合法样本数固定为
  `floor(max_recording_ms * 16000 / 1000)`；累计 `sample_count` 超过该值时返回
  `input_too_long`，不得使用四舍五入后的 `duration_ms` 判断是否超限。
- 新建 conversation 返回的 ID 在收到 `request.done` 前只是 provisional；客户端不得提前把它作为后续默认上下文。
- 发送 accepted 前，后端必须对选定音色及 ready 情绪参考建立该请求专用的不可变快照；资源随后通过 HTTP 删除不影响本请求，后续请求重新校验最新资源状态。
- 后端不能满足原请求时必须返回明确错误。内部 fallback 只有在不改变客户端可观察选择和语义时才允许。
- 客户端等待确认的超时为 `server.hello.timeouts.request_accept_timeout_ms`。

### 10.3 上行音频与提交

`request.accepted` 后客户端发送 `INPUT_PCM` 帧。首帧和相邻有效帧受
`input_idle_timeout_ms` 约束。录音结束后发送：

```json
{
  "v": 2,
  "type": "input.commit",
  "event_id": "019d6449-3334-7d06-8dae-c1fa96d3141c",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945625000,
  "payload": {
    "last_sequence": 249,
    "frame_count": 250,
    "sample_count": 80000,
    "duration_ms": 5000
  }
}
```

提交后不得再发送该请求的输入音频。后端校验统计后返回 `input.committed`。

若用户在尚未发送任何 PCM 时结束录音，客户端不得构造零统计 commit，必须改为发送
`request.cancel(reason=user_cancelled)`。已经提交非空 PCM、但后端检测不到有效语音
时，后端返回请求级 terminal `input_empty`。

### 10.4 `input.committed`

```json
{
  "v": 2,
  "type": "input.committed",
  "event_id": "019d6449-44c0-795b-b125-5016f1343f02",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945625050,
  "payload": {
    "frame_count": 250,
    "sample_count": 80000,
    "duration_ms": 5000
  }
}
```

要求：

- 每个有效 `input.commit` 必须返回一次。
- 返回值必须反映后端实际接受的音频统计。
- 统计不一致时返回 `input_statistics_mismatch`，不得开始处理。
- 客户端以本消息作为录音上传完成和处理计时的起点。
- 除取消和 error 外，后端在发送本消息前不得发送任何 transcript、Assistant 输出或成功终态；完整处理屏障见 [`request-lifecycle.md`](./request-lifecycle.md)。

## 11. 输入转写事件

### 11.1 `input.transcript.delta`

当请求明确启用输入转写且 Pipeline 支持流式转写时，后端可以发送：

```json
{
  "v": 2,
  "type": "input.transcript.delta",
  "event_id": "019d644a-45d7-79a4-b653-22731dac962e",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945625300,
  "payload": {
    "text": "帮我总结",
    "revision": 0,
    "stable_prefix_length": 2
  }
}
```

修订规则：

- `text` 是当前完整转写假设，不是新增片段；客户端每次用它替换上一 revision。
- `revision` 从 `0` 开始严格加一。
- `stable_prefix_length` 按 Unicode code point 计数，不是 UTF-8 字节或 JavaScript UTF-16 code unit。
- `stable_prefix_length` 必须在 `0..text code point length` 范围内，并且不得小于上一 revision。
- 已声明稳定的前缀内容不得在后续 revision 中改变。

### 11.2 `input.transcript.done`

```json
{
  "v": 2,
  "type": "input.transcript.done",
  "event_id": "019d644b-03ef-77a4-bf2d-c1b1324ef652",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945626000,
  "payload": {
    "text": "帮我总结一下今天的会议",
    "language": "zh",
    "confidence": null,
    "duration_ms": 5000,
    "finish_reason": "stop"
  }
}
```

要求：

- 成功的 `dictation` 请求必须发送一次 done；失败时遵守第 14.1 节的“开始前/开始后”流终止规则。
- 未请求输入转写时不得发送 transcript 事件。
- Assistant 请求中的输入转写是旁路结果，不是助手输出的前置条件。
- 助手文本或音频可以早于 `input.transcript.done`。
- 原生音频 Pipeline 不支持转写时不得伪造 ASR 文本。
- `finish_reason` 只允许 `stop` 或 `error`。成功完成时为 `stop`；已经发送至少一个 transcript delta 后失败时为 `error`，`text` 保存最后一个完整假设。

版本 2 使用 `input.transcript.*` 替代版本 1 的 `asr.*`，避免客户端把所有输入理解都假设成独立 ASR 阶段。

## 12. Assistant 文本事件

### 12.1 `assistant.text.delta`

```json
{
  "v": 2,
  "type": "assistant.text.delta",
  "event_id": "019d644c-184b-7137-aa22-a2f003a1a701",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945626500,
  "payload": {
    "sequence": 0,
    "delta": "当然可以，"
  }
}
```

序号从 `0` 严格递增。客户端按顺序拼接文本。

### 12.2 `assistant.text.done`

```json
{
  "v": 2,
  "type": "assistant.text.done",
  "event_id": "019d644d-22e7-7770-82fb-a17aa96bd759",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945628000,
  "payload": {
    "text": "当然可以，下面是会议总结。",
    "last_sequence": 3,
    "finish_reason": "stop",
    "usage": {
      "input_tokens": 120,
      "output_tokens": 18
    }
  }
}
```

文本与音频输出之间没有先后约束。即使音频已经开始或完成，文本流仍必须保持自己的 sequence 和 done 语义。

`last_sequence` 的类型为 `integer/null`：发送过至少一个文本 delta 时，它必须等于最后一个 delta 的 sequence；没有发送任何 delta、直接以完整文本成功结束时必须为 `null`。`assistant.text.done` 可以作为未发送 delta 的合法成功文本流终点。

`finish_reason` 只允许 `stop` 或 `error`。成功完成时为 `stop`；已经发送至少一个文本 delta 后失败时为 `error`，`text` 为已发送 delta 的拼接结果，`last_sequence` 为最后一个已发送序号。开始前失败仍只发送 stream error，不发送 text done。

## 13. Assistant 音频事件

### 13.1 `output.audio.start`

```json
{
  "v": 2,
  "type": "output.audio.start",
  "event_id": "019d644c-1a36-7c56-9de1-7452b78bf83b",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945626510,
  "payload": {
    "format_id": "pcm24_mono",
    "encoding": "pcm_s16le",
    "sample_rate": 24000,
    "channels": 1,
    "voice": "serena",
    "emotion": "neutral"
  }
}
```

要求：

- 第一条 `OUTPUT_PCM` 前必须发送。
- `format_id` 必须等于 `request.accepted.response.output_audio`。
- `encoding`、`sample_rate` 和 `channels` 必须匹配 `format_id` 指向的协商候选。
- `voice` 的类型为 string/null；`voice` 和 `emotion` 必须分别严格等于
  `request.accepted.response.voice` 和 `request.accepted.response.emotion`；它们是对
  已接受选择的一致性确认，不允许报告后端替换后的实际值。
- 可以早于第一个助手文本 delta。
- 客户端以本事件初始化播放链路，不依据 Pipeline 或模型名称猜采样率。

### 13.2 下行二进制音频

`output.audio.start` 后，后端发送 `OUTPUT_PCM` 二进制帧。客户端按 sequence 入流式播放器。

后端必须完成所有上游格式转换。上游即使使用 audio token、codec、Base64 或其他采样率，对客户端仍只表现为协商后的 PCM 帧。

### 13.3 `output.audio.done`

```json
{
  "v": 2,
  "type": "output.audio.done",
  "event_id": "019d644f-301e-7703-b414-e5d23177370c",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945630000,
  "payload": {
    "last_sequence": 42,
    "chunk_count": 43,
    "sample_count": 103200,
    "duration_ms": 4300,
    "finish_reason": "stop"
  }
}
```

`finish_reason` 可取 `stop` 或 `error`。`output.audio.done` 表示后端不再发送音频，不表示本地播放完毕。若 `output.audio.start` 后、第一条 PCM 前失败，必须发送 `last_sequence=null`、`chunk_count=0`、`sample_count=0`、`duration_ms=0` 和 `finish_reason=error`。帧数、样本数和时长必须满足 [`request-lifecycle.md`](./request-lifecycle.md) 的强一致性公式。

## 14. 请求完成

### 14.1 `request.done`

```json
{
  "v": 2,
  "type": "request.done",
  "event_id": "019d6450-13db-77c8-b916-b17ff0b3f6ea",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945631000,
  "payload": {
    "result": "success",
    "conversation_id": "019d6446-56e6-7529-820e-e2ea51f232b5",
    "requested": {
      "input_transcription": false,
      "text": true,
      "audio": true
    },
    "completed": {
      "input_transcription": false,
      "text": true,
      "audio": true
    },
    "failures": {},
    "usage": {
      "recording_ms": 5000,
      "input_tokens": 120,
      "output_tokens": 18,
      "output_audio_ms": 4300
    },
    "context": {
      "retained_turns": 2,
      "dropped_turns": 0
    }
  }
}
```

部分成功的 payload 示例：

```json
{
  "result": "partial",
  "conversation_id": "019d6446-56e6-7529-820e-e2ea51f232b5",
  "requested": {
    "input_transcription": false,
    "text": true,
    "audio": true
  },
  "completed": {
    "input_transcription": false,
    "text": true,
    "audio": false
  },
  "failures": {
    "audio": {
      "code": "output_audio_failed",
      "message": "语音生成失败"
    }
  },
  "usage": {
    "recording_ms": 5000,
    "input_tokens": 120,
    "output_tokens": 18,
    "output_audio_ms": null
  },
  "context": {
    "retained_turns": 2,
    "dropped_turns": 0
  }
}
```

要求：

- `request.done` 是成功或部分成功终态。
- `result` 只允许 `success` 或 `partial`。
- `requested` 原样回显 `request.accepted.response` 中的三个流开关。
- `completed` 表示对应流是否成功完成；未请求的流固定为 `false`。
- `success` 要求每个 requested 流都 completed，且 `failures={}`。
- `partial` 要求至少一个 Assistant 输出流成功完成，并且每个“已请求但未完成”的流都在 `failures` 中提供稳定 `code` 和可读 `message`。
- `failures` 中每个流的 `code` 和 `message` 必须严格等于此前为该流发送的
  `terminal=false` stream error；不得在终态中改写、概括或替换错误码。
- Assistant 的 partial 必须至少有一个助手输出流成功；输入转写单独成功不允许发送 `request.done`。Dictation 只有转写成功才能发送 success。
- 每个已请求且成功完成的流必须恰好发送一个对应 done，且 `finish_reason=stop`。
- 流的“开始”定义为：输入转写或助手文本已经发送首个 delta；助手音频已经发送 `output.audio.start`。
- 当请求仍继续并可能形成 partial 时，独立流在开始前失败只发送 `terminal=false` 的
  流级 `error`，不得为该流发送 done；开始后失败必须先发送该 error，再恰好发送一个
  `finish_reason=error` 的 done。请求级 terminal error、cancel、会话 fatal error 和
  断线直接截断未结束流，不要求补流级 error 或 done。
- 流失败后其他可用流继续处理；Assistant 至少一个助手输出流成功时，最后发送 `request.done(result=partial)`。
- 整个请求无法继续或没有任何可用结果时，后端发送 `terminal=true` 的请求级 `error`，不得再发送 `request.done`。
- `request.done` 后同请求事件均为迟到事件。
- 客户端可以继续播放已经缓存的音频。
- 后端不得在 payload 中加入上游请求 ID、URL 或内部错误堆栈。
- `request.done` 的必填字段、usage/context 空值和 conversation 原子提交规则见 [`request-lifecycle.md`](./request-lifecycle.md) 与 [`conversations.md`](./conversations.md)。

## 15. 取消、打断与对话

### 15.1 `request.cancel`

沿用版本 1：

```json
{
  "v": 2,
  "type": "request.cancel",
  "event_id": "019d6451-621b-7cf2-b598-f4ed71097d43",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945631500,
  "payload": {"reason": "user_interrupted"}
}
```

`reason` 可取：

- `user_cancelled`
- `user_interrupted`
- `client_timeout`
- `network_congestion`
- `protocol_error`

客户端可以在 `starting` 或任意已接受但尚未终态的状态发送 cancel。后端必须按 WebSocket 消息顺序处理 `request.start` 和随后的 cancel；即使尚未发送 `request.accepted`，也必须以该请求 ID 的 `request.cancelled` 或请求级 `terminal=true` error 给出明确终态，不得在 cancel 之后补发 `request.accepted`。

后端必须：

- 立即停止向客户端发送新的文本和音频。
- 取消或中止对应的生成处理工作。
- 在 `server.hello.timeouts.cancel_stop_target_ms` 目标内停止新增输出。
- 在 `server.hello.timeouts.cancel_timeout_ms` 内发送合法终态。通常为 `request.cancelled`；如果取消到达前请求已经完成，可以发送 `request.done` 或请求级 `terminal=true` 的 `error`。
- 屏蔽与已取消请求关联的迟到数据。

取消与完成存在竞态。客户端发送 cancel 后必须接受旧请求的任意合法终态，不得只等待 `request.cancelled`。`request.done` 先到达时，客户端记录 `cancel_raced_with_completion` 诊断，但仍可继续启动打断后的新请求。

### 15.2 `request.cancelled`

以下示例表示取消的是 confirmed conversation 中的新请求；新建对话的 provisional 请求取消时 `conversation_id` 为 `null`。

```json
{
  "v": 2,
  "type": "request.cancelled",
  "event_id": "019d6451-8d05-7def-92ba-fead16dfec74",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945631580,
  "payload": {
    "reason": "user_interrupted",
    "conversation_id": "019d6446-56e6-7529-820e-e2ea51f232b5"
  }
}
```

要求：

- `request.cancelled` 是取消终态。
- `conversation_id` 的类型为 UUID/null。复用 confirmed conversation 时返回原 ID；新建对话只有 provisional ID 且请求被取消时，后端删除该空对话并返回 `null`。
- 发送后不得再产生该请求的文本或音频。
- 客户端收到 `request.cancelled`、`request.done` 或请求级 `terminal=true` 的 `error` 中任一合法终态后，才可以发送下一条 `request.start`；本地打断录音可以更早开始。
- 版本 2 以 `request.done` 作为本次请求内容写入对话上下文的唯一确认点。`request.cancelled` 或请求级终态 error 不得把本次请求的用户输入、部分文本或未发送结果写入对话上下文；新建请求的 provisional ID 必须丢弃，更早 confirmed 的轮次不受影响。

### 15.3 播放中启动新请求

版本 2 仍保持单活跃请求约束：

#### 15.3.1 旧请求尚未终态

1. 用户触发打断时，客户端立即停止本地播放。
2. 客户端立即启动本地录音，把用户已经开始说的内容暂存在内存预缓冲区。
3. 客户端向旧请求发送 `request.cancel(reason=user_interrupted)`。
4. 等待旧请求的任意合法终态：`request.cancelled`、`request.done` 或请求级 `terminal=true` 的 `error`。等待目标为 `server.hello.timeouts.cancel_stop_target_ms`，最多等待 `server.hello.timeouts.cancel_timeout_ms`；期间继续录音，但不得使用旧 request ID 上传新语音。
5. 旧请求进入终态后，客户端创建新 request ID；Pipeline 的
   `continuation_after_interruption` 为 `supported` 或 `unvalidated` 且旧请求已有 confirmed
   conversation 时复用其 ID；该能力为 `unsupported` 或只有 provisional ID 且未 done 时
   发送 `conversation_id=null`。
6. 收到新请求的 `request.accepted` 后，客户端先按录制顺序发送预缓冲区中的 PCM 帧，再继续发送实时录音帧。
7. 新请求的第一帧 sequence 必须从 `0` 开始，`timestamp_us` 必须以用户开始本次打断录音的时刻为流起点。

客户端不得在旧请求仍活跃时发送新的 `request.start` 或音频。

#### 15.3.2 旧请求已终态但本地仍在播放

后端发送 `output.audio.done` 和请求终态后，本地播放器仍可能有尚未播放的缓存。用户在此期间触发打断时：

1. 客户端立即停止并清空旧请求的本地播放缓存。
2. 客户端立即启动录音并写入内存预缓冲区。
3. 客户端不得向已经终态的旧 request ID 发送 `request.cancel`。
4. 若上一连接仍在保温期内，客户端可以复用；若已经因 client/server idle close 关闭，则立即建立新连接并完成 hello。正常空闲关闭不妨碍继续对话。
5. Pipeline 的 `continuation_after_interruption` 为 `supported` 或 `unvalidated` 时，客户端
   使用已由旧请求 `request.done` 确认的 conversation ID 和新的 request ID 发送
   `request.start`；为 `unsupported` 时发送 `conversation_id=null`。
6. 收到新请求的 `request.accepted` 后，客户端先发送预缓冲 PCM，再继续发送实时录音帧；sequence 和 timestamp 规则与 15.3.1 相同。

若所选 Pipeline 使用后端对话上下文，`request.done` 表示上一条完整助手回复已经提交到该上下文。即使用户尚未听完本地缓存，新请求延续的也是完整回复后的上下文；版本 2 不按本地播放位置截断或回滚后端上下文。

打断预缓冲要求：

- 预缓冲只保存在内存，不得写入磁盘或日志。
- 预缓冲容量必须至少覆盖 `server.hello.timeouts.cancel_timeout_ms + server.hello.timeouts.request_accept_timeout_ms + client_safety_margin_ms`。
- `client_safety_margin_ms` 是客户端本地值，默认 1000 ms，不由后端协商。按示例超时计算为 `2000 + 2000 + 1000 = 5000 ms`；16 kHz 单声道 PCM16 约占 160 KiB。
- 对 15.3.2 的已终态分支，如果复用现有连接，理论下限为 `server.hello.timeouts.request_accept_timeout_ms + client_safety_margin_ms`；如果连接已经关闭，则同时受第 7.3 节冷启动预缓冲上限约束。
- 达到容量上限时必须终止本次打断并提示用户重试，不得静默丢弃最早样本。
- 取消确认超过 `server.hello.timeouts.cancel_timeout_ms` 时，客户端关闭当前连接并把旧请求标记为失败；不得把预缓冲音频错误地发送给旧请求。
- 新请求启动失败时必须丢弃预缓冲音频，不得自动重试上传。
- 后端只需保证快速取消和明确终态，不需要同时处理两个活跃请求。
- 打断只由快捷键或按钮显式触发，不定义自动检测路径。
- 当前能力是回合制中止，不是全双工对话。旧响应终止前，客户端只能在本地预缓冲新语音，不能同时向后端上传第二条实时音频流。
- 没有客户端显式打断动作时，后端不得自动取消响应。

### 15.4 对话清除

对话清除不要求实时响应，不占用 WebSocket。客户端使用 `DELETE /v2/conversations/{conversation_id}`，具体见 [`HTTP_API_V2.md`](./HTTP_API_V2.md)。

客户端不得在该对话存在活跃请求时删除；后端必须校验对话归属当前用户。
完整生命周期、active lease 与删除竞态见 [`conversations.md`](./conversations.md)。

## 16. 错误

### 16.1 `error`

`error` 只允许由后端发送给客户端。客户端不得使用该消息类型报告本地异常、未知服务端消息、背压或解析失败。

```json
{
  "v": 2,
  "type": "error",
  "event_id": "019d6453-23d2-7cf4-a641-a7927d18cbdc",
  "request_id": "019d6446-00f1-7d73-9385-943cb7707eb5",
  "sent_at_ms": 1785945632500,
  "payload": {
    "code": "pipeline_unavailable",
    "message": "所选语音服务暂时不可用",
    "stage": "routing",
    "stream": null,
    "terminal": true,
    "retryable": true,
    "fatal": false,
    "retry_after_ms": 3000,
    "details": {}
  }
}
```

`stage` 可取：

- `session`
- `authentication`
- `authorization`
- `quota`
- `routing`
- `input`
- `transcription`
- `generation`
- `output`
- `protocol`

客户端只消费稳定错误码和可读消息。后端必须把上游错误转换成本协议错误，不得透传上游响应正文、堆栈、主机名或凭据。

错误状态字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `stream` | enum/null | `input_transcription`、`text`、`audio`；非流错误为 `null` |
| `terminal` | boolean | 是否终止当前 request ID；会话级错误固定为 `false` |
| `retryable` | boolean | 请求级终态错误是否允许在未提交 turn 的前提下，以新的 request ID 发起一次新的用户操作；不得自动重放录音 |
| `fatal` | boolean | 是否导致整个 WebSocket 会话不可继续；为 `true` 时随后关闭连接 |
| `retry_after_ms` | integer/null | 建议重试等待时间 |

`terminal`、`retryable`、`fatal` 表达不同语义，但合法组合必须满足第 16.3 节约束。
客户端不得把 `retryable=true` 理解成同一个请求可以恢复，也不得自动重放已提交
partial、已经发送过的录音或 `outcome_unknown` 请求。stream error 固定
`retryable=false`，因为当前请求仍在继续且版本 2 不支持单独重试输出流。

### 16.2 标准错误码

| code | stage | fatal | 说明 |
|---|---|---:|---|
| `authentication_required` | authentication | 是 | 缺少 Token |
| `authentication_failed` | authentication | 是 | Token 无效 |
| `authentication_expired` | authentication | 是 | Token 已过期 |
| `permission_denied` | authorization | 否 | 无 Pipeline、模型或账户级能力权限 |
| `quota_exceeded` | quota | 否 | 用户配额不足 |
| `rate_limited` | quota | 否 | 请求过于频繁 |
| `protocol_version_mismatch` | session | 是 | 无共同协议版本 |
| `transport_negotiation_failed` | session | 是 | 没有共同的必需输入格式或同一格式 ID 的编码含义不一致 |
| `pipeline_unavailable` | routing | 否 | Pipeline 暂不可用 |
| `capabilities_stale` | routing | 否 | request.start 使用的 HTTP capabilities revision 已过期 |
| `unsupported_pipeline` | routing | 否 | Pipeline 不存在或未开放 |
| `unsupported_model` | routing | 否 | 模型不存在或不适用于 Pipeline |
| `unsupported_feature` | routing | 否 | 请求了未协商能力 |
| `unsupported_inference_option` | routing | 否 | ASR、LLM 或 TTS 选项不存在或不适用于 Pipeline/mode |
| `unsupported_output_audio` | routing | 否 | 输出音频 ID 不存在或未协商 |
| `unsupported_language` | input | 否 | 识别语言不存在或未协商 |
| `request_already_active` | protocol | 否 | 已有活跃请求 |
| `request_not_found` | protocol | 否 | request ID 无效 |
| `invalid_message` | protocol | 视情况 | 消息字段无效 |
| `unsupported_message_type` | protocol | 否 | 未知消息类型 |
| `invalid_audio_frame` | protocol | 视情况 | 二进制帧格式、方向、阶段或关联错误；按下方矩阵决定请求级/会话级 |
| `audio_sequence_error` | input | 否 | 上行音频序号或时间戳错误；下行错误由客户端本地关闭，不反向发 error |
| `input_too_long` | input | 否 | 录音超限 |
| `input_empty` | input | 否 | 没有有效音频 |
| `input_idle_timeout` | input | 否 | accepted 后等待首帧或相邻输入帧连续空闲超时 |
| `input_statistics_mismatch` | input | 否 | commit 统计与已接收音频不一致 |
| `request_accept_timeout` | routing | 否 | 后端未能在请求接受期限内完成校验或路由 |
| `input_commit_timeout` | input | 否 | 后端未能在输入确认期限内完成 commit 校验 |
| `transcription_timeout` | transcription | 否 | Dictation 转写未在期限内完成 |
| `generation_timeout` | generation | 否 | Assistant 未在首输出期限内产生任何已请求输出 |
| `output_audio_timeout` | output | 否 | 已请求音频未在首音频期限内产生首个 PCM 帧 |
| `request_timeout` | routing | 否 | 请求超过总时限 |
| `transcription_failed` | transcription | 否 | 输入转写失败 |
| `generation_failed` | generation | 否 | 助手生成失败 |
| `output_audio_failed` | output | 否 | 音频输出失败 |
| `voice_not_found` | authorization | 否 | 音色不存在或无权访问 |
| `voice_not_ready` | routing | 否 | 音色仍在处理或处理失败 |
| `voice_not_selectable` | routing | 否 | 音色存在但当前不可用于生成 |
| `emotion_reference_not_found` | authorization | 否 | 情绪参考不存在、未 ready 或无权访问 |
| `conversation_not_found` | authorization | 否 | 对话不存在或无权访问，不区分两种情况 |
| `conversation_active` | routing | 否 | 同一 conversation 已在另一请求或连接中 active；版本 2 不排队 |
| `conversation_configuration_mismatch` | routing | 否 | 对话绑定的 Pipeline 或上下文模型与本请求不一致 |
| `upstream_unavailable` | routing | 否 | 后端当前无法取得推理能力 |
| `server_error` | session | 视情况 | 未分类后端错误 |

`upstream_unavailable` 只表达业务能力暂不可用，不得携带上游服务身份或网络地址。

错误状态组合是协议的一部分，不能由后端按实现临时选择。除下方特殊场景矩阵外，固定
规则如下：

| code 分组 | scope | terminal | retryable | fatal |
|---|---|---:|---:|---:|
| `authentication_*`、`protocol_version_mismatch`、`transport_negotiation_failed` | session | false | false | true |
| `permission_denied`、`quota_exceeded`、`unsupported_*` | request | true | false | false |
| `request_already_active`、`request_not_found` | request | true | false | false |
| `audio_sequence_error`、`input_too_long`、`input_statistics_mismatch` | request | true | false | false |
| `voice_not_found`、`voice_not_selectable`、`emotion_reference_not_found` | request | true | false | false |
| `conversation_not_found`、`conversation_configuration_mismatch` | request | true | false | false |
| `rate_limited`、`pipeline_unavailable`、`capabilities_stale`、`voice_not_ready`、`conversation_active`、`upstream_unavailable` | request | true | true | false |
| `input_empty`、请求阶段的 `*_timeout`、请求级 `*_failed` | request | true | true | false |
| `transcription_failed|transcription_timeout|request_timeout` 且 `stream=input_transcription` | stream | false | false | false |
| `generation_failed|generation_timeout|request_timeout` 且 `stream=text` | stream | false | false | false |
| `output_audio_failed|output_audio_timeout|request_timeout` 且 `stream=audio` | stream | false | false | false |

Session scope 固定使用 `request_id=null/stream=null`；request scope 固定使用非空
`request_id`、`stream=null`；stream scope 固定使用非空 `request_id` 和表中指定的
`stream`。`retry_after_ms` 非空时 `retryable` 必须为 `true`；`rate_limited` 可以携带
该值，其他错误只有服务端能给出有意义等待时间时才携带。

`invalid_message` 和 `unsupported_message_type` 使用固定策略：握手阶段、无法解析合法
信封，或不存在可安全关联的 starting/active request 时，返回 session scope fatal
error 并以 `1002` 关闭；能够安全关联当前请求时，返回 request scope、
`terminal=true/retryable=false/fatal=false`，终止该请求但连接可以复用。
`server_error` 的 scope 取决于能否安全关联请求；一旦确定 scope，仍必须遵守第 16.3
节的不变量。`server_error` 为 session
scope 时固定 fatal 并以 `1011` 关闭；为 request scope 时固定 terminal、非 fatal，
客户端可以用新 request ID 重试。`invalid_audio_frame` 只使用下方专用矩阵。

以下容易产生实现分叉的场景固定使用这些状态组合：

| 场景 | code / stage | request_id | terminal | retryable | fatal | 后续行为 |
|---|---|---|---:|---:|---:|---|
| accepted 前收到可解析且指向 starting 请求的 `INPUT_PCM` | `invalid_audio_frame` / protocol | 该请求 | true | false | false | 终止该 starting 请求，连接可复用 |
| commit 后又收到当前请求的 `INPUT_PCM` | `invalid_audio_frame` / protocol | 当前请求 | true | false | false | 终止请求，不开始或继续推理 |
| 二进制帧损坏到无法安全取得 request ID，或帧不属于任何 starting/active 请求 | `invalid_audio_frame` / protocol | null | false | false | true | 尽力发送 error 后以 `1002` 关闭 |
| JSON/Binary Message 超过协商上限 | 不要求先发送 error | 按能否安全关联决定 | 按能否安全关联决定 | false | true | 以 `1009` 关闭；若有活跃请求则由断线隐式失败 |
| accepted 后等待首帧或帧间空闲到期 | `input_idle_timeout` / input | 当前请求 | true | true | false | 终止请求并释放槽位 |
| 同一用户的同一 confirmed conversation 已被其他请求持有 lease | `conversation_active` / routing | 新请求 | true | true | false | 不 accepted、不排队；新 request ID 可稍后重试 |

能安全关联到当前请求、但 magic、version、kind、flags、长度、payload 对齐、方向或
request ID 不合法的其他输入帧，统一使用请求级 `invalid_audio_frame`，默认
`terminal=true/retryable=false/fatal=false`。序号和时间戳不连续仍使用
`audio_sequence_error`。服务端不得在同一错误上任意选择 `invalid_message`。

### 16.3 错误后的请求状态

- `request.accepted` 前的请求级错误必须为 `terminal=true`；它不创建活跃请求，客户端按 `retryable` 决定是否使用新 request ID 重试。
- `request.accepted` 后的 `terminal=true` 错误是请求终态，后端不得再发送该请求的业务事件或 `request.done`。
- `terminal=false` 用于独立流失败，且当时已有其他 Assistant 输出成功，或其他已请求
  流仍可能产生可用结果的情况；Assistant 最终至少一个助手输出流成功时发送
  `request.done(result=partial)`，否则改以请求级 `terminal=true` error 结束且不发送
  `request.done`。Dictation 转写失败时直接以请求级 terminal error 结束。
- 请求级错误的 `request_id` 非空；若 `fatal=true`，则 `terminal` 必须同时为 `true`，发送后按第 17 节关闭连接。
- 会话级错误的 `request_id=null` 且 `terminal=false`；`fatal=true` 表示发送错误后必须按第 17 节关闭连接。如果当时存在活跃请求，连接关闭使该请求隐式失败，不要求再补请求级终态事件。
- 会话级 `fatal=false` 错误不关闭连接；客户端可以继续处理当前请求和会话。
- 客户端收到错误时只展示后端提供的稳定消息，不拼接内部 details 给普通用户。

### 16.4 未知消息类型

- 后端收到未知客户端消息类型时返回 `unsupported_message_type`。能安全关联当前
  starting/active request 时必须终止该请求但保持连接；否则必须作为会话级 fatal
  error 并以 `1002` 关闭。后端不得自行选择非终态的 request scope 组合。
- 客户端收到未知服务端消息类型时，不得反向发送 `error`，并将其记录为本地 `protocol_error`。
- 若当时存在活跃请求且连接仍可写，客户端应该先尽力发送 `request.cancel(reason=protocol_error)`，但不等待取消终态；随后以 WebSocket `1002` 关闭连接。该路径是第 15 节“发送 cancel 后等待终态”规则的明确例外。
- 若不存在活跃请求或消息已经使状态无法可靠解析，客户端直接以 `1002` 关闭连接。连接关闭由后端负责传播到内部任务。

## 17. WebSocket 关闭码

| code | 含义 |
|---:|---|
| `1000` | 正常关闭，包括客户端 `client_idle` 和服务端 `idle_timeout` |
| `1002` | WebSocket 或消息协议错误 |
| `1008` | 鉴权、权限或策略拒绝 |
| `1009` | 消息过大 |
| `1011` | 后端内部错误 |
| `4001` | 握手超时 |
| `4002` | 协议版本不兼容 |
| `4003` | 鉴权失败或过期 |
| `4004` | 心跳超时 |
| `4008` | 配额或速率限制 |

fatal 场景的关闭码固定映射如下，不得在 `1008` 与私有关闭码之间随机选择：

| 场景 | 关闭码 |
|---|---:|
| hello 时限到期 | `4001` |
| `protocol_version_mismatch` | `4002` |
| `authentication_required`、`authentication_failed`、`authentication_expired` | `4003` |
| 心跳超时 | `4004` |
| 握手阶段配额或速率拒绝 | `4008` |
| `transport_negotiation_failed`、未知消息或协议状态损坏 | `1002` |
| 消息超过协商上限 | `1009` |
| session scope `server_error` | `1011` |

`1008` 只保留给没有上述稳定映射的其他策略拒绝。

上游连接中断不得直接使用上游关闭码关闭客户端连接。后端应优先把它转换为请求级错误；只有整个会话无法继续时才关闭客户端连接。

没有 starting/活跃请求时收到 `1000/client_idle` 或 `1000/idle_timeout` 属于预期状态，
不是连接故障。客户端不得为此安排后台重连。活跃请求期间收到任何关闭都会终止本地
实时请求；协议不允许自动重放录音。客户端在发送 `input.commit` 后、收到终态前断线
时，结果为本地 `outcome_unknown`，并按 [`conversations.md`](./conversations.md) 放弃
复用相关 conversation ID。

## 18. 超时规范

| 阶段 | 起点 | `server.hello.timeouts` 字段 | 示例值 |
|---|---|---|---:|
| 请求接受 | `request.start` | `request_accept_timeout_ms` | 2000 ms |
| 输入帧空闲 | `request.accepted` 或最近有效 `INPUT_PCM` | `input_idle_timeout_ms` | 10000 ms |
| 输入确认 | `input.commit` | `input_commit_timeout_ms` | 2000 ms |
| Dictation 转写完成 | `input.committed` | `dictation_completion_timeout_ms` | 10000 ms |
| Assistant 首输出 | `input.committed` | `assistant_first_output_timeout_ms` | 15000 ms |
| Assistant 首音频 | `input.committed` | `assistant_first_audio_timeout_ms` | 30000 ms |
| 请求总时长 | `input.committed` | `request_total_timeout_ms` | 120000 ms |
| 停止新增输出目标 | `request.cancel` | `cancel_stop_target_ms` | 200 ms |
| 取消终态确认 | `request.cancel` | `cancel_timeout_ms` | 2000 ms |
| 连接业务空闲 | hello 完成或最近请求终态 | `connection_idle_timeout_ms` | 30000 ms |

Assistant 首输出的计时终点是 `assistant.text.delta`、`assistant.text.done` 或 `output.audio.start` 中最先到达者，不等待输入转写。Assistant 首音频的计时终点是第一条 `OUTPUT_PCM` 二进制帧；它必须晚于对应的 `output.audio.start`。

`server.hello.timeouts` 的值是本连接的实际协议期限，不是提示值；客户端和后端均必须使用它们。后端可以根据用户套餐和当前部署在握手时返回与示例不同的 `limits` 和 `timeouts`，但不得在连接存续期间无通知修改或缩短。

计时器启用条件与超时行为：

| 计时器 | 启用条件 | 后端到期行为 | 客户端到期行为 |
|---|---|---|---|
| 请求接受 | 每个 `request.start` | 返回请求级 `terminal=true` 的 `request_accept_timeout`，不得再 accepted | 发送 `request.cancel(reason=client_timeout)`；即使尚未 accepted 也合法 |
| 输入帧空闲 | 每个 accepted 后尚未 commit 的请求；每帧重置 | 返回请求级 `terminal=true` 的 `input_idle_timeout` | 发送 `request.cancel(reason=client_timeout)` |
| 输入确认 | 每个 `input.commit` | 返回请求级 `terminal=true` 的 `input_commit_timeout` | 发送 `request.cancel(reason=client_timeout)` |
| Dictation 转写完成 | `mode=dictation` | 返回请求级 `terminal=true` 的 `transcription_timeout` | 发送 `request.cancel(reason=client_timeout)` |
| Assistant 首输出 | `mode=assistant` | 返回请求级 `terminal=true` 的 `generation_timeout` | 发送 `request.cancel(reason=client_timeout)` |
| Assistant 首音频 | `mode=assistant` 且 `response.audio=true` | 若已有其他 Assistant 输出成功，或其他 Assistant 输出仍可继续，则发送 `terminal=false/stream=audio` 的 `output_audio_timeout` 并按流失败规则继续；否则发送请求级 terminal error | 发送 `request.cancel(reason=client_timeout)` |
| 请求总时长 | 每个已经 `input.committed` 的请求 | 已有 Assistant 输出成功则关闭未完成流并 `request.done(partial)`；否则直接请求级 terminal `request_timeout` | 发送 `request.cancel(reason=client_timeout)` |
| 连接业务空闲 | 不存在 starting/活跃请求 | 以 `1000/idle_timeout` 关闭连接 | 可以更早以 `1000/client_idle` 关闭；不得因正常 idle close 自动重连 |

客户端因上述期限发送 cancel 后，必须继续等待任一合法请求终态，最多等待 `cancel_timeout_ms`；仍无终态时关闭连接并把请求标记为本地超时失败。后端自身的超时 error 与客户端 cancel 可能竞态，客户端必须接受最先到达的合法终态。

未满足启用条件的计时器不得启动。例如纯文本 Assistant 不启动首音频计时器，Dictation 不启动 Assistant 首输出或首音频计时器。已经由成功事件满足的首输出计时器不得因其他流仍未开始而再次触发。

仅在总超时发生前已有 Assistant 输出成功时，才按 partial 路径关闭未完成流。此时
遵守第 14 节的开始前/开始后规则：未开始流发送一次
`terminal=false` stream error；已开始流发送 stream error 后再发送对应
`done(finish_reason=error)`。这些 stream error 固定使用 `code=request_timeout`、
`stage=routing`、目标 `stream`、`terminal=false/retryable=false/fatal=false`；partial 的
failure 条目必须回显相同 code/message。如果已有 Assistant 输出成功，最后必须是
`request.done(result=partial)`；该 partial 规则优先于本表中通用的请求级超时错误。
没有任何 Assistant 输出成功时直接发送请求级 terminal `request_timeout`，不再补流级
error 或 done。

## 19. 背压与资源限制

沿用当前客户端实现：

- `bufferedAmount >= 256 KiB`：标记网络拥塞。
- 持续拥塞超过 2 秒：发送 `request.cancel(reason=network_congestion)`。
- `bufferedAmount > 1 MiB`：立即停止发送，并在连接仍可写时发送相同 cancel。
- `audio_backpressure` 只作为客户端本地诊断码；线上 cancel reason 使用 `network_congestion`，客户端不得向后端发送 `error` 消息。

后端必须同时限制：

- 每用户连接数。
- 每用户活跃请求数。
- JSON 和二进制消息大小。
- 单次录音、生成文本、输出音频和对话上下文长度。
- 上游并发与排队时间。

配额与限制必须使用稳定错误码对客户端表达，不得把内部队列或上游容量数据直接暴露。

## 20. 完整时序

### 20.1 Native Audio Assistant 成功流程

```text
Client                         MindSurf Backend
  |       user starts recording         |
  |       buffer PCM locally            |
  | ===== WebSocket Upgrade ==========> |
  | --- client.hello ----------------> |
  | <-------------- server.hello ----- |
  | --- request.start ---------------> |
  | <----------- request.accepted ----- |
  | --- buffered INPUT_PCM frames ----> |  sequence=0...
  | --- live INPUT_PCM frames --------> |
  | --- input.commit ----------------> |
  | <------------ input.committed ----- |
  | <--------- output.audio.start ----- |
  | <---------- OUTPUT_PCM frames ----- |
  | <------ assistant.text.delta ------ |
  | <------- assistant.text.done ------ |
  | <--------- output.audio.done ------ |
  | <------------- request.done ------- |
```

### 20.2 Cascade Dictation 成功流程

```text
Client                         MindSurf Backend
  |       reuse or open connection      |
  | --- request.start ---------------> |
  | <----------- request.accepted ----- |
  | --- INPUT_PCM frames ------------> |
  | --- input.commit ----------------> |
  | <------------ input.committed ----- |
  | <------ input.transcript.delta ---- |
  | <------- input.transcript.done ---- |
  | <------------- request.done ------- |
```

### 20.3 Assistant 无输入转写流程

```text
Client                         MindSurf Backend
  | --- request.start ---------------> |  input_transcription=false
  | <----------- request.accepted ----- |
  | --- INPUT_PCM frames ------------> |
  | --- input.commit ----------------> |
  | <------------ input.committed ----- |
  | <--------- output.audio.start ----- |
  | <---------- OUTPUT_PCM frames ----- |
  | <------ assistant.text.delta ------ |
  | <------- assistant.text.done ------ |
  | <--------- output.audio.done ------ |
  | <------------- request.done ------- |
```

客户端不得等待不存在的 `input.transcript.done`。文本和音频仍可交错，图中顺序只是一个合法示例；若请求只选择其中一种输出，必须完整省略另一条流的 start/delta/done 事件。

### 20.4 活跃请求播放中打断

```text
Client                         MindSurf Backend
  | <---------- OUTPUT_PCM frame ------ |
  |       stop local playback           |
  |       start local recording         |
  |       buffer interruption PCM       |
  | --- request.cancel --------------> |
  |       keep buffering locally        |
  | <-------- any terminal event ------- |  cancelled / done / terminal error
  | --- new request.start ------------> |  same conversation_id when continuation is supported/unvalidated
  | <------- new request.accepted ------ |
  | --- buffered INPUT_PCM frames ----> |  new request_id, sequence=0...
  | --- live INPUT_PCM frames --------> |
```

### 20.5 请求终态后的本地播放打断

```text
Client                         MindSurf Backend
  | <--------- output.audio.done ------ |
  | <------------- request.done ------- |
  |       keep playing cached PCM       |
  |       user interrupts playback      |
  |       stop and clear local playback |
  |       start and buffer recording    |
  | ===== open WebSocket if needed ===> |
  | --- client.hello if new ----------> |
  | <------ server.hello if new ------- |
  | --- new request.start ------------> |  no cancel; ID reuse follows continuation capability
  | <------- new request.accepted ------ |
  | --- buffered INPUT_PCM frames ----> |  new request_id, sequence=0...
  | --- live INPUT_PCM frames --------> |
```

## 21. 兼容与扩展

### 21.1 版本规则

- v1 使用 `/v1/voice/ws` 和 `mindsurf.voice.v1`。
- v2 使用 `/v2/voice/ws` 和 `mindsurf.voice.v2`。
- v2 保留 v1 的通用信封和音频头布局，但版本字节必须为 `2`。
- 客户端不得根据 URL 自动降级；协议降级必须由明确服务档案或用户选择触发。
- 新增可选字段不增加主版本。
- 改变必填字段、事件终态或二进制布局必须增加主版本。

### 21.2 能力协商

能力分为两层：

- HTTP `GET /v2/capabilities` 是业务能力和候选目录的权威来源，包括不透明 Pipeline ID、Pipeline kind、mode、功能、模型、ASR/LLM/TTS、语言和默认业务选择。
- HTTP `GET /v2/voices` 是音色、可选性和情绪资源的权威来源。
- WebSocket hello 只协商当前连接的输入/输出音频格式、limits、timeouts 和 heartbeat，不返回或覆盖业务目录。

客户端构造请求时必须同时满足 HTTP 业务目录和本连接 hello 的传输约束。例如 Pipeline/模型来自 HTTP，而 `response.output_audio` 只来自 server hello。后端在每个 `request.start` 时重新校验最新权限、能力和资源状态；若 HTTP 缓存已经过期，使用稳定错误拒绝，客户端刷新 HTTP 后以新 request ID 重试。

推理服务具备某能力，不代表后端必须向所有客户端或所有用户开放。

### 21.3 未知字段

接收方必须忽略未知非关键 payload 字段。未知消息类型属于协议错误，必须按第 16.4 节的方向性规则处理。

## 22. 安全要求

- 客户端只能连接用户配置或应用信任的 MindSurf 后端。
- 非开发模式的连接必须使用 TLS。开发模式可以显式使用无 TLS 的 HTTP/WS 连接本地或非本地开发后端，但不得携带生产凭据或敏感数据。
- 客户端 Token 只用于后端鉴权，不得转发给推理服务。
- 后端必须验证 Token、用户状态、请求权限、模型权限、对话归属和配额。
- 客户端不得持有上游 API Key、推理服务 Token 或内部服务地址。
- Token、音频正文、完整转写和完整回复默认不得写入日志。
- `error.details` 不得包含凭据、原始音频、上游响应正文、内部主机名或堆栈。
- 后端必须防止用户通过 `conversation_id` 访问其他用户的上下文。
- 后端必须限制消息大小、录音时长、连接数、请求速率和输出长度。
- 取消和断线必须向后端内部生成任务传播，避免继续消耗推理资源。

## 23. 客户端实现检查表

- [ ] 只配置和连接 MindSurf 后端地址。
- [ ] 不保存或发送上游推理服务凭据。
- [ ] 非开发模式拒绝 HTTP/WS；开发模式显式开启后允许 WS 连接本地或非本地开发地址，且不携带生产凭据或敏感数据。
- [ ] 在建立实时连接前通过 HTTP 获取 Pipeline、模型、组件、语言、默认选择和音色；设置页不依赖 WebSocket。
- [ ] 请求 `mindsurf.voice.v2` 子协议。
- [ ] HTTP 与 `client.hello` 始终携带 Bearer Token；本地开发使用专用开发 Token，不进入匿名分支。
- [ ] hello 不发送或期待业务目录；校验 `server.hello` 的协议版本、输入/输出格式交集、limits、timeouts 与 heartbeat。
- [ ] 按 HTTP capabilities 的 Pipeline kind + mode 校验默认选择及 model/ASR/LLM/TTS/音频空值规则；不从 Pipeline ID 或候选分布推断 kind。
- [ ] 在 request.start 携带构造请求所用的 capabilities revision；过期时刷新目录并使用新 request ID。
- [ ] 分别按 `outputs.*.supported` 决定输出是否可请求，文本非流式时接受无 delta 的 done。
- [ ] 根据 HTTP 候选的 `pipelines` 和 `modes` 过滤模型及 ASR/LLM/TTS 选择，不根据名称推断兼容性。
- [ ] 只显示当前用户有权使用的 Pipeline、模型、音色和情绪。
- [ ] 默认按用户动作建立 WebSocket；允许显式预连接和请求后的短时复用，但不要求应用全程常驻。
- [ ] 冷启动时立即本地录音并使用有界内存预缓冲；accepted 前不上传，容量不足时显式失败。
- [ ] v2 二进制帧 version 字节为 `2`。
- [ ] 收到非法或乱序下行音频时不发送 `error`，按 protocol_error/1002 路径关闭连接。
- [ ] 等待 `request.accepted` 后才发送 PCM。
- [ ] 将新建请求 accepted 返回的 `conversation_id` 保存为 provisional，只在 `request.done` 后提升为 confirmed；取消、失败或断线时丢弃 provisional ID。
- [ ] Dictation 和 `features.conversation=false` 的 Assistant 始终发送并接收 `conversation_id=null`。
- [ ] 复用 conversation 前校验 Pipeline 与上下文模型绑定；配置改变或打断连续能力为 unsupported 时明确开始新对话。
- [ ] Assistant 不再强制等待输入转写再处理输出。
- [ ] 文本和音频流可以独立、交错到达。
- [ ] 识别流级 error 后，按该流是否已开始决定等待 error done 或不等待 done。
- [ ] stream error 固定 `retryable=false`；partial、已上传录音和 `outcome_unknown` 均不自动重放。
- [ ] 接受没有 text delta、`last_sequence=null` 的 `assistant.text.done`。
- [ ] `output.audio.start.format_id` 与 accepted 候选一致后再按实际格式初始化播放器。
- [ ] 输入转写 revision 从 0 严格递增，并按 Unicode code point 处理稳定前缀。
- [ ] Pipeline 不支持输入转写时不请求该能力。
- [ ] Dictation 只使用支持输入转写的 Pipeline。
- [ ] 普通 cancel 后立即停止本地播放并等待终态；未知服务端 type 的协议错误路径除外。
- [ ] 为每个协商超时按启用条件启动计时器，到期后 cancel；取消终态仍超时则关闭连接。
- [ ] 本地仍在播放但旧请求已终态时，不发送 cancel，直接以新 request ID 启动下一请求。
- [ ] 打断时立即开始本地录音，取消确认期间以内存预缓冲保存开头语音。
- [ ] 预缓冲容量按 hello 的取消超时、请求接受超时和本地安全余量计算；示例配置为 5 秒且溢出不静默丢帧。
- [ ] 打断只由快捷键或按钮触发，不实现自动插话判断。
- [ ] 预缓冲音频只在新请求 accepted 后使用新 request ID 发送。
- [ ] 打断新请求从 sequence 0 和本次录音起点时间戳开始。
- [ ] 断线后不自动重放录音。
- [ ] 请求终态后可以主动 idle close；收到 `client_idle` 或 `idle_timeout` 正常关闭后不安排后台重连。
- [ ] `conversation_id` 可以跨按需连接延续，`session_id` 不得跨连接复用。
- [ ] 不向后端发送 `error`；未知服务端 type 按 protocol_error/1002 流程处理。
- [ ] 日志不记录 Token、音频正文或上游信息。

## 24. 后端兼容性检查表

- [ ] Upgrade 时只选择 `mindsurf.voice.v2`。
- [ ] 第一条客户端业务消息只接受 `client.hello`。
- [ ] 未知或非法客户端消息能关联当前请求时以 request terminal error 结束；不能关联时
  以 session fatal error 和 `1002` 关闭，不由实现临时选择。
- [ ] 在握手阶段完成客户端鉴权与音频传输格式协商，不在 hello 中复制 HTTP 业务目录。
- [ ] 在 `server.hello` 中返回完整、合法且连接期间不变的 limits 与 timeouts。
- [ ] hello 的 `limits.max_recording_ms` 覆盖当前 capabilities revision 中全部可用 Pipeline
  的最大录音上限，不依赖客户端尚未发送的 Pipeline 选择。
- [ ] 不向客户端返回上游 URL、Token、内部会话 ID 或原始事件。
- [ ] 将所有上游协议转换为 v2 控制消息和二进制 PCM。
- [ ] 先校验 capabilities revision，再按不透明 Pipeline ID 查找同 revision 的 kind，并据此校验模型、组件、音色、情绪、对话归属和用户权限。
- [ ] `request.accepted` 严格回显 start 的业务选择；不能满足时返回错误，不通过 accepted 改写选择。
- [ ] accepted 回显 language 和分通道 generation；`max_recording_ms` 严格等于 HTTP
  Pipeline 能力值且不超过 hello 上限，超限按精确样本数判断。
- [ ] accepted 前校验 request.start 的 capabilities revision，过期时返回 capabilities_stale。
- [ ] 按 Pipeline/voice emotion_control 矩阵校验 emotion；preset 枚举和 reference ready
  状态都来自最新 voice 资源。
- [ ] accepted 后启用输入帧空闲计时器；零帧结束走 cancel，已提交静音才使用 `input_empty`。
- [ ] 同一用户的同一 confirmed conversation 跨所有连接只允许一个 active lease；冲突请求不排队。
- [ ] `request.accepted` 前完成音色与情绪参考校验并建立不可变请求快照。
- [ ] `request.accepted` 前不接受音频。
- [ ] `input.commit` 后不接受该请求的更多输入帧。
- [ ] Assistant 输出不依赖输入转写完成。
- [ ] 文本与音频各自遵守 sequence 和 done 语义。
- [ ] 已开始流失败时严格按 error → done(error) 顺序结束；开始前失败不发送该流 done。
- [ ] 上游音频统一转换为协商的客户端格式。
- [ ] 成功或部分成功请求以带 `requested/completed/failures` 的 `request.done` 结束。
- [ ] 收到取消后以任一合法请求终态结束，并屏蔽该终态后的迟到数据。
- [ ] 取消和断线传播到内部推理任务。
- [ ] 每个协议超时按第 18 节返回对应稳定错误并进入规定终态或流失败状态。
- [ ] 上游错误转换为稳定错误码并完成脱敏。
- [ ] 执行用户级连接、请求、配额和速率限制。
- [ ] 无 starting/活跃请求达到连接空闲期限时以 `1000/idle_timeout` 关闭，心跳不得延长业务空闲期限。
- [ ] 对话上下文按用户隔离并支持 HTTP 删除。
- [ ] provisional conversation 在取消、失败或断线后清理；confirmed conversation 的新轮次只在 `request.done` 前原子提交。

## 25. 联调验收用例

1. 客户端直接配置推理服务地址时，产品配置校验拒绝或明确标记为非受支持。
2. Upgrade 未选择 `mindsurf.voice.v2`，客户端拒绝连接。
3. `client.hello` 缺少 Token，后端返回 `authentication_required`。
4. Token 无效或过期时使用不同稳定错误码。
5. Token 不出现在 URL、日志、错误详情和关闭原因。
6. HTTP capabilities 只返回当前用户有权使用的 Pipeline、模型与组件，WebSocket hello 不重复这些目录。
7. 任一 Pipeline + mode 的默认选择不存在、不适用或违反空值规则时，客户端拒绝使用该 HTTP capabilities 响应，不需要建立 WebSocket 才能发现问题。
8. `server.hello.timeouts` 缺失、含非正数或违反字段间约束时，客户端拒绝握手。
9. 后端返回上游 URL、内部主机名或上游 Token 的测试必须失败。
10. v1 信封发送到 v2 连接，后端返回版本错误。
11. 二进制音频 version 不是 2，后端拒绝该帧。
12. `request.accepted` 前发送音频，后端返回协议错误。
13. 无权使用模型时返回 `permission_denied`，不发起上游请求。
14. Pipeline 不支持 Dictation 时拒绝 Dictation 请求。
15. Pipeline 不支持输入转写时拒绝相应 feature 请求。
16. Native Assistant 不返回输入转写，客户端仍正常处理文本和音频。
17. 助手音频早于文本到达，客户端正常播放。
18. 助手文本早于音频到达，客户端正常显示。
19. 只有文本输出的 Assistant 请求正常完成。
20. 只有音频输出的 Assistant 请求正常完成。
21. Dictation 只返回输入转写，不返回助手输出。
22. 后端把上游 Base64 或 codec 音频转换为 v2 PCM 二进制帧。
23. 下行格式来自 `output.audio.start.format_id` 且与 accepted 候选匹配，客户端不根据模型名猜测。
24. 输入转写 delta 从 revision 0 开始、使用完整快照，稳定前缀按 Unicode code point 计算且不可回退或改写。
25. 文本 delta 和音频帧序号分别严格递增。
26. 每个成功流及每个已经开始的失败流恰好一个 done；开始前失败的流没有 done。
27. 单流开始前失败只发非终态 stream error；开始后失败严格先 error 再 `done(finish_reason=error)`；Assistant 至少一个助手输出流成功时才能最终 `request.done(result=partial)`。
28. `request.done` 后的上游迟到事件被后端丢弃。
29. cancel 后在 hello 的 `cancel_stop_target_ms` 目标内不再产生客户端输出。
30. cancel 后在 hello 的 `cancel_timeout_ms` 内收到 `request.cancelled`、`request.done` 或请求级终态错误；cancel 与完成竞态不会卡死客户端。
31. cancel 确实停止后端内部推理任务。
32. 用户打断时客户端立即开始录音，取消确认期间的开头语音未丢失。
33. 预缓冲音频未使用旧 request ID 上传。
34. 新请求 accepted 后，预缓冲帧先于实时帧发送且 sequence 从 0 连续递增。
35. 预缓冲按协商的 cancel timeout、request accept timeout 和客户端安全余量计算；示例 5 秒容量不足时显式失败，不静默丢弃开头样本。
36. 旧请求终态前发送新请求，后端返回 `request_already_active`。
37. 新建对话把 accepted 返回的 ID 标记为 provisional；只有收到 `request.done` 后才确认该 ID 并用于下一轮。
38. 其他用户的 `conversation_id` 只返回 `conversation_not_found`，不泄露资源存在性。
39. HTTP 删除对话后上下文清空且用户隔离不受影响。
40. 请求级 fatal error 同时为 terminal；会话级 fatal error 保持 `request_id=null/terminal=false` 并随后关闭连接。
41. 不支持的音色状态、情绪参考、输出格式、语言和级联选项分别返回协议规定的稳定错误码。
42. 上游连接失败转换为 `upstream_unavailable`，不透传上游关闭码。
43. 配额耗尽返回 `quota_exceeded`，不暴露内部容量数据。
44. 限流返回 `rate_limited` 和可选 `retry_after_ms`。
45. 单帧、单次录音、输出长度和会话连接数上限生效。
46. 客户端断线后后端取消对应内部任务并释放资源。
47. 心跳只保留一个未完成 ping，pong nonce 不匹配或超时会按规范处理；ping/pong 不延长连接业务空闲期限。
48. 二进制帧 UUID 使用规范文本字节序，消息总长受 `max_binary_bytes` 限制，时间戳与提交统计按样本数精确校验。
49. 持续发送拥塞时客户端发送 `request.cancel(reason=network_congestion)`，只在本地记录 `audio_backpressure`，不向后端伪造客户端 `error`。
50. 同一客户端可通过独立服务档案明确选择 v1 或 v2，不发生自动误判。
51. `request.done` 后本地仍在播放时触发打断，客户端不发送旧 request cancel，直接用保存的 conversation ID 启动新请求。
52. 上一请求已终态后的新请求沿用完整后端上下文，不按本地实际播放位置截断回复。
53. 后端收到未知客户端 type 时返回 `unsupported_message_type`；客户端收到未知服务端 type 时不发送 error，并以 protocol_error/1002 结束不兼容连接。
54. 未发送任何 `assistant.text.delta` 时，可以直接以 `assistant.text.done(last_sequence=null)` 成功完成文本流。
55. Assistant 首输出可由 text delta、text done 或 audio start 满足；首音频只由第一条 OUTPUT_PCM 满足。
56. 通过 HTTP 新建并 ready 的音色可直接用于下一次请求，hello 不存在音色快照；后端按最新状态重新校验。
57. 客户端收到乱序或损坏的 OUTPUT_PCM 时不反向发送 error，尽力 cancel 后以 1002 关闭连接。
58. HTTP capabilities 中每个模型及 ASR/LLM/TTS 候选的 Pipeline + mode 适用范围可被客户端机械校验，不兼容组合不会出现在默认选择中。
59. 请求接受、输入确认、Dictation、Assistant 首输出、Assistant 首音频和请求总时长分别触发规定的稳定错误及客户端 cancel 行为；未请求音频时不启动首音频计时器。
60. `starting` 状态可以取消；新建对话无论是否已分配 provisional ID，取消后都清理空对话并返回 `request.cancelled.conversation_id=null`；复用 confirmed 对话时返回原 ID。
61. 应用启动和浏览设置时只请求 HTTP，不建立 WebSocket；第一次录音触发按需建连。
62. 冷启动建连、握手和 accepted 期间的录音完整保存在有界内存预缓冲，accepted 后从 sequence 0 上传；容量耗尽时显式失败。
63. 请求终态后客户端立即关闭和短时复用两种策略均兼容；后端 idle timeout 正常关闭不会触发客户端后台重连。
64. 同一 `conversation_id` 可以在两个不同 `session_id` 的按需连接中连续使用。
65. client hello 没有共同输入格式或对同一格式 ID 给出不同编码含义时，后端发送会话级 fatal `transport_negotiation_failed` 并关闭连接。
66. 非开发模式配置 HTTP/WS 地址时客户端在发送请求或凭据前拒绝连接；显式开发模式可以通过 WS 连接非本地开发地址。
67. Dictation 和不支持 conversation 的 Assistant 在 start、accepted、done、cancelled 中都使用 `conversation_id=null`，且后端不创建上下文资源。
68. 新建 Assistant 请求 accepted 后取消、失败或断线时，provisional conversation 被清理；下一请求使用 `null`，不会复用空 ID。
69. 新建 Assistant 请求只有在 `request.done` 后才确认 conversation ID；普通下一轮与跨连接下一轮复用 confirmed ID。
70. 使用不同 Pipeline、原生 model 或级联 LLM 复用 conversation 时返回 terminal `conversation_configuration_mismatch`；voice、emotion、TTS 和输出格式可以按每轮重新选择。
71. Assistant 只有输入转写成功、所有助手输出失败时，以 terminal error 结束且不提交 turn；至少一个助手输出成功时才允许 partial。
72. accepted 严格确认 start 的业务选择并回显 language 与分通道 generation；后端不能替换 Pipeline、模型、组件、language、generation、voice、emotion 或输出格式。
73. accepted 后未收到首帧或相邻输入帧空闲达到 `input_idle_timeout_ms` 时，以固定 terminal error 释放请求；零帧用户结束录音走 cancel，提交非空静音才返回 `input_empty`。
74. 两个连接同时使用同一 confirmed conversation 时只有一个取得全局 lease；另一个收到 terminal/retryable `conversation_active`，不 accepted、不排队。
75. 请求总超时时若已有 Assistant 输出成功，未完成流按失败规则关闭并返回 partial；没有成功输出时才返回 terminal `request_timeout`。
76. 1–7 个 16 kHz 样本或其他按公式舍入为 0ms 的非空音频可以合法提交和完成，统计仍严格等于公式结果。
77. 同一 session 的重复 event ID 被静默忽略且不重放响应；request ID 在终态后也不得复用。
78. 本地开发 HTTP 和 WebSocket 同样要求专用开发 Token，不存在匿名 v2 分支。
79. accepted 的 `max_recording_ms` 严格等于请求所依据的 HTTP Pipeline 能力值；超过
    `floor(max_recording_ms * 16000 / 1000)` 个样本才触发 `input_too_long`。
80. 所有 stream error 都是 `retryable=false`；partial 终态不会触发录音或整个请求的自动重放。
81. 未知或非法客户端消息能关联当前请求时产生 request terminal error；不能关联时
    产生 session fatal error 并以 `1002` 关闭。
82. request.start 的 capabilities revision 过期时，后端在 accepted 前返回 terminal、
    retryable 的 `capabilities_stale`；accepted 必须原样回显当前请求 revision。
83. Pipeline 的文本/音频 supported 开关决定 response 请求合法性；文本非流式时只发送
    `assistant.text.done(last_sequence=null)`。
84. 显式打断后，continuation 为 supported/unvalidated 时复用 confirmed ID，为 unsupported
    时发送 null 开始新对话。
85. Pipeline ID 与 kind 不同、或多个 ID 共享同一 kind 时，客户端和后端先校验
    capabilities revision，再从同一快照取得 ID→kind 映射并按 kind 校验 selection；不得把
    `native_audio` 或 `cascade` 字面量当作特殊 ID。

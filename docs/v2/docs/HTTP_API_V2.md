# MindSurf Voice HTTP 接口协议

> 协议体系：MindSurf Voice API v2
> 规范名称：MindSurf Voice HTTP API
> 接口版本：2
> 文档状态：Draft
> 传输层：HTTPS（开发模式可以使用 HTTP）
> 同级实时传输规范：[`WS_PROTOCOL_V2.md`](./WS_PROTOCOL_V2.md)
> HTTP 机器契约：[`../openapi/openapi.yaml`](../openapi/openapi.yaml)

## 1. 文档目的

MindSurf Voice API v2 由两份同级、互补的规范共同组成：

| 规范 | 职责 | 生命周期 |
|---|---|---|
| 本文档：HTTP API v2 | 业务能力发现、资源查询与资源变更 | 独立请求；资源状态可以长期存在 |
| [`WS_PROTOCOL_V2.md`](./WS_PROTOCOL_V2.md)：WebSocket API v2 | 实时音频和增量结果传输、请求控制 | 按需连接；连接和请求状态是临时的 |

两份规范共同构成客户端与 MindSurf 后端之间的完整版本 2 接口，互为同级边界定义；任何一份都不是另一份的附带文档或上游实现协议。业务状态以 HTTP 资源为准，当前实时连接的传输状态以 WebSocket 协商为准。

本文档定义其中的 HTTP 部分，包括：

- Pipeline、模型、组件、语言和默认业务选择目录。
- 音色列表和质量状态。
- 用户音色克隆参考上传、异步处理、情绪参考版本和删除。
- 后端对话上下文删除。

Conversation 的创建、确认、复用、配置绑定和删除竞态由 [`conversations.md`](./conversations.md) 统一定义；本文档只定义其 HTTP 删除接口。

实时录音、流式文本、流式音频和请求取消由同级的 [`WS_PROTOCOL_V2.md`](./WS_PROTOCOL_V2.md) 定义。

客户端仍然只访问 MindSurf 后端。本接口不规定后端如何连接推理服务，也不向客户端暴露模型内部向量、音频码、上游凭据或上游接口。

能力边界参考 [`mindsurf-omni/docs/CAPABILITIES.md`](https://github.com/oscar030406/mindsurf-omni/blob/main/docs/CAPABILITIES.md)；该文档用于决定后端可以对客户端声明什么能力，不改变本协议的客户端—后端边界。

## 2. 通用约定

### 2.1 基础地址

```text
https://api.example.com
```

开发模式可以使用 HTTP origin，包括显式配置的非本地开发后端。例如：

```text
http://127.0.0.1:8000
```

本文档中的接口路径已经包含 `/v2`，客户端必须把路径拼接到上述 origin，不能重复生成 `/v2/v2/...`。

`GET /v2/capabilities` 返回的 `realtime.websocket_path` 必须是相对于当前业务后端 origin 的路径，不得包含其他 origin。客户端从 HTTPS origin 生成 `wss://` 地址，从 HTTP origin 生成 `ws://` 地址；不得跟随能力响应连接其他主机。

非开发模式下，客户端配置的业务后端 origin 必须使用 HTTPS，因而生成的 WebSocket 地址必须使用 WSS。开发模式必须由应用构建或启动配置显式启用，不得根据目标是否为 localhost 自动推断；开发模式可以使用 HTTP/WS 连接本地或非本地开发地址。

### 2.2 鉴权

所有 HTTP 请求，包括本地开发环境，均必须使用：

```http
Authorization: Bearer <access-token>
```

要求：

- HTTP 与 WebSocket 使用同一用户身份体系。
- v2 不提供匿名模式；本地开发环境必须使用专用开发 Token，不得省略鉴权。
- Token 不得出现在 URL、multipart 字段、日志或错误响应中。
- 后端必须校验音色和对话资源归属当前用户。
- 客户端不得向推理服务或其他 origin 发送该 Token。

### 2.3 JSON 信封

除 `204 No Content` 外，成功响应使用：

```json
{
  "request_id": "019d64c0-1f36-7f0d-a6ef-b18a03046f83",
  "data": {}
}
```

错误响应使用：

```json
{
  "request_id": "019d64c0-1f36-7f0d-a6ef-b18a03046f83",
  "error": {
    "code": "invalid_request",
    "message": "请求字段不符合要求",
    "details": {}
  }
}
```

后端生成的 `request_id` 只用于本次 HTTP 请求诊断，不等同于 WebSocket `request_id`。

### 2.4 幂等

创建或增加参考版本的请求必须携带：

```http
Idempotency-Key: <UUID>
```

同一用户使用相同 Key 重试时，后端必须返回原创建结果，不得重复创建音色或参考版本。

幂等键规则：

- 幂等范围按已鉴权用户隔离；不同用户可以使用相同 Key。
- 后端必须按以下规范元组生成请求指纹，不得直接散列 multipart 原始报文：大写 HTTP
  方法、规范化路径、按字段名排序的校验后普通字段、文件 part 的小写基础媒体类型，
  以及文件原始字节的 SHA-256。`name` 使用去除首尾 Unicode 空白后的 UTF-8 值；
  `emotion` 使用通过语法校验后的原值；`consent_confirmed` 固定为 ASCII `true`。
  multipart boundary、part 顺序、文件名、传输头顺序和媒体类型参数不参与指纹。
- 后端只有在鉴权、multipart 结构、普通字段语法、声明媒体类型、上传大小和资源前置
  条件等同步校验全部通过，且请求已经具备返回 `202 Accepted` 的条件时，才消费
  `Idempotency-Key`。同步校验失败以及在接受异步任务前返回的 4xx/5xx 不得创建或占用
  幂等记录，客户端修正请求后可以继续使用原 Key；修正后的请求仍按其自身指纹处理。
- 写入幂等记录和创建资源/异步任务必须位于同一原子串行化边界。两个相同用户、相同
  Key、相同指纹的请求并发到达时，只允许一个请求创建资源；另一个请求必须等待首个
  接受事务产生确定结果，然后按重放规则返回同一 `data`，不得重复创建，也不得仅因
  首个请求仍在执行就返回临时冲突。相同 Key、不同指纹仍固定返回
  `409 idempotency_key_reused`。
- 同一用户以相同 Key 和相同请求指纹重试时，固定返回 `202 Accepted`，并返回与首次
  接受响应相同的 `data`（包括同一资源 ID、`status=processing` 和首次声明的
  `poll_after_ms`）。即使资源后来已经 ready/failed，也不得在 POST 重放响应中改成
  当前资源快照；客户端必须用对应 GET 接口查询当前状态。
- 每次 HTTP 尝试必须生成新的诊断 `request_id`；幂等重放只复用响应的 `data`，不得
  复用首次 HTTP 请求的 `request_id`。
- 同一用户以相同 Key 提交不同请求指纹时，返回 `409 idempotency_key_reused`，不得执行新请求。
- 首次创建的资源已经被用户删除时，相同 Key 和相同指纹的重试返回 `409 idempotent_resource_deleted`；不得重新创建资源，也不得返回一个看似可轮询但实际已删除的 `202`。
- 幂等记录从首次成功写入接受事务起至少保留 24 小时。服务端可以声明更长保留期，但不得在保留期内复用 Key。

### 2.5 Multipart 字段编码与稳定 ID

本文档中的 multipart 普通字段统一按 UTF-8 文本编码：

- `consent_confirmed` 虽然语义类型为 boolean，线上字段值只允许小写 ASCII 文本 `true` 或 `false`；缺失、空值、`1`、`yes` 和其他拼写均视为无效参数。
- `name` 的长度按 Unicode code point 计算，不按 UTF-8 字节或 JavaScript UTF-16 code unit 计算。后端可以去除首尾 Unicode 空白，但不得对中间内容进行隐式改写；去除后仍必须满足长度限制。
- `emotion` 是稳定、区分大小写的资源 ID，版本 2 只接受正则 `^[a-z][a-z0-9_-]{0,31}$`。客户端不得发送显示名称，后端不得自动改变大小写或做同义词归一化。
- emotion 冲突与去重以通过上述校验后的完整 ID 精确匹配。
- 文件 part 必须携带 `Content-Type`。`accepted_content_types` 声明基础媒体类型；参数（例如 `codecs=opus`）可以携带，但后端是否接受仍取决于文件可解码性，客户端不得仅凭扩展名判断格式。

## 3. 业务能力目录

### 3.1 `GET /v2/capabilities`

这是 Pipeline、模型、级联组件、语言和默认业务选择的权威目录，用于设置页、请求参数构造和功能入口展示。WebSocket 握手独立协商当前连接的音频格式等传输参数。

响应示例：

```json
{
  "request_id": "019d64c1-d106-7abf-b8e0-0466bb832942",
  "data": {
    "protocol_version": 2,
    "revision": "cap_019d64c1",
    "realtime": {
      "websocket_path": "/v2/voice/ws",
      "subprotocol": "mindsurf.voice.v2"
    },
    "voice_cloning": {
      "supported": true,
      "asynchronous": true,
      "accepted_content_types": [
        "audio/wav",
        "audio/mpeg",
        "audio/mp4",
        "audio/webm"
      ],
      "min_reference_ms": 2000,
      "max_reference_ms": 10000,
      "recommended_reference_ms": 3000,
      "effective_reference_window_ms": 2000,
      "max_upload_bytes": 10485760,
      "emotion_reference_variants": true
    },
    "default_pipeline": "native_audio",
    "pipelines": [
      {
        "id": "native_audio",
        "kind": "native_audio",
        "name": "Omni 原生音频",
        "description": "端到端语音理解和语音生成",
        "modes": ["assistant"],
        "max_recording_ms": 120000,
        "features": {
          "input_transcription": false,
          "outputs": {
            "text": {"supported": true, "streaming": true},
            "audio": {"supported": true, "streaming": true}
          },
          "conversation": true,
          "turn_taking": "half_duplex",
          "interruption_trigger": "explicit_client_action",
          "continuation_after_interruption": "unvalidated",
          "voice_control": "reference_clone",
          "emotion_control": "reference_variant",
          "generation_controls": {
            "text": {
              "temperature": {"type": "number", "minimum": 0, "maximum": 2, "default": 0.7},
              "top_p": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.9},
              "max_output_tokens": {"type": "integer", "minimum": 1, "maximum": 4096, "default": 512}
            },
            "audio": {}
          },
          "validated_conversation_turns": 3
        }
      },
      {
        "id": "cascade",
        "kind": "cascade",
        "name": "级联语音",
        "description": "ASR、LLM 与 TTS 组合链路",
        "modes": ["dictation", "assistant"],
        "max_recording_ms": 120000,
        "features": {
          "input_transcription": true,
          "outputs": {
            "text": {"supported": true, "streaming": true},
            "audio": {"supported": true, "streaming": true}
          },
          "conversation": true,
          "turn_taking": "half_duplex",
          "interruption_trigger": "explicit_client_action",
          "continuation_after_interruption": "supported",
          "voice_control": "preset",
          "emotion_control": "preset",
          "generation_controls": {
            "text": {
              "temperature": {"type": "number", "minimum": 0, "maximum": 2, "default": 0.7},
              "top_p": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.9},
              "max_output_tokens": {"type": "integer", "minimum": 1, "maximum": 4096, "default": 512}
            },
            "audio": {}
          },
          "validated_conversation_turns": null
        }
      }
    ],
    "models": [{
      "id": "mindsurf-omni",
      "name": "MindSurf Omni",
      "description": "原生音频对话模型",
      "pipelines": ["native_audio"],
      "modes": ["assistant"]
    }],
    "inference_options": {
      "asr": [{
        "id": "cascade-asr-default",
        "name": "默认语音识别",
        "description": "后端当前默认 ASR",
        "pipelines": ["cascade"],
        "modes": ["dictation", "assistant"]
      }],
      "llm": [{
        "id": "cascade-llm-default",
        "name": "默认语言模型",
        "description": "后端当前默认 LLM",
        "pipelines": ["cascade"],
        "modes": ["assistant"]
      }],
      "tts": [{
        "id": "cascade-tts-default",
        "name": "默认语音合成",
        "description": "后端当前默认 TTS",
        "pipelines": ["cascade"],
        "modes": ["assistant"]
      }]
    },
    "recognition_languages": [{"id": "auto", "name": "自动检测"}],
    "default_selections": {
      "native_audio": {
        "assistant": {
          "model": "mindsurf-omni",
          "asr": null,
          "llm": null,
          "tts": null,
          "voice": "serena",
          "emotion": "neutral"
        }
      },
      "cascade": {
        "dictation": {
          "model": null,
          "asr": "cascade-asr-default",
          "llm": null,
          "tts": null,
          "voice": null,
          "emotion": null
        },
        "assistant": {
          "model": null,
          "asr": "cascade-asr-default",
          "llm": "cascade-llm-default",
          "tts": "cascade-tts-default",
          "voice": "cascade-default",
          "emotion": "neutral"
        }
      }
    }
  }
}
```

语义：

- `revision` 是当前用户能力目录的不透明版本。客户端必须把构造实时请求所用的 revision
  放入 `request.start.capabilities_revision`。后端当前 revision 不一致时返回 WebSocket
  `capabilities_stale`；客户端重新获取目录，不得解析 revision，并使用新 request ID 重试。
  收到 `unsupported_*`、`permission_denied`、`pipeline_unavailable` 或其他表明选择可能
  过期的错误后也必须重新获取。
- `voice_cloning.supported=false` 时，`asynchronous` 和 `emotion_reference_variants` 必须为 `false`，`accepted_content_types` 必须为空，所有时长与大小限制必须为 `null`；客户端隐藏创建及新增参考入口。
- Pipeline 的 `id` 是不透明业务配置 ID，只用于候选关联、默认选择和
  `request.start.pipeline` 引用，不携带类型语义；同一个 `kind` 可以存在多个不同 ID。
  `kind` 决定 WebSocket `selection` 的必填和空值规则，v2 当前固定为
  `native_audio` 或 `cascade`。客户端不得从 ID、名称、默认选择或候选分布推断 `kind`。
- `default_pipeline` 必须存在于 `pipelines`。`default_selections` 必须覆盖每个 Pipeline 支持的 mode，并按照该 Pipeline 的 `kind` 满足相应 model/ASR/LLM/TTS 与 voice/emotion 空值规则。
- 每个 Pipeline 的 `max_recording_ms` 是开始录音前即可获得的请求输入上限。客户端必须
  按该值限制本地采集和预缓冲；后端不得在 accepted 阶段临时缩短它。能力目录过期且
  当前上限已变化时，后端必须在 accepted 前以 `pipeline_unavailable` 拒绝，客户端刷新
  capabilities 后使用新的 request ID 重试。WebSocket hello 的连接上限必须覆盖当前
  revision 中所有可用 Pipeline 的该值最大值，不能依赖 hello 之后才会发送的 Pipeline
  选择。
- `default_selections` 不包含输入/输出音频格式；格式由每次 WebSocket hello 协商，客户端从当前连接候选中选择。
- `models` 与 `inference_options` 的候选必须通过非空 `pipelines` 和 `modes` 明确适用组合。客户端不得根据候选名称推断兼容性，也不得用候选是否存在反推 Pipeline `kind`。
- 实时交互语义按 Pipeline 声明，客户端不得把一个 Pipeline 的打断或多轮能力套用到另一个 Pipeline。
- `half_duplex` 表示回合制交互，不支持双方持续同时说话的全双工双流。
- `interruption_trigger=explicit_client_action` 表示只通过客户端快捷键或按钮打断，不提供自动插话判断。
- `outputs.text.supported` 和 `outputs.audio.supported` 分别决定 Assistant 是否允许请求
  `response.text=true` 和 `response.audio=true`；请求未支持的输出返回 WebSocket
  `unsupported_feature`。`outputs.text.streaming=false` 表示文本仅通过一次
  `assistant.text.done(last_sequence=null)` 返回，不发送 delta。版本 2 的音频输出只有流式
  PCM 形态，因此 `outputs.audio.supported=true` 时 `streaming` 必须为 `true`，不支持音频时
  两者都为 `false`。
- `continuation_after_interruption` 可取 `supported`、`unvalidated` 或 `unsupported`；前两者
  允许显式打断后继续沿用 confirmed conversation ID，其中 `unvalidated` 表示尚未验证连续
  对话质量；`unsupported` 要求打断后的下一请求发送 `conversation_id=null` 开始新对话。
- `validated_conversation_turns` 为正整数时表示能力验证只覆盖到该轮数，不代表硬性最大轮数；为 `null` 表示后端未声明已验证轮数，而不是不支持多轮。
- `features.conversation` 只对该 Pipeline 的 Assistant mode 生效。Dictation 永不创建或更新 conversation；值为 `false` 的 Assistant 请求也不使用 conversation。完整规则见 [`conversations.md`](./conversations.md)。
- `request.cancel` 是 WebSocket v2 的基础协议能力，不作为可选 Pipeline feature 出现在本目录；所有已接受请求都必须可取消。`interruption_*` 只描述用户打断交互及其上下文质量。
- `effective_reference_window_ms` 表示后端实际用于音色条件的有效参考窗口。客户端应该引导用户把最有代表性的声音放在录音结尾。
- `generation_controls` 按输出通道声明参数描述对象。每个参数必须包含 `type`、`minimum`、`maximum` 和 `default`；客户端按描述生成控件并在发送前校验，后端不得静默 clamp 越界值。空对象表示该通道没有公开参数。当前文本采样参数不构成音频情绪、语速或表现力旋钮。
- `generation_controls.text` 与 `generation_controls.audio` 是两个独立命名空间；即使未来
  出现同名参数，也分别通过 WebSocket `generation.text` 和 `generation.audio` 发送，
  不得合并为扁平对象。
- 版本 2 的 `recognition_languages` 是所有声明支持语音识别的 Pipeline、mode 及其
  ASR/model 候选的公共交集；目录中的每个语言必须适用于这些组合。若候选的语言集合
  不同，后端必须拆成不同 Pipeline，版本 2 不允许客户端通过提交失败来探测兼容性。
- 一个 Pipeline 的 `generation_controls` 只适用于该 Pipeline 的 `assistant` mode 及其
  model/LLM 候选。Dictation 不使用生成参数，即使同一 Pipeline 同时支持 Dictation 和
  Assistant，也必须在 Dictation 请求中省略 `generation`。每个 control 必须满足
  `minimum <= default <= maximum`；Assistant 候选参数能力不同时必须拆成不同 Pipeline。
- `generation.text` 只允许在 `response.text=true` 时发送，`generation.audio` 只允许在
  `response.audio=true` 时发送。省略整个 `generation` 表示使用能力目录声明的默认值；
  通道对象允许为空对象，表示该通道当前没有需要显式覆盖的公开参数。
- Voice 声明支持某 Pipeline，表示后端保证它能与该 Pipeline 下所有公开 TTS 路由组合
  使用。TTS 与 voice 的内部兼容和转换由后端负责，客户端不维护隐藏的组合矩阵。
- Voice 声明支持某 Pipeline 时，其 `emotion_control` 必须与该 Pipeline 的
  `features.emotion_control` 相同。`none` 固定使用 `emotion=null`；`preset` 和
  `reference_variant` 都从该 Voice 的 `supported_emotions` 选择，其中后者还必须对应
  ready reference。任何允许组合不得依赖未公开的情绪兼容表。
- `default_selections` 中的非空 voice 和 emotion 还必须能在 `GET /v2/voices` 的最新资源状态中解析；能力目录不替代音色资源接口。
- HTTP capabilities 不声明音频编码、采样率、连接 limits、timeouts 或 heartbeat；这些传输参数只由 WebSocket 协议和 hello 定义。后端在 `request.start` 时按最新业务能力、权限和资源状态重新校验，不能使用时返回稳定错误；客户端随后刷新 HTTP 目录。
- 版本 2 的音色克隆只定义异步处理，因此 `voice_cloning.supported=true` 时
  `asynchronous` 固定为 `true`；`supported=false` 时直接调用创建接口返回
  `403 permission_denied`。`emotion_reference_variants=false` 时客户端必须隐藏新增情绪参考
  入口，直接调用新增参考接口返回 `409 emotion_reference_variants_unsupported`。

## 4. 音色资源

### 4.1 资源结构

```json
{
  "id": "voice_019d64c4",
  "name": "我的音色",
  "source": "custom",
  "status": "ready",
  "quality_tier": "unverified",
  "selectable": true,
  "pipelines": ["native_audio"],
  "emotion_control": "reference_variant",
  "supported_emotions": ["neutral", "happy"],
  "base_reference_id": "ref_019d64c4a",
  "default_emotion": "neutral",
  "poll_after_ms": null,
  "failure": null,
  "emotion_references": [
    {
      "id": "ref_019d64c4a",
      "emotion": "neutral",
      "status": "ready",
      "speaker_verification": "baseline",
      "duration_ms": 3200,
      "effective_window_ms": 2000,
      "poll_after_ms": null,
      "failure": null,
      "created_at_ms": 1785946200000
    },
    {
      "id": "ref_019d64c8a",
      "emotion": "happy",
      "status": "ready",
      "speaker_verification": "matched",
      "duration_ms": 3500,
      "effective_window_ms": 2000,
      "poll_after_ms": null,
      "failure": null,
      "created_at_ms": 1785946300000
    }
  ],
  "created_at_ms": 1785946200000,
  "updated_at_ms": 1785946210000
}
```

字段定义：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 客户端提交给 WebSocket `response.voice` 的稳定 ID |
| `source` | enum | `builtin` 或 `custom` |
| `status` | enum | `processing`、`ready`、`failed` |
| `quality_tier` | enum | `verified`、`unverified`、`preview`、`disabled` |
| `selectable` | boolean | 当前是否允许用于生成 |
| `pipelines` | string[] | 可使用该音色的 Pipeline |
| `emotion_control` | enum | `none`、`preset`、`reference_variant` |
| `supported_emotions` | string[] | 当前音色已准备好的情绪 ID |
| `base_reference_id` | string/null | 自建 `reference_variant` 音色创建时的身份基准参考 ID；其他音色为 `null` |
| `default_emotion` | string/null | 客户端选择或重置到该音色时默认采用的 ready 情绪；不适用时为 `null` |
| `poll_after_ms` | integer/null | `status=processing` 时必须为正整数，其他状态为 `null` |
| `failure` | object/null | `status=failed` 时必须包含稳定 `code` 和脱敏 `message`，其他状态为 `null` |
| `emotion_references` | object[] | 当前用户可见的情绪参考资源摘要，包括处理中和失败项 |

质量规则：

- 普通客户端默认只展示 `selectable=true` 的音色。
- `status!=ready` 时 `selectable` 必须为 `false`；只有 `status=ready` 才可能可选。
- `quality_tier=preview` 或 `disabled` 时 `selectable` 必须为 `false`。
- 内置音色只有经过后端投放审核后才能标记 `verified` 和 `selectable=true`。
- 识别不稳定的内置音色必须为 `preview` 或 `disabled`，不得仅因为模型包中存在就投放。
- 用户自建音色默认是 `unverified`。客户端必须提示其效果未经人工认证。
- `quality_tier` 是分档，不是音色排名或连续分数。
- 对 `emotion_control=reference_variant` 的音色，`supported_emotions` 必须由 `emotion_references` 中所有 `status=ready` 的 emotion 推导；`preset` 音色由后端投放的预设枚举决定，`emotion_references` 可以为空。
- 新建自建音色处于 `processing` 时，`base_reference_id=null`、`default_emotion=null`、
  `supported_emotions=[]`。此时初始参考必须出现在 `emotion_references` 中，状态固定为
  `status=processing`、`speaker_verification=pending`；`pending` 只表示参考处理尚未形成
  最终一致性状态，不区分初始参考或后续新增参考。初始参考成功时，后端必须在同一原子
  转换中把它改为 `ready/baseline`，设置基准 ID、默认情绪并把该情绪加入
  `supported_emotions`；初始处理失败时三个字段仍分别保持 `null`、`null` 和空数组，
  参考转为 `failed/unverified`。
- 自建 `reference_variant` 音色创建成功后，初始参考同时成为不可变的 `base_reference_id` 和初始 `default_emotion`。`base_reference_id` 是后续参考一致性检查的身份锚点；修改默认情绪不得改变该锚点。
- 非空 `default_emotion` 必须存在于 `supported_emotions`；processing、failed 或不适用情绪
  的音色使用 `null`。它是客户端切换到该音色或重置其情绪选择时采用的资源默认值，
  不是 WebSocket 服务端的隐式补值，也不表示算法能够从录音自动识别情绪。客户端仍须
  在 `request.start` 中显式发送最终选择。
- capabilities 的 `default_selections` 决定 Pipeline 与 mode 的完整初始组合；用户随后切换到其他 voice 时，客户端使用该音色的 `default_emotion` 初始化情绪选择。
- 原生音频 Pipeline 中的 emotion 是用户提交的参考录音标签和选择键，不是独立情绪向量，也不表示连续情绪强度。每个可选情绪必须有该说话人对应的真实参考录音。

情绪参考的 `speaker_verification` 是参考与身份基准的一致性处理状态：

| 值 | 语义 |
|---|---|
| `baseline` | 创建音色时的身份基准参考；只允许用于 `base_reference_id` 指向的参考 |
| `pending` | 参考处理尚未形成最终一致性状态；所有 `status=processing` 的初始或新增参考固定使用该值 |
| `matched` | 后端使用其已验证的判定方法确认与身份基准一致 |
| `unverified` | 未运行检查、检查不可用、结果不确定，或参考因其他原因处理失败 |
| `mismatched` | 后端使用其已验证的判定方法明确判定不一致；必须同时为 `status=failed` 且 `failure.code=speaker_mismatch` |

`matched` 只表示当前后端的一致性检查结果，不构成现实身份认证。协议不返回原始相似度、阈值、内部向量或模型特征；这些数值不具备跨模型稳定语义。用户音色也不得仅因参考为 `matched` 自动升级为 `quality_tier=verified`。

当前 `mindsurf-omni` 交付的内置音色投放基线为：`serena`、`eric`、`uncle_fu`、`dylan`、`arthur`、`moon` 可以进入 `verified/selectable` 候选；其他随模型包存在但未达到投放门槛的音色必须保持 `preview` 或 `disabled`。该名单由后端数据维护，客户端不得硬编码。

### 4.2 `GET /v2/voices`

查询当前用户可见的内置和自建音色：

```http
GET /v2/voices?selectable=true
```

响应：

```json
{
  "request_id": "019d64c5-8dc0-781c-8b89-fdce43ac74fb",
  "data": {
    "items": []
  }
}
```

查询参数规则：

- `selectable` 省略时返回当前用户可见的全部音色；`true` 只返回可选择音色，`false` 只返回不可选择音色。其他值返回 `400 invalid_query`。
- 本接口不分页，一次返回筛选后的完整可见集合；版本 2 不接受 `limit` 或 `cursor`，携带
  未定义查询参数返回 `400 invalid_query`。
- 返回顺序固定为：内置音色在前并按 `id` 升序；自建音色在后并按 `created_at_ms` 降序、
  `id` 升序打破同时间戳并列。客户端可以按产品需要重新分组展示，但不得依赖未声明顺序。
- 后端必须设置有限的每用户自建音色配额；达到配额时创建接口返回现有的
  `429 quota_exceeded`，不得通过截断列表隐藏已有资源。

### 4.3 `POST /v2/voices`

创建用户音色，使用 `multipart/form-data`：

| 字段 | 类型 | 必须 | 说明 |
|---|---|---:|---|
| `name` | string | 是 | 用户可见名称，去除首尾 Unicode 空白后为 1–80 Unicode code point |
| `reference_audio` | file | 是 | 真实人物参考录音 |
| `emotion` | string | 是 | 该参考的情绪标签，通常为 `neutral` |
| `consent_confirmed` | boolean | 是 | 用户确认有权使用该声音 |

示例：

```http
POST /v2/voices
Authorization: Bearer <access-token>
Idempotency-Key: 019d64c6-b28d-73ca-bba7-ef450b05658f
Content-Type: multipart/form-data
```

后端接受后返回 `202 Accepted`：

```json
{
  "request_id": "019d64c6-b377-7438-9891-a2a9401679ce",
  "data": {
    "id": "voice_019d64c6",
    "status": "processing",
    "poll_after_ms": 1000
  }
}
```

要求：

- `consent_confirmed` 不为 `true` 时必须拒绝。
- 当前用户的 capabilities 声明 `voice_cloning.supported=false` 时返回
  `403 permission_denied`，不得接受异步任务。
- 后端必须检查文件类型、大小、可解码性、时长、有效语音和明显削波。
- 后端负责解码、重采样、声道转换和截取有效参考窗口。
- 客户端不得上传纯静音、合成测试音或未经授权的第三方声音。
- 参考音频原件的保留策略必须由隐私政策明确；协议响应不得返回存储路径。
- 情绪通过独立 `emotion` 字段提交，不得拼进文本或文件名。
- 初始参考处理成功后，其 reference ID 成为该音色不可变的 `base_reference_id`，其 emotion 成为初始 `default_emotion`，且 `speaker_verification=baseline`。
- multipart 结构、字段语法、授权确认、声明的媒体类型和上传大小在返回 `202` 前同步校验，分别使用规范规定的 400、415 或 413 错误。
- 解码、真实时长、有效语音、削波和模型处理属于异步校验；请求一旦返回 `202`，这些失败通过音色资源转为 `status=failed` 和稳定 `failure.code` 表达，不得把原 POST 事后改写成同步 422。

### 4.4 `GET /v2/voices/{voice_id}`

查询异步处理状态。`processing` 完成后转为：

- `ready`：可以按 `selectable` 使用。
- `failed`：不可使用，并返回脱敏的 `failure.code` 与 `failure.message`。

客户端必须遵守 `poll_after_ms`，不得高频轮询。

### 4.5 `PATCH /v2/voices/{voice_id}`

修改当前用户自建音色的可变元数据。版本 2 只支持修改客户端选择该音色时采用的默认情绪：

```http
PATCH /v2/voices/voice_019d64c6
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "default_emotion": "happy"
}
```

要求：

- 只允许音色所有者操作；其他用户的音色统一返回 `404 voice_not_found`。
- 版本 2 请求体必须且只能包含 `default_emotion`；缺失、`null` 或包含未知字段时返回 `400 invalid_request`。
- 目标 emotion 必须已有 `status=ready` 的参考并存在于 `supported_emotions`，否则返回 `409 default_emotion_unavailable`。
- 内置音色不可通过该接口修改，返回 `403 builtin_voice_immutable`。
- 修改必须原子生效，并更新 `updated_at_ms`；不得改变 `base_reference_id`、参考内容或当前已接受 WebSocket 请求的不可变快照。

成功返回 `200 OK` 和第 4.1 节定义的完整音色资源。

### 4.6 `POST /v2/voices/{voice_id}/references`

为已有自建音色增加另一份真实情绪参考。使用 multipart：

| 字段 | 类型 | 必须 | 说明 |
|---|---|---:|---|
| `reference_audio` | file | 是 | 同一说话人的真实录音 |
| `emotion` | string | 是 | 新情绪 ID |
| `consent_confirmed` | boolean | 是 | 再次确认授权 |

要求：

- 只允许音色所有者操作。
- 内置音色不能增加用户参考，返回 `403 builtin_voice_immutable`；其他用户资源仍返回 `404 voice_not_found`。
- 后端应将新增参考与 `base_reference_id` 指向的身份基准进行说话人一致性检查。检查是参考质量和风险信号，不是现实身份认证。
- 只有后端使用经过验证的判定方法得到明确不一致结果时，才能以 `speaker_verification=mismatched` 和 `speaker_mismatch` 拒绝。不得仅因原始相似度低、固定通用阈值未通过或结果不确定而拒绝。
- 未运行检查、检查能力不可用或结果不确定时，参考可以处理为 `ready`，但必须标记 `speaker_verification=unverified`；协议不要求人工审核，也不得把 `consent_confirmed` 当作同一说话人证明。
- 原生音频的情绪参考必须是真实录音，不得把中性参考通过信号处理伪造成情绪版本。
- emotion 由上传者作为业务标签提交；后端不承诺自动识别或提取录音情绪。
- 新参考处理完成前，不得把该 emotion 加入 `supported_emotions`。
- 同一 emotion 已存在时默认返回冲突；覆盖必须使用新的明确版本接口，不得静默替换。
- capabilities 声明 `emotion_reference_variants=false` 时返回
  `409 emotion_reference_variants_unsupported`，不得创建 reference 资源。
- 同一音色的不同 emotion 可以并行处理；同一 emotion 已存在或正在处理时返回 `409 emotion_reference_conflict`。
- multipart 结构、字段语法、授权确认、声明的媒体类型、上传大小和 emotion 冲突在返回 `202` 前同步校验。解码、时长、语音质量和 speaker verification 在接受后异步执行，失败通过 reference 的 `status=failed` 与稳定 `failure.code` 表达。

接受后返回 `202 Accepted`：

```json
{
  "request_id": "019d64c8-26cb-7835-a463-d490ac90b728",
  "data": {
    "voice_id": "voice_019d64c6",
    "id": "ref_019d64c8",
    "emotion": "happy",
    "status": "processing",
    "speaker_verification": "pending",
    "poll_after_ms": 1000
  }
}
```

### 4.7 `GET /v2/voices/{voice_id}/references/{reference_id}`

查询单个情绪参考的异步处理状态：

```json
{
  "request_id": "019d64c9-2e7a-7712-8bed-ce195bfb556f",
  "data": {
    "voice_id": "voice_019d64c6",
    "id": "ref_019d64c8",
    "emotion": "happy",
    "status": "ready",
    "speaker_verification": "matched",
    "duration_ms": 3500,
    "effective_window_ms": 2000,
    "poll_after_ms": null,
    "failure": null,
    "created_at_ms": 1785946300000,
    "updated_at_ms": 1785946304000
  }
}
```

`status` 为 `processing`、`ready` 或 `failed`。处理中响应必须包含 `poll_after_ms`；失败时 `failure` 包含脱敏的稳定错误码和消息。只有 `ready` 项才进入音色的 `supported_emotions`。新增参考从 `pending` 终结为 `matched`、`unverified` 或 `mismatched`；基础音频质量处理失败但未形成明确说话人结论时使用 `unverified`。

### 4.8 `DELETE /v2/voices/{voice_id}/references/{reference_id}`

删除当前用户的情绪参考：

- 成功返回 `204 No Content`，响应体必须为空。
- 删除后相应 emotion 必须从 `supported_emotions` 移除。
- `base_reference_id` 指向的身份基准不能单独删除，返回 `409 base_reference_required`；需要删除该参考时必须删除整个音色。
- 当前 `default_emotion` 对应的非基准参考不能删除，返回 `409 default_reference_required`。客户端可以先通过第 4.5 节把默认情绪切换到另一份 ready 参考，再重试删除。
- 同一参考既是身份基准又是当前默认时，必须优先返回 `base_reference_required`。
- 其他用户的参考统一返回 `404 emotion_reference_not_found`，不得泄露其存在性。
- 后端在 WebSocket `request.accepted` 时已经对所选音色和 ready 情绪参考建立不可变请求快照；删除不影响已接受请求，后续请求不得再选择该参考。
- 请求快照只能在该请求作用域内保留，必须在请求终态或连接关闭后释放；删除操作必须立即清除对应的持久资源及索引。

### 4.9 `DELETE /v2/voices/{voice_id}`

删除当前用户的自建音色：

- 成功返回 `204 No Content`。
- 删除同步完成，响应体必须为空；返回后查询该 ID 得到 `404 voice_not_found`。
- 内置音色不得由普通用户删除。
- 普通用户删除内置音色时返回 `403 builtin_voice_immutable`；该错误只说明请求中由当前用户可见的内置资源不可删除，不得用于泄露其他用户资源。
- 删除必须同时使该 voice ID 不再可选。
- 后端在 WebSocket `request.accepted` 时已经对所选音色和 ready 情绪参考建立不可变请求快照；正在使用该音色的已接受请求继续使用快照，后续请求不得继续选择该音色。
- 请求快照只能在该请求作用域内保留，必须在请求终态或连接关闭后释放。
- 后端应按隐私政策删除原始参考及派生数据。

## 5. 对话资源

### 5.1 `DELETE /v2/conversations/{conversation_id}`

清除当前用户的对话上下文：

Conversation 生命周期及 provisional/confirmed 状态见 [`conversations.md`](./conversations.md)。本接口只操作 confirmed conversation。

- 成功返回 `204 No Content`。
- 对话不存在或属于其他用户时同样返回 `204 No Content`，且不得执行删除。
- 后端必须先校验所有权，再判断 active 状态；只有当前用户自己的活跃对话返回 `409 conversation_active`。
- active 从后端原子接受一个引用该 conversation ID 的 `request.start` 开始，到该请求进入终态结束。请求接受与删除必须串行化：先取得 active lease 时 DELETE 返回 `409`；DELETE 先完成时 WebSocket 请求返回 `conversation_not_found`。
- `204` 响应体必须为空，三种 204 情况在状态码、响应头和耗时特征上不应形成可用于判断资源存在性的稳定差异。

该接口只删除后端管理的对话上下文，不删除本地客户端历史、音色或账户数据。
删除后的 ID 不得被当作空对话重新创建；后续 WebSocket 使用必须返回 `conversation_not_found`。

## 6. HTTP 状态码

| 状态码 | 使用场景 |
|---:|---|
| `200` | 查询成功 |
| `202` | 异步创建或参考处理已接受 |
| `204` | 删除成功 |
| `400` | 参数、音频或 multipart 无效 |
| `401` | 缺少、无效或过期鉴权 |
| `403` | Pipeline、模型或账户级能力已知但无使用权限；不得用于暴露其他用户资源 |
| `404` | 资源不存在，或为避免越权泄露而隐藏；对话 DELETE 按第 5.1 节统一返回 204 |
| `409` | 资源状态冲突 |
| `413` | 上传文件过大 |
| `415` | 音频类型不支持 |
| `422` | 保留给未来同步音频分析接口；本版本两个异步上传接口不返回 422 |
| `429` | 速率或配额限制 |
| `500` | 后端内部错误 |
| `503` | 当前能力暂不可用 |

HTTP error response code 与状态码的唯一映射以 [`openapi.yaml`](../openapi/openapi.yaml) 中的 `Error400` 至 `Error503` schema 为准，Markdown 不再复制维护第二份列表。
OpenAPI 还必须为每个 operation 使用收窄后的错误 union，不能因为状态码相同就允许该
操作返回其他资源域的错误。例如 conversation DELETE 的 409 只能是
`conversation_active`，不能返回任一幂等或音色参考冲突。

multipart 中 `consent_confirmed` 缺失、为 `false` 或使用 `true` 以外的任何线上文本值
统一返回 `400 consent_required`；其他字段缺失、类型或语法错误返回
`400 invalid_request`。

异步音频处理失败通过资源的 `failure.code` 表达，不是原 POST 的 HTTP error response。版本 2 至少定义：

- `invalid_reference_audio`
- `reference_too_short`
- `reference_too_long`
- `reference_has_no_speech`
- `reference_clipped`
- `speaker_mismatch`

## 7. 安全与隐私

- 声音参考属于敏感用户内容，必须在传输和静态存储时加密。
- 必须记录资源所有者、授权确认时间和删除状态，但不得在普通日志中记录音频正文。
- 客户端必须在上传前明确说明用途、保存期限和删除方式。
- 后端不得把用户自建音色暴露给其他用户。
- 对其他用户拥有的音色和情绪参考，查看、修改、删除均必须返回相应 `*_not_found`，不得用 `403` 暴露资源存在性。
- 对话删除对不存在和越权资源统一返回 `204`；其他对话操作若未来加入，必须另行定义一致的隐藏策略。
- 分享、公开发布或团队共享音色不在本版本范围内。
- 下载原始参考音频不在本版本范围内。
- 后端错误不得包含文件系统路径、内部向量、模型码、上游响应或堆栈。

## 8. 客户端检查表

- [ ] 能力入口先读取 `GET /v2/capabilities`。
- [ ] 所有 HTTP 请求始终携带 Bearer Token；本地开发使用专用开发 Token，不尝试匿名访问。
- [ ] Pipeline、模型、组件、语言和默认业务选择以 HTTP capabilities 为准；音频格式和连接期限只读取 WebSocket hello。
- [ ] 把 Pipeline `id` 作为不透明引用，并只按同 revision 中的 `kind` 构造和校验 selection；允许多个 ID 共享同一 kind。
- [ ] 只把 `realtime.websocket_path` 解析为当前业务后端的同源 WebSocket 地址。
- [ ] 音色列表默认只展示 `selectable=true`。
- [ ] 对 `unverified` 自建音色显示效果提示。
- [ ] 上传前取得明确授权确认。
- [ ] 情绪使用独立字段，不拼入文本。
- [ ] multipart boolean 使用小写文本 `true`/`false`，emotion ID 在上传前按稳定语法校验。
- [ ] 原生 `reference_variant` 只展示该音色已经 ready 的情绪。
- [ ] 将原生 emotion 解释为真实参考录音的标签和选择键，不展示连续强度，也不声称自动识别了情绪。
- [ ] 遵守异步处理的 `poll_after_ms`。
- [ ] 音色列表一次读取完整 `items`，不发送 limit/cursor，并正确处理稳定排序。
- [ ] 为创建音色和增加情绪参考生成并持久化 Idempotency-Key，重试时复用原 Key 与原请求内容。
- [ ] 幂等指纹使用校验后字段、基础媒体类型和文件原始字节摘要，不受 multipart boundary、part 顺序或文件名影响。
- [ ] 情绪参考按 reference ID 轮询；删除后同步清理该 emotion 的本地状态。
- [ ] 区分不可变的身份基准和可修改的默认情绪；删除当前默认的非基准参考前先切换默认情绪。
- [ ] 对 `speaker_verification=unverified` 显示适当的一致性提示，不把 `matched` 展示为现实身份认证。
- [ ] 音色或情绪参考删除后不影响已经 accepted 的请求，但新的请求立即停止使用已删资源。
- [ ] 删除后清理本地缓存的 voice ID。
- [ ] 只对 confirmed conversation 调用删除；成功后清理本地 ID，`conversation_active` 时等待请求终态后再重试。

## 9. 联调验收用例

1. capabilities 为每个 Pipeline 分别返回半双工与显式客户端动作打断能力。
2. capabilities 为各 Pipeline 分别返回已验证对话轮数；`null` 不解释为不支持多轮，正整数不当作硬上限。
3. `realtime.websocket_path` 包含其他 origin 时客户端拒绝连接；HTTPS/HTTP origin 分别只转换为 WSS/WS；非开发模式拒绝 HTTP/WS，开发模式允许 WS 连接本地或非本地开发地址。
4. 音色列表默认不返回或不展示 disabled 音色。
5. 内置音色只有审核通过者为 verified/selectable。
6. 自建音色创建返回 202，并可轮询到 ready 或 failed。
7. 缺少授权确认时创建请求被拒绝。
8. 过短、过长、静音、削波或不支持格式得到稳定错误码。
9. 相同用户以相同 Idempotency-Key 和内容重试始终返回 202 与首次接受时相同的 data，
   但每次生成新的 HTTP request_id；资源当前状态只通过 GET 查询。资源已删除时返回
   `idempotent_resource_deleted` 且不复活资源。
10. 自建音色 ready 前不能用于 WebSocket 请求。
11. 创建成功后，初始参考成为 `base_reference_id` 和初始默认情绪，且其 `speaker_verification=baseline`。
12. 增加情绪参考时始终以 `base_reference_id` 为一致性比较基准；修改默认情绪不改变该基准。
13. 情绪参考 POST 返回独立 reference ID，可轮询到 ready 或 failed；processing 时校验状态为 pending，ready 前不出现在 supported_emotions。
14. 一致性检查未运行、不可用或不确定时参考可 ready，但标记 unverified；只有经过验证的方法明确判定不一致时才以 mismatched 和 `speaker_mismatch` 失败。
15. 原生 `reference_variant` 把 emotion 作为真实参考的标签和选择键，不接受数值情绪强度，也不承诺自动识别录音情绪。
16. PATCH 只能把默认情绪改为已有 ready 参考；修改成功不改变身份基准和已 accepted 请求快照。
17. 其他用户查看、修改或删除音色、参考时只得到相应 404 `*_not_found`。
18. 删除普通非默认情绪参考返回空响应体的 204，并同步移出 supported_emotions。
19. 删除身份基准返回 `base_reference_required`；删除当前默认的非基准参考返回 `default_reference_required`，切换默认情绪后可以删除后者。
20. 删除自建音色同步返回空响应体的 204，随后查询为 `voice_not_found`，新请求无法继续选择。
21. 删除已被 accepted 请求使用的非默认情绪参考或整个音色不影响该请求快照，但后续请求无法选择已删资源。
22. 普通用户不能删除或修改内置音色。
23. 删除不存在或其他用户的对话统一返回空响应体的 204，并且不执行删除。
24. 后端先校验对话所有权；只有当前用户自己的活跃对话返回 `conversation_active`。请求接受和删除通过 active lease 串行化，不出现已删除对话仍被 accepted 的竞态。
25. 相同用户复用 Idempotency-Key 但改变字段或文件内容时返回 `idempotency_key_reused`；24 小时保留期内不得复用。
25a. 只改变 multipart boundary、part 顺序、文件名、传输头顺序或媒体类型参数时，规范
     指纹保持相同；改变校验后字段、基础媒体类型或文件原始字节时指纹改变。
26. Token、音频正文和内部派生数据不出现在日志或错误响应中。
27. Pipeline、模型和音色目录不从 hello 获取；音频编码、limits、timeouts 和 heartbeat 不从 HTTP capabilities 获取。
28. multipart 中 `consent_confirmed=true` 按文本解析；`1`、`yes`、空值及大小写变体被拒绝。
29. emotion ID 的长度、字符集和大小写规则在创建、增加参考和修改默认情绪接口中一致，冲突按完整 ID 精确判断。
30. voices 不接受 limit/cursor；非法 selectable 或任一未定义查询参数返回
    `invalid_query`，结果完整且按内置 ID、自建创建时间和 ID 稳定排序。
31. 普通用户删除或修改当前可见的内置音色返回 `403 builtin_voice_immutable`；其他用户资源仍按隐藏存在性规则返回 404。
32. capabilities 的 revision 变化或 WebSocket 返回候选过期类错误后，客户端刷新 HTTP 目录并重新校验本地选择。
33. 应用启动和设置浏览只依赖 HTTP capabilities 与 voices，不要求建立 WebSocket。
34. 删除 confirmed conversation 后，后续 WebSocket 使用旧 ID 返回 `conversation_not_found`，不会以相同 ID 创建空对话。
35. capabilities 中每个 generation control 都包含类型、上下限和默认值；越界值被拒绝而不是静默 clamp。
36. capabilities 中每个 Pipeline 都包含正整数 `max_recording_ms`，客户端在开始录音前即可确定请求上限。
37. 本地开发 HTTP 和 WebSocket 均使用专用开发 Token，不存在匿名 v2 调用。
36. multipart 结构、授权、媒体类型和大小同步拒绝；解码、时长、语音质量与 speaker verification 在 202 后通过资源 failed 状态表达。
38. `voice_cloning.supported=true` 时 `asynchronous` 固定为 true；能力关闭时直接创建返回
    `permission_denied`，情绪参考版本关闭时新增参考返回
    `emotion_reference_variants_unsupported`。
39. processing/failed 的初始自建音色保持 `base_reference_id=null`、
    `default_emotion=null`、`supported_emotions=[]`；ready 转换同时原子设置三个字段。
40. capabilities 可以返回 `id=omni-production, kind=native_audio`，也可以返回两个不同
    ID、相同 `kind=cascade` 的 Pipeline；客户端均按 kind 而不是 ID 字面量构造 selection。

# MindSurf Voice API v2

本目录是 MindSurf Voice API v2 冻结版的统一规范入口。

```text
v2/
├── docs/          浏览器授权、额度、长期连接、请求状态和设计语义
├── openapi/       HTTP API 的 OpenAPI 3.1 契约
├── schemas/       WebSocket JSON 消息及共享类型的 JSON Schema
└── test-vectors/  JSON 正反例和输入音频二进制固定向量
```

## 产品边界

v2 只提供两种单轮模式：

- `asr_only`：ASR；
- `asr_llm`：ASR 后执行 LLM，作为一个完整流程。

两种模式都流式更新客户端临时文本区域：ASR 可以在录音期间返回增量和修订，asr_llm
还会在 ASR 完整结果后流式返回 LLM 文本。每个阶段都通过全量 snapshot 收口。只有最终
snapshot 和 `request.done` 都收到后，客户端才把临时文本一次性写入真实目标。

HTTP 通过系统浏览器和 PKCE 完成授权，并提供用户、额度、用量、能力发现和一次性 WS
ticket。客户端取得 Token 后立即建立 WebSocket，并在应用可用期间通过心跳保持长期连接；
录音请求复用该连接。注册、验证和账户恢复由浏览器认证站点处理。

v2 不包含 Assistant、多轮 Conversation、TTS、下行音频、音色或情绪能力。

## 通信协议概览

### 登录与初始化

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Client as 桌面客户端
    participant Browser as 系统浏览器
    participant HTTP as HTTP API

    alt 首次登录或需要重新认证
        User->>Client: 发起登录
        Client->>Browser: 打开 authorize（state + PKCE challenge）
        Browser->>HTTP: 登录、注册或账户恢复
        HTTP-->>Browser: 302 回跳自定义协议
        Browser-->>Client: Authorization Code + state
        Client->>HTTP: POST /v2/auth/token（code + verifier）
        HTTP-->>Client: access token + refresh token + user
    else 已有 refresh token
        Client->>HTTP: POST /v2/auth/refresh
        HTTP-->>Client: 轮换后的 token pair + user
    end

    par 加载账户状态
        Client->>HTTP: GET /v2/users/me
        HTTP-->>Client: 当前用户
    and 加载额度
        Client->>HTTP: GET /v2/quota
        HTTP-->>Client: 额度与累计用量
    and 加载能力目录
        Client->>HTTP: GET /v2/capabilities
        HTTP-->>Client: revision、Pipeline 与默认选择
    end
```

### WebSocket 建连与请求

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Client as 桌面客户端
    participant HTTP as HTTP API
    participant WS as WebSocket API
    participant Target as 文本目标

    Client->>HTTP: POST /v2/realtime/tickets
    HTTP-->>Client: 一次性 ticket + websocket_path + subprotocol
    Client->>WS: Upgrade（ticket，mindsurf.voice.v2）
    Client->>WS: client.hello
    WS-->>Client: server.hello（音频格式、心跳与限制）

    loop 登录可用期间保持长期连接
        WS-->>Client: session.ping
        Client->>WS: session.pong

        opt 用户发起一次语音请求
            Client->>WS: request.start（mode、Pipeline、revision、selection）
            WS-->>Client: request.accepted（录音上限与额度预留）
            loop 录音期间
                Client->>WS: INPUT_PCM 二进制帧
                WS-->>Client: ASR delta / 修订 snapshot（可选）
            end
            Client->>WS: input.commit
            WS-->>Client: input.committed
            WS-->>Client: 完整 ASR snapshot

            alt asr_only
                Note over WS,Client: ASR snapshot 为 final=true
            else asr_llm
                WS-->>Client: 空 LLM snapshot（切换 stage）
                WS-->>Client: LLM delta（可选）
                WS-->>Client: LLM final snapshot
            end

            WS-->>Client: request.done（final_text + usage）
            Client->>Target: 一次性写入最终文本
        end
    end

    opt 连接异常中断
        Note over Client,WS: 活跃请求不恢复、不重放
        Client->>HTTP: 申请新 ticket
        Client->>WS: 建立新的长期连接
    end
```

## 权威来源

| 内容 | 权威来源 |
|---|---|
| HTTP 路径、状态码和字段 | `openapi/openapi.yaml` |
| WS JSON 信封和 payload | `schemas/` |
| 输入音频二进制布局、连接和时序 | `docs/WS_PROTOCOL_V2.md` |
| 请求成功、降级、取消和断线 | `docs/request-lifecycle.md` |
| 跨语言固定输入 | `test-vectors/` |

## 文档入口

- [HTTP API v2](./docs/HTTP_API_V2.md)
- [WebSocket API v2](./docs/WS_PROTOCOL_V2.md)
- [Request 生命周期](./docs/request-lifecycle.md)
- [后端接入与交接](./docs/backend-integration.md)
- [OpenAPI](./openapi/openapi.yaml)
- [WebSocket Schemas](./schemas/README.md)
- [测试向量](./test-vectors/README.md)

v2 契约已于 2026-08-17 冻结。改变 mode、必填字段、HTTP 或 WebSocket public API、消息格式、
终态语义、鉴权方式或二进制布局均属于不兼容变更，必须提升主版本。

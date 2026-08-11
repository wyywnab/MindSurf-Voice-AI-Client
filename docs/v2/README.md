# MindSurf Voice API v2

本目录是 MindSurf Voice API v2 的统一规范入口。

```text
v2/
├── docs/          语义、生命周期、时序、设计边界和实现说明
├── openapi/       HTTP API 的机器可验证契约
├── schemas/       WebSocket JSON 消息及共享数据类型的 JSON Schema
└── test-vectors/  跨语言 JSON 反例与二进制固定向量
```

## 规范分工

同一个约束只保留一个权威定义，其他位置通过链接引用：

| 内容 | 权威来源 |
|---|---|
| HTTP 路径、方法、参数、状态码和请求/响应结构 | `openapi/` |
| WebSocket JSON 信封和 payload 字段结构 | `schemas/` |
| WebSocket 二进制帧布局 | `docs/WS_PROTOCOL_V2.md` 与固定测试向量 |
| Conversation、请求、取消、超时和部分成功语义 | `docs/` |
| 产品能力边界及为什么这样设计 | `docs/` |

Markdown 中的 JSON 示例用于解释，不应成为独立的数据结构定义。字段类型、必填性、枚举、空值和数值范围应落入 OpenAPI 或 JSON Schema。

## 当前文档

- [HTTP API v2](./docs/HTTP_API_V2.md)
- [WebSocket API v2](./docs/WS_PROTOCOL_V2.md)
- [Conversation 生命周期](./docs/conversations.md)
- [Request 生命周期与流完成语义](./docs/request-lifecycle.md)
- [后端仓库接入与交接](./docs/backend-integration.md)
- [HTTP OpenAPI 3.1 契约](./openapi/openapi.yaml)
- [HTTP OpenAPI 写作约定](./openapi/README.md)
- [WS 客户端消息 Schema](./schemas/client-messages.schema.json)
- [WS 服务端消息 Schema](./schemas/server-messages.schema.json)
- [WebSocket Schema 写作约定](./schemas/README.md)
- [协议测试向量](./test-vectors/README.md)

当前规范仍是 Draft。Conversation 生命周期、capabilities revision 绑定、accepted fallback、
Pipeline ID/kind 分离、输出能力、打断后连续性、部分成功上下文提交、generation controls、
音色异步状态和幂等删除竞态已经收敛；HTTP 字段契约由 OpenAPI 3.1 承载，WebSocket
控制消息由 JSON Schema 2020-12 承载。

## 推荐编写顺序

1. 在 `docs/` 中确定资源和状态机语义，尤其是跨请求生命周期。
2. 在 `schemas/` 中定义共享标量、控制信封和每种 WebSocket 消息。
3. 在 `openapi/` 中定义 HTTP 路径、组件模型和错误响应。
4. 从机器规范生成示例或校验示例，避免 Markdown 与契约漂移。
5. 客户端、后端和 Mock 使用同一 revision 的正反例测试向量，但分别在自己的仓库建立实现级 CI。

提交协议变更时，应同时说明兼容性影响，并更新对应 schema、示例和验收用例。在
`2.0.0-draft` 冻结前允许做不兼容收敛，但客户端与后端不得把 Draft 当作稳定版本；
v2 正式冻结发布后，改变必填字段、终态语义或二进制布局必须提升主版本。

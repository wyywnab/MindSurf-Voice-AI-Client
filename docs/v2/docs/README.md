# v2 语义文档

本目录保存无法仅靠结构化 schema 表达的协议语义：

- [HTTP API v2](./HTTP_API_V2.md)
- [WebSocket API v2](./WS_PROTOCOL_V2.md)
- [Conversation 生命周期](./conversations.md)
- [Request 生命周期与流完成语义](./request-lifecycle.md)
- [后端仓库接入与交接](./backend-integration.md)

后续建议把两份长文档逐步拆成：

```text
docs/
├── overview.md
├── conversations.md          # 已建立的权威语义
├── request-lifecycle.md      # 已建立的权威语义
├── errors-and-retries.md
├── audio-transport.md
├── HTTP_API_V2.md
└── WS_PROTOCOL_V2.md
```

拆分前保留现有文件作为完整基线；拆分过程中不要复制字段表，字段级契约应引用 `../openapi/` 或 `../schemas/`。

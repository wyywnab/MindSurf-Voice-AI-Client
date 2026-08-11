# HTTP OpenAPI

本目录用于维护 MindSurf Voice HTTP API v2 的 OpenAPI 3.1 契约。

当前主入口是 [`openapi.yaml`](./openapi.yaml)，已覆盖 capabilities、voices、voice references 和 conversations 的全部 v2 HTTP 路径。规模继续增长时按领域拆分：

```text
openapi/
├── openapi.yaml
├── paths/
│   ├── capabilities.yaml
│   ├── voices.yaml
│   └── conversations.yaml
└── components/
    ├── common.yaml
    ├── capabilities.yaml
    ├── voices.yaml
    └── errors.yaml
```

编写要求：

- 使用 OpenAPI 3.1，使 schema 语义与 JSON Schema 2020-12 对齐。
- 每个操作定义成功响应、所有稳定错误响应和鉴权要求。
- 用 schema 表达 required、nullable、enum、format、长度和数值范围。
- multipart 明确每个 part 的媒体类型和文本编码规则。
- 错误码与 HTTP 状态码建立唯一映射；不要只维护一张无映射的错误码列表。
- 相同状态码在不同 operation 中必须引用收窄后的专用错误 union；不得让一个操作在
  机器契约中返回其他资源域的错误码。
- 异步资源明确 `202 -> processing -> ready|failed` 的转换及轮询字段。
- `operationId` 和组件名称保持稳定，供客户端类型生成和契约测试使用。

当前契约版本仍标记为 `2.0.0-draft`。冻结前应加入 OpenAPI lint、示例校验和客户端类型生成检查。

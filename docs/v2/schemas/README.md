# WebSocket JSON Schemas

本目录用于维护 MindSurf Voice WebSocket v2 控制消息及共享数据结构的 JSON Schema 2020-12 契约。

当前结构：

```text
schemas/
├── envelope.schema.json
├── client-messages.schema.json
├── server-messages.schema.json
├── common/
│   ├── audio.schema.json
│   ├── request.schema.json
│   └── errors.schema.json
```

方向入口：

- [`client-messages.schema.json`](./client-messages.schema.json)：客户端发往后端的 5 种控制消息。
- [`server-messages.schema.json`](./server-messages.schema.json)：后端发往客户端的 13 种控制消息。
- [`envelope.schema.json`](./envelope.schema.json)：固定信封、UUID 以及 session/request 级 request ID。

两个方向入口都使用顶层 `oneOf`，可以直接用于运行时消息校验。各消息定义保存在入口文件的 `$defs` 中，共享结构通过相对 `$ref` 引用 `common/`。

编写要求：

- 每个消息 schema 固定 `v`、`type` 和 request/session 级 `request_id` 规则。
- payload 明确定义 required、null、枚举、整数范围及未知字段策略。
- 使用 `$defs`/`$ref` 复用 UUID、时间戳、选择项、流状态和错误结构。
- 客户端消息与服务端消息分别提供顶层 `oneOf`，用于方向性校验。
- 顶层信封拒绝未知字段；payload 和可扩展的嵌套对象允许未知非关键字段，与协议的向前兼容规则一致。
- Generation 固定使用 `generation.text` / `generation.audio` 两个命名空间；具体参数名和
  上下限来自当前 HTTP capabilities。WS schema 拒绝旧的扁平结构，客户端和后端还
  必须按本次能力目录校验各通道参数。通道参数只允许在对应 response 开关为 true 时
  发送，Dictation 必须省略整个 generation。
- Pipeline ID 是 HTTP capabilities 中的不透明引用；其 `kind` 属于 HTTP 能力快照，未在
  WebSocket 消息中冗余发送。因此 JSON Schema 不根据 `pipeline` 字符串硬编码
  native/cascade 的 selection 规则；客户端和后端必须在校验 `capabilities_revision` 后，
  使用同一能力快照中的 `Pipeline.kind` 执行跨资源语义校验。
- error Schema 固定稳定错误码的 stage、retryable、scope 和 stream 组合；新增错误码时
  必须同时更新错误状态矩阵与正反例，不能只扩展 code 枚举。
- `client.hello.auth` 是必填 Bearer 鉴权；v2 的本地开发环境也不允许匿名连接。
- stream error 固定 `retryable=false`；只有不提交 turn 的请求级终态错误可以声明以新
  request ID 重试，且重试不表示自动重放录音。
- Schema 只校验结构；跨事件顺序、sequence 连续性、统计合计和状态机仍由语义文档与测试向量约束。
- 每种消息至少提供一个合法样例和关键非法样例，并由客户端、后端和 Mock 共同运行。

二进制音频帧不使用 JSON Schema。固定布局见 [`WS_PROTOCOL_V2.md`](../docs/WS_PROTOCOL_V2.md)，可逐字节比对的十六进制向量见 [`test-vectors/binary/audio-frames.json`](../test-vectors/binary/audio-frames.json)。

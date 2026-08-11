# v2 协议测试向量

本目录保存与实现语言无关的 v2 协议固定输入。它是协议资产的一部分，不属于某个客户端或后端实现。

```text
test-vectors/
├── manifest.json
├── json/
│   ├── invalid-messages.json
│   └── pipeline-kind-requests.json
└── binary/
    └── audio-frames.json
```

## JSON 控制消息

合法 JSON 样例以 [`WS_PROTOCOL_V2.md`](../docs/WS_PROTOCOL_V2.md) 中的完整消息为单一来源，`manifest.json` 固定必须覆盖的 18 种消息类型。这样可以避免文档样例和另一份合法 fixture 逐渐分叉。

[`invalid-messages.json`](./json/invalid-messages.json) 保存不能仅靠“能解析成 JSON”发现的
关键反例。每个反例都是除目标规则外结构完整的客户端或服务端消息；校验脚本必须证明
原消息被对应 Schema 拒绝，并且只修复目标规则后可以通过。Schema 结构校验仍以
[`client-messages.schema.json`](../schemas/client-messages.schema.json) 和
[`server-messages.schema.json`](../schemas/server-messages.schema.json) 为准。

[`pipeline-kind-requests.json`](./json/pipeline-kind-requests.json) 保存 HTTP capabilities 与
WebSocket `request.start` 的成对向量。它验证 Pipeline ID 只是引用、同一 kind 可以有多个
ID，以及 selection 必须根据同 revision 能力快照中的 `Pipeline.kind` 校验。这些规则不能
由单条 WebSocket JSON Schema 独立表达。

## 二进制音频帧

[`audio-frames.json`](./binary/audio-frames.json) 中的 `frame_hex` 是一个完整 WebSocket Binary Message，不包含空格或 `0x` 前缀。多字节头字段使用大端，PCM16 payload 使用小端。

每个实现至少应验证：

- 合法向量能逐字段解码，并且重新编码后逐字节一致；
- 错误版本与错误 payload 长度被拒绝；
- 同一 `stream` 内 sequence 和 timestamp 连续；
- UUID 按规范文本顺序编码，而不是平台特有的混合端序。

## 本仓库校验

在仓库根目录运行：

```bash
npm ci
npm run validate:protocol-v2
```

该命令使用 JSON Schema 2020-12 validator 和 OpenAPI 3.1 validator，校验机器契约、
Markdown 示例、正反例和二进制固定向量之间的一致性。它不证明客户端或后端已经正确
实现协议；实现级 codec 和状态机测试应分别放在各自仓库。

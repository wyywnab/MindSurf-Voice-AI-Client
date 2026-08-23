# MindSurf Voice 协议版本

MindSurf Voice 分别管理 HTTP 路径主版本、契约发布版本和 WebSocket 线协议版本：

- HTTP 路径只携带不兼容主版本，当前保持 `/v2`；
- HTTP 契约发布使用语义化版本，当前草案为 `2.1.0`；
- WebSocket 子协议和消息字段保持 `mindsurf.voice.v2` / `v=2`。

## 当前版本

| 契约 | 版本 | 状态 | 入口 |
|---|---:|---|---|
| Voice HTTP/WS Core | 2.0.0 | Frozen | [`v2/`](./v2/README.md) |
| Polish Prompt Extension | 1.0.0 | Draft | [`extensions/polish-prompt-v1/`](./extensions/polish-prompt-v1/README.md) |
| Voice HTTP Release | 2.1.0 | Draft | [`releases/2.1.0/`](./releases/2.1.0/README.md) |
| Voice WebSocket | 2 | Frozen、未变更 | [`v2/docs/WS_PROTOCOL_V2.md`](./v2/docs/WS_PROTOCOL_V2.md) |

`2.1.0` 由冻结的 HTTP Core `2.0.0` 和 Polish Prompt Extension `1.0.0` 组成。现有
`docs/v2/` 是不可变基线；新增能力不得回写或重新解释该目录中的既有契约。

## 版本规则

- patch：只允许勘误和不改变合法请求、响应或行为集合的澄清；
- minor：允许增加向后兼容的新接口或可选能力；
- major：删除或重解释字段、改变必填规则、状态机、鉴权或二进制格式。

HTTP minor/patch 升级不进入 URL。只有不兼容升级才引入 `/v3`，并同步评估新的 WebSocket
子协议。

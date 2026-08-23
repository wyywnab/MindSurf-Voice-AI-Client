# MindSurf Voice HTTP Contract 2.1.0

> 发布状态：Draft
>
> HTTP 路径主版本：2
>
> WebSocket 协议版本：2（未变更）

HTTP Contract `2.1.0` 是向后兼容的 minor release，由以下规范组成：

- [Voice HTTP/WS Core 2.0.0](../../v2/README.md)，Frozen；
- [Polish Prompt Management Extension 1.0.0](../../extensions/polish-prompt-v1/README.md)，Draft。

机器入口 [`openapi.yaml`](./openapi.yaml) 通过 OpenAPI Path Item `$ref` 组合冻结核心和扩展，
不复制或修改 v2.0.0 基线。精确组成记录在 [`manifest.json`](./manifest.json)。

兼容目标：

- 所有 HTTP 路径继续使用 `/v2`；
- v2.0 客户端可以无修改使用 v2.1 服务端；
- v2.1 客户端面对 v2.0 服务端时只禁用提示词管理；
- `mindsurf.voice.v2`、WS `v=2`、消息 Schema 和生命周期完全不变；
- Prompt 更新不改变 capabilities revision，也不要求重连。

变更见 [`CHANGELOG.md`](./CHANGELOG.md)。扩展通过评审并冻结后，本 release 才从 Draft 切换
为 Frozen。

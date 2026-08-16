# HTTP OpenAPI 3.1

[`openapi.yaml`](./openapi.yaml) 是 HTTP v2 的字段级权威契约，覆盖 9 个 operation：系统
浏览器授权、Authorization Code 换 Token、刷新、登出、当前用户、额度、用量、能力目录和
realtime ticket。

编写规则：

- 默认 Bearer security，authorize/token/refresh 显式 `security: []`；
- code、PKCE verifier、access/refresh token 和 ticket 标记为敏感字段；
- token 和 refresh 使用必填 Idempotency-Key 安全恢复结果不确定的重试；
- refresh 原结果不能继续安全重放时返回 idempotency_result_expired，不得误判为 token 重放；
- 桌面客户端是无 client secret 的 public client，只允许 Authorization Code + S256 PKCE；
- 成功和错误均携带 request ID，204 除外；
- HTTP 只管理账户和长期资源，不承载实时音频；
- 不得加入 Conversation、TTS、Voice 或 Emotion 资源；
- Pipeline ID 是不透明引用，跨资源选择由同 revision 能力目录校验；
- defaults 是默认 Pipeline 和 selection 的唯一权威来源，能力目录必须满足 ID 唯一和引用完整性；
- WebSocket ticket 一次消费、短时有效，但建立的 WS 是长期连接。
- ticket 响应的 websocket_path 是本次建连权威路径，capabilities 路径只用于预览。

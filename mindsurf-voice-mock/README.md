# MindSurf Voice API v2 Mock

用于桌面客户端本地开发和契约联调的内存 Mock。它实现冻结的 HTTP、一次性 realtime ticket 和
`mindsurf.voice.v2` WebSocket 文本协议，不执行真实 ASR/LLM 推理，也不生成下行音频。

## 启动

```bash
npm ci
npm start
```

默认 HTTP origin：

```text
http://127.0.0.1:8000
```

可使用 `PORT` 修改端口。客户端账户页应填写 HTTP origin，不填写 WebSocket URL或长期 Token。

本地授权页会展示固定测试账户。用户点击“登录并授权”后，Mock 签发短时 Authorization Code，并
显示回到客户端的确认页；点击“打开 MindSurf Voice AI”后通过 `mindsurf://auth/callback` 回跳。
点击“取消”则生成 `access_denied` 回跳。所有用户、token、ticket、额度、用量和账户润色提示词
仅存在于 Mock 进程内存，重启后重置。修改 Mock 源码后需要重启进程才会生效。

## 已实现接口

- `GET /v2/auth/authorize`
- `POST /v2/auth/token`
- `POST /v2/auth/refresh`
- `POST /v2/auth/logout`
- `GET /v2/users/me`
- `GET /v2/users/me/polish-prompt`
- `PUT /v2/users/me/polish-prompt`
- `DELETE /v2/users/me/polish-prompt`
- `GET /v2/quota`
- `GET /v2/usage`
- `GET /v2/capabilities`
- `POST /v2/realtime/tickets`
- ticket 指定的 `GET /v2/voice/ws` WebSocket Upgrade

WebSocket 支持 hello、心跳、单活跃请求、严格 v2 INPUT_PCM 帧、commit 统计、取消、额度结算、
`asr_only` 和 `asr_llm` 的完整文本生命周期。ticket 30 秒过期且只能消费一次。

润色提示词接口实现账户级默认值与自定义覆盖、ETag / If-Match 乐观并发控制、
Idempotency-Key 重放和恢复默认语义。`asr_llm` 在发送 `request.accepted` 前固化当前 Prompt
快照；Mock 不执行真实 LLM 推理，自定义 Prompt 会产生不包含正文的确定性占位结果，便于验证
更新生效边界。

## 故障注入

```bash
node server.mjs --fault capabilities_stale
node server.mjs --fault cancel_race --fault-delay-ms 1000
node server.mjs --fault asr_failed,request_done_missing
node server.mjs --help
```

也可设置 `MOCK_FAULTS` 和 `MOCK_FAULT_DELAY_MS`。稳定故障名包括：

- 浏览器拒绝、token/refresh 响应不确定和 refresh token 重放；
- Prompt 存储不可用和 Prompt mutation 响应不确定；
- capabilities stale、ticket 过期/已消费；
- hello/heartbeat/accepted 超时；
- 输入统计不一致、ASR/LLM 失败、处理中断线；
- final/done 不一致、取消输给成功竞态和 done 缺失。

`token_response_uncertain`、`refresh_response_uncertain` 与
`polish_prompt_response_uncertain` 会在服务端提交结果后断开第一次 HTTP 响应；客户端必须使用
相同 Idempotency-Key 和完全相同的 body 恢复结果。

## 测试

```bash
npm test
```

测试覆盖 PKCE、token 幂等与轮换、受保护 HTTP 接口、Prompt 并发和幂等语义、Prompt 请求快照、
用量分页、ticket 单次消费、同一长连接的两种模式、取消后继续复用连接，以及 capabilities
stale/final-done mismatch 故障路径。

权威规范见 [docs/v2](../docs/v2/README.md)。

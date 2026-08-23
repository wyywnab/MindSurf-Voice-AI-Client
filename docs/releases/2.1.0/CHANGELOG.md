# HTTP Contract 2.1.0 Changelog

## Added

- 账户级润色提示词资源 `/v2/users/me/polish-prompt`；
- GET、PUT 和 DELETE 管理操作；
- 默认值继承、用户覆盖和恢复默认语义；
- ETag / If-Match 乐观并发控制和 Idempotency-Key 重放语义；
- `polish_prompt_revision_conflict` 和 `precondition_required` 错误。

## Unchanged

- HTTP Core 2.0.0 的所有路径、字段和行为；
- WebSocket 子协议 `mindsurf.voice.v2` 和消息版本 `v=2`；
- `request.start`、`request.accepted`、终态和二进制音频格式；
- capabilities revision 的含义。

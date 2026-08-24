# Polish Prompt Management Extension v1

> 扩展版本：1.0.0
>
> 文档状态：Draft
>
> 基础契约：MindSurf Voice HTTP Core 2.0.0
>
> 机器契约：[`openapi.yaml`](./openapi.yaml)

## 1. 范围

本扩展为当前登录用户提供账户级润色提示词管理，只增加独立 HTTP 资源，不修改 Voice
WebSocket v2 的消息、状态机、二进制音频格式或连接生命周期。

```text
/v2/users/me/polish-prompt
```

- 每个用户最多有一份自定义润色提示词，同一账户的所有设备共享；
- 配置适用于所有 `asr_llm` Pipeline 和识别语言，`asr_only` 完全忽略；
- 没有自定义值时资源仍然存在，并返回服务端当前默认提示词；
- 本版本不定义按设备、Pipeline、模型或语言拆分的配置，不支持模板占位符或历史版本。

## 2. 通用约定

所有接口使用 HTTP Core v2 的 Bearer 鉴权、`request_id` 和 `ErrorResponse`。成功响应均设置：

```http
Cache-Control: private, no-cache
ETag: "<opaque-revision>"
```

`ETag` 是当前有效配置的强校验器。客户端必须原样保存（包括双引号），并在 PUT/DELETE 的
`If-Match` 中发送。PUT 和 DELETE 还必须携带 `Idempotency-Key`。服务端至少保留 24 小时幂等
结果；同一 key 和相同操作重放原结果，同一 key 用于不同操作或内容返回
`409 idempotency_conflict`。服务端必须先恢复幂等结果，再检查 `If-Match`，以允许成功响应丢失
后的安全重试。

## 3. 数据模型

```json
{
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf30",
  "data": {
    "revision": "polish-prompt-01K3...",
    "source": "default",
    "prompt": "请在保持原意的前提下，使文本更加通顺、简洁、自然。",
    "updated_at_ms": 1786723200000,
    "constraints": {
      "max_code_points": 4000,
      "max_utf8_bytes": 16384
    }
  }
}
```

- `revision` 与响应 ETag 表示同一不透明版本；
- `source=default` 表示当前服务端默认值，`source=custom` 表示用户覆盖值；
- `updated_at_ms` 是当前有效内容开始生效的服务端时间；
- `constraints` 是客户端计数和预校验的权威限制。

服务端默认提示词变化只影响 `source=default` 的用户，并产生新的 revision 和 ETag；已有用户
自定义值不得被覆盖。

## 4. 获取有效配置

```http
GET /v2/users/me/polish-prompt
Authorization: Bearer <access-token>
```

成功返回 `200` 和当前有效配置。符合本扩展的服务端必须始终将该资源视为存在，不得因为用户
没有自定义值而返回 `404`。

新客户端访问旧版服务端时，如果该路径返回 HTTP `404`，必须仅依据状态码判定扩展不受支持，
不得要求响应正文符合 Core v2 `ErrorResponse`。客户端应隐藏提示词管理入口，并且不得继续发送
PUT 或 DELETE。除该兼容性 `404` 外的错误仍按 Core v2 标准错误信封处理。

客户端只有在 GET 成功并保存响应 ETag 后才能发送 PUT 或 DELETE。若 mutation 意外收到 `404`，
客户端应将扩展标记为不可用、停止后续写入并提示用户刷新；PUT 和 DELETE 不承担首次能力探测。

## 5. 设置自定义提示词

```http
PUT /v2/users/me/polish-prompt
Authorization: Bearer <access-token>
Content-Type: application/json
If-Match: "polish-prompt-01K3..."
Idempotency-Key: 019d643e-1550-761a-b7a0-471791bcaf31
```

```json
{
  "prompt": "请去除口语中的重复和停顿词，修正明显语病，但不要改变原意和语气。"
}
```

成功返回 `200`、新 ETag 和 `source=custom` 的完整配置。若内容与当前自定义值逐码点相同，
返回当前配置，不创建新 revision，也不改变 `updated_at_ms`。

输入规则：

- `prompt` 是唯一允许字段；去除首尾 Unicode 空白后不能为空；
- 校验后原样保存，不自动 trim、改写换行或进行 Unicode 规范化；
- 最多 4000 个 Unicode code point，UTF-8 编码后最多 16384 字节；
- 禁止 U+0000，换行和制表符可以保留；
- 内容是“润色指令”，不是带 `{{transcript}}` 等占位符的完整模板。

## 6. 恢复默认提示词

```http
DELETE /v2/users/me/polish-prompt
Authorization: Bearer <access-token>
If-Match: "polish-prompt-01K4..."
Idempotency-Key: 019d643e-1550-761a-b7a0-471791bcaf33
```

成功返回 `200`、当前默认配置及其 ETag，不使用 `204`。已经处于默认状态时返回当前配置且不
创建新 revision。

## 7. 并发和错误

PUT/DELETE 缺少 `If-Match` 返回 `428 precondition_required`；revision 已过期返回
`412 polish_prompt_revision_conflict`。客户端收到 412 后必须重新 GET，并让用户决定采用远端
内容还是基于新 revision 再次提交，不得自动覆盖。错误响应不得回显提示词正文。

| HTTP | code | 语义 |
|---:|---|---|
| 400 | `invalid_request` | JSON、字段或提示词内容非法 |
| 401 | `authentication_*` | access token 缺失、无效或过期 |
| 403 | `account_suspended` | 当前账户不可用 |
| 409 | `idempotency_conflict` | 幂等 key 被用于不同操作或内容 |
| 412 | `polish_prompt_revision_conflict` | `If-Match` 与当前 revision 不一致 |
| 428 | `precondition_required` | 缺少 `If-Match` |
| 429 | `rate_limit_exceeded` | HTTP 请求频率超限 |
| 500 | `server_error` | 未分类内部错误 |
| 503 | `service_unavailable` | 配置服务暂不可用 |

## 8. 与 WebSocket v2 的关系

`client.hello`、`request.start`、`request.accepted` 和终态消息均不增加 Prompt 或 Prompt
revision 字段。长连接不因配置更新重连，`capabilities_revision` 也不因本配置改变。

服务端在 `request.start` 到达后、发送 `request.accepted` 前，按 WS session 用户解析并固化
有效 Prompt 快照：

- 已 accepted 的请求始终使用该快照；
- PUT/DELETE 成功后才开始的新 `asr_llm` 请求必须使用新配置；
- `asr_only` 不读取该快照；
- 配置存储不可用且没有可确认的新鲜快照时，不得静默改用默认值，应在 accepted 前使用现有
  WS `upstream_unavailable` 请求级错误结束请求。

多节点服务必须保证写响应返回前，新 revision 已对后续请求准入可见，或通过等价机制满足上述
先后关系。

## 9. Prompt 组合、安全与隐私

模型输入应分为：服务端固定安全边界、用户润色指令、明确分隔的 ASR 文本。用户提示词不能
替换服务端安全约束；服务端不得要求 transcript 占位符，也不得使用无边界的字符串拼接。

正文属于用户私有数据，不得写入访问日志、诊断日志、错误 details、用量、历史或 WebSocket
消息。允许记录 user ID、source、revision、字符数和更新时间，但不得记录正文。

## 10. 兼容性

- Core 2.0 客户端可以无修改使用 HTTP 2.1 服务端；
- HTTP 2.1 客户端面对 2.0 服务端时只禁用提示词管理；
- 没有自定义值的用户，其 `asr_llm` 行为与 Core 2.0 一致；
- 只有未来要求单次请求选择或发送 Prompt 时，才评估新的 WebSocket 主版本。

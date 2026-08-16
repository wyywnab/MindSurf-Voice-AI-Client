# MindSurf Voice HTTP 接口协议

> 接口版本：2
>
> 文档状态：Frozen
>
> 传输层：HTTPS（显式开发模式可以使用 HTTP）
>
> 机器契约：[`../openapi/openapi.yaml`](../openapi/openapi.yaml)

## 1. 范围

HTTP API v2 负责：

- 通过系统浏览器完成登录、注册和账户恢复，并用 PKCE 换取 Token；
- Token 刷新和当前客户端 session 登出；
- 当前用户资料；
- 额度余额和用量查询；
- ASR/LLM/Pipeline 能力发现；
- 为长期 WebSocket 连接签发一次性 ticket。

实时音频和文本事件由 [WebSocket API v2](./WS_PROTOCOL_V2.md) 定义。本协议不包含
Conversation、Assistant、TTS、下行音频、Voice、音色克隆或 Emotion 资源。

字段、状态码和 required 规则以 OpenAPI 3.1 为准；本文解释跨请求语义。

## 2. 通用约定

生产基础地址示例：

```text
https://api.example.com
```

所有路径已经包含 `/v2`。除 authorize、token 和 refresh 外，接口默认使用：

```http
Authorization: Bearer <access-token>
```

错误统一返回：

```json
{
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf20",
  "error": {
    "code": "quota_exhausted",
    "message": "当前额度不足",
    "retryable": false,
    "details": {}
  }
}
```

Token、Authorization Code、PKCE verifier 和 ticket 不得出现在日志、错误 details 或遥测字段中。
用户密码、邮箱验证码、MFA 和第三方身份凭据只进入系统浏览器中的认证网站，桌面客户端
不得采集、保存或转发这些凭据。

## 3. 鉴权生命周期

### 3.1 系统浏览器授权

桌面客户端是 public client，不持有 client secret。用户点击登录后，客户端为本次尝试生成：

- 至少 32 字节密码学随机数经无 padding base64url 编码得到的 `state`；
- 43～128 个 RFC 7636 unreserved 字符组成的 `code_verifier`；
- `code_challenge = BASE64URL_NOPAD(SHA256(ASCII(code_verifier)))`。

`state` 和 `code_verifier` 只保存在内存中；同一客户端实例一次只能有一个活跃授权尝试，
客户端等待回跳最多 15 分钟。超时、应用退出或新授权开始时必须丢弃旧尝试。随后使用
系统默认浏览器打开，不得使用内嵌 WebView：

```text
GET https://api.example.com/v2/auth/authorize
  ?client_id=mindsurf-desktop
  &response_type=code
  &redirect_uri=mindsurf%3A%2F%2Fauth%2Fcallback
  &code_challenge=<base64url-sha256>
  &code_challenge_method=S256
  &state=<opaque-state>
```

认证网站内部负责登录、注册、邮箱验证、找回密码、MFA 和第三方身份提供商。它们不是桌面
客户端协议的一部分，可以独立演进。服务端必须精确匹配预注册的 client ID 和 redirect URI，
不得接受调用方提供的任意回跳地址。

若 client ID、redirect URI、response type 或 PKCE 参数非法，authorize 必须在自身 origin
显示错误并返回 400，不得向未经验证的 redirect URI 跳转。自定义协议可能被其他本地应用
抢占，因此安全性依赖一次性 code 和 S256 PKCE；仅拿到回跳 code 不能换取 Token。

成功后浏览器回跳：

```text
mindsurf://auth/callback?code=<one-time-code>&state=<original-state>
```

用户取消或授权站点无法完成时回跳：

```text
mindsurf://auth/callback?error=access_denied&state=<original-state>
```

回跳必须恰好包含 `code` 或 `error` 之一。稳定回跳错误只定义 `access_denied` 和
`temporarily_unavailable`；客户端不得依赖面向用户的 `error_description`。回跳 URI 不得
包含 access token、refresh token、Cookie、邮箱或其他账户资料。

客户端只接受当前活跃尝试且 state 恒定时间匹配的回跳。未知、过期、重复或不匹配的回跳
全部丢弃并记录脱敏诊断。Tauri 必须把自定义协议回跳转交给已经运行的单实例；回跳不得创建
第二套独立登录状态。

### 3.2 Code 换取 Token

客户端收到合法回跳后立即调用：

```http
POST /v2/auth/token
Content-Type: application/json
Idempotency-Key: <random-uuid>
```

```json
{
  "grant_type": "authorization_code",
  "client_id": "mindsurf-desktop",
  "code": "<one-time-code>",
  "code_verifier": "<original-verifier>",
  "redirect_uri": "mindsurf://auth/callback",
  "device": {
    "id": "stable-device-id",
    "name": "Alice's MacBook",
    "platform": "macos",
    "app_version": "2.0.0"
  }
}
```

Authorization Code 默认 60 秒过期，只能消费一次，并绑定用户、client ID、redirect URI 和
PKCE challenge。校验全部成功、创建登录 session、消费 code、签发 token pair 和保存幂等
结果必须位于同一原子边界。code 无效、过期、已消费、绑定不匹配或 PKCE 校验失败统一返回
`400 authorization_grant_invalid`，不得暴露具体原因。

`Idempotency-Key` 是每次逻辑交换新生成的 UUID，客户端必须为原样重试复用同一个 key。
服务端至少在 code 原有效期结束后继续保留幂等结果 60 秒；同一 key 和相同请求返回第一次的
同一 token pair，同一 key 携带不同请求返回 `409 idempotency_conflict`。幂等命中不是第二次
消费 code。重放响应中的 token 字符串保持不变，`expires_in` 和 `refresh_expires_in` 按重放
响应时刻重新计算真实剩余秒数。token 请求结构非法使用 `400 invalid_request`。

若响应因网络中断而结果不确定，客户端使用相同 key 和完全相同的请求重试；不得为同一次
交换生成新 key。若幂等窗口已经结束或仍无法确认结果，必须丢弃本次 state/verifier/code 并
重新打开浏览器授权。

成功返回 access/refresh token 和当前用户。`expires_in` 与 `refresh_expires_in` 的单位都是秒。
access token 建议 10～20 分钟过期；refresh token 必须轮换。客户端把 refresh token 存入
系统 Keychain，不得保存在普通设置 JSON、localStorage 或日志中；access token 只保存在内存
或等价安全存储。

授权成功后的启动顺序：

```text
browser authorize -> callback -> token exchange
  -> GET /v2/users/me
  -> GET /v2/quota
  -> GET /v2/capabilities
  -> POST /v2/realtime/tickets
  -> WebSocket Upgrade + long-lived connection
```

已有 refresh token 时不打开浏览器，先 refresh。三个 GET 可以并行；能力目录和 ticket 成功
后立即建立长连接，不等待用户开始录音。

### 3.3 刷新

```http
POST /v2/auth/refresh
Idempotency-Key: <random-uuid>
```

refresh 使用当前 refresh token，成功时必须同时返回新的 access token 和新的 refresh token，
旧 refresh token 原子失效。客户端为每次逻辑刷新生成新的 `Idempotency-Key`，响应不确定时
只允许使用相同 key 和相同请求重试。服务端必须保证首次请求后至少 2 分钟内可重放第一次的
同一 token pair，并按重放时刻重新计算两个 `*_expires_in`；这不视为 refresh token 重放。

服务端还必须在替代 refresh token 过期前保留足以区分“相同操作恢复”和“不同操作重放”的
幂等元数据，包括 session、key、请求指纹和旧 token 指纹。原 token pair 已不能安全重放时，
相同 key 和相同请求返回 `409 idempotency_result_expired`，不得撤销 session；客户端收到该错误，
或从首次 refresh 尝试起 2 分钟仍无法确认结果时，停止 refresh 重试、丢弃本地 token，并重新
打开系统浏览器授权。不得换一个 key 再提交旧 refresh token。

同一 key 携带不同请求返回 `409 idempotency_conflict`；只有使用不同 key 提交已轮换的 refresh
token 才返回 `409 refresh_token_reused`，撤销该登录 session 并关闭其现有 WebSocket。

access token 过期不影响已经认证的 WS；它只影响后续 HTTP 请求。WS 非正常断线后需要新
ticket，此时必须先确保 access token 有效。

### 3.4 登出

```http
POST /v2/auth/logout
Authorization: Bearer <access-token>
```

logout 没有请求体。access token 必须包含或可解析到稳定的登录 session ID；后端据此撤销
该 session 的 refresh token、尚未消费的 tickets 和已建立的 WebSocket。为允许客户端在
204 响应丢失后安全重试，logout 对签名和有效期合法、但其 session 已被同一次 logout
撤销的 access token 仍返回 204；该 token 访问其他受保护接口时仍按已撤销处理。

客户端无论收到 204、确认 session 已撤销，还是决定放弃网络重试，都清除 Keychain 凭据
和内存中的用户、额度、能力数据。logout 不得在 URL 或请求体中再次传输 refresh token。
该操作只退出当前桌面客户端 session，不清除系统浏览器中的认证 Cookie。用户再次授权时
可能直接登录；需要强制重新认证或选择账户时，authorize 分别使用 `prompt=login` 或
`prompt=select_account`。

## 4. 当前用户

```http
GET /v2/users/me
```

返回稳定 `user_id`、显示名称、登录标识、账户状态、创建时间和当前 plan。密码散列、内部
权限结构、上游身份或计费系统 ID 不得返回。

账户状态不是 `active` 时不得签发 realtime ticket。

## 5. 额度和用量

### 5.1 当前额度

```http
GET /v2/quota
```

示例：

```json
{
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf21",
  "data": {
    "plan": "free",
    "pricing_revision": "pricing-2026-08-1",
    "period": {
      "starts_at_ms": 1786723200000,
      "ends_at_ms": 1789401600000
    },
    "credits": {
      "limit": 10000,
      "used": 3200,
      "reserved": 100,
      "remaining": 6700
    },
    "usage": {
      "input_audio_ms": 186000,
      "llm_input_tokens": 12400,
      "llm_output_tokens": 8600,
      "asr_credits_charged": 2100,
      "llm_credits_charged": 1100,
      "credits_charged": 3200
    }
  }
}
```

不变量：`remaining = max(limit - used - reserved, 0)`、
`usage.credits_charged = usage.asr_credits_charged + usage.llm_credits_charged`，且当前计费周期
只有这两类费用时 `credits.used = usage.credits_charged`。credits 是客户端展示余额和判断是否
可发起请求的权威单位；原始 usage 用于解释和审计，客户端不得自行换算 credits。

### 5.2 用量历史

```http
GET /v2/usage?from_ms=1786723200000&to_ms=1786809600000&cursor=...
```

查询区间固定为半开区间 `[from_ms, to_ms)`，并要求 `from_ms < to_ms`。返回分页的已结算
usage entries。每条 entry 至少包含 request ID、mode、结算时间、原始资源用量、ASR 扣费、
LLM 润色扣费、合计扣费和 pricing revision。未终态的 reservation 不进入历史列表。
`cursor` 是服务端签名的不透明游标，固定首次请求的用户、区间、排序和快照水位；携带 cursor
时 `from_ms`、`to_ms` 和 `limit` 必须与首次请求一致，否则返回 `400 invalid_request`。因此
翻页期间新结算的 entry 不会导致重复或漏项，新 entry 由下一次不带 cursor 的查询获取。

### 5.3 实时请求结算

- `request.start` 接受前分别计算 ASR 和 LLM 润色的最大费用，并原子创建两个分项 reservation；
- 任一分项额度无法预留都返回 WS `quota_exhausted`，不得 accepted；
- 请求终态分别结算实际执行的 ASR 和 LLM 润色阶段；
- `credits_charged = asr_credits_charged + llm_credits_charged`；
- `asr_only` 的 LLM 原始用量和 LLM 扣费固定为 0；
- 取消或失败只收已经执行阶段的实际费用，并分别释放未消费 reservation；
- `request.done`、`request.cancelled` 和请求级 terminal error 的 usage 是本次最终结算结果；
- HTTP quota 是账户汇总的最终权威来源。

## 6. 能力目录

```http
GET /v2/capabilities
```

能力目录只描述单轮文本处理：

```json
{
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf22",
  "data": {
    "protocol_version": 2,
    "revision": "cap-2026-08-15-1",
    "realtime": {
      "websocket_path": "/v2/voice/ws",
      "ticket_path": "/v2/realtime/tickets",
      "subprotocol": "mindsurf.voice.v2",
      "persistent": true
    },
    "modes": ["asr_only", "asr_llm"],
    "pipelines": [
      {
        "id": "general-asr",
        "name": "通用识别",
        "description": "ASR only",
        "modes": ["asr_only"],
        "max_recording_ms": 120000,
        "asr_options": ["whisper-large-v3"],
        "llm_options": [],
        "generation_controls": {}
      },
      {
        "id": "general-asr-llm",
        "name": "ASR + LLM",
        "description": "ASR followed by an LLM text-processing step",
        "modes": ["asr_llm"],
        "max_recording_ms": 120000,
        "asr_options": ["whisper-large-v3"],
        "llm_options": ["qwen-text"],
        "generation_controls": {
          "temperature": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "default": 0.2
          }
        }
      }
    ],
    "asr_options": [{"id": "whisper-large-v3", "name": "Whisper Large v3"}],
    "llm_options": [{"id": "qwen-text", "name": "Qwen Text"}],
    "recognition_languages": ["auto", "zh-CN", "en-US"],
    "defaults": {
      "asr_only": {
        "pipeline": "general-asr",
        "selection": {"asr": "whisper-large-v3", "llm": null}
      },
      "asr_llm": {
        "pipeline": "general-asr-llm",
        "selection": {"asr": "whisper-large-v3", "llm": "qwen-text"}
      }
    }
  }
}
```

Pipeline ID 是不透明引用。客户端必须使用同一 revision 中的 Pipeline 校验 mode 和
selection，不得从 ID 名称推断能力。`defaults[mode]` 是默认 Pipeline 和 selection 的唯一
权威来源，不再维护第二份 `default_pipeline`。

每个能力 revision 必须满足以下引用完整性：Pipeline ID、顶层 ASR option ID 和顶层 LLM
option ID 在各自集合内唯一；Pipeline 引用的 option 必须存在于顶层集合；每个默认 Pipeline
必须存在并支持对应 mode；默认 selection 必须属于该 Pipeline；asr_only 默认 LLM 必须为
null，asr_llm 默认 LLM 必须非空；每个 generation control 必须满足
`minimum <= default <= maximum`，integer control 的三者都必须是整数。客户端收到不满足这些
不变量的目录时不得猜测或 fallback，应把整个 revision 视为无效并停止发起请求。

能力变化后后端在 accepted 前返回 `capabilities_stale`，客户端重新获取目录并让用户确认任何
可观察选择变化。

## 7. WebSocket ticket

```http
POST /v2/realtime/tickets
Authorization: Bearer <access-token>
```

成功：

```json
{
  "request_id": "019d643e-1550-761a-b7a0-471791bcaf23",
  "data": {
    "ticket": "<opaque-one-time-ticket>",
    "expires_at_ms": 1786723230000,
    "websocket_path": "/v2/voice/ws",
    "subprotocol": "mindsurf.voice.v2"
  }
}
```

ticket 默认有效期 30 秒、只消费一次。它只认证 Upgrade，不限制 WS 的存活时间。长期连接
空闲时保持在线；断线重连必须申请新 ticket。

`RealtimeTicket.websocket_path` 是本次 ticket 建连的唯一权威路径。客户端必须使用 ticket
响应中的值，不得硬编码路径；capabilities 中的 `realtime.websocket_path` 只用于建连前预览和
诊断。路径在签发 ticket 的 HTTP API origin 上解析，生产把 https 映射为 wss，本地开发把
http 映射为 ws；响应不能改变 authority。签发 ticket 时两个路径应一致，但若能力 revision
在两次请求间变化，仍以 ticket 响应为准。

限制：

- 账户非 active：`403 account_suspended`；
- 连接数达到上限：`429 realtime_connection_limit`；
- access token 无效：`401 authentication_*`；
- ticket 服务暂不可用：`503 service_unavailable`。

## 8. HTTP 状态与稳定错误

| HTTP | code | 场景 |
|---:|---|---|
| 400 | `invalid_request` | 字段或查询参数非法 |
| 400 | `authorization_grant_invalid` | code 无效、过期、已消费、绑定不匹配或 PKCE 失败 |
| 409 | `idempotency_conflict` | 同一 Idempotency-Key 被用于不同请求 |
| 409 | `idempotency_result_expired` | refresh 原结果已不能安全重放；重新浏览器授权，不撤销 session |
| 401 | `authentication_required` | 缺少 access token |
| 401 | `authentication_failed` | refresh token 或 access token 无效 |
| 401 | `authentication_expired` | access token 过期 |
| 403 | `account_suspended` | 账户不可用 |
| 409 | `refresh_token_reused` | 检测到 refresh token 重放 |
| 429 | `rate_limit_exceeded` | HTTP 请求频率超限 |
| 429 | `realtime_connection_limit` | 长连接数达到上限 |
| 500 | `server_error` | 未分类内部错误 |
| 503 | `service_unavailable` | 临时不可用 |

浏览器认证页面不得通过页面内容、状态码、响应时长或回跳错误泄露某个邮箱是否已经注册。

## 9. 客户端检查表

- refresh token 存系统 Keychain；
- access token 只保存在内存或等价安全存储；
- 使用系统浏览器，不在客户端内嵌认证页面或采集密码；
- 每次授权生成新的 state、verifier 和 S256 challenge，并严格校验回跳 state；
- 每次 token 交换和 refresh 生成新的 Idempotency-Key，网络重试必须复用原 key；
- refresh 结果不确定时最多恢复 2 分钟；超时或结果过期后重新浏览器授权，不换 key 重放旧 token；
- code 只通过后端 token 接口交换，不放入日志或持久化；
- 授权后并行加载 me、quota、capabilities；
- 立即申请 ticket 并建立长期 WS；
- WS ready 前不开始录音；
- token 刷新不打断健康的现有 WS；
- 断线时刷新 Token、申请新 ticket、重连；
- logout 清除凭据并停止重连；
- 请求终态后异步刷新 quota；
- 不自行计算 credits。

## 10. 后端检查表

- authorize 精确校验 public client、redirect URI、state 和 S256 PKCE 参数；
- code 短时、一次消费并绑定 client、redirect URI、用户和 PKCE challenge；
- code 消费、session 创建和 token 签发原子化；
- token/refresh 幂等结果与凭据轮换原子化，并加密保存、按期清理；
- 浏览器页面负责注册、验证、账户恢复和 MFA，且不泄露账户是否存在；
- refresh token 轮换和重放检测原子化；
- refresh 幂等元数据保留到替代 refresh token 过期，原结果过期不会误撤销 session；
- ticket 一次消费和过期判断原子化；
- ticket、Token、Authorization Code、PKCE verifier 和浏览器凭据全链路日志脱敏；
- logout/禁用能够跨节点撤销长连接；
- ASR/LLM 分项 reservation 和 request accepted 使用同一事务边界；
- usage 分项结算幂等，request ID 不会重复扣费，分项之和始终等于总扣费；
- capabilities revision 与 WS request 校验一致；
- capabilities 的 ID、引用、defaults 和 generation control 不变量在发布前验证；
- ticket 响应路径是单次建连权威值；
- HTTP 和 WS 使用同一用户、额度和权限来源。

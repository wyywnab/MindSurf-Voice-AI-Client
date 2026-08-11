# Conversation 生命周期

本文档是 MindSurf Voice API v2 对话资源及跨请求上下文语义的权威定义。字段结构仍由 WebSocket JSON Schema 和 HTTP OpenAPI 定义。

## 1. 适用范围

Conversation 是后端管理的多轮上下文容器，不等同于 WebSocket session，也不等同于单次 request。

只有同时满足以下条件的请求才使用 conversation：

- `mode=assistant`；
- 所选 Pipeline 的 `features.conversation=true`。

其他请求统一不使用 conversation：

- Dictation 不创建、读取或更新 conversation；
- `features.conversation=false` 的 Assistant 不创建、读取或更新 conversation。

不使用 conversation 时，客户端必须发送 `conversation_id=null`，`request.accepted`、`request.done` 和 `request.cancelled` 也必须返回 `conversation_id=null`。

## 2. 标识符状态

对支持 conversation 的 Assistant 请求，conversation ID 在客户端有三种状态：

| 状态 | 含义 | 客户端行为 |
|---|---|---|
| `none` | 当前没有对话 | `request.start.conversation_id=null` |
| `provisional` | 后端已为新请求分配 ID，但尚无已提交轮次 | 只与当前请求绑定，不作为后续默认上下文 |
| `confirmed` | 至少一个请求已经通过 `request.done` 原子提交 | 后续同一逻辑对话复用该 ID |

`request.start.conversation_id=null` 表示请求创建新对话。后端接受请求时分配 UUID，并在 `request.accepted` 中返回；客户端先把它保存为 provisional。

只有收到该请求的 `request.done` 后，客户端才把 provisional ID 提升为 confirmed。`request.done` 是对话轮次提交的唯一确认点。

## 3. 创建与复用

### 3.1 创建

支持 conversation 的 Assistant 请求携带 `conversation_id=null` 时：

1. 后端校验 Pipeline、模型、权限和资源。
2. 后端分配 conversation ID，并将其与当前用户及初始上下文配置绑定。
3. 后端发送带该 ID 的 `request.accepted`。
4. 请求成功或部分成功完成时，后端在发送 `request.done` 前原子提交本轮。
5. 客户端收到 `request.done` 后确认并保存该 ID。

`request.accepted` 本身不表示任何用户输入或助手输出已经写入上下文。

### 3.2 普通下一轮

同一逻辑对话的下一次 Assistant 请求必须显式发送已 confirmed 的 conversation ID。后端不得根据用户、连接、最近请求或时间窗口隐式猜测对话。

以下动作开始新对话，并发送 `conversation_id=null`：

- 用户明确选择“新对话”；
- 客户端没有 confirmed conversation ID；
- 当前选择与既有 conversation 的上下文配置不兼容；
- 后端返回 `conversation_not_found`；
- 对话已通过 HTTP 删除。

协议不根据 WebSocket 断开、空闲超时或应用窗口隐藏自动结束 conversation。客户端是否跨应用重启持久化 confirmed ID 属于产品策略；若持久化，必须按敏感标识符保护，并允许用户清除。

### 3.3 打断后的下一轮

打断旧请求时，首先读取该 Pipeline 的
`features.continuation_after_interruption`：

- 值为 `supported` 或 `unvalidated`，且旧请求属于 confirmed conversation：旧请求无论
  cancelled、failed 还是与完成竞态，都继续使用此前 confirmed ID 启动下一轮；只有收到
  新的 `request.done` 才增加轮次。
- 值为 `unsupported`：显式打断后的下一请求必须发送 `conversation_id=null` 开始新对话；
  客户端可以保留旧 confirmed ID 供用户显式返回旧对话使用，但不得用于这次打断后的连续请求。
- 旧请求正在创建新 conversation 且只有 provisional ID：旧请求 cancelled 或 terminal error 后必须丢弃该 ID；下一轮发送 `conversation_id=null`。
- 旧请求以 `request.done` 结束：其 ID 已 confirmed，下一轮复用该 ID。

上述 `unsupported` 分支只适用于 `reason=user_interrupted` 的显式打断。普通取消、超时或
失败不会删除更早的 confirmed conversation，之后是否继续该旧对话仍由用户动作决定。

客户端不得把 cancelled 或 failed 请求的用户音频、部分文本或 provisional ID 当作已提交历史。

## 4. 上下文配置绑定

Conversation 创建时固定绑定：

- `pipeline`；
- `mode=assistant`；
- 原生 Pipeline 的 `selection.model`，或级联 Pipeline 的 `selection.llm`。

复用 conversation 时，上述字段必须与创建时一致。不同则后端返回请求级、`terminal=true`、`retryable=false` 的 `conversation_configuration_mismatch`。客户端可以提示用户开始新对话，但不得用相同 request ID 自动改写请求。

以下选择可以在同一 conversation 的不同轮次间变化，并由每次请求重新校验：

- 输入识别语言与 ASR；
- TTS、voice、emotion 和输出音频格式；
- 是否请求输入转写、文本或音频输出；
- 当前 Pipeline 支持的 generation 参数。

这些变化不得重写已经提交的历史轮次。

## 5. 轮次原子提交

后端必须把一次 Assistant 请求作为一个原子 turn 提交。服务端提交点定义为：后端先
原子提交 turn，再把对应的 `request.done` 写入当前 WebSocket 的有序发送队列。进入
提交点后，该 turn 必须能被使用同一 conversation ID 的下一请求观察到，即使连接在
客户端实际收到 `request.done` 前断开，也不得回滚或重复提交。

WebSocket 无法证明客户端已经收到某个已发送事件。因此，客户端在发送
`input.commit` 后、收到请求终态前断线时，必须把本次结果标记为本地
`outcome_unknown`：它不是线上消息或服务端请求状态，只表示客户端无法判断提交点
是否已经发生。为避免继续使用可能包含客户端未见 turn 的上下文，客户端不得复用
该请求关联的 conversation ID；后续 Assistant 请求必须以 `conversation_id=null`
开始新对话。版本 2 不通过重放旧 request ID 或录音来消除该不确定性。

断线后的 ID 处理固定如下：

| 断线时点 | 原 ID 状态 | 下一请求 |
|---|---|---|
| `input.commit` 前 | confirmed | 可以继续复用原 ID |
| `input.commit` 前 | provisional | 丢弃并发送 `conversation_id=null` |
| `input.commit` 后、终态前 | confirmed 或 provisional | 标记 `outcome_unknown`，丢弃关联 ID 并发送 `null` |
| 已收到 `request.done` | confirmed | 可以继续复用该 ID |
| 已收到 cancelled/terminal error | 旧 confirmed | 保留旧 ID；显式打断后的立即下一请求是否复用由 continuation 能力决定 |
| 已收到 cancelled/terminal error | provisional | 丢弃并发送 `null` |

Assistant 请求只有在至少一个助手输出流成功时才能发送 `request.done`：

- 文本成功；或
- 音频成功。

输入转写单独成功不构成可提交的 Assistant turn。若所有请求的助手输出均失败，即使输入转写成功，也必须以请求级 `terminal=true` error 结束，不得发送 `request.done`，也不得提交本轮。

`request.done(result=partial)` 提交已经成功完成的助手输出对应的完整后端语义结果：

- 文本成功、音频失败：提交用户输入与完整文本回复；
- 音频成功、文本失败或未请求：提交用户输入与后端用于生成该音频的完整助手语义结果；
- 文本和音频都成功：只提交一个助手 turn，不得重复写入。

输出是否已经在客户端本地播放不影响提交。`request.done` 后的本地打断不会截断或回滚已经提交的上下文。

## 6. 取消、失败与断线

- `request.cancelled` 不提交当前 turn。
- 请求级 `terminal=true` error 不提交当前 turn。
- 服务端尚未进入提交点时断线不提交当前 turn；进入提交点后的断线不回滚 turn。
- 上述情况不影响同一 confirmed conversation 中更早的已提交轮次。

对新建对话请求，cancelled、terminal error，或者在服务端进入提交点前断线后，后端
必须删除没有已提交轮次的 provisional conversation。`request.cancelled.conversation_id`
返回 `null`。客户端即使已经从 accepted 收到 provisional ID，也必须丢弃。若断线发生
在提交点之后，该 conversation 已经 confirmed，但客户端仍按 `outcome_unknown` 规则
丢弃本地 ID；后端可以按产品保留策略清理长期不再引用的 conversation。

对复用 confirmed conversation 的请求，`request.cancelled.conversation_id` 返回原 conversation ID；客户端继续保留它。

请求级 terminal error 不携带新的 conversation 状态。客户端根据请求开始前是否已有 confirmed ID 决定保留旧 ID或丢弃 provisional ID。

## 7. 删除与并发

`DELETE /v2/conversations/{conversation_id}` 只删除 confirmed conversation。provisional conversation 由请求生命周期自动清理，不作为客户端可管理资源。

Conversation 的 active lease 是当前用户范围内、跨所有 WebSocket 连接和设备的
全局排他租约。同一 confirmed conversation 同时最多只能有一个已接受但未终态的
请求；版本 2 不允许同一 conversation 跨连接并发执行，也不允许通过排队隐式改变
请求顺序。

active 状态从后端原子接受一个引用该 ID 的 `request.start` 开始，到该请求进入终态
或其连接关闭结束。取得 lease、另一个 WebSocket 的请求接受以及 HTTP 删除必须使用
同一串行化边界：

- 请求先取得 active lease：DELETE 返回 `409 conversation_active`；
- DELETE 先完成：请求返回 `conversation_not_found`，不得 accepted。
- 另一个请求先取得 active lease：后到的 WebSocket 请求在 accepted 前返回请求级、
  `terminal=true`、`retryable=true`、`fatal=false` 的 `conversation_active`；不得排队，
  不得读取尚未提交的 turn。

lease 必须在 `request.done` 的 turn 原子提交完成之后才释放，确保后续请求取得 lease
后能够观察上一轮；cancelled、terminal error 或断线则在确认不提交本轮后释放。

删除成功后：

- 后端必须清除上下文和索引；
- 客户端必须清除本地 confirmed ID；
- 后续携带旧 ID 的请求返回 `conversation_not_found`；
- 后端不得把已删除 ID 当作空的新 conversation 重新创建。

不存在或属于其他用户的 ID 按 HTTP 规范统一返回 `204`，但 WebSocket 复用时统一返回 `conversation_not_found`，不得泄露所有权信息。

## 8. 状态摘要

```text
request.start(conversation_id=null)
        |
        v
request.accepted(provisional ID)
        |
        +-- request.done ----------> confirmed ID + committed turn
        |
        +-- cancelled/error ------> provisional deleted, client discards ID
        +-- close before commit --> provisional deleted, client discards ID

request.start(confirmed ID)
        |
        +-- request.done ----------> same ID + one committed turn
        |
        +-- cancelled/error ------> same ID, no new turn
        +-- close before commit --> same ID, no new turn

input.commit 后、terminal 前连接关闭
        |
        +-- commit point 前 -------> no new turn
        +-- commit point 后 -------> turn may exist; client marks outcome_unknown
                                      and starts a new conversation

DELETE confirmed ID
        |
        +-- active ---------------> 409 conversation_active
        +-- inactive -------------> 204, later WS use => conversation_not_found
```

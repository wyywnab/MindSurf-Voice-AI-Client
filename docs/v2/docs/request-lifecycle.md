# Request 生命周期与流完成语义

本文档是 MindSurf Voice WebSocket API v2 跨消息顺序、流终止、部分成功和请求终态的权威定义。单条消息的字段结构由 JSON Schema 定义。

## 1. 请求状态机

```text
idle
  -> starting
      -> recording
          -> committing
              -> processing
                  -> streaming
      -> cancelling

starting/recording/committing/processing/streaming/cancelling
  -> completed | cancelled | failed
```

状态含义：

| 状态 | 起点 | 结束条件 |
|---|---|---|
| `starting` | 客户端发送 `request.start` | accepted、取消终态或 terminal error |
| `recording` | 客户端收到 `request.accepted` | 客户端发送 `input.commit` |
| `committing` | 客户端发送 `input.commit` | `input.committed` 或 terminal error |
| `processing` | 客户端收到 `input.committed` | 第一条已请求输出流事件 |
| `streaming` | 任一已请求流开始 | 所有流结束并收到请求终态 |
| `cancelling` | 客户端发送 `request.cancel` | 任一合法请求终态 |

一条连接最多有一个 starting 或尚未终态的请求。starting 也占用请求槽位。

## 2. 接受阶段

`request.accepted` 必须严格确认客户端提交的业务选择。以下字段必须与 `request.start` 一致：

- `mode`、`pipeline`、`capabilities_revision`；
- `selection`；
- `language`；
- `response`；
- start 携带时逐字段原样回显 `generation`，start 省略时也省略；
- conversation 语义所要求的既有 ID，或者为新对话分配的 provisional ID。

后端必须先确认 `capabilities_revision` 等于当前用户能力目录 revision；不一致时以请求级
terminal、retryable 的 `capabilities_stale` 拒绝，不得 accepted。版本 2 不允许后端在
accepted 中替换 Pipeline、模型、组件、language、voice、emotion、
generation 或输出格式。accepted 的 `max_recording_ms` 不是业务 fallback：它必须严格
等于客户端构造请求所依据的 HTTP Pipeline 能力值，并处于 hello 连接上限以内。能力
目录已经变化时必须在 accepted 前返回请求级 terminal `pipeline_unavailable`，不得临时
缩短上限。16 kHz 输入按
`sample_count <= floor(max_recording_ms * 16000 / 1000)` 校验，不能使用舍入后的
`duration_ms` 判断。后端 fallback 属于内部路由行为，只有在不改变客户端可观察选择和
语义时才允许。

客户端收到不符合以上规则的 accepted 时，应视为协议错误：尽力 cancel，然后以 WebSocket `1002` 关闭连接。

## 3. 输入阶段与处理屏障

客户端只有在 accepted 后才能发送 `INPUT_PCM`。

客户端发送 `input.commit` 后不得再发送输入音频。后端在完整校验 sequence、timestamp 和提交统计之前不得启动推理处理，并且在发送 `input.committed` 前不得发送以下事件：

- `input.transcript.*`；
- `assistant.text.*`；
- `output.audio.start` 或 `OUTPUT_PCM`；
- `output.audio.done`；
- 成功或部分成功的 `request.done`。

取消和 error 不受该屏障限制。

零帧请求不得 commit。用户在发送任何 PCM 前结束录音时，客户端必须发送
`request.cancel(reason=user_cancelled)`；后端以 `request.cancelled` 结束请求。

`input_empty` 专指客户端已经提交至少一帧 PCM，但后端在解码后没有检测到任何
可处理的有效语音（例如全部为静音）的情况。此时后端以请求级、
`terminal=true` 的 `input_empty` 结束请求。它不得用于代替零帧请求的取消流程。

`recording` 状态还受 hello 中 `input_idle_timeout_ms` 约束：从 accepted 起，到首个
有效 `INPUT_PCM`；以及任意两个有效 `INPUT_PCM` 之间，均不得连续空闲达到该期限。
超时以请求级、`terminal=true` 的 `input_idle_timeout` 结束并释放请求槽位。发送
`input.commit`、cancel 或任一终态会停止该计时器。

## 4. 流的开始与结束

三个逻辑输出流分别维护生命周期：

| 流 | 开始事件 | 成功结束 | 失败结束 |
|---|---|---|---|
| `input_transcription` | 首个 delta；无 delta 时 done 即开始并结束 | `input.transcript.done(stop)` | 开始后为 stream error + done(error) |
| `text` | 首个 delta；无 delta 时 done 即开始并结束 | `assistant.text.done(stop)` | 开始后为 stream error + done(error) |
| `audio` | `output.audio.start` | `output.audio.done(stop)` | start 后为 stream error + done(error) |

未请求的流不得产生任何事件，且在 `request.done.completed` 中固定为 `false`。

当后端把失败作为独立流失败处理，并继续当前请求以争取 partial 结果时，流开始前只
发送一次 `terminal=false` 的 stream error，不发送该流 done；流开始后必须严格发送：

```text
stream error(terminal=false) -> stream done(finish_reason=error)
```

done 后不得再产生该流的数据或错误。

请求级 `terminal=true` error、`request.cancelled`、会话 fatal error 和连接关闭会直接
截断所有尚未结束的流，不要求补 stream error 或 stream done。该请求级终止规则优先
于独立流失败规则。换言之，只有请求仍继续并可能以 `request.done(partial)` 结束时，
失败流才必须按上述顺序闭合。

## 5. 文本与转写一致性

### 5.1 输入转写

每个 `input.transcript.delta.text` 是完整假设。`input.transcript.done.text` 可以修改最后一个 delta 中尚未稳定的后缀，但必须逐 code point 保留最后一次声明的稳定前缀。

若 done 为 `finish_reason=stop`，其 text 是最终转写。若 done 为 `finish_reason=error`，其 text 是最后可用完整假设；没有发送过 delta 的流在开始前失败，不发送 done。

### 5.2 Assistant 文本

每个 `assistant.text.delta.delta` 是新增片段。无论成功或失败，只要发送过 delta，`assistant.text.done.text` 必须严格等于所有 delta 按 sequence 拼接的结果，`last_sequence` 必须等于最后一个 sequence。

没有发送 delta 而直接成功完成时，done 可以携带完整文本，且 `last_sequence=null`。没有发送 delta 的失败属于开始前失败，只发送 stream error。

## 6. 音频统计一致性

`output.audio.done` 必须满足：

- 发送过 PCM 时，`last_sequence = chunk_count - 1`；
- `chunk_count` 等于已发送 PCM 帧数；
- `sample_count` 等于所有 PCM payload 的样本总数；
- `duration_ms = floor(sample_count * 1000 / sample_rate + 0.5)`；
- `last_sequence`、chunk、sample 和 duration 不得为负数。

成功音频流必须至少发送一个 PCM 帧，因此 `finish_reason=stop` 时 `chunk_count > 0`。

`output.audio.start` 后、第一帧 PCM 前失败时固定为：

```json
{
  "last_sequence": null,
  "chunk_count": 0,
  "sample_count": 0,
  "duration_ms": 0,
  "finish_reason": "error"
}
```

客户端收到统计不一致时必须停止播放；若连接仍可写则尽力发送 `request.cancel(reason=protocol_error)`，不等待终态并以 `1002` 关闭连接。

## 7. 请求成功、部分成功与失败

### 7.1 Dictation

Dictation 只请求输入转写：

- transcript 成功：`request.done(result=success)`；
- transcript 失败：请求级 terminal error，不发送 `request.done`；
- Dictation 不创建或更新 conversation。

### 7.2 Assistant

Assistant 的可提交结果要求至少一个助手输出流成功：text 或 audio。输入转写是旁路结果，不能单独使 Assistant 请求成为 success 或 partial。

结果规则：

| 情况 | 请求终态 |
|---|---|
| 所有已请求流成功 | `request.done(result=success)` |
| 至少一个助手输出流成功，另有请求流失败或超时 | `request.done(result=partial)` |
| 没有助手输出流成功 | 请求级 `terminal=true` error |

对于 partial，每个已请求但未成功的流都必须出现在 `failures` 中。成功流不得出现在 `failures` 中。
每个 failure 的 `code` 和 `message` 必须严格回显该流此前的 `terminal=false` stream
error；流错误与最终 failure 不得使用两套原因。

该规则优先于请求总超时的通用错误路径。总超时到达时，若此时已经至少有一个
Assistant 输出流成功，后端按流失败规则关闭所有尚未完成的流，再发送
`request.done(result=partial)` 并原子提交本轮。若尚无任何 Assistant 输出流成功，
则直接发送请求级、`terminal=true` 的 `request_timeout`，不补 stream done，且不提交
本轮。

## 8. `request.done` 不变量

`request.done` 必须包含：

- `result`；
- `conversation_id`；
- `requested`；
- `completed`；
- `failures`；
- `usage`；
- `context`。

其中：

- `requested` 严格回显 accepted 中三个流开关；
- `completed` 的键固定为 `input_transcription`、`text`、`audio`；
- 未请求流的 completed 固定为 `false`；
- success 要求所有已请求流 completed 且 `failures={}`；
- partial 要求至少一个助手输出流 completed，且每个失败流都有 failure；
- `usage` 的每个未知或无法统计值使用 `null`，不得省略键或伪造 `0`；
- 不使用 conversation 时，`conversation_id=null` 且 `context=null`；
- 使用 conversation 时，`context` 必须包含提交本轮后的 `retained_turns` 和 `dropped_turns` 非负整数。

`request.done` 只能在所有已请求流均已成功结束或按失败规则关闭后发送，并且必须是该请求最后一条事件。

## 9. 取消竞态

客户端发送 cancel 后进入 cancelling，但仍必须接受最先到达的任一合法终态：

- `request.cancelled`；
- `request.done`；
- 请求级 `terminal=true` error。

后端按消息顺序处理 cancel。处理 cancel 后不得发送 accepted 或新的流数据；cancel 处理前已经完成并进入发送队列的合法终态可以赢得竞态。

终态只能有一个。后端发送任一终态后，不得再为同一 request ID 响应迟到的 cancel、超时或上游事件。

## 10. 终态与迟到事件

终态包括：

- `request.done`；
- `request.cancelled`；
- 请求级 `terminal=true` error。

后端发送终态后必须释放请求槽位和请求快照。客户端收到终态后可以开始新的 request；同 request ID 的后续事件必须忽略并记录。

若连接在终态前关闭，后端必须取消尚未进入 conversation 提交点的内部工作并释放
资源；录音和请求不得自动重放。客户端在发送 `input.commit` 前断线时把请求标记为
failed；发送 commit 后、收到终态前断线时按 [`conversations.md`](./conversations.md)
标记为本地 `outcome_unknown`，并且不得继续复用该请求关联的 conversation ID。

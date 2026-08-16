# Request 生命周期与临时文本语义

本文档是 WebSocket v2 对请求状态、临时文本更新、最终覆盖和目标提交的权威定义。

## 1. 状态机

```text
idle
  -> starting
      -> recording                 # request.accepted；ASR 可并行流式处理
          -> committing
              -> processing_asr_final
                  -> processing_llm   # 仅 asr_llm
                      -> ready_to_commit
      -> cancelling

starting/recording/committing/processing_asr_final/processing_llm/ready_to_commit/cancelling
  -> completed | cancelled | failed
```

一条长期连接最多只有一个 starting 或尚未终态的请求。请求终态后连接回到 idle，连接本身
保持在线。

## 2. 两种模式

- `asr_only`：音频经过 ASR，最终 ASR 文本就是请求结果。
- `asr_llm`：音频先经过 ASR，再把完整 ASR 文本交给 LLM，最终 LLM 文本才是请求结果。

两种模式都通过同一组 `output.text.*` 事件更新同一块客户端临时文本区域。协议不把 ASR
文本和 LLM 文本建模成两个独立输出流。

## 3. 接受和输入

`request.accepted` 必须原样确认 request.start 的 `mode`、`pipeline`、
`capabilities_revision`、`selection`、`language` 和可选 generation。接受前必须校验能力
revision、Pipeline mode、ASR/LLM 选择、language、generation、request ID 唯一性、连接请求
槽位和额度预留。request ID 在账户范围永久不可复用；检测到复用时返回请求级 terminal
`request_id_reused`，并且不得创建 reservation 或启动任何阶段。

客户端只有在 accepted 后才能发送 INPUT_PCM。发送 `input.commit` 后不得继续发送音频。
后端可以在 recording 阶段一边接收 INPUT_PCM，一边产生 ASR delta 和用于纠错的
`final=false` ASR snapshot。发送 `input.committed` 前不得发送本请求的最终 ASR snapshot、
启动 LLM 或发送任何 LLM 输出。

accepted 超时或用户主动取消时，客户端可以在 starting 阶段发送 `request.cancel`。发送后
立即停止音频且不得 commit；后端仍按取消竞态选择唯一终态。accepted 超过 3 秒时客户端
发送 `request.cancel(reason=client_timeout)`，再等待 2 秒仍无终态则关闭连接并按断线处理。

## 4. 临时文本区域

客户端为当前请求维护一块临时文本区域：

- `output.text.delta`：把 delta 追加到当前 stage 的临时区域；
- `output.text.snapshot`：用完整 text 原子覆盖临时区域；
- ASR 和 LLM 各自维护独立的 delta sequence，均从 0 连续递增，snapshot 不重置 sequence；
- asr_llm 的第一条 LLM 事件必须是
  `output.text.snapshot(stage=llm, text="", final=false)`；客户端收到它时原子清空 ASR
  临时文本并切换到 LLM stage，后续 LLM delta 追加到空区域；
- 请求结束前，临时区域不得写入用户当前聚焦的真实目标；
- 只有 `final=true` 的 snapshot 后，同一 request ID 的下一条请求级事件是合法
  `request.done`，客户端才把临时区域全文一次性写入真实目标；request_id=null 的心跳等
  会话消息可以穿插；
- request.done.final_text 必须等于最后一条 `final=true` snapshot 的 text；
- cancelled、terminal error 或断线都不得提交临时区域。

ASR streaming 可以是真流式、伪流式或非流式实现。非流式 ASR 可以在录音期间不产生任何
输出，并在 input.committed 后直接发送完整 ASR snapshot；客户端不得依据更新频率推断模型
类型。

## 5. `asr_only` 时序

```text
request.start(mode=asr_only)
request.accepted
INPUT_PCM... <-> output.text.delta(stage=asr)*
             <-> output.text.snapshot(stage=asr, final=false)*
input.commit
input.committed
output.text.delta(stage=asr)*
output.text.snapshot(stage=asr, final=false)*
output.text.snapshot(stage=asr, final=true)
request.done(mode=asr_only)
client commits temporary text to target
```

ASR delta 允许用户在录音期间看到文本；ASR 可以随时用 `final=false` snapshot 修订已经展示
的假设。`input.committed` 后必须发送且只能发送一条 `final=true` 的完整 ASR snapshot，覆盖
流式拼接可能存在的标点、分词或识别修订差异。该 final snapshot 发出后仍遵守下一条请求级
服务端事件只能是 request.done 的终态锁定规则。

`selection.llm` 必须为 null，generation 必须省略。

## 6. `asr_llm` 时序

```text
request.start(mode=asr_llm)
request.accepted
INPUT_PCM... <-> output.text.delta(stage=asr)*
             <-> output.text.snapshot(stage=asr, final=false)*
input.commit
input.committed
output.text.delta(stage=asr)*
output.text.snapshot(stage=asr, final=false)  # commit 后的完整 ASR 收口
backend runs LLM with complete ASR text
output.text.snapshot(stage=llm, text="", final=false)
output.text.delta(stage=llm)*
output.text.snapshot(stage=llm, final=true)
request.done(mode=asr_llm)
client commits temporary text to target
```

asr_llm 的所有 ASR snapshot 都必须使用 `final=false`，客户端不得据此写入真实目标。
`input.committed` 后至少发送一次完整 ASR snapshot；LLM stage 切换前的最后一条 ASR 事件
必须是 snapshot，它的全文是交给 LLM 的权威输入。后端只能在该 snapshot 发出后启动 LLM，
此后不得再发送 ASR 事件。

第一条 LLM 事件必须是 text 为空且 final=false 的 stage 切换 snapshot。LLM delta 的 sequence
随后从 0 连续递增。LLM 处理完成后必须发送一次完整 `final=true` snapshot，纠正流式拼接差异
并作为 request.done.final_text 的唯一来源。即使上游 LLM 只能整段返回，也必须先发送空的
stage 切换 snapshot，再发送最终 snapshot；客户端不需要区分流式和非流式上游。

`selection.llm` 必须为非空。LLM 只能在完整 ASR snapshot 产生后启动。

## 7. 成功和失败

`request.done` 只表示完整流程成功：

- asr_only：成功 ASR snapshot 已发送且 final=true；
- asr_llm：commit 后完整 ASR snapshot、LLM stage 切换和 LLM final snapshot 均已发送；
- final_text 与 final snapshot 严格一致；
- usage 已完成结算。

v2 不定义 partial，也不在 asr_llm 的 LLM 失败时自动降级提交 ASR 文本：

- ASR 失败：请求级 terminal `asr_failed`；
- LLM 失败：请求级 terminal `llm_failed`；
- 任一失败都保留临时区域仅供状态展示，不得写入真实目标；
- 用户若想使用 ASR 文本，应重新选择 asr_only 发起新请求，客户端不得自动改变模式。

## 8. 额度

accepted 前分别计算 ASR 和 LLM 润色的最大费用，并在同一原子操作中完成两项预留；任一
分项无法预留都不得 accepted。终态分别结算实际执行的阶段，并释放每项剩余额度：

- `asr_credits_charged` 只包含 ASR 阶段费用；
- `llm_credits_charged` 只包含 LLM 润色阶段费用；
- 合计必须满足 `credits_charged = asr_credits_charged + llm_credits_charged`；
- `asr_only` 的 LLM 用量和费用固定为 0；
- LLM 尚未开始即取消或失败时，不得收取 LLM 费用；LLM 已开始后失败，可以按实际资源收费；
- 每个分项的最终扣费不得超过 accepted 中对应的 `quota_reservation` 分项。

`request.done`、`request.cancelled` 和请求级 terminal error 都必须返回最终 usage。HTTP
`GET /v2/quota` 是余额权威来源。

## 9. 取消竞态

后端发送 final=true snapshot 前必须原子锁定 success 终态和最终 usage；因此 final snapshot
发出后下一条请求级事件只能是 request.done，不能再改为 cancelled 或 failed。

发送 cancel 后，客户端立即且永久撤销本地提交资格，并接受最先到达的一个合法终态：
request.cancelled、request.done 或请求级 terminal error。终态只能有一个；终态之后同
request ID 的事件忽略并记录。cancel 可在 request.start 后、服务端锁定 success 终态前参与
竞态；客户端观察不到锁定点，因此 final snapshot 后发出的 cancel 合法但必然输掉竞态，后端
继续发送 request.done。客户端发送 cancel 后不得继续发送音频或 input.commit，即使最终收到
done 也不得把文本写入真实目标。

## 10. 断线

活跃请求期间断线时，不恢复、不重放录音和 request ID。客户端丢弃提交资格，临时区域
不得写入真实目标；后端取消工作并结算实际用量。客户端申请新 ticket 恢复长期连接后，
由用户以新 request ID 重新发起请求。

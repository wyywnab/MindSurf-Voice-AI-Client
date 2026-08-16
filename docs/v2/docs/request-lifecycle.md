# Request 生命周期与临时文本语义

本文档是 WebSocket v2 对请求状态、临时文本更新、最终覆盖和目标提交的权威定义。

## 1. 状态机

```text
idle
  -> starting
      -> recording                 # request.accepted
          -> committing
              -> processing_asr
                  -> processing_llm   # 仅 asr_llm
                      -> ready_to_commit
      -> cancelling

starting/recording/committing/processing_asr/processing_llm/ready_to_commit/cancelling
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
后端完整校验音频统计并发送 `input.committed` 后，才能产生文本输出。

accepted 超时或用户主动取消时，客户端可以在 starting 阶段发送 `request.cancel`。发送后
立即停止音频且不得 commit；后端仍按取消竞态选择唯一终态。accepted 超过 3 秒时客户端
发送 `request.cancel(reason=client_timeout)`，再等待 2 秒仍无终态则关闭连接并按断线处理。

## 4. 临时文本区域

客户端为当前请求维护一块临时文本区域：

- `output.text.delta`：把 delta 追加到临时区域；
- `output.text.snapshot`：用完整 text 原子覆盖临时区域；
- 请求结束前，临时区域不得写入用户当前聚焦的真实目标；
- 只有 `final=true` 的 snapshot 后，同一 request ID 的下一条请求级事件是合法
  `request.done`，客户端才把临时区域全文一次性写入真实目标；request_id=null 的心跳等
  会话消息可以穿插；
- request.done.final_text 必须等于最后一条 `final=true` snapshot 的 text；
- cancelled、terminal error 或断线都不得提交临时区域。

`output.text.delta.sequence` 从 0 连续递增。所有 delta 都属于 ASR 流式阶段。

## 5. `asr_only` 时序

```text
request.start(mode=asr_only)
request.accepted
INPUT_PCM...
input.commit
input.committed
output.text.delta(stage=asr)*
output.text.snapshot(stage=asr, final=true)
request.done(mode=asr_only)
client commits temporary text to target
```

ASR 流式 delta 让用户尽早看到文本。ASR 完成时必须发送一次完整 snapshot，覆盖流式拼接
可能存在的标点、分词或识别修订差异。

`selection.llm` 必须为 null，generation 必须省略。

## 6. `asr_llm` 时序

```text
request.start(mode=asr_llm)
request.accepted
INPUT_PCM...
input.commit
input.committed
output.text.delta(stage=asr)*
output.text.snapshot(stage=asr, final=false)
backend runs LLM with complete ASR text
output.text.snapshot(stage=llm, final=true)
request.done(mode=asr_llm)
client commits temporary text to target
```

ASR snapshot 只是中间检查点，必须使用 `final=false`，客户端不得据此写入真实目标。LLM
处理完成后发送第二次全量 snapshot，原子覆盖同一临时区域，并使用 `final=true`。

当前 v2 不定义 LLM delta；LLM 阶段只发送最终全量覆盖。以后若要增加 LLM 流式输出，需要
经过能力协商或协议升级，不能把 ASR delta 的 stage 偷换为 LLM。

`selection.llm` 必须为非空。LLM 只能在完整 ASR snapshot 产生后启动。

## 7. 成功和失败

`request.done` 只表示完整流程成功：

- asr_only：成功 ASR snapshot 已发送且 final=true；
- asr_llm：ASR 中间 snapshot 和 LLM final snapshot 均已发送；
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

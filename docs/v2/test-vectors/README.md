# v2 协议测试向量

- manifest 固定 5 种客户端和 9 种服务端消息；
- invalid-messages 覆盖 ticket 后 hello、两种 mode、snapshot 和终态；
- browser-authorization 覆盖系统浏览器回跳、state、PKCE、绑定校验和 code 一次消费；
- auth-idempotency 覆盖 token/refresh 同 key 结果恢复、key 冲突和 refresh 重放；
- session-parameters 覆盖单 outstanding ping 所需的 heartbeat interval/timeout 关系；
- mode-pipeline-requests 覆盖能力 ID/引用/defaults 不变量，以及 revision、Pipeline mode、
  ASR/LLM、language 和 generation 选择；
- billing-usage 覆盖 ASR/LLM 分项预留、分项扣费、合计不变量和 asr_only 零 LLM 费用；
- request-lifecycles 覆盖录音期间 ASR 更新、ASR/LLM 分阶段 sequence、LLM stage 切换、
  snapshot/done 顺序、心跳穿插、final/cancel 竞态和唯一终态；
- audio-frames 覆盖上行 INPUT_PCM 的时间戳、连续 sequence 和 commit 统计，v2 不定义下行音频。

运行 `npm run validate:protocol-v2`。通过只代表协议资产内部一致，不代表实现已经兼容。

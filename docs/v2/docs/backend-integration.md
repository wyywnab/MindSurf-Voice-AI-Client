# 后端仓库接入与交接

## 1. 仓库边界

本仓库维护客户端和后端之间的 v2 契约。绿色协议 CI 只证明 OpenAPI、Schema、文档示例
和固定向量一致，不证明任一后端实现已经兼容。

后端必须固定不可变 commit SHA，并读取：

- `openapi/openapi.yaml`；
- `schemas/client-messages.schema.json`；
- `schemas/server-messages.schema.json`；
- `docs/WS_PROTOCOL_V2.md`；
- `docs/request-lifecycle.md`；
- `test-vectors/`。

## 2. 后端 CI 门禁

至少覆盖：

1. 系统浏览器 authorize、PKCE code 交换、注册/登录网页、refresh 轮换、refresh 重放、
   logout 和 session 撤销；
2. quota 查询、ASR/LLM 分项 reservation、成功/取消/失败分项结算和幂等扣费；
3. ticket 过期、一次消费、重复消费、连接上限和日志脱敏；
4. 长期 WS 空闲保持、心跳超时、服务端 draining 和跨节点撤销；
5. asr_only 录音期间的 ASR delta/修订 snapshot、commit 后最终 snapshot 和目标提交；
6. asr_llm 的完整 ASR 收口、空 LLM stage 切换 snapshot、LLM delta、LLM 最终 snapshot，
   以及 LLM 失败不提交；
7. capabilities stale、Pipeline/mode/selection 交叉校验；
8. 输入二进制帧 decode/encode 逐字节回环；
9. commit 统计按实际帧重算，时间戳、sequence 或统计不一致时稳定失败；
10. success 终态锁定先于 final snapshot；final snapshot 与 done 之间允许心跳，但不允许同请求的其他事件；
11. starting 阶段取消、accepted 超时和取消/完成竞态只有一个终态；
12. 会话级与请求级 error 的 request_id、terminal、fatal 和 close code 完全符合错误矩阵；
13. 活跃请求断线不恢复、不重放且正确结算；
14. 普通请求终态后连接保持可复用。
15. 所有请求终态的 ASR/LLM 分项费用之和等于总费用，且各分项不超过对应 reservation；
16. token/refresh 相同 Idempotency-Key 可恢复原结果，不同请求复用 key 稳定冲突；
17. request ID 在账户范围永久不可复用，重复 ID 不会创建 reservation 或重复扣费；
18. Upgrade 错误状态、ticket 消费点和 101 结果不确定场景符合协议矩阵。

## 3. 交付流程

1. 更新语义文档、OpenAPI、Schema 和测试向量；
2. 运行本仓库协议校验；
3. 记录完整 commit SHA 和兼容性变化；
4. 后端固定 revision 并运行自己的实现级 CI；
5. 使用真实客户端完成浏览器授权回跳、Token 交换、长连接、连续多请求、额度和重连联调；
6. 双方确认并固定冻结 revision；冻结后不再接受 v2 不兼容变更。

禁止从可变分支静默同步协议后直接发布。

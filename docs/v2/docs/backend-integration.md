# 后端仓库接入与交接

## 1. 仓库边界

当前仓库是 MindSurf Voice 客户端仓库。`docs/v2/` 中的文件定义跨端协议，但本仓库的 CI 只验证：

- OpenAPI、JSON Schema、文档样例和测试向量彼此一致；
- 客户端自己的 v2 codec、状态机和行为（实现后）；
- 协议资产变更没有破坏客户端构建。

本仓库的绿色 CI **不代表后端实现兼容 v2**。后端必须在自己的仓库建立独立的契约和集成测试，不能把客户端仓库的 CI 当作后端发布门禁。

## 2. 交付给后端的内容

每次交付必须给出不可变的 Git tag 或 commit SHA，后端固定该 revision，并读取以下资产：

| 资产 | 后端用途 |
|---|---|
| [`openapi/openapi.yaml`](../openapi/openapi.yaml) | 校验 HTTP 路由、请求响应和错误状态 |
| [`schemas/client-messages.schema.json`](../schemas/client-messages.schema.json) | 校验入站 WS JSON |
| [`schemas/server-messages.schema.json`](../schemas/server-messages.schema.json) | 校验出站 WS JSON |
| [`docs/WS_PROTOCOL_V2.md`](./WS_PROTOCOL_V2.md) | 实现二进制布局、时序、超时和关闭语义 |
| [`docs/request-lifecycle.md`](./request-lifecycle.md) | 实现请求状态机和部分成功规则 |
| [`docs/conversations.md`](./conversations.md) | 实现 conversation 创建、提交和清理 |
| [`test-vectors/`](../test-vectors/) | 运行跨语言固定正反例 |

如果后端复制协议文件而不是以 submodule、制品包或下载步骤固定它们，后端仓库还应提交一份来源锁定文件，例如：

```json
{
  "repository": "MindSurf-Voice-AI-Client",
  "revision": "<full-commit-sha>",
  "path": "docs/v2",
  "protocol_version": 2
}
```

禁止从可变分支的最新提交静默同步后直接发布。

## 3. 后端自己的 CI 门禁

后端仓库至少应包含以下任务：

1. 对照 OpenAPI 检查 HTTP 实现，并覆盖每个 operation 的成功响应与稳定错误码。
2. 用客户端消息 Schema 拒绝非法入站 JSON，用服务端消息 Schema 校验所有出站 JSON。
3. 对二进制测试向量执行 decode → 字段断言 → encode，并要求合法帧逐字节回环一致。
4. 执行请求时序测试：成功、取消、超时、断连、partial、capabilities revision 过期、
   不透明 Pipeline ID 到 kind 的同 revision 解析、非流式文本、打断连续性三态、
   conversation provisional 清理和已提交上下文。
5. 执行 HTTP 资源状态测试：音色克隆能力关闭、情绪参考版本关闭，以及自建音色从
   processing 到 ready/failed 的基准 ID、默认情绪和 supported emotions 原子转换。
6. 用真实客户端或版本固定的客户端 Mock 做至少一次端到端握手、音频上传、完成和取消测试。

协议资产自检脚本可以复制或封装，但它不能替代这些实现级测试。

## 4. 变更和验收流程

协议变更建议按以下顺序交接：

1. 客户端仓库更新语义文档、机器契约和测试向量，协议 CI 通过。
2. 记录 commit SHA，并在交接说明中列出兼容性影响和待实现项。
3. 后端仓库更新其锁定 revision，在自己的分支完成实现与 CI。
4. 客户端固定后端候选版本完成联调验收。
5. 双方确认后再将 Draft 标记为可发布版本。

任何一方新增字段时都应遵守向前兼容规则；修改必填字段、终态语义、错误含义或二进制布局时不能只更新单方实现。

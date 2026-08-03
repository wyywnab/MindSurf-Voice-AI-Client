# MindSurf Voice Mock

MindSurf Voice AI Phase 1 的独立本地 WebSocket mock 服务。它不执行真实 ASR、LLM 或 TTS 推理，只用于验证客户端协议和状态机。M4 使用同目录的 `mock_audio.m4a`，服务启动时通过 `ffmpeg` 解码为 24 kHz 单声道 PCM16，再按 80 ms 分片流式发送。测试文件以 40 ms 间隔下发，模拟 TTS 持续产生前置播放缓冲，避免本机定时器抖动造成假性欠载。

## 启动

```powershell
npm install
npm start
```

运行环境需要能从 `PATH` 调用 `ffmpeg`。

默认监听：

```text
ws://127.0.0.1:8000/v1/voice/ws
```

可以通过 `PORT` 环境变量修改端口。

设置 `MOCK_AUTH_TOKEN` 后，Mock 要求 `client.hello.auth` 携带对应 Bearer Token。`MOCK_EXPIRED_TOKEN` 可指定用于触发 `token_expired` 的测试 Token。

## M4 故障注入

默认启动保持正常协议路径：

```bash
npm start
```

M4 故障注入通过 `--fault`（逗号分隔）或 `MOCK_FAULTS` 选择，延迟类场景通过 `--fault-delay-ms` 或 `MOCK_FAULT_DELAY_MS` 设置毫秒数：

```bash
node server.mjs --fault asr_final_missing,request_done_missing
node server.mjs --fault llm_first_token_delay --fault-delay-ms 20000
node server.mjs --help
```

稳定场景名包括握手延迟/超时、三类鉴权错误、请求接受/提交超时、ASR final 缺失、LLM 首 Token 延迟、TTS 中途失败、处理中断线、重复事件、过期请求、未知消息、乱序控制消息、损坏音频、`request.done` 提前/缺失和取消确认超时。测试命令同时运行配置契约测试与正常协议集成测试：

```bash
npm test
```

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

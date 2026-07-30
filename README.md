# MindSurf Voice AI Client

This is the Windows and macOS client for the MindSurf Voice AI project.

本仓库包含客户端及联调用 Mock 服务。客户端基于 Tauri 2、Vue 3 和 TypeScript，负责录音、服务通信、交互展示、文本注入和音频播放。

## 主要功能

- 听写、助手和混合模式
- 全局按住说话快捷键
- ASR、LLM 文本流式展示
- TTS 音频流式播放
- Windows/macOS 光标位置文本注入
- WebSocket 协议接入
- 用于开发联调的本地 Mock 服务

## 目录

```text
mindsurf-voice-ai/       Tauri 桌面客户端
mindsurf-voice-mock/     本地 WebSocket Mock 服务
docs/DELIVERY.md         客户端交付说明
docs/WS_PROTOCOL.md      WebSocket 接口说明
docs/PHASE1_IMPLEMENTATION.md
```

## 本地运行

需要准备 Node.js 22+、Rust stable 和 `ffmpeg`。Windows 还需要 WebView2；
macOS 需要 Xcode Command Line Tools 及 macOS 10.15 或更高版本。

客户端不会自动启动 Mock 服务。请按照当前平台分别启动 Mock 和客户端。

### Windows

在仓库根目录启动 Mock 服务：

```powershell
Set-Location .\mindsurf-voice-mock
npm install
npm start
```

再打开一个 PowerShell 窗口，在仓库根目录启动客户端：

```powershell
Set-Location .\mindsurf-voice-ai
npm install
npm run tauri dev
```

### macOS

在仓库根目录启动 Mock 服务：

```bash
cd mindsurf-voice-mock
npm install
npm start
```

再打开一个终端窗口，在仓库根目录启动客户端：

```bash
cd mindsurf-voice-ai
npm install
npm run tauri dev
```

Mock 服务默认地址：

```text
ws://127.0.0.1:8000/v1/voice/ws
```

Windows 默认按住 `Ctrl + Win`，macOS 默认按住
`Control + Command` 录音；松开后提交，按 `Escape` 取消。

macOS 首次使用时需要授予麦克风、辅助功能和输入监控权限。辅助功能用于
文本注入，输入监控用于全局按住说话快捷键；可以在客户端设置页检查并打开
对应的“隐私与安全性”面板。

交付情况见 [`docs/DELIVERY.md`](./docs/DELIVERY.md)。

# MindSurf Voice AI Client

This is the Windows and macOS client for the MindSurf Voice AI project.

本仓库包含客户端及联调用 Mock 服务。客户端基于 Tauri 2、Vue 3 和 TypeScript，负责录音、服务通信、交互展示、文本注入和音频播放。

## 主要功能

- 听写、助手和混合模式
- 全局按住说话快捷键
- 可实际按键录入并校验冲突、失败自动回滚的全局快捷键配置
- ASR 与 LLM 文本流式展示
- TTS 音频流式播放
- Windows SendInput / macOS Accessibility API 光标位置 Unicode 文本注入
- 可新建、复制、切换和删除的 WebSocket 服务档案、自动连接和连通性测试
- Bearer Token AES-256-GCM 加密存储与应用层鉴权
- Windows/macOS 多麦克风输入、识别语言、语音回复、音色和播放音量设置
- 请求关键节点时间线、完整运行摘要和可按时间/级别/模块筛选的结构化运行日志
- 默认排除正文、音频和凭据的脱敏诊断 ZIP 导出
- 请求状态机、协议事件路由和 Controller 编排的架构重构
- Mock 故障注入与集成测试覆盖 19 类异常场景
- 用于开发联调的本地 WebSocket Mock 服务

## 目录

```text
mindsurf-voice-ai/       Tauri 桌面客户端
mindsurf-voice-mock/     本地 WebSocket Mock 服务
docs/DELIVERY.md         客户端交付说明
docs/WS_PROTOCOL.md      WebSocket 接口说明
docs/MACOS.md            macOS 适配说明
docs/PHASE1_IMPLEMENTATION.md
docs/PHASE2_IMPLEMENTATION.md
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

开发环境可为 Mock 启用 Token 鉴权：

```powershell
$env:MOCK_AUTH_TOKEN = "dev-token"
npm start
```

```bash
MOCK_AUTH_TOKEN=dev-token npm start
```

客户端可在设置中保存同一 Token。Token 不写入明文配置，远程服务地址必须使用 `wss://`；`ws://` 仅允许本机回环地址。

Windows 默认按住 `Ctrl + Win`，macOS 默认按住
`Control + Command + Space` 录音；松开后提交，按 `Escape` 取消。

macOS 首次使用时需要授予麦克风和辅助功能权限。辅助功能用于文本注入；全
局按住说话快捷键使用系统 Carbon 热键 API，不依赖"输入监控"权限。可以在
客户端权限页检查并打开对应的"隐私与安全性"面板。启动时如有核心权限未
授权或快捷键未就绪，客户端会默认进入权限页；点击"初始化系统权限"即可
按顺序完成授权和实际录音能力检查。

交付情况见 [`docs/DELIVERY.md`](./docs/DELIVERY.md)。

# MindSurf Voice AI 客户端交付说明

> 更新日期：2026-07-30
> 交付范围：Phase 1 Windows/macOS 客户端及联调 Mock

## 1. 交付定位

本仓库交付 MindSurf Voice AI 系统中的客户端，负责用户交互、麦克风采集、音频上传、结果展示、文本注入和语音播放。

仓库中的 Mock 服务用于客户端开发和接口验证。

## 2. 技术栈

| 模块 | 技术 |
|---|---|
| 桌面框架 | Tauri 2、Rust 2021 |
| 前端 | Vue 3、TypeScript、Vite |
| 原生桌面能力 | Windows API、macOS CoreGraphics/AppKit、全局快捷键、文本注入 |
| 音频处理 | Web Audio API、重采样、PCM16 编码与分帧 |
| 通信协议 | WebSocket、自定义 `mindsurf.voice.v1` 协议 |
| 本地 Mock | Node.js、`ws`、FFmpeg |
| 工程质量 | Vitest、ESLint、Prettier、vue-tsc、Cargo |

## 3. 客户端功能介绍

客户端提供三种工作模式：

| 模式 | 说明 |
|---|---|
| 听写模式 | 将语音识别为文字，并注入当前光标位置 |
| 助手模式 | 将语音作为问题，流式展示并播放助手回复 |
| 混合模式 | 同时保留识别文本和助手回复 |

默认按住 `Ctrl + Win` 开始录音，松开后提交；按 `Escape` 可以取消当前请求。客户端还提供连接状态、录音悬浮窗、音量反馈、系统托盘和快捷键设置。

![客户端主界面](./images/image1.png)

![录音悬浮窗](./images/imgae2.png)

## 4. 客户端已实现

- Tauri + Vue 桌面应用基础框架。
- 听写、助手、混合三种模式及状态管理。
- 麦克风采集、音量计算、16 kHz 单声道 PCM16 重采样与分帧。
- WebSocket 握手、控制消息、二进制音频帧、心跳、超时和自动重连。
- ASR 与 LLM 文本的流式接收和展示。
- TTS 音频分片缓冲、连续播放和停止。
- Windows 全局按住说话快捷键及快捷键配置。
- Windows Unicode 文本注入。
- macOS 全局按住说话快捷键、Unicode 文本注入及权限引导。
- macOS 跨 Space 非激活悬浮窗、菜单栏托盘和多显示器定位。
- 录音悬浮窗、系统托盘、权限和错误提示。
- 请求提交、取消及断线后的状态清理。
- 遵循当前协议的本地 Mock 服务及测试音频输出。
- 前端音频、协议、录音、快捷键、文本注入和 WebSocket 单元测试。

## 5. 客户端待实现

- 完善鉴权、`wss://` 和生产环境配置。
- 继续优化界面、悬浮窗和快捷键交互。
- 按需求进行 Linux 跨平台适配。
- 接入正式服务地址，替换本地 Mock。
- 配置正式升级服务地址和更新签名公钥。
- 使用正式 Apple Developer 凭据完成签名、公证及发布验证。

## 6. 交付内容

```text
mindsurf-voice-ai/       		Windows Tauri 客户端源码
mindsurf-voice-mock/     		客户端联调用 WebSocket Mock
README.md                		项目启动说明
docs/WS_PROTOCOL.md           	WebSocket 协议
docs/PHASE1_IMPLEMENTATION.md 	Phase 1 实现基线
```

运行方法及环境要求见 [`README.md`](../README.md)，接口说明见 [`WS_PROTOCOL.md`](./WS_PROTOCOL.md)。

# MindSurf Voice AI Client

MindSurf Voice AI 的 Windows/macOS 桌面客户端与 Voice API v2 本地联调服务。客户端基于
Tauri 2、Vue 3 和 TypeScript，提供录音、`asr_only` / `asr_llm` 单轮文本处理、临时文本展示、
一次性文本注入、全局按住说话快捷键、悬浮窗、系统托盘和脱敏诊断。

当前协议只提供文本结果，不包含多轮对话或下行音频。系统浏览器登录、HTTP 账户/额度/能力、
一次性 realtime ticket 和长期 WebSocket 均遵循冻结的 [Voice API v2](./docs/v2/README.md)。

## 目录

```text
mindsurf-voice-ai/       Tauri 桌面客户端
mindsurf-voice-mock/     HTTP + ticket + WebSocket v2 本地 Mock
docs/v2/                 冻结的 OpenAPI、JSON Schema、协议和测试向量
docs/DELIVERY.md         当前交付状态与待人工验收项
docs/MACOS.md            macOS 权限、构建和发布说明
```

## 环境要求

- Node.js 22+
- Rust stable
- Windows 10/11 + WebView2，或 macOS 10.15+
- macOS 构建需要 Xcode Command Line Tools

Mock 不再依赖 FFmpeg。

## 本地联调

先启动 Mock：

```bash
cd mindsurf-voice-mock
npm ci
npm start
```

Mock 默认监听 `http://127.0.0.1:8000`，提供：

- `/v2/auth/*` PKCE、token 交换/轮换和登出；
- `/v2/users/me`、`/v2/quota`、`/v2/usage`、`/v2/capabilities`；
- `/v2/realtime/tickets` 与 ticket 指定的 `/v2/voice/ws`；
- `mindsurf.voice.v2` 长连接、心跳和两种请求模式。

另开终端启动客户端：

```bash
cd mindsurf-voice-ai
npm ci
npm run tauri dev
```

在客户端账户页把 Voice API origin 设置为 `http://127.0.0.1:8000`，然后点击登录。本地 Mock
会立即完成浏览器授权并回跳应用，无需输入真实账户或密码。

Windows 默认按住 `Ctrl + Win`，macOS 默认按住 `Control + Command + Space` 录音；松开提交，
按 `Escape` 取消。macOS 首次使用需授予麦克风和辅助功能权限。

故障注入和接口说明见 [Mock README](./mindsurf-voice-mock/README.md)。

## 质量检查

```bash
npm run validate:protocol-v2

cd mindsurf-voice-mock
npm test

cd ../mindsurf-voice-ai
npm run check
npm run build

cd src-tauri
cargo fmt --all -- --check
cargo check
cargo test
```

跨平台系统浏览器回跳、Keychain、原生录音、快捷键、悬浮窗和文本注入仍需在对应操作系统上
按 [交付清单](./docs/DELIVERY.md) 人工签收。

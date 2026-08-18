# MindSurf Voice AI Client

作为 MindSurf 项目的前端部分，MindSurf Voice AI 提供面向 Windows 和 macOS 的语音输入桌面客户端，基于 Tauri 2、Vue 3 和 TypeScript。当前版本为 `0.2.0`，与后端的对接协议版本为 `v2`，支持语音识别、LLM 润色、文本注入、全局按住说话快捷键、登录自启动、悬浮窗和系统托盘。

Voice API v2 只返回单轮文本结果，不包含多轮对话或服务端下行音频。协议、接口和请求生命周期的权威入口为 [docs/v2](./docs/v2/README.md)。

## 快速联调

### 环境

- Node.js 22+
- Rust stable + Cargo
- macOS 10.15+：Xcode Command Line Tools
- Windows 10/11：Microsoft C++ Build Tools（“使用 C++ 的桌面开发”）和 WebView2

完整系统依赖见 [Tauri 2 Prerequisites](https://v2.tauri.app/start/prerequisites/)。

### 安装依赖

在仓库根目录一次性安装三个工作区的依赖：

```bash
npm ci
npm --prefix mindsurf-voice-mock ci
npm --prefix mindsurf-voice-ai ci
```

- 根目录依赖用于校验冻结协议；
- `mindsurf-voice-mock` 是本地 HTTP + WebSocket v2 服务；
- `mindsurf-voice-ai` 是 Tauri 桌面客户端。

Mock 不依赖 FFmpeg，也不需要真实 ASR、LLM、数据库或用户账户。

### 启动服务和客户端

终端 1：

```bash
cd mindsurf-voice-mock
npm start
```

终端 2：

```bash
cd mindsurf-voice-ai
npm run tauri dev
```

Mock 默认监听 `http://127.0.0.1:8000`。首次 Rust 编译耗时会稍长；完成后客户端会自动打开。只运行 `npm run dev` 是浏览器 UI 预览，原生录音、托盘、快捷键、凭据存储和文本注入等能力不可用。

### 完成本地登录

1. 确认客户端 Voice API origin 为 `http://127.0.0.1:8000`；
2. 点击登录，在系统浏览器打开 Mock 授权页；
3. 点击“登录并授权”；
4. 在成功页点击“打开 MindSurf Voice AI”，通过 `mindsurf://auth/callback` 回到客户端。

Mock 使用固定测试账户，不需要真实用户名或密码。账户、token、ticket、额度和用量都只保存在进程内存中，重启 Mock 后会重置。修改 Mock 源码后需要重启进程；开发时可以用 `npm run dev` 启动文件监听。

Windows Debug 客户端会自动注册 `mindsurf://`。macOS 的完整浏览器回跳、Keychain 和 TCC 权限应使用打包后的 Debug App 验证：

```bash
cd mindsurf-voice-ai
npm run build:macos:debug
open "src-tauri/target/debug/bundle/macos/MindSurf Voice AI.app"
```

详细原因和权限重置步骤见 [macOS 说明](./docs/MACOS.md)。

## 联调范围

本地 Mock 提供：

- `/v2/auth/*`：PKCE 授权、token 交换、轮换和登出；
- `/v2/users/me`、`/v2/quota`、`/v2/usage`、`/v2/capabilities`；
- `/v2/realtime/tickets`：一次性 realtime ticket；
- `/v2/voice/ws`：`mindsurf.voice.v2` 长连接、心跳和单轮请求；
- `asr_only` 与 `asr_llm` 两种模式；
- capabilities stale、超时、断线、取消竞态、final/done 不一致等故障注入。

Mock 参数、稳定故障名和接口明细见 [mindsurf-voice-mock/README.md](./mindsurf-voice-mock/README.md)。协议对接建议按以下顺序阅读：

1. [后端集成说明](./docs/v2/docs/backend-integration.md)
2. [HTTP API v2](./docs/v2/docs/HTTP_API_V2.md)
3. [WebSocket v2](./docs/v2/docs/WS_PROTOCOL_V2.md)
4. [Request 生命周期](./docs/v2/docs/request-lifecycle.md)
5. [Schema 与测试向量](./docs/v2/schemas/README.md)

## 客户端操作

- Windows 默认按住 `Ctrl + Win` 录音；
- macOS 默认按住 `Control + Command + Space` 录音；
- 松开快捷键后提交，按 `Escape` 取消；
- macOS 首次使用需要麦克风和辅助功能权限；
- 设置页可切换模式、Pipeline、麦克风、自动注入、悬浮窗和登录自启动。

## 常用命令

以下命令均从仓库根目录执行：

| 用途                  | 命令                                                   |
| --------------------- | ------------------------------------------------------ |
| 启动 Mock             | `npm --prefix mindsurf-voice-mock start`               |
| Mock 文件监听         | `npm --prefix mindsurf-voice-mock run dev`             |
| 启动桌面客户端        | `npm --prefix mindsurf-voice-ai run tauri dev`         |
| 客户端完整检查        | `npm --prefix mindsurf-voice-ai run check`             |
| 客户端前端生产构建    | `npm --prefix mindsurf-voice-ai run build`             |
| Mock 测试             | `npm --prefix mindsurf-voice-mock test`                |
| Voice API v2 协议校验 | `npm run validate:protocol-v2`                         |
| macOS Debug App       | `npm --prefix mindsurf-voice-ai run build:macos:debug` |

Rust 原生层质量门：

```bash
cd mindsurf-voice-ai/src-tauri
cargo fmt --all -- --check
cargo check --all-targets
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets
```

## 构建与发布

macOS 本机 Debug App：

```bash
cd mindsurf-voice-ai
npm run tauri build -- --debug --bundles app --no-sign
```

Windows NSIS/MSI：

```powershell
cd mindsurf-voice-ai
npm run tauri build -- --bundles nsis,msi
```

正式版本由 `.github/workflows/release-desktop.yml` 构建：macOS Universal App/DMG 和 Windows x64 NSIS/MSI 会进入同一个 Draft Release。普通安装包发布后可从 [GitHub Releases](https://github.com/wyywnab/MindSurf-Voice-AI-Client/releases) 下载。

- [macOS 构建、签名和发布](./docs/MACOS.md)
- [Windows 构建、签名和发布](./docs/WINDOWS.md)
- [交付状态与人工验收](./docs/DELIVERY.md)

## 常见问题

- 连接失败：确认 Mock 仍在运行，客户端 origin 与 Mock 端口一致；
- macOS 浏览器无法回跳：重新执行 `npm run build:macos:debug` 并启动生成的 `.app`；
- Windows 编译失败：确认已安装 C++ 桌面开发工具；MSI 的 `light.exe` 错误通常需要
  启用 Windows VBSCRIPT 可选功能；
- 麦克风、快捷键或注入不可用：先在客户端“系统权限”页检查，再查看开发者诊断页；
- 需要复现协议异常：使用 Mock 的 `--fault`、`--fault-delay-ms` 或对应环境变量。

## 目录

```text
mindsurf-voice-ai/       Tauri 2 + Vue 3 桌面客户端
mindsurf-voice-mock/     HTTP + ticket + WebSocket v2 本地 Mock
scripts/                 协议与仓库级校验脚本
docs/v2/                 冻结协议、OpenAPI、Schema 和测试向量
docs/DELIVERY.md         交付状态与人工验收项
docs/MACOS.md            macOS 权限、构建和发布
docs/WINDOWS.md          Windows 构建、签名和发布
```

客户端内部模块说明见 [mindsurf-voice-ai/README.md](./mindsurf-voice-ai/README.md)。

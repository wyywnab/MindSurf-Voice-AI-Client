# MindSurf Voice AI

MindSurf Voice AI 的 Windows/macOS 桌面客户端，基于 Tauri 2、Vue 3 和
TypeScript。

客户端支持听写、助手和混合模式、ASR/LLM 流式文本、Windows `SendInput`
与 macOS CoreGraphics Unicode 文本注入，以及可配置的全局按住说话快捷键。
Windows 默认使用 `Ctrl + Win`，macOS 默认使用 `Control + Command`；任一
组合键释放后提交，`Escape` 取消当前请求。

## 环境要求

- Node.js 22+
- Rust stable
- Windows 10/11 与 WebView2，或 macOS 10.15+
- macOS 构建需要 Xcode Command Line Tools

## 本地开发

客户端不会自动启动 Mock 服务。下面的命令均从仓库根目录执行。

### Windows

先启动 Mock：

```powershell
Set-Location .\mindsurf-voice-mock
npm install
npm start
```

再打开一个 PowerShell 窗口启动客户端：

```powershell
Set-Location .\mindsurf-voice-ai
npm install
npm run tauri dev
```

### macOS

先启动 Mock：

```bash
cd mindsurf-voice-mock
npm install
npm start
```

再打开一个终端窗口启动客户端：

```bash
cd mindsurf-voice-ai
npm install
npm run tauri dev
```

首次运行需在“系统设置 → 隐私与安全性”中允许麦克风、辅助功能和输入监控。

调试阶段默认连接本地 mock 服务：

```text
ws://127.0.0.1:8000/v1/voice/ws
```

可以通过 `VITE_VOICE_SERVICE_URL` 覆盖服务地址。独立 Mock 服务位于客户端
同级目录 `../mindsurf-voice-mock`。

## 质量检查

```powershell
npm run check
npm run build

Set-Location src-tauri
cargo fmt --all -- --check
cargo check --all-targets
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets
```

`npm run check` 会执行 Prettier、ESLint、TypeScript 和音频工具单元测试。

## 目录

```text
src/
├─ components/    UI 组件
├─ audio/         重采样、PCM16、分帧与 WAV
├─ composables/   Vue 业务组合逻辑
├─ services/      Tauri 与外部服务适配
├─ stores/        客户端业务状态
├─ styles/        全局样式
└─ types/         TypeScript 领域类型

src-tauri/src/
├─ commands/      Tauri commands
├─ error.rs       统一命令结果与错误类型
├─ lib.rs         Tauri 应用入口
└─ main.rs        桌面进程入口
```

协议与实现基线见仓库根目录的 `PHASE1_IMPLEMENTATION.md` 和 `WS_PROTOCOL.md`。

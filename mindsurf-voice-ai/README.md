# MindSurf Voice AI

MindSurf Voice AI 的 Windows/macOS 桌面客户端，基于 Tauri 2、Vue 3 和
TypeScript。

客户端支持听写、助手和混合模式、ASR/LLM 流式文本、TTS 流式语音播放、
Windows SendInput 与 macOS Accessibility API Unicode 文本注入，以及可实际按
键录入的全局按住说话快捷键。Windows 默认使用 `Ctrl + Win`，macOS 默认使用
`Control + Command + Space`；按住录音，释放提交，`Escape` 取消当前请求。

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

macOS 首次运行需在"系统设置 → 隐私与安全性"中允许麦克风和辅助功能权限。
全局快捷键使用系统 Carbon 热键 API，不依赖"输入监控"权限。

调试阶段默认连接本地 Mock 服务：

```text
ws://127.0.0.1:8000/v1/voice/ws
```

Mock 服务位于客户端同级目录 `../mindsurf-voice-mock`。

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

`npm run check` 会执行 Prettier、ESLint、TypeScript 和前端测试。

## 目录

```text
src/
├─ components/     UI 组件（录音/连接/权限/设置面板、悬浮窗等）
├─ audio/          重采样、PCM16、分帧、WAV 与流式播放器
├─ composables/    Vue 业务组合逻辑（录音等）
├─ controllers/    请求/录音/悬浮窗/文本输出的业务编排
├─ services/       传输、协议、录音、文本注入、设置、诊断、托盘等
├─ stores/         连接/请求/设置/诊断等状态域
├─ styles/         全局样式
└─ types/          TypeScript 领域类型

src-tauri/src/
├─ commands/       Tauri commands（文本注入、快捷方式、权限、托盘等）
├─ error.rs        统一命令结果与错误类型
├─ lib.rs          Tauri 应用入口
└─ main.rs         桌面进程入口
```

Phase 2 架构详情见仓库根目录的 [`PHASE2_IMPLEMENTATION.md`](../docs/PHASE2_IMPLEMENTATION.md)，
协议见 [`WS_PROTOCOL.md`](../docs/WS_PROTOCOL.md)。

# MindSurf Voice AI Desktop

基于 Tauri 2、Vue 3 和 TypeScript 的 Voice API v2 桌面客户端。

## 当前能力

- 系统浏览器 Authorization Code + PKCE 登录与深链回跳；
- refresh token 系统 Keychain 保存与原子轮换，access token 仅保留在内存；
- HTTP 用户、额度、用量、能力目录与一次性 realtime ticket；
- `mindsurf.voice.v2` 长连接、心跳、关闭码分类和新 ticket 重连；
- `asr_only` 与 `asr_llm` 两种单轮文本模式；
- 16 kHz 单声道 PCM16 上行、final snapshot + `request.done` 双确认；
- Windows/macOS 原生文本注入、麦克风选择、登录自启动、快捷键、悬浮窗、托盘和脱敏诊断。

协议不包含多轮对话或服务端下行音频。

## 本地开发

先按仓库根目录 [README](../README.md) 启动本地 Mock，再执行：

```bash
npm ci
npm run tauri dev
```

在账户页将 Voice API origin 设为：

```text
http://127.0.0.1:8000
```

随后点击登录。Mock 会在系统浏览器显示本地测试账户；点击“登录并授权”，再从授权成功页点击
“打开 MindSurf Voice AI”，即可签发 Authorization Code 并回跳应用。

## 质量检查

```bash
npm run check
npm run build

cd src-tauri
cargo fmt --all -- --check
cargo check
cargo test
```

## 模块

```text
src/
├─ components/     账户、录音、连接、权限、设置、诊断与悬浮窗 UI
├─ composables/    录音组合逻辑
├─ controllers/    授权、连接、请求、录音、悬浮窗与文本输出编排
├─ services/       HTTP、realtime v2、录音、注入、设置、诊断和托盘
├─ stores/         登录、账户、额度、能力、连接、请求、设置和诊断状态
└─ types/          HTTP、realtime、设置与 UI 类型

src-tauri/src/commands/
├─ credentials.rs      Keychain refresh token
├─ native_recorder.rs  原生录音
├─ text_injection.rs   原生文本注入
└─ ...                 深链、权限、快捷键、托盘、悬浮窗与诊断
```

规范入口：

- [Voice API v2](../docs/v2/README.md)
- [HTTP API](../docs/v2/docs/HTTP_API_V2.md)
- [WebSocket v2](../docs/v2/docs/WS_PROTOCOL_V2.md)
- [Request 生命周期](../docs/v2/docs/request-lifecycle.md)
- [Phase 3 实施状态](../docs/PHASE3_IMPLEMENTATION.md)

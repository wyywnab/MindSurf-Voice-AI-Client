# MindSurf Voice AI 客户端交付说明

> 更新日期：2026-08-18
>
> 协议基线：冻结的 Voice API v2
>
> 当前范围：Phase 3 M1-M5 客户端、自动化验证与本地 Mock；跨平台人工签收待完成

## 已交付

- Tauri 2 + Vue 3 桌面客户端；
- 系统浏览器 Authorization Code + PKCE、深链与单实例回跳；
- refresh token Keychain 保存、轮换、启动恢复与登出清理；
- HTTP user、quota、usage、capabilities 和 realtime ticket；
- `mindsurf.voice.v2` 长连接、hello、心跳、关闭码策略和新 ticket 重连；
- `asr_only` / `asr_llm` 单轮文本请求与 48 字节 INPUT_PCM 上行帧；
- accepted 回显校验、commit 统计、文本 stage/sequence、final/done 双确认和取消竞态；
- Windows/macOS 录音、麦克风选择、登录自启动、全局快捷键、悬浮窗、系统托盘与 Unicode 文本注入；
- 设置 schema v2、脱敏诊断、日志轮转和清理本地数据；
- HTTP + ticket + WebSocket v2 本地 Mock 与可配置故障注入；
- 前端、Rust、Mock、冻结协议以及 macOS/Windows 安装包自动化质量门。

当前产品只输出文本，不包含多轮对话和服务端下行音频。接口权威入口为
[docs/v2](./v2/README.md)。

## Mock 交付

`mindsurf-voice-mock` 提供全部 9 个 OpenAPI operation 对应路径、PKCE/token 生命周期、内存账户与
额度、用量分页、一次性 ticket、长期 WebSocket 和两种请求模式。正常流程和故障注入均不依赖
正式后端、数据库或 FFmpeg。

启动与故障列表见 [Mock README](../mindsurf-voice-mock/README.md)。

## 自动化验证

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

自动化覆盖 OpenAPI/Schema/文档示例/测试向量、客户端状态机与控制器、Mock HTTP/WS 全链路、
Rust 原生命令和生产构建。

## 待跨平台人工签收

以下内容必须在真实 Windows 和 macOS 桌面环境完成，当前不能由本地自动化替代：

- 系统浏览器登录回跳、重复/过期回跳和启动恢复；
- Keychain/Windows Credential Manager 的 token 写入、轮换、登出和旧凭据清理；
- 麦克风权限、设备切换、长录音、取消和原生录音回退；
- 全局按住说话快捷键、冲突提示和权限恢复；
- 登录自启动开关、重启后的系统状态同步，以及静默托盘启动和手动唤醒；
- Windows NSIS/MSI 安装、代码签名、升级、卸载和自启动项清理；
- 多显示器/全屏 Space 悬浮窗与托盘模式切换；
- 两种模式的 final/done 一次性文本注入，以及取消、失败、断线时零注入；
- 睡眠/唤醒、网络切换和连续请求下的长期连接恢复；
- 签名、公证、安装包和正式升级渠道。

平台操作细节见 [macOS 说明](./MACOS.md)、[Windows 说明](./WINDOWS.md) 和
[Phase 3 实施文档](./PHASE3_IMPLEMENTATION.md)。

## 交付内容

```text
mindsurf-voice-ai/               桌面客户端源码
mindsurf-voice-mock/             Voice API v2 本地 Mock 与集成测试
docs/v2/                         冻结协议、OpenAPI、Schema 和测试向量
docs/PHASE3_IMPLEMENTATION.md    当前实施状态
docs/PHASE1_IMPLEMENTATION.md    已取代的历史记录
docs/PHASE2_IMPLEMENTATION.md    已取代的历史记录
```

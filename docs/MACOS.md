# macOS 适配与发布

## 系统要求

- macOS 10.15 或更高版本。
- Node.js 22+、Rust stable、Xcode Command Line Tools。
- Intel 与 Apple Silicon 均受支持；正式发布工作流生成 Universal Binary。

## 权限

| 权限     | 用途                                      | 触发位置                       |
| -------- | ----------------------------------------- | ------------------------------ |
| 麦克风   | 录制语音                                  | 权限页统一初始化或首次开始录音 |
| 辅助功能 | 将 Unicode 文本输入当前前台应用           | 首次文本注入或权限页           |
| 输入监控 | 在其他应用处于前台时监听按住说话和 Escape | 启用全局快捷键或权限页         |

启动时如有任一权限未授权，客户端会默认进入“权限”页。点击“初始化系统
权限”后，客户端会依次查询或请求麦克风、辅助功能和输入监控权限，并在原生
麦克风授权后通过 WebView 获取并立即释放一次音频流，以确认实际录音能力。

权限被拒绝后，可在同一页面重新请求或直接打开对应的“隐私与安全性”页面。
从系统设置返回应用后，三项原生权限状态会自动刷新。部分 macOS 版本在变更
输入监控权限后会要求重启应用。

## 本地验证

```bash
cd mindsurf-voice-ai
npm ci
npm run check
npm run build

cd src-tauri
cargo fmt --all -- --check
cargo check --all-targets
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-targets
```

生成本机架构的测试应用包：

```bash
cd mindsurf-voice-ai
npm run tauri build -- --debug --bundles app
```

生成 Universal App 与 DMG：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

## 签名与公证

根目录 `.github/workflows/release-macos.yml` 会构建、签名、公证并创建草稿
GitHub Release。仓库需要配置以下 Actions secrets：

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

发布前还应在常用编辑器、浏览器输入框、Terminal、多显示器和全屏 Space 中
手工验证快捷键、中文/英文/emoji/换行注入、权限恢复、睡眠唤醒与服务重连。

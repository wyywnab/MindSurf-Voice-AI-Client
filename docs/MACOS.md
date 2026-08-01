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

全局快捷键的“用户期望启用”状态会单独持久化。用户主动关闭快捷键后，权限
刷新或应用重启不会重新启用；如果用户期望启用但因权限不足启动失败，授权后
会自动重新注册。

正式录音采用“准备麦克风 → 创建服务端请求 → 开始发送 PCM”的顺序。权限、
设备或 WebView 初始化失败时不会创建服务端请求；准备期间松开快捷键或取消，
已取得的 MediaStream 会被释放。

macOS 文本注入会同时校验前台应用和 focused Accessibility 元素。同一应用内
切换窗口、标签页或输入框时，注入会停止并保留剩余文本。悬浮窗优先跟随前台
应用最前方窗口所在的显示器，无法读取窗口信息时再回退到应用当前显示器。

每次文本注入任务只创建并复用一个 `CGEventSource`。悬浮窗选择目标显示器时，
会先把 Tauri 的物理显示器边界转换为 Quartz 逻辑坐标，再使用目标显示器的
scale factor 计算物理尺寸和边距；窗口最终通过逻辑坐标移动和调整大小，避免
读取旧显示器缩放造成 Retina 与非 Retina 混合环境下的偏移。

启用自动注入时，如果从 MindSurf 主窗口开始录音，麦克风准备完成后应用会主动
让出前台焦点，使之前使用的输入位置重新获得焦点。macOS 全局快捷键的 Event Tap
只负责采集按键并通过独立线程派发应用事件；如果 Event Tap 被系统临时禁用，
客户端会释放当前按住状态、清理 Space 状态并立即重新启用监听。

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

## CI 必需检查

`.github/workflows/ci.yml` 会在每次 push 和 pull request 上运行以下检查：

- `Windows quality gate`
- `macOS quality gate`
- `macOS application bundle`

应在 GitHub 分支保护规则中将这三个检查设为 `main` 的必需状态检查。工作流
代码可以保证检查被创建，但分支保护仍需仓库管理员在 GitHub 设置中启用。

生成本机架构的测试应用包：

```bash
cd mindsurf-voice-ai
npm run build:macos:debug
```

不要使用 `tauri dev` 或未经 bundle 签名的裸二进制验证 TCC 权限。本地没有
Apple Development 签名证书时，脚本会使用标识为 `org.sast.mindsurf` 的 ad-hoc
签名；每次重新构建都会产生新的代码哈希，因此必须先完全退出旧进程，再执行
`tccutil reset All org.sast.mindsurf`，重新打开同一个 `.app` 并授权。红色关闭按钮
只会隐藏主窗口，必须使用托盘菜单“退出”或确认进程已经结束。

生成 Universal App 与 DMG：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

## 签名与公证

根目录 `.github/workflows/release-macos.yml` 会构建、签名、公证并创建草稿
GitHub Release。tag 发布前会校验 tag、`tauri.conf.json`、`package.json` 和
`Cargo.toml` 的版本一致；例如应用版本为 `0.1.0` 时只能使用 `v0.1.0` tag。
仓库需要配置以下 Actions secrets：

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

发布前还应在常用编辑器、浏览器输入框、Terminal、Retina + 非 Retina 多显示器
和全屏 Space 中手工验证快捷键、权限恢复、睡眠唤醒与服务重连，并分别使用
500、2000、8000 code point 的中文、英文、emoji 和换行混合文本验证注入性能、
目标切换中止及剩余文本保留。

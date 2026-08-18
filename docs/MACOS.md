# macOS 适配与发布

## 系统要求

- macOS 10.15 或更高版本。
- Node.js 22+、Rust stable、Xcode Command Line Tools。
- Intel 与 Apple Silicon 均受支持；正式发布工作流生成 Universal Binary。

## 权限

| 权限     | 用途                                                       | 触发位置                       |
| -------- | ---------------------------------------------------------- | ------------------------------ |
| 麦克风   | 录制语音                                                   | 权限页统一初始化或首次开始录音 |
| 辅助功能 | 将 Unicode 文本输入当前前台应用                            | 首次文本注入或权限页           |
| 输入监控 | 当前组合键快捷键方案不依赖该权限，也不把其状态作为就绪条件 | 非必需                         |

启动时如有核心权限未授权或快捷键未就绪，客户端会默认进入“权限”页。点击
“初始化系统权限”后，客户端会查询或请求麦克风和辅助功能权限，并验证快捷键
监听器。macOS 没有提供可靠 API 判断应用是否明确列在输入监控设置中，因此
客户端不会把 `CGPreflightListenEventAccess` 的结果显示成可信的授权状态。

权限被拒绝后，可在同一页面重新请求或直接打开对应的“隐私与安全性”页面。
从系统设置返回应用后，麦克风和辅助功能状态会自动刷新。

全局快捷键的“用户期望启用”状态会单独持久化。用户主动关闭快捷键后，权限
刷新或应用重启不会重新启用；如果用户期望启用但因权限不足启动失败，授权后
会自动重新注册。

“常规与快捷键”中的“登录时自动启动”使用用户级 LaunchAgent，不需要管理员
权限。自启动进程携带 `--autostart` 参数，照常初始化主 WebView、全局快捷键和
托盘等后台能力，但不显示主窗口，也不在 Dock 中保留常规应用图标；从托盘或
再次启动应用时会恢复常规激活策略并显示主窗口。开关状态以系统注册结果为准，
不额外保存一份可能失效的本地副本。

macOS 正式录音使用原生 AVAudioRecorder，不依赖隐藏 WKWebView 的
`getUserMedia()`。停止录音后读取单声道 PCM，必要时重采样到 16 kHz，再按现有
20 ms 帧协议提交。停止或取消时会释放原生录音器并删除临时文件。

macOS 文本注入会同时校验前台应用和 focused Accessibility 元素。同一应用内
切换窗口、标签页或输入框时，注入会停止并保留剩余文本。悬浮窗优先跟随前台
应用最前方窗口所在的显示器，无法读取窗口信息时再回退到应用当前显示器。

每次文本注入任务只创建并复用一个 `CGEventSource`。悬浮窗选择目标显示器时，
会先把 Tauri 的物理显示器边界转换为 Quartz 逻辑坐标，再使用目标显示器的
scale factor 计算物理尺寸和边距；窗口最终通过逻辑坐标移动和调整大小，避免
读取旧显示器缩放造成 Retina 与非 Retina 混合环境下的偏移。

macOS 全局快捷键通过 `tauri-plugin-global-shortcut` 注册包含 Space 的组合键，
原生回调通过独立线程派发应用事件。悬浮窗使用透明 NSPanel 作为 Space 载体，
保留 Tauri 原 NSWindow/WebView 并作为子窗口，因此可显示在第三方全屏 Space，
同时不会破坏 Tao 对原窗口 contentView 的内部假设。

完整的问题现象、不可用旧方案和最终架构见
[`MindSurf_macOS适配实现复盘.md`](MindSurf_macOS适配实现复盘.md)。

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
- `Windows installers`

应在 GitHub 分支保护规则中将这四个检查设为 `main` 的必需状态检查。工作流
代码可以保证检查被创建，但分支保护仍需仓库管理员在 GitHub 设置中启用。

生成本机架构的测试应用包：

```bash
cd mindsurf-voice-ai
npm run build:macos:debug
```

系统浏览器登录回跳必须使用重新生成并启动过的 `.app` 验证。应用包的 `Info.plist` 声明
`mindsurf` URL Scheme；macOS 在应用包启动后将其注册为 `mindsurf://` 的处理程序。浏览器授权页
点击“登录并授权”时，应提示打开 MindSurf Voice AI。若没有提示，先完全退出旧进程，重新执行上述
构建脚本并启动 `src-tauri/target/debug/bundle/macos/MindSurf Voice AI.app`。裸二进制或旧应用包
不会获得新 Scheme 声明。

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

根目录 `.github/workflows/release-desktop.yml` 会构建、签名、公证 macOS 产物，
随后将签名后的 Windows 安装包追加到同一个草稿 GitHub Release。tag 发布前会
校验 tag、`tauri.conf.json`、`package.json` 和 `Cargo.toml` 的版本一致；例如应用
版本为 `0.2.0` 时只能使用 `v0.2.0` tag。
仓库需要配置以下 Actions secrets：

- `APPLE_CERTIFICATE`
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`
- `APPLE_ID`
- `APPLE_PASSWORD`
- `APPLE_TEAM_ID`

Windows 签名所需 Secrets 和发布步骤见 [Windows 说明](./WINDOWS.md)。

发布前还应在常用编辑器、浏览器输入框、Terminal、Retina + 非 Retina 多显示器
和全屏 Space 中手工验证快捷键、权限恢复、睡眠唤醒与服务重连，并分别使用
500、2000、8000 code point 的中文、英文、emoji 和换行混合文本验证注入性能、
目标切换中止及剩余文本保留。还应分别启用和关闭登录自启动，注销并重新登录，
确认启用时仅出现托盘图标、关闭时不会启动，并验证从托盘能够正常恢复主窗口。

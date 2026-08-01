# MindSurf Voice AI Client：macOS 适配实现复盘

- 整理日期：2026-08-01
- 适用分支：`fix/macos-bugfix`
- 适用模块：`mindsurf-voice-ai`
- 目的：记录本轮 macOS 实机适配中遇到的问题、不可用方案、最终实现和后续维护约束。

## 1. 最终结果

本轮适配完成并经过实机验证的核心链路如下：

```text
全局快捷键按下
  → 捕获当前前台输入目标
  → 原生 AVAudioRecorder 开始录音
  → 透明悬浮窗显示在普通窗口或全屏 Space 上方
  → 快捷键松开
  → 原生录音停止并读取 PCM
  → 通过现有 WebSocket 协议提交音频
  → 收到识别结果
  → 优先通过 Accessibility 写入目标元素
  → 不支持 Accessibility 写入时，向已捕获 PID 定向发送 CGEvent
```

已在 Chrome、Codex、VS Code、Typora、普通窗口完全遮挡和 macOS 全屏应用等场景中验证：

- MindSurf 不在前台、窗口被完全遮住时，快捷键仍能触发。
- 全屏应用中可以显示悬浮窗、录音并注入文本。
- 未录音时不会持续占用麦克风，菜单栏黄色麦克风图标会消失。
- 悬浮窗圆角外侧保持透明。
- 原生录音电平能够驱动主界面和悬浮窗音量条。

## 2. 权限检测

### 2.1 问题

最初把麦克风、辅助功能和输入监控都视为可以可靠查询的三项权限。实机测试发现：即使用户没有在“输入监控”中添加应用，状态也可能显示为已授权。

原因是 macOS 没有提供“当前应用是否明确出现在输入监控列表中”的可靠公开 API。`CGPreflightListenEventAccess` 在辅助功能授权能够满足相关事件监听能力时也可能返回成功，不能直接映射成“输入监控已授权”。

### 2.2 不可用旧方案

- 使用 `CGPreflightListenEventAccess` 作为输入监控设置项的真实状态。
- 把输入监控当作所有全局快捷键实现的固定前置条件。
- 权限刷新后，只要监听器不在运行就自动重新启用快捷键；这会覆盖用户主动关闭快捷键的选择。

### 2.3 最终方案

- 麦克风权限通过 AVFoundation 查询和请求。
- 辅助功能权限通过 `AXIsProcessTrusted` 查询，通过 `AXIsProcessTrustedWithOptions` 触发系统提示。
- 输入监控状态返回 `unknown`，不再伪装成可靠的“已授权/未授权”状态，也不作为当前快捷键方案的就绪条件。
- 权限页面集中提供核心权限状态、请求按钮和系统设置入口，并明确说明当前全局热键不依赖输入监控权限。
- 应用启动时若核心权限或快捷键未就绪，默认进入权限页面。
- 快捷键“用户希望启用”与“后端实际已注册”分开持久化和展示。

## 3. 全局快捷键

### 3.1 问题

早期现象具有明显的窗口可见性规律：MindSurf 露出一部分时能够触发，被其他窗口完全遮住后不能触发；从 MindSurf 切换到个别应用时偶尔可以触发，从其他应用切换过去又失效。

这不是键位冲突，而是全局按键事件最终依赖隐藏 WKWebView 及时执行 JavaScript。macOS 对后台、被遮挡或位于其他 Space 的 WebView 有调度限制，导致原生侧收到事件后，前端处理时机不稳定。

### 3.2 不可用旧方案

- 仅在前端监听按键。
- 自建 Event Tap 后直接依赖主 WebView 处理按下和松开事件。
- 只通过重复 `eval` 或提高前端定时器频率唤醒后台 WebView。
- 使用只有修饰键的快捷键。系统和其他软件容易截获，按下/松开语义也不稳定。

### 3.3 最终方案

- macOS 使用官方 `tauri-plugin-global-shortcut` 注册包含普通键的组合键：
  - `Control + Command + Space`
  - `Control + Option + Space`
  - `Control + Shift + Space`
- 原生回调只负责更新按住状态，并通过独立 Rust 通知线程向主窗口派发事件，避免阻塞系统快捷键回调。
- 使用 `NSProcessInfo.beginActivity` 降低 App Nap 对按住说话流程的影响。
- 将主 WKWebView 的 `WKInactiveSchedulingPolicy` 设为 `None`，并在派发快捷键事件前执行一次无副作用求值作为唤醒措施。
- 前端串行处理按下、松开和取消动作，避免快速操作造成录音与请求状态竞态。

## 4. 麦克风录音

### 4.1 问题

WKWebView 的 `getUserMedia()` 在主窗口不可见或应用位于其他全屏 Space 时可能长期 pending。曾出现以下组合现象：

- 悬浮窗能显示，但没有开始录音或注入。
- 普通窗口能够录音，全屏下没有黄色麦克风图标。
- 为了维持录音而保留 MediaStream 后，空闲状态菜单栏仍长期显示黄色麦克风图标。

### 4.2 不可用旧方案

- 继续以 WKWebView `getUserMedia()` 作为 macOS 正式录音实现。
- 在开始录音前先显示悬浮窗，希望“有一个可见 WebView”能解除主 WebView 的媒体限制。悬浮窗和主窗口是不同 WKWebView，不能解决主窗口的媒体调度问题。
- 长期保留预热的 MediaStream。虽然减少再次初始化，但会造成系统持续显示麦克风占用。
- 仅修改 WebKit inactive scheduling policy。它能改善脚本调度，但不能保证不可见 WKWebView 的媒体采集请求成功。

### 4.3 最终方案

- macOS 正式录音改用原生 `AVAudioRecorder`。
- 录音格式为单声道、16-bit PCM WAV，目标采样率 16 kHz。
- 停止录音后读取临时 WAV、解析 PCM；如果系统实际采样率不是 16 kHz，由前端统一重采样。
- PCM 仍按现有 20 ms 帧格式送入 WebSocket，保持服务端协议不变。
- 停止或取消时立即释放录音器并删除临时文件，确保系统麦克风指示及时消失。
- 开启 AVAudioRecorder metering，将 dBFS 转换为统一的 0～1 电平值。

当前实现为最长 60 秒的按住说话场景在内存和临时文件中缓冲，停止后再提交 PCM。若未来需要真正的低延迟流式识别，应改用 `AVAudioEngine` tap 在录音期间持续输出 PCM，而不是让 WKWebView 重新承担采集职责。

## 5. 文本注入

### 5.1 问题

仅在识别完成后读取“当前前台窗口”会丢失录音开始时的输入目标；悬浮窗或 MindSurf 窗口切换也可能让应用把自己误认为目标。同时，不同应用对 Accessibility 文本写入的支持并不一致。

### 5.2 不可用旧方案

- 识别完成后才查找前台 PID。
- 只比较应用 PID，不保存 focused Accessibility 元素。
- 对所有应用只使用逐字符、非定向的 CGEvent。
- 依赖剪贴板粘贴；这会覆盖用户剪贴板，并引入额外权限和数据安全问题。

### 5.3 最终方案

- 在录音开始、悬浮窗改变前台状态之前捕获前台 PID 和 focused AXUIElement。
- 优先向捕获的 Accessibility 元素设置 `AXSelectedText`，适用于标准文本控件并能一次写入 Unicode 文本。
- AX 写入不可用时，使用定向到已捕获 PID 的 CGEvent Unicode 键盘事件作为兼容回退。
- 注入前等待快捷键修饰键释放，避免文本与 Control、Command、Option、Shift 组合成系统快捷键。
- 注入过程中校验目标；失败时返回已注入数量和剩余文本，允许用户切换目标后重试。
- 单次任务复用 CGEventSource，并对最大 8000 code point 做边界控制。

## 6. 悬浮窗和全屏 Space

### 6.1 问题

Tauri 的普通透明 `NSWindow` 即使设置 always-on-top，在第三方应用的原生全屏 Space 中仍可能不可见。它实际上已经显示在桌面 Space；退出全屏后立即看到悬浮窗，证明问题是 Space 归属而不是前端渲染失败。

### 6.2 不可用旧方案

- 只使用 `always_on_top`。
- 给普通 NSWindow 增加 `CanJoinAllSpaces`、`FullScreenAuxiliary`、`CanJoinAllApplications` 和 ScreenSaver window level。这些设置不足以保证普通窗口进入第三方全屏 Space。
- 使用 `MoveToActiveSpace`。普通窗口仍可能留在桌面 Space。
- 先显示悬浮窗再启动录音。它只能证明窗口调用成功，不能改变窗口类型和 Space 归属。
- 新建 NSPanel 后把 Tauri NSWindow 的 contentView/WKWebView 直接搬到 NSPanel。Tao 内部假设原 NSWindow 始终拥有 contentView，后续访问时会在 `ns_window.contentView().unwrap()` 触发 panic。

### 6.3 最终方案

- 保留 Tauri 创建的原 NSWindow 和完整 WKWebView 层级。
- 创建无内容、透明、不可激活的原生 NSPanel 作为“Space 载体”。
- 把原 Tauri NSWindow 作为 NSPanel 的 child window，而不是移动 contentView。
- NSPanel 使用 `CanJoinAllApplications + CanJoinAllSpaces + FullScreenAuxiliary`，并保持高窗口层级；AppKit 会让子窗口随父面板进入全屏 Space。
- 定位时临时解除父子关系、同步载体 frame、再重新绑定，避免移动父窗口造成子窗口坐标二次偏移。
- 对 NSPanel 和子 NSWindow 都显式设置 `opaque = false`、clear background 和无阴影，保持圆角外侧透明。
- 悬浮窗不获取焦点，避免破坏目标应用的输入位置。

## 7. 全屏悬浮窗动画

### 7.1 问题

全屏悬浮窗已经可见后，时间和音量条仍会出现不均匀刷新。单纯把主窗口的发布间隔从 60 ms 调到 33 ms 只能缓解：真正的问题仍是数据源位于隐藏的主 WKWebView，macOS 全屏时其 JavaScript 定时器可能被批量调度。

### 7.2 最终方案

- 主窗口只同步录音是否开始、最近一次时长、电平和业务状态，并给快照附带生成时间戳。
- 可见悬浮窗用自身的 `requestAnimationFrame` 推进显示时长，并用快照时间戳补偿消息传输延迟。
- macOS 悬浮窗直接调用原生命令读取 AVAudioRecorder 的 active 状态、原生录音时长和电平，不再等待隐藏主窗口轮询后转发。
- 悬浮窗在动画帧内对音量做快速上升、缓慢回落的指数平滑，避免 30 Hz 采样造成跳动。
- 状态事件发布采用“仅保留最新快照”的合并策略，防止后台调度变慢时旧 IPC 消息堆积并造成显示滞后。

## 8. 多显示器、签名与 TCC

- 悬浮窗优先使用当前前台应用窗口与各显示器的重叠面积选择目标显示器，而不是按鼠标位置选择。
- Quartz 窗口边界与 Tauri 物理坐标在比较前统一换算，避免 Retina/非 Retina 混合环境偏移。
- Debug `.app` 使用固定 bundle identifier 并进行 ad-hoc 签名。直接运行裸二进制、`tauri dev` 和重新签名后的 `.app` 可能被 TCC 视为不同身份。
- 每次重建 ad-hoc 签名应用都可能改变代码哈希；权限异常时应完全退出旧进程、重置对应 TCC 项并从固定 `.app` 路径重新授权。

## 9. 关键实现位置

| 功能                    | 文件                                                          |
| ----------------------- | ------------------------------------------------------------- |
| 原生录音、WAV/PCM、电平 | `mindsurf-voice-ai/src-tauri/src/commands/native_recorder.rs` |
| 全局快捷键与后台调度    | `mindsurf-voice-ai/src-tauri/src/commands/shortcuts_macos.rs` |
| NSPanel 全屏载体        | `mindsurf-voice-ai/src-tauri/src/commands/overlay.rs`         |
| 权限查询与系统设置入口  | `mindsurf-voice-ai/src-tauri/src/commands/permissions.rs`     |
| AX/CGEvent 文本注入     | `mindsurf-voice-ai/src-tauri/src/commands/text_injection.rs`  |
| 原生录音前端适配        | `mindsurf-voice-ai/src/services/nativeRecorder.ts`            |
| 悬浮窗本地动画          | `mindsurf-voice-ai/src/OverlayApp.vue`                        |
| 录音、请求、注入编排    | `mindsurf-voice-ai/src/components/RecorderPanel.vue`          |

## 10. 验证清单

提交或发布前至少执行：

```bash
cd mindsurf-voice-ai
npm run check
npm run tauri -- build --debug --bundles app

cd src-tauri
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
```

实机回归必须覆盖：

1. MindSurf 前台、被部分遮挡、被完全遮挡。
2. Chrome、编辑器和原生应用的普通窗口。
3. 第三方应用 macOS 原生全屏 Space。
4. AX 标准输入框和只能走 CGEvent 回退的输入位置。
5. 快速按下/松开、取消、连续多次录音。
6. 录音期间麦克风图标出现，停止后消失。
7. 悬浮窗透明、定位、时间和音量动画。
8. 重启应用后的麦克风、辅助功能和快捷键状态。

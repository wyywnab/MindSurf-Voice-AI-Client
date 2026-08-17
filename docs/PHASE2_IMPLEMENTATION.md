# MindSurf Voice AI 第二阶段实现文档

> **历史文档：本阶段的协议与产品范围已被 Phase 3 和冻结的
> [`docs/v2/`](./v2/README.md) 完整取代，不得作为当前实现或联调依据。**

> 文档状态：实施中
> 适用范围：`mindsurf-voice-ai` Windows/macOS Tauri 客户端与联调 Mock
> 阶段定位：架构整理、稳定性提升与正式服务接入准备
> 前置基线：Phase 1 已完成录音、WebSocket 语音请求、流式文本/音频、全局快捷键、悬浮窗及 Windows/macOS 文本注入闭环

## 实施状态

| 里程碑         | 状态                       | 完成日期   | 说明                                                                                                                          |
| -------------- | -------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| M1             | 已完成                     | 2026-08-02 | 已拆分连接、请求、设置和诊断状态域，引入请求状态机、请求/录音/悬浮窗控制器、协议事件路由与文本输出 Backend。                  |
| M2             | 已完成                     | 2026-08-03 | 已接入 Tauri Store、按档案隔离的加密 Token、多服务档案与连通性测试，并补齐 Windows/macOS 多麦克风、语言、语音和播放音量选项。 |
| M3             | 已完成                     | 2026-08-03 | 已实现请求时间线、完整运行摘要、结构化文件日志、时间筛选、清理/目录操作、轮转和脱敏 ZIP 诊断导出。                            |
| 发布前安全加固 | 已完成                     | 2026-08-03 | 已启用发布 CSP、按窗口拆分 Capability，并提供一键清除设置、全部 Token/加密密钥和诊断日志。                                    |
| M4             | 已完成（待双平台人工签收） | 2026-08-03 | 已实现 19 类可配置 Mock 故障、控制器/传输/路由集成测试和完整质量门；Windows/macOS 原生交互按 8.4 清单签收。                   |

M2 已删除 `voiceSession.ts` 兼容入口，组件直接依赖拆分后的 Store 与 Controller。设置统一写入 Tauri Store，不保留 `localStorage` 适配器或旧设置迁移逻辑；服务 Token 经系统钥匙串托管的密钥加密后再写入 Store。

本文档定义 MindSurf Voice AI 客户端第二阶段的实现范围、模块边界、开发顺序和验收标准。第二阶段以现有功能的重构和稳定化为主，在不改变当前单次语音请求交互模型的前提下，补充服务配置、应用层鉴权、请求时间线和运行日志。

本文档仅保留为历史实施记录；其中的接口链接和产品描述均已失效。

## 1. 阶段背景

Phase 1 已经完成核心功能闭环，但当前实现仍保留较明显的阶段性结构：

- `stores/voiceSession.ts` 同时管理连接、请求、模型选项、播放、快捷键、悬浮窗、文本注入和配置持久化，职责过多。
- `RecorderPanel.vue` 同时承担页面展示、录音编排、快捷键事件处理和悬浮窗同步，组件逻辑偏重。
- 请求生命周期主要由多个状态字段和分散的事件处理共同维护，继续增加功能后容易产生竞态或非法状态组合。
- WebSocket 传输、协议事件处理和业务请求控制耦合较紧，不利于独立测试和后续替换传输实现。
- 配置仍分散在环境变量和 `localStorage`，尚未形成统一的桌面端配置存储层。
- 当前只能查看零散状态和播放指标，缺少一次请求从录音到结束的完整时间线，也缺少可导出的运行日志。

第二阶段不以扩大产品形态为目标，而是先整理这些基础结构，使后续增加输入法模式、替换原生音频模型或适配其他平台时，不需要再次重写现有业务层。

## 2. 阶段目标

第二阶段按以下优先级推进：

1. 重构客户端核心模块，明确录音、连接、请求、播放、文本输出、配置和 UI 的职责边界。
2. 建立单一、可验证的请求生命周期状态机，统一处理完成、取消、超时、断线和异常终态。
3. 将页面组件中的业务编排下沉到独立控制层，减少 UI 组件直接操作传输和系统能力。
4. 建立统一设置存储层，使用 Tauri Store 保存配置；Token 加密后存入 Store。
5. 支持正式服务地址、`wss://` 和应用层 Token 鉴权。
6. 完善麦克风设备、识别语言和语音输出等实际运行配置，去除请求中的固定值。
7. 增加请求时间线和运行日志，用于性能观察、故障定位和联调。
8. 扩展 Mock 故障注入和自动化测试，覆盖异常路径与竞态场景。
9. 在 Windows 和 macOS 上保持 Phase 1 已有功能行为一致，不引入明显回归。

## 3. 非目标

以下能力不属于第二阶段：

- 多轮对话、对话历史、长期记忆或 `conversation_id` 生命周期管理。
- 全双工持续对话、自动唤醒、自动 VAD 提交和回声消除。
- 注入前编辑器、复杂语音编辑命令和按前台应用配置文本规则。
- 输入法模式的具体实现。
- Linux 客户端适配。
- 原生音频 token 模型接入。
- 自动更新系统和复杂发布渠道管理。
- 旧版设置迁移、旧 `localStorage` 数据兼容或配置格式升级工具。

当前客户端尚未正式上线。第二阶段允许直接替换现有设置结构，并在首次启动新版本时使用新的默认配置，不为开发阶段遗留配置增加迁移成本。

## 4. 阶段实施顺序

第二阶段分为四个里程碑，必须优先完成重构，再开发依赖新结构的配置和可观测性功能。

| 里程碑 | 内容                                          | 依赖         |
| ------ | --------------------------------------------- | ------------ |
| M1     | 核心架构重构与状态机整理                      | Phase 1 基线 |
| M2     | 统一配置存储、音频选项、服务地址与 Token 鉴权 | M1           |
| M3     | 请求时间线、运行日志与日志导出                | M1、M2       |
| M4     | Mock 故障注入、异常路径测试与阶段验收         | M1～M3       |

## 5. M1：核心架构重构

### 5.1 重构原则

重构期间应遵守以下原则：

- 先通过测试固定 Phase 1 现有行为，再拆分模块。
- 单个模块只维护一种主要职责，不通过共享可变对象隐式联动。
- 页面组件负责展示和用户输入，不直接维护 WebSocket 请求协议状态。
- 系统相关能力继续通过 Tauri Command 或 Rust trait 隔离。
- 重构完成前不同时加入大范围新功能，避免难以区分结构问题和功能问题。
- 不要求为了目录形式机械拆分；模块边界以可测试性和依赖方向为准。

### 5.2 目标分层

```text
┌─────────────────────────────────────────────────────────────┐
│ Vue Components                                              │
│ 页面、控件、悬浮窗展示、用户操作                             │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Application Controllers                                     │
│ VoiceRequestController / RecordingController / OverlaySync  │
└──────────────┬─────────────────────┬────────────────────────┘
               │                     │
┌──────────────▼────────────┐  ┌────▼─────────────────────────┐
│ Stores                    │  │ Services                     │
│ connection / request /    │  │ transport / recorder /       │
│ settings / diagnostics    │  │ player / text output / logs  │
└──────────────┬────────────┘  └────┬─────────────────────────┘
               │                    │
┌──────────────▼────────────────────▼─────────────────────────┐
│ Tauri / Rust                                                 │
│ 快捷键、权限、文本注入、配置加密、文件日志、窗口与托盘       │
└─────────────────────────────────────────────────────────────┘
```

依赖方向必须从上层指向下层。Services 不得反向依赖 Vue Components，Transport 不得直接修改页面状态。

### 5.3 Store 拆分

将现有 `voiceSession` 拆分为以下状态域：

#### `connectionStore`

负责：

- 当前服务地址的展示状态。
- `disconnected`、`connecting`、`connected`、`reconnecting`、`error`。
- 重连次数、最近连接错误和 `server.hello`。
- 服务端能力、限制和模型选项。

不负责：

- 当前请求文本。
- 播放队列。
- 文本注入结果。
- 快捷键和悬浮窗配置。

#### `requestStore`

负责：

- 当前唯一活跃请求 ID。
- 请求生命周期状态。
- ASR partial/final。
- Assistant delta/final。
- 当前请求错误、警告和终态。
- 当前请求选用的模式和推理选项快照。

推理选项必须在请求开始时形成快照。请求处理中修改全局设置不得影响已经开始的请求。

#### `settingsStore`

负责：

- 服务地址和 Token 是否已配置。
- 默认交互模式。
- 快捷键设置。
- 悬浮窗设置。
- 自动注入设置和注入长度限制。
- 默认推理选项。

`settingsStore` 不直接访问 `localStorage` 或 Store 文件，只通过 `SettingsRepository` 读写。

#### `diagnosticsStore`

负责：

- 当前请求时间线。
- 最近若干次请求摘要。
- UI 当前显示的日志筛选条件。
- 日志导出状态。

运行日志的权威持久化位置不在 Vue Store 中。Store 只保存界面需要的有限窗口，避免长时间运行后内存持续增长。

### 5.4 请求生命周期状态机

第二阶段必须用明确的状态机替代分散的布尔条件组合。

建议状态：

```text
idle
  → preparing
  → recording
  → committing
  → recognizing
  → generating
  → playing
  → completed
```

异常与取消路径：

```text
任意非终态 → cancelling → cancelled
任意非终态 → failed
连接断开   → failed
超时       → cancelling 或 failed
```

其中：

- `completed`、`cancelled`、`failed` 为请求终态。
- 终态请求不得继续接受普通业务事件。
- 开始新请求前，上一请求必须已经进入终态并完成本地资源清理。
- `playing` 只表示已经开始播放音频；助手文本生成和音频播放可能短暂重叠。若需要表达并行阶段，应在状态机之外使用只读阶段标记，不增加互相冲突的主状态。
- 听写模式可以从 `recognizing` 直接进入 `completed`。
- 无 TTS 的助手请求可以从 `generating` 直接进入 `completed`。

所有状态转换统一经过 `VoiceRequestController`，Store 不对外暴露任意修改 `requestStatus` 的接口。

建议定义：

```ts
interface RequestTransition {
  from: RequestLifecycleState;
  to: RequestLifecycleState;
  reason: string;
  atMonotonicMs: number;
}
```

非法转换在开发构建中必须抛出或记录错误，在正式构建中必须拒绝执行并将请求安全清理为 `failed`。

### 5.5 请求控制器

新增 `VoiceRequestController`，统一编排：

1. 检查连接、录音和当前请求状态。
2. 准备文本注入目标。
3. 启动请求并保存请求配置快照。
4. 接收录音帧并交给 Transport。
5. 提交录音统计信息。
6. 处理协议事件并驱动状态机。
7. 控制播放器和文本输出。
8. 处理取消、超时、断线和应用退出。
9. 记录时间线事件和结构化日志。

页面和快捷键处理器只能调用下列高级操作：

```ts
startPushToTalk(): Promise<void>
stopPushToTalk(): Promise<void>
cancelCurrentRequest(reason: CancelReason): Promise<void>
interruptPlayback(): Promise<void>
```

页面不得直接调用 `request.start`、`input.commit` 或修改请求 ID。

### 5.6 Transport 与协议事件分离

现有 WebSocket 模块拆分为：

#### `VoiceTransport`

负责：

- WebSocket 建连和关闭。
- 子协议协商。
- 握手、心跳、重连和背压。
- JSON 与二进制消息发送。
- 等待指定确认消息和传输超时。
- 将收到的原始消息解析为已验证事件。

#### `ProtocolEventRouter`

负责：

- 事件去重。
- `request_id` 与当前请求匹配校验。
- 未知事件和非法顺序处理。
- 将连接级事件和请求级事件分发给对应控制器。

#### `VoiceRequestController`

负责：

- 决定事件对业务状态的影响。
- 决定是否播放、注入、取消或失败。

Transport 不得直接修改 `requestStore`；控制器不得直接操作底层 WebSocket 对象。

### 5.7 录音控制与 UI 解耦

将 `RecorderPanel.vue` 中的录音和快捷键编排移动到 `RecordingController` 或 `useVoiceInteraction`：

- 页面只读取录音状态、音量和时长。
- 全局快捷键事件统一转换为按下、释放和取消意图。
- 快捷键重复触发、按键释放顺序和窗口销毁由控制层处理。
- 录音上限使用本地安全上限与 `server.hello.limits.max_recording_ms` 的较小值，不再在 UI 中固定显示或仅依赖硬编码的 60 秒。
- Recorder 仍只负责设备采集、编码、分帧和资源释放，不负责创建网络请求。

### 5.7.1 快捷键录入与平台注册

设置页不再提供固定快捷键下拉选项。用户点击“录制快捷键”后按以下事务流程执行：

1. 保存当前绑定和启用状态，并暂停按住说话快捷键。
2. 在捕获阶段监听窗口级 `keydown`/`keyup`，阻止组合触发页面默认行为。
3. 将物理按键 `KeyboardEvent.code` 与修饰键规范化为统一字符串，并实时显示组合。
4. 检查格式、系统保留组合、同一动作重复绑定和应用内部动作冲突。
5. 调用统一 Rust 命令尝试平台注册；只有平台注册成功才写入 `SettingsRepository`。
6. 录制取消、校验失败或平台注册失败时重新注册旧组合，持久设置保持不变。

规范化顺序固定为 `shift + control + alt + super + code`，例如：

```text
shift+control+KeyR
control+alt+Space
control+super
```

其中 `code` 使用物理键位名称，不受当前键盘布局字符影响。绑定必须包含至少一个修饰键；仅修饰键组合至少包含两个修饰键。同一动作录入与旧值相同的组合返回 `shortcut_duplicate_binding`，不同动作使用同一组合返回 `shortcut_internal_conflict`，不得静默覆盖。

平台策略：

| 平台    | 默认值                | 注册方式                                                                | 仅修饰键       | 能力检测  |
| ------- | --------------------- | ----------------------------------------------------------------------- | -------------- | --------- |
| Windows | `control+super`       | Rust 低层键盘钩子；带普通键的组合额外使用 `RegisterHotKey` 探测系统冲突 | 支持           | `windows` |
| macOS   | `control+super+Space` | Tauri Global Shortcut / 系统全局热键                                    | 当前需要普通键 | `macos`   |

Linux 不在本阶段实现范围内；其他平台统一通过相同接口返回 `unsupported_platform`。

仅修饰键组合不经过无法稳定表达该组合的通用插件。Windows 继续使用 Rust 平台监听层；其他平台若平台层尚无稳定实现，必须通过相同命令接口返回 `shortcut_modifier_only_unsupported`，上层不得伪装注册成功。

稳定错误码至少包括：

- `shortcut_invalid`
- `shortcut_key_unsupported`
- `shortcut_modifier_required`
- `shortcut_modifier_only_invalid`
- `shortcut_modifier_only_unsupported`
- `shortcut_duplicate_binding`
- `shortcut_internal_conflict`
- `shortcut_system_reserved`
- `shortcut_conflict`
- `shortcut_listener_unavailable`
- `shortcut_state_unavailable`
- `shortcut_restore_failed`

### 5.8 文本输出接口

第二阶段不实现输入法模式，但必须把“文本结果输出”从直接注入实现中抽象出来，避免上层业务永久绑定当前注入方式。

```ts
interface TextOutputBackend {
  readonly kind: "direct_injection" | "input_method";
  isAvailable(): Promise<boolean>;
  prepareTarget(): Promise<TextOutputTarget | null>;
  output(
    target: TextOutputTarget | null,
    text: string,
  ): Promise<TextOutputResult>;
}
```

第二阶段只实现并启用：

```text
DirectInjectionBackend
├─ Windows SendInput
└─ macOS CoreGraphics / Accessibility
```

`InputMethodBackend` 只保留类型和注册入口，不实现系统输入法，不在界面中暴露不可用选项。

Linux 适配必须在直接注入模式和输入法模式的产品行为均明确后再单独立项，不作为第二阶段附带任务。

### 5.9 悬浮窗同步优化

主窗口与悬浮窗同步改为事件驱动：

- 状态、文本、模式变化时立即推送。
- 音量和录音时长使用受控节流更新。
- 悬浮窗本地计算可推导的显示值，不要求主窗口固定高频发送完整快照。
- 同一时间只允许一个同步任务在途，后续更新合并为最新快照。
- 页面卸载或窗口关闭时必须取消定时器、监听器和待处理同步。

建议：

- 音量更新不高于 15 Hz。
- 时长显示不高于 10 Hz。
- 文本和状态仅在数据变化时推送。

### 5.10 统一配置存储

新增 `SettingsRepository`，统一通过 Tauri Store 读写设置。前端业务代码不得继续直接调用 `localStorage`。

建议配置结构：

```ts
interface AppSettings {
  schemaVersion: 1;
  service: {
    url: string;
    tokenConfigured: boolean;
    autoConnect: boolean;
  };
  audio: {
    inputDeviceId: string | null;
    language: string;
    audioResponseEnabled: boolean;
    voice: string;
    playbackVolume: number;
  };
  interaction: {
    defaultMode: VoiceInteractionMode;
    autoInjection: Record<VoiceInteractionMode, boolean>;
    injectionMaxCodePoints: number;
  };
  shortcut: {
    enabled: boolean;
    binding: ShortcutBinding;
  };
  overlay: {
    enabled: boolean;
    position: OverlayPosition;
  };
  inference: {
    asrId: string;
    llmId: string;
    ttsId: string;
    outputAudioId: string;
  };
}
```

Token 不进入普通 `AppSettings` 对象，也不返回在设置页面展示。设置页只能读取“已配置/未配置”，用户保存新 Token 时覆盖旧值，清除时显式删除密文。

本阶段不实现旧配置迁移：

- 原 `localStorage` 键可以删除或停止读取。
- 新版本首次启动使用默认设置。
- 不维护迁移脚本、双写逻辑和旧 schema 兼容分支。

## 6. M2：服务配置与 Token 鉴权

### 6.1 服务配置

设置页增加“服务连接”区域：

- WebSocket 服务地址。
- Token 输入、覆盖和清除。
- 自动连接开关。
- 保存配置。
- 测试连接。
- 当前连接状态、协议版本和服务端标识。

服务连接以档案管理。用户可以新建、复制、重命名、删除和切换档案；每个档案独立保存地址、自动连接、鉴权方式、首选 Pipeline 和 Token。至少保留一个档案，复制档案不复制 Token。切换或删除当前档案前不得存在活跃请求，切换完成后关闭旧连接并按新档案重连。

地址校验规则：

- `ws://` 只允许 loopback 调试地址。
- 非 loopback 地址必须使用 `wss://`。
- 禁止把 Token 写入 URL 查询参数或 fragment。
- 保存前进行 URL 解析和协议校验。
- 地址修改时，当前连接必须先安全关闭，再按新配置重新连接。

### 6.2 Token 存储

Token 必须加密后写入 Tauri Store：

```text
用户输入 Token
  → 前端调用 Rust Command
  → Rust 加密
  → 密文写入 Tauri Store
  → 前端仅保留“已配置”状态
```

要求：

- 加解密逻辑位于 Rust 层。
- 密钥材料不得写入前端代码、日志或同一个 Store 字段。
- 平台实现应使用系统可保护的设备级密钥材料；Windows 和 macOS 可以采用不同底层实现，但对前端暴露统一 Command。
- Token 明文只在建立连接所需的最短生命周期内存在。
- Token 不得出现在错误信息、调试日志、时间线、崩溃报告或导出包中。
- 清除 Token 时同时清除 Store 密文和内存中的临时值。
- Token 密文以服务档案 ID 隔离，切换、覆盖或删除一个档案不得影响其他档案凭据。

本阶段的威胁模型主要防止配置文件被直接复制后泄露明文 Token，不承诺抵御已经获得当前用户会话控制权的本地恶意程序。

### 6.3 应用层鉴权

WebSocket 浏览器接口无法可靠设置自定义 HTTP Header，因此第二阶段采用协议内鉴权，不把长期 Token 放入 URL。

建议在 `client.hello` 中增加可选字段：

```json
{
  "auth": {
    "scheme": "bearer",
    "token": "<token>"
  }
}
```

规则：

- 未配置 Token 时省略 `auth`。
- 需要鉴权但未提供 Token时，服务端返回会话级 fatal error。
- Token 无效或过期时，服务端返回稳定错误码，客户端停止自动重连并提示重新配置。
- Token 不得被通用 JSON 日志记录器序列化。
- `client.hello` 的调试输出必须使用脱敏副本。

建议新增错误码：

- `authentication_required`
- `authentication_failed`
- `token_expired`

该扩展实现前必须更新 `WS_PROTOCOL.md`，明确兼容行为、错误码和 Mock 行为。

### 6.4 测试连接

“测试连接”执行独立的短连接流程：

1. 校验服务地址。
2. 读取并临时解密 Token。
3. 完成 WebSocket、子协议和 `client.hello/server.hello` 握手。
4. 验证鉴权结果。
5. 显示连接耗时、协议版本、服务端 pipeline 和可用模型。
6. 主动关闭测试连接。

测试连接不得占用正式连接实例，也不得改变当前请求状态。

### 6.5 麦克风与语音输出设置

当前请求中的识别语言和语音音色仍使用固定值，录音模块也只使用系统默认输入设备。第二阶段应将这些值纳入统一设置和请求配置快照。

设置项：

- 麦克风输入设备。
- 识别语言；至少支持“自动”和服务端明确支持的语言选项。
- 是否请求语音回复。
- TTS 音色或 voice ID。
- 本地播放音量。
- 录音上限只读展示；实际值取客户端安全上限与服务端协商上限的较小值。

统一设备描述：

```ts
interface AudioInputDevice {
  id: string;
  label: string;
  isDefault: boolean;
  backend: "web_audio" | "native";
}
```

实现要求：

- Windows/WebView 录音通过 `enumerateDevices()` 和 `deviceId` constraint 选择设备。
- macOS 通过 `enumerateDevices()` 展示全部可见麦克风；系统默认设备继续使用原生录音后端，用户明确选择的其他设备通过精确 `deviceId` 交给 Web Audio 采集，上层继续使用同一设备设置模型。
- 未授权前设备名称可能不可见，界面必须能显示“默认麦克风”等降级名称。
- 已选择设备不存在时回退到系统默认设备，并记录一条 `warn` 日志。
- 录音进行中不允许切换设备；变更在下一次请求生效。
- 监听设备变化，在耳机插拔后刷新列表，但不得中断已经进行的请求。
- 提供短时麦克风测试和电平显示，测试不得创建服务端请求。
- 播放音量只作用于本地播放器，不改变服务端生成的 PCM 数据。
- `language`、`voice`、是否请求音频及推理模型均在 `request.start` 前形成不可变快照。
- 服务端不支持已保存选项时，回退到 `server.hello` 默认值并在界面提示，不得以无效 ID 发起请求。

如服务端需要新增可用语言或 voice 列表，应通过 `server.hello` 的向后兼容字段提供；客户端不得长期硬编码只支持 `zh-CN` 和 `default`。

## 7. M3：请求时间线与运行日志

### 7.1 设计目标

时间线用于回答“这一次请求卡在哪一步”，日志用于回答“客户端为什么进入这个状态”。两者共享 request ID，但用途不同：

- 时间线：少量、稳定、面向一次请求的关键节点。
- 日志：详细、分级、跨请求的运行记录。

### 7.2 请求时间线

每个请求至少记录以下事件：

```text
request.triggered
recording.prepare_started
recording.started
audio.first_frame_sent
recording.stopped
input.commit_sent
input.committed
asr.first_partial
asr.final
assistant.first_token
assistant.text_done
output.first_chunk
output.playback_started
output.playback_done
text_output.started
text_output.done
request.cancel_sent
request.cancelled
request.done
request.failed
```

不同模式可缺少不适用的事件，但必须保留请求起点和唯一终态。

数据结构：

```ts
interface RequestTimelineEvent {
  requestId: string;
  type: string;
  monotonicMs: number;
  wallClockMs: number;
  stage: "input" | "asr" | "llm" | "tts" | "output" | "request";
  summary: string;
  details?: Record<string, string | number | boolean | null>;
}
```

要求：

- 本地延迟计算使用单调时钟，避免系统时间变化影响结果。
- `wallClockMs` 只用于显示和日志关联。
- `details` 不保存完整转录、完整回复、Token 或音频内容。
- 同一事件只记录一次；重复协议消息可记录为日志警告，但不重复写入主时间线。
- 时间线终态与请求状态机终态必须一致。

### 7.3 时间线界面

增加“时间线与日志”页面或面板。

时间线至少显示：

- 当前或最近一次请求 ID。
- 模式、录音时长、终态。
- 按时间排序的事件节点。
- 相对请求开始时间。
- 关键耗时汇总。
- 上行帧数和字节数、下行音频分片数、播放器 underrun 次数及请求期间重连次数。

关键耗时：

| 指标           | 计算                                            |
| -------------- | ----------------------------------------------- |
| 录音准备耗时   | `recording.started - recording.prepare_started` |
| 提交确认耗时   | `input.committed - input.commit_sent`           |
| 最终 ASR 延迟  | `asr.final - input.commit_sent`                 |
| 首 Token 延迟  | `assistant.first_token - input.commit_sent`     |
| 首音频到达延迟 | `output.first_chunk - input.commit_sent`        |
| 首次播放延迟   | `output.playback_started - input.commit_sent`   |
| 总请求耗时     | 终态事件 - `request.triggered`                  |

听写模式、无 TTS 模式只显示适用指标。

### 7.4 运行日志

日志统一使用结构化记录：

```ts
interface LogEntry {
  timestampMs: number;
  level: "debug" | "info" | "warn" | "error";
  module: string;
  event: string;
  message: string;
  requestId?: string;
  fields?: Record<string, string | number | boolean | null>;
}
```

建议模块：

- `connection`
- `protocol`
- `request`
- `recorder`
- `player`
- `text_output`
- `shortcut`
- `overlay`
- `settings`
- `permissions`

必须记录：

- 建连、握手、断线和重连原因。
- 请求状态转换。
- 超时、取消和错误终态。
- 音频背压、丢弃和播放器 underrun。
- 文本输出失败及稳定错误码。
- 快捷键注册失败和权限异常。
- 配置读取、保存失败，但不得记录敏感字段值。

### 7.5 日志存储与轮转

日志由 Rust 层写入应用日志目录，避免依赖 WebView 控制台作为正式日志。

要求：

- 单文件大小受限。
- 保留文件数量受限。
- 应用启动时清理超出保留策略的旧日志。
- Debug 构建默认包含 `debug`；Release 构建默认最低为 `info`。
- UI 只读取最近部分日志，使用分页加载，并支持起止时间、级别、模块和 request ID 联合筛选。
- 日志中的 request ID 可直接跳转对应时间线。
- 用户可以清空日志或打开系统日志目录，清空操作必须二次确认。
- 日志写入失败不得导致主请求失败，但必须在 UI 中显示一次非阻塞警告。

建议默认策略：

- 单文件最大 5 MiB。
- 最多保留 5 个文件。
- 导出时包含当前和最近轮转文件。

具体值可以在实现时调整，但必须设置上限。

### 7.6 脱敏与导出

导出为标准 ZIP 文件，内容：

```text
diagnostic-<timestamp>.zip
├─ settings-sanitized.json
├─ environment.json
├─ recent-requests.json
├─ timelines.json
├─ client.log
├─ app-info.json
└─ README.txt
```

脱敏要求：

- Token 和认证消息中的凭证字段始终替换为 `<redacted>`。
- 服务 URL 默认保留 scheme、host 和 path；查询参数全部移除。
- 默认不导出完整 ASR 文本和助手回复。
- 默认不导出录音和播放音频。
- 操作系统用户名、用户目录和绝对路径应进行裁剪或替换。
- 导出前界面明确显示将包含的内容。

### 7.7 发布前安全加固

发布构建必须在 M4 验收前完成以下安全收口：

- WebView 启用明确的 CSP。发布策略默认只加载应用自身资源，禁止对象、表单和外部 frame；网络连接只开放 Tauri IPC 与 `wss:` 服务。开发策略仅额外开放本机 Vite 地址和 HMR WebSocket，不得复用为发布策略。
- Tauri Capability 按窗口拆分。主窗口可以使用应用命令、Core API 与 Store；悬浮窗只保留状态同步所需的 Event API，不得读取 Store、服务档案、Token、日志或调用设置操作。Token 与本地数据清理命令还必须在 Rust 层校验调用窗口，防止自定义 Command 绕过插件权限。
- 设置页提供“清除本地数据”操作，并在执行前二次确认。清除范围固定为全部设置/服务档案、全部服务 Token 密文、系统钥匙串中的 Token 加密密钥和诊断日志。清除成功后应用使用默认配置重载；任一步骤失败必须返回稳定错误信息，不得显示成功。
- 当前阶段不存储对话历史和音频，因此清除操作不维护空的兼容层；后续若增加历史持久化，必须同步纳入同一 Rust 命令，避免前端遗漏数据源。
- 诊断导出必须继续生成标准 ZIP，并在写入前对设置、请求时间线和日志进行脱敏。包内不得包含 Token、认证头、完整转写/回复、音频、用户目录或带查询参数的服务 URL。

安全验收：

- 发布配置中 `csp` 不得为 `null`，且不得包含发布环境的 `unsafe-eval`。
- `overlay` Capability 不得包含 `store:*` 或主窗口的广泛 Core 权限。
- 一键清除后 `settings.json`、`credentials.json` 的业务字段为空，旧 Token 无法再解密，旧诊断日志不可读取。
- 清除过程中存在活跃请求时按钮不可用；失败时保留错误提示，不自动重载。
- 诊断 ZIP 通过标准解压工具打开，并通过敏感字段与明文 Token 扫描。

## 8. M4：稳定性、Mock 与测试

### 8.1 Mock 故障注入

Mock 服务增加可配置故障场景：

- 握手延迟或握手超时。
- 鉴权缺失、Token 错误和 Token 过期。
- `request.accepted` 或 `input.committed` 超时。
- ASR final 缺失。
- LLM 首 Token 延迟。
- TTS 中途失败。
- 请求处理中断开连接。
- 重复 `event_id`。
- 非当前 request ID 消息。
- 未知消息类型。
- 控制消息顺序错误。
- 二进制音频帧损坏。
- `request.done` 提前或缺失。
- 服务端长时间不返回 `request.cancelled`。

故障场景必须可以通过启动参数或开发控制页面选择，默认运行仍保持正常路径。

### 8.2 自动化测试分层

#### 单元测试

覆盖：

- 状态机合法和非法转换。
- 协议事件路由与去重。
- 时间线事件幂等。
- 日志脱敏。
- 设置校验和默认值。
- 服务 URL 安全规则。
- 音频设备回退、语言与 voice 选项回退。
- 文本输出 Backend 选择。

#### 集成测试

覆盖：

- `VoiceRequestController + Mock Transport` 完整请求。
- 录音提交、取消、断线和超时。
- 不同模式的合法时序。
- Token 缺失和鉴权失败。
- 请求终态后的资源清理。

#### Rust 测试

覆盖：

- Token 加密、解密和清除。
- Store 读写失败处理。
- 日志轮转和脱敏。
- Windows/macOS 文本输出接口返回结构一致。

#### 端到端人工验收

Windows 和 macOS 分别完成：

- 听写、助手、混合模式。
- 全局按住说话和取消。
- 自动注入和手动注入。
- 播放中断。
- 断线重连。
- Token 正确、错误和清除。
- 时间线与日志导出。

### 8.3 质量门

每个合并请求必须通过：

```text
npm run format:check
npm run lint
npm run typecheck
npm run test
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

涉及 Windows/macOS 原生能力时，必须保证两个平台 CI 均通过；无法在 CI 自动验证的权限和注入行为，应在 PR 中附人工验证记录。

### 8.4 实施结果与人工签收

Mock 使用稳定场景名，通过 `node server.mjs --fault <name>` 或 `MOCK_FAULTS=<name>` 启用；多个场景使用逗号组合，延迟类场景使用 `--fault-delay-ms` 或 `MOCK_FAULT_DELAY_MS`。未指定场景时仍为正常路径。

| 故障类别           | 稳定场景名                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| 握手延迟/超时      | `handshake_delay`、`handshake_timeout`                                                                          |
| 鉴权缺失/错误/过期 | `auth_missing`、`auth_invalid`、`auth_expired`                                                                  |
| 请求确认超时       | `request_accepted_timeout`、`input_committed_timeout`                                                           |
| 推理阶段异常       | `asr_final_missing`、`llm_first_token_delay`、`tts_midstream_failure`                                           |
| 连接与取消异常     | `disconnect_during_request`、`cancellation_timeout`                                                             |
| 协议健壮性         | `duplicate_event_id`、`stale_request_id`、`unknown_message_type`、`out_of_order_control`、`corrupt_audio_frame` |
| 请求终态异常       | `request_done_early`、`request_done_missing`                                                                    |

自动化验收已经覆盖：

- Mock 正常听写/助手流程、Bearer Token 正确/缺失/错误/过期，以及重复事件、过期请求、未知消息和乱序控制消息的真实 WebSocket 流。
- 请求状态机正常、取消、失败和非法终态转换；协议事件按连接/当前请求路由、事件去重和终态拒收。
- `VoiceRequestController + Mock Transport` 完整听写、提交、ASR final、请求完成和资源释放；ASR final 缺失时拒绝提前 `request.done`，`request.done` 缺失时通过总终态计时器失败并取消。
- 握手、`request.accepted` 超时与损坏服务端音频帧的稳定错误码。
- 时间线事件幂等、日志脱敏、设置默认值和边界、服务 URL 规则、麦克风/语言/voice/模型回退，以及文本输出 Backend 选择。
- Rust Token 加解密、诊断日志轮转/脱敏/标准 ZIP、快捷键解析和平台文本输出单元测试。

以下项目依赖真实系统权限、前台应用和音频设备，不能用 Mock 代替。发布候选包必须在 Windows 与 macOS 各执行一次并记录版本、系统版本、执行人、日期和结果：

- [ ] 听写、助手、混合模式完成请求。
- [ ] 全局按住说话、释放提交与 Escape 取消。
- [ ] 自动注入、手动注入及部分失败重试。
- [ ] TTS 播放与播放中断。
- [ ] 处理中断线、自动重连及恢复后新请求。
- [ ] Token 正确、错误、过期与清除。
- [ ] 请求时间线、日志查看和脱敏 ZIP 导出。
- [ ] 麦克风、辅助功能权限缺失/授予后的行为。

## 9. 建议目录结构

```text
mindsurf-voice-ai/src/
├─ components/
│  ├─ recorder/
│  ├─ settings/
│  ├─ diagnostics/
│  └─ shared/
├─ controllers/
│  ├─ voiceRequestController.ts
│  ├─ recordingController.ts
│  └─ overlaySyncController.ts
├─ stores/
│  ├─ connectionStore.ts
│  ├─ requestStore.ts
│  ├─ settingsStore.ts
│  └─ diagnosticsStore.ts
├─ services/
│  ├─ transport/
│  │  ├─ voiceTransport.ts
│  │  └─ protocolEventRouter.ts
│  ├─ audio/
│  │  ├─ recorder.ts
│  │  └─ streamingPlayer.ts
│  ├─ text-output/
│  │  ├─ types.ts
│  │  └─ directInjectionBackend.ts
│  ├─ settings/
│  │  └─ settingsRepository.ts
│  └─ diagnostics/
│     ├─ timeline.ts
│     └─ logger.ts
├─ types/
│  ├─ connection.ts
│  ├─ request.ts
│  ├─ settings.ts
│  ├─ diagnostics.ts
│  └─ protocol.ts
└─ composables/
   ├─ useVoiceInteraction.ts
   └─ useDiagnostics.ts

mindsurf-voice-ai/src-tauri/src/
├─ commands/
│  ├─ credentials.rs
│  ├─ diagnostics.rs
│  ├─ text_input.rs
│  ├─ permissions.rs
│  ├─ shortcut.rs
│  └─ window.rs
├─ platform/
│  ├─ windows/
│  └─ macos/
├─ settings/
│  ├─ mod.rs
│  └─ encryption.rs
├─ diagnostics/
│  ├─ logger.rs
│  ├─ redaction.rs
│  └─ export.rs
├─ app_state.rs
├─ error.rs
└─ lib.rs
```

该结构是目标边界，不要求一次提交全部移动完成。重构应按可运行的小步骤推进，避免长时间维护无法构建的中间分支。

## 10. 重构提交顺序建议

1. 补充状态机、事件路由和现有行为测试。
2. 引入 `requestStore` 和 `VoiceRequestController`，保持 UI 不变。
3. 拆分 `connectionStore`，将 Transport 从原 Store 移出。
4. 把播放和文本输出控制迁入 Controller/Service。
5. 将 `RecorderPanel` 的快捷键、录音和悬浮窗编排移出组件。
6. 引入 `SettingsRepository` 和 Tauri Store，删除原 `localStorage` 读写。
7. 增加服务地址、音频设备、语言、voice 和本地播放设置。
8. 增加 Token 加密与协议鉴权。
9. 引入时间线和结构化日志。
10. 增加 Mock 故障注入及集成测试。
11. 完成 Windows/macOS 全量回归和文档更新。

每一步完成后主分支都应保持可运行，不采用一次性重写。

## 11. 验收标准

### 11.1 架构验收

- `voiceSession.ts` 已删除，UI 直接使用职责拆分后的 Store 与 Controller。
- UI 组件不直接持有或操作 WebSocket 实例。
- 所有请求状态变化通过统一状态机执行。
- 所有请求均只有一个明确终态。
- 文本输出通过 `TextOutputBackend` 调用，上层不直接依赖平台注入函数。
- 所有持久设置通过 `SettingsRepository` 访问，不再直接使用 `localStorage`。

### 11.2 功能验收

- Windows/macOS 上 Phase 1 的三种模式、快捷键、悬浮窗、流式播放和文本注入行为无回归。
- 快捷键可通过实际按键录入；注册失败或取消后恢复旧绑定，系统保留和应用内部冲突均有稳定错误码。
- Windows/macOS 使用各自默认值，且平台能力状态与实际注册结果一致。
- 可在界面修改服务地址并完成测试连接。
- 非 loopback 明文 `ws://` 地址被拒绝。
- Token 可保存、覆盖和清除，Store 文件中不存在明文 Token。
- 鉴权失败不会无限自动重连，并能给出明确提示。
- 可选择可用麦克风；设备消失时能安全回退到默认设备。
- 识别语言、是否请求语音、voice 和播放音量按设置生效，请求中不再固定使用 `zh-CN` 和 `default`。
- 每次请求均生成可查看的时间线和唯一终态。
- 日志可按级别、模块和 request ID 筛选。
- 导出包不包含 Token、完整转录、完整回复和音频。

### 11.3 稳定性验收

- Windows 和 macOS 各连续完成 100 次正常请求，无崩溃、无无法开始下一请求的状态卡死。
- 在录音、识别、生成和播放阶段分别执行取消，均能在限定时间内回到可开始新请求的状态。
- 请求处理中断线后，本地录音、播放器、定时器和活跃请求均被清理。
- 重复事件、过期事件和错误 request ID 不改变当前请求正确状态。
- 日志和时间线长时间运行后内存与磁盘占用保持有界。
- 现有 CI 质量门全部通过。

## 12. 文档更新要求

第二阶段实现过程中同步维护：

- `README.md`：服务配置、Token 配置和运行方式。
- `WS_PROTOCOL.md`：鉴权字段、鉴权错误码和兼容规则。
- `DELIVERY.md`：Phase 2 已实现能力和发布范围。
- 新增故障注入说明或 Mock README。
- 本文档：里程碑状态、实现偏差和最终验收结果。

协议、实现和 Mock 三者不得只更新其中一处。

## 13. 后续阶段预留

第二阶段完成后，可以分别评估以下独立方向：

1. **输入法模式**：明确组合文本、候选窗、提交和取消行为，并实现 `InputMethodBackend`。
2. **Linux 适配**：在直接注入模式和输入法模式均有稳定接口后，按 X11/Wayland 能力选择实现。
3. **原生音频模型**：在 Transport 和请求控制层稳定后，增加 `native_audio` pipeline 协商和对应事件。
4. **持续交互**：如产品需求转向多轮对话，再单独设计会话上下文，不复用当前单次请求状态强行扩展。

这些方向不得反向阻塞第二阶段的架构重构、配置接入和可观测性建设。

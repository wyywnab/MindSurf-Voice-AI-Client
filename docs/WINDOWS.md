# Windows 构建与发布

## 系统要求

- Windows 10/11 x64；
- Node.js 22+、Rust stable；
- Microsoft Edge WebView2 Runtime；
- 构建 MSI 时需要 Windows 的 VBSCRIPT 可选功能，GitHub 托管 runner 默认提供。

## 本地验证

```powershell
cd mindsurf-voice-ai
npm ci
npm run check
npm run tauri build -- --bundles nsis,msi
```

Tauri 会分别在 `src-tauri/target/release/bundle/nsis` 和
`src-tauri/target/release/bundle/msi` 下生成安装包。日常 CI 的 `Windows quality
gate` 负责编译和测试 Windows 原生代码，`Windows installers` 进一步生成未签名
的 Debug NSIS/MSI，确保安装包链路不会只在发布时才被验证。

## GitHub Release

`.github/workflows/release-desktop.yml` 在 `v*` tag 或手动触发时执行以下流程：

1. 校验 `tauri.conf.json`、`package.json`、`Cargo.toml` 和 tag 版本一致；
2. 构建、签名并公证 Universal macOS App/DMG，创建 Draft Release；
3. 在 `windows-latest` 上导入代码签名证书；
4. 构建并签名 x64 NSIS/MSI，将二者上传到同一个 Draft Release；
5. 无论构建成功与否，都从 runner 证书库删除临时导入的证书和 PFX 文件。

Windows 发布需要在 GitHub Actions 中配置两个 Repository Secrets：

- `WINDOWS_CERTIFICATE`：包含私钥的 PFX 文件经过 Base64 编码后的完整内容；
- `WINDOWS_CERTIFICATE_PASSWORD`：PFX 导出密码。

可以在 PowerShell 中生成 `WINDOWS_CERTIFICATE`：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificate.pfx"))
```

证书必须是受 Windows 信任的代码签名证书并包含可导入的私钥。使用硬件令牌、
Azure Artifact Signing 或其他不可导出证书时，需要按签发机构要求把工作流改为
对应的自定义 `signCommand`，不能把硬件证书转换成 PFX 上传。

当前客户端版本为 `0.2.0`，发布 tag 必须为 `v0.2.0`。工作流创建的是 Draft
Release；应在两个平台的安装与签名验收完成后再由维护者手动发布。

## 发布前人工验收

- 在干净的 Windows 10 和 Windows 11 x64 环境分别安装 NSIS 与 MSI；
- 检查安装包、主程序和卸载程序的数字签名；
- 验证 WebView2 检测、系统浏览器登录回跳和 Windows Credential Manager；
- 验证全局快捷键、麦克风、文本注入、托盘和关闭隐藏行为；
- 启用登录自启动后注销再登录，确认仅驻留托盘且任务管理器状态同步；
- 从 `0.1.x` 升级到 `0.2.0`，再执行卸载，确认程序文件和失效自启动项不会残留。

# AI锦衣卫 Windows Agent

这是员工电脑端的 Tauri 2 + React MVP。当前目标是 Windows 10/11，负责采集前台应用活动、脱敏工作标识、可识别的网站域名、系统空闲状态和同步心跳。0.1.9 起，Agent 会在 Windows 本地利用窗口标题和浏览器 UI Automation 的可访问性名称提取允许的结构化标签，例如项目、来源、操作、状态和资源分类；原始标题、页面正文和控件文本不会保存或上传。应用会话和空闲会话都使用同一个事件 ID checkpoint，默认每 15 秒向服务端更新一次持续时长；心跳仍按策略默认每 60 秒发送。这样历史页可以较快显示应用切换和持续增长的时长，而不是只显示首次检测到的片段。0.1.11 起，Agent 会自动创建当前 Windows 用户的开机启动项，重启后恢复托盘进程。0.1.12 起，首次注册或隐私策略版本变化后，Agent 会先展示采集说明；员工确认前不会新增或上传活动事件，确认记录由服务端按策略版本留痕。

浏览器域名优先由 Agent 使用 Windows UI Automation 读取当前浏览器地址栏并仅提取域名，因此普通 Chrome/Edge 使用不强制安装扩展；如果浏览器策略、远程桌面或权限导致原生回退读不到地址栏，可选装 `browser-extension/` 扩展补充精确域名和有限来源提示。两种来源重叠时，服务端会合并重复时间线并优先保留扩展来源。

管理员可以在管理后台的“权限 → 采集策略”中将活动更新时间调整为 15、30 或 60 秒。该策略通过 Agent 心跳下发，修改后无需重新构建 MSI；只有 Agent 版本升级或采集代码变化时才需要重新安装 MSI。

## 本地开发

需要 Node.js、Rust/Cargo，以及 Windows 构建环境。服务端先在局域网启动：

```bash
cd ../server
AGENT_ADMIN_TOKEN=dev-admin-token npm start
```

再启动 Agent：

```bash
cd ../agent
npm install
npm run tauri:dev
```

生成 MSI：

```bash
npm run tauri:build
```

Agent 使用一次性注册码注册设备。开发注册码可通过服务端接口生成：

```bash
curl -X POST http://localhost:8787/api/admin/registration-codes \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"employee_id":"employee-wei"}'
```

MVP 不采集键盘、剪贴板、屏幕、聊天正文、文件正文、原始窗口标题或完整网页内容。开发工具只保留经过清洗的项目标识；浏览器原生 UI Automation 和可选扩展只保留域名、有限来源提示以及允许的结构化工作标签，不上传页面文字。已注册 Agent 可以在界面中生成一次性浏览器配对码，Chrome/Edge 扩展用它换取独立的短期凭据，不需要把设备 Token 粘贴到浏览器。

## Windows 一键安装包

`.github/workflows/build-agent-windows.yml` 会在 Windows runner 上生成通用 MSI。安装包只预置局域网服务地址，不预置员工注册码；员工首次启动 Agent 后，在注册页面输入管理员临时生成的一次性注册码完成绑定，不需要为每台电脑重新构建安装包。

GitHub 仓库建议配置：

- Repository variable：`AGENT_SERVER_URL`，例如 `http://192.168.1.20:8787`
- 如果创建 `v*` 版本标签发布正式 MSI，再配置 Repository secrets：`WINDOWS_SIGNING_PFX_BASE64`、`WINDOWS_SIGNING_PFX_PASSWORD`。普通分支构建仍生成未签名测试包；版本标签构建会强制签名，缺少证书时直接失败，避免误把未签名包当成正式交付物。

注册码由管理员在员工准备安装时临时生成，并在 Agent 首次启动时输入；同一个注册码只能成功注册一台设备。

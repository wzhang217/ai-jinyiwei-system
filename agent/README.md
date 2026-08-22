# AI锦衣卫 Windows Agent

这是员工电脑端的 Tauri 2 + React MVP。当前目标是 Windows 10/11，负责采集前台应用活动、系统空闲状态和同步心跳。

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

MVP 不采集键盘、剪贴板、屏幕、聊天正文、文件正文或完整网页内容。

## Windows 一键安装包

`.github/workflows/build-agent-windows.yml` 会在 Windows runner 上生成 MSI。普通 push 会生成通用安装包；手动触发 workflow 时，如果仓库配置了 `AGENT_REGISTRATION_CODE` Secret，workflow 会把一次性注册码写入安装资源，员工安装后自动注册。

GitHub 仓库建议配置：

- Repository variable：`AGENT_SERVER_URL`，例如 `http://192.168.1.20:8787`
- Repository secret：`AGENT_REGISTRATION_CODE`，只用于下一次手动构建的一次性注册码

注册码不要长期保留在 Secret 中。生成一个员工安装包、下载 MSI 后，应立即删除或替换该 Secret；同一个注册码只能成功注册一台设备。

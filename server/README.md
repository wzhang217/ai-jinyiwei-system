# AI锦衣卫 Agent Server

局域网 MVP 服务端，使用 Node.js 内置 `node:sqlite`，负责一次性注册码、设备 Token、事件幂等、心跳和采集策略。

## 启动

```bash
npm start
```

默认监听 `0.0.0.0:8787`，每次启动会生成随机管理员 Token 并打印到服务端终端。正式试点请设置 `AGENT_ADMIN_TOKEN`，并在反向代理后使用 HTTPS。

## 生成注册码

```bash
AGENT_ADMIN_TOKEN=dev-admin-token npm start

curl -X POST http://localhost:8787/api/admin/registration-codes \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"employee_id":"employee-wei"}'
```

返回的注册码只能使用一次。设备注册后，Agent 使用设备 Token 上传应用活动、脱敏工作标识、可识别的网站域名和心跳；事件按 `event_id` 幂等写入，适合断网恢复补传。服务端拒绝包含 `/`、查询参数或片段的网页值，避免完整 URL 进入事件表。

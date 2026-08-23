# AI锦衣卫 Agent Server

局域网 MVP 服务端，使用 Node.js 内置 `node:sqlite`，负责一次性注册码、设备 Token、事件幂等、心跳、采集策略、Memory Summary 和 History Skill。

## 启动

首次配置先复制环境变量模板，并只在服务端填写百炼 API Key：

```bash
cp .env.example .env
# 编辑 .env，填写 DASHSCOPE_API_KEY
```

```bash
npm start
```

`npm start` 和 `npm run dev` 会自动读取 `server/.env`。默认监听 `0.0.0.0:8787`，每次启动会生成随机管理员 Token 并打印到服务端终端。正式试点请设置 `AGENT_ADMIN_TOKEN`，并在反向代理后使用 HTTPS。

## AI 摘要与 History Skill

服务端默认按阿里云 DashScope 的 OpenAI 兼容接口配置 `qwen3.7-plus`。密钥只放在服务端环境变量，不进入前端、Agent 或 MSI：

```bash
# server/.env
DASHSCOPE_API_KEY=你的百炼APIKey
AI_MODEL=qwen3.7-plus
AI_API_URL=https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions
AI_ENABLED=true
AI_MAX_REQUESTS_PER_MINUTE=30
AI_MAX_INPUT_RECORDS=200
AI_REQUEST_TIMEOUT_MS=20000
AI_ENABLE_THINKING=false
AI_SUMMARY_WINDOW_SECONDS=600
AI_ACTIVE_GRACE_SECONDS=45
AI_GENERATION_BATCH_SIZE=1
AGENT_ADMIN_TOKEN=dev-admin-token
```

也可以使用 `AI_API_KEY`、`AI_MODEL` 和 `AI_API_URL` 覆盖默认配置。未配置密钥时，服务会使用本地规则兜底并将摘要标记为 `fallback`；采集、历史记录和离线补传不受影响。

启动后可在服务端终端看到 `AI provider: qwen3.7-plus`。如果显示 `rules-v1`，说明没有读取到 API Key；这不影响 Agent 采集，但不会调用 Qwen。

`GET /api/admin/history` 会将 Leaf/Rollup Summary 持久化到 `memory_summaries` 表；`POST /api/admin/history/ask` 默认会在留存窗口内召回已持久化的 Memory Summary，再结合最近活动覆盖更新的记录进行排序和问答，不只搜索最近一页活动。模型输入只包含应用、时长、切换、脱敏标识和网站域名等活动元数据。

History Skill 的召回使用 `semantic-metadata-v1`：先按时间和权限过滤，再用工作语义分组（开发、浏览器、沟通、文档、项目管理、AI 工作台等）结合应用、域名、来源类型、工作标识和活动顺序进行排序，最后把排序后的脱敏证据交给 Qwen 生成回答。这个检索层不读取原始窗口标题、完整 URL、文件正文或聊天正文，也不会为每条活动额外调用模型。

服务端和数据库以带 `Z` 的 UTC ISO 时间保存和传输事件，前端、Agent 界面、浏览器配对提示和日期边界统一按 `Asia/Shanghai`（UTC+8）展示和计算，避免跨设备时区不同造成日期错位。

采集策略中的 `activity_checkpoint_seconds` 控制同一活动区间的实时更新间隔，默认 15 秒，可在管理后台设置为 15、30 或 60 秒；`heartbeat_interval_seconds` 仍独立控制设备心跳，默认 60 秒。修改策略后，已注册 Agent 会在下一次心跳拉取新策略。

管理后台的团队和员工目录通过 `GET /api/admin/teams`、`GET /api/admin/employees` 读取服务端组织数据，并沿用管理员、管理者和员工的服务端权限范围；前端不再把演示目录作为真实数据源。

管理后台的“立即刷新”会重新读取 `GET /api/admin/history`，历史记录页的导出会调用 `POST /api/admin/history/export`，服务端返回当前权限范围内的记录并写入 `history_exported` 审计日志。设备列表读取真实心跳；超过策略心跳间隔的设备会被标记为离线，并写入 `agent_offline`，恢复心跳后写入 `agent_online`。

历史记录同时提供 Leaf、连续窗口、小时、每日、个人每周和团队周 Rollup Summary。模型暂时不可用时会先返回规则兜底摘要，并写入 `memory_generation_jobs`，后台会按退避策略重试，最多 5 次。`AI_MAX_REQUESTS_PER_MINUTE` 控制单个服务进程的模型调用预算，超过后暂时使用规则摘要并进入重试队列。模型请求默认 20 秒超时，并默认关闭 qwen3.7-plus 的思考模式以适配短摘要和实时问答；超时同样会进入规则兜底和重试流程。需要保留思考过程时可设置 `AI_ENABLE_THINKING=true`，但应同步提高 `AI_REQUEST_TIMEOUT_MS`。

AI 摘要和活动采集采用不同频率：Agent 仍按采集策略实时上报活动区间，但服务端只对已经闭合且达到 `AI_SUMMARY_WINDOW_SECONDS`（默认 10 分钟）的 Leaf 窗口生成一次 AI 摘要；当前仍在增长的窗口显示规则摘要并标记为 `window_pending`，不会因为每次 15 秒活动更新、心跳或前端刷新而重新调用模型。小时、每日、每周等 Rollup 由已生成的 Leaf 和规则聚合得到，不额外触发模型调用，避免一次活动同时派生多次 AI 请求；失败的 Leaf 任务仍按原有退避策略重试。`AI_ACTIVE_GRACE_SECONDS`（默认 45 秒）用于判断最近活动是否仍在增长。后台默认每 15 秒最多处理 1 个生成任务，`AI_GENERATION_BATCH_SIZE` 可按服务端额度调整，避免历史补偿队列瞬间打满模型请求。

管理员可以先预览再执行数据留存删除，删除活动事件、Leaf/Rollup Summary，并写入审计日志：

```bash
curl -X POST http://localhost:8787/api/admin/retention \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"before":"2026-05-01T00:00:00.000Z"}'

# 确认后才执行：
curl -X POST http://localhost:8787/api/admin/retention \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"before":"2026-05-01T00:00:00.000Z","apply":true}'
```

管理员可以用启动 Token 换取有范围的会话令牌：

```bash
curl -X POST http://localhost:8787/api/admin/sessions \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"role":"employee","employee_id":"employee-wei"}'
```

之后用返回的 Token 放在 `x-admin-session` 中访问历史、设备、事件和问答接口。`admin` 角色只能由启动 Token 使用；正式试点应设置随机的 `AGENT_SESSION_SECRET` 并接入企业登录系统。

浏览器来源扩展位于 `../agent/browser-extension/`，Chrome 和 Edge 共用同一套 MV3 文件，并继续调用 `/api/agent/events`。正式配对流程如下：

1. 在已经注册的 Windows Agent 中点击“生成浏览器配对码”。
2. 打开 Chrome/Edge 扩展设置，填写服务地址和 Agent 显示的 `BP-...` 配对码。
3. 服务端通过 `POST /api/agent/browser-pair` 将 10 分钟内有效、只能使用一次的配对码换成 30 天有效的浏览器凭据。

浏览器凭据只允许上传脱敏的网站来源事件，不能发送心跳、读取采集策略或生成新的配对码；扩展不会保存或要求员工粘贴 Windows Agent Token。

前端默认连接真实服务端。只有在 `app/.env` 明确设置 `VITE_DEMO_MODE=true` 时才启用演示数据；推荐配置 `VITE_AGENT_API_BASE_URL` 和 `VITE_AGENT_ADMIN_TOKEN` 后使用真实数据。

## 生成注册码

```bash
AGENT_ADMIN_TOKEN=dev-admin-token npm start

curl -X POST http://localhost:8787/api/admin/registration-codes \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"employee_id":"employee-wei"}'
```

返回的注册码只能使用一次。设备注册后，Agent 使用设备 Token 上传应用活动、脱敏工作标识、可识别的网站域名和心跳；事件按 `event_id` 幂等写入，适合断网恢复补传。服务端拒绝包含 `/`、查询参数或片段的网页值，避免完整 URL 进入事件表。

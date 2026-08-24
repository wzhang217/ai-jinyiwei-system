# AI锦衣卫 Agent Server

局域网 MVP 服务端，使用 Node.js 内置 `node:sqlite`，负责一次性注册码、设备 Token、事件幂等、心跳、采集策略、Memory Summary 和 History Skill。

## 启动

首次配置先复制环境变量模板，并只在服务端填写管理员初始密码和百炼 API Key：

```bash
cp .env.example .env
# 编辑 .env，至少填写 ADMIN_PASSWORD、AGENT_SESSION_SECRET 和 DASHSCOPE_API_KEY
```

```bash
npm start
```

`npm start` 和 `npm run dev` 会自动读取 `server/.env`。默认监听 `0.0.0.0:8787`。首次启动时，如果 `ADMIN_PASSWORD` 已设置，服务端会创建一个管理员账号；之后管理后台使用用户名和密码登录，服务端签发短期 HS256 JWT。生产环境默认拒绝 `x-admin-token`，不能把管理员 Token 放入 `app/.env` 或前端构建产物；只有设置 `AGENT_ALLOW_BOOTSTRAP_TOKEN=true` 才会临时开放维护入口。正式试点请设置随机的 `AGENT_SESSION_SECRET`、明确的 `AGENT_CORS_ORIGIN`，并在反向代理后使用 HTTPS。

Linux 客户服务器可使用 `server/deploy/install-systemd.sh` 安装服务、备份和健康检查定时器；该脚本不会覆盖已有环境文件。正式部署前先执行 `--init-env` 生成环境模板，填好账号、JWT 密钥、数据库和 AI 配置后再安装。健康检查失败会记录到 systemd journal，并可通过 `HEALTH_ALERT_WEBHOOK_URL` 发出通用 JSON 告警。

### 管理后台登录

在 `server/.env` 设置以下值后重启服务端：

```bash
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请替换为至少12位密码
ADMIN_DISPLAY_NAME=企业管理员
AUTH_JWT_TTL_SECONDS=28800
```

前端只需要设置 `VITE_AGENT_API_BASE_URL=http://localhost:8787`，不再设置 `VITE_AGENT_ADMIN_TOKEN`。登录成功后的 JWT 存放在浏览器会话存储中，每次请求通过 `Authorization: Bearer <jwt>` 发送；退出登录会清除本机 JWT，账号停用或 JWT 过期后服务端拒绝请求。

登录只校验用户名和密码，不启用 MFA、数据库会话或登录失败锁定；登录成功、失败和退出仍写入审计。员工 Agent 注册后必须确认当前隐私策略版本，服务端会记录组织、员工、设备、策略哈希和确认时间；策略版本更新后需要重新确认。相关接口为 `/api/agent/privacy-policy`、`/api/agent/privacy-acknowledgement` 和 `/api/admin/privacy/acknowledgements`。后台的“员工数据权利”支持 `POST /api/admin/privacy/subject-export` 导出员工活动元数据，以及 `POST /api/admin/privacy/subject-delete` 先预览再执行删除；两者均按老板/高管/员工服务端范围过滤并写入审计。导出不会包含密码、Token 或原始正文；删除会清理活动事件、Memory Summary、生成队列和浏览器临时凭据，但保留员工/设备身份、审计日志和隐私确认记录。

### 新客户组织初始化

正式交付每个客户前，使用服务端 CLI 创建独立组织和第一个老板账号。命令会复制当前默认策略、隐私说明、通知、活动分类、集成和三角色权限模板；密码只从环境变量读取，不会写入命令行参数、日志、前端或 MSI：

```bash
export PROVISION_ORGANIZATION_NAME="示例客户"
export PROVISION_ORGANIZATION_SLUG="example-customer"
export PROVISION_ADMIN_USERNAME="owner"
export PROVISION_ADMIN_DISPLAY_NAME="客户老板"
export PROVISION_ADMIN_PASSWORD="请从密码管理器临时注入至少12位密码"
npm run provision:organization -- \
  --organization-id org_example_customer
unset PROVISION_ADMIN_PASSWORD
```

也可以将 `PROVISION_*` 值改为同名命令参数；管理员密码仍必须使用 `PROVISION_ADMIN_PASSWORD`，避免出现在 shell history。命令是幂等保护式的：组织 ID、slug 或用户名已存在时直接失败，不覆盖已有客户数据。初始化后由老板登录后台创建员工、账号和设备注册码，员工账号只使用 `employee` 角色，高管账号只使用 `manager` 角色，不创建审计员角色。

### 数据库迁移、备份与恢复

服务启动会执行版本化迁移，并在 `/health` 返回 `schema_version` 与 `expected_schema_version`。当前数据库版本为 7，包含组织归属字段、按组织隔离的采集策略和企业设置、隐私策略确认记录、兼容旧版本的账号字段、AI 用量统计和审计日志哈希链；旧版 SQLite 会在启动时补列并建立组织配置，不需要删库重建。MVP 使用 SQLite；正式交付前至少要把数据库目录放到持久化磁盘，并设置定时备份。手动备份：

```bash
npm run backup
# 创建已校验备份并删除超过保留天数的旧备份（默认 14 天）
npm run backup:rotate
# 或指定源库和备份文件
AGENT_DB_PATH=./data/agent.sqlite AGENT_BACKUP_PATH=./data/backups/manual.sqlite npm run backup

# 对已有备份执行完整性和外键校验
AGENT_RESTORE_PATH=./data/backups/manual.sqlite npm run restore-check
```

`npm run backup` 会先校验源库，再使用 SQLite `VACUUM INTO` 生成一致性备份，并重新打开备份校验 `integrity_check` 和 `foreign_key_check`；任一步失败都会返回非零退出码。恢复前先停止服务端，用 `npm run restore-check` 校验备份，再用经过校验的备份文件替换 `AGENT_DB_PATH`，然后启动服务并检查 `/health`、设备心跳、历史记录和审计日志。不要在服务运行时直接覆盖 SQLite 文件；备份文件应进入企业自己的加密存储和异地保留策略。

Linux systemd 可用仓库内的 `deploy/ai-jinyiwei-agent-backup.service` 和 `deploy/ai-jinyiwei-agent-backup.timer` 每日生成并轮换备份：

```bash
sudo cp deploy/ai-jinyiwei-agent-backup.service deploy/ai-jinyiwei-agent-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-jinyiwei-agent-backup.timer
sudo systemctl list-timers ai-jinyiwei-agent-backup.timer
```

客户支持排障时可以生成脱敏诊断报告。报告只包含服务版本、数据库完整性/迁移状态、设备和队列计数、最近同步时间及脱敏的摘要任务错误，不包含活动名称、窗口标题、URL、文件内容、Token、密码或 API Key：

```bash
npm run diagnostics -- --output ./data/diagnostics/diagnostic-$(date +%Y%m%d%H%M%S).json
```

systemd 部署还可以启用仓库内的 `deploy/ai-jinyiwei-agent-health.service` 和 `deploy/ai-jinyiwei-agent-health.timer`，每 5 分钟执行 `/health/ready`；失败记录会进入 journald，接入企业监控时应对该 unit 的失败状态告警：

```bash
sudo cp deploy/ai-jinyiwei-agent-health.service deploy/ai-jinyiwei-agent-health.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ai-jinyiwei-agent-health.timer
sudo systemctl list-timers ai-jinyiwei-agent-health.timer
```

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
AI_REQUEST_TIMEOUT_MS=60000
AI_ENABLE_THINKING=false
# Optional provider pricing in USD per 1M tokens; leave 0 when unknown.
AI_INPUT_COST_PER_MILLION_TOKENS=0
AI_OUTPUT_COST_PER_MILLION_TOKENS=0
AI_SUMMARY_WINDOW_SECONDS=600
AI_ACTIVE_GRACE_SECONDS=45
AI_GENERATION_BATCH_SIZE=1
AGENT_ADMIN_TOKEN=dev-admin-token
```

也可以使用 `AI_API_KEY`、`AI_MODEL` 和 `AI_API_URL` 覆盖默认配置。未配置密钥时，服务会使用本地规则兜底并将摘要标记为 `fallback`；采集、历史记录和离线补传不受影响。

启动后可在服务端终端看到 `AI provider: qwen3.7-plus`。如果显示 `rules-v1`，说明没有读取到 API Key；这不影响 Agent 采集，但不会调用 Qwen。

`GET /api/admin/history` 会将 Leaf/Rollup Summary 持久化到 `memory_summaries` 表；`POST /api/admin/history/ask` 默认会在留存窗口内召回已持久化的 Memory Summary，再结合最近活动覆盖更新的记录进行排序和问答，不只搜索最近一页活动。模型输入只包含应用、时长、切换、脱敏标识和网站域名等活动元数据。

## 生产部署

### 生产环境预检

在首次启动或修改生产 `.env` 后，先执行预检；它不会启动服务，也不会打印密钥：

```bash
npm run preflight:production
```

预检会拒绝模板密钥、弱管理员密码、非 HTTPS CORS、bootstrap Token、相对数据库/备份路径、过短备份保留期、过低磁盘阈值和缺失的 AI Key。预检通过后再启动 Docker 或 systemd；`HOST=0.0.0.0` 只会提示警告，仍必须由防火墙和反向代理限制 8787 的访问范围。

### Docker Compose

适合局域网服务器或云主机的第一种部署方式：

```bash
cp .env.example .env
# 编辑 .env：至少设置 ADMIN_PASSWORD、AGENT_SESSION_SECRET、AGENT_CORS_ORIGIN
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 agent-server
```

容器使用 `restart: unless-stopped`，数据库写入挂载到 `server/data`，镜像只读根文件系统。升级时执行 `docker compose up -d --build`，服务启动会自动执行版本化迁移；升级前先执行一次 `npm run backup` 或对应的容器备份任务。

### Linux systemd

将 `deploy/ai-jinyiwei-agent-server.service` 安装到 `/etc/systemd/system/`，创建专用用户 `jinyiwei`，将服务目录放到 `/opt/ai-jinyiwei/server`，并把 `.env.example` 复制为 `/etc/ai-jinyiwei/server.env` 后填写生产密钥：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ai-jinyiwei-agent-server
sudo systemctl status ai-jinyiwei-agent-server
sudo journalctl -u ai-jinyiwei-agent-server -n 100 --no-pager
```

systemd 会在进程异常退出后自动重启，日志进入 journald；服务单元自带日志限流，生产机还应按企业标准配置 journald 保留上限、磁盘告警和备份任务。仓库提供 `deploy/journald-ai-jinyiwei.conf.example` 作为可选模板，安装到 `/etc/systemd/journald.conf.d/` 前应先由客户确认主机级保留策略。`npm run healthcheck` 用于部署探活，要求迁移版本已达到当前版本且数据库所在文件系统剩余空间不低于 `DISK_MIN_FREE_BYTES`。

### HTTPS 与防火墙

`deploy/Caddyfile.example` 是反向代理模板，实际部署时替换域名，令 `AGENT_CORS_ORIGIN` 与前端 HTTPS 来源完全一致；多个前端来源用英文逗号分隔，不能使用 `*`。只开放 443；8787 仅允许本机或内网反向代理访问。服务端会拒绝未列入白名单的浏览器 `Origin`，并返回安全响应头。证书、DNS、防火墙和企业网络代理由部署环境负责，不能把示例域名直接用于生产。

健康检查分为三类：`GET /health/live` 只判断进程是否能响应；`GET /health` 和 `GET /health/ready` 会检查 SQLite `quick_check` 以及迁移版本，数据库未就绪时返回 HTTP 503。`npm run healthcheck` 额外检查数据库文件系统的剩余空间；`npm run diagnostics` 会输出空间总量、剩余量和阈值。容器探活和 systemd 部署应使用 `/health/ready`，负载均衡器的存活探针可使用 `/health/live`。

当前 MVP 使用简单 JWT 账号验证：用户名和密码正确后签发 HS256 JWT，默认有效期由 `AUTH_JWT_TTL_SECONDS` 控制，最长 24 小时。JWT 不包含密码或采集数据；服务端每次请求仍查询账号是否存在、是否停用，并按老板/高管/员工角色执行数据范围过滤。数据库中保留旧版 MFA 字段仅用于兼容已有 SQLite，不再作为登录流程或后台设置项。

History Skill 的召回使用 `semantic-metadata-v1`：先按时间和权限过滤，再用工作语义分组（开发、浏览器、沟通、文档、项目管理、AI 工作台等）结合应用、域名、来源类型、工作标识和活动顺序进行排序，最后把排序后的脱敏证据交给 Qwen 生成回答。这个检索层不读取原始窗口标题、完整 URL、文件正文或聊天正文，也不会为每条活动额外调用模型。

服务端和数据库以带 `Z` 的 UTC ISO 时间保存和传输事件，前端、Agent 界面、浏览器配对提示和日期边界统一按 `Asia/Shanghai`（UTC+8）展示和计算，避免跨设备时区不同造成日期错位。

采集策略中的 `activity_checkpoint_seconds` 控制同一活动区间的实时更新间隔，默认 15 秒，可在管理后台设置为 15、30 或 60 秒；`heartbeat_interval_seconds` 仍独立控制设备心跳，默认 60 秒。修改策略后，已注册 Agent 会在下一次心跳拉取新策略。

管理后台的团队和员工目录通过 `GET /api/admin/teams`、`GET /api/admin/employees` 读取服务端组织数据，并沿用管理员、管理者和员工的服务端权限范围；前端不再把演示目录作为真实数据源。

### 批量导入客户员工目录

正式交付前可以使用 CSV 或 JSON 将客户员工目录导入指定组织。脚本只创建或更新员工目录，不删除缺失员工，也不接受密码字段；账号密码仍通过管理后台、SSO 或客户自己的账号目录交接，避免把密码写入导入文件。

CSV 最小格式：

```csv
employee_id,name,team
employee-001,张三,研发中心
employee-002,李四,客户成功
```

先预览，再执行：

```bash
AGENT_DB_PATH=./data/agent.sqlite \
npm run directory:import -- \
  --organization-id customer_acme \
  --file ./customer-directory.csv \
  --dry-run

AGENT_DB_PATH=./data/agent.sqlite \
npm run directory:import -- \
  --organization-id customer_acme \
  --file ./customer-directory.csv
```

JSON 可以是员工数组，也可以是 `{ "employees": [...] }`。脚本具备组织隔离、重复员工 ID 拒绝、事务回滚和审计记录；重复执行同一文件是幂等的。它不会自动停用缺失员工，停用应由管理员确认后在后台完成。

管理后台的“立即刷新”会重新读取 `GET /api/admin/history`，历史记录页的导出会调用 `POST /api/admin/history/export`，服务端返回当前权限范围内的记录并写入 `history_exported` 审计日志。设备列表读取真实心跳；超过策略心跳间隔的设备会被标记为离线，并写入 `agent_offline`，恢复心跳后写入 `agent_online`。

历史记录同时提供 Leaf、连续窗口、小时、每日、个人每周和团队周 Rollup Summary。模型暂时不可用时会先返回规则兜底摘要，并写入 `memory_generation_jobs`，后台会按退避策略重试，最多 5 次。`AI_MAX_REQUESTS_PER_MINUTE` 控制单个服务进程的模型调用预算，超过后暂时使用规则摘要并进入重试队列。模型请求默认 60 秒超时，并默认关闭 qwen3.7-plus 的思考模式以适配短摘要和实时问答；超时同样会进入规则兜底和重试流程。需要保留思考过程时可设置 `AI_ENABLE_THINKING=true`，但应同步提高 `AI_REQUEST_TIMEOUT_MS`。

AI 摘要和活动采集采用不同频率：Agent 仍按采集策略实时上报活动区间，但服务端只对已经闭合且达到 `AI_SUMMARY_WINDOW_SECONDS`（默认 10 分钟）的 Leaf 窗口生成一次 AI 摘要；当前仍在增长的窗口显示规则摘要并标记为 `window_pending`，不会因为每次 15 秒活动更新、心跳或前端刷新而重新调用模型。小时、每日、每周等 Rollup 由已生成的 Leaf 和规则聚合得到，不额外触发模型调用，避免一次活动同时派生多次 AI 请求；失败的 Leaf 任务仍按原有退避策略重试。`AI_ACTIVE_GRACE_SECONDS`（默认 45 秒）用于判断最近活动是否仍在增长。后台默认每 15 秒最多处理 1 个生成任务，`AI_GENERATION_BATCH_SIZE` 可按服务端额度调整，避免历史补偿队列瞬间打满模型请求。

服务端会把每次实际模型调用的操作类型、状态、HTTP 状态、耗时、供应商返回的 Token（若有）、提示词版本和费用估算写入 `ai_usage`，不保存 Prompt、API Key 或活动正文。后台“设置 → AI 设置”可配置每日请求上限和每日费用上限（填 `0` 表示不限），并查看最近 7 天的调用、Token、延迟和失败情况；也可通过 `GET /api/admin/ai/usage?days=7` 读取同一统计。费用估算依赖 `AI_INPUT_COST_PER_MILLION_TOKENS` 和 `AI_OUTPUT_COST_PER_MILLION_TOKENS`，价格未知时保持 `0`。达到额度后，新的模型请求会被拦截并保留规则摘要，避免继续产生供应商费用。

审计日志除 SQLite 的追加写入保护外，新写入记录还带有按企业隔离的 `previous_hash` / `entry_hash` 哈希链。老板可调用 `GET /api/admin/audit/verify` 或在后台“审计”页查看校验结果；从旧版本升级的历史记录会显示为“历史旧记录”，不会被伪装成已完成哈希校验。

管理员可以先预览再执行数据留存删除，删除活动事件、Leaf/Rollup Summary，并写入审计日志。下面的 `x-admin-token` 示例仅用于开发环境或已明确开启 bootstrap 维护窗口的临时操作，生产管理后台应使用账号会话：

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

开发或迁移期间仍可以用启动 Token 换取有范围的临时 JWT；生产默认关闭此入口，临时开启后应在维护完成立即恢复 `AGENT_ALLOW_BOOTSTRAP_TOKEN=false` 并重启服务：

```bash
curl -X POST http://localhost:8787/api/admin/sessions \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"role":"employee","employee_id":"employee-wei"}'
```

之后用返回的 Token 放在 `Authorization: Bearer <token>` 中访问历史、设备、事件和问答接口；`x-admin-session` 仅作为旧版客户端的过渡别名。正式管理后台通过 `POST /api/auth/login` 获取 JWT，`POST /api/auth/logout` 记录退出并由前端清除 Token；旧版启动 Token 不进入前端构建产物。

浏览器来源扩展位于 `../agent/browser-extension/`，Chrome 和 Edge 共用同一套 MV3 文件，并继续调用 `/api/agent/events`。正式配对流程如下：

1. 在已经注册的 Windows Agent 中点击“生成浏览器配对码”。
2. 打开 Chrome/Edge 扩展设置，填写服务地址和 Agent 显示的 `BP-...` 配对码。
3. 服务端通过 `POST /api/agent/browser-pair` 将 10 分钟内有效、只能使用一次的配对码换成 30 天有效的浏览器凭据。

浏览器凭据只允许上传脱敏的网站来源事件，不能发送心跳、读取采集策略或生成新的配对码；扩展不会保存或要求员工粘贴 Windows Agent Token。

前端默认连接真实服务端。只有在 `app/.env` 明确设置 `VITE_DEMO_MODE=true` 时才启用演示数据；真实环境只配置 `VITE_AGENT_API_BASE_URL`，用户在登录页输入企业账号密码。

## 生成注册码

```bash
AGENT_ADMIN_TOKEN=dev-admin-token npm start

curl -X POST http://localhost:8787/api/admin/registration-codes \
  -H 'content-type: application/json' \
  -H 'x-admin-token: dev-admin-token' \
  -d '{"employee_id":"employee-wei"}'
```

返回的注册码只能使用一次。设备注册后，Agent 使用设备 Token 上传应用活动、脱敏工作标识、可识别的网站域名和心跳；事件按 `event_id` 幂等写入，适合断网恢复补传。服务端拒绝包含 `/`、查询参数或片段的网页值，避免完整 URL 进入事件表。

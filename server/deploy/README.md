# AI锦衣卫服务端生产部署

生产环境不要依赖开发者终端中的 `npm start`。服务端应运行在一台固定的 Linux 局域网服务器或云主机上，Agent 通过 HTTPS 域名访问；管理后台的 `VITE_AGENT_API_BASE_URL` 也应指向同一个 HTTPS 地址。

## 方案 A：systemd（推荐试点服务器）

在仓库的 `server/` 目录执行：

```bash
sudo bash deploy/install-systemd.sh --init-env
sudoedit /etc/ai-jinyiwei/server.env
sudo bash deploy/install-systemd.sh
```

第一次执行只创建环境模板，不会启动服务。至少要替换：

- `AGENT_SESSION_SECRET`：随机生成的长密钥；
- `ADMIN_PASSWORD`：客户管理员密码；
- `DASHSCOPE_API_KEY`：如启用 AI 摘要；
- `AGENT_CORS_ORIGIN`：管理后台的 HTTPS 来源；
- `AGENT_DB_PATH`、`AGENT_BACKUP_DIR`：绝对路径；
- `HEALTH_ALERT_WEBHOOK_URL`：可选，健康检查失败通知地址。
- `AI_ALERT_WEBHOOK_URL`：可选，AI 模型失败、额度阻断和额度预警通知地址；请求体只含状态、模型、操作、费用和额度统计，不含 Prompt 或活动内容。

安装器会创建受限的 `jinyiwei` 系统用户，复制 `src/`、`scripts/` 和 Node 依赖，安装服务与定时器，并启用开机自启动。它不会覆盖已经存在的环境文件和数据库。

常用运维命令：

```bash
sudo systemctl restart ai-jinyiwei-agent-server
sudo systemctl status ai-jinyiwei-agent-server
journalctl -u ai-jinyiwei-agent-server -f
sudo systemctl list-timers ai-jinyiwei-agent-backup.timer ai-jinyiwei-agent-health.timer
sudo -u jinyiwei bash -lc 'cd /opt/ai-jinyiwei/server && npm run diagnostics'
sudo -u jinyiwei bash -lc 'cd /opt/ai-jinyiwei/server && npm run ops:check'
```

健康检查失败会触发 `ai-jinyiwei-agent-health-alert.service`。没有配置 webhook 时，故障仍会写入 journald；配置 webhook 后会按 `HEALTH_ALERT_COOLDOWN_SECONDS` 抑制重复通知。

systemd 服务在每次启动前自动执行 `preflight-production`；密钥、HTTPS 来源、持久化路径、备份保留期或磁盘阈值不符合要求时，服务不会监听端口。修改 `/etc/ai-jinyiwei/server.env` 后直接重启即可重新检查。

AI 用量告警由服务进程按组织和告警类型抑制重复通知，额度比例由 `AI_BUDGET_ALERT_RATIO` 和 `AI_REQUEST_ALERT_RATIO` 控制。正式交付前应使用企业告警系统的 HTTPS 地址，并在测试环境验证失败、阻断和恢复三种状态。

## HTTPS 反向代理

复制 `Caddyfile.example`，把域名改成客户域名，并让 DNS 指向服务器。Caddy 自动申请和续期证书：

```bash
sudo cp deploy/Caddyfile.example /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Caddy 同机反代到 `127.0.0.1:8787`。防火墙只开放 `80/443`；不要把 8787 直接暴露到公网。若 Agent 在客户内网，确保 Windows 电脑能解析并访问 HTTPS 域名。

## 方案 B：Docker Compose

Docker 方案适合已经有容器运维的平台：

```bash
cd server
cp .env.example .env
$EDITOR .env
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8787/health/ready
```

Compose 只把 8787 绑定到本机，仍建议由 Caddy/Nginx 负责 HTTPS。`./data` 是持久化目录，备份应覆盖其中的 `agent.sqlite` 和 `backups/`。

## 备份、恢复与回滚

每日定时器会先执行 SQLite 完整性检查、外键检查和 `VACUUM INTO`，再按保留天数清理旧备份。上线前和每季度至少做一次恢复演练：

```bash
cd /opt/ai-jinyiwei/server
sudo -u jinyiwei npm run backup:rotate
sudo -u jinyiwei AGENT_RESTORE_PATH=/tmp/agent-restore-check.sqlite npm run restore-check
npm run ops:check
```

升级时保留旧目录和数据库，先停止服务、备份、替换应用文件，再启动并检查 `/health/ready`。新版本异常时恢复旧应用目录并保留新产生的日志，禁止直接删除数据库。正式客户交付前应把这套流程写入变更单和回滚记录。

## 日志与客户交接

可选安装 `journald-ai-jinyiwei.conf.example` 控制日志保留量：

```bash
sudo bash deploy/install-systemd.sh --install-journald
```

交付客户时应一并提供：HTTPS 地址、管理后台地址、管理员账号首次登录方式、Agent 注册码生成流程、升级/回滚窗口、隐私政策确认方式、备份责任人、故障联系人和数据留存期限。不要把 `.env`、API Key、JWT 或一次性注册码提交到 Git 仓库。

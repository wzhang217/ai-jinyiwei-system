const env = process.env;
const errors = [];
const warnings = [];

const value = (name) => String(env[name] || "").trim();
const isPlaceholder = (input) => /^(change-me|replace-with|dev-|admin_|test_|example)/i.test(input);
const isAbsolutePath = (input) => input.startsWith("/") || /^[A-Za-z]:[\\/]/.test(input);

if (value("NODE_ENV") !== "production") errors.push("NODE_ENV 必须设置为 production");
if (value("AGENT_ALLOW_BOOTSTRAP_TOKEN").toLowerCase() !== "false") errors.push("AGENT_ALLOW_BOOTSTRAP_TOKEN 必须显式设置为 false");

const sessionSecret = value("AGENT_SESSION_SECRET");
if (sessionSecret.length < 32 || isPlaceholder(sessionSecret)) {
  errors.push("AGENT_SESSION_SECRET 必须是至少 32 个字符的随机值，不能使用模板值");
}

const adminPassword = value("ADMIN_PASSWORD");
if (adminPassword.length < 12 || isPlaceholder(adminPassword)) {
  errors.push("ADMIN_PASSWORD 必须是至少 12 个字符的真实管理员密码，不能使用模板值");
}

const corsOrigins = value("AGENT_CORS_ORIGIN").split(",").map((origin) => origin.trim()).filter(Boolean);
if (!corsOrigins.length || corsOrigins.includes("*")) {
  errors.push("AGENT_CORS_ORIGIN 必须配置明确的来源，不能使用 *");
} else {
  for (const origin of corsOrigins) {
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== "https:") errors.push(`AGENT_CORS_ORIGIN 必须使用 HTTPS：${origin}`);
      if (parsed.pathname !== "/" || parsed.search || parsed.hash) errors.push(`AGENT_CORS_ORIGIN 只能包含协议、域名和可选端口：${origin}`);
    } catch {
      errors.push(`AGENT_CORS_ORIGIN 不是有效 URL：${origin}`);
    }
  }
}

const dbPath = value("AGENT_DB_PATH");
if (!dbPath || !isAbsolutePath(dbPath)) errors.push("AGENT_DB_PATH 必须设置为持久化磁盘上的绝对路径");
const backupDir = value("AGENT_BACKUP_DIR");
if (!backupDir || !isAbsolutePath(backupDir)) errors.push("AGENT_BACKUP_DIR 必须设置为持久化磁盘上的绝对路径");

const retentionDays = Number(value("AGENT_BACKUP_RETENTION_DAYS"));
if (!Number.isFinite(retentionDays) || retentionDays < 7) errors.push("AGENT_BACKUP_RETENTION_DAYS 至少为 7 天");
const minimumFreeBytes = Number(value("DISK_MIN_FREE_BYTES"));
if (!Number.isFinite(minimumFreeBytes) || minimumFreeBytes < 1_073_741_824) errors.push("DISK_MIN_FREE_BYTES 至少为 1073741824（1 GiB）");

const aiEnabled = value("AI_ENABLED").toLowerCase() === "true" || Boolean(value("AI_API_KEY") || value("DASHSCOPE_API_KEY"));
const aiKey = value("AI_API_KEY") || value("DASHSCOPE_API_KEY");
if (aiEnabled && !aiKey) errors.push("AI_ENABLED=true 时必须配置 AI_API_KEY 或 DASHSCOPE_API_KEY");
if (aiEnabled && isPlaceholder(aiKey)) errors.push("AI API Key 仍是模板值，请替换后再部署");

if (value("HOST") === "0.0.0.0") warnings.push("HOST=0.0.0.0：必须确认防火墙只允许反向代理/局域网访问，8787 不得直接暴露公网");

if (errors.length) {
  console.error("生产环境预检失败：");
  for (const error of errors) console.error(`- ${error}`);
  for (const warning of warnings) console.error(`警告：${warning}`);
  process.exitCode = 1;
} else {
  console.log("生产环境预检通过：身份、Session、CORS、持久化路径、备份、磁盘阈值和 AI 配置已满足最低要求。");
  for (const warning of warnings) console.warn(`警告：${warning}`);
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createAiService } from "./ai.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultDbPath = resolve(moduleDir, "../data/agent.sqlite");
const allowedEventTypes = new Set(["app_session", "idle"]);
const allowedSourceKinds = new Set([
  "desktop_app",
  "browser_native",
  "browser_extension",
  "system_idle",
  "system_app",
]);

const defaultEmployees = [
  ["employee-wei", "Wei", "研发与产品中心"],
  ["employee-lin", "Lin", "客户与销售团队"],
  ["employee-ming", "Ming", "运营与支持团队"],
  ["employee-chen", "Chen", "研发与产品中心"],
  ["employee-jia", "Jia", "客户与销售团队"],
];

const defaultPolicy = {
  idle_threshold_seconds: 300,
  activity_checkpoint_seconds: 15,
  heartbeat_interval_seconds: 60,
  collect_app_activity: true,
  collect_idle_status: true,
  collect_web_domains: true,
  collect_file_metadata: true,
  work_hours_start: "09:00",
  work_hours_end: "18:00",
  excluded_processes: [],
  excluded_domains: [],
  version: 1,
};

const defaultOrganizationSettings = {
  company_name: "锦衣卫科技",
  default_language: "简体中文",
  timezone: "Asia/Shanghai（UTC+8）",
  retention: "原始 90 天 · 汇总 1 年",
  ai_model: "qwen3.7-plus",
  ai_summary_interval_seconds: "600",
  ai_budget_per_minute: "30",
};

const defaultNotificationSettings = [
  ["agent_offline", "Agent 离线超过 30 分钟", 1],
  ["memory_summary_failed", "Memory Summary 生成失败", 1],
  ["coverage_low", "团队数据覆盖率低于 90%", 1],
  ["suspected_non_work", "疑似非工作活动", 0],
];

const defaultActivityCategories = [
  ["work_project", "purple", "工作与项目", "开发、文档、项目管理"],
  ["communication", "blue", "沟通与会议", "企业微信、会议和邮件"],
  ["system_tools", "green", "系统与工具", "登录、设置、故障和同步"],
  ["suspected_non_work", "amber", "疑似非工作", "购物、娱乐、求职和游戏，需人工确认"],
  ["unknown", "gray", "未知", "无法可靠分类的活动"],
];

const defaultIntegrationSettings = [
  ["browser_extension", "浏览器扩展", "Chrome / Edge 页面域名和标题", "connected", 1],
  ["project_tools", "项目管理工具", "Jira、Linear、Trello", "disconnected", 0],
  ["collaboration", "协作工具", "企业微信、飞书、Slack", "partial", 1],
  ["history_api", "History API", "供企业内部系统查询记录", "preparing", 0],
];

const defaultRolePolicies = [
  ["admin", "老板", "整个企业", "管理组织、设备、策略、审计和全企业历史记录。"],
  ["manager", "高管", "直属团队", "查看直属团队的趋势、历史记录和 Memory Summary。"],
  ["employee", "员工", "本人", "查看自己的活动历史、Memory Summary 和隐私说明。"],
];

const HISTORY_WINDOW_SECONDS = 10 * 60;
const AI_SUMMARY_WINDOW_SECONDS = Math.max(
  60,
  Number(process.env.AI_SUMMARY_WINDOW_SECONDS) || HISTORY_WINDOW_SECONDS,
);
const AI_ACTIVE_GRACE_SECONDS = Math.max(
  15,
  Number(process.env.AI_ACTIVE_GRACE_SECONDS) || 45,
);
const AI_GENERATION_INTERVAL_SECONDS = 15;
const MAX_EVENT_DURATION_SECONDS = 12 * 3600;
const HIDDEN_AGENT_PROCESSES = new Set([
  "ai-jinyiwei-agent.exe",
  "dwm.exe",
  "sihost.exe",
  "searchhost.exe",
  "startmenuexperiencehost.exe",
  "runtimebroker.exe",
  "textinputhost.exe",
  "shellexperiencehost.exe",
  "mphelper.exe",
  "newidview.exe",
  "360albumviewer64.exe",
  "360huabao.exe",
  "sesvcr.exe",
  "softmgrlite.exe",
]);

const isoNow = () => new Date().toISOString();
const SHANGHAI_OFFSET_MS = 8 * 3600_000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const newId = (prefix) => `${prefix}_${randomBytes(12).toString("hex")}`;
const newToken = () => randomBytes(32).toString("base64url");
const newRegistrationCode = () => `JY-${randomBytes(5).toString("hex").toUpperCase()}`;
const newBrowserPairingCode = () => `BP-${randomBytes(5).toString("hex").toUpperCase()}`;

function configuredAiGenerationBatchSize() {
  return Math.min(Math.max(Number(process.env.AI_GENERATION_BATCH_SIZE) || 1, 1), 20);
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      team TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS registration_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS browser_pairing_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS browser_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      browser_name TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      employee_id TEXT NOT NULL REFERENCES employees(id),
      hostname TEXT NOT NULL,
      os_version TEXT NOT NULL,
      agent_version TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'offline',
      last_heartbeat_at TEXT,
      queued_events INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      disabled_at TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(id),
      occurred_at TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('app_session', 'idle')),
      app_name TEXT NOT NULL,
      process_name TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'desktop_app',
      context_label TEXT,
      web_domain TEXT,
      duration_seconds INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      target TEXT NOT NULL,
      detail TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS policies (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_summaries (
      id TEXT PRIMARY KEY,
      record_type TEXT NOT NULL CHECK (record_type IN ('leaf', 'rollup')),
      employee_id TEXT NOT NULL REFERENCES employees(id),
      device_id TEXT NOT NULL REFERENCES devices(id),
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_seconds INTEGER NOT NULL,
      source_hash TEXT NOT NULL,
      period_start TEXT NOT NULL DEFAULT '',
      period_end TEXT NOT NULL DEFAULT '',
      source_event_ids TEXT NOT NULL DEFAULT '[]',
      source_event_ids_json TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      prior_context TEXT NOT NULL DEFAULT '',
      important_context TEXT NOT NULL DEFAULT '',
      citations TEXT NOT NULL DEFAULT '[]',
      citations_json TEXT NOT NULL DEFAULT '[]',
      payload_json TEXT NOT NULL,
      model_name TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      status TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_generation_jobs (
      id TEXT PRIMARY KEY,
      summary_id TEXT NOT NULL UNIQUE REFERENCES memory_summaries(id) ON DELETE CASCADE,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'retrying', 'succeeded', 'failed')),
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS organization_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_settings (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity_categories (
      id TEXT PRIMARY KEY,
      color TEXT NOT NULL,
      label TEXT NOT NULL,
      detail TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS integration_settings (
      key TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      status TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS role_policies (
      role TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      scope TEXT NOT NULL,
      detail TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

  `);

  ensureColumn(db, "events", "context_label", "TEXT");
  ensureColumn(db, "events", "web_domain", "TEXT");
  ensureColumn(db, "events", "source_kind", "TEXT NOT NULL DEFAULT 'desktop_app'");
  ensureColumn(db, "memory_summaries", "rollup_scope", "TEXT NOT NULL DEFAULT 'window'");
  ensureColumn(db, "memory_summaries", "source_record_ids_json", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "memory_summaries", "title", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "memory_summaries", "summary", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "memory_summaries", "prior_context", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "memory_summaries", "important_context", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "memory_summaries", "period_start", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "memory_summaries", "period_end", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "memory_summaries", "source_event_ids", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "memory_summaries", "citations", "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "memory_summaries", "citations_json", "TEXT NOT NULL DEFAULT '[]'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_started_at
      ON memory_summaries (started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_employee_started_at
      ON memory_summaries (employee_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_device_started_at
      ON memory_summaries (device_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_rollup_scope
      ON memory_summaries (rollup_scope, started_at DESC);
  `);
  db.exec(`
    UPDATE memory_summaries
    SET period_start = COALESCE(NULLIF(period_start, ''), started_at, ''),
        period_end = COALESCE(NULLIF(period_end, ''), ended_at, ''),
        source_event_ids = CASE WHEN source_event_ids = '[]' THEN COALESCE(json_extract(payload_json, '$.source_event_ids'), source_event_ids_json, '[]') ELSE source_event_ids END,
        citations = CASE WHEN citations = '[]' THEN COALESCE(json_extract(payload_json, '$.citations'), citations_json, '[]') ELSE citations END,
        title = COALESCE(NULLIF(title, ''), json_extract(payload_json, '$.title'), ''),
        summary = COALESCE(NULLIF(summary, ''), json_extract(payload_json, '$.summary'), ''),
        prior_context = COALESCE(NULLIF(prior_context, ''), json_extract(payload_json, '$.prior_context'), ''),
        important_context = COALESCE(NULLIF(important_context, ''), json_extract(payload_json, '$.non_obvious'), ''),
        citations_json = CASE WHEN citations_json = '[]' THEN COALESCE(json_extract(payload_json, '$.citations'), '[]') ELSE citations_json END
    WHERE payload_json IS NOT NULL AND json_valid(payload_json)
  `);
  purgeInvalidIdleSummaries(db);

  const employeeInsert = db.prepare(
    "INSERT OR IGNORE INTO employees (id, name, team, created_at) VALUES (?, ?, ?, ?)",
  );
  const createdAt = isoNow();
  for (const employee of defaultEmployees) employeeInsert.run(...employee, createdAt);

  const policyInsert = db.prepare("INSERT OR IGNORE INTO policies (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(defaultPolicy)) {
    policyInsert.run(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }

  const organizationInsert = db.prepare("INSERT OR IGNORE INTO organization_settings (key, value, updated_at) VALUES (?, ?, ?)");
  for (const [key, value] of Object.entries(defaultOrganizationSettings)) organizationInsert.run(key, value, createdAt);

  const notificationInsert = db.prepare("INSERT OR IGNORE INTO notification_settings (key, label, enabled, updated_at) VALUES (?, ?, ?, ?)");
  for (const [key, label, enabled] of defaultNotificationSettings) notificationInsert.run(key, label, enabled, createdAt);

  const categoryInsert = db.prepare("INSERT OR IGNORE INTO activity_categories (id, color, label, detail, enabled, updated_at) VALUES (?, ?, ?, ?, 1, ?)");
  for (const [id, color, label, detail] of defaultActivityCategories) categoryInsert.run(id, color, label, detail, createdAt);

  const integrationInsert = db.prepare("INSERT OR IGNORE INTO integration_settings (key, title, detail, status, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [key, title, detail, status, enabled] of defaultIntegrationSettings) integrationInsert.run(key, title, detail, status, enabled, createdAt);

  const roleInsert = db.prepare("INSERT OR IGNORE INTO role_policies (role, label, scope, detail, updated_at) VALUES (?, ?, ?, ?, ?)");
  for (const [role, label, scope, detail] of defaultRolePolicies) roleInsert.run(role, label, scope, detail, createdAt);
}

function purgeInvalidIdleSummaries(db) {
  // Older Agent builds could upload a 24-hour idle event. It is retained in
  // events for diagnostics, but must never remain as a future-looking History
  // Summary after the duration guard was fixed.
  const invalid = db.prepare(`
    SELECT ms.id
    FROM memory_summaries ms
    WHERE EXISTS (
      SELECT 1
      FROM events ev
      WHERE ev.type = 'idle'
        AND ev.duration_seconds >= 86400
        AND ms.source_event_ids_json LIKE '%' || ev.event_id || '%'
    )
  `).all();
  if (!invalid.length) return;
  const deleteJobs = db.prepare("DELETE FROM memory_generation_jobs WHERE summary_id = ?");
  const deleteSummaries = db.prepare("DELETE FROM memory_summaries WHERE id = ?");
  for (const row of invalid) {
    deleteJobs.run(row.id);
    deleteSummaries.run(row.id);
  }
}

function recoverRunningMemoryJobs(db) {
  const now = isoNow();
  db.prepare(`
    UPDATE memory_generation_jobs
    SET status = 'queued', next_attempt_at = ?, last_error = COALESCE(last_error, 'recovered after server restart'), updated_at = ?
    WHERE status = 'running'
  `).run(now, now);
}

function ensureColumn(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((item) => item.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function getPolicy(db) {
  const rows = db.prepare("SELECT key, value FROM policies").all();
  return rows.reduce((policy, row) => {
    if (["excluded_processes", "excluded_domains"].includes(row.key)) {
      try {
        const parsed = JSON.parse(row.value);
        policy[row.key] = Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
      } catch {
        policy[row.key] = [];
      }
      return policy;
    }
    policy[row.key] = ["idle_threshold_seconds", "activity_checkpoint_seconds", "heartbeat_interval_seconds", "version"].includes(row.key)
      ? Number(row.value)
      : ["collect_app_activity", "collect_idle_status", "collect_web_domains", "collect_file_metadata"].includes(row.key)
        ? row.value === "true"
        : row.value;
    return policy;
  }, {});
}

function getOrganizationSettings(db) {
  return db.prepare("SELECT key, value FROM organization_settings ORDER BY key").all()
    .reduce((settings, row) => ({ ...settings, [row.key]: row.value }), {});
}

function getNotificationSettings(db) {
  return db.prepare("SELECT key, label, enabled, updated_at FROM notification_settings ORDER BY rowid").all()
    .map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

function getActivityCategories(db) {
  return db.prepare("SELECT id, color, label, detail, enabled, updated_at FROM activity_categories ORDER BY rowid").all()
    .map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

function getIntegrationSettings(db) {
  return db.prepare("SELECT key, title, detail, status, enabled, updated_at FROM integration_settings ORDER BY rowid").all()
    .map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

function getRolePolicies(db) {
  return db.prepare("SELECT role, label, scope, detail, updated_at FROM role_policies ORDER BY CASE role WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 WHEN 'employee' THEN 3 ELSE 4 END").all();
}

function getAdminSettings(db) {
  const timestamps = [
    ...db.prepare("SELECT updated_at FROM organization_settings").all(),
    ...db.prepare("SELECT updated_at FROM notification_settings").all(),
    ...db.prepare("SELECT updated_at FROM activity_categories").all(),
    ...db.prepare("SELECT updated_at FROM integration_settings").all(),
    ...db.prepare("SELECT updated_at FROM role_policies").all(),
  ].map((row) => Date.parse(row.updated_at)).filter((value) => !Number.isNaN(value));
  return {
    organization: getOrganizationSettings(db),
    notifications: getNotificationSettings(db),
    categories: getActivityCategories(db),
    integrations: getIntegrationSettings(db),
    roles: getRolePolicies(db),
    updated_at: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : isoNow(),
  };
}

function validSettingString(value, max = 200) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\r\n]/.test(value);
}

function validateOrganizationSettings(body) {
  if (!body || typeof body !== "object") return "organization settings must be an object";
  for (const key of Object.keys(defaultOrganizationSettings)) {
    if (body[key] !== undefined && !validSettingString(body[key])) return `${key} is invalid`;
  }
  if (body.timezone && !/^Asia\/Shanghai（UTC\+8）$/.test(body.timezone) && body.timezone !== "Asia/Shanghai") return "timezone must use Asia/Shanghai";
  return null;
}

function updateOrganizationSettings(db, body) {
  const validationError = validateOrganizationSettings(body);
  if (validationError) return { error: validationError };
  const current = getOrganizationSettings(db);
  const now = isoNow();
  for (const key of Object.keys(defaultOrganizationSettings)) {
    if (body[key] === undefined || String(body[key]) === String(current[key] ?? "")) continue;
    db.prepare("INSERT INTO organization_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, String(body[key]).trim(), now);
  }
  return { settings: getOrganizationSettings(db), changed: Object.keys(defaultOrganizationSettings).some((key) => body[key] !== undefined && String(body[key]) !== String(current[key] ?? "")) };
}

function updateNotificationSettings(db, body) {
  const entries = Array.isArray(body?.settings)
    ? body.settings
    : body?.settings && typeof body.settings === "object"
      ? Object.entries(body.settings).map(([key, enabled]) => ({ key, enabled }))
      : [];
  if (!entries.length || entries.length > 20) return { error: "settings must contain notification entries" };
  const known = new Map(getNotificationSettings(db).map((row) => [row.key, row]));
  const now = isoNow();
  for (const entry of entries) {
    if (!known.has(entry?.key) || typeof entry.enabled !== "boolean") return { error: "notification setting is invalid" };
    db.prepare("UPDATE notification_settings SET enabled = ?, updated_at = ? WHERE key = ?").run(entry.enabled ? 1 : 0, now, entry.key);
  }
  return { settings: getNotificationSettings(db) };
}

function validateCategories(categories) {
  if (!Array.isArray(categories) || categories.length !== defaultActivityCategories.length) return "categories must contain all activity categories";
  const known = new Set(defaultActivityCategories.map(([id]) => id));
  return categories.every((item) => known.has(item?.id) && validSettingString(item.label, 80) && validSettingString(item.detail, 200) && typeof item.enabled === "boolean")
    ? null
    : "activity category is invalid";
}

function updateActivityCategories(db, categories) {
  const validationError = validateCategories(categories);
  if (validationError) return { error: validationError };
  const now = isoNow();
  const update = db.prepare("UPDATE activity_categories SET label = ?, detail = ?, enabled = ?, updated_at = ? WHERE id = ?");
  for (const item of categories) update.run(item.label.trim(), item.detail.trim(), item.enabled ? 1 : 0, now, item.id);
  return { categories: getActivityCategories(db) };
}

function updateIntegrationSettings(db, integrations) {
  if (!Array.isArray(integrations) || integrations.length > 20) return { error: "integrations must be an array" };
  const known = new Map(getIntegrationSettings(db).map((row) => [row.key, row]));
  const now = isoNow();
  for (const item of integrations) {
    if (!known.has(item?.key) || typeof item.enabled !== "boolean") return { error: "integration setting is invalid" };
    db.prepare("UPDATE integration_settings SET enabled = ?, updated_at = ? WHERE key = ?").run(item.enabled ? 1 : 0, now, item.key);
  }
  return { integrations: getIntegrationSettings(db) };
}

function updateRolePolicies(db, roles) {
  if (!Array.isArray(roles) || roles.length !== defaultRolePolicies.length) return { error: "roles must contain老板、高管和员工" };
  const known = new Set(defaultRolePolicies.map(([role]) => role));
  if (!roles.every((item) => known.has(item?.role) && validSettingString(item.scope, 80) && validSettingString(item.detail, 240))) return { error: "role policy is invalid" };
  const now = isoNow();
  const update = db.prepare("UPDATE role_policies SET scope = ?, detail = ?, updated_at = ? WHERE role = ?");
  for (const item of roles) update.run(item.scope.trim(), item.detail.trim(), now, item.role);
  return { roles: getRolePolicies(db) };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    ...corsHeaders(),
  });
  response.end(body);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": process.env.AGENT_CORS_ORIGIN || "*",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-admin-token, x-admin-session",
    "access-control-max-age": "600",
  };
}

function sendError(response, status, message, code = "bad_request") {
  sendJson(response, status, { error: { code, message } });
}

async function readJson(request, maxBytes = 512 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signAdminSession(payload, secret) {
  const encoded = encodeBase64Url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyAdminSession(token, secret) {
  const [encoded, signature] = String(token || "").split(".");
  if (!encoded || !signature) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest();
  const received = Buffer.from(signature, "base64url");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(decodeBase64Url(encoded));
    if (!payload || typeof payload !== "object" || Number(payload.exp) <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(request, adminToken, sessionSecret = adminToken) {
  if (request.headers["x-admin-token"] === adminToken) {
    return { role: "admin", actor: "admin", employee_id: null, team: null, source: "bootstrap" };
  }
  const token = request.headers["x-admin-session"] || "";
  const payload = verifyAdminSession(token, sessionSecret);
  return payload ? { ...payload, source: "session" } : null;
}

function canMutateAdmin(principal) {
  return principal?.role === "admin";
}

function scopePredicate(principal, { deviceAlias = "d", employeeAlias = "e" } = {}) {
  if (!principal || principal.role === "admin") return { sql: "1 = 1", params: [] };
  if (principal.role === "employee") return { sql: `${deviceAlias}.employee_id = ?`, params: [principal.employee_id] };
  if (principal.role === "manager") return { sql: `${employeeAlias}.team = ?`, params: [principal.team] };
  return { sql: "1 = 0", params: [] };
}

function principalScope(principal) {
  if (!principal || principal.role === "admin") return {};
  return principal.role === "employee" ? { employeeId: principal.employee_id } : { team: principal.team };
}

function bearerToken(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

function deviceFromRequest(db, request) {
  const token = bearerToken(request);
  if (!token) return null;
  const device = db.prepare(`
    SELECT d.*, e.name AS employee_name, e.team AS employee_team
    FROM devices d JOIN employees e ON e.id = d.employee_id
    WHERE d.token_hash = ? AND d.disabled_at IS NULL
  `).get(hash(token));
  if (device) return { ...device, auth_kind: "device" };
  const browser = db.prepare(`
    SELECT d.*, e.name AS employee_name, e.team AS employee_team,
      bt.browser_name, bt.expires_at AS browser_token_expires_at
    FROM browser_tokens bt
    JOIN devices d ON d.id = bt.device_id
    JOIN employees e ON e.id = d.employee_id
    WHERE bt.token_hash = ? AND bt.revoked_at IS NULL AND bt.expires_at > ? AND d.disabled_at IS NULL
  `).get(hash(token), isoNow());
  return browser ? { ...browser, auth_kind: "browser" } : null;
}

function recordAudit(db, action, actor, target, detail = "") {
  db.prepare(
    "INSERT INTO audit_logs (id, action, actor, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId("audit"), action, actor, target, detail, isoNow());
}

function refreshStaleDeviceStatuses(db) {
  const heartbeatInterval = Number(getPolicy(db).heartbeat_interval_seconds) || 60;
  const staleBefore = Date.now() - Math.max(heartbeatInterval * 3, 180) * 1000;
  const devices = db.prepare("SELECT id, status, last_heartbeat_at FROM devices WHERE disabled_at IS NULL").all();
  const update = db.prepare("UPDATE devices SET status = ?, updated_at = ? WHERE id = ?");
  for (const device of devices) {
    const lastHeartbeat = Date.parse(device.last_heartbeat_at || "");
    const nextStatus = Number.isNaN(lastHeartbeat) || lastHeartbeat < staleBefore ? "offline" : "online";
    if (nextStatus === device.status) continue;
    const now = isoNow();
    update.run(nextStatus, now, device.id);
    recordAudit(db, nextStatus === "online" ? "agent_online" : "agent_offline", "system", device.id, nextStatus === "online" ? "heartbeat resumed" : "heartbeat timeout");
  }
}

function validateEnrollment(body) {
  if (typeof body.registration_code !== "string" || body.registration_code.length < 6) return "registration_code is required";
  if (typeof body.hostname !== "string" || body.hostname.length < 1 || body.hostname.length > 150) return "hostname is required";
  if (typeof body.os_version !== "string" || body.os_version.length < 1 || body.os_version.length > 150) return "os_version is required";
  if (typeof body.agent_version !== "string" || body.agent_version.length < 1 || body.agent_version.length > 30) return "agent_version is required";
  return null;
}

function validateEvents(body) {
  if (!Array.isArray(body.events) || body.events.length > 100) return "events must be an array with at most 100 items";
  for (const event of body.events) {
    if (!event || typeof event.event_id !== "string" || event.event_id.length > 100) return "event_id is required";
    if (!allowedEventTypes.has(event.type)) return "unsupported event type";
    if (typeof event.occurred_at !== "string" || Number.isNaN(Date.parse(event.occurred_at))) return "occurred_at must be an ISO date";
    if (typeof event.app_name !== "string" || event.app_name.length > 120) return "app_name is required";
    if (typeof event.process_name !== "string" || event.process_name.length > 120) return "process_name is required";
    if (event.source_kind !== undefined && event.source_kind !== null && !allowedSourceKinds.has(event.source_kind)) return "source_kind is invalid";
    if (event.context_label !== undefined && event.context_label !== null && !isSafeContextLabel(event.context_label)) return "context_label is invalid";
    if (event.title_hint !== undefined && event.title_hint !== null && !isSafeContextLabel(event.title_hint)) return "title_hint is invalid";
    if (event.web_domain !== undefined && event.web_domain !== null && (typeof event.web_domain !== "string" || event.web_domain.length > 253 || !isSafeWebDomain(event.web_domain))) return "web_domain is invalid";
    if (!Number.isInteger(event.duration_seconds) || event.duration_seconds < 0 || event.duration_seconds > MAX_EVENT_DURATION_SECONDS) return "duration_seconds is invalid";
  }
  return null;
}

function sourceKindForEvent(event) {
  if (event?.type === "idle") return "system_idle";
  if (event?.web_domain) {
    if (event.source_kind === "browser_extension" || event.source_kind === "browser_native") {
      return event.source_kind;
    }
    return event?.title_hint || String(event?.context_label || "").startsWith("来源：")
      ? "browser_extension"
      : "browser_native";
  }
  if (allowedSourceKinds.has(event?.source_kind)) return event.source_kind;
  return "desktop_app";
}

function isSafeContextLabel(value) {
  return typeof value === "string"
    && value.length <= 120
    && !/[\r\n]/.test(value)
    && !/https?:\/\//i.test(value)
    && !/[\\/?#]/.test(value);
}

function parsePolicyMinutes(value, { allowEndOfDay = false } = {}) {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return null;
  const [hour, minute] = value.split(":").map(Number);
  if (minute >= 60) return null;
  if (allowEndOfDay && hour === 24 && minute === 0) return 24 * 60;
  if (hour >= 24) return null;
  return hour * 60 + minute;
}

function validatePolicyUpdate(body) {
  if (!body || typeof body !== "object") return "policy must be an object";
  const start = parsePolicyMinutes(body.work_hours_start);
  const end = parsePolicyMinutes(body.work_hours_end, { allowEndOfDay: true });
  if (start === null || end === null) return "work hours must use HH:MM format";
  if (start >= end) return "work_hours_end must be later than work_hours_start";
  if (!Number.isInteger(body.activity_checkpoint_seconds) || body.activity_checkpoint_seconds < 10 || body.activity_checkpoint_seconds > 300) {
    return "activity_checkpoint_seconds must be an integer between 10 and 300";
  }
  for (const key of ["collect_app_activity", "collect_idle_status", "collect_web_domains", "collect_file_metadata"]) {
    if (typeof body[key] !== "boolean") return `${key} must be boolean`;
  }
  if (!isValidPolicyList(body.excluded_processes, { kind: "process" })) return "excluded_processes is invalid";
  if (!isValidPolicyList(body.excluded_domains, { kind: "domain" })) return "excluded_domains is invalid";
  return null;
}

function isValidPolicyList(value, { kind }) {
  if (!Array.isArray(value) || value.length > 100) return false;
  return value.every((item) => {
    if (typeof item !== "string" || !item.trim() || item.length > 120 || /[\r\n]/.test(item)) return false;
    if (kind === "domain") return isSafeWebDomain(item);
    return /^[a-z0-9_.-]+$/i.test(item.trim());
  });
}

function policyDomainMatches(domain, excludedDomains = []) {
  const normalized = String(domain || "").trim().toLowerCase();
  if (!normalized) return false;
  return excludedDomains.some((excluded) => {
    const value = String(excluded || "").trim().toLowerCase();
    return normalized === value || normalized.endsWith(`.${value}`);
  });
}

function eventExcludedByPolicy(event, policy) {
  if (event.type === "app_session" && policy.collect_app_activity === false) return true;
  if (event.type === "idle" && policy.collect_idle_status === false) return true;
  const processName = String(event.process_name || "").trim().toLowerCase();
  const excludedProcesses = (policy.excluded_processes || []).map((item) => String(item).trim().toLowerCase());
  return excludedProcesses.includes(processName) || policyDomainMatches(event.web_domain, policy.excluded_domains);
}

function eventPayloadByPolicy(event, policy) {
  if (policy.collect_web_domains !== false) return event;
  const sourceKind = sourceKindForEvent(event);
  return {
    ...event,
    source_kind: sourceKind === "browser_native" || sourceKind === "browser_extension" ? "desktop_app" : sourceKind,
    web_domain: null,
  };
}

function isSafeWebDomain(value) {
  const domain = value.trim().toLowerCase();
  if (!domain || domain.includes("/") || domain.includes("?") || domain.includes("#") || domain.includes("@")) return false;
  if (domain === "localhost") return true;
  return domain.split(".").length >= 2 && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain);
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function formatShanghaiDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date).replace(/\//g, "-");
}

function isBareDomainHistoryTitle(value, employeeName = "") {
  const title = String(value || "").trim();
  const prefix = employeeName ? `${employeeName} ·` : "";
  const candidate = prefix && title.startsWith(prefix)
    ? title.slice(prefix.length).trim()
    : title;
  return isSafeWebDomain(candidate);
}

function summaryNeedsMetadataEvidence(value, record) {
  const text = String(value || "");
  if (!text.trim()) return true;
  if (record.started_at && !text.includes("东八区")) return true;
  if ((record.activity_sequence || []).length > 1 && !text.includes("切换") && !text.includes("应用顺序") && !text.includes("→")) return true;
  return false;
}

function evidenceTimeRange(records) {
  const starts = records.map((record) => Date.parse(record.started_at)).filter(Number.isFinite);
  const ends = records.map((record) => Date.parse(record.ended_at)).filter(Number.isFinite);
  if (!starts.length || !ends.length) return null;
  return {
    start: new Date(Math.min(...starts)).toISOString(),
    end: new Date(Math.max(...ends)).toISOString(),
  };
}

function applicationKey(appName) {
  const normalized = String(appName || "").toLowerCase();
  if (normalized.includes("edge") || normalized.includes("msedge")) return "edge";
  if (normalized.includes("chrome")) return "chrome";
  if (normalized.includes("360se")) return "browser360";
  if (normalized.includes("code") || normalized.includes("visual studio")) return "vscode";
  if (normalized.includes("wemeet") || normalized.includes("tencentmeeting") || normalized.includes("腾讯会议")) return "tencent_meeting";
  if (normalized.includes("wechat") || normalized.includes("weixin") || normalized.includes("企业微信")) return "wechat";
  if (normalized.includes("slack")) return "slack";
  if (normalized.includes("teams")) return "teams";
  if (normalized.includes("feishu") || normalized.includes("lark") || normalized.includes("dingtalk")) return "collaboration";
  if (normalized.includes("jira") || normalized.includes("linear") || normalized.includes("trello") || normalized.includes("asana") || normalized.includes("clickup")) return "project";
  if (normalized.includes("wps")) return "wps";
  if (normalized.includes("winword") || normalized.includes("word")) return "word";
  if (normalized.includes("excel")) return "excel";
  if (normalized.includes("powerpnt") || normalized.includes("powerpoint")) return "powerpoint";
  if (normalized.includes("notion")) return "notion";
  if (normalized.includes("figma")) return "figma";
  if (normalized.includes("360zip")) return "archive360";
  if (normalized.includes("doubao")) return "doubao";
  if (normalized.includes("namiai")) return "namiai";
  if (normalized.includes("360tray")) return "security360";
  if (normalized.includes("finder")) return "finder";
  if (normalized.includes("explorer")) return "explorer";
  if (normalized.includes("terminal") || normalized.includes("powershell") || normalized.includes("cmd.exe")) return "terminal";
  if (normalized.includes("codex") || normalized.includes("chatgpt")) return "codex";
  return "other";
}

function displayApplicationName(appName) {
  const normalized = String(appName || "").toLowerCase();
  if (normalized.includes("chrome")) return "Google Chrome";
  if (normalized.includes("edge") || normalized.includes("msedge")) return "Microsoft Edge";
  if (normalized.includes("360se")) return "360 浏览器";
  if (normalized.includes("code") || normalized.includes("visual studio")) return "Visual Studio Code";
  if (normalized.includes("wemeet") || normalized.includes("tencentmeeting") || normalized.includes("腾讯会议")) return "腾讯会议";
  if (normalized.includes("wechat") || normalized.includes("weixin") || normalized.includes("企业微信")) return "微信/企业微信";
  if (normalized.includes("slack")) return "Slack";
  if (normalized.includes("teams")) return "Microsoft Teams";
  if (normalized.includes("feishu") || normalized.includes("lark")) return "飞书";
  if (normalized.includes("dingtalk")) return "钉钉";
  if (normalized.includes("jira")) return "Jira";
  if (normalized.includes("linear")) return "Linear";
  if (normalized.includes("trello")) return "Trello";
  if (normalized.includes("asana")) return "Asana";
  if (normalized.includes("clickup")) return "ClickUp";
  if (normalized.includes("wps")) return "WPS Office";
  if (normalized.includes("winword") || normalized.includes("word")) return "Microsoft Word";
  if (normalized.includes("excel")) return "Microsoft Excel";
  if (normalized.includes("powerpnt") || normalized.includes("powerpoint")) return "Microsoft PowerPoint";
  if (normalized.includes("notion")) return "Notion";
  if (normalized.includes("figma")) return "Figma";
  if (normalized.includes("360zip")) return "360 压缩";
  if (normalized.includes("doubao")) return "豆包";
  if (normalized.includes("namiai")) return "Namiai";
  if (normalized.includes("360tray")) return "360 安全卫士";
  if (normalized.includes("explorer")) return "Windows 文件资源管理器";
  if (normalized.includes("terminal") || normalized.includes("powershell") || normalized.includes("cmd.exe")) return "Windows 终端";
  if (normalized.includes("codex") || normalized.includes("chatgpt")) return "Codex";
  return appName;
}

function applicationContext(appName, processName) {
  const normalized = `${appName || ""} ${processName || ""}`.toLowerCase();
  if (normalized.includes("jira") || normalized.includes("linear") || normalized.includes("trello") || normalized.includes("asana") || normalized.includes("clickup") || normalized.includes("monday")) return "项目管理";
  if (normalized.includes("wemeet") || normalized.includes("tencentmeeting") || normalized.includes("腾讯会议")) return "沟通";
  if (normalized.includes("wechat") || normalized.includes("weixin") || normalized.includes("企业微信") || normalized.includes("slack") || normalized.includes("teams") || normalized.includes("feishu") || normalized.includes("lark") || normalized.includes("dingtalk")) return "沟通";
  if (normalized.includes("chrome") || normalized.includes("edge") || normalized.includes("360se") || normalized.includes("firefox") || normalized.includes("browser")) return "浏览器";
  if (normalized.includes("code") || normalized.includes("visual studio") || normalized.includes("idea") || normalized.includes("devenv")) return "开发";
  if (normalized.includes("doubao") || normalized.includes("namiai") || normalized.includes("codex") || normalized.includes("chatgpt")) return "AI 工作台";
  if (normalized.includes("360zip")) return "文件";
  if (normalized.includes("wps") || normalized.includes("word") || normalized.includes("excel") || normalized.includes("powerpoint") || normalized.includes("notion")) return "文档";
  if (normalized.includes("explorer") || normalized.includes("finder")) return "文件";
  if (normalized.includes("terminal") || normalized.includes("powershell") || normalized.includes("cmd.exe") || normalized.includes("windowsterminal")) return "终端";
  if (normalized.includes("360tray")) return "系统";
  if (normalized.includes("idle") || normalized.includes("system")) return "系统";
  return "其他";
}

function metadataResource(label) {
  const value = String(label || "");
  if (value.startsWith("项目：")) return { name: value, path: "脱敏项目标识", type: "code", source_type: "代码仓库" };
  if (value.startsWith("文档：")) return { name: value, path: "脱敏文档标识", type: "document", source_type: "文档" };
  if (value.startsWith("文件：") || value.startsWith("文件夹：")) return { name: value, path: "脱敏文件标识", type: "document", source_type: "文档" };
  if (value.startsWith("来源：")) return { name: value, path: "允许的来源提示", type: "metadata", source_type: "网站" };
  if (value.startsWith("操作：")) return { name: value, path: "脱敏操作分类", type: "metadata", source_type: "工作操作" };
  if (value.startsWith("状态：")) return { name: value, path: "脱敏状态分类", type: "metadata", source_type: "工作状态" };
  if (value.startsWith("资源：")) return { name: value, path: "脱敏资源分类", type: "metadata", source_type: "工作资源" };
  return { name: value, path: "脱敏工作标识", type: "metadata", source_type: "项目" };
}

// Browser sources may send a compact, redacted hint such as
// "来源：GitHub · 项目：owner-repo". Keep the event schema backward
// compatible (it still stores one context_label), but expose each protected
// facet separately to History, Resources, and the AI prompt.
function splitContextLabels(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return [...new Set(value
    .split(/\s*[·|｜;；]\s*/)
    .map((item) => item.trim())
    .filter((item) => item && isSafeContextLabel(item)))].slice(0, 8);
}

function applicationResource(applicationName) {
  const context = applicationContext(applicationName, "");
  const sourceType = context === "沟通"
    ? "沟通工具"
    : context === "文档"
      ? "文档"
      : context === "项目管理"
        ? "项目"
        : "应用元数据";
  return {
    name: applicationName,
    path: "前台应用元数据",
    type: "application",
    source_type: sourceType,
  };
}

function sourceKindLabel(sourceKind) {
  return {
    desktop_app: "桌面应用",
    browser_native: "浏览器原生",
    browser_extension: "浏览器扩展",
    system_idle: "系统空闲",
    system_app: "系统组件",
  }[sourceKind] || "活动元数据";
}

function contextResource(label) {
  const resource = metadataResource(label);
  return String(label || "").startsWith("来源：")
    ? { ...resource, path: "脱敏网站来源提示", type: "website", source_type: "网站" }
    : resource;
}

function workThemeTitle(employeeName, {
  isIdle = false,
  contextKinds = [],
  applicationNames = [],
  contextLabels = [],
  resourceTypes = [],
} = {}) {
  if (isIdle) return `${employeeName} · 系统空闲`;

  // App classification is the primary signal. Redacted project/document/site
  // facets add the missing work context without ever using raw titles, URLs,
  // or page contents in a user-facing title.
  const themes = [...new Set(contextKinds.filter(Boolean))];
  const labels = contextLabels.filter((label) => typeof label === "string");
  const types = new Set(resourceTypes.filter(Boolean));
  const hasLabel = (prefix) => labels.some((label) => label.startsWith(prefix));
  const projectLabel = labels.find((label) => label.startsWith("项目："));
  const operationLabel = labels.find((label) => label.startsWith("操作："));
  const appendTheme = (theme) => {
    if (!themes.includes(theme)) themes.push(theme);
  };

  if (hasLabel("项目：") || types.has("代码仓库")) appendTheme("开发");
  if (hasLabel("文档：") || hasLabel("文件：") || hasLabel("文件夹：") || types.has("文档")) appendTheme("文档");
  if (hasLabel("来源：") || types.has("网站")) appendTheme("浏览器");
  if (types.has("沟通工具")) appendTheme("沟通");
  if (themes.length > 1 && themes.includes("其他")) {
    themes.splice(themes.indexOf("其他"), 1);
  }
  if (operationLabel && projectLabel) {
    return `${employeeName} · ${projectLabel.slice(3)} ${operationLabel.slice(3)}`;
  }
  if (operationLabel) {
    return `${employeeName} · ${operationLabel.slice(3)}活动`;
  }
  if (themes.length) return `${employeeName} · ${themes.slice(0, 4).join("、")}${themes.length > 4 ? "等" : ""}活动`;
  const apps = applicationNames.filter(Boolean);
  if (apps.length > 2) return `${employeeName} · 多应用工作活动`;
  return `${employeeName} · ${apps.join("、") || "工作"}活动`;
}

function isMemoryRecordActive(record, nowMs = Date.now()) {
  const endedAtMs = Date.parse(record.ended_at);
  return Number.isFinite(endedAtMs) && endedAtMs >= nowMs - AI_ACTIVE_GRACE_SECONDS * 1000;
}

function isEligibleForAiSummary(record, nowMs = Date.now()) {
  if (isMemoryRecordActive(record, nowMs)) return false;
  // Keep Qwen on the fixed ten-minute Leaf cadence. Rollups are derived
  // views of those Leaves and stay rules-based in the MVP, otherwise one
  // activity window would fan out into hourly/daily/weekly model calls.
  return record.record_type === "leaf"
    && Number(record.duration_seconds || 0) >= AI_SUMMARY_WINDOW_SECONDS;
}

function historyEventRows(db, deviceId, principal = null, team = null) {
  const conditions = [];
  const params = [];
  if (deviceId) {
    conditions.push("ev.device_id = ?");
    params.push(deviceId);
  }
  const scope = scopePredicate(principal);
  conditions.push(scope.sql);
  params.push(...scope.params);
  // A sleeping/resumed Windows client can report a malformed future timestamp.
  // Keep the raw event for diagnostics, but never let it appear in History.
  conditions.push("julianday(ev.occurred_at) <= julianday(?)");
  params.push(new Date(Date.now() + 60_000).toISOString());
  if (team && principal?.role !== "employee") {
    conditions.push("e.team = ?");
    params.push(team);
  }
  const query = `SELECT ev.*, d.employee_id, e.name AS employee_name, e.team AS employee_team, d.hostname
    FROM events ev
    JOIN devices d ON d.id = ev.device_id
    JOIN employees e ON e.id = d.employee_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY ev.occurred_at ASC
    LIMIT 10000`;
  const rows = db.prepare(query).all(...params);
  return rows
    .filter((row) => !HIDDEN_AGENT_PROCESSES.has(String(row.process_name || "").toLowerCase()))
    .map((row) => ({ ...row, source_kind: sourceKindForEvent(row) }));
}

function splitHistoryEventRow(row) {
  const durationSeconds = Math.max(0, Number(row.duration_seconds) || 0);
  // Older Windows Agent builds could emit a full-day idle checkpoint after
  // sleep/resume. Reject it before segmentation; otherwise it would become
  // many apparently valid ten-minute windows and push History into the future.
  if (row.type === "idle" && durationSeconds >= 86_400) return [];
  if (durationSeconds <= HISTORY_WINDOW_SECONDS) return [row];
  const startMs = Date.parse(row.occurred_at);
  if (!Number.isFinite(startMs)) return [row];
  const segments = [];
  let offsetSeconds = 0;
  let segmentIndex = 0;
  while (offsetSeconds < durationSeconds) {
    const segmentDuration = Math.min(HISTORY_WINDOW_SECONDS, durationSeconds - offsetSeconds);
    segments.push({
      ...row,
      event_id: `${row.event_id}:segment:${segmentIndex}`,
      source_event_id: row.event_id,
      occurred_at: new Date(startMs + offsetSeconds * 1000).toISOString(),
      duration_seconds: segmentDuration,
    });
    offsetSeconds += segmentDuration;
    segmentIndex += 1;
  }
  return segments;
}

function sourceKindPriority(sourceKind) {
  return {
    browser_extension: 3,
    browser_native: 2,
    desktop_app: 1,
    system_app: 1,
    system_idle: 1,
  }[sourceKind] || 0;
}

function coalesceOverlappingActivityRows(rows) {
  const compact = [];
  for (const row of rows) {
    const startMs = Date.parse(row.occurred_at);
    const durationSeconds = Math.max(0, Number(row.duration_seconds) || 0);
    const endMs = startMs + durationSeconds * 1000;
    const previous = compact.at(-1);
    if (!previous || row.type !== previous.type) {
      compact.push(row);
      continue;
    }
    const previousStartMs = Date.parse(previous.occurred_at);
    const previousEndMs = previousStartMs + Math.max(0, Number(previous.duration_seconds) || 0) * 1000;
    const sameActivity = row.app_name === previous.app_name
      && row.process_name === previous.process_name
      && (row.web_domain || null) === (previous.web_domain || null)
      && ((row.context_label || null) === (previous.context_label || null)
        || Boolean(row.web_domain && previous.web_domain));
    if (!sameActivity || !Number.isFinite(startMs) || !Number.isFinite(previousStartMs) || startMs >= previousEndMs) {
      compact.push(row);
      continue;
    }
    const mergedStartMs = Math.min(previousStartMs, startMs);
    const mergedEndMs = Math.max(previousEndMs, endMs);
    const preferred = sourceKindPriority(sourceKindForEvent(row)) > sourceKindPriority(sourceKindForEvent(previous))
      ? row
      : previous;
    compact[compact.length - 1] = {
      ...preferred,
      occurred_at: new Date(mergedStartMs).toISOString(),
      duration_seconds: Math.max(0, Math.round((mergedEndMs - mergedStartMs) / 1000)),
    };
  }
  return compact;
}

// Keep the raw activity_sequence for evidence and source tracing, but give
// summaries a task-shaped sequence: adjacent observations from the same
// foreground application form one stage, while returning to an app after a
// different app still creates a new stage. Browser domain changes are kept as
// a small set on that stage instead of becoming dozens of repeated Edge rows.
function buildSummaryActivitySequence(rows) {
  const stages = [];
  for (const row of rows) {
    const occurredAtMs = Date.parse(row.occurred_at);
    if (!Number.isFinite(occurredAtMs)) continue;
    const durationSeconds = Math.max(0, Number(row.duration_seconds) || 0);
    const endMs = occurredAtMs + durationSeconds * 1000;
    const appName = row.type === "idle" ? "Idle" : row.app_name;
    const processName = row.process_name;
    const stageKey = `${row.type}\u001f${appName}\u001f${processName}`;
    const previous = stages.at(-1);
    const previousGapSeconds = previous
      ? Math.max(0, (occurredAtMs - previous.endMs) / 1000)
      : Infinity;
    if (!previous || previous.key !== stageKey || previousGapSeconds > 90) {
      stages.push({
        key: stageKey,
        occurred_at: row.occurred_at,
        endMs,
        duration_seconds: durationSeconds,
        app: row.type === "idle" ? "系统空闲" : displayApplicationName(row.app_name),
        app_name: row.app_name,
        context_kind: row.type === "idle" ? "系统" : applicationContext(row.app_name, row.process_name),
        context_labels: splitContextLabels(row.context_label),
        web_domains: row.web_domain ? [row.web_domain] : [],
        source_kinds: [row.source_kind || sourceKindForEvent(row)],
      });
      continue;
    }

    previous.endMs = Math.max(previous.endMs, endMs);
    previous.duration_seconds = Math.max(0, Math.round((previous.endMs - Date.parse(previous.occurred_at)) / 1000));
    previous.context_labels = [...new Set([
      ...previous.context_labels,
      ...splitContextLabels(row.context_label),
    ])].slice(0, 8);
    if (row.web_domain && !previous.web_domains.includes(row.web_domain)) {
      previous.web_domains = [...previous.web_domains, row.web_domain].slice(0, 8);
    }
    const sourceKind = row.source_kind || sourceKindForEvent(row);
    if (!previous.source_kinds.includes(sourceKind)) previous.source_kinds.push(sourceKind);
  }

  return stages.map(({ key, endMs, context_labels, web_domains, source_kinds, ...stage }) => ({
    ...stage,
    duration_seconds: Math.max(0, Math.round((endMs - Date.parse(stage.occurred_at)) / 1000)),
    context_label: context_labels.join(" · ") || null,
    context_labels,
    web_domain: web_domains.length === 1 ? web_domains[0] : null,
    web_domains,
    source_kind: source_kinds
      .sort((left, right) => sourceKindPriority(right) - sourceKindPriority(left))[0] || "desktop_app",
    source_kinds,
  }));
}

function buildHistoryRecords(db, { deviceId = null, limit = 200, principal = null, team = null } = {}) {
  const episodes = [];
  let current = null;

  const flush = () => {
    if (current) episodes.push(current);
    current = null;
  };

  const historyRows = historyEventRows(db, deviceId, principal, team)
    .flatMap((sourceRow) => splitHistoryEventRow(sourceRow))
    .sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
  for (const row of historyRows) {
    const startMs = Date.parse(row.occurred_at);
    if (Number.isNaN(startMs)) continue;
    const rawDurationSeconds = Math.max(0, Number(row.duration_seconds) || 0);
    // Values exactly at the protocol ceiling were produced by the first
    // Windows idle-time implementation when the machine uptime was long.
    // Keep those raw events for diagnostics, but do not turn them into fake
    // 24-hour History entries.
    if (row.type === "idle" && rawDurationSeconds >= 86_400) continue;
    const durationSeconds = rawDurationSeconds;
    const endMs = startMs + durationSeconds * 1000;
    const isIdle = row.type === "idle";
    const gapSeconds = current ? Math.max(0, (startMs - current.endMs) / 1000) : Infinity;
    const exceedsWindow = current && ((startMs - current.startMs) / 1000 >= HISTORY_WINDOW_SECONDS);

    if (!current || current.deviceId !== row.device_id || current.isIdle !== isIdle || gapSeconds > HISTORY_WINDOW_SECONDS || exceedsWindow) {
      flush();
      current = {
        deviceId: row.device_id,
        employeeId: row.employee_id,
        employeeName: row.employee_name,
        employeeTeam: row.employee_team,
        hostname: row.hostname,
        isIdle,
        startMs,
        endMs,
        rows: [row],
      };
    } else {
      current.endMs = Math.max(current.endMs, endMs);
      current.rows.push(row);
    }
  }
  flush();

  const selectedEpisodes = episodes
    .sort((left, right) => right.startMs - left.startMs)
    .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 2000))
    .sort((left, right) => left.startMs - right.startMs);
  const records = selectedEpisodes.map((episode) => {
      const activityRows = coalesceOverlappingActivityRows(episode.rows);
      const start = new Date(episode.startMs).toISOString();
      const end = new Date(episode.endMs).toISOString();
      const durationSeconds = Math.max(0, Math.round((episode.endMs - episode.startMs) / 1000));
      const rawApplicationNames = [...new Set(activityRows.map((row) => row.app_name))];
      const applicationNames = [...new Set(rawApplicationNames.map(displayApplicationName))];
      const applications = [...new Set(rawApplicationNames.map(applicationKey))];
      const contextKinds = [...new Set(activityRows.map((row) => applicationContext(row.app_name, row.process_name)))];
      const applicationKeys = activityRows.map((row) => [
        row.type,
        row.app_name,
        row.process_name,
      ].join("\u001f"));
      const contextSwitches = applicationKeys.slice(1).reduce(
        (count, key, index) => count + (key === applicationKeys[index] ? 0 : 1),
        0,
      );
      const contextLabels = [...new Set(activityRows.flatMap((row) => splitContextLabels(row.context_label)))];
      const webDomains = [...new Set(activityRows.map((row) => row.web_domain).filter((value) => typeof value === "string" && value.trim()))];
      const sourceKinds = [...new Set(activityRows.map((row) => row.source_kind || sourceKindForEvent(row)))];
      const sourceTypes = [...new Set(sourceKinds.map(sourceKindLabel))];
      const summaryActivitySequence = buildSummaryActivitySequence(activityRows);
      const activitySequence = activityRows.map((row) => {
        const rowContextLabels = splitContextLabels(row.context_label);
        return ({
        occurred_at: row.occurred_at,
        duration_seconds: Math.max(0, Number(row.duration_seconds) || 0),
        app: row.type === "idle" ? "系统空闲" : displayApplicationName(row.app_name),
        app_name: row.app_name,
        context_kind: row.type === "idle" ? "系统" : applicationContext(row.app_name, row.process_name),
        context_label: rowContextLabels.join(" · ") || null,
        context_labels: rowContextLabels,
        web_domain: row.web_domain || null,
        source_kind: row.source_kind || sourceKindForEvent(row),
        });
      });
      const activityCount = activitySequence.length;
      const sourceLabels = [...contextLabels, ...webDomains];
      const displayApps = episode.isIdle ? ["系统空闲"] : applicationNames;
      const resources = [...new Map([
        ...(episode.isIdle ? [] : applicationNames.map(applicationResource)),
        ...contextLabels.map(contextResource),
        ...webDomains.map((domain) => ({ name: domain, path: "仅域名元数据", type: "website", source_type: "网站" })),
      ].map((item) => [item.name, item])).values()];
      const resourceTypes = [...new Set(resources.map((resource) => resource.source_type).filter(Boolean))];
      const displayTitle = workThemeTitle(episode.employeeName, {
        isIdle: episode.isIdle,
        contextKinds,
        applicationNames: displayApps,
        contextLabels,
        resourceTypes,
      });
      const readableDuration = formatDuration(durationSeconds);
      const timeRange = `东八区 ${formatShanghaiDateTime(start)} 至 ${formatShanghaiDateTime(end)}`;
      const sourceDetail = sourceLabels.length
        ? `关联 ${sourceLabels.join("、")}。`
        : "未记录具体网站或项目内容。";
      const timeline = activityRows.map((row) => ({
        occurred_at: row.occurred_at,
        duration_seconds: Math.max(0, Number(row.duration_seconds) || 0),
        source_kind: row.source_kind || sourceKindForEvent(row),
        text: row.type === "idle"
          ? "进入系统空闲状态"
          : [
              `前台应用：${displayApplicationName(row.app_name)}`,
              row.context_label,
              row.web_domain ? `域名：${row.web_domain}` : null,
            ].filter(Boolean).join(" · "),
        app: row.type === "idle" ? "other" : applicationKey(row.app_name),
      }));
      const citations = [...new Map([
        ...episode.rows.map((row) => [
          `app:${row.process_name}`,
          {
            label: row.hostname,
            detail: `${episode.employeeName} · ${row.process_name}`,
            type: "app",
          },
        ]),
        ...contextLabels.map((label) => [
          `context:${label}`,
          {
            label,
            detail: "脱敏工作标识；未保存原始窗口标题",
            type: "metadata",
          },
        ]),
        ...webDomains.map((domain) => [
          `domain:${domain}`,
          {
            label: domain,
            detail: "仅保留网站域名；未保存完整 URL 或页面内容",
            type: "website",
          },
        ]),
      ]).values()];

      return {
        id: `history_${episode.deviceId}_${episode.startMs}`,
        user_id: episode.employeeId,
        employee_name: episode.employeeName,
        employee_team: episode.employeeTeam,
        device_id: episode.deviceId,
        hostname: episode.hostname,
        record_type: "leaf",
        title: displayTitle,
        description: episode.isIdle
          ? `${episode.employeeName} 的电脑处于系统空闲状态 ${readableDuration}（${timeRange}）。`
          : `${episode.employeeName} 在 ${displayApps.join("、")} 中连续活动 ${readableDuration}（${timeRange}），记录 ${activityCount} 个去重活动片段并发生 ${contextSwitches} 次上下文切换${sourceLabels.length ? `，关联 ${sourceLabels.join("、")}` : ""}。`,
        applications,
        application_names: applicationNames,
        context_kinds: contextKinds,
        context_switches: contextSwitches,
        context_labels: contextLabels,
        web_domains: webDomains,
        source_kinds: sourceKinds,
        source_types: sourceTypes,
        activity_sequence: activitySequence,
        summary_activity_sequence: summaryActivitySequence,
        activity_fragment_count: activityCount,
        summary_activity_count: summaryActivitySequence.length,
        duration_seconds: durationSeconds,
        started_at: start,
        ended_at: end,
        summary: episode.isIdle
          ? `这是一条基于系统空闲状态生成的活动元数据记录，时间范围为${timeRange}。`
          : `${episode.employeeName} 在 ${contextKinds.join("、") || "工作"}上下文中连续活动 ${readableDuration}（${timeRange}），按 ${summaryActivitySequence.length} 个应用阶段概括（原始采集片段 ${activityCount} 个），发生 ${contextSwitches} 次应用切换。来源类型包括 ${sourceTypes.join("、")}；${sourceDetail}该摘要只基于活动元数据生成。`,
        prior_context: "来源于 Windows Agent 的前台应用活动采集；工作标识来自允许的开发工具窗口标题脱敏结果，网站只保留域名。",
        important_context: "应用切换只代表活动上下文变化，不直接代表工作效率或绩效结论；系统不保存原始窗口标题、完整 URL、页面正文或聊天正文。",
        non_obvious: "应用切换只代表活动上下文变化，不直接代表工作效率或绩效结论；系统不保存原始窗口标题、完整 URL、页面正文或聊天正文。",
        timeline,
        resources,
        resource_types: resourceTypes,
        citations,
        source_event_ids: [...new Set(episode.rows.map((row) => row.source_event_id || row.event_id))],
        confidence: 1,
      };
  });

  const previousByDevice = new Map();
  for (const record of records) {
    const previous = previousByDevice.get(record.device_id);
    if (previous) {
      const previousContext = [
        ...(previous.application_names || []).slice(0, 3),
        ...(previous.context_labels || []).slice(0, 3),
        ...(previous.web_domains || []).slice(0, 3).map((domain) => `网站：${domain}`),
      ];
      record.prior_context = previousContext.length
        ? `此前紧邻活动涉及 ${previousContext.join("、")}；当前记录是后续工作上下文。`
        : "此前同一设备存在相邻活动窗口；当前记录是后续工作上下文。";
    }
    previousByDevice.set(record.device_id, record);
  }
  return records.sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at));
}

function aiInputForRecord(record) {
  return {
    ...record,
    summary: record.summary,
    prior_context: record.prior_context,
    important_context: record.important_context || record.non_obvious,
    non_obvious: record.non_obvious,
  };
}

const HISTORY_QUERY_STOPWORDS = new Set([
  "最近", "今天", "昨天", "本周", "这周", "主要", "做了", "什么", "哪些", "这个", "团队", "工作", "活动", "记录", "情况", "是否", "存在", "频繁", "任务", "切换",
]);

function historyQueryTokens(question) {
  const fragments = String(question || "").toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9][a-z0-9._-]*/gu) || [];
  const tokens = new Set();
  for (const fragment of fragments) {
    if (HISTORY_QUERY_STOPWORDS.has(fragment)) continue;
    if (/^[\p{Script=Han}]+$/u.test(fragment)) {
      if (fragment.length >= 2) tokens.add(fragment);
      for (let index = 0; index < fragment.length - 1; index += 1) tokens.add(fragment.slice(index, index + 2));
    } else if (fragment.length >= 2) {
      tokens.add(fragment);
    }
  }
  return [...tokens];
}

// History Skill retrieval deliberately stays on the redacted metadata plane.
// These groups provide a small local semantic layer for Chinese questions and
// common product names, without sending a second AI request for every search
// or indexing window titles, URLs, file contents, or chat text.
const HISTORY_SEMANTIC_GROUPS = [
  {
    id: "development",
    label: "开发",
    terms: ["开发", "代码", "编程", "研发", "工程", "程序", "vscode", "visual studio", "git", "github", "仓库", "项目", "coding", "codex"],
  },
  {
    id: "browser",
    label: "浏览器",
    terms: ["浏览器", "网页", "网站", "上网", "chrome", "edge", "firefox", "360 浏览器", "360se", "域名", "browser"],
  },
  {
    id: "communication",
    label: "沟通",
    terms: ["沟通", "聊天", "会议", "协作", "微信", "企业微信", "weixin", "wechat", "腾讯会议", "slack", "teams", "飞书", "钉钉", "dingtalk"],
  },
  {
    id: "documents",
    label: "文档",
    terms: ["文档", "文件", "资料", "写作", "编辑", "word", "excel", "powerpoint", "wps", "notion", "文件资源管理器", "explorer", "finder"],
  },
  {
    id: "project_management",
    label: "项目管理",
    terms: ["项目管理", "任务", "进度", "工单", "jira", "linear", "trello", "asana", "clickup", "monday"],
  },
  {
    id: "ai_workspace",
    label: "AI 工作台",
    terms: ["人工智能", "ai", "模型", "大模型", "提示词", "摘要", "qwen", "通义", "豆包", "doubao", "namiai", "codex", "chatgpt"],
  },
  {
    id: "terminal",
    label: "终端",
    terms: ["终端", "命令行", "shell", "terminal", "powershell", "cmd"],
  },
  {
    id: "idle",
    label: "系统空闲",
    terms: ["空闲", "离开", "不在电脑前", "idle", "休息", "锁屏"],
  },
  {
    id: "system",
    label: "系统",
    terms: ["系统", "后台", "服务", "托盘", "安全", "system", "360 安全卫士", "360tray"],
  },
];

function normalizedSearchText(value) {
  return String(value || "").toLowerCase().replace(/[：:，,。！？!?、/\\()[\]{}]/g, " ");
}

function semanticGroupsForText(value) {
  const text = normalizedSearchText(value);
  return new Set(HISTORY_SEMANTIC_GROUPS
    .filter((group) => group.terms.some((term) => text.includes(String(term).toLowerCase())))
    .map((group) => group.id));
}

function historyRecordSemanticText(record) {
  const sequence = Array.isArray(record?.activity_sequence) ? record.activity_sequence : [];
  const summarySequence = Array.isArray(record?.summary_activity_sequence) ? record.summary_activity_sequence : [];
  const timeline = Array.isArray(record?.timeline) ? record.timeline : [];
  const resources = Array.isArray(record?.resources) ? record.resources : [];
  const citations = Array.isArray(record?.citations) ? record.citations : [];
  return [
    record?.title,
    record?.description,
    record?.summary,
    record?.context_kinds,
    record?.context_labels,
    record?.web_domains,
    record?.source_kinds,
    record?.source_types,
    record?.resource_types,
    record?.application_names,
    sequence.flatMap((item) => [
      item?.app,
      item?.context_kind,
      item?.context_label,
      item?.context_labels,
      item?.web_domain,
      item?.source_kind,
    ]),
    summarySequence.flatMap((item) => [
      item?.app,
      item?.context_kind,
      item?.context_label,
      item?.context_labels,
      item?.web_domain,
      item?.web_domains,
    ]),
    timeline.flatMap((item) => [item?.app, item?.text, item?.source_kind]),
    resources.map((item) => item?.name),
    citations.map((item) => [item?.label, item?.detail]),
  ].flat(Infinity).filter(Boolean).join(" ");
}

function semanticRecordFields(record) {
  const sequence = Array.isArray(record?.activity_sequence) ? record.activity_sequence : [];
  const summarySequence = Array.isArray(record?.summary_activity_sequence) ? record.summary_activity_sequence : [];
  const timeline = Array.isArray(record?.timeline) ? record.timeline : [];
  return [
    [record?.title, 7],
    [record?.context_kinds?.join(" "), 7],
    [record?.context_labels?.join(" "), 6],
    [record?.web_domains?.join(" "), 6],
    [record?.application_names?.join(" "), 5],
    [record?.source_types?.join(" "), 4],
    [record?.resource_types?.join(" "), 5],
    [record?.source_kinds?.join(" "), 3],
    [sequence.map((item) => [
      item?.app,
      item?.context_kind,
      item?.context_label,
      item?.context_labels,
      item?.web_domain,
    ].flat(Infinity).filter(Boolean).join(" ")).join(" "), 4],
    [summarySequence.map((item) => [
      item?.app,
      item?.context_kind,
      item?.context_label,
      item?.context_labels,
      item?.web_domain,
      item?.web_domains,
    ].flat(Infinity).filter(Boolean).join(" ")).join(" "), 5],
    [timeline.map((item) => item?.text).join(" "), 2],
  ];
}

function semanticMatchScore(question, record) {
  const tokens = historyQueryTokens(question);
  const queryText = normalizedSearchText(question);
  const queryGroups = semanticGroupsForText(queryText);
  const recordText = normalizedSearchText(historyRecordSemanticText(record));
  const recordGroups = semanticGroupsForText(recordText);
  const exactScore = tokens.reduce((total, token) => semanticRecordFields(record).reduce((fieldTotal, [value, weight]) => {
    const normalized = normalizedSearchText(value);
    if (!normalized.includes(token)) return fieldTotal;
    const phraseBonus = normalized.includes(queryText) && queryText.length >= 3 ? 2 : 0;
    return fieldTotal + weight + phraseBonus;
  }, 0), 0);
  const semanticScore = [...queryGroups].reduce((total, group) => total + (recordGroups.has(group) ? 12 : 0), 0);
  const groupCoverage = queryGroups.size && recordGroups.size
    ? [...queryGroups].filter((group) => recordGroups.has(group)).length / queryGroups.size
    : 0;
  return {
    score: exactScore + semanticScore + Math.round(groupCoverage * 3),
    queryGroups: [...queryGroups],
    recordGroups: [...recordGroups],
  };
}

function shanghaiDateParts(milliseconds = Date.now()) {
  const shifted = new Date(milliseconds + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay(),
  };
}

function shanghaiDayStart(milliseconds = Date.now()) {
  const parts = shanghaiDateParts(milliseconds);
  return Date.UTC(parts.year, parts.month, parts.day) - SHANGHAI_OFFSET_MS;
}

function shanghaiDateKey(milliseconds) {
  const parts = shanghaiDateParts(milliseconds);
  return `${parts.year}-${String(parts.month + 1).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function historyQueryTimeRange(question, now = Date.now()) {
  const value = String(question || "").trim();
  if (!value) return null;
  const todayStart = shanghaiDayStart(now);
  if (/今天|今日/.test(value)) return { start: new Date(todayStart).toISOString(), end: new Date(now).toISOString(), label: "今天" };
  if (/昨天|昨日/.test(value)) {
    const start = todayStart - 24 * 3600_000;
    return { start: new Date(start).toISOString(), end: new Date(todayStart).toISOString(), label: "昨天" };
  }
  if (/上周/.test(value)) {
    const currentWeekStart = todayStart - ((shanghaiDateParts(now).weekday + 6) % 7) * 24 * 3600_000;
    const start = currentWeekStart - 7 * 24 * 3600_000;
    return { start: new Date(start).toISOString(), end: new Date(currentWeekStart).toISOString(), label: "上周" };
  }
  if (/本周|这周|本星期/.test(value)) {
    const start = todayStart - ((shanghaiDateParts(now).weekday + 6) % 7) * 24 * 3600_000;
    return { start: new Date(start).toISOString(), end: new Date(now).toISOString(), label: "本周" };
  }
  const recent = value.match(/(?:最近|近|过去)\s*(\d{1,3})\s*(分钟|小时|天|周)/);
  if (recent) {
    const amount = Number(recent[1]);
    const units = { 分钟: 60_000, 小时: 3600_000, 天: 24 * 3600_000, 周: 7 * 24 * 3600_000 };
    const start = now - amount * units[recent[2]];
    return { start: new Date(start).toISOString(), end: new Date(now).toISOString(), label: `${recent[1]}${recent[2]}` };
  }
  const dateMatch = value.match(/(20\d{2})[-年\/]\s*(\d{1,2})[-月\/]\s*(\d{1,2})日?/);
  if (dateMatch) {
    const start = Date.UTC(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3])) - SHANGHAI_OFFSET_MS;
    if (Number.isFinite(start)) return { start: new Date(start).toISOString(), end: new Date(start + 24 * 3600_000).toISOString(), label: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` };
  }
  return null;
}

function filterHistoryRecordsByTime(records, range) {
  if (!range) return records;
  const start = Date.parse(range.start);
  const end = Date.parse(range.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return records;
  return records.filter((record) => {
    const recordStart = Date.parse(record.started_at || "");
    const recordEnd = Date.parse(record.ended_at || "") || recordStart;
    return Number.isFinite(recordStart) && recordEnd >= start && recordStart < end;
  });
}

export function searchHistoryRecords(question, records = []) {
  return {
    mode: "semantic-metadata-v1",
    query_groups: [...semanticGroupsForText(question)],
    records: records
      .map((record, index) => {
        const match = semanticMatchScore(question, record);
        const startedAt = Date.parse(record.started_at || "");
        return {
          record,
          score: match.score,
          startedAt: Number.isFinite(startedAt) ? startedAt : 0,
          index,
        };
      })
      .sort((left, right) => right.score - left.score || right.startedAt - left.startedAt || left.index - right.index)
      .map(({ record }) => record),
  };
}

// Compatibility name used by the existing server tests and callers. The
// implementation is now semantic metadata retrieval rather than substring
// ranking alone.
export function rankHistoryRecords(question, records = []) {
  return searchHistoryRecords(question, records).records;
}

function startOfShanghaiWeekMs(milliseconds) {
  const parts = shanghaiDateParts(milliseconds);
  const day = parts.weekday;
  const daysSinceMonday = (day + 6) % 7;
  return Date.UTC(parts.year, parts.month, parts.day - daysSinceMonday) - SHANGHAI_OFFSET_MS;
}

function rollupBucket(record, scope) {
  const startMs = Date.parse(record.started_at);
  const parts = shanghaiDateParts(startMs);
  if (scope === "hourly") return Date.UTC(parts.year, parts.month, parts.day, parts.hour) - SHANGHAI_OFFSET_MS;
  if (scope === "daily") return Date.UTC(parts.year, parts.month, parts.day) - SHANGHAI_OFFSET_MS;
  if (scope === "weekly" || scope === "team_weekly") return startOfShanghaiWeekMs(startMs);
  return null;
}

function buildRollupRecords(leafRecords, scope = "window") {
  const sorted = [...leafRecords].sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
  const groups = [];
  if (scope === "window") {
    let current = null;
    const flush = () => {
      if (current && current.records.length > 1) groups.push(current);
      current = null;
    };
    for (const record of sorted) {
      const startMs = Date.parse(record.started_at);
      const endMs = Date.parse(record.ended_at);
      const gapSeconds = current ? Math.max(0, (startMs - current.endMs) / 1000) : Infinity;
      const day = shanghaiDateKey(startMs);
      if (!current || current.deviceId !== record.device_id || current.day !== day || gapSeconds > 30 * 60) {
        flush();
        current = { deviceId: record.device_id, employeeId: record.user_id, startMs, endMs, records: [record], day };
      } else {
        current.endMs = Math.max(current.endMs, endMs);
        current.records.push(record);
      }
    }
    flush();
  } else if (scope === "six_hour") {
    // Codex-style long memories are rolling windows over one contiguous
    // work arc, rather than fixed clock buckets. Keep a partial window so a
    // currently active work arc can appear before six hours are complete.
    let current = null;
    const flush = () => {
      if (current && current.records.length > 1) groups.push(current);
      current = null;
    };
    for (const record of sorted) {
      const startMs = Date.parse(record.started_at);
      const endMs = Date.parse(record.ended_at);
      const gapSeconds = current ? Math.max(0, (startMs - current.endMs) / 1000) : Infinity;
      const spanSeconds = current ? Math.max(0, (startMs - current.startMs) / 1000) : Infinity;
      const day = shanghaiDateKey(startMs);
      if (!current || current.deviceId !== record.device_id || current.day !== day || gapSeconds > 30 * 60 || spanSeconds >= 6 * 60 * 60) {
        flush();
        current = { deviceId: record.device_id, employeeId: record.user_id, startMs, endMs, records: [record], day };
      } else {
        current.endMs = Math.max(current.endMs, endMs);
        current.records.push(record);
      }
    }
    flush();
  } else {
    const grouped = new Map();
    for (const record of sorted) {
      const bucket = rollupBucket(record, scope);
      const groupingKey = scope === "team_weekly" ? (record.employee_team || "未分组") : record.device_id;
      const key = `${groupingKey}:${bucket}`;
      const group = grouped.get(key) || {
        deviceId: record.device_id,
        employeeId: record.user_id,
        team: record.employee_team || "未分组",
        startMs: bucket,
        endMs: bucket,
        records: [],
      };
      group.startMs = Math.min(group.startMs, Date.parse(record.started_at));
      group.endMs = Math.max(group.endMs, Date.parse(record.ended_at));
      group.records.push(record);
      grouped.set(key, group);
    }
    for (const group of grouped.values()) groups.push(group);
  }

  return groups.map((group) => {
    const records = group.records;
    const first = records[0];
    const applications = [...new Set(records.flatMap((record) => record.applications || []))];
    const applicationNames = [...new Set(records.flatMap((record) => record.application_names || []))];
    const contextKinds = [...new Set(records.flatMap((record) => record.context_kinds || []))];
    const contextLabels = [...new Set(records.flatMap((record) => record.context_labels || []))];
    const webDomains = [...new Set(records.flatMap((record) => record.web_domains || []))];
    const sourceKinds = [...new Set(records.flatMap((record) => record.source_kinds || []))];
    const sourceTypes = [...new Set(sourceKinds.map(sourceKindLabel))];
    const sourceEventIds = [...new Set(records.flatMap((record) => record.source_event_ids || []))];
    const timeline = records.flatMap((record) => record.timeline || []).sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
    const activitySequence = records.flatMap((record) => record.activity_sequence || []).sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
    const summaryActivitySequence = records.flatMap((record) => record.summary_activity_sequence || record.activity_sequence || []).sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
    const resources = [...new Map(records.flatMap((record) => record.resources || []).map((item) => [item.name, item])).values()];
    const resourceTypes = [...new Set(records.flatMap((record) => record.resource_types || []).filter(Boolean))];
    const citations = [...new Map(records.flatMap((record) => record.citations || []).map((item) => [`${item.label}:${item.detail}`, item])).values()];
    const periodStartMs = Math.min(...records.map((record) => Date.parse(record.started_at)));
    const periodEndMs = Math.max(...records.map((record) => Date.parse(record.ended_at)));
    const durationSeconds = records.reduce((sum, record) => sum + Math.max(0, Number(record.duration_seconds) || 0), 0);
    const readableDuration = formatDuration(durationSeconds);
    const scopeLabel = scope === "six_hour" ? "6 小时汇总" : scope === "hourly" ? "小时汇总" : scope === "daily" ? "每日汇总" : scope === "weekly" ? "每周汇总" : scope === "team_weekly" ? "团队周汇总" : "连续工作汇总";
    const isTeamRollup = scope === "team_weekly";
    const subjectName = isTeamRollup ? `${first.employee_team || "未分组"}团队` : first.employee_name;
    const contextTitle = workThemeTitle(subjectName, {
      contextKinds,
      applicationNames,
      contextLabels,
      resourceTypes,
    }).split(" · ").slice(1).join(" · ") || "连续工作活动";
    return {
      id: `rollup_${scope}_${hash(`${group.team || first.employee_team || group.deviceId}:${group.startMs}`).slice(0, 24)}`,
      user_id: first.user_id,
      employee_name: subjectName,
      employee_team: first.employee_team,
      device_id: first.device_id,
      hostname: first.hostname,
      record_type: "rollup",
      rollup_scope: scope,
      title: `${subjectName} · ${contextTitle}`,
      description: `${subjectName} 在 ${applicationNames.slice(0, 6).join("、") || "多个工作上下文"} 中活动 ${readableDuration}，由 ${records.length} 条 Leaf Summary 形成${scopeLabel}。`,
      applications,
      application_names: applicationNames,
      context_kinds: contextKinds,
      context_switches: records.reduce((sum, record) => sum + Number(record.context_switches || 0), 0) + Math.max(0, records.length - 1),
      context_labels: contextLabels,
      web_domains: webDomains,
      source_kinds: sourceKinds,
      source_types: sourceTypes,
      activity_sequence: activitySequence,
      summary_activity_sequence: summaryActivitySequence,
      activity_fragment_count: records.reduce((sum, record) => sum + Number(record.activity_fragment_count || record.activity_sequence?.length || 0), 0),
      summary_activity_count: summaryActivitySequence.length,
      duration_seconds: durationSeconds,
      started_at: new Date(periodStartMs).toISOString(),
      ended_at: new Date(periodEndMs).toISOString(),
      summary: `${subjectName} 在 ${contextKinds.join("、") || "工作"}上下文中活动 ${readableDuration}，${scopeLabel}包含 ${records.length} 条 Leaf Summary 和 ${timeline.length} 个活动片段。该汇总只基于活动元数据生成。`,
      prior_context: isTeamRollup
        ? "该团队周汇总由同一团队可见范围内的 Leaf Summary 聚合而成；来源仍是 Windows Agent 活动元数据，网站只保留域名。"
        : "该 Rollup Summary 由同一设备在相邻时间窗口中的 Leaf Summary 聚合而成；来源仍是 Windows Agent 活动元数据，网站只保留域名。",
      important_context: "汇总记录用于帮助理解连续工作上下文，不代表工作效率或绩效结论；系统不保存原始窗口标题、完整 URL、页面正文或聊天正文。",
      non_obvious: "汇总记录用于帮助理解连续工作上下文，不代表工作效率或绩效结论；系统不保存原始窗口标题、完整 URL、页面正文或聊天正文。",
      timeline,
      resources,
      resource_types: resourceTypes,
      citations,
      source_event_ids: sourceEventIds,
      source_record_ids: records.map((record) => record.id),
      confidence: Math.min(...records.map((record) => record.confidence ?? 1)),
    };
  });
}

async function materializeMemoryRecords(db, baseRecords, ai, { deferModel = false } = {}) {
  const select = db.prepare("SELECT * FROM memory_summaries WHERE id = ?");
  const insert = db.prepare(`
    INSERT INTO memory_summaries
      (id, record_type, employee_id, device_id, started_at, ended_at, duration_seconds,
       source_hash, period_start, period_end, source_event_ids, source_event_ids_json,
       source_record_ids_json, title, summary, prior_context, important_context, citations,
       citations_json, payload_json, model_name, prompt_version, status, generated_at, updated_at, rollup_scope)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      record_type = excluded.record_type,
      employee_id = excluded.employee_id,
      device_id = excluded.device_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      duration_seconds = excluded.duration_seconds,
      source_hash = excluded.source_hash,
      period_start = excluded.period_start,
      period_end = excluded.period_end,
      source_event_ids = excluded.source_event_ids,
      source_event_ids_json = excluded.source_event_ids_json,
      source_record_ids_json = excluded.source_record_ids_json,
      title = excluded.title,
      summary = excluded.summary,
      prior_context = excluded.prior_context,
      important_context = excluded.important_context,
      citations = excluded.citations,
      citations_json = excluded.citations_json,
      payload_json = excluded.payload_json,
      model_name = excluded.model_name,
      prompt_version = excluded.prompt_version,
      status = excluded.status,
      updated_at = excluded.updated_at,
      rollup_scope = excluded.rollup_scope
  `);

  const records = [];
  const selectJob = db.prepare("SELECT status, attempts FROM memory_generation_jobs WHERE summary_id = ?");
  const enqueueJob = db.prepare(`
    INSERT INTO memory_generation_jobs (id, summary_id, attempts, next_attempt_at, status, created_at, updated_at)
    VALUES (?, ?, 0, ?, 'queued', ?, ?)
    ON CONFLICT(summary_id) DO UPDATE SET
      status = CASE WHEN memory_generation_jobs.status IN ('succeeded', 'failed') THEN 'queued' ELSE memory_generation_jobs.status END,
      next_attempt_at = excluded.next_attempt_at,
      updated_at = excluded.updated_at
  `);
  const cancelJob = db.prepare("UPDATE memory_generation_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE summary_id = ? AND status IN ('queued', 'running', 'retrying')");
  const updateCancelledSummary = db.prepare("UPDATE memory_summaries SET payload_json = ?, model_name = ?, status = ?, updated_at = ? WHERE id = ?");
  for (const baseRecord of baseRecords) {
    const legacySourceHash = hash(JSON.stringify({
      source_event_ids: baseRecord.source_event_ids,
      started_at: baseRecord.started_at,
      ended_at: baseRecord.ended_at,
      duration_seconds: baseRecord.duration_seconds,
      context_labels: baseRecord.context_labels,
      web_domains: baseRecord.web_domains,
      source_record_ids: baseRecord.source_record_ids,
      prior_context: baseRecord.prior_context,
    }));
    const sourceHash = hash(JSON.stringify({
      source_event_ids: baseRecord.source_event_ids,
      started_at: baseRecord.started_at,
      ended_at: baseRecord.ended_at,
      duration_seconds: baseRecord.duration_seconds,
      context_labels: baseRecord.context_labels,
      web_domains: baseRecord.web_domains,
      source_kinds: baseRecord.source_kinds,
      activity_sequence: baseRecord.activity_sequence,
      application_names: baseRecord.application_names,
      resources: baseRecord.resources,
      source_record_ids: baseRecord.source_record_ids,
      prior_context: baseRecord.prior_context,
    }));
    const existing = select.get(baseRecord.id);
    let existingPayload = null;
    if (existing) {
      try {
        existingPayload = JSON.parse(existing.payload_json);
      } catch {
        // Rebuild a malformed persisted payload below.
      }
    }
    const metadataBackfill = Boolean(
      existing
      && existingPayload
      && (
        // Older payloads were written before sequence/source/resource
        // metadata became part of the public Memory Summary contract. Repair
        // those payloads even when their legacy hash happens to match.
        (existing.source_hash === legacySourceHash && (
          JSON.stringify(existingPayload.application_names || []) !== JSON.stringify(baseRecord.application_names || [])
          || JSON.stringify(existingPayload.resources || []) !== JSON.stringify(baseRecord.resources || [])
        ))
        || !Array.isArray(existingPayload.activity_sequence)
        || !Array.isArray(existingPayload.summary_activity_sequence)
        || !Array.isArray(existingPayload.source_kinds)
        || !Array.isArray(existingPayload.source_types)
        || !Array.isArray(existingPayload.resource_types)
        || (existingPayload.resources || []).some((resource) => resource && !resource.source_type)
        || isBareDomainHistoryTitle(existingPayload.title, baseRecord.employee_name)
      )
    );
    const job = existing ? selectJob.get(baseRecord.id) : null;
    const pendingJob = job && ["queued", "running", "retrying"].includes(job.status);
    const exhaustedJob = job && job.status === "failed" && Number(job.attempts || 0) >= 5;
    const activeRecord = isMemoryRecordActive(baseRecord);
    const eligibleForAi = ai.mode === "model" && isEligibleForAiSummary(baseRecord);
    const waitingForWindow = ai.mode === "model" && activeRecord;
    if (ai.mode === "model" && !eligibleForAi && pendingJob) {
      const cancelledStatus = waitingForWindow ? "window_pending" : "fallback";
      cancelJob.run("cancelled: 仅闭合的十分钟 Leaf 窗口进入 AI 队列", isoNow(), baseRecord.id);
      if (existingPayload) {
        const cancelledPayload = {
          ...existingPayload,
          summary_status: cancelledStatus,
          summary_model: "rules-v1",
          generated_at: existingPayload.generated_at || existing.generated_at || isoNow(),
        };
        updateCancelledSummary.run(JSON.stringify(cancelledPayload), "rules-v1", cancelledStatus, isoNow(), baseRecord.id);
        existingPayload = cancelledPayload;
      }
    }
    const shouldRegenerateForModel = existing
      && !metadataBackfill
      && ai.mode === "model"
      && eligibleForAi
      && !exhaustedJob
      && (existing.status === "fallback" || existing.model_name !== ai.model)
      && !pendingJob;
    if (existing && existing.source_hash === sourceHash && !metadataBackfill && !shouldRegenerateForModel) {
      if (existingPayload) {
        records.push(existingPayload);
        continue;
      }
    }

    const shouldDeferModel = deferModel && eligibleForAi;
    const generated = metadataBackfill
      ? {
          title: isBareDomainHistoryTitle(existingPayload.title, baseRecord.employee_name)
            ? baseRecord.title
            : existingPayload.title,
          description: summaryNeedsMetadataEvidence(existingPayload.description, baseRecord)
            ? baseRecord.description
            : existingPayload.description,
          summary: summaryNeedsMetadataEvidence(existingPayload.summary, baseRecord)
            ? baseRecord.summary
            : existingPayload.summary,
          prior_context: existingPayload.prior_context,
          important_context: existingPayload.important_context || existingPayload.non_obvious,
          non_obvious: existingPayload.non_obvious || existingPayload.important_context,
          confidence: existingPayload.confidence,
          generated_at: existingPayload.generated_at || existing.generated_at,
          status: pendingJob
            ? (waitingForWindow ? "window_pending" : "fallback")
            : existing.status || existingPayload.summary_status || "fallback",
          model_name: pendingJob ? "rules-v1" : existing.model_name || existingPayload.summary_model || "rules-v1",
        }
      : shouldDeferModel
      ? {
          title: baseRecord.title,
          description: baseRecord.description,
          summary: baseRecord.summary,
          prior_context: baseRecord.prior_context,
          important_context: baseRecord.important_context || baseRecord.non_obvious,
          non_obvious: baseRecord.non_obvious || baseRecord.important_context,
          confidence: baseRecord.confidence,
          status: "queued",
          model_name: ai.model,
        }
      : ai.mode === "model" && !eligibleForAi
      ? {
          title: baseRecord.title,
          description: baseRecord.description,
          summary: baseRecord.summary,
          prior_context: baseRecord.prior_context,
          important_context: baseRecord.important_context || baseRecord.non_obvious,
          non_obvious: baseRecord.non_obvious || baseRecord.important_context,
          confidence: baseRecord.confidence,
          status: waitingForWindow ? "window_pending" : "fallback",
          model_name: "rules-v1",
          generated_at: existing?.generated_at || isoNow(),
        }
      : await ai.summarizeMemory(aiInputForRecord(baseRecord));
    const record = {
      ...baseRecord,
      title: generated.title || baseRecord.title,
      description: generated.description || baseRecord.description,
      summary: generated.summary || baseRecord.summary,
      prior_context: generated.prior_context || baseRecord.prior_context,
      important_context: generated.important_context || generated.non_obvious || baseRecord.important_context || baseRecord.non_obvious,
      non_obvious: generated.non_obvious || generated.important_context || baseRecord.non_obvious || baseRecord.important_context,
      confidence: generated.confidence ?? baseRecord.confidence,
      summary_status: generated.status || "fallback",
      summary_model: generated.model_name || ai.model,
      prompt_version: ai.promptVersion || "memory-v1",
      generated_at: generated.generated_at || (generated.status === "generated" ? isoNow() : existing?.generated_at || isoNow()),
    };
    const now = isoNow();
    insert.run(
      record.id,
      record.record_type,
      record.user_id,
      record.device_id,
      record.started_at,
      record.ended_at,
      record.duration_seconds,
      sourceHash,
      record.started_at,
      record.ended_at,
      JSON.stringify(record.source_event_ids || []),
      JSON.stringify(record.source_event_ids || []),
      JSON.stringify(record.source_record_ids || []),
      record.title,
      record.summary,
      record.prior_context,
      record.important_context || record.non_obvious,
      JSON.stringify(record.citations || []),
      JSON.stringify(record.citations || []),
      JSON.stringify(record),
      record.summary_model,
      ai.promptVersion || "memory-v1",
      record.summary_status,
      record.generated_at,
      now,
      record.rollup_scope || "leaf",
    );
    if (ai.mode === "model" && eligibleForAi && (shouldDeferModel || generated.retryable) && (!exhaustedJob || existing?.model_name !== ai.model)) {
      enqueueJob.run(newId("memory_job"), record.id, isoNow(), now, now);
    }
    records.push(record);
  }
  return records;
}

export async function processMemoryGenerationJobs(db, ai, logger = console, { limit = 5 } = {}) {
  if (ai.mode !== "model") return { processed: 0, succeeded: 0, retried: 0, failed: 0, cancelled: 0 };
  const now = isoNow();
  const jobs = db.prepare(`
    SELECT id, summary_id, attempts
    FROM memory_generation_jobs
    WHERE status IN ('queued', 'retrying') AND next_attempt_at <= ?
    ORDER BY next_attempt_at ASC
    LIMIT ?
  `).all(now, Math.min(Math.max(Number(limit) || 5, 1), 20));
  const markRunning = db.prepare("UPDATE memory_generation_jobs SET status = 'running', updated_at = ? WHERE id = ?");
  const getSummary = db.prepare("SELECT * FROM memory_summaries WHERE id = ?");
  const updateSummary = db.prepare(`
    UPDATE memory_summaries
    SET period_start = ?, period_end = ?, source_event_ids = ?, source_event_ids_json = ?,
        title = ?, summary = ?, prior_context = ?, important_context = ?, citations = ?, citations_json = ?,
        payload_json = ?, model_name = ?, status = ?, generated_at = ?, updated_at = ?
    WHERE id = ?
  `);
  const updateSummaryStatus = db.prepare(`
    UPDATE memory_summaries
    SET payload_json = ?, model_name = ?, status = ?, updated_at = ?
    WHERE id = ?
  `);
  const markSucceeded = db.prepare("UPDATE memory_generation_jobs SET status = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ?");
  const markRetry = db.prepare("UPDATE memory_generation_jobs SET attempts = ?, next_attempt_at = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?");
  const markCancelled = db.prepare("UPDATE memory_generation_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?");
  let succeeded = 0;
  let retried = 0;
  let failed = 0;
  let cancelled = 0;

  for (const job of jobs) {
    markRunning.run(now, job.id);
    let storedPayload = null;
    try {
      const stored = getSummary.get(job.summary_id);
      if (!stored) throw new Error("summary not found");
      const baseRecord = JSON.parse(stored.payload_json);
      storedPayload = baseRecord;
      if (!isEligibleForAiSummary(baseRecord)) {
        markCancelled.run("cancelled: 活动窗口尚未闭合或未达到十分钟", isoNow(), job.id);
        cancelled += 1;
        continue;
      }
      const generated = await ai.summarizeMemory(aiInputForRecord(baseRecord));
      if (generated.status !== "generated") throw new Error("model generation returned fallback");
      const record = {
        ...baseRecord,
        title: generated.title || baseRecord.title,
        description: generated.description || baseRecord.description,
        summary: generated.summary || baseRecord.summary,
        prior_context: generated.prior_context || baseRecord.prior_context,
        important_context: generated.important_context || generated.non_obvious || baseRecord.important_context || baseRecord.non_obvious,
        non_obvious: generated.non_obvious || generated.important_context || baseRecord.non_obvious || baseRecord.important_context,
        confidence: generated.confidence ?? baseRecord.confidence,
        summary_status: "generated",
        summary_model: generated.model_name || ai.model,
        prompt_version: ai.promptVersion || "memory-v1",
        generated_at: isoNow(),
      };
      updateSummary.run(
        record.started_at,
        record.ended_at,
        JSON.stringify(record.source_event_ids || []),
        JSON.stringify(record.source_event_ids || []),
        record.title,
        record.summary,
        record.prior_context,
        record.important_context || record.non_obvious,
        JSON.stringify(record.citations || []),
        JSON.stringify(record.citations || []),
        JSON.stringify(record),
        record.summary_model,
        "generated",
        record.generated_at,
        isoNow(),
        job.summary_id,
      );
      markSucceeded.run(isoNow(), job.id);
      succeeded += 1;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const exhausted = attempts >= 5;
      const nextAttempt = new Date(Date.now() + Math.min(60 * 60, 2 ** attempts * 30) * 1000).toISOString();
      const safeMessage = String(error.message || "generation failed").slice(0, 300);
      markRetry.run(attempts, nextAttempt, exhausted ? "failed" : "retrying", safeMessage, isoNow(), job.id);
      if (exhausted) {
        if (storedPayload) {
          const fallbackRecord = {
            ...storedPayload,
            summary_status: "fallback",
            summary_model: "rules-v1",
          };
          updateSummaryStatus.run(JSON.stringify(fallbackRecord), "rules-v1", "fallback", isoNow(), job.summary_id);
        }
        failed += 1;
      } else retried += 1;
      logger.warn?.(`Memory Summary generation ${exhausted ? "failed" : "will retry"}: ${safeMessage}`);
    }
  }
  return { processed: jobs.length, succeeded, retried, failed, cancelled };
}

async function getMemoryRecords(db, { deviceId = null, limit = 200, ai, principal = null, team = null, deferModel = false }) {
  const requestedLimit = Math.min(Math.max(Number(limit) || 200, 1), 2000);
  // Keep fresh materialization bounded: querying older history should reuse
  // persisted summaries instead of issuing a model request for every old
  // event window on each question.
  const freshLimit = Math.min(requestedLimit, 200);
  const leafRecords = await materializeMemoryRecords(db, buildHistoryRecords(db, { deviceId, limit: freshLimit, principal, team }), ai, { deferModel });
  const rollupRecords = [];
  for (const scope of ["window", "six_hour", "hourly", "daily", "weekly", "team_weekly"]) {
    rollupRecords.push(...await materializeMemoryRecords(db, buildRollupRecords(leafRecords, scope), ai, { deferModel }));
  }

  const persistedRecords = readPersistedMemoryRecords(db, {
    deviceId,
    principal,
    team,
    limit: requestedLimit,
  });
  const freshLeafIds = new Set(leafRecords.map((record) => record.id));
  const freshSourceEventIds = new Set(leafRecords.flatMap((record) => record.source_event_ids || []));
  const compatiblePersistedRecords = persistedRecords.filter((record) => {
    if (record.record_type !== "leaf" || freshLeafIds.has(record.id)) return true;
    // A change in event segmentation can leave an older persisted Leaf Summary
    // whose source events are now represented by a fresh record. Do not show
    // both versions in History; the freshly materialized record is canonical.
    return !(record.source_event_ids || []).some((eventId) => freshSourceEventIds.has(eventId));
  });
  // The freshly materialized records win over the stored payload so an
  // active session's growing duration and current AI status are visible
  // immediately, while older summaries remain searchable across history.
  const merged = new Map(compatiblePersistedRecords.map((record) => [record.id, record]));
  for (const record of [...leafRecords, ...rollupRecords]) merged.set(record.id, record);

  return [...merged.values()]
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))
    .slice(0, requestedLimit);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readPersistedMemoryRecords(db, { deviceId = null, principal = null, team = null, limit = 2000 } = {}) {
  const scope = scopePredicate(principal, { deviceAlias: "d", employeeAlias: "e" });
  const conditions = [scope.sql];
  const params = [...scope.params];
  // Do not surface summaries whose period starts materially in the future.
  // This protects the timeline from legacy summaries created by invalid
  // full-day idle checkpoints without rewriting the stored audit data.
  conditions.push("julianday(ms.started_at) <= julianday(?)");
  params.push(new Date(Date.now() + 60_000).toISOString());
  if (deviceId) {
    conditions.push("ms.device_id = ?");
    params.push(deviceId);
  }
  if (team) {
    conditions.push("e.team = ?");
    params.push(team);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 2000, 1), 2000);
  const rows = db.prepare(`
    SELECT ms.id, ms.payload_json, ms.status, ms.model_name, ms.prompt_version,
           ms.generated_at, ms.updated_at, ms.source_event_ids_json,
           ms.source_record_ids_json, ms.citations_json
    FROM memory_summaries ms
    JOIN devices d ON d.id = ms.device_id
    JOIN employees e ON e.id = ms.employee_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY ms.started_at DESC
    LIMIT ${safeLimit}
  `).all(...params);

  return rows.map((row) => {
    try {
      const payload = JSON.parse(row.payload_json);
      if (!payload || typeof payload !== "object" || !payload.id) return null;
      return {
        ...payload,
        source_event_ids: parseJsonArray(payload.source_event_ids || row.source_event_ids_json),
        source_record_ids: parseJsonArray(payload.source_record_ids || row.source_record_ids_json),
        citations: Array.isArray(payload.citations) ? payload.citations : parseJsonArray(row.citations_json),
        summary_status: payload.summary_status || row.status,
        summary_model: payload.summary_model || row.model_name,
        prompt_version: payload.prompt_version || row.prompt_version,
        generated_at: payload.generated_at || row.generated_at,
        updated_at: payload.updated_at || row.updated_at,
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function createRequestHandler({ db, adminToken, sessionSecret = adminToken, ai, logger = console }) {
  return async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const method = request.method || "GET";

    try {
      if (method === "OPTIONS") {
        response.writeHead(204, corsHeaders());
        return response.end();
      }
      if (method === "GET" && url.pathname === "/health") {
        return sendJson(response, 200, { ok: true, service: "ai-jinyiwei-agent-server", now: isoNow() });
      }

      if (method === "POST" && url.pathname === "/api/admin/sessions") {
        if (request.headers["x-admin-token"] !== adminToken) return sendError(response, 401, "bootstrap admin authentication required", "unauthorized");
        const body = await readJson(request);
        const role = ["admin", "manager", "employee"].includes(body.role) ? body.role : null;
        if (!role) return sendError(response, 400, "role must be admin, manager, or employee", "invalid_role");
        let employeeId = null;
        let team = null;
        let actor = "admin";
        if (role === "employee") {
          const employee = db.prepare("SELECT id, name, team FROM employees WHERE id = ?").get(body.employee_id);
          if (!employee) return sendError(response, 404, "employee not found", "employee_not_found");
          employeeId = employee.id;
          team = employee.team;
          actor = employee.name;
        } else if (role === "manager") {
          team = typeof body.team === "string" && body.team.trim() ? body.team.trim().slice(0, 120) : "研发与产品中心";
          actor = `manager:${team}`;
        }
        const ttl = Math.min(Math.max(Number(body.expires_in_seconds) || 8 * 3600, 300), 24 * 3600);
        const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        const token = signAdminSession({ role, actor, employee_id: employeeId, team, exp: Date.parse(expiresAt) }, sessionSecret);
        recordAudit(db, "admin_session_created", "admin", actor, `role=${role}`);
        return sendJson(response, 201, { token, expires_at: expiresAt, principal: { role, actor, employee_id: employeeId, team } });
      }

      if (method === "POST" && url.pathname === "/api/admin/registration-codes") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const body = await readJson(request);
        const employee = db.prepare("SELECT id, name, team FROM employees WHERE id = ?").get(body.employee_id);
        if (!employee) return sendError(response, 404, "employee not found", "employee_not_found");
        const ttl = Math.min(Math.max(Number(body.expires_in_seconds) || 3600, 60), 7 * 24 * 3600);
        const code = newRegistrationCode();
        const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
        db.prepare(
          "INSERT INTO registration_codes (id, code_hash, employee_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(newId("code"), hash(code), employee.id, expiresAt, isoNow());
        recordAudit(db, "registration_code_created", "admin", employee.id, "one-time registration code created");
        return sendJson(response, 201, { code, employee, expires_at: expiresAt });
      }

      if (method === "GET" && url.pathname === "/api/admin/registration-codes") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const scope = scopePredicate(principal, { deviceAlias: "d", employeeAlias: "e" });
        const codes = db.prepare(`
          SELECT rc.id, rc.employee_id, e.name AS employee_name, e.team AS employee_team,
            rc.expires_at, rc.used_at, rc.created_at
          FROM registration_codes rc JOIN employees e ON e.id = rc.employee_id
          WHERE ${scope.sql.replaceAll("d.", "rc.")}
          ORDER BY rc.created_at DESC LIMIT 100
        `).all(...scope.params);
        return sendJson(response, 200, { codes });
      }

      if (method === "GET" && url.pathname === "/api/admin/devices") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        refreshStaleDeviceStatuses(db);
        const scope = scopePredicate(principal);
        const devices = db.prepare(`
          SELECT d.id, d.employee_id, e.name AS employee_name, e.team AS employee_team,
            d.hostname, d.os_version, d.agent_version, d.status, d.last_heartbeat_at,
            d.queued_events, d.created_at, d.updated_at
          FROM devices d JOIN employees e ON e.id = d.employee_id
          WHERE ${scope.sql}
          ORDER BY d.updated_at DESC
        `).all(...scope.params);
        return sendJson(response, 200, { devices });
      }

      const deviceMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)$/);
      if (deviceMatch && method === "GET") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        refreshStaleDeviceStatuses(db);
        const deviceId = decodeURIComponent(deviceMatch[1]);
        const device = db.prepare(`
          SELECT d.*, e.name AS employee_name, e.team AS employee_team
          FROM devices d JOIN employees e ON e.id = d.employee_id
          WHERE d.id = ?
        `).get(deviceId);
        if (!device) return sendError(response, 404, "device not found", "device_not_found");
        const scope = scopePredicate(principal);
        const inScope = db.prepare(`SELECT 1 FROM devices d JOIN employees e ON e.id = d.employee_id WHERE d.id = ? AND ${scope.sql}`).get(deviceId, ...scope.params);
        if (!inScope) return sendError(response, 403, "device is outside your data scope", "forbidden");
        const events = db.prepare(`
          SELECT event_id, occurred_at, type, app_name, process_name, source_kind, context_label, web_domain, duration_seconds, received_at
          FROM events WHERE device_id = ? ORDER BY occurred_at DESC LIMIT 50
        `).all(deviceId);
        return sendJson(response, 200, { device, events });
      }

      const deviceActionMatch = url.pathname.match(/^\/api\/admin\/devices\/([^/]+)\/(disable|enable)$/);
      if (deviceActionMatch && method === "POST") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const deviceId = decodeURIComponent(deviceActionMatch[1]);
        const action = deviceActionMatch[2];
        const device = db.prepare("SELECT id, disabled_at FROM devices WHERE id = ?").get(deviceId);
        if (!device) return sendError(response, 404, "device not found", "device_not_found");
        const now = isoNow();
        if (action === "disable") {
          db.prepare("UPDATE devices SET status = 'disabled', disabled_at = ?, updated_at = ? WHERE id = ?").run(now, now, deviceId);
          db.prepare("UPDATE browser_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL").run(now, deviceId);
          recordAudit(db, "device_disabled", principal.actor || "admin", deviceId, "device disabled by administrator");
        } else {
          db.prepare("UPDATE devices SET status = 'offline', disabled_at = NULL, updated_at = ? WHERE id = ?").run(now, deviceId);
          recordAudit(db, "device_enabled", principal.actor || "admin", deviceId, "device enabled by administrator");
        }
        const updated = db.prepare("SELECT id, status, disabled_at, updated_at FROM devices WHERE id = ?").get(deviceId);
        return sendJson(response, 200, { device: updated });
      }

      if (method === "GET" && url.pathname === "/api/admin/employees") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const scope = scopePredicate(principal, { deviceAlias: "d", employeeAlias: "e" });
        const employees = db.prepare(`
          SELECT e.id, e.name, e.team, e.created_at,
            COUNT(DISTINCT d.id) AS device_count,
            COUNT(DISTINCT CASE WHEN d.status = 'online' THEN d.id END) AS online_device_count,
            MAX(d.last_heartbeat_at) AS last_heartbeat_at,
            MIN(d.hostname) AS hostname
          FROM employees e
          LEFT JOIN devices d ON d.employee_id = e.id AND d.disabled_at IS NULL
          WHERE ${scope.sql}
          GROUP BY e.id, e.name, e.team, e.created_at
          ORDER BY e.team ASC, e.name ASC
        `).all(...scope.params);
        return sendJson(response, 200, { employees });
      }

      if (method === "GET" && url.pathname === "/api/admin/teams") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const scope = scopePredicate(principal, { deviceAlias: "d", employeeAlias: "e" });
        const teams = db.prepare(`
          SELECT e.team AS name,
            COUNT(DISTINCT e.id) AS member_count,
            COUNT(DISTINCT d.id) AS device_count,
            COUNT(DISTINCT CASE WHEN d.status = 'online' THEN e.id END) AS online_member_count,
            MIN(e.name) AS lead_name
          FROM employees e
          LEFT JOIN devices d ON d.employee_id = e.id AND d.disabled_at IS NULL
          WHERE ${scope.sql}
          GROUP BY e.team
          ORDER BY e.team ASC
        `).all(...scope.params).map((team) => ({
          ...team,
          id: `team_${hash(team.name).slice(0, 16)}`,
        }));
        return sendJson(response, 200, { teams });
      }

      if (method === "GET" && url.pathname === "/api/admin/policy") {
        if (!requireAdmin(request, adminToken, sessionSecret)) return sendError(response, 401, "admin authentication required", "unauthorized");
        return sendJson(response, 200, { policy: getPolicy(db) });
      }

      if (method === "PUT" && url.pathname === "/api/admin/policy") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const body = await readJson(request);
        const current = getPolicy(db);
        const nextPolicy = {
          work_hours_start: body?.work_hours_start,
          work_hours_end: body?.work_hours_end,
          activity_checkpoint_seconds: body?.activity_checkpoint_seconds ?? current.activity_checkpoint_seconds ?? 15,
          collect_app_activity: body?.collect_app_activity ?? current.collect_app_activity ?? true,
          collect_idle_status: body?.collect_idle_status ?? current.collect_idle_status ?? true,
          collect_web_domains: body?.collect_web_domains ?? current.collect_web_domains ?? true,
          collect_file_metadata: body?.collect_file_metadata ?? current.collect_file_metadata ?? true,
          excluded_processes: body?.excluded_processes ?? current.excluded_processes ?? [],
          excluded_domains: body?.excluded_domains ?? current.excluded_domains ?? [],
        };
        const validationError = validatePolicyUpdate(nextPolicy);
        if (validationError) return sendError(response, 400, validationError, "invalid_policy");
        const changed = [
          ["work_hours_start", nextPolicy.work_hours_start],
          ["work_hours_end", nextPolicy.work_hours_end],
          ["activity_checkpoint_seconds", String(nextPolicy.activity_checkpoint_seconds)],
          ["collect_app_activity", String(nextPolicy.collect_app_activity)],
          ["collect_idle_status", String(nextPolicy.collect_idle_status)],
          ["collect_web_domains", String(nextPolicy.collect_web_domains)],
          ["collect_file_metadata", String(nextPolicy.collect_file_metadata)],
          ["excluded_processes", JSON.stringify(nextPolicy.excluded_processes.map((item) => item.trim().toLowerCase()))],
          ["excluded_domains", JSON.stringify(nextPolicy.excluded_domains.map((item) => item.trim().toLowerCase()))],
        ].filter(([key, value]) => {
          const currentValue = ["excluded_processes", "excluded_domains"].includes(key)
            ? JSON.stringify(current[key] || [])
            : String(current[key] ?? "");
          return currentValue !== String(value);
        });
        if (changed.length > 0) {
          for (const [key, value] of changed) {
            db.prepare("UPDATE policies SET value = ? WHERE key = ?").run(value, key);
          }
          const version = Number(current.version || 0) + 1;
          db.prepare("UPDATE policies SET value = ? WHERE key = ?").run(String(version), "version");
          recordAudit(
            db,
            "policy_changed",
            "admin",
            "agent_policy",
            `work hours=${nextPolicy.work_hours_start}-${nextPolicy.work_hours_end}; activity checkpoint=${nextPolicy.activity_checkpoint_seconds}s; excluded processes=${nextPolicy.excluded_processes.length}; excluded domains=${nextPolicy.excluded_domains.length}`,
          );
        }
        return sendJson(response, 200, { policy: getPolicy(db) });
      }

      if (method === "GET" && url.pathname === "/api/admin/settings") {
        if (!requireAdmin(request, adminToken, sessionSecret)) return sendError(response, 401, "admin authentication required", "unauthorized");
        return sendJson(response, 200, getAdminSettings(db));
      }

      if (method === "PUT" && url.pathname === "/api/admin/settings/organization") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const result = updateOrganizationSettings(db, await readJson(request));
        if (result.error) return sendError(response, 400, result.error, "invalid_settings");
        if (result.changed) recordAudit(db, "organization_settings_changed", principal.actor || "admin", "organization_settings", "organization profile updated");
        return sendJson(response, 200, { organization: result.settings });
      }

      if (method === "PUT" && url.pathname === "/api/admin/settings/notifications") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const result = updateNotificationSettings(db, await readJson(request));
        if (result.error) return sendError(response, 400, result.error, "invalid_settings");
        recordAudit(db, "notification_settings_changed", principal.actor || "admin", "notification_settings", "notification rules updated");
        return sendJson(response, 200, { notifications: result.settings });
      }

      if (method === "PUT" && url.pathname === "/api/admin/settings/categories") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const result = updateActivityCategories(db, (await readJson(request)).categories);
        if (result.error) return sendError(response, 400, result.error, "invalid_settings");
        recordAudit(db, "activity_categories_changed", principal.actor || "admin", "activity_categories", "activity categories updated");
        return sendJson(response, 200, { categories: result.categories });
      }

      if (method === "PUT" && url.pathname === "/api/admin/settings/integrations") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const result = updateIntegrationSettings(db, (await readJson(request)).integrations);
        if (result.error) return sendError(response, 400, result.error, "invalid_settings");
        recordAudit(db, "integration_settings_changed", principal.actor || "admin", "integration_settings", "integration settings updated");
        return sendJson(response, 200, { integrations: result.integrations });
      }

      if (method === "GET" && url.pathname === "/api/admin/roles") {
        if (!requireAdmin(request, adminToken, sessionSecret)) return sendError(response, 401, "admin authentication required", "unauthorized");
        return sendJson(response, 200, { roles: getRolePolicies(db) });
      }

      if (method === "PUT" && url.pathname === "/api/admin/roles") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const result = updateRolePolicies(db, (await readJson(request)).roles);
        if (result.error) return sendError(response, 400, result.error, "invalid_role_policy");
        recordAudit(db, "role_policies_changed", principal.actor || "admin", "role_policies", "role data scopes updated");
        return sendJson(response, 200, { roles: result.roles });
      }

      if (method === "GET" && url.pathname === "/api/admin/events") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 2000);
        const deviceId = url.searchParams.get("device_id");
        const scope = scopePredicate(principal);
        const conditions = [scope.sql];
        const params = [...scope.params];
        conditions.push("julianday(ev.occurred_at) <= julianday(?)");
        params.push(new Date(Date.now() + 60_000).toISOString());
        if (deviceId) { conditions.push("ev.device_id = ?"); params.push(deviceId); }
        const query = `SELECT ev.*, d.employee_id, e.name AS employee_name, d.hostname
          FROM events ev JOIN devices d ON d.id = ev.device_id JOIN employees e ON e.id = d.employee_id
          WHERE ${conditions.join(" AND ")} ORDER BY ev.occurred_at DESC LIMIT ${limit}`;
        const events = db.prepare(query).all(...params).map((event) => ({
          ...event,
          // Older Agent builds stored browser events as desktop_app even
          // though they already carried a validated domain. Normalize the
          // diagnostic response the same way as History so the UI reports the
          // effective capture source, not the stale persisted value.
          source_kind: sourceKindForEvent(event),
        }));
        return sendJson(response, 200, { events });
      }

      if (method === "GET" && url.pathname === "/api/admin/history") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 2000);
        const deviceId = url.searchParams.get("device_id") || null;
        const records = await getMemoryRecords(db, { deviceId, limit, ai, principal, deferModel: true });
        return sendJson(response, 200, { records, generated_at: isoNow(), model: ai.model });
      }

      if (method === "GET" && url.pathname.startsWith("/api/admin/history/") && url.pathname.endsWith("/sources")) {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const recordId = decodeURIComponent(url.pathname.slice("/api/admin/history/".length, -"/sources".length));
        if (!recordId || recordId.length > 200) return sendError(response, 400, "record id is invalid", "invalid_record_id");
        const records = await getMemoryRecords(db, { limit: 2000, ai, principal, deferModel: true });
        const record = records.find((item) => item.id === recordId);
        if (!record) return sendError(response, 404, "history record not found", "record_not_found");

        const sourceRecordIds = Array.isArray(record.source_record_ids) ? record.source_record_ids : [];
        const sourceRecords = sourceRecordIds
          .map((sourceId) => records.find((item) => item.id === sourceId))
          .filter(Boolean)
          .map((source) => ({
            ...source,
            source_record_ids: undefined,
          }));
        const sourceEventIds = new Set(Array.isArray(record.source_event_ids) ? record.source_event_ids : []);
        const sourceEvents = historyEventRows(db, record.device_id, principal)
          .filter((event) => sourceEventIds.has(event.event_id))
          .map((event) => ({
            event_id: event.event_id,
            occurred_at: event.occurred_at,
            type: event.type,
            app_name: event.app_name,
            process_name: event.process_name,
            source_kind: sourceKindForEvent(event),
            context_label: event.context_label,
            web_domain: event.web_domain,
            duration_seconds: event.duration_seconds,
          }));
        return sendJson(response, 200, {
          record_id: record.id,
          source_records: sourceRecords,
          source_events: sourceEvents,
        });
      }

      if (method === "POST" && url.pathname === "/api/admin/history/export") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const body = await readJson(request);
        const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 2000);
        const deviceId = typeof body.device_id === "string" && body.device_id.trim() ? body.device_id.trim() : null;
        const records = await getMemoryRecords(db, { deviceId, limit, ai, principal, deferModel: true });
        const requestedIds = Array.isArray(body.record_ids) ? new Set(body.record_ids.filter((id) => typeof id === "string").slice(0, 200)) : null;
        const exported = requestedIds?.size ? records.filter((record) => requestedIds.has(record.id)) : records;
        recordAudit(db, "history_exported", principal.actor || "admin", deviceId || "history", `records=${exported.length}`);
        return sendJson(response, 200, { records: exported, exported_at: isoNow(), model: ai.model });
      }

      if (method === "POST" && url.pathname === "/api/admin/history/ask") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const body = await readJson(request);
        if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 500) {
          return sendError(response, 400, "question must be a non-empty string of at most 500 characters", "invalid_question");
        }
        // History Skill searches persisted Memory Summary records across the
        // retention window by default; the timeline keeps its smaller recent
        // response through the GET endpoint above.
        const limit = Math.min(Math.max(Number(body.limit) || 2000, 1), 2000);
        const deviceId = typeof body.device_id === "string" && body.device_id.trim() ? body.device_id.trim() : null;
        const requestedTeam = typeof body.team === "string" && body.team.trim() ? body.team.trim().slice(0, 120) : null;
        const effectiveTeam = principal.role === "manager" ? principal.team : principal.role === "employee" ? null : requestedTeam;
        const records = await getMemoryRecords(db, { deviceId, limit, ai, principal, team: effectiveTeam, deferModel: true });
        const queryTimeRange = historyQueryTimeRange(body.question.trim());
        const timeScopedRecords = filterHistoryRecordsByTime(records, queryTimeRange);
        const retrieval = searchHistoryRecords(body.question.trim(), timeScopedRecords);
        const rankedRecords = retrieval.records;
        const answer = await ai.answerHistory({ question: body.question.trim(), records: rankedRecords, timeRange: queryTimeRange });
        const evidenceIds = Array.isArray(answer.evidence_ids) ? answer.evidence_ids : [];
        const evidence = evidenceIds.map((id) => rankedRecords.find((record) => record.id === id)).filter(Boolean);
        const selectedEvidence = evidence.length ? evidence : rankedRecords.slice(0, 3);
        const citations = [...new Map(selectedEvidence
          .flatMap((record) => record.citations || [])
          .map((citation) => [`${citation.label}:${citation.detail}`, citation]))
          .values()].slice(0, 50);
        const resources = [...new Map(selectedEvidence
          .flatMap((record) => record.resources || [])
          .map((resource) => [resource.name, resource]))
          .values()].slice(0, 50);
        recordAudit(
          db,
          "history_asked",
          principal.actor || "admin",
          deviceId || "history",
          `question_length=${body.question.trim().length}; evidence=${selectedEvidence.length}`,
        );
        return sendJson(response, 200, {
          answer: answer.answer,
          evidence: selectedEvidence,
          applications: [...new Set(selectedEvidence.flatMap((record) => record.application_names || []))],
          context_labels: [...new Set(selectedEvidence.flatMap((record) => record.context_labels || []))],
          web_domains: [...new Set(selectedEvidence.flatMap((record) => record.web_domains || []))],
          citations,
          resources,
          time_range: evidenceTimeRange(selectedEvidence),
          query_time_range: queryTimeRange,
          query_team: effectiveTeam,
          caveats: [answer.caveat || "答案只基于活动元数据和 Memory Summary。"],
          uncertainty: answer.uncertainty || "应用活动只能说明上下文变化，不能单独证明工作效率或绩效。",
          model: answer.model_name || ai.model,
          retrieval: {
            mode: retrieval.mode,
            candidate_count: timeScopedRecords.length,
            selected_count: selectedEvidence.length,
            query_groups: retrieval.query_groups,
          },
          generated_at: isoNow(),
        });
      }

      if (method === "GET" && url.pathname === "/api/admin/audit") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        let query = "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500";
        let params = [];
        if (principal.role === "employee") {
          query = "SELECT * FROM audit_logs WHERE actor = ? OR target = ? ORDER BY created_at DESC LIMIT 500";
          params = [principal.actor, principal.employee_id];
        } else if (principal.role === "manager") {
          query = `SELECT * FROM audit_logs
            WHERE target IN (SELECT d.id FROM devices d JOIN employees e ON e.id = d.employee_id WHERE e.team = ?)
               OR target IN (SELECT id FROM employees WHERE team = ?)
               OR actor = ?
            ORDER BY created_at DESC LIMIT 500`;
          params = [principal.team, principal.team, principal.actor];
        }
        const logs = db.prepare(query).all(...params);
        return sendJson(response, 200, { logs });
      }

      if (method === "GET" && url.pathname === "/api/admin/audit/export") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        let query = "SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 5000";
        let params = [];
        if (principal.role === "employee") {
          query = "SELECT * FROM audit_logs WHERE actor = ? OR target = ? ORDER BY created_at DESC LIMIT 5000";
          params = [principal.actor, principal.employee_id];
        } else if (principal.role === "manager") {
          query = `SELECT * FROM audit_logs
            WHERE target IN (SELECT d.id FROM devices d JOIN employees e ON e.id = d.employee_id WHERE e.team = ?)
               OR target IN (SELECT id FROM employees WHERE team = ?)
               OR actor = ?
            ORDER BY created_at DESC LIMIT 5000`;
          params = [principal.team, principal.team, principal.actor];
        }
        const logs = db.prepare(query).all(...params);
        recordAudit(db, "audit_exported", principal.actor || "admin", "audit_logs", `records=${logs.length}`);
        return sendJson(response, 200, { logs, exported_at: isoNow() });
      }

      if (method === "GET" && url.pathname === "/api/admin/memory/jobs") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const scope = scopePredicate(principal);
        const jobs = db.prepare(`
          SELECT j.id, j.summary_id, j.attempts, j.next_attempt_at,
            CASE WHEN j.status = 'failed' AND j.last_error LIKE 'cancelled:%' THEN 'cancelled' ELSE j.status END AS status,
            j.last_error,
            j.created_at, j.updated_at, ms.model_name, ms.record_type, ms.rollup_scope,
            e.name AS employee_name, e.team AS employee_team
          FROM memory_generation_jobs j
          JOIN memory_summaries ms ON ms.id = j.summary_id
          JOIN devices d ON d.id = ms.device_id
          JOIN employees e ON e.id = d.employee_id
          WHERE ${scope.sql}
          ORDER BY j.updated_at DESC LIMIT 500
        `).all(...scope.params);
        return sendJson(response, 200, {
          jobs,
          model: ai.model,
          cadence: {
            summary_window_seconds: AI_SUMMARY_WINDOW_SECONDS,
            active_grace_seconds: AI_ACTIVE_GRACE_SECONDS,
            generation_interval_seconds: AI_GENERATION_INTERVAL_SECONDS,
            generation_batch_size: configuredAiGenerationBatchSize(),
          },
        });
      }

      if (method === "POST" && url.pathname === "/api/admin/retention") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal || !canMutateAdmin(principal)) return sendError(response, 403, "admin write permission required", "forbidden");
        const body = await readJson(request);
        const cutoff = typeof body.before === "string" ? Date.parse(body.before) : NaN;
        if (Number.isNaN(cutoff)) return sendError(response, 400, "before must be a valid ISO date", "invalid_cutoff");
        const before = new Date(cutoff).toISOString();
        const preview = {
          events: Number(db.prepare("SELECT COUNT(*) AS count FROM events WHERE occurred_at < ?").get(before).count),
          memory_summaries: Number(db.prepare("SELECT COUNT(*) AS count FROM memory_summaries WHERE ended_at < ?").get(before).count),
        };
        if (body.apply !== true) return sendJson(response, 200, { applied: false, before, preview });

        db.exec("BEGIN IMMEDIATE");
        try {
          const summaries = db.prepare("DELETE FROM memory_summaries WHERE ended_at < ?").run(before);
          const events = db.prepare("DELETE FROM events WHERE occurred_at < ?").run(before);
          recordAudit(db, "retention_deleted", "admin", "activity_data", `before=${before}; summaries=${summaries.changes}; events=${events.changes}`);
          db.exec("COMMIT");
          return sendJson(response, 200, {
            applied: true,
            before,
            deleted: { events: Number(events.changes), memory_summaries: Number(summaries.changes) },
          });
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      }

      if (method === "POST" && url.pathname === "/api/agent/enroll") {
        const body = await readJson(request);
        const validationError = validateEnrollment(body);
        if (validationError) return sendError(response, 400, validationError);
        const registration = db.prepare(`
          SELECT rc.id, rc.employee_id, rc.expires_at, e.name AS employee_name, e.team AS employee_team
          FROM registration_codes rc JOIN employees e ON e.id = rc.employee_id
          WHERE rc.code_hash = ? AND rc.used_at IS NULL
        `).get(hash(body.registration_code.trim().toUpperCase()));
        if (!registration) return sendError(response, 400, "registration code is invalid or already used", "invalid_registration_code");
        if (Date.parse(registration.expires_at) <= Date.now()) return sendError(response, 400, "registration code has expired", "expired_registration_code");

        const deviceId = newId("device");
        const token = newToken();
        const now = isoNow();
        db.exec("BEGIN IMMEDIATE");
        try {
          const claim = db.prepare("UPDATE registration_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, registration.id);
          if (Number(claim.changes) !== 1) throw new Error("registration code was claimed concurrently");
          db.prepare(`
            INSERT INTO devices (id, employee_id, hostname, os_version, agent_version, token_hash, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 'online', ?, ?)
          `).run(deviceId, registration.employee_id, body.hostname, body.os_version, body.agent_version, hash(token), now, now);
          recordAudit(db, "agent_enrolled", registration.employee_name, deviceId, `device bound to ${registration.employee_id}`);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(response, 201, {
          device_id: deviceId,
          device_token: token,
          employee: { id: registration.employee_id, name: registration.employee_name, team: registration.employee_team },
          policy: getPolicy(db),
          server_time: now,
        });
      }

      if (method === "POST" && url.pathname === "/api/agent/browser-pairing-codes") {
        const device = deviceFromRequest(db, request);
        if (!device || device.auth_kind !== "device") return sendError(response, 401, "registered device token required", "unauthorized");
        const code = newBrowserPairingCode();
        const now = isoNow();
        const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
        db.prepare(
          "INSERT INTO browser_pairing_codes (id, code_hash, device_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
        ).run(newId("browser_pair"), hash(code), device.id, expiresAt, now);
        recordAudit(db, "browser_pairing_code_created", device.employee_name, device.id, "short-lived browser pairing code created");
        return sendJson(response, 201, { code, expires_at: expiresAt, device_id: device.id });
      }

      if (method === "POST" && url.pathname === "/api/agent/browser-pair") {
        const body = await readJson(request);
        const pairingCode = typeof body.pairing_code === "string" ? body.pairing_code.trim().toUpperCase() : "";
        if (!/^BP-[A-F0-9]{10}$/.test(pairingCode)) return sendError(response, 400, "pairing_code is invalid", "invalid_pairing_code");
        const pairing = db.prepare(`
          SELECT bpc.id, bpc.device_id, bpc.expires_at, d.employee_id, d.hostname,
            e.name AS employee_name, e.team AS employee_team
          FROM browser_pairing_codes bpc
          JOIN devices d ON d.id = bpc.device_id
          JOIN employees e ON e.id = d.employee_id
          WHERE bpc.code_hash = ? AND bpc.used_at IS NULL AND d.disabled_at IS NULL
        `).get(hash(pairingCode));
        if (!pairing) return sendError(response, 400, "pairing code is invalid or already used", "invalid_pairing_code");
        if (Date.parse(pairing.expires_at) <= Date.now()) return sendError(response, 400, "pairing code has expired", "expired_pairing_code");
        const requestedBrowserName = typeof body.browser_name === "string" ? body.browser_name.trim() : "";
        const browserName = requestedBrowserName && !/[\r\n]/.test(requestedBrowserName)
          ? requestedBrowserName.slice(0, 80)
          : "Browser";
        const browserToken = newToken();
        const now = isoNow();
        const expiresAt = new Date(Date.now() + 30 * 24 * 3600_000).toISOString();
        db.exec("BEGIN IMMEDIATE");
        try {
          const claim = db.prepare("UPDATE browser_pairing_codes SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, pairing.id);
          if (Number(claim.changes) !== 1) throw new Error("pairing code was claimed concurrently");
          db.prepare(
            "INSERT INTO browser_tokens (id, token_hash, device_id, browser_name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          ).run(newId("browser_token"), hash(browserToken), pairing.device_id, browserName, expiresAt, now);
          recordAudit(db, "browser_paired", pairing.employee_name, pairing.device_id, `browser=${browserName}`);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        return sendJson(response, 201, {
          browser_token: browserToken,
          expires_at: expiresAt,
          device_id: pairing.device_id,
          employee: { id: pairing.employee_id, name: pairing.employee_name, team: pairing.employee_team },
        });
      }

      if (method === "GET" && url.pathname === "/api/agent/policy") {
        const device = deviceFromRequest(db, request);
        if (!device || device.auth_kind !== "device") return sendError(response, 401, "valid device token required", "unauthorized");
        return sendJson(response, 200, { policy: getPolicy(db) });
      }

      if (method === "POST" && url.pathname === "/api/agent/events") {
        const device = deviceFromRequest(db, request);
        if (!device) return sendError(response, 401, "valid device token required", "unauthorized");
        const wasOffline = device.status !== "online";
        const body = await readJson(request);
        const validationError = validateEvents(body);
        if (validationError) return sendError(response, 400, validationError);
        const policy = getPolicy(db);
        const acceptedEvents = body.events.filter((event) => !eventExcludedByPolicy(event, policy));
        const insert = db.prepare(`
          INSERT INTO events
            (event_id, device_id, occurred_at, type, app_name, process_name, source_kind, context_label, web_domain, duration_seconds, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            source_kind = excluded.source_kind,
            context_label = COALESCE(excluded.context_label, events.context_label),
            web_domain = COALESCE(excluded.web_domain, events.web_domain),
            duration_seconds = MAX(events.duration_seconds, excluded.duration_seconds),
            received_at = excluded.received_at
        `);
        for (const event of acceptedEvents) {
          const normalizedEvent = eventPayloadByPolicy(event, policy);
          insert.run(normalizedEvent.event_id, device.id, normalizedEvent.occurred_at, normalizedEvent.type, normalizedEvent.app_name, normalizedEvent.process_name, sourceKindForEvent(normalizedEvent), normalizedEvent.context_label || normalizedEvent.title_hint || null, normalizedEvent.web_domain ? normalizedEvent.web_domain.trim().toLowerCase() : null, normalizedEvent.duration_seconds, isoNow());
        }
        if (device.auth_kind === "device") {
          db.prepare("UPDATE devices SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(isoNow(), isoNow(), device.id);
          if (wasOffline) recordAudit(db, "agent_online", "system", device.id, "event upload resumed");
        }
        return sendJson(response, 202, {
          accepted: acceptedEvents.length,
          filtered: body.events.length - acceptedEvents.length,
          duplicate_safe: true,
        });
      }

      if (method === "POST" && url.pathname === "/api/agent/heartbeat") {
        const device = deviceFromRequest(db, request);
        if (!device || device.auth_kind !== "device") return sendError(response, 401, "valid device token required", "unauthorized");
        const wasOffline = device.status !== "online";
        const body = await readJson(request);
        const now = isoNow();
        db.prepare(`
          UPDATE devices SET status = 'online', agent_version = ?, queued_events = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?
        `).run(
          typeof body.agent_version === "string" ? body.agent_version.slice(0, 30) : device.agent_version,
          Number.isInteger(body.queued_events) && body.queued_events >= 0 ? body.queued_events : 0,
          now,
          now,
          device.id,
        );
        if (wasOffline) recordAudit(db, "agent_online", "system", device.id, "heartbeat resumed");
        return sendJson(response, 200, { ok: true, server_time: now, policy: getPolicy(db) });
      }

      return sendError(response, 404, "route not found", "not_found");
    } catch (error) {
      logger.error?.(error);
      const message = error.message === "request_body_too_large" ? "request body is too large" : error.message === "invalid_json" ? "invalid JSON body" : "internal server error";
      return sendError(response, error.message === "request_body_too_large" || error.message === "invalid_json" ? 400 : 500, message, "request_error");
    }
  };
}

export function createAgentServer({ dbPath = process.env.AGENT_DB_PATH || defaultDbPath, adminToken = process.env.AGENT_ADMIN_TOKEN || `admin_${randomBytes(18).toString("base64url")}`, sessionSecret = process.env.AGENT_SESSION_SECRET || adminToken, logger = console, ai = createAiService({ logger }) } = {}) {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(resolve(dbPath));
  createSchema(db);
  recoverRunningMemoryJobs(db);
  const server = createHttpServer(createRequestHandler({ db, adminToken, sessionSecret, ai, logger }));
  let memoryWarmupRunning = false;
  const memoryMaterializationIntervalMs = Math.max(15_000, Number(process.env.MEMORY_MATERIALIZATION_INTERVAL_MS) || 60_000);
  const memoryGenerationBatchSize = configuredAiGenerationBatchSize();
  const warmRecentMemorySummaries = async () => {
    if (memoryWarmupRunning || ai.mode !== "model") return;
    memoryWarmupRunning = true;
    try {
      await getMemoryRecords(db, { limit: 200, ai, deferModel: true });
    } catch (error) {
      logger.warn?.(`Memory Summary materialization error: ${error.message}`);
    } finally {
      memoryWarmupRunning = false;
    }
  };
  const memoryMaterializationTimer = setInterval(() => {
    warmRecentMemorySummaries().catch((error) => logger.warn?.(`Memory Summary worker error: ${error.message}`));
  }, memoryMaterializationIntervalMs);
  memoryMaterializationTimer.unref?.();
  const generationTimer = setInterval(() => {
    processMemoryGenerationJobs(db, ai, logger, { limit: memoryGenerationBatchSize }).catch((error) => logger.warn?.(`Memory Summary worker error: ${error.message}`));
  }, AI_GENERATION_INTERVAL_SECONDS * 1000);
  generationTimer.unref?.();
  return {
    db,
    server,
    adminToken,
    ai,
    sessionSecret,
    listen(port = Number(process.env.PORT) || 8787, host = process.env.HOST || "0.0.0.0") {
      return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolvePromise(server.address()));
      });
    },
    close() {
      clearInterval(memoryMaterializationTimer);
      clearInterval(generationTimer);
      db.close();
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createAgentServer();
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || "0.0.0.0";
  app.listen(port, host).then((address) => {
    console.log(`AI锦衣卫 Agent Server listening on http://${address.address === "::" ? "localhost" : address.address}:${address.port}`);
    console.log(`Admin token: ${process.env.AGENT_ADMIN_TOKEN ? "configured via AGENT_ADMIN_TOKEN" : app.adminToken}`);
    console.log(`AI provider: ${app.ai?.model || "rules-v1"} (${app.ai?.mode || "fallback"})`);
  });
}

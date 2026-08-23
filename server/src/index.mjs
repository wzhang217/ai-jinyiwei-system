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

const defaultEmployees = [
  ["employee-wei", "Wei", "研发与产品中心"],
  ["employee-lin", "Lin", "客户与销售团队"],
  ["employee-ming", "Ming", "运营与支持团队"],
  ["employee-chen", "Chen", "研发与产品中心"],
  ["employee-jia", "Jia", "客户与销售团队"],
];

const defaultPolicy = {
  idle_threshold_seconds: 300,
  heartbeat_interval_seconds: 60,
  work_hours_start: "09:00",
  work_hours_end: "18:00",
  excluded_processes: [],
  excluded_domains: [],
  version: 1,
};

const HISTORY_WINDOW_SECONDS = 10 * 60;
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
const hash = (value) => createHash("sha256").update(value).digest("hex");
const newId = (prefix) => `${prefix}_${randomBytes(12).toString("hex")}`;
const newToken = () => randomBytes(32).toString("base64url");
const newRegistrationCode = () => `JY-${randomBytes(5).toString("hex").toUpperCase()}`;
const newBrowserPairingCode = () => `BP-${randomBytes(5).toString("hex").toUpperCase()}`;

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
  `);

  ensureColumn(db, "events", "context_label", "TEXT");
  ensureColumn(db, "events", "web_domain", "TEXT");
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

  const employeeInsert = db.prepare(
    "INSERT OR IGNORE INTO employees (id, name, team, created_at) VALUES (?, ?, ?, ?)",
  );
  const createdAt = isoNow();
  for (const employee of defaultEmployees) employeeInsert.run(...employee, createdAt);

  const policyInsert = db.prepare("INSERT OR IGNORE INTO policies (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(defaultPolicy)) {
    policyInsert.run(key, Array.isArray(value) ? JSON.stringify(value) : String(value));
  }
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
    policy[row.key] = ["idle_threshold_seconds", "heartbeat_interval_seconds", "version"].includes(row.key)
      ? Number(row.value)
      : row.value;
    return policy;
  }, {});
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
  if (!principal || principal.role === "admin" || principal.role === "auditor") return { sql: "1 = 1", params: [] };
  if (principal.role === "employee") return { sql: `${deviceAlias}.employee_id = ?`, params: [principal.employee_id] };
  if (principal.role === "manager") return { sql: `${employeeAlias}.team = ?`, params: [principal.team] };
  return { sql: "1 = 0", params: [] };
}

function principalScope(principal) {
  if (!principal || principal.role === "admin" || principal.role === "auditor") return {};
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
    if (event.context_label !== undefined && event.context_label !== null && !isSafeContextLabel(event.context_label)) return "context_label is invalid";
    if (event.title_hint !== undefined && event.title_hint !== null && !isSafeContextLabel(event.title_hint)) return "title_hint is invalid";
    if (event.web_domain !== undefined && event.web_domain !== null && (typeof event.web_domain !== "string" || event.web_domain.length > 253 || !isSafeWebDomain(event.web_domain))) return "web_domain is invalid";
    if (!Number.isInteger(event.duration_seconds) || event.duration_seconds < 0 || event.duration_seconds > 86400) return "duration_seconds is invalid";
  }
  return null;
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
  const processName = String(event.process_name || "").trim().toLowerCase();
  const excludedProcesses = (policy.excluded_processes || []).map((item) => String(item).trim().toLowerCase());
  return excludedProcesses.includes(processName) || policyDomainMatches(event.web_domain, policy.excluded_domains);
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
  if (normalized.includes("explorer")) return "Windows 文件资源管理器";
  if (normalized.includes("terminal") || normalized.includes("powershell") || normalized.includes("cmd.exe")) return "Windows 终端";
  if (normalized.includes("codex") || normalized.includes("chatgpt")) return "Codex";
  return appName;
}

function applicationContext(appName, processName) {
  const normalized = `${appName || ""} ${processName || ""}`.toLowerCase();
  if (normalized.includes("jira") || normalized.includes("linear") || normalized.includes("trello") || normalized.includes("asana") || normalized.includes("clickup") || normalized.includes("monday")) return "项目管理";
  if (normalized.includes("wechat") || normalized.includes("weixin") || normalized.includes("企业微信") || normalized.includes("slack") || normalized.includes("teams") || normalized.includes("feishu") || normalized.includes("lark") || normalized.includes("dingtalk")) return "沟通";
  if (normalized.includes("chrome") || normalized.includes("edge") || normalized.includes("360se") || normalized.includes("firefox") || normalized.includes("browser")) return "浏览器";
  if (normalized.includes("code") || normalized.includes("visual studio") || normalized.includes("idea") || normalized.includes("devenv")) return "开发";
  if (normalized.includes("wps") || normalized.includes("word") || normalized.includes("excel") || normalized.includes("powerpoint") || normalized.includes("notion")) return "文档";
  if (normalized.includes("explorer") || normalized.includes("finder")) return "文件";
  if (normalized.includes("terminal") || normalized.includes("powershell") || normalized.includes("cmd.exe") || normalized.includes("windowsterminal")) return "终端";
  if (normalized.includes("idle") || normalized.includes("system")) return "系统";
  return "其他";
}

function metadataResource(label) {
  const value = String(label || "");
  if (value.startsWith("项目：")) return { name: value, path: "脱敏项目标识", type: "code" };
  if (value.startsWith("文档：")) return { name: value, path: "脱敏文档标识", type: "document" };
  if (value.startsWith("文件：") || value.startsWith("文件夹：")) return { name: value, path: "脱敏文件标识", type: "document" };
  if (value.startsWith("来源：")) return { name: value, path: "允许的来源提示", type: "metadata" };
  return { name: value, path: "脱敏工作标识", type: "metadata" };
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
  return rows.filter((row) => !HIDDEN_AGENT_PROCESSES.has(String(row.process_name || "").toLowerCase()));
}

function splitHistoryEventRow(row) {
  const durationSeconds = Math.max(0, Number(row.duration_seconds) || 0);
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

function buildHistoryRecords(db, { deviceId = null, limit = 200, principal = null, team = null } = {}) {
  const episodes = [];
  let current = null;

  const flush = () => {
    if (current) episodes.push(current);
    current = null;
  };

  for (const sourceRow of historyEventRows(db, deviceId, principal, team)) {
    for (const row of splitHistoryEventRow(sourceRow)) {
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
  }
  flush();

  const selectedEpisodes = episodes
    .sort((left, right) => right.startMs - left.startMs)
    .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 2000))
    .sort((left, right) => left.startMs - right.startMs);
  const records = selectedEpisodes.map((episode) => {
      const start = new Date(episode.startMs).toISOString();
      const end = new Date(episode.endMs).toISOString();
      const durationSeconds = Math.max(0, Math.round((episode.endMs - episode.startMs) / 1000));
      const rawApplicationNames = [...new Set(episode.rows.map((row) => row.app_name))];
      const applicationNames = [...new Set(rawApplicationNames.map(displayApplicationName))];
      const applications = [...new Set(rawApplicationNames.map(applicationKey))];
      const contextKinds = [...new Set(episode.rows.map((row) => applicationContext(row.app_name, row.process_name)))];
      const contextKeys = episode.rows.map((row) => [
        row.type,
        row.app_name,
        row.process_name,
        row.context_label || "",
        row.web_domain || "",
      ].join("\u001f"));
      const contextSwitches = contextKeys.slice(1).reduce(
        (count, key, index) => count + (key === contextKeys[index] ? 0 : 1),
        0,
      );
      const contextLabels = [...new Set(episode.rows.map((row) => row.context_label).filter((value) => typeof value === "string" && value.trim()))];
      const webDomains = [...new Set(episode.rows.map((row) => row.web_domain).filter((value) => typeof value === "string" && value.trim()))];
      const sourceLabels = [...contextLabels, ...webDomains];
      const displayApps = episode.isIdle ? ["系统空闲"] : applicationNames;
      const displayTitle = sourceLabels.length
        ? `${episode.employeeName} · ${sourceLabels.slice(0, 2).join("、")}${sourceLabels.length > 2 ? " 等" : ""}`
        : contextKinds.length > 1
        ? `${episode.employeeName} · ${contextKinds.join("、")}活动`
        : displayApps.length > 2
          ? `${episode.employeeName} · ${displayApps.slice(0, 2).join("、")} 等 ${displayApps.length} 个应用`
          : `${episode.employeeName} · ${displayApps.join("、")}`;
      const readableDuration = formatDuration(durationSeconds);
      const timeline = episode.rows.map((row) => ({
        occurred_at: row.occurred_at,
        text: row.type === "idle"
          ? "进入系统空闲状态"
          : [
              `前台应用：${displayApplicationName(row.app_name)}`,
              row.context_label,
              row.web_domain ? `域名：${row.web_domain}` : null,
            ].filter(Boolean).join(" · "),
        app: row.type === "idle" ? "other" : applicationKey(row.app_name),
      }));
      const resources = [
        ...contextLabels.map(metadataResource),
        ...webDomains.map((domain) => ({ name: domain, path: "仅域名元数据", type: "metadata" })),
      ];
      const citations = [...new Map(episode.rows.map((row) => [row.process_name, {
        label: row.hostname,
        detail: `${episode.employeeName} · ${row.process_name}`,
        type: "app",
      }])).values()];

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
          ? `${episode.employeeName} 的电脑处于系统空闲状态 ${readableDuration}。`
          : `${episode.employeeName} 在 ${displayApps.join("、")} 中连续活动 ${readableDuration}${sourceLabels.length ? `，关联 ${sourceLabels.join("、")}` : ""}。`,
        applications,
        application_names: applicationNames,
        context_kinds: contextKinds,
        context_switches: contextSwitches,
        context_labels: contextLabels,
        web_domains: webDomains,
        duration_seconds: durationSeconds,
        started_at: start,
        ended_at: end,
        summary: episode.isIdle
          ? "这是一条基于系统空闲状态生成的活动元数据记录。"
          : `${episode.employeeName} 在 ${contextKinds.join("、")}上下文中连续活动 ${readableDuration}，期间记录到 ${episode.rows.length} 个前台应用片段并发生 ${contextSwitches} 次应用切换，主要涉及 ${displayApps.join("、")}${sourceLabels.length ? `，关联 ${sourceLabels.join("、")}` : ""}。该摘要只基于活动元数据生成。`,
        prior_context: "来源于 Windows Agent 的前台应用活动采集；工作标识来自允许的开发工具窗口标题脱敏结果，网站只保留域名。",
        important_context: "应用切换只代表活动上下文变化，不直接代表工作效率或绩效结论；系统不保存原始窗口标题、完整 URL、页面正文或聊天正文。",
        non_obvious: "应用切换只代表活动上下文变化，不直接代表工作效率或绩效结论；系统不保存原始窗口标题、完整 URL、页面正文或聊天正文。",
        timeline,
        resources,
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

function localDayStart(milliseconds = Date.now()) {
  const date = new Date(milliseconds);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function historyQueryTimeRange(question, now = Date.now()) {
  const value = String(question || "").trim();
  if (!value) return null;
  const todayStart = localDayStart(now);
  if (/今天|今日/.test(value)) return { start: new Date(todayStart).toISOString(), end: new Date(now).toISOString(), label: "今天" };
  if (/昨天|昨日/.test(value)) {
    const start = todayStart - 24 * 3600_000;
    return { start: new Date(start).toISOString(), end: new Date(todayStart).toISOString(), label: "昨天" };
  }
  if (/上周/.test(value)) {
    const currentWeekStart = todayStart - ((new Date(todayStart).getDay() + 6) % 7) * 24 * 3600_000;
    const start = currentWeekStart - 7 * 24 * 3600_000;
    return { start: new Date(start).toISOString(), end: new Date(currentWeekStart).toISOString(), label: "上周" };
  }
  if (/本周|这周|本星期/.test(value)) {
    const start = todayStart - ((new Date(todayStart).getDay() + 6) % 7) * 24 * 3600_000;
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
    const startDate = new Date(Number(dateMatch[1]), Number(dateMatch[2]) - 1, Number(dateMatch[3]));
    const start = startDate.getTime();
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

export function rankHistoryRecords(question, records = []) {
  const tokens = historyQueryTokens(question);
  return records
    .map((record, index) => {
      const fields = [
        [record.title, 6],
        [record.context_labels?.join(" "), 5],
        [record.web_domains?.join(" "), 5],
        [record.application_names?.join(" "), 4],
        [record.description, 2],
        [record.summary, 2],
        [record.prior_context, 1],
      ];
      const score = tokens.reduce((total, token) => total + fields.reduce((fieldTotal, [value, weight]) => (
        String(value || "").toLowerCase().includes(token) ? fieldTotal + weight : fieldTotal
      ), 0), 0);
      const startedAt = Date.parse(record.started_at || "");
      return { record, score, startedAt: Number.isFinite(startedAt) ? startedAt : 0, index };
    })
    .sort((left, right) => right.score - left.score || right.startedAt - left.startedAt || left.index - right.index)
    .map(({ record }) => record);
}

function startOfUtcWeekMs(milliseconds) {
  const date = new Date(milliseconds);
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday);
}

function rollupBucket(record, scope) {
  const startMs = Date.parse(record.started_at);
  const date = new Date(startMs);
  if (scope === "hourly") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours());
  if (scope === "daily") return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  if (scope === "weekly" || scope === "team_weekly") return startOfUtcWeekMs(startMs);
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
      const day = record.started_at.slice(0, 10);
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
      const day = record.started_at.slice(0, 10);
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
    const sourceEventIds = [...new Set(records.flatMap((record) => record.source_event_ids || []))];
    const timeline = records.flatMap((record) => record.timeline || []).sort((left, right) => Date.parse(left.occurred_at) - Date.parse(right.occurred_at));
    const resources = [...new Map(records.flatMap((record) => record.resources || []).map((item) => [item.name, item])).values()];
    const citations = [...new Map(records.flatMap((record) => record.citations || []).map((item) => [`${item.label}:${item.detail}`, item])).values()];
    const periodStartMs = Math.min(...records.map((record) => Date.parse(record.started_at)));
    const periodEndMs = Math.max(...records.map((record) => Date.parse(record.ended_at)));
    const durationSeconds = records.reduce((sum, record) => sum + Math.max(0, Number(record.duration_seconds) || 0), 0);
    const contextTitle = contextLabels.length ? contextLabels.slice(0, 2).join("、") : contextKinds.slice(0, 3).join("、") || "连续工作";
    const readableDuration = formatDuration(durationSeconds);
    const scopeLabel = scope === "six_hour" ? "6 小时汇总" : scope === "hourly" ? "小时汇总" : scope === "daily" ? "每日汇总" : scope === "weekly" ? "每周汇总" : scope === "team_weekly" ? "团队周汇总" : "连续工作汇总";
    const isTeamRollup = scope === "team_weekly";
    const subjectName = isTeamRollup ? `${first.employee_team || "未分组"}团队` : first.employee_name;
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
      citations,
      source_event_ids: sourceEventIds,
      source_record_ids: records.map((record) => record.id),
      confidence: Math.min(...records.map((record) => record.confidence ?? 1)),
    };
  });
}

async function materializeMemoryRecords(db, baseRecords, ai) {
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
  for (const baseRecord of baseRecords) {
    const sourceHash = hash(JSON.stringify({
      source_event_ids: baseRecord.source_event_ids,
      started_at: baseRecord.started_at,
      ended_at: baseRecord.ended_at,
      duration_seconds: baseRecord.duration_seconds,
      context_labels: baseRecord.context_labels,
      web_domains: baseRecord.web_domains,
      source_record_ids: baseRecord.source_record_ids,
      prior_context: baseRecord.prior_context,
    }));
    const existing = select.get(baseRecord.id);
    const job = existing ? selectJob.get(baseRecord.id) : null;
    const pendingJob = job && ["queued", "running", "retrying"].includes(job.status);
    const exhaustedJob = job && job.status === "failed" && Number(job.attempts || 0) >= 5;
    const shouldRegenerateForModel = existing
      && ai.mode === "model"
      && (existing.status === "fallback" || existing.model_name !== ai.model)
      && !pendingJob
      && (!exhaustedJob || existing.model_name !== ai.model);
    if (existing && existing.source_hash === sourceHash && !shouldRegenerateForModel) {
      try {
        records.push(JSON.parse(existing.payload_json));
        continue;
      } catch {
        // Rebuild a malformed persisted payload below.
      }
    }

    const generated = await ai.summarizeMemory(aiInputForRecord(baseRecord));
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
      generated_at: generated.status === "generated" ? isoNow() : existing?.generated_at || isoNow(),
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
    if (ai.mode === "model" && generated.retryable && (!exhaustedJob || existing?.model_name !== ai.model)) {
      enqueueJob.run(newId("memory_job"), record.id, isoNow(), now, now);
    }
    records.push(record);
  }
  return records;
}

export async function processMemoryGenerationJobs(db, ai, logger = console, { limit = 5 } = {}) {
  if (ai.mode !== "model") return { processed: 0, succeeded: 0, retried: 0, failed: 0 };
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
  const markSucceeded = db.prepare("UPDATE memory_generation_jobs SET status = 'succeeded', last_error = NULL, updated_at = ? WHERE id = ?");
  const markRetry = db.prepare("UPDATE memory_generation_jobs SET attempts = ?, next_attempt_at = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?");
  let succeeded = 0;
  let retried = 0;
  let failed = 0;

  for (const job of jobs) {
    markRunning.run(now, job.id);
    try {
      const stored = getSummary.get(job.summary_id);
      if (!stored) throw new Error("summary not found");
      const baseRecord = JSON.parse(stored.payload_json);
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
      if (exhausted) failed += 1;
      else retried += 1;
      logger.warn?.(`Memory Summary generation ${exhausted ? "failed" : "will retry"}: ${safeMessage}`);
    }
  }
  return { processed: jobs.length, succeeded, retried, failed };
}

async function getMemoryRecords(db, { deviceId = null, limit = 200, ai, principal = null, team = null }) {
  const leafRecords = await materializeMemoryRecords(db, buildHistoryRecords(db, { deviceId, limit, principal, team }), ai);
  const rollupRecords = [];
  for (const scope of ["window", "six_hour", "hourly", "daily", "weekly", "team_weekly"]) {
    rollupRecords.push(...await materializeMemoryRecords(db, buildRollupRecords(leafRecords, scope), ai));
  }
  return [...leafRecords, ...rollupRecords]
    .sort((left, right) => Date.parse(right.started_at) - Date.parse(left.started_at))
    .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 2000));
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
        const role = ["admin", "manager", "employee", "auditor"].includes(body.role) ? body.role : null;
        if (!role) return sendError(response, 400, "role must be admin, manager, employee, or auditor", "invalid_role");
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
        } else if (role === "auditor") {
          actor = "auditor";
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
          excluded_processes: body?.excluded_processes ?? current.excluded_processes ?? [],
          excluded_domains: body?.excluded_domains ?? current.excluded_domains ?? [],
        };
        const validationError = validatePolicyUpdate(nextPolicy);
        if (validationError) return sendError(response, 400, validationError, "invalid_policy");
        const changed = [
          ["work_hours_start", nextPolicy.work_hours_start],
          ["work_hours_end", nextPolicy.work_hours_end],
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
            `work hours=${nextPolicy.work_hours_start}-${nextPolicy.work_hours_end}; excluded processes=${nextPolicy.excluded_processes.length}; excluded domains=${nextPolicy.excluded_domains.length}`,
          );
        }
        return sendJson(response, 200, { policy: getPolicy(db) });
      }

      if (method === "GET" && url.pathname === "/api/admin/events") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 2000);
        const deviceId = url.searchParams.get("device_id");
        const scope = scopePredicate(principal);
        const conditions = [scope.sql];
        const params = [...scope.params];
        if (deviceId) { conditions.push("ev.device_id = ?"); params.push(deviceId); }
        const query = `SELECT ev.*, d.employee_id, e.name AS employee_name, d.hostname
          FROM events ev JOIN devices d ON d.id = ev.device_id JOIN employees e ON e.id = d.employee_id
          WHERE ${conditions.join(" AND ")} ORDER BY ev.occurred_at DESC LIMIT ${limit}`;
        const events = db.prepare(query).all(...params);
        return sendJson(response, 200, { events });
      }

      if (method === "GET" && url.pathname === "/api/admin/history") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 2000);
        const deviceId = url.searchParams.get("device_id") || null;
        const records = await getMemoryRecords(db, { deviceId, limit, ai, principal });
        return sendJson(response, 200, { records, generated_at: isoNow(), model: ai.model });
      }

      if (method === "GET" && url.pathname.startsWith("/api/admin/history/") && url.pathname.endsWith("/sources")) {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const recordId = decodeURIComponent(url.pathname.slice("/api/admin/history/".length, -"/sources".length));
        if (!recordId || recordId.length > 200) return sendError(response, 400, "record id is invalid", "invalid_record_id");
        const records = await getMemoryRecords(db, { limit: 2000, ai, principal });
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
        const records = await getMemoryRecords(db, { deviceId, limit, ai, principal });
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
        const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 2000);
        const deviceId = typeof body.device_id === "string" && body.device_id.trim() ? body.device_id.trim() : null;
        const requestedTeam = typeof body.team === "string" && body.team.trim() ? body.team.trim().slice(0, 120) : null;
        const effectiveTeam = principal.role === "manager" ? principal.team : principal.role === "employee" ? null : requestedTeam;
        const records = await getMemoryRecords(db, { deviceId, limit, ai, principal, team: effectiveTeam });
        const queryTimeRange = historyQueryTimeRange(body.question.trim());
        const timeScopedRecords = filterHistoryRecordsByTime(records, queryTimeRange);
        const rankedRecords = rankHistoryRecords(body.question.trim(), timeScopedRecords);
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

      if (method === "GET" && url.pathname === "/api/admin/memory/jobs") {
        const principal = requireAdmin(request, adminToken, sessionSecret);
        if (!principal) return sendError(response, 401, "admin authentication required", "unauthorized");
        const scope = scopePredicate(principal);
        const jobs = db.prepare(`
          SELECT j.id, j.summary_id, j.attempts, j.next_attempt_at, j.status, j.last_error,
            j.created_at, j.updated_at, ms.model_name, ms.record_type, ms.rollup_scope,
            e.name AS employee_name, e.team AS employee_team
          FROM memory_generation_jobs j
          JOIN memory_summaries ms ON ms.id = j.summary_id
          JOIN devices d ON d.id = ms.device_id
          JOIN employees e ON e.id = d.employee_id
          WHERE ${scope.sql}
          ORDER BY j.updated_at DESC LIMIT 500
        `).all(...scope.params);
        return sendJson(response, 200, { jobs, model: ai.model });
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
            (event_id, device_id, occurred_at, type, app_name, process_name, context_label, web_domain, duration_seconds, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            context_label = COALESCE(excluded.context_label, events.context_label),
            web_domain = COALESCE(excluded.web_domain, events.web_domain),
            duration_seconds = MAX(events.duration_seconds, excluded.duration_seconds),
            received_at = excluded.received_at
        `);
        for (const event of acceptedEvents) {
          insert.run(event.event_id, device.id, event.occurred_at, event.type, event.app_name, event.process_name, event.context_label || event.title_hint || null, event.web_domain ? event.web_domain.trim().toLowerCase() : null, event.duration_seconds, isoNow());
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
  const server = createHttpServer(createRequestHandler({ db, adminToken, sessionSecret, ai, logger }));
  let memoryWarmupRunning = false;
  const memoryMaterializationIntervalMs = Math.max(15_000, Number(process.env.MEMORY_MATERIALIZATION_INTERVAL_MS) || 60_000);
  const warmRecentMemorySummaries = async () => {
    if (memoryWarmupRunning || ai.mode !== "model") return;
    memoryWarmupRunning = true;
    try {
      await getMemoryRecords(db, { limit: 200, ai });
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
    processMemoryGenerationJobs(db, ai, logger).catch((error) => logger.warn?.(`Memory Summary worker error: ${error.message}`));
  }, 15_000);
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

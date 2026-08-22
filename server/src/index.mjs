import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

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
]);

const isoNow = () => new Date().toISOString();
const hash = (value) => createHash("sha256").update(value).digest("hex");
const newId = (prefix) => `${prefix}_${randomBytes(12).toString("hex")}`;
const newToken = () => randomBytes(32).toString("base64url");
const newRegistrationCode = () => `JY-${randomBytes(5).toString("hex").toUpperCase()}`;

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
  `);

  const employeeInsert = db.prepare(
    "INSERT OR IGNORE INTO employees (id, name, team, created_at) VALUES (?, ?, ?, ?)",
  );
  const createdAt = isoNow();
  for (const employee of defaultEmployees) employeeInsert.run(...employee, createdAt);

  const policyInsert = db.prepare("INSERT OR IGNORE INTO policies (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(defaultPolicy)) policyInsert.run(key, String(value));
}

function getPolicy(db) {
  const rows = db.prepare("SELECT key, value FROM policies").all();
  return rows.reduce((policy, row) => {
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
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-admin-token",
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

function requireAdmin(request, adminToken) {
  return request.headers["x-admin-token"] === adminToken;
}

function bearerToken(request) {
  const value = request.headers.authorization || "";
  return value.startsWith("Bearer ") ? value.slice("Bearer ".length).trim() : "";
}

function deviceFromRequest(db, request) {
  const token = bearerToken(request);
  if (!token) return null;
  return db.prepare(`
    SELECT d.*, e.name AS employee_name, e.team AS employee_team
    FROM devices d JOIN employees e ON e.id = d.employee_id
    WHERE d.token_hash = ? AND d.disabled_at IS NULL
  `).get(hash(token));
}

function recordAudit(db, action, actor, target, detail = "") {
  db.prepare(
    "INSERT INTO audit_logs (id, action, actor, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(newId("audit"), action, actor, target, detail, isoNow());
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
    if (!Number.isInteger(event.duration_seconds) || event.duration_seconds < 0 || event.duration_seconds > 86400) return "duration_seconds is invalid";
  }
  return null;
}

function formatDuration(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

function applicationKey(appName) {
  const normalized = String(appName || "").toLowerCase();
  if (normalized.includes("chrome") || normalized.includes("edge")) return "chrome";
  if (normalized.includes("code") || normalized.includes("visual studio")) return "vscode";
  if (normalized.includes("wechat") || normalized.includes("weixin") || normalized.includes("企业微信")) return "wechat";
  if (normalized.includes("notion")) return "notion";
  if (normalized.includes("figma")) return "figma";
  if (normalized.includes("finder") || normalized.includes("explorer")) return "finder";
  if (normalized.includes("codex") || normalized.includes("chatgpt")) return "codex";
  return "other";
}

function displayApplicationName(appName) {
  const normalized = String(appName || "").toLowerCase();
  if (normalized.includes("chrome")) return "Google Chrome";
  if (normalized.includes("edge")) return "Microsoft Edge";
  if (normalized.includes("code") || normalized.includes("visual studio")) return "Visual Studio Code";
  if (normalized.includes("wechat") || normalized.includes("weixin") || normalized.includes("企业微信")) return "微信/企业微信";
  if (normalized.includes("notion")) return "Notion";
  if (normalized.includes("figma")) return "Figma";
  if (normalized.includes("explorer")) return "Windows 文件资源管理器";
  if (normalized.includes("codex") || normalized.includes("chatgpt")) return "Codex";
  return appName;
}

function historyEventRows(db, deviceId) {
  const query = deviceId
    ? `SELECT ev.*, d.employee_id, e.name AS employee_name, e.team AS employee_team, d.hostname
       FROM events ev
       JOIN devices d ON d.id = ev.device_id
       JOIN employees e ON e.id = d.employee_id
       WHERE ev.device_id = ?
       ORDER BY ev.occurred_at ASC
       LIMIT 10000`
    : `SELECT ev.*, d.employee_id, e.name AS employee_name, e.team AS employee_team, d.hostname
       FROM events ev
       JOIN devices d ON d.id = ev.device_id
       JOIN employees e ON e.id = d.employee_id
       ORDER BY ev.occurred_at ASC
       LIMIT 10000`;
  const rows = deviceId ? db.prepare(query).all(deviceId) : db.prepare(query).all();
  return rows.filter((row) => !HIDDEN_AGENT_PROCESSES.has(String(row.process_name || "").toLowerCase()));
}

function buildHistoryRecords(db, { deviceId = null, limit = 200 } = {}) {
  const episodes = [];
  let current = null;

  const flush = () => {
    if (current) episodes.push(current);
    current = null;
  };

  for (const row of historyEventRows(db, deviceId)) {
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

  return episodes
    .sort((left, right) => right.startMs - left.startMs)
    .slice(0, Math.min(Math.max(Number(limit) || 200, 1), 2000))
    .map((episode) => {
      const start = new Date(episode.startMs).toISOString();
      const end = new Date(episode.endMs).toISOString();
      const durationSeconds = Math.max(0, Math.round((episode.endMs - episode.startMs) / 1000));
      const rawApplicationNames = [...new Set(episode.rows.map((row) => row.app_name))];
      const applicationNames = [...new Set(rawApplicationNames.map(displayApplicationName))];
      const applications = [...new Set(rawApplicationNames.map(applicationKey))];
      const displayApps = episode.isIdle ? ["系统空闲"] : applicationNames;
      const displayTitle = displayApps.length > 2
        ? `${episode.employeeName} · ${displayApps.slice(0, 2).join("、")} 等 ${displayApps.length} 个应用`
        : `${episode.employeeName} · ${displayApps.join("、")}`;
      const readableDuration = formatDuration(durationSeconds);
      const timeline = episode.rows.map((row) => ({
        occurred_at: row.occurred_at,
        text: row.type === "idle" ? "进入系统空闲状态" : `前台应用：${displayApplicationName(row.app_name)}`,
        app: row.type === "idle" ? "other" : applicationKey(row.app_name),
      }));
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
          : `${episode.employeeName} 在 ${displayApps.join("、")} 中连续活动 ${readableDuration}。`,
        applications,
        application_names: applicationNames,
        duration_seconds: durationSeconds,
        started_at: start,
        ended_at: end,
        summary: episode.isIdle
          ? "这是一条基于系统空闲状态生成的活动元数据记录。"
          : `${episode.employeeName} 在 ${displayApps.join("、")} 中连续活动 ${readableDuration}，期间记录到 ${episode.rows.length} 个前台应用片段。该摘要只基于活动元数据生成。`,
        prior_context: "来源于 Windows Agent 的前台应用活动采集；当前版本未读取窗口正文、聊天正文或文件正文。",
        non_obvious: "应用切换只代表活动上下文变化，不直接代表工作效率或绩效结论。",
        timeline,
        resources: [],
        citations,
        confidence: 1,
      };
    });
}

function createRequestHandler({ db, adminToken, logger = console }) {
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

      if (method === "POST" && url.pathname === "/api/admin/registration-codes") {
        if (!requireAdmin(request, adminToken)) return sendError(response, 401, "admin authentication required", "unauthorized");
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
        if (!requireAdmin(request, adminToken)) return sendError(response, 401, "admin authentication required", "unauthorized");
        const devices = db.prepare(`
          SELECT d.id, d.employee_id, e.name AS employee_name, e.team AS employee_team,
            d.hostname, d.os_version, d.agent_version, d.status, d.last_heartbeat_at,
            d.queued_events, d.created_at, d.updated_at
          FROM devices d JOIN employees e ON e.id = d.employee_id
          ORDER BY d.updated_at DESC
        `).all();
        return sendJson(response, 200, { devices });
      }

      if (method === "GET" && url.pathname === "/api/admin/events") {
        if (!requireAdmin(request, adminToken)) return sendError(response, 401, "admin authentication required", "unauthorized");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 500, 1), 2000);
        const deviceId = url.searchParams.get("device_id");
        const query = deviceId
          ? `SELECT ev.*, d.employee_id, e.name AS employee_name, d.hostname
             FROM events ev JOIN devices d ON d.id = ev.device_id JOIN employees e ON e.id = d.employee_id
             WHERE ev.device_id = ? ORDER BY ev.occurred_at DESC LIMIT ${limit}`
          : `SELECT ev.*, d.employee_id, e.name AS employee_name, d.hostname
             FROM events ev JOIN devices d ON d.id = ev.device_id JOIN employees e ON e.id = d.employee_id
             ORDER BY ev.occurred_at DESC LIMIT ${limit}`;
        const events = deviceId ? db.prepare(query).all(deviceId) : db.prepare(query).all();
        return sendJson(response, 200, { events });
      }

      if (method === "GET" && url.pathname === "/api/admin/history") {
        if (!requireAdmin(request, adminToken)) return sendError(response, 401, "admin authentication required", "unauthorized");
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 2000);
        const deviceId = url.searchParams.get("device_id") || null;
        return sendJson(response, 200, { records: buildHistoryRecords(db, { deviceId, limit }) });
      }

      if (method === "GET" && url.pathname === "/api/admin/audit") {
        if (!requireAdmin(request, adminToken)) return sendError(response, 401, "admin authentication required", "unauthorized");
        const logs = db.prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 500").all();
        return sendJson(response, 200, { logs });
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

      if (method === "GET" && url.pathname === "/api/agent/policy") {
        const device = deviceFromRequest(db, request);
        if (!device) return sendError(response, 401, "valid device token required", "unauthorized");
        return sendJson(response, 200, { policy: getPolicy(db) });
      }

      if (method === "POST" && url.pathname === "/api/agent/events") {
        const device = deviceFromRequest(db, request);
        if (!device) return sendError(response, 401, "valid device token required", "unauthorized");
        const body = await readJson(request);
        const validationError = validateEvents(body);
        if (validationError) return sendError(response, 400, validationError);
        const insert = db.prepare(`
          INSERT OR IGNORE INTO events
            (event_id, device_id, occurred_at, type, app_name, process_name, duration_seconds, received_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const event of body.events) {
          insert.run(event.event_id, device.id, event.occurred_at, event.type, event.app_name, event.process_name, event.duration_seconds, isoNow());
        }
        db.prepare("UPDATE devices SET status = 'online', last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(isoNow(), isoNow(), device.id);
        return sendJson(response, 202, { accepted: body.events.length, duplicate_safe: true });
      }

      if (method === "POST" && url.pathname === "/api/agent/heartbeat") {
        const device = deviceFromRequest(db, request);
        if (!device) return sendError(response, 401, "valid device token required", "unauthorized");
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

export function createAgentServer({ dbPath = process.env.AGENT_DB_PATH || defaultDbPath, adminToken = process.env.AGENT_ADMIN_TOKEN || `admin_${randomBytes(18).toString("base64url")}`, logger = console } = {}) {
  mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(resolve(dbPath));
  createSchema(db);
  const server = createHttpServer(createRequestHandler({ db, adminToken, logger }));
  return {
    db,
    server,
    adminToken,
    listen(port = Number(process.env.PORT) || 8787, host = process.env.HOST || "0.0.0.0") {
      return new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => resolvePromise(server.address()));
      });
    },
    close() {
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
  });
}

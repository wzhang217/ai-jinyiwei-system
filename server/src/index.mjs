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

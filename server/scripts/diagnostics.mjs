import { mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = resolve(process.env.AGENT_DB_PATH || "./data/agent.sqlite");
const storagePath = dirname(dbPath);
const minimumFreeBytes = Math.max(0, Number(process.env.DISK_MIN_FREE_BYTES) || 1_073_741_824);
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 && process.argv[outputIndex + 1]
  ? resolve(process.argv[outputIndex + 1])
  : null;

const redact = (value) => String(value || "")
  .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
  .replace(/(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
  .replace(/sk-[A-Za-z0-9_-]+/g, "sk-[REDACTED]");

const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const scalar = (sql, fallback = 0) => {
    try {
      const row = db.prepare(sql).get();
      return Number(Object.values(row || {})[0] ?? fallback);
    } catch {
      return fallback;
    }
  };
  const text = (sql) => {
    try {
      const row = db.prepare(sql).get();
      return Object.values(row || {})[0] ?? null;
    } catch {
      return null;
    }
  };
  const integrity = text("PRAGMA quick_check") || "unknown";
  const schemaVersion = scalar("SELECT COALESCE(MAX(version), 0) FROM schema_migrations");
  const expectedSchemaVersion = 7;
  let storage = { path: storagePath, free_bytes: null, total_bytes: null, minimum_free_bytes: minimumFreeBytes, ready: false };
  try {
    const filesystem = statfsSync(storagePath);
    const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
    const totalBytes = Number(filesystem.blocks) * Number(filesystem.bsize);
    storage = { ...storage, free_bytes: freeBytes, total_bytes: totalBytes, ready: freeBytes >= minimumFreeBytes };
  } catch (error) {
    storage.error = redact(error.message).slice(0, 200);
  }
  const recentJobErrors = db.prepare(`
    SELECT status, attempts, last_error, updated_at
    FROM memory_generation_jobs
    WHERE last_error IS NOT NULL AND last_error <> ''
    ORDER BY updated_at DESC LIMIT 5
  `).all().map((item) => ({
    status: item.status,
    attempts: Number(item.attempts || 0),
    error: redact(item.last_error).slice(0, 300),
    updated_at: item.updated_at,
  }));
  const report = {
    generated_at: new Date().toISOString(),
    service: "ai-jinyiwei-agent-server",
    node: process.version,
    pid: process.pid,
    db_path: dbPath,
    database: {
      integrity_check: integrity,
      ready: integrity === "ok" && schemaVersion === expectedSchemaVersion && storage.ready,
      schema_version: schemaVersion,
      expected_schema_version: expectedSchemaVersion,
      organizations: scalar("SELECT COUNT(*) FROM organizations"),
      accounts: scalar("SELECT COUNT(*) FROM user_accounts"),
      employees: scalar("SELECT COUNT(*) FROM employees"),
      devices: scalar("SELECT COUNT(*) FROM devices"),
      online_devices: scalar("SELECT COUNT(*) FROM devices WHERE status = 'online'"),
      queued_generation_jobs: scalar("SELECT COUNT(*) FROM memory_generation_jobs WHERE status IN ('queued', 'retrying', 'running')"),
      failed_generation_jobs: scalar("SELECT COUNT(*) FROM memory_generation_jobs WHERE status = 'failed'"),
      events: scalar("SELECT COUNT(*) FROM events"),
      memory_summaries: scalar("SELECT COUNT(*) FROM memory_summaries"),
      audit_entries: scalar("SELECT COUNT(*) FROM audit_logs"),
      ai_usage_entries: scalar("SELECT COUNT(*) FROM ai_usage"),
      newest_event_at: text("SELECT MAX(received_at) FROM events"),
      newest_heartbeat_at: text("SELECT MAX(last_heartbeat_at) FROM devices"),
    },
    storage,
    configuration: {
      host: process.env.HOST || "127.0.0.1",
      port: Number(process.env.PORT) || 8787,
      cors_origin_configured: Boolean(process.env.AGENT_CORS_ORIGIN),
      bootstrap_token_allowed: process.env.AGENT_ALLOW_BOOTSTRAP_TOKEN === "true",
      ai_enabled: process.env.AI_ENABLED !== "false",
      ai_model: process.env.AI_MODEL || "qwen3.7-plus",
      backup_dir: resolve(process.env.AGENT_BACKUP_DIR || "./data/backups"),
    },
    recent_job_errors: recentJobErrors,
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, output: outputPath, ready: report.database.ready }));
  } else {
    process.stdout.write(serialized);
  }
  if (!report.database.ready) process.exitCode = 1;
} finally {
  db.close();
}

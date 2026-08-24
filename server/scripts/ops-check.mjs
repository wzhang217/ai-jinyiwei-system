import { statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CURRENT_SCHEMA_VERSION } from "../src/index.mjs";

const host = process.env.HEALTHCHECK_HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8787;
const dbPath = resolve(process.env.AGENT_DB_PATH || "./data/agent.sqlite");
const minimumFreeBytes = Math.max(0, Number(process.env.DISK_MIN_FREE_BYTES) || 1_073_741_824);
const checks = [];

function addCheck(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail });
}

try {
  const response = await fetch(`http://${host}:${port}/health/ready`, { signal: AbortSignal.timeout(5_000) });
  const body = await response.json().catch(() => ({}));
  addCheck(
    "service_ready",
    response.ok && body.ok === true && Number(body.schema_version) >= Number(body.expected_schema_version),
    { status: response.status, schema_version: body.schema_version ?? null, expected_schema_version: body.expected_schema_version ?? null },
  );
} catch (error) {
  addCheck("service_ready", false, { error: String(error.message || error).slice(0, 200) });
}

try {
  const filesystem = statfsSync(dirname(dbPath));
  const freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
  addCheck("storage", freeBytes >= minimumFreeBytes, { free_bytes: freeBytes, minimum_free_bytes: minimumFreeBytes });
} catch (error) {
  addCheck("storage", false, { error: String(error.message || error).slice(0, 200) });
}

try {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown";
    const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
    const hasMigrationTable = Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get());
    const schemaVersion = hasMigrationTable
      ? Number(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version || 0)
      : 0;
    addCheck("database", integrity === "ok" && foreignKeys.length === 0 && hasMigrationTable && schemaVersion >= CURRENT_SCHEMA_VERSION, {
      integrity_check: integrity,
      foreign_key_violations: foreignKeys.length,
      schema_version: schemaVersion,
      expected_schema_version: CURRENT_SCHEMA_VERSION,
    });
  } finally {
    db.close();
  }
} catch (error) {
  addCheck("database", false, { error: String(error.message || error).slice(0, 200), path: dbPath });
}

const report = {
  ok: checks.every((check) => check.ok),
  generated_at: new Date().toISOString(),
  service: "ai-jinyiwei-agent-server",
  checks,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

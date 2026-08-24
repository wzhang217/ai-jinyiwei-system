import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const inputPath = process.env.AGENT_RESTORE_PATH || process.argv[2];
if (!inputPath) throw new Error("provide a backup path via AGENT_RESTORE_PATH or the first argument");
const candidate = resolve(inputPath);
if (!statSync(candidate, { throwIfNoEntry: false })) throw new Error(`backup not found: ${candidate}`);

const db = new DatabaseSync(candidate);
try {
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") throw new Error(`integrity_check failed: ${integrity || "unknown result"}`);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) throw new Error(`foreign_key_check failed: ${foreignKeys.length} violation(s)`);
  const hasMigrationTable = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const schemaVersion = hasMigrationTable
    ? db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()?.version || 0
    : 0;
  console.log(JSON.stringify({ ok: true, path: candidate, schema_version: Number(schemaVersion) }));
} finally {
  db.close();
}

import { mkdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";

const source = resolve(process.env.AGENT_DB_PATH || "./data/agent.sqlite");
const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
const destination = resolve(process.env.AGENT_BACKUP_PATH || `./data/backups/agent-${stamp}.sqlite`);

if (!statSync(source, { throwIfNoEntry: false })) throw new Error(`database not found: ${source}`);
if (source === destination) throw new Error("backup destination must differ from the source database");
mkdirSync(dirname(destination), { recursive: true });

function verifyDatabase(db, label) {
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
  if (integrity !== "ok") throw new Error(`${label} integrity_check failed: ${integrity || "unknown result"}`);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) throw new Error(`${label} foreign_key_check failed: ${foreignKeys.length} violation(s)`);
}

const db = new DatabaseSync(source);
try {
  verifyDatabase(db, "source database");
  const escaped = destination.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
} finally {
  db.close();
}

const backup = new DatabaseSync(destination);
try {
  verifyDatabase(backup, "backup database");
  console.log(`Database backup created and verified: ${destination}`);
} finally {
  backup.close();
}

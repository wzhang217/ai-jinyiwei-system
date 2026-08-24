import { mkdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";

const source = resolve(process.env.AGENT_DB_PATH || "./data/agent.sqlite");
const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
const destination = resolve(process.env.AGENT_BACKUP_PATH || `./data/backups/agent-${stamp}.sqlite`);

if (!statSync(source, { throwIfNoEntry: false })) throw new Error(`database not found: ${source}`);
mkdirSync(dirname(destination), { recursive: true });
const db = new DatabaseSync(source);
try {
  const escaped = destination.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  console.log(`Database backup created: ${destination}`);
} finally {
  db.close();
}

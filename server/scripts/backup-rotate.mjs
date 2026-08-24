import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";

const backupDir = resolve(process.env.AGENT_BACKUP_DIR || "./data/backups");
const retentionDays = Math.min(Math.max(Number(process.env.AGENT_BACKUP_RETENTION_DAYS) || 14, 1), 3650);
mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replaceAll(/[-:.TZ]/g, "").slice(0, 14);
process.env.AGENT_BACKUP_PATH = process.env.AGENT_BACKUP_PATH || join(backupDir, `agent-${stamp}.sqlite`);

// Reuse the same integrity_check, foreign_key_check and VACUUM INTO path as
// the manual backup command, then rotate only verified SQLite backup files.
await import("./backup.mjs");

const cutoff = Date.now() - retentionDays * 24 * 3600_000;
const candidates = readdirSync(backupDir)
  .filter((name) => /^agent-\d{14}\.sqlite$/.test(name))
  .map((name) => {
    const path = join(backupDir, name);
    return { name, path, modifiedAt: statSync(path).mtimeMs };
  })
  .sort((left, right) => right.modifiedAt - left.modifiedAt);

let removed = 0;
for (const candidate of candidates) {
  if (candidate.modifiedAt < cutoff) {
    unlinkSync(candidate.path);
    removed += 1;
  }
}

console.log(JSON.stringify({ ok: true, backup_dir: backupDir, retention_days: retentionDays, retained: candidates.length - removed, removed }));

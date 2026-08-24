import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentServer, recordAudit } from "../src/index.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (!value.startsWith("--")) continue;
  const [key, inlineValue] = value.slice(2).split("=", 2);
  const nextValue = inlineValue ?? process.argv[index + 1];
  if (inlineValue === undefined && nextValue && !nextValue.startsWith("--")) index += 1;
  args.set(key, nextValue || "");
}

const pick = (name, envName, fallback = "") => String(args.get(name) || process.env[envName] || fallback).trim();
const organizationId = pick("organization-id", "DIRECTORY_IMPORT_ORGANIZATION_ID");
const fileName = pick("file", "DIRECTORY_IMPORT_FILE");
const dryRun = args.has("dry-run") && String(args.get("dry-run")).toLowerCase() !== "false";

if (!organizationId) throw new Error("--organization-id or DIRECTORY_IMPORT_ORGANIZATION_ID is required");
if (!fileName) throw new Error("--file or DIRECTORY_IMPORT_FILE is required");

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  if (quoted) throw new Error("directory CSV contains an unterminated quoted field");
  values.push(value.trim());
  return values;
}

function parseCsv(contents) {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase());
  if (!headers.includes("employee_id") || !headers.includes("name") || !headers.includes("team")) {
    throw new Error("directory CSV headers must include employee_id,name,team");
  }
  return lines.slice(1).map((line, lineIndex) => {
    const values = parseCsvLine(line);
    if (values.length > headers.length) throw new Error(`directory CSV row ${lineIndex + 2} has too many columns`);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

function parseDirectory(contents, filePath) {
  const trimmed = contents.trim();
  if (!trimmed) return [];
  if (filePath.toLowerCase().endsWith(".json") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : parsed?.employees;
    if (!Array.isArray(rows)) throw new Error("directory JSON must be an array or an object with an employees array");
    return rows;
  }
  return parseCsv(contents);
}

function normalizeRow(row, index) {
  const employeeId = String(row.employee_id ?? row.id ?? "").trim();
  const name = String(row.name ?? "").trim();
  const team = String(row.team ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,159}$/.test(employeeId)) {
    throw new Error(`directory row ${index + 1} has an invalid employee_id`);
  }
  if (!name || name.length > 160) throw new Error(`directory row ${index + 1} has an invalid name`);
  if (!team || team.length > 160) throw new Error(`directory row ${index + 1} has an invalid team`);
  return { employeeId, name, team };
}

const filePath = resolve(fileName);
const rows = parseDirectory(await readFile(filePath, "utf8"), filePath).map(normalizeRow);
const ids = new Set();
for (const row of rows) {
  if (ids.has(row.employeeId)) throw new Error(`directory contains duplicate employee_id: ${row.employeeId}`);
  ids.add(row.employeeId);
}

const app = createAgentServer({ dbPath: process.env.AGENT_DB_PATH });
try {
  const { db } = app;
  const organization = db.prepare("SELECT id, disabled_at FROM organizations WHERE id = ?").get(organizationId);
  if (!organization) throw new Error("organization not found");
  if (organization.disabled_at) throw new Error("organization is disabled");

  const existing = db.prepare("SELECT id, organization_id FROM employees WHERE id = ?");
  const insert = db.prepare("INSERT INTO employees (id, name, team, organization_id, created_at) VALUES (?, ?, ?, ?, ?)");
  const update = db.prepare("UPDATE employees SET name = ?, team = ? WHERE id = ? AND organization_id = ?");
  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const current = existing.get(row.employeeId);
      if (current && current.organization_id !== organizationId) {
        throw new Error(`employee_id belongs to another organization: ${row.employeeId}`);
      }
      if (current) {
        update.run(row.name, row.team, row.employeeId, organizationId);
        updated += 1;
      } else {
        insert.run(row.employeeId, row.name, row.team, organizationId, now);
        created += 1;
      }
    }
    if (dryRun) {
      db.exec("ROLLBACK");
    } else {
      recordAudit(db, "directory_imported", "directory-import", organizationId, `rows=${rows.length};created=${created};updated=${updated}`, organizationId);
      db.exec("COMMIT");
    }
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }

  console.log(JSON.stringify({ ok: true, dry_run: dryRun, organization_id: organizationId, rows: rows.length, created, updated }));
} finally {
  await app.close();
}

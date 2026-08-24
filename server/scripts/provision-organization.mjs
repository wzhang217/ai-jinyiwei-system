import { randomBytes } from "node:crypto";
import { createAgentServer, ensureOrganizationConfiguration, hashAccountPassword, recordAudit } from "../src/index.mjs";

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
const organizationId = pick("organization-id", "PROVISION_ORGANIZATION_ID", `org_${randomBytes(8).toString("hex")}`).toLowerCase();
const organizationName = pick("organization-name", "PROVISION_ORGANIZATION_NAME");
const organizationSlug = pick("organization-slug", "PROVISION_ORGANIZATION_SLUG").toLowerCase();
const adminUsername = pick("admin-username", "PROVISION_ADMIN_USERNAME").toLowerCase();
const adminDisplayName = pick("admin-display-name", "PROVISION_ADMIN_DISPLAY_NAME", "企业老板");
const adminPassword = String(process.env.PROVISION_ADMIN_PASSWORD || "");

if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(organizationId)) throw new Error("organization id must be 3-64 lowercase letters, numbers, hyphen, or underscore");
if (!organizationName || organizationName.length > 160) throw new Error("PROVISION_ORGANIZATION_NAME or --organization-name is required and must be <= 160 characters");
if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(organizationSlug)) throw new Error("PROVISION_ORGANIZATION_SLUG or --organization-slug must be 3-64 lowercase letters, numbers, or hyphens");
if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(adminUsername)) throw new Error("PROVISION_ADMIN_USERNAME or --admin-username must be 3-64 lowercase letters, numbers, dot, underscore, or hyphen");
if (!adminDisplayName || adminDisplayName.length > 120) throw new Error("admin display name is required and must be <= 120 characters");
const passwordHash = hashAccountPassword(adminPassword);

const app = createAgentServer({ dbPath: process.env.AGENT_DB_PATH });
try {
  const { db } = app;
  const now = new Date().toISOString();
  if (db.prepare("SELECT id FROM organizations WHERE id = ? OR slug = ?").get(organizationId, organizationSlug)) {
    throw new Error("organization id or slug already exists");
  }
  if (db.prepare("SELECT id FROM user_accounts WHERE username = ?").get(adminUsername)) {
    throw new Error("admin username already exists");
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(organizationId, organizationName, organizationSlug, now, now);
    ensureOrganizationConfiguration(db, organizationId, now);
    const accountId = `account_${randomBytes(12).toString("hex")}`;
    db.prepare(`
      INSERT INTO user_accounts
        (id, username, display_name, role, employee_id, team, organization_id, password_hash, created_at, updated_at, password_changed_at)
      VALUES (?, ?, ?, 'admin', NULL, NULL, ?, ?, ?, ?, ?)
    `).run(accountId, adminUsername, adminDisplayName, organizationId, passwordHash, now, now, now);
    recordAudit(db, "organization_provisioned", "provisioning-cli", organizationId, `slug=${organizationSlug}; owner=${adminUsername}`, organizationId);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }

  console.log(JSON.stringify({
    ok: true,
    organization: { id: organizationId, name: organizationName, slug: organizationSlug },
    owner: { username: adminUsername, display_name: adminDisplayName, role: "admin" },
    password_source: "PROVISION_ADMIN_PASSWORD",
  }));
} finally {
  await app.close();
}

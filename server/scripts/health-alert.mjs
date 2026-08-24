import { mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const host = process.env.HEALTHCHECK_HOST || "127.0.0.1";
const port = Number(process.env.PORT) || 8787;
const endpoint = `http://${host}:${port}/health/ready`;
const dbPath = resolve(process.env.AGENT_DB_PATH || "./data/agent.sqlite");
const statePath = resolve(process.env.HEALTH_ALERT_STATE_PATH || `${dirname(dbPath)}/health-alert-state.json`);
const cooldownSeconds = Math.max(60, Number(process.env.HEALTH_ALERT_COOLDOWN_SECONDS) || 1800);
const webhookUrl = String(process.env.HEALTH_ALERT_WEBHOOK_URL || "").trim();

let responseStatus = 0;
let responseBody = {};
let failure = "";
try {
  const response = await fetch(endpoint);
  responseStatus = response.status;
  responseBody = await response.json().catch(() => ({}));
  if (!response.ok || !responseBody.ok || Number(responseBody.schema_version) !== Number(responseBody.expected_schema_version)) {
    failure = `readiness check failed (${responseStatus})`;
  }
} catch (error) {
  failure = `readiness endpoint unavailable: ${error.message}`;
}

let freeBytes = null;
try {
  const filesystem = statfsSync(dirname(dbPath));
  freeBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
} catch {
  // The readiness response remains the authoritative signal if the DB path is
  // temporarily unavailable.
}

const now = Date.now();
let previous = {};
try {
  previous = JSON.parse(readFileSync(statePath, "utf8"));
} catch {
  previous = {};
}
const alert = {
  type: "ai-jinyiwei-agent-health-failure",
  occurred_at: new Date(now).toISOString(),
  endpoint,
  failure: failure || "unknown readiness failure",
  http_status: responseStatus || null,
  response: responseBody,
  storage_free_bytes: freeBytes,
};

if (previous.last_sent_at && now - Number(previous.last_sent_at) < cooldownSeconds * 1000) {
  console.error(JSON.stringify({ ...alert, suppressed: true, next_alert_at: new Date(Number(previous.last_sent_at) + cooldownSeconds * 1000).toISOString() }));
  process.exit(0);
}

console.error(JSON.stringify(alert));
if (webhookUrl) {
  const webhookResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `[AI锦衣卫] 服务健康检查失败\n${alert.failure}`, alert }),
  });
  if (!webhookResponse.ok) throw new Error(`health alert webhook returned ${webhookResponse.status}`);
}

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify({ last_sent_at: now, last_failure: alert.failure }, null, 2));
if (!webhookUrl) console.error("HEALTH_ALERT_WEBHOOK_URL is not configured; failure was written to the service journal only");

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentServer } from "../src/index.mjs";

async function withServer(callback) {
  const dir = await mkdtemp(join(tmpdir(), "ai-jinyiwei-server-"));
  const app = createAgentServer({ dbPath: join(dir, "agent.sqlite"), adminToken: "test-admin", logger: { error() {} } });
  const address = await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    return await callback({ base, app });
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  return { response, body: await response.json() };
}

test("enrolls a device and accepts idempotent events and heartbeats", async () => {
  await withServer(async ({ base }) => {
    const preflight = await fetch(`${base}/api/admin/devices`, { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");

    const codeResult = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: { "x-admin-token": "test-admin" },
      body: JSON.stringify({ employee_id: "employee-chen" }),
    });
    assert.equal(codeResult.response.status, 201);

    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({
        registration_code: codeResult.body.code,
        hostname: "WIN-TEST-01",
        os_version: "Windows 11 Pro",
        agent_version: "0.1.0",
      }),
    });
    assert.equal(enrolled.response.status, 201);
    assert.equal(enrolled.body.employee.id, "employee-chen");

    const event = {
      event_id: "event-1",
      occurred_at: new Date().toISOString(),
      type: "app_session",
      app_name: "Visual Studio Code",
      process_name: "Code.exe",
      duration_seconds: 42,
    };
    const headers = { authorization: `Bearer ${enrolled.body.device_token}` };
    const first = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers, body: JSON.stringify({ events: [event] }) });
    const duplicate = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers, body: JSON.stringify({ events: [event] }) });
    assert.equal(first.response.status, 202);
    assert.equal(duplicate.response.status, 202);

    const heartbeat = await jsonFetch(`${base}/api/agent/heartbeat`, { method: "POST", headers, body: JSON.stringify({ agent_version: "0.1.0", queued_events: 0 }) });
    assert.equal(heartbeat.response.status, 200);

    const devices = await jsonFetch(`${base}/api/admin/devices`, { headers: { "x-admin-token": "test-admin" } });
    const events = await jsonFetch(`${base}/api/admin/events`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(devices.body.devices.length, 1);
    assert.equal(devices.body.devices[0].status, "online");
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].process_name, "Code.exe");
  });
});

test("rejects invalid, expired, and reused registration codes", async () => {
  await withServer(async ({ base }) => {
    const invalid = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: "JY-NOT-REAL", hostname: "WIN", os_version: "Windows", agent_version: "0.1.0" }),
    });
    assert.equal(invalid.response.status, 400);

    const codeResult = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: { "x-admin-token": "test-admin" },
      body: JSON.stringify({ employee_id: "employee-wei", expires_in_seconds: 60 }),
    });
    const payload = { registration_code: codeResult.body.code, hostname: "WIN-TEST-02", os_version: "Windows 10", agent_version: "0.1.0" };
    const first = await jsonFetch(`${base}/api/agent/enroll`, { method: "POST", body: JSON.stringify(payload) });
    const second = await jsonFetch(`${base}/api/agent/enroll`, { method: "POST", body: JSON.stringify(payload) });
    assert.equal(first.response.status, 201);
    assert.equal(second.response.status, 400);
  });
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentServer, processMemoryGenerationJobs, rankHistoryRecords } from "../src/index.mjs";
import { createAiService } from "../src/ai.mjs";

async function withServer(callback, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ai-jinyiwei-server-"));
  const app = createAgentServer({ dbPath: join(dir, "agent.sqlite"), adminToken: "test-admin", logger: { error() {}, warn() {} }, ...options });
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

test("ranks relevant Memory Summary records before History Skill context", () => {
  const ranked = rankHistoryRecords("GitHub 项目", [
    {
      id: "wps-record",
      title: "Wei · WPS Office",
      application_names: ["WPS Office"],
      context_labels: [],
      web_domains: [],
      started_at: "2026-08-23T10:00:00.000Z",
    },
    {
      id: "github-record",
      title: "Wei · 项目：AI锦衣卫系统",
      application_names: ["Google Chrome"],
      context_labels: ["项目：AI锦衣卫系统", "来源：GitHub"],
      web_domains: ["github.com"],
      started_at: "2026-08-23T09:00:00.000Z",
    },
  ]);
  assert.equal(ranked[0].id, "github-record");
});

test("enrolls a device and accepts idempotent events and heartbeats", async () => {
  await withServer(async ({ base, app }) => {
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
      context_label: "项目：AI锦衣卫系统",
      duration_seconds: 42,
    };
    const headers = { authorization: `Bearer ${enrolled.body.device_token}` };
    const rejectedDomain = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [{ ...event, event_id: "event-invalid-domain", web_domain: "github.com/path" }] }),
    });
    assert.equal(rejectedDomain.response.status, 400);
    const first = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers, body: JSON.stringify({ events: [event] }) });
    const duplicate = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers, body: JSON.stringify({ events: [event] }) });
    const checkpoint = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers, body: JSON.stringify({ events: [{ ...event, duration_seconds: 120 }] }) });
    assert.equal(first.response.status, 202);
    assert.equal(duplicate.response.status, 202);
    assert.equal(checkpoint.response.status, 202);

    const adjacentEvent = {
      event_id: "event-2",
      occurred_at: new Date(Date.now() - 1_000).toISOString(),
      type: "app_session",
      app_name: "Google Chrome",
      process_name: "chrome.exe",
      title_hint: "来源：GitHub",
      web_domain: "github.com",
      duration_seconds: 60,
    };
    const adjacent = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers, body: JSON.stringify({ events: [adjacentEvent] }) });
    assert.equal(adjacent.response.status, 202);

    const earlierEvent = {
      event_id: "event-0",
      occurred_at: new Date(Date.now() - 20 * 60_000).toISOString(),
      type: "app_session",
      app_name: "Windows Explorer",
      process_name: "explorer.exe",
      duration_seconds: 60,
    };
    const earlier = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers, body: JSON.stringify({ events: [earlierEvent] }) });
    assert.equal(earlier.response.status, 202);

    const heartbeat = await jsonFetch(`${base}/api/agent/heartbeat`, { method: "POST", headers, body: JSON.stringify({ agent_version: "0.1.0", queued_events: 0 }) });
    assert.equal(heartbeat.response.status, 200);

    const devices = await jsonFetch(`${base}/api/admin/devices`, { headers: { "x-admin-token": "test-admin" } });
    const employees = await jsonFetch(`${base}/api/admin/employees`, { headers: { "x-admin-token": "test-admin" } });
    const teams = await jsonFetch(`${base}/api/admin/teams`, { headers: { "x-admin-token": "test-admin" } });
    const events = await jsonFetch(`${base}/api/admin/events`, { headers: { "x-admin-token": "test-admin" } });
    const history = await jsonFetch(`${base}/api/admin/history`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(devices.body.devices.length, 1);
    assert.equal(devices.body.devices[0].status, "online");
    assert.ok(employees.body.employees.some((employee) => employee.id === "employee-chen" && employee.device_count === 1));
    assert.ok(teams.body.teams.some((team) => team.name === "研发与产品中心" && team.member_count >= 2));
    app.db.prepare("UPDATE devices SET status = 'online', last_heartbeat_at = ? WHERE id = ?").run(new Date(Date.now() - 10 * 60_000).toISOString(), enrolled.body.device_id);
    const staleDevices = await jsonFetch(`${base}/api/admin/devices`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(staleDevices.body.devices[0].status, "offline");
    const recovered = await jsonFetch(`${base}/api/agent/heartbeat`, { method: "POST", headers, body: JSON.stringify({ agent_version: "0.1.0", queued_events: 0 }) });
    assert.equal(recovered.body.ok, true);
    const recoveredDevices = await jsonFetch(`${base}/api/admin/devices`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(recoveredDevices.body.devices[0].status, "online");
    const audit = await jsonFetch(`${base}/api/admin/audit`, { headers: { "x-admin-token": "test-admin" } });
    assert.ok(audit.body.logs.some((log) => log.action === "agent_offline"));
    assert.ok(audit.body.logs.some((log) => log.action === "agent_online"));
    assert.equal(events.body.events.length, 3);
    assert.equal(events.body.events[0].process_name, "Code.exe");
    assert.equal(events.body.events[0].duration_seconds, 120);
    assert.equal(history.body.records.filter((record) => record.record_type === "leaf").length, 2);
    assert.ok(history.body.records.some((record) => record.record_type === "rollup" && record.rollup_scope === "window"));
    assert.ok(history.body.records.some((record) => record.record_type === "rollup" && record.rollup_scope === "hourly"));
    assert.ok(history.body.records.some((record) => record.record_type === "rollup" && record.rollup_scope === "daily"));
    assert.ok(history.body.records.some((record) => record.record_type === "rollup" && record.rollup_scope === "weekly"));
    assert.ok(history.body.records.some((record) => record.record_type === "rollup" && record.rollup_scope === "team_weekly"));
    const leaf = history.body.records.find((record) => record.record_type === "leaf");
    const rollup = history.body.records.find((record) => record.record_type === "rollup" && record.rollup_scope === "window");
    assert.deepEqual(leaf.applications.sort(), ["chrome", "vscode"]);
    assert.deepEqual(leaf.context_kinds.sort(), ["开发", "浏览器"]);
    assert.equal(leaf.context_switches, 1);
    assert.deepEqual(leaf.context_labels.sort(), ["来源：GitHub", "项目：AI锦衣卫系统"]);
    assert.deepEqual(leaf.web_domains, ["github.com"]);
    assert.ok(leaf.timeline.some((item) => item.text.includes("域名：github.com")));
    assert.match(leaf.title, /Chen/);
    assert.deepEqual(leaf.source_event_ids.sort(), ["event-1", "event-2"]);
    assert.equal(rollup.record_type, "rollup");
    assert.equal(rollup.source_record_ids.length, 2);
    assert.ok(rollup.source_record_ids.includes(leaf.id));
    const summaryCount = app.db.prepare("SELECT COUNT(*) AS count FROM memory_summaries").get().count;
    assert.ok(summaryCount >= 7);
    const storedColumns = app.db.prepare("SELECT title, summary, prior_context, important_context, period_start, period_end, source_event_ids, citations, citations_json FROM memory_summaries WHERE id = ?").get(leaf.id);
    assert.equal(storedColumns.title, leaf.title);
    assert.equal(storedColumns.summary, leaf.summary);
    assert.equal(storedColumns.prior_context, leaf.prior_context);
    assert.equal(storedColumns.important_context, leaf.non_obvious);
    assert.equal(storedColumns.period_start, leaf.started_at);
    assert.equal(storedColumns.period_end, leaf.ended_at);
    assert.deepEqual(JSON.parse(storedColumns.source_event_ids).sort(), leaf.source_event_ids.sort());
    assert.deepEqual(JSON.parse(storedColumns.citations), leaf.citations);
    assert.deepEqual(JSON.parse(storedColumns.citations_json), leaf.citations);
    const exported = await jsonFetch(`${base}/api/admin/history/export`, { method: "POST", headers: { "x-admin-token": "test-admin" }, body: JSON.stringify({ record_ids: [leaf.id] }) });
    assert.equal(exported.response.status, 200);
    assert.deepEqual(exported.body.records.map((record) => record.id), [leaf.id]);
    const exportAudit = await jsonFetch(`${base}/api/admin/audit`, { headers: { "x-admin-token": "test-admin" } });
    assert.ok(exportAudit.body.logs.some((log) => log.action === "history_exported"));

    const secondHistory = await jsonFetch(`${base}/api/admin/history`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(secondHistory.body.records[0].summary_status, "fallback");
    assert.equal(app.db.prepare("SELECT COUNT(*) AS count FROM memory_summaries").get().count, summaryCount);

    const answer = await jsonFetch(`${base}/api/admin/history/ask`, {
      method: "POST",
      headers: { "x-admin-token": "test-admin" },
      body: JSON.stringify({ question: "最近主要做了什么？" }),
    });
    assert.equal(answer.response.status, 200);
    assert.equal(answer.body.evidence.length, 3);
    assert.ok(answer.body.evidence.some((record) => record.id === leaf.id));
    assert.equal(answer.body.model, "rules-v1");
    assert.ok(Array.isArray(answer.body.applications));
    assert.ok(Array.isArray(answer.body.context_labels));
    assert.ok(Array.isArray(answer.body.web_domains));
    assert.ok(Array.isArray(answer.body.citations));
    assert.ok(answer.body.citations.some((citation) => citation.label === "WIN-TEST-01"));
    assert.ok(Array.isArray(answer.body.resources));
    assert.ok(answer.body.time_range?.start);
    assert.ok(answer.body.time_range?.end);
    assert.match(answer.body.time_range.start, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(answer.body.time_range.end, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(answer.body.uncertainty, /效率|绩效/);
    const askAudit = await jsonFetch(`${base}/api/admin/audit`, { headers: { "x-admin-token": "test-admin" } });
    const historyAskLog = askAudit.body.logs.find((log) => log.action === "history_asked");
    assert.ok(historyAskLog);
    assert.match(historyAskLog.detail, /question_length=|evidence=/);
    assert.doesNotMatch(historyAskLog.detail, /最近主要做了什么/);

    const invalidQuestion = await jsonFetch(`${base}/api/admin/history/ask`, {
      method: "POST",
      headers: { "x-admin-token": "test-admin" },
      body: JSON.stringify({ question: "" }),
    });
    assert.equal(invalidQuestion.response.status, 400);
  });
});

test("allows an admin to configure 24-hour collection", async () => {
  await withServer(async ({ base }) => {
    const headers = { "x-admin-token": "test-admin" };
    const initial = await jsonFetch(`${base}/api/admin/policy`, { headers });
    assert.equal(initial.response.status, 200);
    assert.deepEqual(
      { start: initial.body.policy.work_hours_start, end: initial.body.policy.work_hours_end },
      { start: "09:00", end: "18:00" },
    );

    const updated = await jsonFetch(`${base}/api/admin/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ work_hours_start: "00:00", work_hours_end: "24:00" }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.policy.work_hours_start, "00:00");
    assert.equal(updated.body.policy.work_hours_end, "24:00");
    assert.equal(updated.body.policy.version, 2);

    const invalid = await jsonFetch(`${base}/api/admin/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ work_hours_start: "18:00", work_hours_end: "09:00" }),
    });
    assert.equal(invalid.response.status, 400);
  });
});

test("filters History Skill evidence by the requested time range", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-TIME-RANGE", os_version: "Windows 11", agent_version: "0.1.3" }),
    });
    const headers = { authorization: `Bearer ${enrolled.body.device_token}` };
    const now = Date.now();
    for (const [eventId, occurredAt, appName] of [
      ["today-event", new Date(now - 5 * 60_000).toISOString(), "Visual Studio Code"],
      ["old-event", new Date(now - 3 * 24 * 3600_000).toISOString(), "WPS"],
    ]) {
      const result = await jsonFetch(`${base}/api/agent/events`, {
        method: "POST",
        headers,
        body: JSON.stringify({ events: [{ event_id: eventId, occurred_at: occurredAt, type: "app_session", app_name: appName, process_name: `${appName}.exe`, duration_seconds: 60 }] }),
      });
      assert.equal(result.response.status, 202);
    }
    const answer = await jsonFetch(`${base}/api/admin/history/ask`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ question: "今天主要做了什么？" }),
    });
    assert.equal(answer.response.status, 200);
    assert.equal(answer.body.query_time_range.label, "今天");
    assert.ok(answer.body.evidence.length >= 1);
    assert.ok(answer.body.evidence.every((record) => record.started_at >= answer.body.query_time_range.start && record.started_at < answer.body.query_time_range.end));
    assert.ok(!answer.body.evidence.some((record) => record.title.includes("WPS")));
  });
});

test("keeps History Skill answers inside the requested team scope", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    async function enroll(employeeId, hostname, eventId, appName) {
      const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ employee_id: employeeId }),
      });
      const device = await jsonFetch(`${base}/api/agent/enroll`, {
        method: "POST",
        body: JSON.stringify({ registration_code: code.body.code, hostname, os_version: "Windows 11", agent_version: "0.1.3" }),
      });
      const result = await jsonFetch(`${base}/api/agent/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${device.body.device_token}` },
        body: JSON.stringify({ events: [{ event_id: eventId, occurred_at: new Date().toISOString(), type: "app_session", app_name: appName, process_name: `${appName}.exe`, duration_seconds: 60 }] }),
      });
      assert.equal(result.response.status, 202);
    }
    await enroll("employee-wei", "WIN-TEAM-WEI", "team-wei-event", "Visual Studio Code");
    await enroll("employee-lin", "WIN-TEAM-LIN", "team-lin-event", "WPS");

    const teamAnswer = await jsonFetch(`${base}/api/admin/history/ask`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ question: "这个团队最近主要做了什么？", team: "客户与销售团队" }),
    });
    assert.equal(teamAnswer.response.status, 200);
    assert.equal(teamAnswer.body.query_team, "客户与销售团队");
    assert.ok(teamAnswer.body.evidence.length >= 1);
    assert.ok(teamAnswer.body.evidence.every((record) => record.employee_team === "客户与销售团队"));
    assert.ok(teamAnswer.body.evidence.every((record) => record.employee_name !== "Wei"));

    const managerSession = await jsonFetch(`${base}/api/admin/sessions`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ role: "manager", team: "研发与产品中心" }),
    });
    const managerAnswer = await jsonFetch(`${base}/api/admin/history/ask`, {
      method: "POST",
      headers: { "x-admin-session": managerSession.body.token },
      body: JSON.stringify({ question: "这个团队最近主要做了什么？", team: "客户与销售团队" }),
    });
    assert.equal(managerAnswer.response.status, 200);
    assert.equal(managerAnswer.body.query_team, "研发与产品中心");
    assert.ok(managerAnswer.body.evidence.every((record) => record.employee_team === "研发与产品中心"));
  });
});

test("classifies project-management and collaboration sources without raw page content", async () => {
  await withServer(async ({ base }) => {
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: { "x-admin-token": "test-admin" },
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-CONTEXT", os_version: "Windows 11", agent_version: "0.1.3" }),
    });
    const eventResponse = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.body.device_token}` },
      body: JSON.stringify({ events: [{
        event_id: "jira-context-event",
        occurred_at: new Date().toISOString(),
        type: "app_session",
        app_name: "Jira",
        process_name: "chrome.exe",
        title_hint: "来源：Jira",
        web_domain: "jira.example.com",
        duration_seconds: 60,
      }] }),
    });
    assert.equal(eventResponse.response.status, 202);
    const history = await jsonFetch(`${base}/api/admin/history`, { headers: { "x-admin-token": "test-admin" } });
    const leaf = history.body.records.find((record) => record.record_type === "leaf");
    assert.deepEqual(leaf.context_kinds, ["项目管理"]);
    assert.deepEqual(leaf.web_domains, ["jira.example.com"]);
    assert.ok(leaf.resources.some((resource) => resource.name === "来源：Jira"));
    assert.ok(!JSON.stringify(leaf).includes("jira.example.com/path"));
  });
});

test("enforces server-side employee scope with signed admin sessions", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    async function enroll(employeeId, hostname) {
      const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ employee_id: employeeId }),
      });
      const result = await jsonFetch(`${base}/api/agent/enroll`, {
        method: "POST",
        body: JSON.stringify({ registration_code: code.body.code, hostname, os_version: "Windows 11", agent_version: "0.1.1" }),
      });
      return result.body;
    }
    const chen = await enroll("employee-chen", "WIN-CHEN");
    const wei = await enroll("employee-wei", "WIN-WEI");
    for (const [device, eventId] of [[chen, "chen-event"], [wei, "wei-event"]]) {
      const result = await jsonFetch(`${base}/api/agent/events`, {
        method: "POST",
        headers: { authorization: `Bearer ${device.device_token}` },
        body: JSON.stringify({ events: [{ event_id: eventId, occurred_at: new Date().toISOString(), type: "app_session", app_name: "WPS", process_name: "wps.exe", duration_seconds: 30 }] }),
      });
      assert.equal(result.response.status, 202);
    }
    const session = await jsonFetch(`${base}/api/admin/sessions`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ role: "employee", employee_id: "employee-chen" }),
    });
    assert.equal(session.response.status, 201);
    const scopedHeaders = { "x-admin-session": session.body.token };
    const devices = await jsonFetch(`${base}/api/admin/devices`, { headers: scopedHeaders });
    assert.equal(devices.response.status, 200);
    assert.deepEqual(devices.body.devices.map((device) => device.employee_id), ["employee-chen"]);
    const history = await jsonFetch(`${base}/api/admin/history`, { headers: scopedHeaders });
    assert.equal(history.response.status, 200);
    assert.ok(history.body.records.every((record) => record.user_id === "employee-chen"));
    const managerSession = await jsonFetch(`${base}/api/admin/sessions`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ role: "manager", team: "研发与产品中心" }),
    });
    const managerHeaders = { "x-admin-session": managerSession.body.token };
    const scopedEmployees = await jsonFetch(`${base}/api/admin/employees`, { headers: managerHeaders });
    const scopedTeams = await jsonFetch(`${base}/api/admin/teams`, { headers: managerHeaders });
    assert.ok(scopedEmployees.body.employees.every((employee) => employee.team === "研发与产品中心"));
    assert.deepEqual(scopedTeams.body.teams.map((team) => team.name), ["研发与产品中心"]);
    const policy = await jsonFetch(`${base}/api/admin/policy`, { method: "PUT", headers: scopedHeaders, body: JSON.stringify({ work_hours_start: "00:00", work_hours_end: "24:00" }) });
    assert.equal(policy.response.status, 403);
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

test("configures the Qwen 3.7 Plus adapter without sending a real request", async () => {
  const ai = createAiService({
    apiKey: "test-key",
    model: "qwen3.7-plus",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.model, "qwen3.7-plus");
      assert.equal(request.enable_thinking, false);
      return {
        ok: true,
      async json() {
          return { choices: [{ message: { content: JSON.stringify({ title: "模型摘要", important_context: "只基于活动元数据", confidence: 0.9 }) } }] };
        },
      };
    },
  });
  const summary = await ai.summarizeMemory({
    id: "memory-test",
    title: "规则标题",
    description: "规则描述",
    summary: "规则总结",
    prior_context: "规则上下文",
    non_obvious: "规则边界",
    employee_name: "Wei",
    application_names: ["Visual Studio Code"],
  });
  assert.equal(ai.mode, "model");
  assert.equal(ai.model, "qwen3.7-plus");
  assert.equal(summary.status, "generated");
  assert.equal(summary.title, "模型摘要");
  assert.equal(summary.important_context, "只基于活动元数据");
  assert.equal(summary.confidence, 0.9);
});

test("times out a stuck model request and keeps the safe fallback path", async () => {
  const ai = createAiService({
    apiKey: "test-key",
    requestTimeoutMs: 5,
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("aborted by test")), { once: true });
    }),
    logger: { warn() {} },
  });
  const summary = await ai.summarizeMemory({ title: "规则标题", summary: "规则总结" });
  assert.equal(summary.status, "fallback");
  assert.equal(summary.retryable, true);
  assert.equal(summary.model_name, "rules-v1");
});

test("uses safe fallbacks for optional empty model fields without losing generated status", async () => {
  const ai = createAiService({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ title: "模型标题", summary: "模型摘要", prior_context: "" }) } }] };
      },
    }),
    logger: { warn() {} },
  });
  const summary = await ai.summarizeMemory({ title: "规则标题", description: "规则描述", summary: "规则总结", prior_context: "规则上下文", non_obvious: "规则边界" });
  assert.equal(summary.status, "generated");
  assert.equal(summary.title, "模型标题");
  assert.equal(summary.summary, "模型摘要");
  assert.equal(summary.prior_context, "规则上下文");
});

test("normalizes safe string arrays returned by the model", async () => {
  const ai = createAiService({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ title: "模型标题", important_context: ["只基于活动元数据", "不包含原始正文"] }) } }] };
      },
    }),
    logger: { warn() {} },
  });
  const summary = await ai.summarizeMemory({ title: "规则标题", summary: "规则总结", prior_context: "规则上下文", non_obvious: "规则边界" });
  assert.equal(summary.status, "generated");
  assert.equal(summary.important_context, "只基于活动元数据；不包含原始正文");
});

test("rejects unsafe model summary text and falls back", async () => {
  const ai = createAiService({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ title: "https://private.example/path" }) } }] };
      },
    }),
    logger: { warn() {} },
  });
  const summary = await ai.summarizeMemory({ title: "安全标题", description: "安全描述", summary: "安全摘要", prior_context: "安全上下文", non_obvious: "安全边界" });
  assert.equal(summary.status, "fallback");
  assert.equal(summary.model_name, "rules-v1");
  assert.equal(summary.retryable, true);
});

test("rejects absolute Unix paths in model summary text", async () => {
  const ai = createAiService({
    apiKey: "test-key",
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({ title: "读取 /Users/wei/private.docx" }) } }] };
      },
    }),
    logger: { warn() {} },
  });
  const summary = await ai.summarizeMemory({ title: "安全标题", description: "安全描述", summary: "安全摘要", prior_context: "安全上下文", non_obvious: "安全边界" });
  assert.equal(summary.status, "fallback");
  assert.equal(summary.retryable, true);
});

test("queues failed Qwen summaries and retries them", async () => {
  let calls = 0;
  const ai = createAiService({
    apiKey: "test-key",
    model: "qwen3.7-plus",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary upstream failure");
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ title: "重试后的摘要", summary: "模型已恢复" }) } }] }; } };
    },
    logger: { warn() {} },
  });
  await withServer(async ({ base, app }) => {
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, { method: "POST", headers: { "x-admin-token": "test-admin" }, body: JSON.stringify({ employee_id: "employee-wei" }) });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, { method: "POST", body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-AI", os_version: "Windows 11", agent_version: "0.1.1" }) });
    const events = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers: { authorization: `Bearer ${enrolled.body.device_token}` }, body: JSON.stringify({ events: [{ event_id: "retry-event", occurred_at: new Date().toISOString(), type: "app_session", app_name: "WPS", process_name: "wps.exe", duration_seconds: 45 }] }) });
    assert.equal(events.response.status, 202);
    const first = await jsonFetch(`${base}/api/admin/history`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.records[0].summary_status, "fallback");
    const queued = await jsonFetch(`${base}/api/admin/memory/jobs`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(queued.body.jobs.filter((job) => job.status === "queued").length, 1);
    const result = await processMemoryGenerationJobs(app.db, ai, { warn() {} });
    assert.equal(result.succeeded, 1);
    const second = await jsonFetch(`${base}/api/admin/history`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(second.body.records[0].summary_status, "generated");
    assert.equal(second.body.records[0].title, "重试后的摘要");
    const generatedRecord = second.body.records[0];
    const stored = app.db.prepare("SELECT period_start, period_end, source_event_ids, citations FROM memory_summaries WHERE id = ?").get(generatedRecord.id);
    assert.equal(stored.period_start, generatedRecord.started_at);
    assert.equal(stored.period_end, generatedRecord.ended_at);
    assert.deepEqual(JSON.parse(stored.source_event_ids), generatedRecord.source_event_ids);
    assert.deepEqual(JSON.parse(stored.citations), generatedRecord.citations);
  }, { ai });
});

test("enforces an in-process AI request budget", async () => {
  let calls = 0;
  const ai = createAiService({
    apiKey: "test-key",
    maxRequestsPerMinute: 1,
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({ title: "受限测试" }) } }] }; } };
    },
    logger: { warn() {} },
  });
  const input = { title: "测试记录", description: "描述", summary: "摘要", prior_context: "上下文", non_obvious: "边界", employee_name: "Wei" };
  const first = await ai.summarizeMemory(input);
  const second = await ai.summarizeMemory(input);
  assert.equal(first.status, "generated");
  assert.equal(second.status, "fallback");
  assert.equal(second.retryable, true);
  assert.equal(calls, 1);
});

test("stops requeueing a summary after five failed attempts", async () => {
  let calls = 0;
  const ai = createAiService({
    apiKey: "test-key",
    model: "qwen3.7-plus",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("permanent upstream failure");
    },
    logger: { warn() {} },
  });
  await withServer(async ({ base, app }) => {
    const code = await jsonFetch(base + "/api/admin/registration-codes", {
      method: "POST",
      headers: { "x-admin-token": "test-admin" },
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(base + "/api/agent/enroll", {
      method: "POST",
      body: JSON.stringify({
        registration_code: code.body.code,
        hostname: "WIN-AI-FAILED",
        os_version: "Windows 11",
        agent_version: "0.1.3",
      }),
    });
    await jsonFetch(base + "/api/agent/events", {
      method: "POST",
      headers: { authorization: "Bearer " + enrolled.body.device_token },
      body: JSON.stringify({
        events: [{
          event_id: "permanent-failure-event",
          occurred_at: new Date().toISOString(),
          type: "app_session",
          app_name: "WPS",
          process_name: "wps.exe",
          duration_seconds: 45,
        }],
      }),
    });
    const first = await jsonFetch(base + "/api/admin/history", { headers: { "x-admin-token": "test-admin" } });
    assert.equal(first.body.records[0].summary_status, "fallback");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      app.db.prepare("UPDATE memory_generation_jobs SET next_attempt_at = ?").run(new Date().toISOString());
      await processMemoryGenerationJobs(app.db, ai, { warn() {} });
    }
    const beforeFinalRead = calls;
    const jobs = await jsonFetch(base + "/api/admin/memory/jobs", { headers: { "x-admin-token": "test-admin" } });
    assert.equal(jobs.body.jobs[0].status, "failed");
    assert.equal(jobs.body.jobs[0].attempts, 5);
    const second = await jsonFetch(base + "/api/admin/history", { headers: { "x-admin-token": "test-admin" } });
    assert.equal(second.body.records[0].summary_status, "fallback");
    assert.equal(calls, beforeFinalRead);
  }, { ai });
});

test("previews and applies admin retention deletion", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ employee_id: "employee-wei" }) });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, { method: "POST", body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-RETENTION", os_version: "Windows 11", agent_version: "0.1.1" }) });
    const deviceHeaders = { authorization: `Bearer ${enrolled.body.device_token}` };
    const oldDate = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    const event = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers: deviceHeaders, body: JSON.stringify({ events: [{ event_id: "old-retention-event", occurred_at: oldDate, type: "app_session", app_name: "WPS", process_name: "wps.exe", duration_seconds: 60 }] }) });
    assert.equal(event.response.status, 202);
    await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
    const preview = await jsonFetch(`${base}/api/admin/retention`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ before: cutoff }) });
    assert.equal(preview.response.status, 200);
    assert.equal(preview.body.applied, false);
    assert.equal(preview.body.preview.events, 1);
    assert.ok(preview.body.preview.memory_summaries >= 1);
    const applied = await jsonFetch(`${base}/api/admin/retention`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ before: cutoff, apply: true }) });
    assert.equal(applied.response.status, 200);
    assert.equal(applied.body.applied, true);
    assert.equal(applied.body.deleted.events, 1);
    const events = await jsonFetch(`${base}/api/admin/events`, { headers: adminHeaders });
    assert.equal(events.body.events.length, 0);
  });
});

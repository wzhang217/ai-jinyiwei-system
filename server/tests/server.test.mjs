import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentServer, processMemoryGenerationJobs, rankHistoryRecords, searchHistoryRecords } from "../src/index.mjs";
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

test("retrieves by semantic metadata facets and not only exact wording", () => {
  const records = [
    {
      id: "document-record",
      title: "Wei · 文档活动",
      application_names: ["WPS Office"],
      context_kinds: ["文档"],
      context_labels: [],
      web_domains: [],
      source_types: ["桌面应用"],
      started_at: "2026-08-23T10:00:00.000Z",
    },
    {
      id: "communication-record",
      title: "Wei · 沟通活动",
      application_names: ["微信/企业微信"],
      context_kinds: ["沟通"],
      context_labels: [],
      web_domains: [],
      source_types: ["桌面应用"],
      started_at: "2026-08-23T09:30:00.000Z",
    },
    {
      id: "development-browser-record",
      title: "Wei · 开发、浏览器活动",
      application_names: ["Visual Studio Code", "Google Chrome"],
      context_kinds: ["开发", "浏览器"],
      context_labels: ["来源：GitHub"],
      web_domains: ["github.com"],
      source_types: ["浏览器原生", "桌面应用"],
      started_at: "2026-08-23T09:00:00.000Z",
    },
    {
      id: "raw-content-only-record",
      title: "Wei · 其他活动",
      application_names: ["Unknown App"],
      context_kinds: ["其他"],
      context_labels: [],
      web_domains: [],
      source_types: ["桌面应用"],
      window_title: "研发代码仓库和网页正文不应被检索",
      raw_content: "研发代码仓库和网页正文不应被检索",
      started_at: "2026-08-23T11:00:00.000Z",
    },
  ];

  const developmentSearch = searchHistoryRecords("研发团队在网页和代码仓库上连续工作", records);
  assert.equal(developmentSearch.mode, "semantic-metadata-v1");
  assert.deepEqual(developmentSearch.query_groups.sort(), ["browser", "development"]);
  assert.equal(developmentSearch.records[0].id, "development-browser-record");

  const communicationSearch = rankHistoryRecords("开会和聊天", records);
  assert.equal(communicationSearch[0].id, "communication-record");
  assert.notEqual(developmentSearch.records[0].id, "raw-content-only-record");
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

    const testNow = new Date(Date.now() - 30 * 60_000);
    const event = {
      event_id: "event-1",
      occurred_at: testNow.toISOString(),
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
      occurred_at: new Date(testNow.getTime() - 1_000).toISOString(),
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
      occurred_at: new Date(testNow.getTime() - 20 * 60_000).toISOString(),
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
    assert.ok(history.body.records.some((record) => record.record_type === "rollup" && record.rollup_scope === "six_hour"));
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
    assert.ok(leaf.resources.some((resource) => resource.name === "Google Chrome" && resource.type === "application"));
    assert.ok(leaf.resources.some((resource) => resource.name === "Visual Studio Code" && resource.type === "application"));
    assert.ok(rollup.resources.some((resource) => resource.name === "Google Chrome" && resource.type === "application"));
    assert.match(leaf.title, /Chen/);
    assert.deepEqual(leaf.source_event_ids.sort(), ["event-1", "event-2"]);
    assert.equal(rollup.record_type, "rollup");
    assert.equal(rollup.source_record_ids.length, 2);
    assert.ok(rollup.source_record_ids.includes(leaf.id));
    const rollupSources = await jsonFetch(`${base}/api/admin/history/${encodeURIComponent(rollup.id)}/sources`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(rollupSources.response.status, 200);
    assert.equal(rollupSources.body.source_records.length, 2);
    const leafSources = await jsonFetch(`${base}/api/admin/history/${encodeURIComponent(leaf.id)}/sources`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(leafSources.response.status, 200);
    assert.equal(leafSources.body.source_events.length, 2);
    assert.equal(leafSources.body.source_events[0].window_title, undefined);
    assert.ok(leafSources.body.source_events.every((event) => event.source_kind));
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
    assert.equal(answer.body.retrieval.mode, "semantic-metadata-v1");
    assert.equal(answer.body.retrieval.candidate_count >= answer.body.retrieval.selected_count, true);
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

test("pairs a browser with a short-lived scoped credential", async () => {
  await withServer(async ({ base, app }) => {
    const codeResult = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: { "x-admin-token": "test-admin" },
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: codeResult.body.code, hostname: "WIN-BROWSER-01", os_version: "Windows 11", agent_version: "0.1.3" }),
    });
    const deviceHeaders = { authorization: `Bearer ${enrolled.body.device_token}` };
    const pairing = await jsonFetch(`${base}/api/agent/browser-pairing-codes`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(pairing.response.status, 201);
    assert.match(pairing.body.code, /^BP-[A-F0-9]{10}$/);

    const paired = await jsonFetch(`${base}/api/agent/browser-pair`, {
      method: "POST",
      body: JSON.stringify({ pairing_code: pairing.body.code, browser_name: "Google Chrome" }),
    });
    assert.equal(paired.response.status, 201);
    assert.notEqual(paired.body.browser_token, enrolled.body.device_token);
    assert.equal(paired.body.employee.id, "employee-wei");

    const browserHeaders = { authorization: `Bearer ${paired.body.browser_token}` };
    const event = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({ events: [{
        event_id: "browser-source-event",
        occurred_at: new Date().toISOString(),
        type: "app_session",
        app_name: "Google Chrome",
        process_name: "chrome.exe",
        title_hint: "来源：GitHub",
        web_domain: "github.com",
        duration_seconds: 60,
      }] }),
    });
    assert.equal(event.response.status, 202);
    const browserHistory = await jsonFetch(`${base}/api/admin/history`, { headers: { "x-admin-token": "test-admin" } });
    const browserRecord = browserHistory.body.records.find((record) => record.source_event_ids?.includes("browser-source-event"));
    assert.ok(browserRecord);
    assert.ok(browserRecord.context_labels.includes("来源：GitHub"));
    assert.deepEqual(browserRecord.web_domains, ["github.com"]);
    const heartbeat = await jsonFetch(`${base}/api/agent/heartbeat`, { method: "POST", headers: browserHeaders, body: JSON.stringify({ queued_events: 0 }) });
    assert.equal(heartbeat.response.status, 401);
    const reused = await jsonFetch(`${base}/api/agent/browser-pair`, { method: "POST", body: JSON.stringify({ pairing_code: pairing.body.code, browser_name: "Microsoft Edge" }) });
    assert.equal(reused.response.status, 400);

    app.db.prepare("UPDATE browser_tokens SET expires_at = ? WHERE token_hash = ?").run(new Date(Date.now() - 1_000).toISOString(), createHash("sha256").update(paired.body.browser_token).digest("hex"));
    const expired = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers: browserHeaders, body: JSON.stringify({ events: [] }) });
    assert.equal(expired.response.status, 401);
  });
});

test("splits long foreground sessions into ten-minute Memory Summary windows", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-LONG-SESSION", os_version: "Windows 11", agent_version: "0.1.3" }),
    });
    const occurredAt = new Date(Date.now() - 31 * 60_000).toISOString();
    const uploaded = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.body.device_token}` },
      body: JSON.stringify({ events: [{
        event_id: "long-session",
        occurred_at: occurredAt,
        type: "app_session",
        app_name: "Visual Studio Code",
        process_name: "Code.exe",
        context_label: "项目：AI锦衣卫系统",
        duration_seconds: 1_501,
      }] }),
    });
    assert.equal(uploaded.response.status, 202);

    const history = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const leaves = history.body.records
      .filter((record) => record.record_type === "leaf")
      .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
    assert.deepEqual(leaves.map((record) => record.duration_seconds), [600, 600, 301]);
    assert.ok(leaves.every((record) => record.duration_seconds <= 600));
    assert.ok(leaves.every((record) => record.context_switches === 0));
    assert.ok(leaves.every((record) => record.source_event_ids.length === 1 && record.source_event_ids[0] === "long-session"));
    assert.ok(history.body.records.some((record) => record.record_type === "rollup" && record.rollup_scope === "window"));
    const sixHour = history.body.records.find((record) => record.record_type === "rollup" && record.rollup_scope === "six_hour");
    assert.ok(sixHour);
    assert.equal(sixHour.source_record_ids.length, 3);
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
    assert.equal(initial.body.policy.activity_checkpoint_seconds, 15);

    const updated = await jsonFetch(`${base}/api/admin/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ work_hours_start: "00:00", work_hours_end: "24:00", activity_checkpoint_seconds: 30 }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.policy.work_hours_start, "00:00");
    assert.equal(updated.body.policy.work_hours_end, "24:00");
    assert.equal(updated.body.policy.activity_checkpoint_seconds, 30);
    assert.equal(updated.body.policy.version, 2);

    const invalid = await jsonFetch(`${base}/api/admin/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ work_hours_start: "18:00", work_hours_end: "09:00" }),
    });
    assert.equal(invalid.response.status, 400);

    const invalidCheckpoint = await jsonFetch(`${base}/api/admin/policy`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ work_hours_start: "00:00", work_hours_end: "24:00", activity_checkpoint_seconds: 5 }),
    });
    assert.equal(invalidCheckpoint.response.status, 400);
  });
});

test("enforces application and website exclusion policy for uploaded events", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const updated = await jsonFetch(`${base}/api/admin/policy`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({
        work_hours_start: "00:00",
        work_hours_end: "24:00",
        excluded_processes: ["passwordmanager.exe"],
        excluded_domains: ["private.example.com"],
      }),
    });
    assert.equal(updated.response.status, 200);
    assert.deepEqual(updated.body.policy.excluded_processes, ["passwordmanager.exe"]);
    assert.deepEqual(updated.body.policy.excluded_domains, ["private.example.com"]);

    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-EXCLUSION", os_version: "Windows 11", agent_version: "0.1.3" }),
    });
    const headers = { authorization: `Bearer ${enrolled.body.device_token}` };
    const uploaded = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [
        { event_id: "excluded-process", occurred_at: new Date().toISOString(), type: "app_session", app_name: "Password Manager", process_name: "PasswordManager.exe", duration_seconds: 30 },
        { event_id: "excluded-domain", occurred_at: new Date().toISOString(), type: "app_session", app_name: "Chrome", process_name: "chrome.exe", web_domain: "mail.private.example.com", duration_seconds: 30 },
        { event_id: "allowed-event", occurred_at: new Date().toISOString(), type: "app_session", app_name: "Visual Studio Code", process_name: "Code.exe", context_label: "项目：AI锦衣卫系统", duration_seconds: 30 },
      ] }),
    });
    assert.equal(uploaded.response.status, 202);
    assert.equal(uploaded.body.accepted, 1);
    assert.equal(uploaded.body.filtered, 2);

    const events = await jsonFetch(`${base}/api/admin/events`, { headers: adminHeaders });
    assert.deepEqual(events.body.events.map((event) => event.event_id), ["allowed-event"]);
  });
});

test("normalizes legacy browser events in the live diagnostics response", async () => {
  await withServer(async ({ base, app }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({
        registration_code: code.body.code,
        hostname: "WIN-DIAGNOSTIC-SOURCE",
        os_version: "Windows 11",
        agent_version: "0.1.8",
      }),
    });
    app.db.prepare("INSERT INTO events (event_id, device_id, occurred_at, type, app_name, process_name, source_kind, web_domain, duration_seconds, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      "legacy-browser-diagnostic",
      enrolled.body.device_id,
      new Date(Date.now() - 2 * 60_000).toISOString(),
      "app_session",
      "msedge",
      "msedge.exe",
      "desktop_app",
      "example.com",
      60,
      new Date().toISOString(),
    );

    const events = await jsonFetch(`${base}/api/admin/events`, { headers: adminHeaders });
    const event = events.body.events.find((item) => item.event_id === "legacy-browser-diagnostic");
    assert.equal(event.source_kind, "browser_native");
  });
});

test("repairs legacy summary metadata without another model call", async () => {
  const ai = {
    mode: "model",
    model: "qwen3.7-plus",
    promptVersion: "memory-v1",
    calls: 0,
    async summarizeMemory() {
      this.calls += 1;
      throw new Error("metadata repair must not call the model");
    },
  };

  await withServer(async ({ base, app }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({
        registration_code: code.body.code,
        hostname: "WIN-METADATA-REPAIR",
        os_version: "Windows 11",
        agent_version: "0.1.8",
      }),
    });
    const deviceHeaders = { authorization: `Bearer ${enrolled.body.device_token}` };
    const now = Date.now();
    const uploaded = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ events: [
        {
          event_id: "repair-browser-event",
          occurred_at: new Date(now - 3 * 60_000).toISOString(),
          type: "app_session",
          app_name: "Microsoft Edge",
          process_name: "msedge.exe",
          web_domain: "jd.com",
          duration_seconds: 60,
        },
        {
          event_id: "repair-weixin-event",
          occurred_at: new Date(now - 2 * 60_000).toISOString(),
          type: "app_session",
          app_name: "微信/企业微信",
          process_name: "Weixin.exe",
          duration_seconds: 60,
        },
      ] }),
    });
    assert.equal(uploaded.response.status, 202);

    const first = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const leaf = first.body.records.find((record) => record.record_type === "leaf" && record.source_event_ids?.includes("repair-browser-event"));
    assert.ok(leaf);
    assert.ok(leaf.activity_sequence.length >= 2);

    const stored = app.db.prepare("SELECT payload_json FROM memory_summaries WHERE id = ?").get(leaf.id);
    const legacyPayload = JSON.parse(stored.payload_json);
    delete legacyPayload.activity_sequence;
    delete legacyPayload.source_kinds;
    delete legacyPayload.source_types;
    delete legacyPayload.resource_types;
    legacyPayload.title = "Wei · jd.com";
    legacyPayload.description = "旧版描述";
    legacyPayload.summary = "旧版摘要";
    legacyPayload.resources = (legacyPayload.resources || []).map(({ name, path, type }) => ({ name, path, type }));
    app.db.prepare("UPDATE memory_summaries SET title = ?, summary = ?, payload_json = ? WHERE id = ?").run(
      legacyPayload.title,
      legacyPayload.summary,
      JSON.stringify(legacyPayload),
      leaf.id,
    );

    const repairedHistory = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const repaired = repairedHistory.body.records.find((record) => record.id === leaf.id);
    assert.ok(repaired);
    assert.notEqual(repaired.title, "Wei · jd.com");
    assert.ok(repaired.activity_sequence.length >= 2);
    assert.match(repaired.summary, /东八区/);
    assert.ok(repaired.source_types.length >= 2);
    assert.ok(repaired.resource_types.length >= 1);
    assert.ok(repaired.resources.every((resource) => resource.source_type));
    assert.equal(ai.calls, 0);
  }, { ai });
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

test("recalls persisted Memory Summary records beyond the recent activity window", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-LONG-MEMORY", os_version: "Windows 11", agent_version: "0.1.4" }),
    });
    const deviceHeaders = { authorization: `Bearer ${enrolled.body.device_token}` };
    const oldEvent = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ events: [{
        event_id: "long-memory-old-wps",
        occurred_at: new Date(Date.now() - 14 * 24 * 3600_000).toISOString(),
        type: "app_session",
        app_name: "WPS",
        process_name: "wps.exe",
        duration_seconds: 300,
      }] }),
    });
    assert.equal(oldEvent.response.status, 202);

    // Materialize and persist the old Memory Summary first.
    const oldHistory = await jsonFetch(`${base}/api/admin/history?limit=200`, { headers: adminHeaders });
    assert.equal(oldHistory.response.status, 200);
    assert.ok(oldHistory.body.records.some((record) => record.application_names.includes("WPS Office") && record.title.includes("文档")));

    const currentEvent = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ events: [{
        event_id: "long-memory-current-code",
        occurred_at: new Date().toISOString(),
        type: "app_session",
        app_name: "Visual Studio Code",
        process_name: "Code.exe",
        duration_seconds: 60,
      }] }),
    });
    assert.equal(currentEvent.response.status, 202);

    const answer = await jsonFetch(`${base}/api/admin/history/ask`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ question: "WPS 之前做了什么？" }),
    });
    assert.equal(answer.response.status, 200);
    assert.ok(answer.body.evidence.some((record) => record.application_names.includes("WPS Office") && record.title.includes("文档")));
    assert.ok(answer.body.evidence.some((record) => record.started_at < new Date(Date.now() - 24 * 3600_000).toISOString()));
  });
});

test("hides materially future event timestamps from History and diagnostics", async () => {
  await withServer(async ({ base, app }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-FUTURE-CLOCK", os_version: "Windows 11", agent_version: "0.1.5" }),
    });
    const futureEvent = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.body.device_token}` },
      body: JSON.stringify({ events: [{
        event_id: "future-clock-event",
        occurred_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
        type: "app_session",
        app_name: "WPS",
        process_name: "wps.exe",
        duration_seconds: 60,
      }] }),
    });
    assert.equal(futureEvent.response.status, 202);
    app.db.prepare("INSERT INTO events (event_id, device_id, occurred_at, type, app_name, process_name, duration_seconds, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      "legacy-full-day-idle",
      enrolled.body.device_id,
      new Date(Date.now() - 2 * 24 * 3600_000).toISOString(),
      "idle",
      "Idle",
      "system",
      86_400,
      new Date().toISOString(),
    );
    const events = await jsonFetch(`${base}/api/admin/events`, { headers: adminHeaders });
    assert.ok(!events.body.events.some((event) => event.event_id === "future-clock-event"));
    const history = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    assert.ok(!history.body.records.some((record) => record.source_event_ids?.includes("future-clock-event")));
    assert.ok(!history.body.records.some((record) => record.source_event_ids?.includes("legacy-full-day-idle")));
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
    assert.deepEqual(leaf.source_kinds, ["browser_extension"]);
    assert.deepEqual(leaf.resource_types.sort(), ["网站", "项目"]);
    assert.deepEqual(leaf.source_types, ["浏览器扩展"]);
    assert.equal(leaf.activity_sequence.length, 1);
    assert.equal(leaf.activity_sequence[0].source_kind, "browser_extension");
    assert.equal(leaf.timeline[0].duration_seconds, 60);
    assert.equal(leaf.timeline[0].source_kind, "browser_extension");
    assert.ok(!leaf.title.includes("jira.example.com"));
    assert.ok(leaf.resources.some((resource) => resource.name === "来源：Jira"));
    assert.ok(!JSON.stringify(leaf).includes("jira.example.com/path"));
  });
});

test("classifies Tencent Meeting as a communication activity", async () => {
  await withServer(async ({ base }) => {
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: { "x-admin-token": "test-admin" },
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-MEETING", os_version: "Windows 11", agent_version: "0.1.8" }),
    });
    const eventId = "tencent-meeting-event";
    const eventResponse = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.body.device_token}` },
      body: JSON.stringify({ events: [{
        event_id: eventId,
        occurred_at: new Date(Date.now() - 60_000).toISOString(),
        type: "app_session",
        app_name: "WemeetApp",
        process_name: "wemeetapp.exe",
        duration_seconds: 60,
      }] }),
    });
    assert.equal(eventResponse.response.status, 202);
    const history = await jsonFetch(`${base}/api/admin/history`, { headers: { "x-admin-token": "test-admin" } });
    const leaf = history.body.records.find((record) => record.source_event_ids?.includes(eventId));
    assert.ok(leaf);
    assert.deepEqual(leaf.applications, ["tencent_meeting"]);
    assert.deepEqual(leaf.application_names, ["腾讯会议"]);
    assert.deepEqual(leaf.context_kinds, ["沟通"]);
    assert.match(leaf.title, /沟通/);
  });
});

test("normalizes legacy idle and browser source kinds from event evidence", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-LEGACY-SOURCE", os_version: "Windows 11", agent_version: "0.1.3" }),
    });
    const occurredAt = new Date(Date.now() - 12 * 60_000);
    const uploaded = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.body.device_token}` },
      body: JSON.stringify({ events: [
        {
          event_id: "legacy-idle-source-event",
          occurred_at: occurredAt.toISOString(),
          type: "idle",
          app_name: "Idle",
          process_name: "system",
          source_kind: "desktop_app",
          duration_seconds: 60,
        },
        {
          event_id: "legacy-browser-source-event",
          occurred_at: new Date(occurredAt.getTime() + 90_000).toISOString(),
          type: "app_session",
          app_name: "Google Chrome",
          process_name: "chrome.exe",
          source_kind: "desktop_app",
          web_domain: "example.com",
          duration_seconds: 60,
        },
      ] }),
    });
    assert.equal(uploaded.response.status, 202);
    const history = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const idle = history.body.records.find((record) => record.activity_sequence?.[0]?.app === "系统空闲");
    const browser = history.body.records.find((record) => record.web_domains?.includes("example.com"));
    assert.equal(idle.activity_sequence[0].source_kind, "system_idle");
    assert.deepEqual(idle.source_types, ["系统空闲"]);
    assert.equal(browser.activity_sequence[0].source_kind, "browser_native");
    assert.deepEqual(browser.source_types, ["浏览器原生"]);
  });
});

test("coalesces overlapping native and extension browser observations", async () => {
  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-DUPLICATE-SOURCE", os_version: "Windows 11", agent_version: "0.1.7" }),
    });
    const occurredAt = new Date(Date.now() - 2 * 60_000);
    const headers = { authorization: `Bearer ${enrolled.body.device_token}` };
    const uploaded = await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers,
      body: JSON.stringify({ events: [
        {
          event_id: "native-browser-event",
          occurred_at: occurredAt.toISOString(),
          type: "app_session",
          app_name: "Google Chrome",
          process_name: "chrome.exe",
          source_kind: "browser_native",
          web_domain: "github.com",
          duration_seconds: 120,
        },
        {
          event_id: "extension-browser-event",
          occurred_at: new Date(occurredAt.getTime() + 30_000).toISOString(),
          type: "app_session",
          app_name: "Google Chrome",
          process_name: "chrome.exe",
          source_kind: "browser_extension",
          title_hint: "来源：GitHub",
          web_domain: "github.com",
          duration_seconds: 120,
        },
        {
          event_id: "second-browser-domain-event",
          occurred_at: new Date(occurredAt.getTime() + 60_000).toISOString(),
          type: "app_session",
          app_name: "Google Chrome",
          process_name: "chrome.exe",
          source_kind: "browser_native",
          web_domain: "example.com",
          duration_seconds: 30,
        },
        {
          event_id: "code-after-browser-event",
          occurred_at: new Date(occurredAt.getTime() + 120_000).toISOString(),
          type: "app_session",
          app_name: "Visual Studio Code",
          process_name: "Code.exe",
          source_kind: "desktop_app",
          duration_seconds: 30,
        },
      ] }),
    });
    assert.equal(uploaded.response.status, 202);
    const history = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const leaf = history.body.records.find((record) => record.record_type === "leaf");
    assert.ok(leaf);
    assert.deepEqual(leaf.source_kinds, ["browser_extension", "browser_native", "desktop_app"]);
    assert.equal(leaf.activity_sequence.length, 3);
    assert.deepEqual(leaf.source_event_ids.sort(), ["code-after-browser-event", "extension-browser-event", "native-browser-event", "second-browser-domain-event"]);
    assert.equal(leaf.activity_sequence[0].duration_seconds, 150);
    assert.equal(leaf.context_switches, 1);
    assert.match(leaf.description, /记录 3 个去重活动片段/);
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
      const userMessage = JSON.parse(request.messages.at(-1).content);
      assert.deepEqual(userMessage.record.resource_types, ["项目", "网站"]);
      assert.deepEqual(userMessage.record.resource_details, [{ name: "项目：AI锦衣卫系统", source_type: "代码仓库" }]);
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
    resource_types: ["项目", "网站"],
    resources: [{ name: "项目：AI锦衣卫系统", source_type: "代码仓库" }],
  });
  assert.equal(ai.mode, "model");
  assert.equal(ai.model, "qwen3.7-plus");
  assert.equal(summary.status, "generated");
  assert.equal(summary.title, "模型摘要");
  assert.equal(summary.important_context, "只基于活动元数据");
  assert.equal(summary.confidence, 0.9);
});

test("routes History Skill questions through Qwen with redacted evidence", async () => {
  let answerCalls = 0;
  const ai = createAiService({
    apiKey: "test-key",
    model: "qwen3.7-plus",
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const userMessage = JSON.parse(request.messages.at(-1).content);
      assert.equal(userMessage.task, "answer_history_question");
      const record = userMessage.records[0];
      assert.ok(record);
      assert.equal(record.window_title, undefined);
      assert.equal(record.full_url, undefined);
      assert.equal(record.raw_content, undefined);
      assert.match(record.started_at_shanghai, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
      answerCalls += 1;
      return {
        ok: true,
        async json() {
          return {
            choices: [{
              message: {
                content: JSON.stringify({
                  answer: "模型根据脱敏活动证据生成的回答。",
                  evidence_ids: [record.id],
                  caveat: "仅基于活动元数据。",
                  uncertainty: "不能据此判断绩效。",
                }),
              },
            }],
          };
        },
      };
    },
    logger: { warn() {} },
  });

  await withServer(async ({ base }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ employee_id: "employee-wei" }),
    });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, {
      method: "POST",
      body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-HISTORY-SKILL", os_version: "Windows 11", agent_version: "0.1.5" }),
    });
    await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${enrolled.body.device_token}` },
      body: JSON.stringify({ events: [{
        event_id: "history-skill-qwen-event",
        occurred_at: new Date(Date.now() - 20 * 60_000).toISOString(),
        type: "app_session",
        app_name: "Visual Studio Code",
        process_name: "Code.exe",
        context_label: "项目：AI锦衣卫系统",
        duration_seconds: 60,
      }] }),
    });
    const answer = await jsonFetch(`${base}/api/admin/history/ask`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ question: "最近主要做了什么？" }),
    });
    assert.equal(answer.response.status, 200);
    assert.equal(answer.body.model, "qwen3.7-plus");
    assert.equal(answer.body.answer, "模型根据脱敏活动证据生成的回答。");
    assert.equal(answer.body.evidence.length, 1);
    assert.equal(answer.body.evidence[0].context_labels[0], "项目：AI锦衣卫系统");
    assert.equal(answer.body.uncertainty, "不能据此判断绩效。");
    assert.equal(answerCalls, 1);
  }, { ai });
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

test("keeps model titles at the work-theme level instead of a bare domain or app", async () => {
  const ai = createAiService({
    apiKey: "test-key",
    enabled: true,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: JSON.stringify({
            title: "Wei · jd.com",
            description: "浏览器活动",
            summary: "浏览器活动摘要",
            prior_context: "活动元数据",
            important_context: "不包含正文",
          }) } }],
        };
      },
    }),
  });
  const summary = await ai.summarizeMemory({
    title: "Wei · 浏览器、沟通活动",
    employee_name: "Wei",
    application_names: ["Google Chrome", "微信/企业微信"],
    context_kinds: ["浏览器", "沟通"],
    web_domains: ["jd.com"],
    summary: "规则摘要",
  });
  assert.equal(summary.status, "generated");
  assert.equal(summary.title, "Wei · 浏览器、沟通活动");
});

test("fills missing time and activity sequence facts into a generated summary", async () => {
  const ai = createAiService({
    apiKey: "test-key",
    enabled: true,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: JSON.stringify({
          title: "开发、浏览器活动",
          description: "模型描述",
          summary: "模型摘要",
          prior_context: "活动元数据",
          important_context: "不包含正文",
        }) } }] };
      },
    }),
  });
  const summary = await ai.summarizeMemory({
    title: "Wei · 开发、浏览器活动",
    employee_name: "Wei",
    started_at: "2026-08-23T01:00:00.000Z",
    ended_at: "2026-08-23T01:10:00.000Z",
    application_names: ["Visual Studio Code", "Google Chrome"],
    context_kinds: ["开发", "浏览器"],
    context_switches: 1,
    source_types: ["桌面应用", "浏览器原生"],
    resource_types: ["网站"],
    web_domains: ["github.com"],
    activity_sequence: [
      { occurred_at: "2026-08-23T01:00:00.000Z", app: "Visual Studio Code", duration_seconds: 300 },
      { occurred_at: "2026-08-23T01:05:00.000Z", app: "Google Chrome", duration_seconds: 300 },
    ],
  });
  assert.match(summary.description, /活动证据：东八区/);
  assert.match(summary.description, /Visual Studio Code → Google Chrome/);
  assert.match(summary.summary, /应用切换 1 次/);
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
    const events = await jsonFetch(`${base}/api/agent/events`, { method: "POST", headers: { authorization: `Bearer ${enrolled.body.device_token}` }, body: JSON.stringify({ events: [{ event_id: "retry-event", occurred_at: new Date(Date.now() - 20 * 60_000).toISOString(), type: "app_session", app_name: "WPS", process_name: "wps.exe", duration_seconds: 600 }] }) });
    assert.equal(events.response.status, 202);
    const first = await jsonFetch(`${base}/api/admin/history`, { headers: { "x-admin-token": "test-admin" } });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.records[0].summary_status, "queued");
    const queued = await jsonFetch(`${base}/api/admin/memory/jobs`, { headers: { "x-admin-token": "test-admin" } });
    assert.ok(queued.body.jobs.filter((job) => job.status === "queued").length >= 1);
    const firstAttempt = await processMemoryGenerationJobs(app.db, ai, { warn() {} }, { limit: 1 });
    assert.equal(firstAttempt.retried, 1);
    app.db.prepare("UPDATE memory_generation_jobs SET next_attempt_at = ?").run(new Date().toISOString());
    const result = await processMemoryGenerationJobs(app.db, ai, { warn() {} }, { limit: 1 });
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
          occurred_at: new Date(Date.now() - 20 * 60_000).toISOString(),
          type: "app_session",
          app_name: "WPS",
          process_name: "wps.exe",
          duration_seconds: 600,
        }],
      }),
    });
    const first = await jsonFetch(base + "/api/admin/history", { headers: { "x-admin-token": "test-admin" } });
    assert.equal(first.body.records[0].summary_status, "queued");
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

test("only calls AI once for a closed ten-minute window", async () => {
  const ai = {
    mode: "model",
    model: "qwen3.7-plus",
    promptVersion: "memory-v1",
    calls: 0,
    async summarizeMemory(input) {
      this.calls += 1;
      return {
        status: "generated",
        model_name: this.model,
        title: `${input.employee_name} · AI 摘要`,
        description: "测试摘要",
        summary: "已对闭合的十分钟工作窗口生成一次摘要。",
        prior_context: input.prior_context,
        important_context: input.non_obvious,
        confidence: 0.9,
      };
    },
  };
  await withServer(async ({ base, app }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ employee_id: "employee-wei" }) });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, { method: "POST", body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-AI-CADENCE", os_version: "Windows 11", agent_version: "0.1.5" }) });
    const deviceHeaders = { authorization: `Bearer ${enrolled.body.device_token}` };

    await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ events: [{ event_id: "active-short-window", occurred_at: new Date().toISOString(), type: "app_session", app_name: "WPS", process_name: "wps.exe", duration_seconds: 45 }] }),
    });
    const activeHistory = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const activeRecord = activeHistory.body.records.find((record) => record.record_type === "leaf" && record.source_event_ids?.includes("active-short-window"));
    assert.equal(activeRecord.summary_status, "window_pending");
    assert.equal(ai.calls, 0);
    const activeJobs = await jsonFetch(`${base}/api/admin/memory/jobs`, { headers: adminHeaders });
    assert.equal(activeJobs.body.cadence.summary_window_seconds, 600);
    assert.equal(activeJobs.body.cadence.active_grace_seconds, 45);
    assert.equal(activeJobs.body.cadence.generation_interval_seconds, 15);
    assert.equal(activeJobs.body.cadence.generation_batch_size, 1);
    assert.equal(activeJobs.body.jobs.filter((job) => ["queued", "running", "retrying"].includes(job.status)).length, 0);
    await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    assert.equal(ai.calls, 0);

    await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ events: [{ event_id: "closed-ten-minute-window", occurred_at: new Date(Date.now() - 40 * 60_000).toISOString(), type: "app_session", app_name: "Visual Studio Code", process_name: "Code.exe", duration_seconds: 600 }] }),
    });
    const queuedHistory = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const queuedRecord = queuedHistory.body.records.find((record) => record.record_type === "leaf" && record.source_event_ids?.includes("closed-ten-minute-window"));
    assert.equal(queuedRecord.summary_status, "queued");
    assert.equal(ai.calls, 0);
    const queuedJobs = await jsonFetch(`${base}/api/admin/memory/jobs`, { headers: adminHeaders });
    assert.ok(queuedJobs.body.jobs.filter((job) => job.status === "queued").length >= 1);

    const processed = await processMemoryGenerationJobs(app.db, ai, { warn() {} }, { limit: 1 });
    assert.equal(processed.succeeded, 1);
    assert.equal(ai.calls, 1);
    const generatedHistory = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const generatedRecord = generatedHistory.body.records.find((record) => record.record_type === "leaf" && record.source_event_ids?.includes("closed-ten-minute-window"));
    assert.equal(generatedRecord.summary_status, "generated");
    assert.equal(generatedRecord.summary_model, "qwen3.7-plus");
    assert.equal(generatedRecord.prompt_version, "memory-v1");
    await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    assert.equal(ai.calls, 1);
  }, { ai });
});

test("does not fan one ten-minute cadence into extra rollup AI calls", async () => {
  const ai = {
    mode: "model",
    model: "qwen3.7-plus",
    promptVersion: "memory-v1",
    calls: 0,
    async summarizeMemory(input) {
      this.calls += 1;
      return {
        status: "generated",
        model_name: this.model,
        title: `${input.employee_name} · 十分钟摘要`,
        description: "闭合窗口摘要",
        summary: "只为闭合的十分钟 Leaf 窗口调用一次模型。",
        prior_context: input.prior_context,
        important_context: input.non_obvious,
        confidence: 0.9,
      };
    },
  };
  await withServer(async ({ base, app }) => {
    const adminHeaders = { "x-admin-token": "test-admin" };
    const code = await jsonFetch(`${base}/api/admin/registration-codes`, { method: "POST", headers: adminHeaders, body: JSON.stringify({ employee_id: "employee-wei" }) });
    const enrolled = await jsonFetch(`${base}/api/agent/enroll`, { method: "POST", body: JSON.stringify({ registration_code: code.body.code, hostname: "WIN-AI-ROLLUP-CADENCE", os_version: "Windows 11", agent_version: "0.1.5" }) });
    const deviceHeaders = { authorization: `Bearer ${enrolled.body.device_token}` };
    await jsonFetch(`${base}/api/agent/events`, {
      method: "POST",
      headers: deviceHeaders,
      body: JSON.stringify({ events: [
        { event_id: "cadence-leaf-one", occurred_at: new Date(Date.now() - 50 * 60_000).toISOString(), type: "app_session", app_name: "WPS", process_name: "wps.exe", duration_seconds: 600 },
        { event_id: "cadence-leaf-two", occurred_at: new Date(Date.now() - 39 * 60_000).toISOString(), type: "app_session", app_name: "Visual Studio Code", process_name: "Code.exe", duration_seconds: 600 },
      ] }),
    });

    const history = await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    const jobs = await jsonFetch(`${base}/api/admin/memory/jobs`, { headers: adminHeaders });
    const queued = jobs.body.jobs.filter((job) => ["queued", "running", "retrying"].includes(job.status));
    assert.equal(history.response.status, 200);
    assert.equal(ai.calls, 0);
    assert.equal(queued.length, 2);
    assert.ok(queued.every((job) => job.record_type === "leaf"));
    assert.ok(!queued.some((job) => job.record_type === "rollup"));

    const processed = await processMemoryGenerationJobs(app.db, ai, { warn() {} }, { limit: 20 });
    assert.equal(processed.succeeded, 2);
    assert.equal(ai.calls, 2);
    await jsonFetch(`${base}/api/admin/history`, { headers: adminHeaders });
    assert.equal(ai.calls, 2);
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

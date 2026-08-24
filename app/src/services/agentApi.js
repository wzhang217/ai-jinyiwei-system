import { formatShanghaiDate, formatShanghaiTime, shanghaiDayKey } from "../time.js";

const configuredBaseUrl = (import.meta.env.VITE_AGENT_API_BASE_URL || "").trim().replace(/\/$/, "");
const sourceKindLabels = {
  desktop_app: "桌面应用",
  browser_native: "浏览器原生",
  browser_extension: "浏览器扩展",
  system_idle: "系统空闲",
  system_app: "系统组件",
};
// Demo data is a local development preview only. A production build must
// never silently fall back to fabricated history when the API is unavailable.
export const demoMode = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === "true";
let adminSessionToken = typeof window !== "undefined" ? window.sessionStorage.getItem("jinyiwei_admin_session") || "" : "";
let adminPrincipal = null;
if (typeof window !== "undefined") {
  try {
    adminPrincipal = JSON.parse(window.sessionStorage.getItem("jinyiwei_admin_principal") || "null");
  } catch {
    window.sessionStorage.removeItem("jinyiwei_admin_principal");
  }
}

export const agentApiEnabled = Boolean(configuredBaseUrl);

export function setAdminSession(token) {
  adminSessionToken = typeof token === "string" ? token : "";
  if (typeof window !== "undefined") {
    if (adminSessionToken) window.sessionStorage.setItem("jinyiwei_admin_session", adminSessionToken);
    else window.sessionStorage.removeItem("jinyiwei_admin_session");
  }
}

export function setAdminPrincipal(principal) {
  adminPrincipal = principal && typeof principal === "object" ? principal : null;
  if (typeof window !== "undefined") {
    if (adminPrincipal) window.sessionStorage.setItem("jinyiwei_admin_principal", JSON.stringify(adminPrincipal));
    else window.sessionStorage.removeItem("jinyiwei_admin_principal");
  }
}

export function getStoredAdminPrincipal() {
  return adminPrincipal;
}

export function clearAdminSession() {
  setAdminSession("");
  setAdminPrincipal(null);
}

async function request(path, options = {}, { publicEndpoint = false } = {}) {
  if (!agentApiEnabled) throw new Error("Agent API is not configured");
  if (!publicEndpoint && !adminSessionToken) throw new Error("请先登录管理后台");
  const authHeaders = adminSessionToken ? { "x-admin-session": adminSessionToken } : {};
  const response = await fetch(`${configuredBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...authHeaders,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || `Agent API HTTP ${response.status}`);
    error.code = body.error?.code || "request_failed";
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function loginAdmin(username, password, otp = "") {
  const body = await request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password, ...(otp ? { otp } : {}) }),
  }, { publicEndpoint: true });
  setAdminSession(body.token);
  setAdminPrincipal(body.principal);
  return body;
}

export async function getLiveMfaStatus() {
  return request("/api/auth/mfa/status");
}

export async function setupLiveMfa() {
  return request("/api/auth/mfa/setup", { method: "POST" });
}

export async function enableLiveMfa(secret, code) {
  return request("/api/auth/mfa/enable", { method: "POST", body: JSON.stringify({ secret, code }) });
}

export async function disableLiveMfa(code) {
  return request("/api/auth/mfa/disable", { method: "POST", body: JSON.stringify({ code }) });
}

export async function getAdminMe() {
  const body = await request("/api/auth/me");
  setAdminPrincipal(body.principal);
  return body;
}

export async function logoutAdmin() {
  try {
    if (adminSessionToken) await request("/api/auth/logout", { method: "POST" });
  } finally {
    clearAdminSession();
  }
}

export async function getLiveDevices() {
  const body = await request("/api/admin/devices");
  return body.devices.map((device) => ({
    id: device.id,
    name: device.hostname,
    user: device.employee_name,
    team: device.employee_team,
    os: device.os_version,
    agent: device.agent_version,
    status: device.status === "online" ? "online" : "offline",
    session: device.status === "online" ? "active" : "offline",
    heartbeat: device.last_heartbeat_at ? formatRelativeTime(device.last_heartbeat_at) : "尚未连接",
    cache: device.queued_events,
    error: device.queued_events > 0 ? `${device.queued_events} 条待上传` : "无",
    employeeId: device.employee_id,
  }));
}

export async function getLiveEmployees() {
  const body = await request("/api/admin/employees");
  return (body.employees || []).map((employee) => ({
    id: employee.id,
    name: employee.name,
    title: "企业成员",
    team: employee.team,
    manager: "—",
    status: Number(employee.online_device_count || 0) > 0 ? "active" : Number(employee.device_count || 0) > 0 ? "offline" : "pending",
    focus: "暂无实时主题",
    coverage: Number(employee.device_count || 0) > 0 ? Math.round((Number(employee.online_device_count || 0) / Number(employee.device_count || 1)) * 100) : 0,
    device: employee.hostname || "未绑定设备",
    deviceCount: Number(employee.device_count || 0),
    lastHeartbeatAt: employee.last_heartbeat_at || null,
  }));
}

export async function createRegistrationCode({ employeeId, expiresInSeconds = 3600 } = {}) {
  const body = await request("/api/admin/registration-codes", {
    method: "POST",
    body: JSON.stringify({
      employee_id: employeeId,
      expires_in_seconds: expiresInSeconds,
    }),
  });
  return body;
}

export async function getLiveTeams() {
  const body = await request("/api/admin/teams");
  return (body.teams || []).map((team) => ({
    id: team.id,
    name: team.name,
    lead: team.lead_name || "—",
    members: Number(team.member_count || 0),
    activeMembers: Number(team.online_member_count || 0),
    coverage: Number(team.member_count || 0) > 0 ? Math.round((Number(team.online_member_count || 0) / Number(team.member_count || 1)) * 100) : 0,
    focus: "等待 Memory Summary",
    summary: "团队主题将在活动数据形成后显示。",
    apps: [],
    deviceCount: Number(team.device_count || 0),
  }));
}

export async function getLiveOrganization() {
  const body = await request("/api/admin/organizations");
  return body.organization || null;
}

export async function getLivePolicy() {
  const body = await request("/api/admin/policy");
  return body.policy;
}

export async function updateLivePolicy(policy) {
  const body = await request("/api/admin/policy", {
    method: "PUT",
    body: JSON.stringify({
      work_hours_start: policy.work_hours_start,
      work_hours_end: policy.work_hours_end,
      activity_checkpoint_seconds: Number(policy.activity_checkpoint_seconds || 15),
      collect_app_activity: policy.collect_app_activity !== false,
      collect_idle_status: policy.collect_idle_status !== false,
      collect_web_domains: policy.collect_web_domains !== false,
      collect_file_metadata: policy.collect_file_metadata !== false,
      excluded_processes: policy.excluded_processes || [],
      excluded_domains: policy.excluded_domains || [],
    }),
  });
  return body.policy;
}

export async function getLiveAdminSettings() {
  return request("/api/admin/settings");
}

export async function updateOrganizationSettings(settings) {
  const body = await request("/api/admin/settings/organization", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
  return body.organization;
}

export async function updateNotificationSettings(settings) {
  const body = await request("/api/admin/settings/notifications", {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });
  return body.notifications || [];
}

export async function updateActivityCategories(categories) {
  const body = await request("/api/admin/settings/categories", {
    method: "PUT",
    body: JSON.stringify({ categories }),
  });
  return body.categories || [];
}

export async function updateIntegrationSettings(integrations) {
  const body = await request("/api/admin/settings/integrations", {
    method: "PUT",
    body: JSON.stringify({ integrations }),
  });
  return body.integrations || [];
}

export async function getLivePrivacyPolicy() {
  return request("/api/admin/privacy/policy");
}

export async function updateLivePrivacyPolicy(policy) {
  return request("/api/admin/privacy/policy", {
    method: "PUT",
    body: JSON.stringify({
      version: policy.version,
      title: policy.title,
      notice: policy.notice,
    }),
  });
}

export async function getLiveRolePolicies() {
  const body = await request("/api/admin/roles");
  return body.roles || [];
}

export async function updateLiveRolePolicies(roles) {
  const body = await request("/api/admin/roles", {
    method: "PUT",
    body: JSON.stringify({ roles }),
  });
  return body.roles || [];
}

export async function getAdminAccounts() {
  const body = await request("/api/admin/accounts");
  return body.accounts || [];
}

export async function createAdminAccount(account) {
  const body = await request("/api/admin/accounts", {
    method: "POST",
    body: JSON.stringify(account),
  });
  return body.account;
}

export async function setAdminAccountStatus(accountId, enabled) {
  const action = enabled ? "enable" : "disable";
  return request(`/api/admin/accounts/${encodeURIComponent(accountId)}/${action}`, { method: "POST" });
}

export async function getLiveDeviceDetail(deviceId) {
  return request(`/api/admin/devices/${encodeURIComponent(deviceId)}`);
}

export async function setLiveDeviceStatus(deviceId, enabled) {
  const action = enabled ? "enable" : "disable";
  const body = await request(`/api/admin/devices/${encodeURIComponent(deviceId)}/${action}`, { method: "POST" });
  return body.device;
}

export async function getLiveEvents(limit = 200) {
  const body = await request(`/api/admin/events?limit=${limit}`);
  return body.events.map((event) => ({
    ...event,
    captureSource: event.source_kind ? sourceKindLabels[event.source_kind] || "活动元数据" : "活动元数据",
    id: `live-${event.event_id}`,
    day: formatDay(event.occurred_at),
    time: formatTime(event.occurred_at),
    duration: formatDuration(event.duration_seconds),
    durationSeconds: event.duration_seconds,
    recordType: "leaf",
    title: event.type === "idle" ? `${event.employee_name} · 空闲状态` : `${event.employee_name} · ${event.app_name}`,
    description: event.type === "idle"
      ? `${event.employee_name} 的 Agent 记录到一段空闲状态。`
      : `${event.employee_name} 在 ${event.app_name} 中连续活动 ${formatDuration(event.duration_seconds)}。`,
    applications: event.type === "idle" ? [] : [applicationKey(event.app_name)],
    resources: event.type === "idle" ? [] : [
      { name: event.app_name, path: "前台应用元数据", type: "application" },
      ...(event.context_label ? [{ name: event.context_label, path: "脱敏工作标识", type: "metadata" }] : []),
      ...(event.web_domain ? [{ name: event.web_domain, path: "仅域名元数据", type: "website" }] : []),
    ],
    summary: event.type === "idle"
      ? "这是一条基于系统空闲状态生成的活动元数据记录。"
      : `这是一条基于前台应用 ${event.app_name} 和活动时长生成的活动元数据记录。`,
    priorContext: "来源于 Windows Agent 的前台应用活动采集。",
    nonObvious: "该记录不包含窗口正文、键盘、剪贴板、屏幕或文件内容。",
    timeline: [{ time: formatTime(event.occurred_at), duration_seconds: event.duration_seconds, source_kind: event.source_kind, text: event.type === "idle" ? "进入空闲状态" : `前台应用：${event.app_name}`, app: event.type === "idle" ? "other" : applicationKey(event.app_name) }],
    citations: [{ label: event.hostname, detail: `${event.employee_name} · ${event.process_name}`, type: "app" }],
    confidence: 1,
    sourceKinds: event.source_kind ? [event.source_kind] : [],
    sourceTypes: event.source_kind ? [sourceKindLabels[event.source_kind] || "活动元数据"] : [],
    activitySequence: [{
      occurred_at: event.occurred_at,
      time: formatTime(event.occurred_at),
      duration_seconds: event.duration_seconds,
      app: event.type === "idle" ? "系统空闲" : event.app_name,
      app_name: event.app_name,
      source_kind: event.source_kind,
      context_label: event.context_label || null,
      context_labels: event.context_label ? event.context_label.split(/\s*[·|｜;；]\s*/).filter(Boolean) : [],
      web_domain: event.web_domain || null,
    }],
  }));
}

export async function getLiveHistory(limit = 200) {
  const body = await request(`/api/admin/history?limit=${limit}`);
  return {
    records: (body.records || []).map(normalizeLiveRecord),
    generatedAt: body.generated_at || null,
    model: body.model || null,
  };
}

export async function getLiveHistorySources(recordId) {
  const body = await request(`/api/admin/history/${encodeURIComponent(recordId)}/sources`);
  return {
    recordId: body.record_id,
    sourceRecords: (body.source_records || []).map(normalizeLiveRecord),
    sourceEvents: (body.source_events || []).map((event) => ({
      ...event,
      occurred_at_utc: event.occurred_at,
      occurred_at: formatShanghaiTime(event.occurred_at, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    })),
  };
}

export async function getMemoryJobs() {
  const body = await request("/api/admin/memory/jobs");
  return { jobs: body.jobs || [], model: body.model || "rules-v1", cadence: body.cadence || null };
}

export async function getLiveAudit() {
  const body = await request("/api/admin/audit");
  return (body.logs || []).map((log) => ({
    id: log.id,
    time: formatRelativeTime(log.created_at),
    createdAt: log.created_at,
    actor: log.actor,
    action: formatAuditAction(log.action),
    target: log.target,
    detail: log.detail || "",
    result: log.action.includes("failed") ? "需关注" : log.action === "agent_offline" ? "需关注" : "成功",
    type: log.action.startsWith("agent_") ? "agent" : log.action.includes("policy") ? "policy" : log.action.includes("retention") ? "export" : "access",
  }));
}

export async function auditLiveExport(recordIds = []) {
  return request("/api/admin/history/export", {
    method: "POST",
    body: JSON.stringify({ record_ids: recordIds }),
  });
}

export async function exportLiveAudit() {
  return request("/api/admin/audit/export");
}

export async function runRetention(before, apply = false) {
  const body = await request("/api/admin/retention", {
    method: "POST",
    body: JSON.stringify({ before, apply }),
  });
  return body;
}

export async function askLiveHistory(question, options = {}) {
  const body = await request("/api/admin/history/ask", {
    method: "POST",
    body: JSON.stringify({
      question,
      ...(options.deviceId ? { device_id: options.deviceId } : {}),
      ...(options.team ? { team: options.team } : {}),
      ...(options.limit ? { limit: options.limit } : {}),
    }),
  });
  const timeRange = body.query_time_range || body.time_range || null;
  const rangeText = timeRange?.start && timeRange?.end
    ? `时间范围：${formatTime(timeRange.start)}–${formatTime(timeRange.end)}`
    : "时间范围：暂无可用证据";
  const contextText = body.context_labels?.length ? `工作标识：${body.context_labels.join("、")}` : "工作标识：暂无明确项目标识";
  const domainText = body.web_domains?.length ? `网站：${body.web_domains.join("、")}` : "网站：未记录网站域名";
  const uncertainty = body.uncertainty || "应用活动只能说明上下文变化，不能单独证明工作效率或绩效。";
  return {
    answer: body.answer,
    evidence: (body.evidence || []).map(normalizeLiveRecord),
    applications: body.applications || [],
    contextLabels: body.context_labels || [],
    webDomains: body.web_domains || [],
    citations: body.citations || [],
    resources: body.resources || [],
    retrieval: body.retrieval || null,
    timeRange,
    team: body.query_team || options.team || null,
    caveats: [`${rangeText} · ${contextText} · ${domainText}。不确定性：${uncertainty}`, ...(body.caveats || [])],
    uncertainty,
    model: body.model,
    generatedAt: body.generated_at,
  };
}

function normalizeLiveRecord(record) {
  return {
    ...record,
    id: record.id,
    day: formatDay(record.started_at),
    time: formatTime(record.started_at),
    duration: formatDuration(record.duration_seconds),
    durationSeconds: record.duration_seconds,
    recordType: record.record_type,
    rollupScope: record.rollup_scope || (record.record_type === "rollup" ? "window" : "leaf"),
    summaryStatus: record.summary_status || record.status || "generated",
    summaryModel: record.summary_model || record.model_name || "rules-v1",
    promptVersion: record.prompt_version || record.promptVersion || "",
    userId: record.user_id,
    applications: record.applications || [],
    resources: (record.resources || []).map((resource) => ({
      ...resource,
      path: resource.source_type ? `${resource.path} · ${resource.source_type}` : resource.path,
    })),
    timeline: (record.timeline || []).map((item) => ({
      ...item,
      time: formatTime(item.occurred_at || item.time),
    })),
    citations: record.citations || [],
    priorContext: record.prior_context,
    importantContext: record.important_context || record.non_obvious,
    nonObvious: record.non_obvious || record.important_context,
    confidence: record.confidence ?? 1,
    applicationNames: record.application_names || [],
    contextKinds: record.context_kinds || [],
    contextSwitches: record.context_switches || 0,
    contextLabels: record.context_labels || [],
    webDomains: record.web_domains || [],
    sourceKinds: record.source_kinds || [],
    sourceTypes: record.source_types || [],
    resourceTypes: record.resource_types || [],
    activityFragmentCount: record.activity_fragment_count || (record.activity_sequence || []).length,
    summaryActivityCount: record.summary_activity_count || (record.summary_activity_sequence || record.activity_sequence || []).length,
    activitySequence: (record.activity_sequence || []).map((item) => ({
      ...item,
      time: formatTime(item.occurred_at || item.time),
    })),
    summaryActivitySequence: (record.summary_activity_sequence || record.activity_sequence || []).map((item) => ({
      ...item,
      time: formatTime(item.occurred_at || item.time),
    })),
  };
}

function applicationKey(appName) {
  const normalized = String(appName || "").toLowerCase();
  if (normalized.includes("edge") || normalized.includes("msedge")) return "edge";
  if (normalized.includes("chrome")) return "chrome";
  if (normalized.includes("360se")) return "browser360";
  if (normalized.includes("code") || normalized.includes("visual studio")) return "vscode";
  if (normalized.includes("wemeet") || normalized.includes("tencentmeeting") || normalized.includes("腾讯会议")) return "tencent_meeting";
  if (normalized.includes("wechat") || normalized.includes("weixin") || normalized.includes("企业微信")) return "wechat";
  if (normalized.includes("slack")) return "slack";
  if (normalized.includes("teams")) return "teams";
  if (normalized.includes("feishu") || normalized.includes("lark") || normalized.includes("dingtalk")) return "collaboration";
  if (["jira", "linear", "trello", "asana", "clickup"].some((name) => normalized.includes(name))) return "project";
  if (normalized.includes("wps")) return "wps";
  if (normalized.includes("winword") || normalized.includes("word")) return "word";
  if (normalized.includes("excel")) return "excel";
  if (normalized.includes("powerpnt") || normalized.includes("powerpoint")) return "powerpoint";
  if (normalized.includes("notion")) return "notion";
  if (normalized.includes("figma")) return "figma";
  if (normalized.includes("360zip") || normalized.includes("360 压缩")) return "archive360";
  if (normalized.includes("doubao") || normalized.includes("豆包")) return "doubao";
  if (normalized.includes("namiai")) return "namiai";
  if (normalized.includes("360tray") || normalized.includes("360 安全")) return "security360";
  if (normalized.includes("explorer")) return "explorer";
  if (normalized.includes("terminal") || normalized.includes("powershell") || normalized.includes("cmd.exe")) return "terminal";
  return "other";
}

function formatDuration(seconds) {
  const totalMinutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  return totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m` : `${totalMinutes}m`;
}

function formatTime(value) {
  return formatShanghaiTime(value, { hour: "2-digit", minute: "2-digit" });
}

function formatDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知日期";
  const today = shanghaiDayKey(Date.now());
  const yesterday = shanghaiDayKey(Date.now() - 24 * 3600_000);
  const day = shanghaiDayKey(date);
  if (day === today) return "今天";
  if (day === yesterday) return "昨天";
  return formatShanghaiDate(date, { month: "numeric", day: "numeric", weekday: "short" });
}

function formatRelativeTime(value) {
  const delta = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (delta < 1) return "刚刚";
  if (delta < 60) return `${delta} 分钟前`;
  const hours = Math.round(delta / 60);
  return `${hours} 小时前`;
}

function formatAuditAction(action) {
  return {
    admin_session_created: "创建管理会话",
    registration_code_created: "生成注册码",
    agent_enrolled: "Agent 注册绑定",
    history_asked: "查询计算机历史",
    agent_online: "Agent 上线",
    agent_offline: "Agent 离线",
    policy_changed: "修改采集策略",
    retention_deleted: "执行数据删除",
    history_exported: "导出历史记录",
  }[action] || action;
}

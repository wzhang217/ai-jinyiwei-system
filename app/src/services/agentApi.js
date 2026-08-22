const configuredBaseUrl = (import.meta.env.VITE_AGENT_API_BASE_URL || "").trim().replace(/\/$/, "");
const adminToken = (import.meta.env.VITE_AGENT_ADMIN_TOKEN || "").trim();

export const agentApiEnabled = Boolean(configuredBaseUrl && adminToken);

async function request(path, options = {}) {
  if (!agentApiEnabled) throw new Error("Agent API is not configured");
  const response = await fetch(`${configuredBaseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-admin-token": adminToken,
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Agent API HTTP ${response.status}`);
  return body;
}

export async function getLiveDevices() {
  const body = await request("/api/admin/devices");
  return body.devices.map((device) => ({
    id: device.id,
    name: device.hostname,
    user: device.employee_name,
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

export async function getLiveEvents(limit = 200) {
  const body = await request(`/api/admin/events?limit=${limit}`);
  return body.events.map((event) => ({
    ...event,
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
    applications: [],
    resources: [],
    summary: event.type === "idle"
      ? "这是一条基于系统空闲状态生成的活动元数据记录。"
      : `这是一条基于前台应用 ${event.app_name} 和活动时长生成的活动元数据记录。`,
    priorContext: "来源于 Windows Agent 的前台应用活动采集。",
    nonObvious: "该记录不包含窗口正文、键盘、剪贴板、屏幕或文件内容。",
    timeline: [{ time: formatTime(event.occurred_at), text: event.type === "idle" ? "进入空闲状态" : `前台应用：${event.app_name}`, app: "codex" }],
    citations: [{ label: event.hostname, detail: `${event.employee_name} · ${event.process_name}`, type: "app" }],
    confidence: 1,
  }));
}

export async function getLiveHistory(limit = 200) {
  const body = await request(`/api/admin/history?limit=${limit}`);
  return body.records.map((record) => ({
    ...record,
    id: record.id,
    day: formatDay(record.started_at),
    time: formatTime(record.started_at),
    duration: formatDuration(record.duration_seconds),
    durationSeconds: record.duration_seconds,
    recordType: record.record_type,
    userId: record.user_id,
    applications: record.applications || [],
    resources: record.resources || [],
    timeline: (record.timeline || []).map((item) => ({
      ...item,
      time: formatTime(item.occurred_at || item.time),
    })),
    citations: record.citations || [],
    priorContext: record.prior_context,
    nonObvious: record.non_obvious,
    confidence: record.confidence ?? 1,
    applicationNames: record.application_names || [],
  }));
}

function formatDuration(seconds) {
  const totalMinutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  return totalMinutes >= 60 ? `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m` : `${totalMinutes}m`;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDay(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知日期";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
}

function formatRelativeTime(value) {
  const delta = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (delta < 1) return "刚刚";
  if (delta < 60) return `${delta} 分钟前`;
  const hours = Math.round(delta / 60);
  return `${hours} 小时前`;
}

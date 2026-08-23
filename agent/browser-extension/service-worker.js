const STORAGE_KEY = "jinyiwei_browser_config";
const SESSION_KEY = "jinyiwei_browser_session";
const ALARM_NAME = "jinyiwei-browser-sync";

const defaultConfig = {
  serverUrl: "",
  browserToken: "",
  deviceToken: "",
  browserName: "Google Chrome",
  enabled: true,
};

async function getConfig() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...defaultConfig, ...(stored[STORAGE_KEY] || {}) };
}

async function getSession() {
  const stored = await chrome.storage.local.get(SESSION_KEY);
  return stored[SESSION_KEY] || null;
}

async function saveSession(session) {
  if (session) await chrome.storage.local.set({ [SESSION_KEY]: session });
  else await chrome.storage.local.remove(SESSION_KEY);
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase().replace(/^www\./, "");
  if (!domain || domain === "localhost" || domain.includes("/") || domain.includes("?") || domain.includes("#") || domain.includes("@")) return "";
  if (!domain.includes(".") || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain)) return "";
  return domain;
}

function safeTitleHint(domain, rawUrl) {
  const host = normalizeDomain(domain);
  if (!host) return null;
  if (host === "github.com" || host.endsWith(".github.com")) {
    try {
      const parts = new URL(rawUrl).pathname.split("/").filter(Boolean);
      if (parts.length >= 2) return `来源：GitHub · 项目：${parts[0]}-${parts[1]}`.slice(0, 120);
    } catch {
      // Keep the source label below when the URL path cannot be parsed.
    }
    return "来源：GitHub";
  }
  if (host === "gitlab.com" || host.endsWith(".gitlab.com")) return "来源：GitLab";
  if (host === "notion.so" || host.endsWith(".notion.so")) return "来源：Notion";
  if (host === "figma.com" || host.endsWith(".figma.com")) return "来源：Figma";
  if (host === "chatgpt.com" || host === "chat.openai.com") return "来源：ChatGPT";
  if (host === "codex.com" || host.endsWith(".codex.com")) return "来源：Codex";
  if (host === "atlassian.net" || host === "jira.com" || host.endsWith(".jira.com")) return "来源：Jira";
  if (host === "linear.app" || host.endsWith(".linear.app")) return "来源：Linear";
  if (host === "trello.com" || host.endsWith(".trello.com")) return "来源：Trello";
  if (host === "asana.com" || host.endsWith(".asana.com")) return "来源：Asana";
  if (host === "clickup.com" || host.endsWith(".clickup.com")) return "来源：ClickUp";
  if (host === "feishu.cn" || host.endsWith(".feishu.cn") || host === "larksuite.com" || host.endsWith(".larksuite.com")) return "来源：飞书";
  if (host === "dingtalk.com" || host.endsWith(".dingtalk.com")) return "来源：钉钉";
  if (host === "slack.com" || host.endsWith(".slack.com")) return "来源：Slack";
  if (host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com")) return "来源：Teams";
  return null;
}

function tabIdentity(tab, hint) {
  return `${normalizeDomain(tab?.url ? new URL(tab.url).hostname : "")}|${hint || ""}`;
}

function tabSource(tab) {
  if (!tab?.url) return null;
  try {
    const parsed = new URL(tab.url);
    const domain = normalizeDomain(parsed.hostname);
    if (!domain || ["chrome", "edge", "about", "file"].includes(parsed.protocol.replace(":", ""))) return null;
    return {
      domain,
      titleHint: safeTitleHint(domain, tab.url),
      identity: tabIdentity(tab, safeTitleHint(domain, tab.url)),
    };
  } catch {
    return null;
  }
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0] || null;
}

async function postEvent(session, durationSeconds, config) {
  const token = config.browserToken || config.deviceToken;
  if (!config.enabled || !config.serverUrl || !token || !session || !session.domain) return { skipped: true };
  const response = await fetch(`${config.serverUrl.replace(/\/$/, "")}/api/agent/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      events: [{
        event_id: session.eventId,
        occurred_at: session.occurredAt,
        type: "app_session",
        app_name: config.browserName,
        process_name: config.browserName.toLowerCase().includes("edge") ? "msedge.exe" : "chrome.exe",
        title_hint: session.titleHint,
        web_domain: session.domain,
        duration_seconds: Math.max(0, Math.min(86400, Math.round(durationSeconds))),
      }],
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { skipped: false };
}

async function flushSession() {
  const [session, config] = await Promise.all([getSession(), getConfig()]);
  if (!session) return;
  try {
    await postEvent(session, (Date.now() - session.startedAt) / 1000, config);
    await chrome.storage.local.set({ lastSyncAt: new Date().toISOString(), lastError: "" });
  } catch (error) {
    await chrome.storage.local.set({ lastError: `来源同步失败：${error.message}` });
  }
}

async function syncActiveTab() {
  const tab = await activeTab();
  const source = tabSource(tab);
  const current = await getSession();
  if (!source) {
    if (current) await flushSession();
    await saveSession(null);
    return;
  }
  if (current?.identity === source.identity) {
    await flushSession();
    return;
  }
  if (current) await flushSession();
  await saveSession({
    eventId: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    startedAt: Date.now(),
    identity: source.identity,
    domain: source.domain,
    titleHint: source.titleHint,
  });
  await flushSession();
}

async function ensureAlarm() {
  // Keep browser context close to the desktop Agent's default checkpoint.
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); void syncActiveTab(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); void syncActiveTab(); });
chrome.tabs.onActivated.addListener(() => { void syncActiveTab(); });
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || tab.active) void syncActiveTab();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void syncActiveTab();
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "sync_now") return false;
  syncActiveTab().then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

void ensureAlarm();

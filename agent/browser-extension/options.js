const STORAGE_KEY = "jinyiwei_browser_config";
const defaults = { serverUrl: "", browserToken: "", deviceToken: "", browserName: "Google Chrome", enabled: true };
const form = document.querySelector("#form");
const status = document.querySelector("#status");

function show(message, error = false) {
  status.textContent = message;
  status.style.color = error ? "#a34d4d" : "#52715c";
}

async function load() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const config = { ...defaults, ...(stored[STORAGE_KEY] || {}) };
  document.querySelector("#serverUrl").value = config.serverUrl;
  document.querySelector("#browserName").value = config.browserName;
  if (config.browserToken) show(`浏览器已配对，有效至 ${config.browserTokenExpiresAt ? new Date(config.browserTokenExpiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hourCycle: "h23" }) : "服务端返回的时间"}。如需重新配对，输入新配对码后保存。`);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const serverUrl = document.querySelector("#serverUrl").value.trim().replace(/\/$/, "");
  const pairingCode = document.querySelector("#pairingCode").value.trim().toUpperCase();
  const browserName = document.querySelector("#browserName").value.trim() || defaults.browserName;
  try {
    const response = await fetch(`${serverUrl}/api/agent/browser-pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pairing_code: pairingCode, browser_name: browserName }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `HTTP ${response.status}`);
    await chrome.storage.local.set({ [STORAGE_KEY]: { serverUrl, browserToken: body.browser_token, browserTokenExpiresAt: body.expires_at, browserName, enabled: true } });
    document.querySelector("#pairingCode").value = "";
    show(`配对成功：${body.employee?.name || "当前设备"}。切换标签页或点击“立即同步”开始发送安全元数据。`);
  } catch (error) {
    show(`配对失败：${error.message}`, true);
  }
});

document.querySelector("#sync").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "sync_now" }, (result) => {
    if (chrome.runtime.lastError) show(chrome.runtime.lastError.message, true);
    else if (!result?.ok) show(result?.error || "同步失败", true);
    else show("已触发同步，请在管理后台点击“立即刷新”。");
  });
});

void load();

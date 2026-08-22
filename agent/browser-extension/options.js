const STORAGE_KEY = "jinyiwei_browser_config";
const defaults = { serverUrl: "", deviceToken: "", browserName: "Google Chrome", enabled: true };
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
  document.querySelector("#deviceToken").value = config.deviceToken;
  document.querySelector("#browserName").value = config.browserName;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const config = {
    serverUrl: document.querySelector("#serverUrl").value.trim().replace(/\/$/, ""),
    deviceToken: document.querySelector("#deviceToken").value.trim(),
    browserName: document.querySelector("#browserName").value.trim() || defaults.browserName,
    enabled: true,
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: config });
  show("配置已保存。切换标签页或点击“立即同步”开始发送安全元数据。扩展不会发送 Token 到服务端以外的地址。");
});

document.querySelector("#sync").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "sync_now" }, (result) => {
    if (chrome.runtime.lastError) show(chrome.runtime.lastError.message, true);
    else if (!result?.ok) show(result?.error || "同步失败", true);
    else show("已触发同步，请在管理后台点击“立即刷新”。");
  });
});

void load();

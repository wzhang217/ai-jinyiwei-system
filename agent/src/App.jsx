import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const fallbackStatus = {
  state: "unregistered",
  server_url: "http://localhost:8787",
  device_id: null,
  employee_name: null,
  employee_team: null,
  last_sync_at: null,
  queued_events: 0,
  last_error: null,
  agent_version: "0.1.7",
  policy: {
    idle_threshold_seconds: 300,
    activity_checkpoint_seconds: 15,
    heartbeat_interval_seconds: 60,
    work_hours_start: "09:00",
    work_hours_end: "18:00",
    version: 1,
  },
};

const isTauri = () => Boolean(window.__TAURI_INTERNALS__ || window.__TAURI_METADATA__);

async function call(command, args) {
  if (!isTauri()) {
    if (command === "get_agent_status") return fallbackStatus;
    if (command === "enroll_agent") return { ...fallbackStatus, state: "online", employee_name: "演示员工", employee_team: "研发与产品中心", device_id: "demo-device" };
    return { ok: true };
  }
  return invoke(command, args);
}

function statusLabel(status) {
  return {
    unregistered: "未注册",
    online: "在线同步",
    syncing: "同步中",
    offline: "离线缓存",
    error: "需要处理",
  }[status] || status;
}

function formatTime(value) {
  if (!value) return "尚未同步";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function App() {
  const [status, setStatus] = useState(fallbackStatus);
  const [serverUrl, setServerUrl] = useState("http://localhost:8787");
  const [registrationCode, setRegistrationCode] = useState("");
  const [browserPairing, setBrowserPairing] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await call("get_agent_status");
      setStatus(next);
      if (next.server_url) setServerUrl(next.server_url);
    } catch (error) {
      setStatus((current) => ({ ...current, state: "error", last_error: String(error) }));
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const notify = (message) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3500);
  };

  const submitEnrollment = async (event) => {
    event.preventDefault();
    if (!serverUrl.trim() || !registrationCode.trim()) {
      notify("请输入服务地址和一次性注册码");
      return;
    }
    setBusy(true);
    try {
      const next = await call("enroll_agent", { serverUrl: serverUrl.trim(), registrationCode: registrationCode.trim() });
      setStatus(next);
      setRegistrationCode("");
      notify(isTauri() ? "设备注册成功，Agent 已开始同步" : "当前是浏览器预览，已显示注册后的界面");
    } catch (error) {
      notify(`注册失败：${error}`);
    } finally {
      setBusy(false);
    }
  };

  const createBrowserPairingCode = async () => {
    if (!isTauri()) {
      notify("浏览器预览不能生成真实配对码，请在 Windows Agent 中操作");
      return;
    }
    setBusy(true);
    try {
      const pairing = await call("create_browser_pairing_code");
      setBrowserPairing(pairing);
      notify("配对码已生成，有效期 10 分钟");
    } catch (error) {
      notify(`生成配对码失败：${error}`);
    } finally {
      setBusy(false);
    }
  };

  const copyBrowserPairingCode = async () => {
    if (!browserPairing?.code) return;
    try {
      await navigator.clipboard.writeText(browserPairing.code);
      notify("配对码已复制");
    } catch {
      notify("复制失败，请手动选中配对码");
    }
  };

  const registered = Boolean(status.device_id);
  const tone = useMemo(() => status.state === "online" || status.state === "syncing" ? "green" : status.state === "offline" ? "amber" : status.state === "error" ? "red" : "gray", [status.state]);

  return (
    <main className="agent-shell">
      <header className="agent-header">
        <div className="brand-mark">锦</div>
        <div>
          <strong>AI锦衣卫 Agent</strong>
          <span>企业活动元数据采集器</span>
        </div>
        <span className={`status-badge ${tone}`}><i />{statusLabel(status.state)}</span>
      </header>

      {!registered ? (
        <section className="card enrollment-card">
          <div className="card-kicker">设备注册</div>
          <h1>连接到企业工作区</h1>
            <p>输入管理员提供的一次性注册码。注册后，Agent 只会采集应用活动、脱敏工作标识、网站域名、空闲状态和同步心跳。</p>
          <form onSubmit={submitEnrollment}>
            <label>局域网服务地址<input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://192.168.1.20:8787" /></label>
            <label>一次性注册码<input value={registrationCode} onChange={(event) => setRegistrationCode(event.target.value.toUpperCase())} placeholder="JY-XXXXXXXXXX" autoComplete="off" /></label>
            <button className="primary-button" disabled={busy}>{busy ? "注册中…" : "注册此设备"}</button>
          </form>
          <div className="preview-note">{isTauri() ? "设备注册信息将保存在本机安全凭据存储中。" : "这是浏览器预览，真实采集只会在 Tauri 客户端中运行。"}</div>
        </section>
      ) : (
        <>
          <section className="card status-card">
            <div className="status-card-top"><div><div className="card-kicker">当前设备</div><h1>{status.employee_name || "已注册设备"}</h1><p>{status.employee_team || "企业工作区"} · {status.device_id}</p></div><div className={`big-status ${tone}`}><i /><strong>{statusLabel(status.state)}</strong></div></div>
            <div className="metrics"><div><span>最近同步</span><strong>{formatTime(status.last_sync_at)}</strong></div><div><span>离线队列</span><strong>{status.queued_events} 条</strong></div><div><span>工作时段</span><strong>{status.policy.work_hours_start}–{status.policy.work_hours_end}</strong></div></div>
            {status.last_error && <div className="error-box">{status.last_error}</div>}
          </section>
          <section className="card browser-pairing-card">
            <div className="section-heading"><div><div className="card-kicker">浏览器来源</div><h2>Windows 原生读取</h2></div><span className="policy-version">默认启用</span></div>
            <p className="pairing-help">Agent 默认通过 Windows 原生辅助功能读取 Chrome / Edge 当前地址栏的域名，不需要安装浏览器扩展。若浏览器策略、远程桌面或权限导致原生读取不到，可选用扩展作为兼容兜底。</p>
            <button className="secondary-button" onClick={createBrowserPairingCode} disabled={busy}>{busy ? "生成中…" : "生成可选扩展配对码"}</button>
            {browserPairing && <div className="pairing-code-box"><code>{browserPairing.code}</code><button className="secondary-button" onClick={copyBrowserPairingCode}>复制</button><small>有效至 {formatTime(browserPairing.expires_at)}</small></div>}
          </section>
          <section className="card">
            <div className="section-heading"><div><div className="card-kicker">采集策略</div><h2>当前会记录什么</h2></div><span className="policy-version">策略 v{status.policy.version}</span></div>
            <div className="policy-list"><PolicyItem title="应用活动" detail={`前台应用名称和使用时长，每 ${status.policy.activity_checkpoint_seconds || 15} 秒更新活动区间`} enabled /><PolicyItem title="脱敏工作标识" detail="仅保留开发工具项目标识，不保存原始窗口标题" enabled /><PolicyItem title="网站来源" detail="仅保留域名，不保存完整 URL 或页面内容" enabled /><PolicyItem title="空闲状态" detail={`超过 ${Math.round(status.policy.idle_threshold_seconds / 60)} 分钟进入空闲`} enabled /><PolicyItem title="同步心跳" detail={`每 ${status.policy.heartbeat_interval_seconds} 秒更新设备状态`} enabled /><PolicyItem title="屏幕、键盘和聊天正文" detail="系统级禁止采集" /></div>
          </section>
          <section className="card privacy-card"><div className="shield">✓</div><div><h2>隐私边界</h2><p>Agent 不读取键盘、剪贴板、屏幕、聊天正文、文件正文、原始窗口标题或完整网页内容；只保留有限的项目标识和网站域名。断网时数据只保存在本机队列，恢复后自动补传。</p></div></section>
        </>
      )}

      <footer><span>Agent v{status.agent_version}</span><span>Windows 10/11</span><button onClick={() => notify("退出操作由企业策略控制；关闭窗口会继续在托盘运行")}>托盘运行说明</button></footer>
      {notice && <div className="toast">{notice}</div>}
    </main>
  );
}

function PolicyItem({ title, detail, enabled = false }) {
  return <div className={`policy-item ${enabled ? "enabled" : "disabled"}`}><span className="policy-icon">{enabled ? "✓" : "—"}</span><span><strong>{title}</strong><small>{detail}</small></span></div>;
}

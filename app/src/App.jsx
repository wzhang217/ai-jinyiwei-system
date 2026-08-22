import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ArrowSquareOut,
  Browser,
  Buildings,
  CaretDown,
  CaretRight,
  ChartLineUp,
  CheckCircle,
  ChatCircleDots,
  Clock,
  Code,
  DotsThree,
  DownloadSimple,
  File,
  FileText,
  FolderOpen,
  GearSix,
  Info,
  Key,
  ListBullets,
  LockKey,
  MagnifyingGlass,
  Monitor,
  PaperPlaneTilt,
  PaintBrush,
  ShieldCheck,
  Sparkle,
  Tag,
  UserCircle,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { applications, defaultQuestions, historyRecords } from "./data.js";
import { askHistory, downloadRecordMarkdown, getRecordStats } from "./services/historyService.js";
import { agentApiEnabled, getLiveHistory } from "./services/agentApi.js";
import { AdminPage, roleLabel } from "./AdminPages.jsx";

const navGroups = [
  { label: "工作区", items: [{ id: "overview", label: "企业总览", icon: ChartLineUp }, { id: "teams", label: "团队", icon: UsersThree }, { id: "employees", label: "员工", icon: UserCircle }, { id: "history", label: "历史记录", icon: ListBullets }, { id: "memory", label: "Memory Summary", icon: Sparkle }, { id: "skill", label: "History Skill", icon: ChatCircleDots }] },
  { label: "管理", items: [{ id: "devices", label: "设备", icon: Monitor }, { id: "permissions", label: "权限", icon: LockKey }, { id: "audit", label: "审计", icon: ShieldCheck }, { id: "settings", label: "设置", icon: GearSix }] },
];

const roleNavigation = {
  admin: new Set(navGroups.flatMap((group) => group.items.map((item) => item.id))),
  manager: new Set(["overview", "teams", "employees", "history", "memory", "skill", "devices", "audit", "settings"]),
  employee: new Set(["overview", "history", "memory", "skill", "devices", "settings"]),
  auditor: new Set(["overview", "history", "memory", "skill", "audit"]),
};

const roleDefaults = { admin: "overview", manager: "teams", employee: "history", auditor: "audit" };

const appIcon = (appKey, size = 22) => {
  const app = applications[appKey] || applications.codex;
  const AppIcon = { codex: Sparkle, chrome: Browser, vscode: Code, finder: FolderOpen, wechat: ChatCircleDots, notion: FileText, figma: PaintBrush }[appKey] || Monitor;
  return <span className="app-icon" style={{ "--app-color": app.color, width: size, height: size }} title={app.name}><AppIcon size={Math.max(12, Math.round(size * 0.62))} weight="fill" /></span>;
};

function App() {
  const [role, setRole] = useState("admin");
  const [activeNav, setActiveNav] = useState("overview");
  const [navigationTarget, setNavigationTarget] = useState(null);
  const [query, setQuery] = useState("");
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [toast, setToast] = useState("");
  const [liveRecords, setLiveRecords] = useState(null);

  const visibleNavGroups = useMemo(() => navGroups.map((group) => ({ ...group, items: group.items.filter((item) => roleNavigation[role].has(item.id)) })).filter((group) => group.items.length), [role]);

  useEffect(() => {
    setActiveNav(roleDefaults[role]);
    setNavigationTarget(null);
  }, [role]);

  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    const refreshLiveRecords = () => getLiveHistory().then((records) => {
      if (!cancelled) setLiveRecords(records);
    }).catch(() => {});
    refreshLiveRecords();
    const timer = window.setInterval(refreshLiveRecords, 15000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  const notify = (message) => {
    setToast(message);
    window.clearTimeout(window.__aiJinyiweiToast);
    window.__aiJinyiweiToast = window.setTimeout(() => setToast(""), 2600);
  };

  const navigate = (page, targetId = null) => {
    if (roleNavigation[role].has(page)) {
      setNavigationTarget(targetId);
      setActiveNav(page);
      if (page === "history" && targetId) {
        const record = (liveRecords || historyRecords).find((item) => item.id === targetId);
        if (record) setSelectedRecord(record);
      }
    }
    else notify("当前角色没有访问这个页面的权限");
  };

  const activeLabel = visibleNavGroups.flatMap((group) => group.items).find((item) => item.id === activeNav)?.label || "工作区";

  return <div className="shell">
    <aside className="sidebar">
      <div className="window-controls" aria-hidden="true"><span className="window-dot window-dot-red" /><span className="window-dot window-dot-yellow" /><span className="window-dot window-dot-green" /></div>
      <button className="back-button" onClick={() => notify("已返回企业工作区")}><ArrowLeft size={19} /><span>返回工作区</span></button>
      <div className="sidebar-search"><MagnifyingGlass size={17} /><input aria-label="搜索设置和功能" placeholder="搜索设置..." value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="organization-switcher"><div className="organization-mark"><Buildings size={20} weight="fill" /></div><div><strong>锦衣卫科技</strong><span>研发与产品中心</span></div><CaretDown size={15} /></div>
      <nav className="sidebar-nav" aria-label="企业导航">{visibleNavGroups.map((group) => <div className="nav-group" key={group.label}><div className="nav-group-label">{group.label}</div>{group.items.map(({ id, label, icon: Icon }) => <button className={`nav-item ${activeNav === id ? "active" : ""}`} key={id} onClick={() => navigate(id)}><Icon size={19} weight={activeNav === id ? "fill" : "regular"} /><span>{role === "employee" && id === "overview" ? "我的工作状态" : label}</span>{id === "skill" && <span className="nav-new">AI</span>}</button>)}</div>)}</nav>
      <div className="sidebar-footer"><div className="privacy-status"><ShieldCheck size={16} weight="fill" /><span>采集策略正常</span><span className="status-dot" /></div><div className="account-row"><span className="avatar">魏</span><div><strong>Wei</strong><span>{roleLabel[role]}</span></div><DotsThree size={20} /></div></div>
    </aside>

    <main className="main-content">
      <header className="topbar"><div className="breadcrumb"><span>{role === "employee" ? "我的工作区" : "工作区"}</span><span>/</span><strong>{activeLabel}</strong></div><div className="topbar-actions"><span className="role-switch-label">查看身份</span><select className="role-select" aria-label="切换查看身份" value={role} onChange={(event) => setRole(event.target.value)}>{Object.entries(roleLabel).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className="icon-button" title="当前企业安全策略"><ShieldCheck size={19} /></button><span className="topbar-divider" /><button className="topbar-avatar">W</button></div></header>
      {activeNav === "history" ? <HistoryView role={role} query={query} records={liveRecords || historyRecords} onToast={notify} onOpenRecord={setSelectedRecord} /> : <AdminPage page={activeNav} role={role} query={query} target={navigationTarget} onNavigate={navigate} onToast={notify} />}
    </main>

    {selectedRecord && <RecordDetail record={selectedRecord} onClose={() => setSelectedRecord(null)} onExport={() => { downloadRecordMarkdown(selectedRecord); notify("已导出 Memory Summary Markdown"); }} onToast={notify} />}
    {toast && <div className="toast"><CheckCircle size={18} weight="fill" /><span>{toast}</span></div>}
  </div>;
}

function HistoryView({ role, query, records: sourceRecords = historyRecords, onToast, onOpenRecord }) {
  const [typeFilter, setTypeFilter] = useState("全部记录");
  const [expandedDays, setExpandedDays] = useState({ 今天: true, 昨天: true, "8月20日星期四": true });
  const [askOpen, setAskOpen] = useState(false);
  const [askQuery, setAskQuery] = useState("");
  const [askResult, setAskResult] = useState(null);
  const records = useMemo(() => sourceRecords.filter((record) => {
    const normalized = query.trim().toLowerCase();
    const searchable = [record.title, record.description, record.summary, record.applications.join(" "), (record.contextKinds || []).join(" "), record.resources.map((item) => item.name).join(" ")].join(" ").toLowerCase();
    return (!normalized || searchable.includes(normalized)) && (typeFilter === "全部记录" || (typeFilter === "短记录" ? record.recordType === "leaf" : record.recordType === "rollup"));
  }), [query, typeFilter, sourceRecords]);
  const grouped = useMemo(() => records.reduce((groups, record) => { groups[record.day] ||= []; groups[record.day].push(record); return groups; }, {}), [records]);
  const submitQuestion = (event) => { event.preventDefault(); if (askQuery.trim()) setAskResult(askHistory(askQuery, sourceRecords)); };
  const openSkill = () => { setAskOpen(true); window.setTimeout(() => document.querySelector(".skill-input")?.focus(), 50); };

  return <div className="page-content history-page"><section className="hero-row"><div><div className="eyebrow"><span className="eyebrow-icon"><Sparkle size={14} weight="fill" /></span>ENTERPRISE COMPUTER HISTORY</div><h1>{role === "employee" ? "我的历史记录" : "历史记录"}</h1><p>{role === "employee" ? "查看自己的 Memory Summary、活动来源和隐私说明。" : "查看按工作主题整理的企业活动记忆，而不是分散的应用日志。"}</p></div><div className="hero-meta"><span className="live-indicator" /><span>{agentApiEnabled ? "Agent 数据同步中" : "演示数据"}</span><span className="meta-separator" /><span>最后更新 2 分钟前</span></div></section><section className="skill-card"><div className="skill-card-icon"><Sparkle size={23} weight="fill" /></div><div className="skill-card-copy"><strong>询问计算机历史</strong><span>从 Memory Summary、活动来源和团队上下文中获得答案</span></div><form className="skill-form" onSubmit={submitQuestion}><input className="skill-input" value={askQuery} onChange={(event) => setAskQuery(event.target.value)} onFocus={() => setAskOpen(true)} placeholder="例如：研发团队本周有哪些连续工作主题？" /><button className="skill-submit" type="submit" aria-label="询问计算机历史"><PaperPlaneTilt size={18} weight="fill" /></button></form><button className="skill-example" onClick={() => { setAskQuery(defaultQuestions[0]); setAskOpen(true); }}><ChatCircleDots size={18} />示例问题</button></section>{askOpen && <section className="answer-card"><div className="answer-header"><div className="answer-title"><span className="answer-mark"><Sparkle size={16} weight="fill" /></span><strong>History Skill</strong><span className="answer-scope">当前范围：{role === "employee" ? "本人" : "锦衣卫科技 / 研发与产品中心"}</span></div><button className="close-inline" onClick={() => setAskOpen(false)}><X size={18} /></button></div>{!askResult ? <div className="suggestion-row">{defaultQuestions.map((question) => <button key={question} onClick={() => { setAskQuery(question); setAskResult(askHistory(question, sourceRecords)); }}>{question}</button>)}</div> : <div className="answer-body"><p className="answer-copy">{askResult.answer}</p><div className="answer-evidence"><span className="answer-label">证据记录</span>{askResult.evidence.map((record) => <button key={record.id} onClick={() => onOpenRecord(record)}><Clock size={15} />{record.title}<span>{record.duration}</span><ArrowSquareOut size={14} /></button>)}</div><div className="answer-caveat"><Info size={16} /><span>{askResult.caveats[0]}</span></div></div>}</section>}<section className="history-toolbar"><div className="section-title"><h2>历史记录</h2><button className="info-button" title="每条记录由连续活动整理为 Memory Summary"><Info size={16} /></button></div><div className="toolbar-actions"><div className="select-wrap"><Tag size={16} /><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option>全部记录</option><option>短记录</option><option>汇总记录</option></select><CaretDown size={14} /></div><button className="outline-button" onClick={() => onToast("企业历史记录受保留策略保护，已为你打开归档设置")}><Archive size={17} />归档策略</button><button className="primary-button" onClick={openSkill}><ChatCircleDots size={17} />询问历史</button></div></section><section className="record-list" aria-label="Memory Summary 历史记录">{Object.entries(grouped).map(([day, dayRecords]) => <DayGroup key={day} day={day} records={dayRecords} expanded={expandedDays[day]} onToggle={() => setExpandedDays((current) => ({ ...current, [day]: !current[day] }))} onOpen={onOpenRecord} onExport={(record) => { downloadRecordMarkdown(record); onToast("已导出 Memory Summary Markdown"); }} onToast={onToast} />)}{!records.length && <div className="empty-state"><MagnifyingGlass size={26} /><strong>没有找到匹配的历史记录</strong><span>尝试调整记录类型或搜索关键词。</span></div>}</section></div>;
}

function DayGroup({ day, records, expanded, onToggle, onOpen, onExport, onToast }) {
  return <div className="day-group"><button className="day-heading" onClick={onToggle}><span>{expanded ? <CaretDown size={17} /> : <CaretRight size={17} />}<strong>{day}</strong><span className="day-count">{records.length} 条记录</span></span><span className="day-line" /></button>{expanded && records.map((record) => <RecordCard key={record.id} record={record} onOpen={() => onOpen(record)} onExport={() => onExport(record)} onToast={onToast} />)}</div>;
}

function RecordCard({ record, onOpen, onExport, onToast }) {
  const stats = getRecordStats(record);
  return <article className="record-card"><div className="record-rail"><span className="record-time">{record.time}</span><span className="record-dot" /></div><div className="record-main"><div className="record-heading"><div className="record-title-wrap"><h3>{record.title}</h3><span className={`record-type ${record.recordType}`}>{record.recordType === "rollup" ? "汇总" : "活动"} · {record.duration}</span></div><div className="record-actions"><button title="查看完整 Memory Summary" onClick={onOpen}><ArrowSquareOut size={18} /></button><button title="导出 Markdown" onClick={onExport}><DownloadSimple size={18} /></button><button title="更多操作" onClick={() => onToast("更多操作将在审计和归档策略中提供")}><DotsThree size={20} /></button></div></div><p className="record-description">{record.description}</p><div className="record-footer"><div className="app-stack">{record.applications.slice(0, 5).map((key) => <span key={key}>{appIcon(key, 23)}</span>)}</div><div className="record-stats"><span><FileText size={15} />{stats.resources} 个资源</span><span><Clock size={15} />{stats.durationReadable}</span>{record.contextSwitches > 0 && <span><Tag size={15} />切换 {record.contextSwitches} 次</span>}<span className="confidence"><CheckCircle size={15} weight="fill" />{stats.confidence}</span></div></div></div></article>;
}

function RecordDetail({ record, onClose, onExport, onToast }) {
  const stats = getRecordStats(record);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="detail-panel" role="dialog" aria-modal="true" aria-label="Memory Summary 详情"><div className="detail-topbar"><div><span className="detail-kicker"><Sparkle size={14} weight="fill" />MEMORY SUMMARY</span><h2>{record.title}</h2><p>{record.time} · {record.duration} · {record.recordType === "rollup" ? "Rollup Summary" : "Leaf Summary"}</p></div><button className="detail-close" onClick={onClose}><X size={21} /></button></div><div className="detail-actions"><button className="outline-button" onClick={onExport}><DownloadSimple size={17} />导出 Markdown</button><button className="outline-button" onClick={() => onToast("已打开来源查看模式")}><FolderOpen size={17} />查看来源</button><button className="icon-button" onClick={() => onToast("当前记录已加入归档队列")}><Archive size={18} /></button></div><div className="detail-scroll"><div className="detail-description">{record.description}</div><div className="detail-chip-row"><span className="detail-chip"><Clock size={15} />{record.duration}</span>{record.contextKinds?.length ? <span className="detail-chip"><Tag size={15} />工作上下文：{record.contextKinds.join("、")}</span> : null}{record.contextSwitches > 0 ? <span className="detail-chip"><Tag size={15} />应用切换 {record.contextSwitches} 次</span> : null}<span className="detail-chip"><CheckCircle size={15} weight="fill" />证据置信度 {stats.confidence}</span><span className="detail-chip"><UsersThree size={15} />Wei · 研发与产品中心</span></div><DetailSection icon={<Sparkle size={18} weight="fill" />} title="Memory summary"><p>{record.summary}</p></DetailSection><DetailSection icon={<Archive size={18} />} title="Relevant prior context"><p>{record.priorContext}</p></DetailSection><DetailSection icon={<WarningCircle size={18} />} title="Important non-obvious context"><div className="uncertain-box"><WarningCircle size={17} /><p>{record.nonObvious}</p></div></DetailSection><DetailSection icon={<ListBullets size={18} />} title="Recording summary"><div className="timeline-detail">{record.timeline.map((item) => <div className="timeline-row" key={`${item.time}-${item.text}`}><span>{item.time}</span><span className="timeline-bullet" />{appIcon(item.app, 22)}<p>{item.text}</p></div>)}</div></DetailSection><DetailSection icon={<FileText size={18} />} title="Resources"><div className="resource-list">{record.resources.map((item) => <button className="resource-row" key={item.name} onClick={() => onToast(`${item.name} 已加入来源上下文`)}>{item.type === "code" ? <Code size={19} /> : item.type === "sensitive" ? <LockKey size={19} /> : <File size={19} />}<span><strong>{item.name}</strong><small>{item.path}</small></span><ArrowSquareOut size={16} /></button>)}</div></DetailSection><DetailSection icon={<Key size={18} />} title="Citations"><div className="citation-list">{record.citations.map((citation) => <button className="citation-row" key={citation.label} onClick={() => onToast(`正在定位来源：${citation.label}`)}><span className="citation-icon"><FileText size={16} /></span><span><strong>{citation.label}</strong><small>{citation.detail}</small></span><ArrowSquareOut size={15} /></button>)}</div></DetailSection><div className="detail-note"><ShieldCheck size={17} /><span>此记录只基于应用、窗口、网页和文件元数据生成，不读取聊天正文、文件正文、键盘或剪贴板。</span></div></div></aside></div>;
}

function DetailSection({ icon, title, children }) { return <section className="detail-section"><div className="detail-section-title">{icon}<h3>{title}</h3></div>{children}</section>; }

export { App };

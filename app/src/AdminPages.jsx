import { useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArrowSquareOut,
  Browser,
  Buildings,
  CaretDown,
  ChartLineUp,
  CheckCircle,
  ChatCircleDots,
  Clock,
  Code,
  Database,
  DeviceMobile,
  DownloadSimple,
  FileText,
  Fingerprint,
  GearSix,
  Globe,
  Info,
  Key,
  Lightning,
  ListBullets,
  LockKey,
  MagnifyingGlass,
  Monitor,
  PaperPlaneTilt,
  Plus,
  Pulse,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Tag,
  UserCircle,
  UsersThree,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { historyRecords } from "./data.js";
import { askHistory, downloadRecordMarkdown, downloadRecordsMarkdown, getRecordStats } from "./services/historyService.js";
import { agentApiEnabled, askLiveHistory, createRegistrationCode, demoMode, getLiveAudit, getLiveDevices, getLiveEmployees, getLiveEvents, getLivePolicy, getLiveTeams, getMemoryJobs, runRetention, updateLivePolicy } from "./services/agentApi.js";
import { auditData, deviceData, employeeData, permissionRoles, settingsData, teamData } from "./adminData.js";

const roleLabel = { admin: "企业管理员", manager: "直属管理者", employee: "员工", auditor: "审计员" };

export function AdminPage({ page, role, query, target, liveRecords, onNavigate, onToast }) {
  switch (page) {
    case "overview": return <OverviewPage role={role} liveRecords={liveRecords} onNavigate={onNavigate} onToast={onToast} />;
    case "teams": return <TeamsPage role={role} target={target} liveRecords={liveRecords} onNavigate={onNavigate} onToast={onToast} />;
    case "employees": return <EmployeesPage role={role} query={query} target={target} liveRecords={liveRecords} onNavigate={onNavigate} onToast={onToast} />;
    case "memory": return <MemoryPage role={role} query={query} target={target} liveRecords={liveRecords} onNavigate={onNavigate} onToast={onToast} />;
    case "skill": return <SkillPage role={role} records={liveRecords ?? (demoMode ? historyRecords : [])} onNavigate={onNavigate} />;
    case "devices": return <DevicesPage role={role} query={query} target={target} onToast={onToast} />;
    case "permissions": return <PermissionsPage role={role} onToast={onToast} />;
    case "audit": return <AuditPage role={role} query={query} onToast={onToast} />;
    case "settings": return <SettingsPage role={role} onToast={onToast} />;
    default: return null;
  }
}

function PageHeader({ eyebrow, title, description, meta, action }) {
  return <section className="page-header"><div><div className="page-eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div><div className="page-header-side">{meta && <span className="scope-pill"><Pulse size={14} weight="fill" />{meta}</span>}{action}</div></section>;
}

function Tabs({ tabs, active, onChange }) {
  return <div className="page-tabs">{tabs.map((tab) => <button className={active === tab ? "active" : ""} key={tab} onClick={() => onChange(tab)}>{tab}</button>)}</div>;
}

function KpiGrid({ items }) {
  return <div className="kpi-grid">{items.map((item) => <div className="kpi-card" key={item.label}><div className={`kpi-icon ${item.tone || "purple"}`}>{item.icon}</div><span className="kpi-label">{item.label}</span><strong>{item.value}</strong><small className={item.good ? "good" : ""}>{item.detail}</small></div>)}</div>;
}

function SectionCard({ title, description, action, children, className = "" }) {
  return <section className={`section-card ${className}`}><div className="section-card-header"><div><h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>{children}</section>;
}

function StatusPill({ status }) {
  const config = { online: ["在线", "online"], active: ["工作中", "online"], idle: ["空闲", "idle"], offline: ["离线", "offline"], meeting: ["会议中", "meeting"], locked: ["已锁定", "offline"], generated: ["已生成", "online"], generating: ["生成中", "meeting"], running: ["生成中", "meeting"], queued: ["排队中", "idle"], retrying: ["重试中", "meeting"], pending: ["待补全", "idle"], failed: ["失败", "offline"], allow: ["允许", "online"], success: ["成功", "online"], attention: ["需关注", "idle"] }[status] || [status, "idle"];
  return <span className={`status-pill ${config[1]}`}><span />{config[0]}</span>;
}

function MiniBars({ values, labels }) {
  return <div className="mini-bars">{values.map((value, index) => <div className="mini-bar-group" key={`${value}-${index}`}><div className="mini-bar-track"><span style={{ height: `${value}%` }} /></div><small>{labels[index]}</small></div>)}</div>;
}

function workThemeLabel(record, fallback = "暂无实时主题") {
  const value = String(record?.summary || record?.contextLabels?.[0] || record?.title || fallback).replace(/^项目：/, "").trim();
  return value.length > 88 ? `${value.slice(0, 86)}…` : value;
}

function OverviewPage({ role, liveRecords, onNavigate, onToast }) {
  const [tab, setTab] = useState("今日态势");
  const [liveDevices, setLiveDevices] = useState(null);
  const [liveJobs, setLiveJobs] = useState(null);
  const [liveTeams, setLiveTeams] = useState(null);
  const canSeeManagement = role !== "employee";
  const sourceRecords = liveRecords ?? (demoMode ? historyRecords : []);
  const scopedRecords = role === "employee"
    ? sourceRecords.filter((record) => record.userId === "employee-wei" || record.user_id === "employee-wei" || record.employee_name === "Wei")
    : role === "manager"
      ? sourceRecords.filter((record) => record.employee_team === "研发与产品中心")
      : sourceRecords;
  const rollups = scopedRecords.filter((record) => record.recordType === "rollup");
  const leafRecords = scopedRecords.filter((record) => record.recordType === "leaf");
  const apps = new Set(scopedRecords.flatMap((record) => record.applicationNames || record.application_names || []));
  const totalDuration = scopedRecords.reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0);
  const totalSwitches = scopedRecords.reduce((sum, record) => sum + Number(record.contextSwitches || record.context_switches || 0), 0);
  const averageWindow = leafRecords.length ? Math.round(leafRecords.reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0) / leafRecords.length / 60) : 0;
  const unknownRatio = leafRecords.length ? Math.round((leafRecords.filter((record) => (record.contextKinds || record.context_kinds || []).includes("其他")).length / leafRecords.length) * 1000) / 10 : 0;
  const trendDays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    return date;
  });
  const trendDurations = trendDays.map((date) => leafRecords
    .filter((record) => {
      const started = new Date(record.started_at || record.startedAt || 0);
      return started.toDateString() === date.toDateString();
    })
    .reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0));
  const maxTrendDuration = Math.max(...trendDurations, 1);
  const trendValues = trendDurations.map((value) => Math.round((value / maxTrendDuration) * 100));
  const trendLabels = trendDays.map((date) => date.toLocaleDateString("zh-CN", { weekday: "short" }).replace("周", "周"));
  const observedDevices = liveDevices || [];
  const onlineDevices = observedDevices.filter((device) => device.status === "online").length;
  const queuedEvents = observedDevices.reduce((sum, device) => sum + Number(device.cache || 0), 0);
  const teamDirectory = liveTeams ?? (demoMode ? teamData : []);
  const teamViews = teamDirectory.map((team) => {
        const teamRecords = sourceRecords.filter((record) => (record.employee_team || record.employeeTeam) === team.name);
        const activeMembers = new Set(teamRecords.map((record) => record.userId || record.user_id || record.employee_name).filter(Boolean)).size;
        const observedCoverage = teamRecords.length ? Math.min(100, Math.round((activeMembers / Math.max(1, team.members)) * 100)) : 0;
        const teamSummary = teamRecords.find((record) => record.rollupScope === "team_weekly");
        const usingLiveDirectory = Boolean(liveTeams);
        return {
          ...team,
          coverage: usingLiveDirectory ? observedCoverage : team.coverage,
          activeMembers: usingLiveDirectory ? activeMembers : team.activeMembers,
          focus: teamSummary ? workThemeLabel(teamSummary) : teamRecords.length ? workThemeLabel(teamRecords[0], "活动上下文") : team.focus || "暂无实时主题",
        };
      });
  const liveAttention = liveRecords === null ? null : [
    ...observedDevices.filter((device) => device.status === "offline" || Number(device.cache || 0) > 0).slice(0, 3).map((device) => ({ tone: "amber", title: `${device.user || device.name} 的 Agent 需要关注`, detail: `${device.status === "offline" ? "设备离线" : `${device.cache} 条事件待上传`} · 最近心跳 ${device.heartbeat}`, action: "查看设备", page: "devices" })),
    ...(liveJobs || []).filter((job) => ["retrying", "failed"].includes(job.status)).slice(0, 2).map((job) => ({ tone: "purple", title: `${job.employee_name} 的 Memory Summary ${job.status === "failed" ? "生成失败" : "正在重试"}`, detail: job.last_error || "模型生成队列需要关注", action: "查看队列", page: "memory" })),
  ];
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    Promise.all([
      getLiveDevices().catch(() => []),
      getMemoryJobs().catch(() => ({ jobs: [] })),
      getLiveTeams().catch(() => []),
    ]).then(([devices, jobs, teams]) => {
      if (cancelled) return;
      setLiveDevices(devices);
      setLiveJobs(jobs.jobs || []);
      setLiveTeams(teams);
    });
    return () => { cancelled = true; };
  }, [liveRecords]);
  return (
    <div className="page-content">
      <PageHeader
        eyebrow="ORGANIZATION PULSE"
        title={role === "employee" ? "我的工作状态" : "企业总览"}
        description={role === "employee" ? "查看自己的活动覆盖、Memory Summary 和需要补充说明的上下文。" : "从组织层面查看工作活动、Memory Summary 生成状态和需要关注的协作问题。"}
        meta="数据同步正常"
        action={<button className="primary-button" onClick={() => onNavigate("skill")}><ChatCircleDots size={17} />询问历史</button>}
      />
      <Tabs tabs={["今日态势", "趋势分析", "需要关注", "数据健康"]} active={tab} onChange={setTab} />
      {tab === "今日态势" && (
        <>
          <KpiGrid items={[
            { label: "活动覆盖率", value: `${scopedRecords.length ? 100 : 0}%`, detail: liveRecords ? "当前可见实时记录" : demoMode ? "演示数据" : "等待真实数据", icon: <Pulse size={20} />, good: true },
            { label: "当前在线设备", value: liveDevices ? `${onlineDevices} / ${observedDevices.length}` : "—", detail: liveDevices ? "按当前权限范围" : "正在读取设备心跳", icon: <Monitor size={20} />, tone: "blue" },
            { label: "Memory Summary", value: `${scopedRecords.length}`, detail: `${rollups.length} 条 Rollup · ${apps.size} 个应用`, icon: <Sparkle size={20} />, tone: "gold" },
            { label: "活动时长", value: totalDuration >= 3600 ? `${Math.floor(totalDuration / 3600)}h` : `${Math.max(0, Math.round(totalDuration / 60))}m`, detail: "只基于活动元数据", icon: <Clock size={20} />, tone: "green", good: true },
          ]} />
          {role === "employee" ? <div className="two-column-grid">
            <SectionCard title="我的连续工作主题" description="只显示属于自己的 Memory Summary 上下文">
              <div className="summary-list">
                {scopedRecords.slice(0, 2).map((record) => <button className="summary-row" key={record.id} onClick={() => onNavigate("memory", record.id)}><span className="summary-icon"><Sparkle size={17} weight="fill" /></span><span><strong>{record.title}</strong><small>{record.recordType === "rollup" ? "Rollup" : "Leaf"} · {record.duration} · {(record.applicationNames || record.applications || []).length} 个应用</small></span><ArrowSquareOut size={15} /></button>)}
                {!scopedRecords.length && <EmptyState title="暂无实时工作主题" />}
              </div>
            </SectionCard>
            <SectionCard title="我的最近记录" description="可补充说明的上下文会在详情中标记">
              <div className="summary-list">
                {scopedRecords.slice(0, 2).map((record) => <button className="summary-row" key={record.id} onClick={() => onNavigate("memory", record.id)}><span className="summary-icon"><Sparkle size={17} weight="fill" /></span><span><strong>{record.title}</strong><small>{record.duration} · 置信度 {Math.round(record.confidence * 100)}%</small></span><ArrowSquareOut size={15} /></button>)}
                {!scopedRecords.length && <EmptyState title="暂无实时记录" />}
              </div>
            </SectionCard>
          </div> : <div className="two-column-grid">
            <SectionCard title="团队工作主题" description="根据近期 Rollup Summary 整理" action={<button className="text-button" onClick={() => onNavigate("teams")}>查看全部 <ArrowSquareOut size={14} /></button>}>
              <div className="team-theme-list">
                {teamViews.map((team) => (
                  <button className="team-theme-row" key={team.id} onClick={() => onNavigate("teams", team.id)}>
                    <span className="theme-index">{team.name.slice(0, 1)}</span>
                    <span className="theme-copy"><strong>{team.name}</strong><small>{team.focus} · {team.members} 人</small></span>
                    <span className="theme-progress"><span style={{ width: `${team.coverage}%` }} /></span>
                    <b>{team.coverage}%</b><ArrowSquareOut size={15} />
                  </button>
                ))}
              </div>
            </SectionCard>
            <SectionCard title="最近的 Rollup Summary" description="组织中最近生成的长周期记录">
              <div className="summary-list">
                {rollups.slice(0, 6).map((record) => (
                  <button className="summary-row" key={record.id} onClick={() => onNavigate("memory", record.id)}>
                    <span className="summary-icon"><Sparkle size={17} weight="fill" /></span>
                    <span><strong>{record.title}</strong><small>{record.duration} · {record.applications.length} 个应用 · 置信度 {Math.round(record.confidence * 100)}%</small></span>
                    <ArrowSquareOut size={15} />
                  </button>
                ))}
              </div>
            </SectionCard>
          </div>}
        </>
      )}
      {tab === "趋势分析" && (
        <>
          <KpiGrid items={[
            { label: "本周工作主题", value: `${new Set(rollups.filter((record) => Date.parse(record.started_at) >= Date.now() - 7 * 24 * 3600_000).map((record) => record.title)).size}`, detail: "来自可见 Rollup Summary", icon: <Sparkle size={20} />, good: true },
            { label: "平均连续工作窗口", value: averageWindow ? `${averageWindow}m` : "—", detail: "来自 Leaf Summary", icon: <Clock size={20} />, tone: "blue", good: true },
            { label: "应用切换密度", value: totalDuration ? `${(totalSwitches / Math.max(totalDuration / 3600, 1 / 60)).toFixed(1)} / h` : "—", detail: "只表示上下文变化", icon: <Lightning size={20} />, tone: "gold" },
            { label: "未知活动比例", value: `${unknownRatio}%`, detail: "无法可靠分类的活动", icon: <WarningCircle size={20} />, tone: "green", good: true },
          ]} />
          <SectionCard title="活动趋势" description="过去 7 天的组织级活动构成">
            <MiniBars values={trendValues} labels={trendLabels} />
            <div className="chart-legend"><span><i className="legend-dot purple" />工作活动</span><span><i className="legend-dot gray" />会议与沟通</span><span><i className="legend-dot amber" />未知活动</span></div>
          </SectionCard>
        </>
      )}
      {tab === "需要关注" && (
        <SectionCard title="需要关注" description="只展示工作负载、数据质量和疑似非工作活动，不作为自动绩效判断">
          <div className="attention-list">
            {liveAttention === null && demoMode ? <>
              <AttentionRow tone="amber" title="Ming 的浏览器扩展待更新" detail="可能导致网页页面标题采集不完整 · 7 分钟前" action="查看设备" onClick={() => onNavigate("devices")} />
              <AttentionRow tone="purple" title="研发与产品中心周四下午任务切换较密集" detail="可能与任务详情验证和客户沟通有关 · 置信度 0.76" action="查看团队" onClick={() => onNavigate("teams")} />
            </> : liveAttention?.length ? liveAttention.filter((item) => canSeeManagement || item.page !== "teams").map((item) => <AttentionRow key={`${item.page}-${item.title}`} tone={item.tone} title={item.title} detail={item.detail} action={item.action} onClick={() => onNavigate(item.page)} />) : <EmptyState title="暂无需要关注的实时异常" />}
          </div>
        </SectionCard>
      )}
      {tab === "数据健康" && (
        <SectionCard title="数据健康" description="采集、摘要和权限链路的当前状态">
          <div className="health-grid">
                {liveRecords === null && demoMode ? <>
              <HealthRow title="Windows Agent 在线率" value="96.2%" detail="演示数据" status="online" />
              <HealthRow title="Memory Summary 生成队列" value="8 条" detail="演示数据" status="generating" />
              <HealthRow title="Citations 完整度" value="98.4%" detail="演示数据" status="online" />
              <HealthRow title="权限同步" value="正常" detail="演示数据" status="online" />
            </> : <>
              <HealthRow title="Windows Agent 在线率" value={liveDevices ? `${observedDevices.length ? Math.round((onlineDevices / observedDevices.length) * 100) : 0}%` : "—"} detail={liveDevices ? `${onlineDevices} / ${observedDevices.length} 台设备` : "正在读取设备心跳"} status={liveDevices && onlineDevices === observedDevices.length ? "online" : "attention"} />
              <HealthRow title="Memory Summary 生成队列" value={liveJobs ? `${liveJobs.filter((job) => ["queued", "retrying", "running"].includes(job.status)).length} 条` : "—"} detail="来自服务端生成任务" status={liveJobs?.some((job) => job.status === "failed") ? "attention" : liveJobs?.length ? "generating" : "online"} />
              <HealthRow title="Citations 完整度" value={`${scopedRecords.length ? Math.round((scopedRecords.filter((record) => record.citations?.length).length / scopedRecords.length) * 100) : 0}%`} detail="当前可见 Memory Summary" status="online" />
              <HealthRow title="权限同步" value="已生效" detail="当前页面使用服务端权限范围" status="online" />
            </>}
          </div>
                </SectionCard>
      )}
    </div>
  );
}

function AttentionRow({ tone, title, detail, action, onClick }) {
  return <div className="attention-row"><span className={`attention-icon ${tone}`}><WarningCircle size={19} weight="fill" /></span><span><strong>{title}</strong><small>{detail}</small></span><button className="text-button" onClick={onClick}>{action}<ArrowSquareOut size={14} /></button></div>;
}

function HealthRow({ title, value, detail, status }) {
  return <div className="health-row"><span className="health-icon"><CheckCircle size={18} weight="fill" /></span><span><strong>{title}</strong><small>{detail}</small></span><b>{value}</b><StatusPill status={status} /></div>;
}

function TeamsPage({ role, target, liveRecords, onNavigate, onToast }) {
  const [tab, setTab] = useState("团队列表");
  const [liveTeams, setLiveTeams] = useState(null);
  const [directoryError, setDirectoryError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    getLiveTeams().then((teams) => {
      if (!cancelled) setLiveTeams(teams);
    }).catch((error) => {
      if (!cancelled) setDirectoryError(error.message);
    });
    return () => { cancelled = true; };
  }, [role]);
  const directoryTeams = liveTeams ?? (demoMode ? teamData : []);
  const visibleTeams = role === "manager" ? directoryTeams.filter((team) => team.name === "研发与产品中心") : directoryTeams;
  const sourceRecords = liveRecords ?? (demoMode ? historyRecords : []);
  const teamCards = visibleTeams.map((team) => {
    const records = sourceRecords.filter((record) => (record.employee_team || record.employeeTeam) === team.name);
    const activeMembers = new Set(records.map((record) => record.userId || record.user_id || record.employee_name).filter(Boolean)).size;
    const liveCoverage = records.length ? Math.min(100, Math.round((activeMembers / Math.max(1, team.members)) * 100)) : 0;
    const latest = records[0];
    const latestTeamSummary = records.find((record) => record.rollupScope === "team_weekly");
    return {
      ...team,
      activeMembers,
      coverage: agentApiEnabled && liveRecords !== null ? liveCoverage : team.coverage,
      focus: latestTeamSummary ? workThemeLabel(latestTeamSummary) : latest ? workThemeLabel(latest) : team.focus,
      liveRecordCount: records.length,
    };
  });
  const [selectedTeam, setSelectedTeam] = useState(() => teamCards.find((team) => team.id === target) || teamCards[0]);
  const [skillQuestion, setSkillQuestion] = useState("");
  const [skillAnswer, setSkillAnswer] = useState(null);
  const teamRecords = sourceRecords.filter((record) => record.employee_team === selectedTeam?.name || record.employeeTeam === selectedTeam?.name);
  const teamRollups = teamRecords.filter((record) => record.rollupScope === "team_weekly");
  const topicRecords = (teamRollups.length ? teamRollups : teamRecords).filter((record) => record.title).slice(0, 4);
  const tabs = ["团队列表", "团队详情", "团队趋势", "工作主题", "团队 Skill"];
  const openTeam = (team) => { setSelectedTeam(team); setTab("团队详情"); };
  useEffect(() => {
    const nextTeam = teamCards.find((team) => team.id === target);
    if (nextTeam) {
      setSelectedTeam(nextTeam);
      setTab("团队详情");
    } else if (!selectedTeam || !teamCards.some((team) => team.id === selectedTeam.id)) {
      setSelectedTeam(teamCards[0] || null);
    }
  }, [target, role, liveRecords, teamCards.length]);
  const runTeamQuestion = async (event) => {
    event.preventDefault();
    if (!skillQuestion.trim()) return;
    try {
      if (agentApiEnabled) setSkillAnswer(await askLiveHistory(skillQuestion, { team: selectedTeam?.name }));
      else if (demoMode) setSkillAnswer(askHistory(skillQuestion, sourceRecords));
      else throw new Error("Agent API is not configured; connect the real server or explicitly enable demo mode");
    } catch (error) {
      onToast(`History Skill 查询失败：${error.message}`);
    }
  };
  return <div className="page-content"><PageHeader eyebrow="TEAM WORKSPACE" title="团队" description="以团队为单位查看工作主题、活动覆盖和 Memory Summary。" meta={`${teamCards.length} 个团队`} action={<button className="outline-button" onClick={() => onToast("创建团队需要连接组织目录 API")}><Plus size={17} />新建团队</button>} />{directoryError && <div className="error-box">组织目录读取失败：{directoryError}</div>}<Tabs tabs={tabs} active={tab} onChange={setTab} />{tab === "团队列表" && <SectionCard title="团队列表" description="点击团队进入成员、趋势和工作主题详情"><div className="team-grid">{teamCards.map((team) => <button className="team-card" key={team.id} onClick={() => openTeam(team)}><div className="team-card-top"><span className="team-avatar">{team.name.slice(0, 1)}</span><span className="team-card-arrow"><ArrowSquareOut size={16} /></span></div><h3>{team.name}</h3><p>{team.focus}</p><div className="team-card-meta"><span><UsersThree size={14} />{team.members} 人</span><span><Pulse size={14} />{team.coverage}% 覆盖</span></div><div className="team-card-progress"><span style={{ width: `${team.coverage}%` }} /></div><small>负责人：{team.lead}{agentApiEnabled && liveRecords !== null ? ` · ${team.liveRecordCount} 条实时记录` : ""}</small></button>)}</div></SectionCard>}{tab === "团队详情" && selectedTeam && <TeamDetail team={selectedTeam} employees={directoryEmployees} liveRecords={teamRecords} onNavigate={onNavigate} onToast={onToast} />}{tab === "团队趋势" && selectedTeam && <><KpiGrid items={[{ label: "可见记录", value: `${teamRecords.length}`, detail: "当前权限范围", icon: <Pulse size={20} />, good: true }, { label: "连续工作窗口", value: `${teamRollups.length}`, detail: "团队周汇总", icon: <Clock size={20} />, tone: "blue" }, { label: "应用上下文", value: `${new Set(teamRecords.flatMap((record) => record.applicationNames || [])).size}`, detail: "去重后应用数", icon: <UsersThree size={20} />, tone: "green" }, { label: "切换次数", value: `${teamRecords.reduce((sum, record) => sum + Number(record.contextSwitches || 0), 0)}`, detail: "只表示上下文变化", icon: <Lightning size={20} />, tone: "gold" }]} /><SectionCard title={`${selectedTeam.name} 活动趋势`} description="当前已接入的实时 Memory Summary"><MiniBars values={[teamRecords.length, teamRollups.length, topicRecords.length, 0, 0, 0, 0]} labels={["记录", "周汇总", "主题", "待补", "待补", "待补", "今天"]} /></SectionCard></>}{tab === "工作主题" && selectedTeam && <SectionCard title="连续工作主题" description="由团队周汇总和实时活动记录聚合"><div className="topic-list">{topicRecords.length ? topicRecords.map((record, index) => <TopicRow key={record.id} rank={String(index + 1).padStart(2, "0")} title={record.title} detail={`${record.duration} · ${record.recordType === "rollup" ? "团队 Rollup" : "Leaf 活动"}`} value={`${Math.max(12, 42 - index * 8)}%`} />) : <EmptyState title="暂无团队主题" />}</div></SectionCard>}{tab === "团队 Skill" && selectedTeam && <SectionCard title="团队 History Skill" description={`当前查询范围：${selectedTeam.name}`}><form className="team-skill-form" onSubmit={runTeamQuestion}><ChatCircleDots size={20} /><input value={skillQuestion} onChange={(event) => setSkillQuestion(event.target.value)} placeholder="询问这个团队最近的工作主题..." /><button className="primary-button" type="submit"><PaperPlaneTilt size={16} />提问</button></form>{skillAnswer ? <SkillAnswer result={skillAnswer} onOpen={() => onNavigate("history")} /> : <div className="question-grid"><button onClick={() => setSkillQuestion("这个团队本周主要在做什么？")}>这个团队本周主要在做什么？</button><button onClick={() => setSkillQuestion("团队是否存在频繁任务切换？")}>团队是否存在频繁任务切换？</button></div>}</SectionCard>}</div>;
}

function TeamDetail({ team, employees = employeeData, liveRecords = [], onNavigate, onToast }) {
  const members = employees.filter((employee) => employee.team.includes(team.name.replace("中心", "")) || employee.team === team.name);
  const teamRollups = liveRecords.filter((record) => record.rollupScope === "team_weekly");
  return <><SectionCard title={team.name} description={`${team.focus} · 负责人 ${team.lead}`} action={<button className="outline-button" onClick={() => onToast("团队设置将在组织目录接入后开放")}><GearSix size={16} />团队设置</button>}><div className="detail-summary-grid"><div><span>成员</span><strong>{team.members}</strong><small>活跃 {team.activeMembers} 人</small></div><div><span>实时记录</span><strong>{liveRecords.length}</strong><small>当前权限范围</small></div><div><span>主要工具</span><strong>{new Set(liveRecords.flatMap((record) => record.applicationNames || [])).size}</strong><small>{[...new Set(liveRecords.flatMap((record) => record.applicationNames || []))].slice(0, 2).join("、") || "暂无"}</small></div><div><span>团队周汇总</span><strong>{teamRollups.length}</strong><small>可回溯到 Leaf</small></div></div></SectionCard><div className="two-column-grid"><SectionCard title="团队成员" description="点击成员查看个人活动"><div className="compact-list">{members.length ? members.map((employee) => <button className="compact-row" key={employee.id} onClick={() => onNavigate("employees", employee.id)}><span className="person-avatar">{employee.name.slice(0, 1)}</span><span><strong>{employee.name}</strong><small>{employee.title} · {employee.focus}</small></span><StatusPill status={employee.status} /><ArrowSquareOut size={15} /></button>) : <EmptyState title="暂无成员数据" />}</div></SectionCard><SectionCard title="团队 Memory Summary" description="最近生成的团队级记录"><div className="summary-list">{teamRollups.length ? teamRollups.slice(0, 3).map((record) => <button className="summary-row" key={record.id} onClick={() => onNavigate("memory", record.id)}><span className="summary-icon"><Sparkle size={17} weight="fill" /></span><span><strong>{record.title}</strong><small>{record.duration} · {record.source_record_ids?.length || record.timeline?.length || 0} 个下层记录</small></span><ArrowSquareOut size={15} /></button>) : <EmptyState title="暂无团队周汇总" />}</div></SectionCard></div></>;
}

function TopicRow({ rank, title, detail, value }) {
  return <div className="topic-row"><span className="topic-rank">{rank}</span><span><strong>{title}</strong><small>{detail}</small></span><span className="topic-track"><span style={{ width: value }} /></span><b>{value}</b></div>;
}

function EmployeesPage({ role, query, target, liveRecords, onNavigate, onToast }) {
  const [tab, setTab] = useState("员工目录");
  const [liveEmployees, setLiveEmployees] = useState(null);
  const [liveDevices, setLiveDevices] = useState(null);
  const [directoryError, setDirectoryError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    getLiveEmployees().then((employees) => {
      if (!cancelled) setLiveEmployees(employees);
    }).catch((error) => {
      if (!cancelled) setDirectoryError(error.message);
    });
    return () => { cancelled = true; };
  }, [role]);
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    getLiveDevices().then((devices) => {
      if (!cancelled) setLiveDevices(devices);
    }).catch((error) => {
      if (!cancelled) setDirectoryError(error.message);
    });
    return () => { cancelled = true; };
  }, [role]);
  const directoryEmployees = liveEmployees ?? (demoMode ? employeeData : []);
  const visibleEmployees = role === "manager" ? directoryEmployees.filter((employee) => employee.team === "研发与产品中心") : directoryEmployees;
  const [selected, setSelected] = useState(() => visibleEmployees.find((employee) => employee.id === target) || visibleEmployees[0]);
  const search = query.trim().toLowerCase();
  const sourceRecords = liveRecords ?? (demoMode ? historyRecords : []);
  const liveEmployeeData = agentApiEnabled && liveRecords !== null
    ? visibleEmployees.map((employee) => {
        const records = sourceRecords.filter((record) => record.userId === employee.id || record.user_id === employee.id || record.employee_name === employee.name);
        const latest = records[0];
        const focus = latest?.contextLabels?.[0] || latest?.title || "暂无实时主题";
        return {
          ...employee,
          status: records.length ? "active" : "offline",
          focus,
          coverage: records.length ? 100 : 0,
        };
      })
    : visibleEmployees;
  const employees = liveEmployeeData.filter((employee) => !search || `${employee.name} ${employee.title} ${employee.team} ${employee.focus}`.toLowerCase().includes(search));
  const selectedRecords = sourceRecords.filter((record) => record.userId === selected?.id || record.user_id === selected?.id || record.employee_name === selected?.name);
  useEffect(() => {
    const nextEmployee = visibleEmployees.find((employee) => employee.id === target);
    if (nextEmployee) {
      setSelected(nextEmployee);
      setTab("个人概览");
    } else if (!selected || !visibleEmployees.some((employee) => employee.id === selected.id)) {
      setSelected(visibleEmployees[0] || null);
    }
  }, [target, role, liveEmployees, visibleEmployees.length]);
  const selectedDevice = liveDevices?.find((device) => device.employeeId === selected?.id)
    || (demoMode ? deviceData.find((device) => device.user === selected?.name) || deviceData[0] : null);
  return <div className="page-content"><PageHeader eyebrow="PEOPLE DIRECTORY" title={role === "employee" ? "我的工作状态" : "员工"} description={role === "employee" ? "查看自己的历史记录、设备状态和隐私说明。" : "以个人为单位查看工作上下文和可授权的历史记录。"} meta={`${employees.length} 位成员`} action={<button className="outline-button" onClick={() => onToast(agentApiEnabled ? "员工目录已从服务端同步" : "员工目录将通过组织目录 API 同步")}><UsersThree size={17} />同步成员</button>} />{directoryError && <div className="error-box">员工目录读取失败：{directoryError}</div>}<Tabs tabs={["员工目录", "个人概览", "历史记录", "Memory Summary", "工作模式", "设备"]} active={tab} onChange={setTab} />{tab === "员工目录" && <SectionCard title="员工目录" description="所有员工使用统一采集规则，查看范围由组织关系决定"><div className="table-toolbar"><span className="table-count">{employees.length} 位成员</span><span className="table-hint"><MagnifyingGlass size={15} />左侧搜索可筛选姓名、团队和工作主题</span></div><div className="data-table"><div className="table-row table-head"><span>成员</span><span>团队与职位</span><span>当前主题</span><span>覆盖率</span><span>状态</span><span /></div>{employees.map((employee) => <button className="table-row" key={employee.id} onClick={() => { setSelected(employee); setTab("个人概览"); }}><span className="table-person"><span className="person-avatar">{employee.name.slice(0, 1)}</span><strong>{employee.name}</strong></span><span><strong>{employee.team}</strong><small>{employee.title}</small></span><span>{employee.focus}</span><span className="coverage-value">{agentApiEnabled && liveRecords !== null ? (employee.coverage ? `${employee.coverage}%` : "—") : `${employee.coverage}%`}</span><span><StatusPill status={employee.status} /></span><ArrowSquareOut size={16} /></button>)}</div></SectionCard>}{tab === "个人概览" && selected && <EmployeeDetail employee={selected} records={selectedRecords} onNavigate={onNavigate} onToast={onToast} />}{tab === "历史记录" && selected && <SectionCard title={`${selected.name} 的历史记录`} description="个人时间线下钻入口"><div className="deep-link-card"><Sparkle size={24} /><span><strong>打开个人 Memory Summary 时间线</strong><small>{selectedRecords.length} 条实时记录 · 按日期、Leaf/Rollup、应用和资源筛选</small></span><button className="primary-button" onClick={() => onNavigate("history")}><ArrowSquareOut size={16} />打开历史记录</button></div></SectionCard>}{tab === "Memory Summary" && selected && <SectionCard title={`${selected.name} 的 Memory Summary`} description="管理个人记忆文档"><MemoryRows records={selectedRecords} onOpen={(record) => onNavigate("memory", record.id)} onExport={() => onToast("已开始导出个人 Memory Summary")} /></SectionCard>}{tab === "工作模式" && selected && <WorkPattern employee={selected} records={selectedRecords} />}{tab === "设备" && selected && <SectionCard title={`${selected.name} 的设备`} description="当前设备与采集状态">{selectedDevice ? <DeviceRow device={selectedDevice} onToast={onToast} /> : <EmptyState title="暂无绑定设备" />}</SectionCard>}</div>;
}

function EmployeeDetail({ employee, records = [], onNavigate, onToast }) {
  const durationSeconds = records.reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0);
  const applications = new Set(records.flatMap((record) => record.applicationNames || record.application_names || record.applications || []));
  const topics = new Set(records.map((record) => record.title).filter(Boolean));
  const switches = records.reduce((sum, record) => sum + Number(record.contextSwitches || record.context_switches || 0), 0);
  const averageWindow = records.length ? Math.max(1, Math.round(durationSeconds / records.length / 60)) : 0;
  const coverage = records.length ? "100%" : agentApiEnabled ? "—" : `${employee.coverage}%`;
  return <><SectionCard title={employee.name} description={`${employee.title} · ${employee.team}`} action={<button className="outline-button" onClick={() => onToast("个人权限详情已打开")}><LockKey size={16} />查看权限</button>}><div className="profile-summary"><span className="profile-avatar">{employee.name.slice(0, 1)}</span><div><strong>{employee.name}</strong><small>直属管理者：{employee.manager}</small><small>设备：{employee.device}</small></div><div className="profile-status"><StatusPill status={records.length ? "active" : agentApiEnabled ? "offline" : employee.status} /><span>覆盖率 {coverage}</span></div></div></SectionCard><div className="two-column-grid"><SectionCard title="个人活动概览" description="最近工作窗口"><KpiGrid items={[{ label: "活跃覆盖", value: coverage, detail: records.length ? "当前可见实时记录" : "暂无实时记录", icon: <Pulse size={19} />, good: Boolean(records.length) }, { label: "主要主题", value: `${topics.size || 0} 个`, detail: records[0]?.title || employee.focus, icon: <Sparkle size={19} />, tone: "gold" }, { label: "平均窗口", value: averageWindow ? `${averageWindow}m` : "—", detail: records.length ? `${applications.size} 个应用上下文` : "等待 Agent 数据", icon: <Clock size={19} />, tone: "blue" }, { label: "应用切换", value: `${switches} 次`, detail: "只表示上下文变化", icon: <WarningCircle size={19} />, tone: "green" }]} /></SectionCard><SectionCard title="快速下钻" description="从个人概览进入原始历史和记忆文档"><div className="quick-link-list"><button onClick={() => onNavigate("history")}><ListBullets size={18} /><span><strong>历史时间线</strong><small>{records.length} 条可见记录 · 按日期组织</small></span><ArrowSquareOut size={15} /></button><button onClick={() => onNavigate("memory")}><Sparkle size={18} /><span><strong>Memory Summary</strong><small>查看 Leaf、Rollup 和来源关系</small></span><ArrowSquareOut size={15} /></button></div></SectionCard></div></>;
}

function WorkPattern({ employee, records = [] }) {
  const durationSeconds = records.reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0);
  const switches = records.reduce((sum, record) => sum + Number(record.contextSwitches || record.context_switches || 0), 0);
  const unknown = records.filter((record) => (record.contextKinds || record.context_kinds || []).includes("其他")).length;
  const concentration = records.length ? Math.round((new Set(records.map((record) => record.contextLabels?.[0] || record.title)).size / records.length) * 100) : 0;
  const switchDensity = durationSeconds ? (switches / Math.max(durationSeconds / 3600, 1 / 60)).toFixed(1) : "—";
  const unknownRatio = records.length ? `${Math.round((unknown / records.length) * 1000) / 10}%` : "—";
  const trendDays = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (6 - index));
    return date;
  });
  const trend = trendDays.map((date) => records.filter((record) => new Date(record.started_at || record.startedAt || 0).toDateString() === date.toDateString()).reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0));
  const maxTrend = Math.max(...trend, 1);
  return <SectionCard title={`${employee.name} 的工作模式`} description="趋势用于辅助理解上下文，不单独作为绩效结论"><div className="pattern-grid"><div className="pattern-card"><span>工作主题集中度</span><strong>{records.length ? `${concentration}%` : "—"}</strong><small>{records.length ? "当前可见记录" : "等待 Agent 数据"}</small></div><div className="pattern-card"><span>任务切换密度</span><strong>{switchDensity}{switchDensity === "—" ? "" : " / h"}</strong><small>只表示上下文变化</small></div><div className="pattern-card"><span>活动时长</span><strong>{durationSeconds ? `${Math.round(durationSeconds / 60)}m` : "—"}</strong><small>当前可见记录</small></div><div className="pattern-card"><span>未知活动</span><strong>{unknownRatio}</strong><small>无法可靠分类的活动</small></div></div><MiniBars values={trend.map((value) => Math.round((value / maxTrend) * 100))} labels={trendDays.map((date) => date.toLocaleDateString("zh-CN", { weekday: "short" }).replace("周", "周"))} /></SectionCard>;
}

function MemoryPage({ role, query, target, liveRecords, onNavigate, onToast: notify }) {
  const [tab, setTab] = useState("全部记录");
  const [selected, setSelected] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState("");
  const sourceRecords = liveRecords ?? (demoMode ? historyRecords : []);
  const onToast = (message) => {
    if (message === "已开始导出团队周汇总") {
      void exportTeamRollups();
      return;
    }
    notify(message);
  };
  const records = sourceRecords.filter((record) => tab === "全部记录" || (tab === "Leaf" ? record.recordType === "leaf" : tab === "Rollup" ? record.recordType === "rollup" : tab === "待生成" ? false : true)).filter((record) => !query.trim() || `${record.title} ${record.description} ${record.summary}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    if (tab !== "待生成" || !agentApiEnabled) return undefined;
    let active = true;
    setJobsLoading(true);
    setJobsError("");
    getMemoryJobs().then((result) => {
      if (active) setJobs(result.jobs.filter((job) => ["queued", "retrying", "running", "failed"].includes(job.status)));
    }).catch((error) => {
      if (active) setJobsError(error.message);
    }).finally(() => {
      if (active) setJobsLoading(false);
    });
    return () => { active = false; };
  }, [tab]);
  useEffect(() => {
    const nextRecord = sourceRecords.find((record) => record.id === target);
    if (nextRecord) setSelected(nextRecord);
  }, [target, sourceRecords]);
  const exportRecord = async (record) => {
    try {
      if (agentApiEnabled) await auditLiveExport([record.id]);
      downloadRecordMarkdown(record);
      onToast("已导出 Memory Summary Markdown");
    } catch (error) {
      onToast(`导出失败：${error.message}`);
    }
  };
  const exportVisibleRecords = async () => {
    try {
      if (agentApiEnabled) await auditLiveExport(sourceRecords.map((record) => record.id));
      downloadRecordsMarkdown(sourceRecords);
      onToast("已开始导出当前可见记录");
    } catch (error) {
      onToast(`导出失败：${error.message}`);
    }
  };
  const exportTeamRollups = async () => {
    const teamRecords = sourceRecords.filter((record) => record.rollupScope === "team_weekly");
    try {
      if (agentApiEnabled) await auditLiveExport(teamRecords.map((record) => record.id));
      downloadRecordsMarkdown(teamRecords);
      onToast("已导出团队周汇总");
    } catch (error) {
      onToast(`导出失败：${error.message}`);
    }
  };
  return <div className="page-content"><PageHeader eyebrow="MEMORY DOCUMENTS" title="Memory Summary" description="管理按工作主题生成的记忆文档、层级关系和来源引用。" meta={`${records.length} 条可见记录`} action={<button className="outline-button" onClick={exportVisibleRecords}><DownloadSimple size={17} />批量导出</button>} /><Tabs tabs={["全部记录", "Leaf", "Rollup", "待生成", "来源关系", "导出"]} active={tab} onChange={setTab} />{["全部记录", "Leaf", "Rollup"].includes(tab) && <SectionCard title={`${tab} Memory Summary`} description="数据库为权威数据源，Markdown 是标准化导出格式"><MemoryRows records={records} onOpen={(record) => setSelected(record)} onExport={exportRecord} /></SectionCard>}{tab === "待生成" && <SectionCard title="摘要生成队列" description={agentApiEnabled ? "来自服务端的真实生成任务，可追踪失败和重试状态。" : "连接服务端后显示真实生成队列。"}>{jobsLoading && <div className="queue-card"><span className="queue-icon"><Sparkle size={20} weight="fill" /></span><span><strong>正在读取生成队列…</strong><small>服务端会按限流策略逐批调用模型。</small></span><StatusPill status="generating" /></div>}{jobsError && <div className="error-box">读取摘要队列失败：{jobsError}</div>}{!jobsLoading && !jobsError && (jobs.length ? jobs.map((job) => <div className="queue-card" key={job.id}><span className={`queue-icon ${job.status === "failed" ? "gold" : ""}`}>{job.status === "failed" ? <WarningCircle size={20} weight="fill" /> : <Sparkle size={20} weight="fill" />}</span><span><strong>{job.employee_name} · {job.record_type === "rollup" ? `${job.rollup_scope || "window"} Rollup` : "Leaf Summary"}</strong><small>{job.status} · 尝试 {job.attempts} 次 · {job.last_error || "等待模型生成"}</small></span><StatusPill status={job.status === "succeeded" ? "generated" : job.status === "failed" ? "failed" : job.status === "running" ? "generating" : "pending"} /></div>) : <EmptyState title="暂无待处理摘要任务" />)}</SectionCard>}{tab === "来源关系" && <SectionCard title="来源关系" description="从 Rollup Summary 回溯到 Leaf Summary 和原始事件"><div className="source-graph"><div className="source-node root"><Sparkle size={18} /><span><strong>实时 Memory Summary</strong><small>Rollup · 可回溯</small></span></div><div className="graph-connector" /><div className="source-children"><div className="source-node"><Clock size={17} /><span><strong>Leaf Summary</strong><small>应用活动窗口</small></span></div><div className="source-node"><FileText size={17} /><span><strong>活动事件</strong><small>设备上传的元数据</small></span></div><div className="source-node"><Code size={17} /><span><strong>受保护工作标识</strong><small>只保留脱敏引用</small></span></div></div></div></SectionCard>}{tab === "导出" && <SectionCard title="导出中心" description="按权限导出 Memory Summary，不包含受保护的原始正文"><div className="export-list"><div><span><DownloadSimple size={19} /><strong>当前可见 Memory Summary</strong><small>{sourceRecords.length} 条记录 · Markdown</small></span><button className="outline-button" onClick={exportVisibleRecords}>导出</button></div><div><span><DownloadSimple size={19} /><strong>团队周汇总</strong><small>{sourceRecords.filter((record) => record.rollupScope === "team_weekly").length} 条记录 · Markdown</small></span><button className="outline-button" onClick={() => onToast("已开始导出团队周汇总")}>导出</button></div></div></SectionCard>}{selected && <MemoryDrawer record={selected} onClose={() => setSelected(null)} onExport={() => exportRecord(selected)} onNavigate={onNavigate} />}</div>;
}

function MemoryRows({ records, onOpen, onExport }) {
  return <div className="memory-table"><div className="memory-row memory-head"><span>记录</span><span>类型</span><span>来源</span><span>状态</span><span /></div>{records.length ? records.map((record) => <div className="memory-row" key={record.id}><button className="memory-title" onClick={() => onOpen(record)}><span className="summary-icon"><Sparkle size={16} weight="fill" /></span><span><strong>{record.title}</strong><small>{record.duration} · {record.description.slice(0, 76)}...</small></span></button><span><span className={`record-type ${record.recordType}`}>{record.recordType === "rollup" ? "Rollup" : "Leaf"}</span></span><span className="source-count"><FileText size={14} />{record.resources.length + record.citations.length} 个来源</span><StatusPill status={record.summaryStatus || "generated"} /><button className="row-action" onClick={() => onExport(record)} title="导出 Markdown"><DownloadSimple size={16} /></button></div>) : <EmptyState title="暂无记录" />}</div>;
}

function MemoryDrawer({ record, onClose, onExport, onNavigate }) {
  const stats = getRecordStats(record);
  const resources = record.resources || [];
  const citations = record.citations || [];
  const timeline = record.timeline || [];
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="memory-drawer"><div className="drawer-header"><span className="page-eyebrow">MEMORY SUMMARY</span><button className="drawer-close" onClick={onClose}>×</button><h2>{record.title}</h2><p>{record.duration} · {record.recordType === "rollup" ? "Rollup Summary" : "Leaf Summary"} · {record.summaryModel || "rules-v1"} · 置信度 {stats.confidence}</p></div><div className="drawer-actions"><button className="outline-button" onClick={onExport}><DownloadSimple size={16} />导出 Markdown</button><button className="primary-button" onClick={() => { onClose(); onNavigate("history"); }}><ArrowSquareOut size={16} />打开时间线</button></div><div className="drawer-content"><DrawerSection title="Memory summary"><p>{record.summary}</p></DrawerSection><DrawerSection title="Relevant prior context"><p>{record.priorContext || "暂无前置上下文。"}</p></DrawerSection><DrawerSection title="Important non-obvious context"><div className="uncertain-box"><WarningCircle size={16} /><p>{record.importantContext || record.nonObvious || "暂无额外说明。"}</p></div></DrawerSection><DrawerSection title="Recording summary"><div className="drawer-timeline">{timeline.length ? timeline.map((item) => <div className="drawer-timeline-row" key={`${item.time}-${item.text}`}><span>{item.time}</span><span>{item.text}</span></div>) : <span className="empty-inline">暂无活动片段。</span>}</div></DrawerSection><DrawerSection title={`Resources · ${resources.length}`}><div className="citation-mini-list">{resources.length ? resources.map((resource) => <div key={resource.name}><FileText size={15} /><span><strong>{resource.name}</strong><small>{resource.path}</small></span></div>) : <span className="empty-inline">当前记录没有额外资源，仅保留活动元数据。</span>}</div></DrawerSection><DrawerSection title={`Citations · ${citations.length}`}><div className="citation-mini-list">{citations.length ? citations.map((citation) => <div key={`${citation.label}-${citation.detail}`}><FileText size={15} /><span><strong>{citation.label}</strong><small>{citation.detail}</small></span></div>) : <span className="empty-inline">当前记录没有可展示的来源引用。</span>}</div></DrawerSection><DrawerSection title="上下层关系"><div className="relation-line"><span className="relation-node">{record.recordType === "rollup" ? "Rollup" : "Leaf"}</span><span className="relation-arrow">→</span><span className="relation-node">{record.recordType === "rollup" ? `${timeline.length} 个下层窗口` : "原始活动事件"}</span></div></DrawerSection></div></aside></div>;
}

function DrawerSection({ title, children }) { return <section className="drawer-section"><h3>{title}</h3>{children}</section>; }

function SkillPage({ role, records, onNavigate }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(["我今天主要做了什么？", "研发团队本周有哪些工作主题？"]);
  const runQuestion = async (nextQuestion) => {
    const value = nextQuestion.trim();
    if (!value) return;
    setQuestion(value);
    setLoading(true);
    setError("");
    try {
      if (agentApiEnabled) setResult(await askLiveHistory(value));
      else if (demoMode) setResult(askHistory(value, records));
      else throw new Error("Agent API is not configured; connect the real server or explicitly enable demo mode");
    } catch (requestError) {
      setResult(null);
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };
  const submit = (event) => { event.preventDefault(); void runQuestion(question); };
  return <div className="page-content"><PageHeader eyebrow="HISTORY SKILL" title="询问计算机历史" description="用自然语言查询你有权限访问的工作活动和上下文。" meta={`${roleLabel[role]} · 只读`} action={<span className="scope-pill"><LockKey size={14} />权限范围已过滤</span>} />{error && <div className="error-box">History Skill 查询失败：{error}</div>}<div className="skill-page-grid"><SectionCard title="新建提问" description="问题会先经过权限范围过滤，再检索 Memory Summary 和证据"><form className="large-skill-form" onSubmit={submit}><ChatCircleDots size={22} /><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：过去三天哪些活动记录存在明显上下文中断？" /><button className="primary-button" type="submit" disabled={loading}><PaperPlaneTilt size={17} />{loading ? "生成中…" : "获取答案"}</button></form><div className="question-grid"><button onClick={() => setQuestion("我今天主要做了什么？")}>我今天主要做了什么？</button><button onClick={() => setQuestion("为什么我今天频繁切换应用？")}>为什么我今天频繁切换应用？</button><button onClick={() => setQuestion("研发团队本周有哪些连续工作主题？")}>研发团队本周有哪些连续工作主题？</button></div></SectionCard><SectionCard title="问题历史" description="最近询问过的问题"><div className="saved-question-list">{saved.map((item) => <button key={item} onClick={() => setQuestion(item)}><Clock size={16} /><span>{item}</span><ArrowSquareOut size={14} /></button>)}</div><button className="text-button add-question" onClick={() => setSaved((items) => [...items, "过去一周有哪些需要人工确认的上下文？"])}><Plus size={15} />添加示例问题</button></SectionCard></div>{result && <SectionCard title="回答结果" description="每个结论都应该能够回溯到 Memory Summary 或原始活动证据"><SkillAnswer result={result} onOpen={() => onNavigate("history")} /></SectionCard>}</div>;
}

function SkillAnswer({ result, onOpen }) {
  const timeRange = result.timeRange?.start && result.timeRange?.end
    ? `${new Date(result.timeRange.start).toLocaleString("zh-CN")} – ${new Date(result.timeRange.end).toLocaleString("zh-CN")}`
    : "暂无可用时间范围";
  const applications = result.applications || [];
  const contextLabels = result.contextLabels || [];
  const webDomains = result.webDomains || [];
  return <div className="skill-answer"><p>{result.answer}</p><div className="skill-answer-meta"><span><CheckCircle size={15} weight="fill" />已关联 {result.evidence?.length || 0} 条证据</span><span><Fingerprint size={15} />权限范围内</span><span><Clock size={15} />{timeRange}</span>{applications.length ? <span><Monitor size={15} />应用：{applications.join("、")}</span> : null}{contextLabels.length ? <span><Tag size={15} />工作标识：{contextLabels.join("、")}</span> : null}{webDomains.length ? <span><Browser size={15} />网站：{webDomains.join("、")}</span> : null}{result.citations?.length ? <span><FileText size={15} />来源引用：{result.citations.slice(0, 3).map((citation) => citation.label).join("、")}</span> : null}</div><div className="evidence-list"><span className="evidence-label">证据记录</span>{(result.evidence || []).map((record) => <button key={record.id} onClick={onOpen}><Sparkle size={16} weight="fill" /><span><strong>{record.title}</strong><small>{record.duration} · 置信度 {Math.round(record.confidence * 100)}%</small></span><ArrowSquareOut size={15} /></button>)}</div><div className="caveat-box"><WarningCircle size={16} /><span>{result.caveats?.[0] || "答案只基于活动元数据和 Memory Summary。"}</span></div>{result.uncertainty && <div className="caveat-box"><Info size={16} /><span>不确定性：{result.uncertainty}</span></div>}</div>;
}

function DevicesPage({ role, query, target, onToast }) {
  const [tab, setTab] = useState("设备列表");
  const [selected, setSelected] = useState(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [registrationEmployees, setRegistrationEmployees] = useState([]);
  const [registrationEmployeeId, setRegistrationEmployeeId] = useState("");
  const [registrationExpires, setRegistrationExpires] = useState(3600);
  const [registrationCode, setRegistrationCode] = useState(null);
  const [registrationLoading, setRegistrationLoading] = useState(false);
  const [registrationError, setRegistrationError] = useState("");
  const [liveDevices, setLiveDevices] = useState(null);
  const [liveEvents, setLiveEvents] = useState(null);
  const [liveError, setLiveError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    getLiveDevices().then((devices) => {
      if (!cancelled) setLiveDevices(devices);
    }).catch((error) => {
      if (!cancelled) setLiveError(error.message);
    });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    getLiveEvents(100).then((events) => {
      if (!cancelled) setLiveEvents(events);
    }).catch((error) => {
      if (!cancelled) setLiveError(error.message);
    });
    return () => { cancelled = true; };
  }, []);
  const sourceDevices = liveDevices ?? (demoMode ? deviceData : []);
  const scopedDevices = role === "employee" ? sourceDevices.filter((device) => device.user === "Wei") : sourceDevices;
  const devices = scopedDevices.filter((device) => !query.trim() || `${device.name} ${device.user} ${device.status} ${device.error}`.toLowerCase().includes(query.toLowerCase()));
  const onlineCount = scopedDevices.filter((device) => device.status === "online").length;
  const queuedCount = scopedDevices.reduce((sum, device) => sum + Number(device.cache || 0), 0);
  const versionCounts = [...new Set(scopedDevices.map((device) => device.agent).filter(Boolean))]
    .map((version) => ({ version, count: scopedDevices.filter((device) => device.agent === version).length }))
    .sort((left, right) => right.count - left.count || right.version.localeCompare(left.version));
  const versionTotal = Math.max(1, scopedDevices.length);
  const versionRows = liveDevices === null && demoMode
    ? <><VersionRow version="0.8.2" count="23 台" width="88%" status="推荐" /><VersionRow version="0.8.1" count="2 台" width="8%" status="可升级" /><VersionRow version="0.7.9" count="1 台" width="4%" status="过旧" /></>
    : versionCounts.length
      ? versionCounts.map((item, index) => <VersionRow key={item.version} version={item.version} count={`${item.count} 台`} width={`${Math.round((item.count / versionTotal) * 100)}%`} status={index === 0 ? "推荐" : "可升级"} />)
      : <EmptyState title="暂无 Agent 版本数据" />;
  const diagnosticRows = liveEvents === null && demoMode
    ? <><DiagnosticRow icon={<CheckCircle size={18} weight="fill" />} title="活动事件批次上传成功" detail="WIN-WEI-01 · 2 分钟前 · 24 条事件" /><DiagnosticRow icon={<WarningCircle size={18} weight="fill" />} title="浏览器扩展版本不一致" detail="WIN-MING-03 · 7 分钟前 · 页面标题可能缺失" /><DiagnosticRow icon={<WarningCircle size={18} weight="fill" />} title="设备离线超过 2 小时" detail="WIN-JIA-05 · 2 小时前 · 本地缓存 44 条" /></>
    : liveEvents?.length
      ? liveEvents.slice(0, 6).map((event) => <DiagnosticRow key={event.id} icon={event.type === "idle" ? <WarningCircle size={18} weight="fill" /> : <CheckCircle size={18} weight="fill" />} title={event.type === "idle" ? "系统空闲事件" : `活动事件：${event.app_name}`} detail={`${event.hostname || "设备"} · ${event.time || "刚刚"} · ${event.duration}`} />)
      : <EmptyState title="暂无真实采集事件" />;
  useEffect(() => {
    const nextDevice = scopedDevices.find((device) => device.id === target);
    if (nextDevice) setSelected(nextDevice);
  }, [target, role]);
  const openRegistration = async () => {
    if (!agentApiEnabled) {
      onToast("连接服务端后才能生成注册码");
      return;
    }
    if (role !== "admin") {
      onToast("只有企业管理员可以生成一次性注册码");
      return;
    }
    setRegistrationOpen(true);
    setRegistrationCode(null);
    setRegistrationError("");
    try {
      const employees = await getLiveEmployees();
      setRegistrationEmployees(employees);
      setRegistrationEmployeeId((current) => current || employees[0]?.id || "");
    } catch (error) {
      setRegistrationError(error.message);
    }
  };

  const generateRegistrationCode = async () => {
    if (!registrationEmployeeId) return;
    setRegistrationLoading(true);
    setRegistrationError("");
    try {
      const result = await createRegistrationCode({ employeeId: registrationEmployeeId, expiresInSeconds: registrationExpires });
      setRegistrationCode(result);
    } catch (error) {
      setRegistrationError(error.message);
    } finally {
      setRegistrationLoading(false);
    }
  };

  const copyRegistrationCode = async () => {
    if (!registrationCode?.code) return;
    try {
      await navigator.clipboard.writeText(registrationCode.code);
      onToast("注册码已复制，请发送给对应员工");
    } catch {
      onToast("浏览器阻止了复制，请手动复制注册码");
    }
  };

  return <div className="page-content"><PageHeader eyebrow="DEVICE FLEET" title="设备" description={agentApiEnabled ? "已连接 Agent 局域网服务，显示真实设备心跳和缓存状态。" : "管理 Windows Agent、设备在线状态和采集诊断。"} meta={`${devices.length} 台设备`} action={<button className="outline-button" onClick={() => void openRegistration()}><Plus size={17} />注册设备</button>} />{liveError && <div className="error-box">Agent 服务暂时不可用：{liveError}</div>}<Tabs tabs={["设备列表", "Agent 状态", "采集策略", "事件诊断"]} active={tab} onChange={setTab} />{tab === "设备列表" && <SectionCard title="Windows 设备" description="点击设备查看会话、心跳、缓存和采集错误"><div className="data-table device-table"><div className="table-row table-head"><span>设备</span><span>使用者</span><span>系统 / Agent</span><span>会话</span><span>心跳</span><span>状态</span></div>{devices.map((device) => <button className="table-row" key={device.id} onClick={() => setSelected(device)}><span className="table-person"><span className="device-icon"><Monitor size={17} /></span><strong>{device.name}</strong></span><span>{device.user}</span><span><strong>{device.os}</strong><small>Agent {device.agent}</small></span><span>{device.session}</span><span>{device.heartbeat}</span><StatusPill status={device.status} /></button>)}</div></SectionCard>}{tab === "Agent 状态" && <><KpiGrid items={[{ label: "Agent 在线率", value: `${scopedDevices.length ? Math.round((onlineCount / scopedDevices.length) * 100) : 0}%`, detail: `${onlineCount} / ${scopedDevices.length} 台`, icon: <Pulse size={20} />, good: true }, { label: "当前版本", value: versionCounts[0]?.version || "—", detail: `${versionCounts[0]?.count || 0} 台设备`, icon: <Wrench size={20} />, tone: "blue" }, { label: "待上传缓存", value: `${queuedCount} 条`, detail: "设备离线时保存在本地", icon: <DownloadSimple size={20} />, tone: "gold" }, { label: "异常设备", value: `${scopedDevices.filter((device) => device.status === "offline" || device.cache > 0).length} 台`, detail: "按心跳和缓存状态", icon: <WarningCircle size={20} />, tone: "green" }]} /><SectionCard title="Agent 版本分布"><div className="version-list">{versionRows}</div></SectionCard></>}{tab === "采集策略" && <PolicyPreview onToast={onToast} />}{tab === "事件诊断" && <SectionCard title="最近采集事件" description="只显示 Agent 诊断元数据"><div className="diagnostic-list">{diagnosticRows}</div></SectionCard>}{selected && <DeviceDrawer device={selected} onClose={() => setSelected(null)} onToast={onToast} />}{registrationOpen && <RegistrationCodeModal employees={registrationEmployees} employeeId={registrationEmployeeId} expiresInSeconds={registrationExpires} code={registrationCode} loading={registrationLoading} error={registrationError} onEmployeeChange={setRegistrationEmployeeId} onExpiresChange={setRegistrationExpires} onGenerate={() => void generateRegistrationCode()} onCopy={() => void copyRegistrationCode()} onClose={() => setRegistrationOpen(false)} />}</div>;
}

function RegistrationCodeModal({ employees, employeeId, expiresInSeconds, code, loading, error, onEmployeeChange, onExpiresChange, onGenerate, onCopy, onClose }) {
  const employee = employees.find((item) => item.id === employeeId);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="detail-panel registration-panel" role="dialog" aria-modal="true" aria-label="生成一次性注册码"><div className="detail-topbar"><div><span className="detail-kicker"><Fingerprint size={14} />DEVICE ENROLLMENT</span><h2>生成一次性注册码</h2><p>绑定 Windows Agent 到指定员工</p></div><button className="detail-close" onClick={onClose}><X size={21} /></button></div><div className="detail-scroll"><div className="detail-description">员工安装通用 MSI 后，需要使用这里生成的注册码完成设备绑定。注册码只显示一次，不写入安装包。</div><div className="registration-form"><label>绑定员工<select value={employeeId} onChange={(event) => onEmployeeChange(event.target.value)} disabled={loading || Boolean(code)}><option value="">请选择员工</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.team}</option>)}</select></label><label>有效期<select value={expiresInSeconds} onChange={(event) => onExpiresChange(Number(event.target.value))} disabled={loading || Boolean(code)}><option value={3600}>1 小时</option><option value={8 * 3600}>8 小时</option><option value={24 * 3600}>24 小时</option><option value={7 * 24 * 3600}>7 天</option></select></label></div>{error && <div className="error-box">注册码生成失败：{error}</div>}{code && <div className="registration-code-box"><span>发送给 {employee?.name || "员工"}</span><strong>{code.code}</strong><small>有效至 {new Date(code.expires_at).toLocaleString("zh-CN")}</small><button className="primary-button" onClick={onCopy}><DownloadSimple size={16} />复制注册码</button></div>} {!code && !error && !employees.length && <div className="empty-state"><UsersThree size={24} /><strong>暂无可绑定员工</strong><span>请先在员工目录中创建员工。</span></div>}<div className="registration-actions">{!code && <button className="primary-button" disabled={loading || !employeeId} onClick={onGenerate}>{loading ? "生成中…" : "生成注册码"}</button>}<button className="outline-button" onClick={onClose}>关闭</button></div><div className="detail-note"><ShieldCheck size={17} /><span>注册码只用于首次绑定；后续事件使用设备 Token。管理员 Token 和 API Key 不会发送到 Agent。</span></div></div></aside></div>;
}

function VersionRow({ version, count, width, status }) { return <div className="version-row"><span><strong>{version}</strong><small>{count}</small></span><span className="version-track"><i style={{ width }} /></span><StatusPill status={status === "推荐" ? "online" : status === "过旧" ? "offline" : "pending"} /></div>; }
function PolicyPreview({ onToast }) {
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let active = true;
    getLivePolicy().then((nextPolicy) => {
      if (active) setPolicy(nextPolicy);
    }).catch((requestError) => {
      if (active) setError(requestError.message);
    });
    return () => { active = false; };
  }, []);
  const hours = policy ? `${policy.work_hours_start}–${policy.work_hours_end}` : "读取中…";
  const idle = policy ? `${Math.round(Number(policy.idle_threshold_seconds || 300) / 60)} 分钟` : "读取中…";
  return <SectionCard title="采集策略" description="当前记录前台应用、空闲状态、心跳和扩展上报的安全工作元数据"><div className="policy-grid"><PolicyItem icon={<Browser size={19} />} title="应用活动" detail={`记录前台应用名称和使用时长 · ${hours}`} enabled /><PolicyItem icon={<Clock size={19} />} title="系统空闲" detail={`超过 ${idle} 进入空闲状态`} enabled /><PolicyItem icon={<Globe size={19} />} title="网站域名与安全提示" detail="Chrome/Edge 扩展仅保留域名和允许的来源提示" enabled /><PolicyItem icon={<DeviceMobile size={19} />} title="截图、键盘和正文" detail="明确禁止采集" enabled={false} /></div>{error && <div className="error-box">读取采集策略失败：{error}</div>}<button className="outline-button" onClick={() => onToast("请在权限 → 采集策略中编辑并保存策略")}><SlidersHorizontal size={16} />编辑采集策略</button></SectionCard>;
}
function PolicyItem({ icon, title, detail, enabled }) { return <div className={`policy-item ${enabled ? "enabled" : "disabled"}`}><span className="policy-icon">{icon}</span><span><strong>{title}</strong><small>{detail}</small></span><span className="toggle"><i /></span></div>; }
function DiagnosticRow({ icon, title, detail }) { return <div className="diagnostic-row">{icon}<span><strong>{title}</strong><small>{detail}</small></span><ArrowSquareOut size={15} /></div>; }
function DeviceRow({ device, onToast }) { return <div className="device-detail-row"><span className="device-icon large"><Monitor size={21} /></span><span><strong>{device.name}</strong><small>{device.os} · Agent {device.agent}</small></span><StatusPill status={device.status} /><button className="outline-button" onClick={() => onToast("已打开设备诊断")}><Wrench size={16} />诊断</button></div>; }
function DeviceDrawer({ device, onClose, onToast }) { return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="memory-drawer device-drawer"><div className="drawer-header"><span className="page-eyebrow">DEVICE DETAIL</span><button className="drawer-close" onClick={onClose}>×</button><h2>{device.name}</h2><p>{device.user} · {device.os} · Agent {device.agent}</p></div><div className="drawer-content"><div className="device-status-banner"><StatusPill status={device.status} /><span>最近心跳 {device.heartbeat}</span></div><DrawerSection title="工作会话"><div className="detail-definition"><span>当前状态</span><strong>{device.session}</strong><span>离线缓存</span><strong>{device.cache} 条</strong><span>最近错误</span><strong>{device.error}</strong></div></DrawerSection><DrawerSection title="设备操作"><div className="drawer-button-list"><button onClick={() => onToast("已发送重新注册指令")}><Fingerprint size={17} />重新注册 Agent</button><button onClick={() => onToast("已打开采集策略")}><SlidersHorizontal size={17} />查看采集策略</button><button onClick={() => onToast("设备已进入停用确认流程")}><LockKey size={17} />停用设备</button></div></DrawerSection></div></aside></div>; }

function PermissionsPage({ role, onToast }) {
  const [tab, setTab] = useState("角色");
  return <div className="page-content"><PageHeader eyebrow="ACCESS CONTROL" title="权限" description="管理角色、组织关系、数据范围和采集策略。" meta="RBAC 已启用" action={<button className="outline-button" onClick={() => onToast("新增角色需要连接权限服务")}><Plus size={17} />新增角色</button>} /><Tabs tabs={["角色", "组织关系", "数据范围", "采集策略", "应用/网站排除", "保留策略"]} active={tab} onChange={setTab} />{tab === "角色" && <SectionCard title="角色权限" description="权限变更会记录操作者和生效时间"><div className="role-list">{permissionRoles.map((item) => <div className="role-row" key={item.role}><span className="role-icon"><Key size={18} /></span><span><strong>{item.role}</strong><small>{item.scope} · {item.users} 人 · {item.description}</small></span><button className="outline-button" onClick={() => onToast(`已打开 ${item.role} 权限详情`)}>查看</button></div>)}</div></SectionCard>}{tab === "组织关系" && <OrgTree onToast={onToast} />}{tab === "数据范围" && <ScopePolicy onToast={onToast} />}{tab === "采集策略" && <PolicyEditor onToast={onToast} />}{tab === "应用/网站排除" && <ExclusionPolicy onToast={onToast} />}{tab === "保留策略" && <RetentionPolicy onToast={onToast} />}</div>;
}
function OrgTree({ onToast }) { return <SectionCard title="组织关系" description="直属管理关系决定团队和个人历史的默认可见范围"><div className="org-tree"><div className="org-node root"><Buildings size={18} /><span><strong>锦衣卫科技</strong><small>管理员 Wei</small></span></div><div className="org-branch"><div className="org-node"><UsersThree size={18} /><span><strong>研发与产品中心</strong><small>负责人 Wei · 12 人</small></span><button className="text-button" onClick={() => onToast("已打开团队权限")}>管理</button></div><div className="org-node"><UsersThree size={18} /><span><strong>客户与销售团队</strong><small>负责人 Lin · 8 人</small></span><button className="text-button" onClick={() => onToast("已打开团队权限")}>管理</button></div><div className="org-node"><UsersThree size={18} /><span><strong>运营与支持团队</strong><small>负责人 Ming · 6 人</small></span><button className="text-button" onClick={() => onToast("已打开团队权限")}>管理</button></div></div></div></SectionCard>; }
function ScopePolicy({ onToast }) { return <SectionCard title="数据范围" description="选择不同角色可以查看的组织范围"><div className="scope-list"><ScopeRow role="企业管理员" value="整个企业" detail="历史、Memory Summary、设备、权限和审计" /><ScopeRow role="直属管理者" value="直属团队" detail="团队趋势、成员历史和团队 Skill" /><ScopeRow role="员工" value="本人" detail="自己的历史、Memory Summary、设备和隐私说明" /><ScopeRow role="审计员" value="授权记录" detail="访问、导出、策略和 Agent 事件" /></div><button className="outline-button" onClick={() => onToast("数据范围规则已保存")}><CheckCircle size={16} />保存范围规则</button></SectionCard>; }
function ScopeRow({ role, value, detail }) { return <div className="scope-row"><span><strong>{role}</strong><small>{detail}</small></span><b>{value}</b><CaretDown size={15} /></div>; }
function PolicyEditor({ onToast }) {
  const [policy, setPolicy] = useState({ work_hours_start: "09:00", work_hours_end: "18:00" });
  const [allDay, setAllDay] = useState(false);
  const [loading, setLoading] = useState(agentApiEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    getLivePolicy()
      .then((nextPolicy) => {
        setPolicy(nextPolicy);
        setAllDay(nextPolicy.work_hours_start === "00:00" && nextPolicy.work_hours_end === "24:00");
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
    return undefined;
  }, []);

  const save = async () => {
    const nextPolicy = allDay ? { ...policy, work_hours_start: "00:00", work_hours_end: "24:00" } : policy;
    setSaving(true);
    setError("");
    try {
      const saved = agentApiEnabled ? await updateLivePolicy(nextPolicy) : nextPolicy;
      setPolicy(saved);
      setAllDay(saved.work_hours_start === "00:00" && saved.work_hours_end === "24:00");
      onToast(allDay ? "已开启 24 小时测试采集" : `工作时间已保存：${saved.work_hours_start}–${saved.work_hours_end}`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  return <SectionCard title="采集策略" description="统一控制应用、网页和文件元数据的采集范围"><div className="policy-grid"><PolicyItem icon={<Browser size={19} />} title="应用与窗口" detail="所有公司管理设备" enabled /><PolicyItem icon={<Globe size={19} />} title="浏览器域名和标题" detail="去除查询参数和 Token" enabled /><PolicyItem icon={<FileText size={19} />} title="文件元数据" detail="仅文件名、扩展名和脱敏路径" enabled /><PolicyItem icon={<DeviceMobile size={19} />} title="截图、键盘和剪贴板" detail="系统级禁止" enabled={false} /></div><div className="policy-time-settings"><div><strong>应用活动采集时间</strong><small>{allDay ? "全天运行，适合当前联调测试" : "只在工作时间内记录应用活动"}</small></div><label className="policy-checkbox"><input type="checkbox" checked={allDay} onChange={(event) => setAllDay(event.target.checked)} /><span>24 小时测试模式</span></label>{!allDay && <div className="policy-time-inputs"><label>开始<input type="time" value={policy.work_hours_start} onChange={(event) => setPolicy((current) => ({ ...current, work_hours_start: event.target.value }))} /></label><span>至</span><label>结束<input type="time" value={policy.work_hours_end} onChange={(event) => setPolicy((current) => ({ ...current, work_hours_end: event.target.value }))} /></label></div>}</div>{error && <div className="error-box">策略保存失败：{error}</div>}<div className="policy-save-row"><small>{loading ? "正在读取服务端策略…" : agentApiEnabled ? `策略版本 v${policy.version || 1}` : "当前为演示模式，未连接服务端"}</small><button className="primary-button" disabled={loading || saving} onClick={save}>{saving ? "保存中…" : "保存采集策略"}</button></div></SectionCard>;
}
function ExclusionPolicy({ onToast }) {
  const [policy, setPolicy] = useState({ excluded_processes: [], excluded_domains: [] });
  const [loading, setLoading] = useState(agentApiEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    getLivePolicy()
      .then((nextPolicy) => setPolicy({
        ...nextPolicy,
        excluded_processes: nextPolicy.excluded_processes || [],
        excluded_domains: nextPolicy.excluded_domains || [],
      }))
      .catch((requestError) => setError(requestError.message))
      .finally(() => setLoading(false));
    return undefined;
  }, []);

  const updateList = (key, value) => {
    setPolicy((current) => ({
      ...current,
      [key]: value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
    }));
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const saved = agentApiEnabled ? await updateLivePolicy(policy) : policy;
      setPolicy({
        ...saved,
        excluded_processes: saved.excluded_processes || [],
        excluded_domains: saved.excluded_domains || [],
      });
      onToast("排除策略已保存，后续采集将跳过这些来源");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  return <SectionCard title="应用与网站排除" description="被排除的来源不会进入活动事件或 Memory Summary"><div className="exclusion-editor"><label>排除的进程（逗号分隔）<input value={policy.excluded_processes.join(", ")} placeholder="passwordmanager.exe, private.exe" onChange={(event) => updateList("excluded_processes", event.target.value)} /></label><label>排除的网站域名（逗号分隔）<input value={policy.excluded_domains.join(", ")} placeholder="bank.example.com, personal.example" onChange={(event) => updateList("excluded_domains", event.target.value)} /></label></div><small className="policy-hint">支持子域名匹配；只对保存后的新事件生效，不删除历史数据。</small>{error && <div className="error-box">排除策略保存失败：{error}</div>}<div className="policy-save-row"><small>{loading ? "正在读取服务端策略…" : agentApiEnabled ? `策略版本 v${policy.version || 1}` : "当前为演示模式，未连接服务端"}</small><button className="primary-button" disabled={loading || saving} onClick={save}>{saving ? "保存中…" : "保存排除策略"}</button></div></SectionCard>;
}
function ExclusionRow({ name, type, enabled }) { return <div className="exclusion-row"><span className={`exclusion-switch ${enabled ? "on" : ""}`}><i /></span><span><strong>{name}</strong><small>{type}</small></span><button className="row-action"><ArrowSquareOut size={15} /></button></div>; }
function RetentionPolicy({ onToast }) {
  const defaultCutoff = new Date(Date.now() - 90 * 24 * 3600_000).toISOString().slice(0, 10);
  const [cutoff, setCutoff] = useState(defaultCutoff);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const runPreview = async (apply = false) => {
    if (!agentApiEnabled) {
      onToast("连接服务端后才能执行真实留存预览");
      return;
    }
    if (apply && !window.confirm("确认删除截止日期之前的活动事件和 Memory Summary？此操作不可恢复。")) return;
    setLoading(true);
    setError("");
    try {
      const result = await runRetention(new Date(`${cutoff}T00:00:00`).toISOString(), apply);
      setPreview(result);
      onToast(apply ? "留存删除已执行并写入审计" : "已生成留存删除预览");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };
  return <SectionCard title="数据保留策略" description="先预览，再由管理员确认删除；删除范围和结果会写入审计日志"><div className="retention-grid"><div><span>原始活动事件</span><strong>90 天</strong><small>到期自动删除</small></div><div><span>Leaf Summary</span><strong>1 年</strong><small>保留来源引用</small></div><div><span>Rollup Summary</span><strong>1 年</strong><small>可导出 Markdown</small></div></div><div className="policy-time-settings"><label>删除截止日期<input type="date" value={cutoff} onChange={(event) => setCutoff(event.target.value)} /></label><div className="policy-save-row"><button className="outline-button" disabled={loading || !cutoff} onClick={() => runPreview(false)}><Archive size={16} />预览删除范围</button><button className="primary-button" disabled={loading || !cutoff || !preview} onClick={() => runPreview(true)}>{loading ? "处理中…" : "确认执行删除"}</button></div></div>{error && <div className="error-box">留存操作失败：{error}</div>}{preview && <div className="deep-link-card"><Archive size={22} /><span><strong>{preview.applied ? "已执行删除" : "删除预览"}</strong><small>截止 {new Date(preview.before).toLocaleString("zh-CN")} · 活动事件 {preview.applied ? preview.deleted.events : preview.preview.events} 条 · Memory Summary {preview.applied ? preview.deleted.memory_summaries : preview.preview.memory_summaries} 条</small></span></div>}</SectionCard>;
}

function AuditPage({ role, query, onToast }) {
  const [tab, setTab] = useState("访问日志");
  const [liveLogs, setLiveLogs] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    getLiveAudit().then((logs) => {
      if (!cancelled) setLiveLogs(logs);
    }).catch((requestError) => {
      if (!cancelled) setError(requestError.message);
    });
    return () => { cancelled = true; };
  }, []);
  const sourceLogs = liveLogs ?? (demoMode ? auditData : []);
  const logs = sourceLogs.filter((item) => !query.trim() || `${item.actor} ${item.action} ${item.target} ${item.result} ${item.detail || ""}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="page-content"><PageHeader eyebrow="AUDIT TRAIL" title="审计" description="记录历史访问、导出、权限策略和 Agent 上下线事件。" meta={agentApiEnabled ? `${logs.length} 条真实事件` : demoMode ? `${logs.length} 条演示事件` : "未连接服务端"} action={<button className="outline-button" onClick={() => onToast(agentApiEnabled ? "真实审计数据已加载" : "连接服务端后才能导出真实审计日志")}><DownloadSimple size={17} />导出日志</button>} />{error && <div className="error-box">审计日志读取失败：{error}</div>}<Tabs tabs={["访问日志", "权限变更", "导出记录", "归档与删除", "Agent 事件"]} active={tab} onChange={setTab} /><SectionCard title={tab} description={role === "auditor" ? "当前为只读审计范围" : "所有操作均带有操作者、对象、时间和结果"}><div className="audit-table"><div className="audit-row audit-head"><span>时间</span><span>操作者</span><span>动作</span><span>对象</span><span>结果</span><span /></div>{logs.length ? logs.map((item) => <div className="audit-row" key={item.id || `${item.time}-${item.actor}-${item.target}`}><span>{item.time}</span><span className="audit-actor">{item.actor}</span><span>{item.action}</span><span title={item.detail}>{item.target}</span><StatusPill status={item.result === "成功" || item.result === "允许" || item.result === "完成" || item.result === "已生效" ? "online" : item.result === "需关注" ? "attention" : "idle"} /><button className="row-action" onClick={() => onToast(item.detail || `${item.action} 详情`)}><ArrowSquareOut size={15} /></button></div>) : <div className="empty-state"><Database size={24} /><strong>暂无真实审计事件</strong><span>服务端产生注册、策略、Agent 上下线和留存操作后会显示在这里。</span></div>}</div></SectionCard></div>;
}

function SettingsPage({ role, onToast }) {
  const [tab, setTab] = useState("企业资料");
  return <div className="page-content"><PageHeader eyebrow="ORGANIZATION SETTINGS" title="设置" description="管理企业资料、工作会话、活动分类、AI、通知和数据集成。" meta={roleLabel[role]} action={<button className="primary-button" onClick={() => onToast("设置已保存")}>保存设置</button>} /><Tabs tabs={["企业资料", "工作会话", "活动分类", "AI 设置", "通知", "数据与集成", "安全合规"]} active={tab} onChange={setTab} />{tab === "企业资料" && <SettingsForm onToast={onToast} />}{tab === "工作会话" && <PolicyEditor onToast={onToast} />}{tab === "活动分类" && <CategorySettings onToast={onToast} />}{tab === "AI 设置" && <SectionCard title="AI 模型适配层" description="摘要和问答必须保留 Citations，并对事件文本进行不可信数据隔离"><div className="settings-grid"><SettingField label="摘要语言" value="简体中文 / English" /><SettingField label="默认模型" value="qwen3.7-plus（服务端）" /><SettingField label="调用预算" value="30 次 / 分钟" /><SettingField label="原始内容读取" value="禁止" /></div></SectionCard>}{tab === "通知" && <NotificationSettings onToast={onToast} />}{tab === "数据与集成" && <IntegrationSettings onToast={onToast} />}{tab === "安全合规" && <ComplianceSettings onToast={onToast} />}</div>;
}
function SettingsForm({ onToast }) { return <SectionCard title="企业资料" description="这些信息会出现在组织导航和 Memory Summary 权限范围中"><div className="settings-grid"><SettingField label="企业名称" value="锦衣卫科技" /><SettingField label="默认语言" value={settingsData.language} /><SettingField label="默认时区" value={settingsData.timezone} /><SettingField label="数据保留" value={settingsData.retention} /></div><button className="outline-button" onClick={() => onToast("企业资料已保存")}><CheckCircle size={16} />保存资料</button></SectionCard>; }
function SettingField({ label, value }) { return <label className="setting-field"><span>{label}</span><input defaultValue={value} /></label>; }
function CategorySettings({ onToast }) { return <SectionCard title="活动分类" description="分类用于摘要和趋势解释，不自动代表绩效结论"><div className="category-list"><CategoryRow color="purple" label="工作与项目" detail="开发、文档、项目管理" /><CategoryRow color="blue" label="沟通与会议" detail="企业微信、会议和邮件" /><CategoryRow color="green" label="系统与工具" detail="登录、设置、故障和同步" /><CategoryRow color="amber" label="疑似非工作" detail="购物、娱乐、求职和游戏，需人工确认" /><CategoryRow color="gray" label="未知" detail="无法可靠分类的活动" /></div><button className="outline-button" onClick={() => onToast("分类规则已保存")}><CheckCircle size={16} />保存分类</button></SectionCard>; }
function CategoryRow({ color, label, detail }) { return <div className="category-row"><span className={`category-dot ${color}`} /><span><strong>{label}</strong><small>{detail}</small></span><button className="row-action"><ArrowSquareOut size={15} /></button></div>; }
function NotificationSettings({ onToast }) { return <SectionCard title="通知设置" description="只针对数据质量和协作问题发送通知"><div className="notification-list"><NotificationRow label="Agent 离线超过 30 分钟" enabled /><NotificationRow label="Memory Summary 生成失败" enabled /><NotificationRow label="团队数据覆盖率低于 90%" enabled /><NotificationRow label="疑似非工作活动" enabled={false} /></div><button className="outline-button" onClick={() => onToast("通知设置已保存")}><CheckCircle size={16} />保存通知设置</button></SectionCard>; }
function NotificationRow({ label, enabled }) { return <div className="notification-row"><span><strong>{label}</strong><small>{enabled ? "当前开启" : "当前关闭"}</small></span><span className={`toggle ${enabled ? "on" : ""}`}><i /></span></div>; }
function IntegrationSettings({ onToast }) { return <SectionCard title="数据与集成" description="第三方数据源默认关闭，启用前需要管理员授权"><div className="integration-grid"><IntegrationCard icon={<Browser size={21} />} title="浏览器扩展" detail="Chrome / Edge 页面域名和标题" status="已连接" onClick={() => onToast("浏览器扩展设置已打开")} /><IntegrationCard icon={<Code size={21} />} title="项目管理工具" detail="Jira、Linear、Trello" status="未连接" onClick={() => onToast("项目管理工具连接配置已打开")} /><IntegrationCard icon={<ChatCircleDots size={21} />} title="协作工具" detail="企业微信、飞书、Slack" status="部分连接" onClick={() => onToast("协作工具连接配置已打开")} /><IntegrationCard icon={<Database size={21} />} title="History API" detail="供企业内部系统查询记录" status="准备中" onClick={() => onToast("History API 配置已打开")} /></div></SectionCard>; }
function IntegrationCard({ icon, title, detail, status, onClick }) { return <button className="integration-card" onClick={onClick}><span className="integration-icon">{icon}</span><span><strong>{title}</strong><small>{detail}</small></span><StatusPill status={status === "已连接" ? "online" : status === "部分连接" ? "meeting" : "pending"} /></button>; }
function ComplianceSettings({ onToast }) { return <SectionCard title="安全与合规" description="员工告知、敏感资源排除和数据访问说明"><div className="compliance-list"><ComplianceRow icon={<ShieldCheck size={19} />} title="员工采集告知" detail="已发布 · 最近更新 2026-08-20" /><ComplianceRow icon={<LockKey size={19} />} title="敏感资源排除" detail="3 条规则生效 · 文件正文不采集" /><ComplianceRow icon={<Fingerprint size={19} />} title="访问审计" detail="所有个人时间线访问均留痕" /><ComplianceRow icon={<Archive size={19} />} title="数据删除策略" detail="原始 90 天 · 汇总 1 年" /></div><button className="outline-button" onClick={() => onToast("合规说明已打开")}><ArrowSquareOut size={16} />查看完整说明</button></SectionCard>; }
function ComplianceRow({ icon, title, detail }) { return <div className="compliance-row">{icon}<span><strong>{title}</strong><small>{detail}</small></span><CheckCircle size={17} weight="fill" /></div>; }
function EmptyState({ title }) { return <div className="empty-state"><Database size={24} /><strong>{title}</strong><span>接入真实数据后会显示在这里。</span></div>; }

export { roleLabel };

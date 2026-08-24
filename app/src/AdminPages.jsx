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
  X,
} from "@phosphor-icons/react";
import { historyRecords } from "./data.js";
import { askHistory, downloadRecordMarkdown, downloadRecordsMarkdown, getRecordStats } from "./services/historyService.js";
import { agentApiEnabled, askLiveHistory, createAdminAccount, createRegistrationCode, demoMode, deleteLivePrivacySubject, exportLiveAudit, exportLivePrivacySubject, getAdminAccounts, getLiveAdminSettings, getLiveAiUsage, getLiveAudit, getLiveDeviceDetail, getLiveDevices, getLiveEmployees, getLiveEvents, getLiveOrganization, getLivePolicy, getLivePrivacyPolicy, getLiveRolePolicies, getLiveTeams, getMemoryJobs, runRetention, setAdminAccountStatus, setLiveDeviceStatus, updateActivityCategories, updateIntegrationSettings, updateLivePolicy, updateLivePrivacyPolicy, updateNotificationSettings, updateOrganizationSettings, verifyLiveAuditIntegrity } from "./services/agentApi.js";
import { auditData, deviceData, employeeData, permissionRoles, settingsData, teamData } from "./adminData.js";
import { SHANGHAI_TIME_ZONE, formatShanghaiTime, shanghaiDateAtStart, shanghaiDateInput, shanghaiDayKey, shanghaiWeekKey } from "./time.js";

const roleLabel = { admin: "老板", manager: "高管", employee: "员工" };

export function AdminPage({ page, role, principal, query, target, liveRecords, onNavigate, onToast }) {
  switch (page) {
    case "overview": return <OverviewPage role={role} principal={principal} liveRecords={liveRecords} onNavigate={onNavigate} onToast={onToast} />;
    case "teams": return <TeamsPage role={role} principal={principal} target={target} liveRecords={liveRecords} onNavigate={onNavigate} onToast={onToast} />;
    case "employees": return <EmployeesPage role={role} principal={principal} query={query} target={target} liveRecords={liveRecords} onNavigate={onNavigate} onToast={onToast} />;
    case "memory": return <MemoryPage role={role} query={query} target={target} liveRecords={liveRecords} onNavigate={onNavigate} onToast={onToast} />;
    case "skill": return <SkillPage role={role} records={liveRecords ?? (demoMode ? historyRecords : [])} onNavigate={onNavigate} />;
    case "devices": return <DevicesPage role={role} principal={principal} query={query} target={target} onNavigate={onNavigate} onToast={onToast} />;
    case "permissions": return <PermissionsPage role={role} principal={principal} target={target} onToast={onToast} />;
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
  const config = { online: ["在线", "online"], active: ["工作中", "online"], idle: ["空闲", "idle"], offline: ["离线", "offline"], meeting: ["会议中", "meeting"], locked: ["已锁定", "offline"], generated: ["已生成", "online"], generating: ["生成中", "meeting"], running: ["生成中", "meeting"], queued: ["排队中", "idle"], retrying: ["重试中", "meeting"], pending: ["待补全", "idle"], window_pending: ["等待10分钟窗口", "idle"], failed: ["失败", "offline"], allow: ["允许", "online"], success: ["成功", "online"], attention: ["需关注", "idle"] }[status] || [status, "idle"];
  return <span className={`status-pill ${config[1]}`}><span />{config[0]}</span>;
}

function MiniBars({ values, labels }) {
  return <div className="mini-bars">{values.map((value, index) => <div className="mini-bar-group" key={`${value}-${index}`}><div className="mini-bar-track"><span style={{ height: `${value}%` }} /></div><small>{labels[index]}</small></div>)}</div>;
}

function workThemeLabel(record, fallback = "暂无实时主题") {
  const value = String(record?.summary || record?.contextLabels?.[0] || record?.title || fallback).replace(/^项目：/, "").trim();
  return value.length > 88 ? `${value.slice(0, 86)}…` : value;
}

function OverviewPage({ role, principal, liveRecords, onNavigate, onToast }) {
  const [tab, setTab] = useState("今日态势");
  const [liveDevices, setLiveDevices] = useState(null);
  const [liveJobs, setLiveJobs] = useState(null);
  const [liveTeams, setLiveTeams] = useState(null);
  const canSeeManagement = role !== "employee";
  const sourceRecords = liveRecords ?? (demoMode ? historyRecords : []);
  const employeeId = principal?.employee_id;
  const managerTeam = principal?.team;
  const scopedRecords = role === "employee"
    ? sourceRecords.filter((record) => employeeId
      ? record.userId === employeeId || record.user_id === employeeId
      : demoMode && (record.userId === "employee-wei" || record.user_id === "employee-wei" || record.employee_name === "Wei"))
    : role === "manager"
      ? sourceRecords.filter((record) => managerTeam ? record.employee_team === managerTeam || record.employeeTeam === managerTeam : false)
      : sourceRecords;
  const rollups = scopedRecords.filter((record) => record.recordType === "rollup");
  const leafRecords = scopedRecords.filter((record) => record.recordType === "leaf");
  const currentShanghaiWeek = shanghaiWeekKey(Date.now());
  const currentWeekThemeCount = new Set(rollups
    .filter((record) => shanghaiWeekKey(record.period_start || record.started_at) === currentShanghaiWeek)
    .map((record) => record.title)
    .filter(Boolean)).size;
  const apps = new Set(scopedRecords.flatMap((record) => record.applicationNames || record.application_names || []));
  const totalDuration = scopedRecords.reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0);
  const totalSwitches = scopedRecords.reduce((sum, record) => sum + Number(record.contextSwitches || record.context_switches || 0), 0);
  const averageWindow = leafRecords.length ? Math.round(leafRecords.reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0) / leafRecords.length / 60) : 0;
  const unknownRatio = leafRecords.length ? Math.round((leafRecords.filter((record) => (record.contextKinds || record.context_kinds || []).includes("其他")).length / leafRecords.length) * 1000) / 10 : 0;
  const trendDays = Array.from({ length: 7 }, (_, index) => {
    return shanghaiDateAtStart(6 - index);
  });
  const trendDurations = trendDays.map((date) => leafRecords
    .filter((record) => {
      const started = new Date(record.started_at || record.startedAt || 0);
      return shanghaiDayKey(started) === shanghaiDayKey(date);
    })
    .reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0));
  const maxTrendDuration = Math.max(...trendDurations, 1);
  const trendValues = trendDurations.map((value) => Math.round((value / maxTrendDuration) * 100));
  const trendLabels = trendDays.map((date) => date.toLocaleDateString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, weekday: "short" }).replace("周", "周"));
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
            { label: "本周工作主题", value: `${currentWeekThemeCount}`, detail: "按东八区自然周统计", icon: <Sparkle size={20} />, good: true },
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

function TeamsPage({ role, principal, target, liveRecords, onNavigate, onToast }) {
  const [tab, setTab] = useState("团队列表");
  const [liveTeams, setLiveTeams] = useState(null);
  const [liveEmployees, setLiveEmployees] = useState(null);
  const [directoryError, setDirectoryError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    Promise.all([getLiveTeams(), getLiveEmployees()]).then(([teams, employees]) => {
      if (cancelled) return;
      setLiveTeams(teams);
      setLiveEmployees(employees);
    }).catch((error) => {
      if (!cancelled) setDirectoryError(error.message);
    });
    return () => { cancelled = true; };
  }, [role]);
  const directoryTeams = liveTeams ?? (demoMode ? teamData : []);
  const directoryEmployees = liveEmployees ?? (demoMode ? employeeData : []);
  const visibleTeams = role === "manager"
    ? directoryTeams.filter((team) => principal?.team ? team.name === principal.team : demoMode && team.name === "研发与产品中心")
    : directoryTeams;
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
  return <div className="page-content"><PageHeader eyebrow="TEAM WORKSPACE" title="团队" description="以团队为单位查看工作主题、活动覆盖和 Memory Summary。" meta={`${teamCards.length} 个团队`} />{directoryError && <div className="error-box">组织目录读取失败：{directoryError}</div>}<Tabs tabs={tabs} active={tab} onChange={setTab} />{tab === "团队列表" && <SectionCard title="团队列表" description="点击团队进入成员、趋势和工作主题详情"><div className="team-grid">{teamCards.map((team) => <button className="team-card" key={team.id} onClick={() => openTeam(team)}><div className="team-card-top"><span className="team-avatar">{team.name.slice(0, 1)}</span><span className="team-card-arrow"><ArrowSquareOut size={16} /></span></div><h3>{team.name}</h3><p>{team.focus}</p><div className="team-card-meta"><span><UsersThree size={14} />{team.members} 人</span><span><Pulse size={14} />{team.coverage}% 覆盖</span></div><div className="team-card-progress"><span style={{ width: `${team.coverage}%` }} /></div><small>负责人：{team.lead}{agentApiEnabled && liveRecords !== null ? ` · ${team.liveRecordCount} 条实时记录` : ""}</small></button>)}</div></SectionCard>}{tab === "团队详情" && selectedTeam && <TeamDetail team={selectedTeam} employees={directoryEmployees} liveRecords={teamRecords} onNavigate={onNavigate} onToast={onToast} />}{tab === "团队趋势" && selectedTeam && <><KpiGrid items={[{ label: "可见记录", value: `${teamRecords.length}`, detail: "当前权限范围", icon: <Pulse size={20} />, good: true }, { label: "连续工作窗口", value: `${teamRollups.length}`, detail: "团队周汇总", icon: <Clock size={20} />, tone: "blue" }, { label: "应用上下文", value: `${new Set(teamRecords.flatMap((record) => record.applicationNames || [])).size}`, detail: "去重后应用数", icon: <UsersThree size={20} />, tone: "green" }, { label: "切换次数", value: `${teamRecords.reduce((sum, record) => sum + Number(record.contextSwitches || 0), 0)}`, detail: "只表示上下文变化", icon: <Lightning size={20} />, tone: "gold" }]} /><SectionCard title={`${selectedTeam.name} 活动趋势`} description="当前已接入的实时 Memory Summary"><MiniBars values={[teamRecords.length, teamRollups.length, topicRecords.length, 0, 0, 0, 0]} labels={["记录", "周汇总", "主题", "待补", "待补", "待补", "今天"]} /></SectionCard></>}{tab === "工作主题" && selectedTeam && <SectionCard title="连续工作主题" description="由团队周汇总和实时活动记录聚合"><div className="topic-list">{topicRecords.length ? topicRecords.map((record, index) => <TopicRow key={record.id} rank={String(index + 1).padStart(2, "0")} title={record.title} detail={`${record.duration} · ${record.recordType === "rollup" ? "团队 Rollup" : "Leaf 活动"}`} value={`${Math.max(12, 42 - index * 8)}%`} />) : <EmptyState title="暂无团队主题" />}</div></SectionCard>}{tab === "团队 Skill" && selectedTeam && <SectionCard title="团队 History Skill" description={`当前查询范围：${selectedTeam.name}`}><form className="team-skill-form" onSubmit={runTeamQuestion}><ChatCircleDots size={20} /><input value={skillQuestion} onChange={(event) => setSkillQuestion(event.target.value)} placeholder="询问这个团队最近的工作主题..." /><button className="primary-button" type="submit"><PaperPlaneTilt size={16} />提问</button></form>{skillAnswer ? <SkillAnswer result={skillAnswer} onOpen={() => onNavigate("history")} /> : <div className="question-grid"><button onClick={() => setSkillQuestion("这个团队本周主要在做什么？")}>这个团队本周主要在做什么？</button><button onClick={() => setSkillQuestion("团队是否存在频繁任务切换？")}>团队是否存在频繁任务切换？</button></div>}</SectionCard>}</div>;
}

function TeamDetail({ team, employees = employeeData, liveRecords = [], onNavigate, onToast }) {
  const members = employees.filter((employee) => employee.team === team.name);
  const teamRollups = liveRecords.filter((record) => record.rollupScope === "team_weekly");
  return <><SectionCard title={team.name} description={`${team.focus} · 负责人 ${team.lead}`}><div className="detail-summary-grid"><div><span>成员</span><strong>{team.members}</strong><small>活跃 {team.activeMembers} 人</small></div><div><span>实时记录</span><strong>{liveRecords.length}</strong><small>当前权限范围</small></div><div><span>主要工具</span><strong>{new Set(liveRecords.flatMap((record) => record.applicationNames || [])).size}</strong><small>{[...new Set(liveRecords.flatMap((record) => record.applicationNames || []))].slice(0, 2).join("、") || "暂无"}</small></div><div><span>团队周汇总</span><strong>{teamRollups.length}</strong><small>可回溯到 Leaf</small></div></div></SectionCard><div className="two-column-grid"><SectionCard title="团队成员" description="点击成员查看个人活动"><div className="compact-list">{members.length ? members.map((employee) => <button className="compact-row" key={employee.id} onClick={() => onNavigate("employees", employee.id)}><span className="person-avatar">{employee.name.slice(0, 1)}</span><span><strong>{employee.name}</strong><small>{employee.title} · {employee.focus}</small></span><StatusPill status={employee.status} /><ArrowSquareOut size={15} /></button>) : <EmptyState title="暂无成员数据" />}</div></SectionCard><SectionCard title="团队 Memory Summary" description="最近生成的团队级记录"><div className="summary-list">{teamRollups.length ? teamRollups.slice(0, 3).map((record) => <button className="summary-row" key={record.id} onClick={() => onNavigate("memory", record.id)}><span className="summary-icon"><Sparkle size={17} weight="fill" /></span><span><strong>{record.title}</strong><small>{record.duration} · {record.source_record_ids?.length || record.timeline?.length || 0} 个下层记录</small></span><ArrowSquareOut size={15} /></button>) : <EmptyState title="暂无团队周汇总" />}</div></SectionCard></div></>;
}

function TopicRow({ rank, title, detail, value }) {
  return <div className="topic-row"><span className="topic-rank">{rank}</span><span><strong>{title}</strong><small>{detail}</small></span><span className="topic-track"><span style={{ width: value }} /></span><b>{value}</b></div>;
}

function EmployeesPage({ role, principal, query, target, liveRecords, onNavigate, onToast }) {
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
  const visibleEmployees = role === "employee"
    ? directoryEmployees.filter((employee) => principal?.employee_id
      ? employee.id === principal.employee_id
      : demoMode && employee.id === "employee-wei")
    : role === "manager"
      ? directoryEmployees.filter((employee) => principal?.team ? employee.team === principal.team : demoMode && employee.team === "研发与产品中心")
      : directoryEmployees;
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
    return shanghaiDateAtStart(6 - index);
  });
  const trend = trendDays.map((date) => records.filter((record) => shanghaiDayKey(record.started_at || record.startedAt || 0) === shanghaiDayKey(date)).reduce((sum, record) => sum + Number(record.durationSeconds || record.duration_seconds || 0), 0));
  const maxTrend = Math.max(...trend, 1);
  return <SectionCard title={`${employee.name} 的工作模式`} description="趋势用于辅助理解上下文，不单独作为绩效结论"><div className="pattern-grid"><div className="pattern-card"><span>工作主题集中度</span><strong>{records.length ? `${concentration}%` : "—"}</strong><small>{records.length ? "当前可见记录" : "等待 Agent 数据"}</small></div><div className="pattern-card"><span>任务切换密度</span><strong>{switchDensity}{switchDensity === "—" ? "" : " / h"}</strong><small>只表示上下文变化</small></div><div className="pattern-card"><span>活动时长</span><strong>{durationSeconds ? `${Math.round(durationSeconds / 60)}m` : "—"}</strong><small>当前可见记录</small></div><div className="pattern-card"><span>未知活动</span><strong>{unknownRatio}</strong><small>无法可靠分类的活动</small></div></div><MiniBars values={trend.map((value) => Math.round((value / maxTrend) * 100))} labels={trendDays.map((date) => date.toLocaleDateString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, weekday: "short" }).replace("周", "周"))} /></SectionCard>;
}

function MemoryPage({ role, query, target, liveRecords, onNavigate, onToast: notify }) {
  const [tab, setTab] = useState("全部记录");
  const [selected, setSelected] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [cadence, setCadence] = useState(null);
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
      if (active) {
        setJobs(result.jobs.filter((job) => ["queued", "retrying", "running", "failed"].includes(job.status)));
        setCadence(result.cadence);
      }
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
  const cadenceText = cadence
    ? `AI 仅处理已闭合 ${Math.round(Number(cadence.summary_window_seconds || 600) / 60)} 分钟窗口；后台每 ${cadence.generation_interval_seconds || 15} 秒最多处理 ${cadence.generation_batch_size || 1} 条任务。`
    : "AI 仅处理已闭合的十分钟窗口，活动中的记录不会触发模型调用。";
  return <div className="page-content"><PageHeader eyebrow="MEMORY DOCUMENTS" title="Memory Summary" description="管理按工作主题生成的记忆文档、层级关系和来源引用。" meta={`${records.length} 条可见记录`} action={<button className="outline-button" onClick={exportVisibleRecords}><DownloadSimple size={17} />批量导出</button>} /><Tabs tabs={["全部记录", "Leaf", "Rollup", "待生成", "来源关系", "导出"]} active={tab} onChange={setTab} />{["全部记录", "Leaf", "Rollup"].includes(tab) && <SectionCard title={`${tab} Memory Summary`} description="数据库为权威数据源，Markdown 是标准化导出格式"><MemoryRows records={records} onOpen={(record) => setSelected(record)} onExport={exportRecord} /></SectionCard>}{tab === "待生成" && <SectionCard title="摘要生成队列" description={`${agentApiEnabled ? "来自服务端的真实生成任务，可追踪失败和重试状态。" : "连接服务端后显示真实生成队列。"} ${cadenceText}`}>{jobsLoading && <div className="queue-card"><span className="queue-icon"><Sparkle size={20} weight="fill" /></span><span><strong>正在读取生成队列…</strong><small>服务端会按限流策略逐批调用模型。</small></span><StatusPill status="generating" /></div>}{jobsError && <div className="error-box">读取摘要队列失败：{jobsError}</div>}{!jobsLoading && !jobsError && (jobs.length ? jobs.map((job) => <div className="queue-card" key={job.id}><span className={`queue-icon ${job.status === "failed" ? "gold" : ""}`}>{job.status === "failed" ? <WarningCircle size={20} weight="fill" /> : <Sparkle size={20} weight="fill" />}</span><span><strong>{job.employee_name} · {job.record_type === "rollup" ? `${job.rollup_scope || "window"} Rollup` : "Leaf Summary"}</strong><small>{job.status} · 尝试 {job.attempts} 次 · {job.last_error || "等待模型生成"}</small></span><StatusPill status={job.status === "succeeded" ? "generated" : job.status === "failed" ? "failed" : job.status === "running" ? "generating" : "pending"} /></div>) : <EmptyState title="暂无待处理摘要任务" />)}</SectionCard>}{tab === "来源关系" && <SectionCard title="来源关系" description="从 Rollup Summary 回溯到 Leaf Summary 和原始事件"><div className="source-graph"><div className="source-node root"><Sparkle size={18} /><span><strong>实时 Memory Summary</strong><small>Rollup · 可回溯</small></span></div><div className="graph-connector" /><div className="source-children"><div className="source-node"><Clock size={17} /><span><strong>Leaf Summary</strong><small>应用活动窗口</small></span></div><div className="source-node"><FileText size={17} /><span><strong>活动事件</strong><small>设备上传的元数据</small></span></div><div className="source-node"><Code size={17} /><span><strong>受保护工作标识</strong><small>只保留脱敏引用</small></span></div></div></div></SectionCard>}{tab === "导出" && <SectionCard title="导出中心" description="按权限导出 Memory Summary，不包含受保护的原始正文"><div className="export-list"><div><span><DownloadSimple size={19} /><strong>当前可见 Memory Summary</strong><small>{sourceRecords.length} 条记录 · Markdown</small></span><button className="outline-button" onClick={exportVisibleRecords}>导出</button></div><div><span><DownloadSimple size={19} /><strong>团队周汇总</strong><small>{sourceRecords.filter((record) => record.rollupScope === "team_weekly").length} 条记录 · Markdown</small></span><button className="outline-button" onClick={() => onToast("已开始导出团队周汇总")}>导出</button></div></div></SectionCard>}{selected && <MemoryDrawer record={selected} onClose={() => setSelected(null)} onExport={() => exportRecord(selected)} onNavigate={onNavigate} />}</div>;
}

function MemoryRows({ records, onOpen, onExport }) {
  return <div className="memory-table"><div className="memory-row memory-head"><span>记录</span><span>类型</span><span>来源</span><span>状态</span><span /></div>{records.length ? records.map((record) => <div className="memory-row" key={record.id}><button className="memory-title" onClick={() => onOpen(record)}><span className="summary-icon"><Sparkle size={16} weight="fill" /></span><span><strong>{record.title}</strong><small>{record.duration} · {record.description.slice(0, 76)}...</small></span></button><span><span className={`record-type ${record.recordType}`}>{record.recordType === "rollup" ? "Rollup" : "Leaf"}</span></span><span className="source-count"><FileText size={14} />{record.resources.length + record.citations.length} 个来源</span><StatusPill status={record.summaryStatus || "generated"} /><button className="row-action" onClick={() => onExport(record)} title="导出 Markdown"><DownloadSimple size={16} /></button></div>) : <EmptyState title="暂无记录" />}</div>;
}

function MemoryDrawer({ record, onClose, onExport, onNavigate }) {
  const stats = getRecordStats(record);
  const resources = record.resources || [];
  const citations = record.citations || [];
  const timeline = record.timeline || [];
  const sequence = record.summaryActivitySequence || record.summary_activity_sequence || record.activitySequence || record.activity_sequence || [];
  const sourceTypes = record.sourceTypes || record.source_types || [];
  const model = record.summaryModel || "rules-v1";
  const prompt = record.promptVersion || record.prompt_version || "memory-v1";
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="memory-drawer"><div className="drawer-header"><span className="page-eyebrow">MEMORY SUMMARY</span><button className="drawer-close" onClick={onClose}>×</button><h2>{record.title}</h2><p>{record.duration} · {record.recordType === "rollup" ? "Rollup Summary" : "Leaf Summary"} · {model} · Prompt {prompt} · 置信度 {stats.confidence}</p></div><div className="drawer-actions"><button className="outline-button" onClick={onExport}><DownloadSimple size={16} />导出 Markdown</button><button className="primary-button" onClick={() => { onClose(); onNavigate("history"); }}><ArrowSquareOut size={16} />打开时间线</button></div><div className="drawer-content"><DrawerSection title="Memory summary"><p>{record.summary}</p></DrawerSection><DrawerSection title="Relevant prior context"><p>{record.priorContext || "暂无前置上下文。"}</p></DrawerSection><DrawerSection title="Important non-obvious context"><div className="uncertain-box"><WarningCircle size={16} /><p>{record.importantContext || record.nonObvious || "暂无额外说明。"}</p></div></DrawerSection><DrawerSection title="Recording summary"><div className="drawer-timeline">{timeline.length ? timeline.map((item) => <div className="drawer-timeline-row" key={`${item.time}-${item.text}`}><span>{item.time}</span><span>{item.text}</span></div>) : <span className="empty-inline">暂无活动片段。</span>}</div>{sequence.length ? <div className="sequence-note"><strong>活动顺序</strong><span>{sequence.map((item) => `${item.app || item.app_name || "未知应用"}（${Math.max(1, Math.round(Number(item.duration_seconds || 0) / 60))} 分钟）`).join(" → ")}</span></div> : null}</DrawerSection>{sourceTypes.length ? <DrawerSection title="来源类型"><div className="detail-chip-row">{sourceTypes.map((sourceType) => <span className="detail-chip" key={sourceType}><Tag size={14} />{sourceType}</span>)}</div></DrawerSection> : null}<DrawerSection title={`Resources · ${resources.length}`}><div className="citation-mini-list">{resources.length ? resources.map((resource) => <div key={resource.name}><FileText size={15} /><span><strong>{resource.name}</strong><small>{resource.path}</small></span></div>) : <span className="empty-inline">当前记录没有额外资源，仅保留活动元数据。</span>}</div></DrawerSection><DrawerSection title={`Citations · ${citations.length}`}><div className="citation-mini-list">{citations.length ? citations.map((citation) => <div key={`${citation.label}-${citation.detail}`}><FileText size={15} /><span><strong>{citation.label}</strong><small>{citation.detail}</small></span></div>) : <span className="empty-inline">当前记录没有可展示的来源引用。</span>}</div></DrawerSection><DrawerSection title="上下层关系"><div className="relation-line"><span className="relation-node">{record.recordType === "rollup" ? "Rollup" : "Leaf"}</span><span className="relation-arrow">→</span><span className="relation-node">{record.recordType === "rollup" ? `${timeline.length} 个下层窗口` : "原始活动事件"}</span></div></DrawerSection></div></aside></div>;
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
    ? `${formatShanghaiTime(result.timeRange.start)} – ${formatShanghaiTime(result.timeRange.end)}`
    : "暂无可用时间范围";
  const applications = result.applications || [];
  const contextLabels = result.contextLabels || [];
  const webDomains = result.webDomains || [];
  return <div className="skill-answer"><p>{result.answer}</p><div className="skill-answer-meta"><span><CheckCircle size={15} weight="fill" />已关联 {result.evidence?.length || 0} 条证据</span><span><Fingerprint size={15} />权限范围内</span><span><Clock size={15} />{timeRange}</span>{result.retrieval?.mode ? <span title="基于脱敏活动元数据和语义同义词检索"><Sparkle size={15} />语义检索</span> : null}{applications.length ? <span><Monitor size={15} />应用：{applications.join("、")}</span> : null}{contextLabels.length ? <span><Tag size={15} />工作标识：{contextLabels.join("、")}</span> : null}{webDomains.length ? <span><Browser size={15} />网站：{webDomains.join("、")}</span> : null}{result.citations?.length ? <span><FileText size={15} />来源引用：{result.citations.slice(0, 3).map((citation) => citation.label).join("、")}</span> : null}</div><div className="evidence-list"><span className="evidence-label">证据记录</span>{(result.evidence || []).map((record) => <button key={record.id} onClick={onOpen}><Sparkle size={16} weight="fill" /><span><strong>{record.title}</strong><small>{record.duration} · 置信度 {Math.round(record.confidence * 100)}%</small></span><ArrowSquareOut size={15} /></button>)}</div><div className="caveat-box"><WarningCircle size={16} /><span>{result.caveats?.[0] || "答案只基于活动元数据和 Memory Summary。"}</span></div>{result.uncertainty && <div className="caveat-box"><Info size={16} /><span>不确定性：{result.uncertainty}</span></div>}</div>;
}

function DevicesPage({ role, principal, query, target, onNavigate, onToast }) {
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
  const scopedDevices = role === "employee"
    ? sourceDevices.filter((device) => principal?.employee_id
      ? device.employeeId === principal.employee_id
      : demoMode && device.user === "Wei")
    : role === "manager" && principal?.team
      ? sourceDevices.filter((device) => device.team === principal.team)
      : sourceDevices;
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
        ? liveEvents.slice(0, 6).map((event) => <DiagnosticRow key={event.id} icon={event.type === "idle" ? <WarningCircle size={18} weight="fill" /> : <CheckCircle size={18} weight="fill" />} title={event.type === "idle" ? "系统空闲事件" : `活动事件：${event.app_name}`} detail={`${event.hostname || "设备"} · ${event.time || "刚刚"} · ${event.duration} · ${event.captureSource || "活动元数据"}`} />)
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
      onToast("只有老板可以生成一次性注册码");
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

  return <div className="page-content"><PageHeader eyebrow="DEVICE FLEET" title="设备" description={agentApiEnabled ? "已连接 Agent 局域网服务，显示真实设备心跳和缓存状态。" : "管理 Windows Agent、设备在线状态和采集诊断。"} meta={`${devices.length} 台设备`} action={<button className="outline-button" onClick={() => void openRegistration()}><Plus size={17} />注册设备</button>} />{liveError && <div className="error-box">Agent 服务暂时不可用：{liveError}</div>}<Tabs tabs={["设备列表", "Agent 状态", "采集策略", "事件诊断"]} active={tab} onChange={setTab} />{tab === "设备列表" && <SectionCard title="Windows 设备" description="点击设备查看会话、心跳、缓存和采集错误"><div className="data-table device-table"><div className="table-row table-head"><span>设备</span><span>使用者</span><span>系统 / Agent</span><span>会话</span><span>心跳</span><span>状态</span></div>{devices.map((device) => <button className="table-row" key={device.id} onClick={() => setSelected(device)}><span className="table-person"><span className="device-icon"><Monitor size={17} /></span><strong>{device.name}</strong></span><span>{device.user}</span><span><strong>{device.os}</strong><small>Agent {device.agent}</small></span><span>{device.session}</span><span>{device.heartbeat}</span><StatusPill status={device.status} /></button>)}</div></SectionCard>}{tab === "Agent 状态" && <><KpiGrid items={[{ label: "Agent 在线率", value: `${scopedDevices.length ? Math.round((onlineCount / scopedDevices.length) * 100) : 0}%`, detail: `${onlineCount} / ${scopedDevices.length} 台`, icon: <Pulse size={20} />, good: true }, { label: "当前版本", value: versionCounts[0]?.version || "—", detail: `${versionCounts[0]?.count || 0} 台设备`, icon: <Wrench size={20} />, tone: "blue" }, { label: "待上传缓存", value: `${queuedCount} 条`, detail: "设备离线时保存在本地", icon: <DownloadSimple size={20} />, tone: "gold" }, { label: "异常设备", value: `${scopedDevices.filter((device) => device.status === "offline" || device.cache > 0).length} 台`, detail: "按心跳和缓存状态", icon: <WarningCircle size={20} />, tone: "green" }]} /><SectionCard title="Agent 版本分布"><div className="version-list">{versionRows}</div></SectionCard></>}{tab === "采集策略" && <PolicyPreview role={role} onNavigate={onNavigate} onToast={onToast} />}{tab === "事件诊断" && <SectionCard title="最近采集事件" description="只显示 Agent 诊断元数据"><div className="diagnostic-list">{diagnosticRows}</div></SectionCard>}{selected && <DeviceDrawer device={selected} role={role} onClose={() => setSelected(null)} onToast={onToast} />}{registrationOpen && <RegistrationCodeModal employees={registrationEmployees} employeeId={registrationEmployeeId} expiresInSeconds={registrationExpires} code={registrationCode} loading={registrationLoading} error={registrationError} onEmployeeChange={setRegistrationEmployeeId} onExpiresChange={setRegistrationExpires} onGenerate={() => void generateRegistrationCode()} onCopy={() => void copyRegistrationCode()} onClose={() => setRegistrationOpen(false)} />}</div>;
}

function RegistrationCodeModal({ employees, employeeId, expiresInSeconds, code, loading, error, onEmployeeChange, onExpiresChange, onGenerate, onCopy, onClose }) {
  const employee = employees.find((item) => item.id === employeeId);
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="detail-panel registration-panel" role="dialog" aria-modal="true" aria-label="生成一次性注册码"><div className="detail-topbar"><div><span className="detail-kicker"><Fingerprint size={14} />DEVICE ENROLLMENT</span><h2>生成一次性注册码</h2><p>绑定 Windows Agent 到指定员工</p></div><button className="detail-close" onClick={onClose}><X size={21} /></button></div><div className="detail-scroll"><div className="detail-description">员工安装通用 MSI 后，需要使用这里生成的注册码完成设备绑定。注册码只显示一次，不写入安装包。</div><div className="registration-form"><label>绑定员工<select value={employeeId} onChange={(event) => onEmployeeChange(event.target.value)} disabled={loading || Boolean(code)}><option value="">请选择员工</option>{employees.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.team}</option>)}</select></label><label>有效期<select value={expiresInSeconds} onChange={(event) => onExpiresChange(Number(event.target.value))} disabled={loading || Boolean(code)}><option value={3600}>1 小时</option><option value={8 * 3600}>8 小时</option><option value={24 * 3600}>24 小时</option><option value={7 * 24 * 3600}>7 天</option></select></label></div>{error && <div className="error-box">注册码生成失败：{error}</div>}{code && <div className="registration-code-box"><span>发送给 {employee?.name || "员工"}</span><strong>{code.code}</strong><small>有效至 {formatShanghaiTime(code.expires_at)}</small><button className="primary-button" onClick={onCopy}><DownloadSimple size={16} />复制注册码</button></div>} {!code && !error && !employees.length && <div className="empty-state"><UsersThree size={24} /><strong>暂无可绑定员工</strong><span>请先在员工目录中创建员工。</span></div>}<div className="registration-actions">{!code && <button className="primary-button" disabled={loading || !employeeId} onClick={onGenerate}>{loading ? "生成中…" : "生成注册码"}</button>}<button className="outline-button" onClick={onClose}>关闭</button></div><div className="detail-note"><ShieldCheck size={17} /><span>注册码只用于首次绑定；后续事件使用设备 Token。管理员 Token 和 API Key 不会发送到 Agent。</span></div></div></aside></div>;
}

function VersionRow({ version, count, width, status }) { return <div className="version-row"><span><strong>{version}</strong><small>{count}</small></span><span className="version-track"><i style={{ width }} /></span><StatusPill status={status === "推荐" ? "online" : status === "过旧" ? "offline" : "pending"} /></div>; }
function PolicyPreview({ role, onNavigate, onToast }) {
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
  const openEditor = () => {
    if (role !== "admin") {
      onToast("当前是员工只读视角；请切换为老板后编辑采集策略");
      return;
    }
    onNavigate("permissions", "policy");
  };
  return <SectionCard title="采集策略" description="当前记录前台应用、空闲状态、心跳和扩展上报的安全工作元数据；此处开关是状态展示，编辑请进入策略编辑页"><div className="policy-grid"><PolicyItem icon={<Browser size={19} />} title="应用活动" detail={`记录前台应用名称和使用时长 · ${hours}`} enabled onClick={openEditor} /><PolicyItem icon={<Clock size={19} />} title="系统空闲" detail={`超过 ${idle} 进入空闲状态`} enabled onClick={openEditor} /><PolicyItem icon={<Globe size={19} />} title="网站域名与安全提示" detail="Chrome/Edge 扩展仅保留域名和允许的来源提示" enabled onClick={openEditor} /><PolicyItem icon={<DeviceMobile size={19} />} title="截图、键盘和正文" detail="明确禁止采集" enabled={false} onClick={openEditor} /></div>{error && <div className="error-box">读取采集策略失败：{error}</div>}<button className="outline-button" onClick={openEditor}><SlidersHorizontal size={16} />编辑采集策略</button></SectionCard>;
}
function PolicyItem({ icon, title, detail, enabled, onClick }) {
  const className = `policy-item ${enabled ? "enabled" : "disabled"}${onClick ? " actionable" : ""}`;
  const content = <><span className="policy-icon">{icon}</span><span><strong>{title}</strong><small>{detail}</small></span><span className={`toggle ${enabled ? "on" : ""}`}><i /></span></>;
  return onClick ? <button type="button" className={className} onClick={onClick} aria-label={`${title}，打开采集策略编辑`} >{content}</button> : <div className={className}>{content}</div>;
}
function DiagnosticRow({ icon, title, detail }) { return <div className="diagnostic-row">{icon}<span><strong>{title}</strong><small>{detail}</small></span><ArrowSquareOut size={15} /></div>; }
function DeviceRow({ device, onToast }) { return <div className="device-detail-row"><span className="device-icon large"><Monitor size={21} /></span><span><strong>{device.name}</strong><small>{device.os} · Agent {device.agent}</small></span><StatusPill status={device.status} /><button className="outline-button" onClick={() => onToast("已打开设备诊断")}><Wrench size={16} />诊断</button></div>; }
function DeviceDrawer({ device, role, onClose, onToast }) {
  const [detail, setDetail] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = detail?.device || device;
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    getLiveDeviceDetail(device.id).then(setDetail).catch((requestError) => setError(requestError.message));
    return undefined;
  }, [device.id]);
  const changeStatus = async (enabled) => {
    if (role !== "admin") {
      onToast("当前角色只能查看设备；请切换为老板后操作");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const updated = agentApiEnabled ? await setLiveDeviceStatus(device.id, enabled) : { ...current, status: enabled ? "offline" : "disabled" };
      setDetail((value) => ({ ...(value || {}), device: { ...current, ...updated } }));
      onToast(enabled ? "设备已启用，等待 Agent 恢复心跳" : "设备已停用并撤销浏览器 Token");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };
  const disabled = current.status === "disabled" || Boolean(current.disabled_at);
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="memory-drawer device-drawer"><div className="drawer-header"><span className="page-eyebrow">DEVICE DETAIL</span><button className="drawer-close" onClick={onClose}>×</button><h2>{current.hostname || current.name}</h2><p>{current.employee_name || current.user} · {current.os_version || current.os} · Agent {current.agent_version || current.agent}</p></div><div className="drawer-content"><div className="device-status-banner"><StatusPill status={disabled ? "locked" : current.status} /><span>最近心跳 {current.last_heartbeat_at ? formatShanghaiTime(current.last_heartbeat_at) : current.heartbeat}</span></div>{error && <div className="error-box">设备操作失败：{error}</div>}<DrawerSection title="工作会话"><div className="detail-definition"><span>当前状态</span><strong>{disabled ? "已停用" : current.session || (current.status === "online" ? "active" : "offline")}</strong><span>离线缓存</span><strong>{current.queued_events ?? current.cache ?? 0} 条</strong><span>最近错误</span><strong>{(current.queued_events ?? current.cache ?? 0) > 0 ? `${current.queued_events ?? current.cache} 条待上传` : "无"}</strong><span>最近事件</span><strong>{detail?.events?.length ?? "读取中…"}</strong></div></DrawerSection><DrawerSection title="设备操作"><div className="drawer-button-list"><button onClick={() => onToast("重新注册需在 Agent 托盘中输入新的注册码")}><Fingerprint size={17} />重新注册 Agent</button><button onClick={() => onToast("已打开采集策略，请在权限页面修改")}><SlidersHorizontal size={17} />查看采集策略</button><button disabled={busy} onClick={() => void changeStatus(disabled)}>{disabled ? <CheckCircle size={17} /> : <LockKey size={17} />}{busy ? "处理中…" : disabled ? "启用设备" : "停用设备"}</button></div></DrawerSection></div></aside></div>;
}

function PermissionsPage({ role, principal, target, onToast }) {
  const canEdit = role === "admin";
  const [tab, setTab] = useState(target === "policy" ? "采集策略" : "角色");
  const [liveRoles, setLiveRoles] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    getLiveRolePolicies().then(setLiveRoles).catch((requestError) => setError(requestError.message));
    return undefined;
  }, []);
  const roleItems = liveRoles?.length ? liveRoles.map((item) => ({ ...item, role: item.label, users: "—" })) : permissionRoles;
  const tabs = canEdit ? ["账号", "角色", "组织关系", "数据范围", "采集策略", "应用/网站排除", "保留策略"] : ["角色", "组织关系", "数据范围", "采集策略", "应用/网站排除", "保留策略"];
  return <div className="page-content"><PageHeader eyebrow="ACCESS CONTROL" title="权限" description="管理老板、高管、员工三种角色、数据范围和采集策略。" meta="RBAC 已启用" action={<button className="outline-button" onClick={() => onToast(canEdit ? "系统角色固定为老板、高管和员工" : "当前角色只能查看权限配置")}><Key size={17} />固定三种角色</button>} />{error && <div className="error-box">权限配置读取失败：{error.message || error}</div>}<Tabs tabs={tabs} active={tab} onChange={setTab} />{tab === "账号" && canEdit && <AccountManagement onToast={onToast} />}{tab === "角色" && <SectionCard title="角色权限" description="系统只保留老板、高管、员工三种角色，权限由服务端强制执行"><div className="role-list">{roleItems.map((item) => <div className="role-row" key={item.role}><span className="role-icon"><Key size={18} /></span><span><strong>{item.role}</strong><small>{item.scope} · {item.users || "—"} 人 · {item.description || item.detail}</small></span><button className="outline-button" onClick={() => onToast(`${item.role}：${item.scope}，${item.description || item.detail}`)}>查看</button></div>)}</div></SectionCard>}{tab === "组织关系" && <OrgTree principal={principal} onToast={onToast} />}{tab === "数据范围" && <ScopePolicy role={role} onToast={onToast} />}{tab === "采集策略" && <PolicyEditor role={role} onToast={onToast} />}{tab === "应用/网站排除" && <ExclusionPolicy role={role} onToast={onToast} />}{tab === "保留策略" && <RetentionPolicy role={role} onToast={onToast} />}</div>;
}

function AccountManagement({ onToast }) {
  const [accounts, setAccounts] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [draft, setDraft] = useState({ username: "", password: "", display_name: "", role: "employee", employee_id: "", team: "" });
  const [loading, setLoading] = useState(agentApiEnabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const refresh = () => {
    if (!agentApiEnabled) return;
    setLoading(true);
    Promise.all([getAdminAccounts(), getLiveEmployees()]).then(([nextAccounts, nextEmployees]) => {
      setAccounts(nextAccounts);
      setEmployees(nextEmployees);
      setDraft((current) => ({ ...current, employee_id: current.employee_id || nextEmployees[0]?.id || "", team: current.team || nextEmployees[0]?.team || "" }));
    }).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false));
  };

  useEffect(() => { refresh(); }, []);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      const account = await createAdminAccount({ ...draft, employee_id: draft.role === "employee" ? draft.employee_id : undefined, team: draft.role === "manager" ? draft.team : undefined });
      setAccounts((current) => [...current, account]);
      setDraft({ username: "", password: "", display_name: "", role: "employee", employee_id: employees[0]?.id || "", team: employees[0]?.team || "" });
      onToast("账号已创建");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (account) => {
    try {
      await setAdminAccountStatus(account.id, Boolean(account.disabled_at));
      setAccounts((current) => current.map((item) => item.id === account.id ? { ...item, disabled_at: account.disabled_at ? null : new Date().toISOString() } : item));
      onToast(account.disabled_at ? "账号已启用" : "账号已停用，会话已撤销");
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  return <SectionCard title="后台账号" description="账号登录决定真实数据范围；停用账号会立即撤销其后台会话" action={<span className="scope-pill">{accounts.length} 个账号</span>}>
    <div className="account-admin-list">{loading ? <span className="empty-inline">正在读取账号…</span> : accounts.map((account) => <div className="account-admin-row" key={account.id}><span className="person-avatar">{account.display_name.slice(0, 1)}</span><span><strong>{account.display_name}</strong><small>{account.username} · {roleLabel[account.role]}{account.team ? ` · ${account.team}` : ""}</small></span><StatusPill status={account.disabled_at ? "offline" : "online"} /><button className="outline-button" onClick={() => void toggle(account)}>{account.disabled_at ? "启用" : "停用"}</button></div>)}</div>
    <form className="account-create-form" onSubmit={save}><strong>创建账号</strong><div className="settings-grid"><label className="setting-field"><span>用户名</span><input required value={draft.username} onChange={(event) => setDraft((current) => ({ ...current, username: event.target.value }))} /></label><label className="setting-field"><span>显示名称</span><input required value={draft.display_name} onChange={(event) => setDraft((current) => ({ ...current, display_name: event.target.value }))} /></label><label className="setting-field"><span>初始密码（至少12位）</span><input required type="password" minLength="12" value={draft.password} onChange={(event) => setDraft((current) => ({ ...current, password: event.target.value }))} /></label><label className="setting-field"><span>角色</span><select value={draft.role} onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}><option value="admin">老板</option><option value="manager">高管</option><option value="employee">员工</option></select></label>{draft.role === "employee" && <label className="setting-field"><span>绑定员工</span><select required value={draft.employee_id} onChange={(event) => setDraft((current) => ({ ...current, employee_id: event.target.value }))}>{employees.map((employee) => <option key={employee.id} value={employee.id}>{employee.name} · {employee.team}</option>)}</select></label>}{draft.role === "manager" && <label className="setting-field"><span>管理团队</span><input required value={draft.team} onChange={(event) => setDraft((current) => ({ ...current, team: event.target.value }))} /></label>}</div>{error && <div className="error-box">账号操作失败：{error}</div>}<button className="primary-button" disabled={saving}>{saving ? "创建中…" : "创建账号"}</button></form>
  </SectionCard>;
}
function OrgTree({ principal, onToast }) {
  const [organization, setOrganization] = useState(null);
  const [teams, setTeams] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    Promise.all([getLiveOrganization(), getLiveTeams()]).then(([nextOrganization, nextTeams]) => {
      if (cancelled) return;
      setOrganization(nextOrganization);
      setTeams(nextTeams);
    }).catch((requestError) => {
      if (!cancelled) setError(requestError.message);
    });
    return () => { cancelled = true; };
  }, []);
  const visibleTeams = teams ?? (demoMode ? teamData : []);
  const organizationName = organization?.name || (demoMode ? settingsData.company_name : "当前组织");
  return <SectionCard title="组织关系" description="直属管理关系决定团队和个人历史的默认可见范围">{error && <div className="error-box">组织目录读取失败：{error}</div>}<div className="org-tree"><div className="org-node root"><Buildings size={18} /><span><strong>{organizationName}</strong><small>{principal?.actor ? `当前账号：${principal.actor}` : "当前账号"}</small></span></div><div className="org-branch">{visibleTeams.length ? visibleTeams.map((team) => <div className="org-node" key={team.id}><UsersThree size={18} /><span><strong>{team.name}</strong><small>负责人 {team.lead || "待配置"} · {team.members} 人</small></span></div>) : <EmptyState title="暂无团队组织数据" />}</div></div></SectionCard>;
}
function ScopePolicy({ role = "admin", onToast }) {
  const fallback = permissionRoles.map((item, index) => ({ role: ["admin", "manager", "employee"][index], label: item.role, scope: item.scope, detail: item.description }));
  const [roles, setRoles] = useState(fallback);
  const [loading, setLoading] = useState(agentApiEnabled);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    getLiveRolePolicies().then(setRoles).catch((requestError) => setError(requestError.message)).finally(() => setLoading(false));
    return undefined;
  }, []);
  return <SectionCard title="数据范围" description="老板、高管、员工的数据范围由服务端 RBAC 强制执行，页面仅展示不可绕过的权限边界"><div className="scope-list">{roles.map((item) => <div className="scope-row" key={item.role}><span><strong>{item.label}</strong><small>{item.detail}</small></span><b>{loading ? "读取中…" : item.scope}</b><CaretDown size={15} /></div>)}</div>{error && <div className="error-box">数据范围读取失败：{error}</div>}<small className="policy-hint">历史、设备、Memory Summary、审计和 History Skill 查询均经过服务端范围过滤；老板可管理策略，高管和员工不能越权。</small></SectionCard>;
}
function PolicyEditor({ role = "admin", onToast }) {
  const canEdit = role === "admin";
  const [policy, setPolicy] = useState({ work_hours_start: "09:00", work_hours_end: "18:00", activity_checkpoint_seconds: 15, collect_app_activity: true, collect_idle_status: true, collect_web_domains: true, collect_file_metadata: true });
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
    if (!canEdit) {
      onToast("当前角色只能查看采集策略；请切换为老板后编辑");
      return;
    }
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

  const togglePolicy = (key) => {
    if (!canEdit) {
      onToast("当前角色只能查看采集策略；请切换为老板后编辑");
      return;
    }
    setPolicy((current) => ({ ...current, [key]: current[key] !== false ? false : true }));
  };

  return <SectionCard title="采集策略" description="统一控制应用、网页和文件元数据的采集范围"><div className="policy-grid"><PolicyItem icon={<Browser size={19} />} title="应用与窗口" detail="所有公司管理设备" enabled={policy.collect_app_activity !== false} onClick={() => togglePolicy("collect_app_activity")} /><PolicyItem icon={<Globe size={19} />} title="浏览器域名和标题" detail="去除查询参数和 Token" enabled={policy.collect_web_domains !== false} onClick={() => togglePolicy("collect_web_domains")} /><PolicyItem icon={<FileText size={19} />} title="文件元数据" detail="仅文件名、扩展名和脱敏路径" enabled={policy.collect_file_metadata !== false} onClick={() => togglePolicy("collect_file_metadata")} /><PolicyItem icon={<DeviceMobile size={19} />} title="截图、键盘和剪贴板" detail="系统级禁止，不能启用" enabled={false} onClick={() => onToast("隐私边界固定禁止截图、键盘和剪贴板采集")} /></div><div className="policy-time-settings"><div><strong>应用活动采集时间</strong><small>{allDay ? "全天运行，适合当前联调测试" : "只在工作时间内记录应用活动"}</small></div><label className="policy-checkbox"><input type="checkbox" checked={allDay} disabled={!canEdit} onChange={(event) => setAllDay(event.target.checked)} /><span>24 小时测试模式</span></label>{!allDay && <div className="policy-time-inputs"><label>开始<input type="time" disabled={!canEdit} value={policy.work_hours_start} onChange={(event) => setPolicy((current) => ({ ...current, work_hours_start: event.target.value }))} /></label><span>至</span><label>结束<input type="time" disabled={!canEdit} value={policy.work_hours_end} onChange={(event) => setPolicy((current) => ({ ...current, work_hours_end: event.target.value }))} /></label></div>}</div><div className="policy-time-settings"><div><strong>活动更新时间</strong><small>控制同一应用活动区间多久上传一次，越短越接近实时</small></div><label className="policy-time-inputs"><span>间隔</span><select disabled={!canEdit} value={policy.activity_checkpoint_seconds || 15} onChange={(event) => setPolicy((current) => ({ ...current, activity_checkpoint_seconds: Number(event.target.value) }))}><option value="15">15 秒</option><option value="30">30 秒</option><option value="60">60 秒</option></select></label></div>{error && <div className="error-box">策略保存失败：{error}</div>}<div className="policy-save-row"><small>{loading ? "正在读取服务端策略…" : agentApiEnabled ? `策略版本 v${policy.version || 1}` : "当前为演示模式，未连接服务端"}</small><button className="primary-button" disabled={loading || saving || !canEdit} onClick={save}>{saving ? "保存中…" : canEdit ? "保存采集策略" : "老板可编辑"}</button></div></SectionCard>;
}
function ExclusionPolicy({ role = "admin", onToast }) {
  const canEdit = role === "admin";
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
    if (!canEdit) {
      onToast("当前角色只能查看排除策略；请切换为老板后编辑");
      return;
    }
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

  return <SectionCard title="应用与网站排除" description="被排除的来源不会进入活动事件或 Memory Summary"><div className="exclusion-editor"><label>排除的进程（逗号分隔）<input disabled={!canEdit} value={policy.excluded_processes.join(", ")} placeholder="passwordmanager.exe, private.exe" onChange={(event) => updateList("excluded_processes", event.target.value)} /></label><label>排除的网站域名（逗号分隔）<input disabled={!canEdit} value={policy.excluded_domains.join(", ")} placeholder="bank.example.com, personal.example" onChange={(event) => updateList("excluded_domains", event.target.value)} /></label></div><small className="policy-hint">支持子域名匹配；只对保存后的新事件生效，不删除历史数据。</small>{error && <div className="error-box">排除策略保存失败：{error}</div>}<div className="policy-save-row"><small>{loading ? "正在读取服务端策略…" : agentApiEnabled ? `策略版本 v${policy.version || 1}` : "当前为演示模式，未连接服务端"}</small><button className="primary-button" disabled={loading || saving || !canEdit} onClick={save}>{saving ? "保存中…" : canEdit ? "保存排除策略" : "老板可编辑"}</button></div></SectionCard>;
}
function ExclusionRow({ name, type, enabled }) { return <div className="exclusion-row"><span className={`exclusion-switch ${enabled ? "on" : ""}`}><i /></span><span><strong>{name}</strong><small>{type}</small></span><button className="row-action"><ArrowSquareOut size={15} /></button></div>; }
function RetentionPolicy({ role = "admin", onToast }) {
  const canEdit = role === "admin";
  const defaultCutoff = shanghaiDateInput(90);
  const [cutoff, setCutoff] = useState(defaultCutoff);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const runPreview = async (apply = false) => {
    if (!canEdit) {
      onToast("当前角色只能查看留存策略；请切换为老板后执行");
      return;
    }
    if (!agentApiEnabled) {
      onToast("连接服务端后才能执行真实留存预览");
      return;
    }
    if (apply && !window.confirm("确认删除截止日期之前的活动事件和 Memory Summary？此操作不可恢复。")) return;
    setLoading(true);
    setError("");
    try {
      const result = await runRetention(new Date(`${cutoff}T00:00:00+08:00`).toISOString(), apply);
      setPreview(result);
      onToast(apply ? "留存删除已执行并写入审计" : "已生成留存删除预览");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };
  return <SectionCard title="数据保留策略" description="先预览，再由管理员确认删除；删除范围和结果会写入审计日志"><div className="retention-grid"><div><span>原始活动事件</span><strong>90 天</strong><small>到期自动删除</small></div><div><span>Leaf Summary</span><strong>1 年</strong><small>保留来源引用</small></div><div><span>Rollup Summary</span><strong>1 年</strong><small>保留来源引用</small></div></div><div className="policy-time-settings"><label>删除截止日期<input disabled={!canEdit} type="date" value={cutoff} onChange={(event) => setCutoff(event.target.value)} /></label><div className="policy-save-row"><button className="outline-button" disabled={loading || !cutoff || !canEdit} onClick={() => runPreview(false)}><Archive size={16} />预览删除范围</button><button className="primary-button" disabled={loading || !cutoff || !preview || !canEdit} onClick={() => runPreview(true)}>{loading ? "处理中…" : canEdit ? "确认执行删除" : "老板可执行"}</button></div></div>{error && <div className="error-box">留存操作失败：{error}</div>}{preview && <div className="deep-link-card"><Archive size={22} /><span><strong>{preview.applied ? "已执行删除" : "删除预览"}</strong><small>截止 {formatShanghaiTime(preview.before)} · 活动事件 {preview.applied ? preview.deleted.events : preview.preview.events} 条 · Memory Summary {preview.applied ? preview.deleted.memory_summaries : preview.preview.memory_summaries} 条</small></span></div>}</SectionCard>;
}

function AuditPage({ role, query, onToast }) {
  const [tab, setTab] = useState("访问日志");
  const [liveLogs, setLiveLogs] = useState(null);
  const [integrity, setIntegrity] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    getLiveAudit().then((logs) => {
      if (!cancelled) setLiveLogs(logs);
    }).catch((requestError) => {
      if (!cancelled) setError(requestError.message);
    });
    if (role === "admin") verifyLiveAuditIntegrity().then((result) => {
      if (!cancelled) setIntegrity(result);
    }).catch((requestError) => {
      if (!cancelled) setError(requestError.message);
    });
    return () => { cancelled = true; };
  }, [role]);
  const sourceLogs = liveLogs ?? (demoMode ? auditData : []);
  const logs = sourceLogs.filter((item) => !query.trim() || `${item.actor} ${item.action} ${item.target} ${item.result} ${item.detail || ""}`.toLowerCase().includes(query.toLowerCase()));
  const exportLogs = async () => {
    if (!agentApiEnabled) return onToast("连接服务端后才能导出真实审计日志");
    try {
      const result = await exportLiveAudit();
      const blob = new Blob([JSON.stringify(result.logs || [], null, 2)], { type: "application/json;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `ai-jinyiwei-audit-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      onToast(`已导出 ${result.logs?.length || 0} 条审计日志`);
      const refreshed = await getLiveAudit();
      setLiveLogs(refreshed);
    } catch (requestError) {
      setError(requestError.message);
    }
  };
  return <div className="page-content"><PageHeader eyebrow="AUDIT TRAIL" title="审计" description="记录历史访问、导出、权限策略和 Agent 上下线事件。" meta={agentApiEnabled ? `${logs.length} 条真实事件` : demoMode ? `${logs.length} 条演示事件` : "未连接服务端"} action={<button className="outline-button" onClick={() => void exportLogs()}><DownloadSimple size={17} />导出日志</button>} />{error && <div className="error-box">审计日志读取失败：{error}</div>}{role === "admin" && <SectionCard title="日志完整性" description="审计日志采用追加式哈希链；历史升级前的旧记录会标记为未加密校验"><div className="deep-link-card"><ShieldCheck size={22} /><span><strong>{integrity ? integrity.valid ? "哈希链校验通过" : "发现完整性异常" : "正在校验…"}</strong><small>{integrity ? `受保护 ${integrity.protected_entries} 条 · 历史旧记录 ${integrity.legacy_entries} 条${integrity.broken_entry_id ? ` · 异常记录 ${integrity.broken_entry_id}` : ""}` : "仅老板可执行完整性校验"}</small></span></div></SectionCard>}<Tabs tabs={["访问日志", "权限变更", "导出记录", "归档与删除", "Agent 事件"]} active={tab} onChange={setTab} /><SectionCard title={tab} description="所有操作均带有操作者、对象、时间和结果"><div className="audit-table"><div className="audit-row audit-head"><span>时间</span><span>操作者</span><span>动作</span><span>对象</span><span>结果</span><span /></div>{logs.length ? logs.map((item) => <div className="audit-row" key={item.id || `${item.time}-${item.actor}-${item.target}`}><span>{item.time}</span><span className="audit-actor">{item.actor}</span><span>{item.action}</span><span title={item.detail}>{item.target}</span><StatusPill status={item.result === "成功" || item.result === "允许" || item.result === "完成" || item.result === "已生效" ? "online" : item.result === "需关注" ? "attention" : "idle"} /><button className="row-action" onClick={() => onToast(item.detail || `${item.action} 详情`)}><ArrowSquareOut size={15} /></button></div>) : <div className="empty-state"><Database size={24} /><strong>暂无真实审计事件</strong><span>服务端产生注册、策略、Agent 上下线和留存操作后会显示在这里。</span></div>}</div></SectionCard></div>;
}

function SettingsPage({ role, onToast }) {
  const canEdit = role === "admin";
  const [tab, setTab] = useState(role === "employee" ? "安全合规" : "企业资料");
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState("");
  const tabs = role === "employee" ? ["安全合规"] : ["企业资料", "工作会话", "活动分类", "AI 设置", "通知", "数据与集成", "安全合规"];
  useEffect(() => { if (role === "employee") setTab("安全合规"); }, [role]);
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    getLiveAdminSettings().then(setSettings).catch((requestError) => setError(requestError.message));
    return undefined;
  }, []);
  const updateSettings = (patch) => setSettings((current) => ({ ...(current || {}), ...patch }));
  return <div className="page-content"><PageHeader eyebrow="ORGANIZATION SETTINGS" title="设置" description="管理企业资料、工作会话、活动分类、AI、通知和数据集成。" meta={roleLabel[role]} action={<span className="scope-pill">{agentApiEnabled ? settings ? "已连接服务端" : "正在读取…" : "演示模式"}</span>} />{error && <div className="error-box">设置读取失败：{error}</div>}<Tabs tabs={tabs} active={tab} onChange={setTab} />{tab === "企业资料" && <SettingsForm role={role} settings={settings?.organization} onChanged={(organization) => updateSettings({ organization })} onToast={onToast} />}{tab === "工作会话" && <PolicyEditor role={role} onToast={onToast} />}{tab === "活动分类" && <CategorySettings role={role} categories={settings?.categories} onChanged={(categories) => updateSettings({ categories })} onToast={onToast} />}{tab === "AI 设置" && <AiSettings role={role} settings={settings?.organization} onChanged={(organization) => updateSettings({ organization })} onToast={onToast} />}{tab === "通知" && <NotificationSettings role={role} notifications={settings?.notifications} onChanged={(notifications) => updateSettings({ notifications })} onToast={onToast} />}{tab === "数据与集成" && <IntegrationSettings role={role} integrations={settings?.integrations} onChanged={(integrations) => updateSettings({ integrations })} onToast={onToast} />}{tab === "安全合规" && <ComplianceSettings role={role} onToast={onToast} />}</div>;
}
function SettingsForm({ role = "admin", settings, onChanged, onToast }) {
  const canEdit = role === "admin";
  const [draft, setDraft] = useState({ company_name: "锦衣卫科技", default_language: settingsData.language, timezone: settingsData.timezone, retention: settingsData.retention });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (settings) setDraft((current) => ({ ...current, ...settings })); }, [settings]);
  const save = async () => {
    if (!canEdit) return onToast("当前角色只能查看企业资料；请切换为老板后保存");
    setSaving(true);
    try {
      const saved = agentApiEnabled ? await updateOrganizationSettings(draft) : draft;
      onChanged(saved);
      onToast("企业资料已保存并写入审计");
    } catch (error) { onToast(`企业资料保存失败：${error.message}`); } finally { setSaving(false); }
  };
  return <SectionCard title="企业资料" description="这些信息会出现在组织导航和 Memory Summary 权限范围中"><div className="settings-grid"><SettingField label="企业名称" value={draft.company_name} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, company_name: value }))} /><SettingField label="默认语言" value={draft.default_language} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, default_language: value }))} /><SettingField label="默认时区" value={draft.timezone} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, timezone: value }))} /><SettingField label="数据保留" value={draft.retention} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, retention: value }))} /></div><button className="outline-button" disabled={!canEdit || saving} onClick={() => void save()}><CheckCircle size={16} />{saving ? "保存中…" : canEdit ? "保存资料" : "老板可编辑"}</button></SectionCard>;
}
function AiSettings({ role = "admin", settings, onChanged, onToast }) {
  const canEdit = role === "admin";
  const [draft, setDraft] = useState({ ai_model: "qwen3.7-plus", ai_summary_interval_seconds: "600", ai_budget_per_minute: "30", ai_daily_request_limit: "0", ai_daily_budget_usd: "0" });
  const [usage, setUsage] = useState(null);
  const [usageError, setUsageError] = useState("");
  useEffect(() => { if (settings) setDraft((current) => ({ ...current, ...settings })); }, [settings]);
  useEffect(() => {
    if (!agentApiEnabled) return undefined;
    let cancelled = false;
    getLiveAiUsage(7).then((result) => { if (!cancelled) setUsage(result); }).catch((error) => { if (!cancelled) setUsageError(error.message); });
    return () => { cancelled = true; };
  }, []);
  const save = async () => {
    if (!canEdit) return onToast("当前角色只能查看 AI 设置；请切换为老板后保存");
    try { const saved = agentApiEnabled ? await updateOrganizationSettings(draft) : draft; onChanged(saved); onToast("AI 设置已保存；摘要仍按十分钟窗口生成"); } catch (error) { onToast(`AI 设置保存失败：${error.message}`); }
  };
  const totals = usage?.totals;
  return <><SectionCard title="AI 模型适配层" description="摘要和问答保留 Citations，并对活动元数据进行不可信数据隔离"><div className="settings-grid"><SettingField label="摘要语言" value="简体中文 / English" disabled /><SettingField label="默认模型" value={draft.ai_model} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, ai_model: value }))} /><SettingField label="摘要间隔（秒）" value={draft.ai_summary_interval_seconds} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, ai_summary_interval_seconds: value }))} /><SettingField label="调用预算 / 分钟" value={draft.ai_budget_per_minute} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, ai_budget_per_minute: value }))} /><SettingField label="每日请求上限（0=不限）" value={draft.ai_daily_request_limit} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, ai_daily_request_limit: value }))} /><SettingField label="每日费用上限 USD（0=不限）" value={draft.ai_daily_budget_usd} disabled={!canEdit} onChange={(value) => setDraft((current) => ({ ...current, ai_daily_budget_usd: value }))} /><SettingField label="原始内容读取" value="禁止" disabled /></div><button className="outline-button" disabled={!canEdit} onClick={() => void save()}><CheckCircle size={16} />{canEdit ? "保存 AI 设置" : "老板可编辑"}</button></SectionCard><SectionCard title="AI 用量与故障" description="最近 7 天的调用、Token、延迟和费用估算；不显示 Prompt 或活动正文"><div className="settings-grid"><SettingField label="调用次数" value={totals ? `${totals.calls}（成功 ${totals.succeeded}）` : usageError ? "读取失败" : "读取中…"} disabled /><SettingField label="Token 总量" value={totals ? String(totals.total_tokens) : "—"} disabled /><SettingField label="估算费用" value={totals ? `$${Number(totals.estimated_cost_usd || 0).toFixed(4)}` : "—"} disabled /><SettingField label="平均延迟" value={totals ? `${totals.average_latency_ms} ms` : "—"} disabled /></div>{usageError && <div className="error-box">AI 用量读取失败：{usageError}</div>}{usage && <div className="helper-text">窗口：最近 {usage.window_days} 天；当前每日额度：{usage.limits.daily_request_limit || "不限"} 次 / {usage.limits.daily_budget_usd ? `$${usage.limits.daily_budget_usd}` : "不限"}。</div>}</SectionCard></>;
}
function SettingField({ label, value, disabled = false, onChange }) { return <label className="setting-field"><span>{label}</span><input disabled={disabled} value={value ?? ""} onChange={(event) => onChange?.(event.target.value)} /></label>; }
function CategorySettings({ role = "admin", categories, onChanged, onToast }) {
  const canEdit = role === "admin";
  const fallback = [{ id: "work_project", color: "purple", label: "工作与项目", detail: "开发、文档、项目管理", enabled: true }, { id: "communication", color: "blue", label: "沟通与会议", detail: "企业微信、会议和邮件", enabled: true }, { id: "system_tools", color: "green", label: "系统与工具", detail: "登录、设置、故障和同步", enabled: true }, { id: "suspected_non_work", color: "amber", label: "疑似非工作", detail: "购物、娱乐、求职和游戏，需人工确认", enabled: true }, { id: "unknown", color: "gray", label: "未知", detail: "无法可靠分类的活动", enabled: true }];
  const [items, setItems] = useState(fallback);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (categories?.length) setItems(categories); }, [categories]);
  const updateItem = (id, key, value) => setItems((current) => current.map((item) => item.id === id ? { ...item, [key]: value } : item));
  const save = async () => {
    if (!canEdit) return onToast("当前角色只能查看分类；请切换为老板后保存");
    setSaving(true);
    try { const saved = agentApiEnabled ? await updateActivityCategories(items) : items; onChanged(saved); onToast("活动分类已保存并写入审计"); } catch (error) { onToast(`活动分类保存失败：${error.message}`); } finally { setSaving(false); }
  };
  return <SectionCard title="活动分类" description="分类用于摘要和趋势解释，不自动代表绩效结论"><div className="category-list">{items.map((item) => <div className="category-row" key={item.id}><span className={`category-dot ${item.color}`} /><span><input className="inline-setting-input" disabled={!canEdit} value={item.label} onChange={(event) => updateItem(item.id, "label", event.target.value)} /><small><input className="inline-setting-input detail" disabled={!canEdit} value={item.detail} onChange={(event) => updateItem(item.id, "detail", event.target.value)} /></small></span><button type="button" className="toggle-button" onClick={() => canEdit ? updateItem(item.id, "enabled", !item.enabled) : onToast("当前角色只能查看分类设置")}><span className={`toggle ${item.enabled ? "on" : ""}`}><i /></span></button></div>)}</div><button className="outline-button" disabled={!canEdit || saving} onClick={() => void save()}><CheckCircle size={16} />{saving ? "保存中…" : canEdit ? "保存分类" : "老板可编辑"}</button></SectionCard>;
}
function NotificationSettings({ role = "admin", notifications, onChanged, onToast }) {
  const canEdit = role === "admin";
  const fallback = [{ key: "agent_offline", label: "Agent 离线超过 30 分钟", enabled: true }, { key: "memory_summary_failed", label: "Memory Summary 生成失败", enabled: true }, { key: "coverage_low", label: "团队数据覆盖率低于 90%", enabled: true }, { key: "suspected_non_work", label: "疑似非工作活动", enabled: false }];
  const [values, setValues] = useState(fallback);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (notifications?.length) setValues(notifications); }, [notifications]);
  const toggle = (key) => { if (!canEdit) return onToast("当前角色只能查看通知设置；请切换为老板后编辑"); setValues((current) => current.map((item) => item.key === key ? { ...item, enabled: !item.enabled } : item)); };
  const save = async () => { if (!canEdit) return onToast("当前角色只能查看通知设置；请切换为老板后保存"); setSaving(true); try { const saved = agentApiEnabled ? await updateNotificationSettings(values.map(({ key, enabled }) => ({ key, enabled }))) : values; onChanged(saved); onToast("通知设置已保存并写入审计"); } catch (error) { onToast(`通知设置保存失败：${error.message}`); } finally { setSaving(false); } };
  return <SectionCard title="通知设置" description="只针对数据质量和协作问题发送通知"><div className="notification-list">{values.map((item) => <NotificationRow key={item.key} label={item.label} enabled={item.enabled} onToggle={() => toggle(item.key)} />)}</div><button className="outline-button" disabled={!canEdit || saving} onClick={() => void save()}><CheckCircle size={16} />{saving ? "保存中…" : canEdit ? "保存通知设置" : "老板可编辑"}</button></SectionCard>;
}
function NotificationRow({ label, enabled, onToggle }) { return <div className="notification-row"><span><strong>{label}</strong><small>{enabled ? "当前开启" : "当前关闭"}</small></span><button type="button" className="toggle-button" aria-label={`${label}：${enabled ? "关闭" : "开启"}`} onClick={onToggle}><span className={`toggle ${enabled ? "on" : ""}`}><i /></span></button></div>; }
function IntegrationSettings({ role = "admin", integrations, onChanged, onToast }) {
  const canEdit = role === "admin";
  const fallback = [{ key: "browser_extension", title: "浏览器扩展", detail: "Chrome / Edge 页面域名和标题", status: "connected", enabled: true }, { key: "project_tools", title: "项目管理工具", detail: "Jira、Linear、Trello", status: "disconnected", enabled: false }, { key: "collaboration", title: "协作工具", detail: "企业微信、飞书、Slack", status: "partial", enabled: true }, { key: "history_api", title: "History API", detail: "供企业内部系统查询记录", status: "preparing", enabled: false }];
  const [items, setItems] = useState(fallback);
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (integrations?.length) setItems(integrations); }, [integrations]);
  const toggle = (key) => { if (!canEdit) return onToast("当前角色只能查看集成设置；请切换为老板后编辑"); setItems((current) => current.map((item) => item.key === key ? { ...item, enabled: !item.enabled } : item)); };
  const save = async () => { if (!canEdit) return onToast("当前角色只能查看集成设置；请切换为老板后保存"); setSaving(true); try { const saved = agentApiEnabled ? await updateIntegrationSettings(items.map(({ key, enabled }) => ({ key, enabled }))) : items; onChanged(saved); onToast("数据集成设置已保存并写入审计"); } catch (error) { onToast(`数据集成保存失败：${error.message}`); } finally { setSaving(false); } };
  return <SectionCard title="数据与集成" description="第三方数据源默认关闭，启用前需要管理员授权"><div className="integration-grid">{items.map((item) => <IntegrationCard key={item.key} icon={item.key === "browser_extension" ? <Browser size={21} /> : item.key === "project_tools" ? <Code size={21} /> : item.key === "collaboration" ? <ChatCircleDots size={21} /> : <Database size={21} />} title={item.title} detail={item.detail} status={item.status} enabled={item.enabled} onClick={() => toggle(item.key)} />)}</div><button className="outline-button" disabled={!canEdit || saving} onClick={() => void save()}><CheckCircle size={16} />{saving ? "保存中…" : canEdit ? "保存集成设置" : "老板可编辑"}</button></SectionCard>;
}
function IntegrationCard({ icon, title, detail, status, enabled, onClick }) { const display = status === "connected" ? "已连接" : status === "partial" ? "部分连接" : status === "preparing" ? "准备中" : "未连接"; return <button className="integration-card" onClick={onClick}><span className="integration-icon">{icon}</span><span><strong>{title}</strong><small>{detail} · {enabled ? "已启用" : "已停用"}</small></span><StatusPill status={status === "connected" || enabled && status === "partial" ? "online" : status === "partial" ? "meeting" : "pending"} /><b>{display}</b></button>; }
function ComplianceSettings({ role = "admin", onToast }) {
  const canEdit = role === "admin";
  const [policy, setPolicy] = useState(null);
  const [draft, setDraft] = useState({ version: "", title: "", notice: "" });
  const [employees, setEmployees] = useState([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState("");
  const [rightsResult, setRightsResult] = useState(null);
  const [rightsLoading, setRightsLoading] = useState(false);
  const [loading, setLoading] = useState(Boolean(agentApiEnabled));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = async () => {
    if (!agentApiEnabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const result = await getLivePrivacyPolicy();
      setPolicy(result);
      if (result.policy) setDraft({ version: result.policy.version, title: result.policy.title, notice: result.policy.notice });
      try {
        const directory = await getLiveEmployees();
        setEmployees(directory);
        setSelectedEmployeeId((current) => current || directory[0]?.id || result.acknowledgements?.[0]?.employee_id || "");
      } catch {
        setEmployees((result.acknowledgements || []).map((item) => ({ id: item.employee_id, name: item.employee_name, team: item.team })));
        setSelectedEmployeeId((current) => current || result.acknowledgements?.[0]?.employee_id || "");
      }
      setError("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const save = async () => {
    if (!canEdit) return onToast("当前角色只能查看隐私政策；请由老板编辑");
    setSaving(true);
    try {
      const result = agentApiEnabled ? await updateLivePrivacyPolicy(draft) : { policy: draft, acknowledgements: policy?.acknowledgements || [] };
      setPolicy(result);
      onToast("隐私政策已保存；员工需要重新确认新版本");
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setSaving(false);
    }
  };
  const acknowledgements = policy?.acknowledgements || [];
  const acknowledgedCount = acknowledgements.filter((item) => item.acknowledged).length;
  const rightsEmployees = employees.length ? employees : acknowledgements.map((item) => ({ id: item.employee_id, name: item.employee_name, team: item.team }));
  const selectedEmployee = rightsEmployees.find((item) => item.id === selectedEmployeeId);
  const runSubjectExport = async () => {
    if (!agentApiEnabled) return onToast("连接真实服务端后才能导出员工数据");
    if (!selectedEmployeeId) return onToast("请选择员工");
    setRightsLoading(true);
    try {
      const result = await exportLivePrivacySubject(selectedEmployeeId);
      const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json;charset=utf-8" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `ai-jinyiwei-privacy-export-${selectedEmployeeId}-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      onToast(`已导出 ${selectedEmployee?.name || "员工"} 的数据，并写入审计`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setRightsLoading(false);
    }
  };
  const runSubjectDelete = async (apply = false) => {
    if (!agentApiEnabled) return onToast("连接真实服务端后才能执行员工数据删除");
    if (!selectedEmployeeId) return onToast("请选择员工");
    if (apply && !window.confirm(`确认删除 ${selectedEmployee?.name || "该员工"} 的活动事件、Memory Summary 和浏览器临时凭据？员工身份、设备身份、审计日志和隐私确认记录会保留。`)) return;
    setRightsLoading(true);
    try {
      const result = await deleteLivePrivacySubject(selectedEmployeeId, apply);
      setRightsResult(result);
      onToast(apply ? "员工活动数据已删除并写入审计" : "已生成员工数据删除预览");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setRightsLoading(false);
    }
  };
  return <div className="compliance-stack">
    <SectionCard title="员工采集告知" description="政策版本和员工确认状态由服务端保存，并在 Agent 上传前校验。">
      {error && <div className="error-box">隐私政策读取失败：{error}</div>}
      <div className="privacy-policy-meta"><StatusPill status={policy?.policy ? "success" : "pending"} /><span>当前版本：{loading ? "读取中…" : policy?.policy?.version || "未配置"}</span><span>{acknowledgedCount}/{acknowledgements.length || 0} 位员工已确认</span></div>
      <div className="settings-grid"><SettingField label="政策版本" value={draft.version} disabled={!canEdit || loading} onChange={(value) => setDraft((current) => ({ ...current, version: value }))} /><SettingField label="政策标题" value={draft.title} disabled={!canEdit || loading} onChange={(value) => setDraft((current) => ({ ...current, title: value }))} /></div>
      <label className="setting-field privacy-notice-field"><span>员工看到的采集说明</span><textarea disabled={!canEdit || loading} value={draft.notice} onChange={(event) => setDraft((current) => ({ ...current, notice: event.target.value }))} rows="5" /></label>
      <div className="policy-save-row"><small>{canEdit ? "修改版本或正文后，所有员工需重新确认。" : "当前角色无权修改政策。"}</small><button className="primary-button" disabled={!canEdit || loading || saving} onClick={() => void save()}>{saving ? "保存中…" : "保存并发布政策"}</button></div>
    </SectionCard>
    {role !== "employee" && <SectionCard title="员工确认台账" description="只显示确认状态、版本和时间，不显示员工采集内容。">
      <div className="compliance-list">{acknowledgements.length ? acknowledgements.map((item) => <div className="compliance-row" key={item.employee_id}><ShieldCheck size={19} /><span><strong>{item.employee_name} · {item.team}</strong><small>{item.acknowledged ? `已确认 ${formatShanghaiTime(item.acknowledged_at, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}` : "尚未确认当前政策"}</small></span><StatusPill status={item.acknowledged ? "success" : "pending"} /></div>) : <EmptyState title={agentApiEnabled ? "暂无员工台账" : "连接服务端后显示员工确认状态"} />}</div>
    </SectionCard>}
    <SectionCard title="员工数据权利" description="按权限导出或删除指定员工的活动元数据；删除前必须预览，身份、设备、审计和隐私确认记录会保留。">
      {!agentApiEnabled && <div className="mfa-note">连接真实服务端后可执行员工数据导出和删除。</div>}
      {agentApiEnabled && <>
        <div className="settings-grid"><label className="setting-field"><span>员工</span><select value={selectedEmployeeId} onChange={(event) => { setSelectedEmployeeId(event.target.value); setRightsResult(null); }} disabled={rightsLoading || !rightsEmployees.length}><option value="">请选择员工</option>{rightsEmployees.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.team}</option>)}</select></label><div className="mfa-note"><strong>删除范围</strong><br />活动事件、Memory Summary、生成队列和浏览器临时凭据；不删除法律留存所需的审计与确认记录。</div></div>
        <div className="policy-save-row"><div className="mfa-action-row"><button className="outline-button" disabled={rightsLoading || !selectedEmployeeId} onClick={() => void runSubjectExport()}><DownloadSimple size={16} />导出员工数据</button><button className="outline-button" disabled={rightsLoading || !selectedEmployeeId} onClick={() => void runSubjectDelete(false)}><Archive size={16} />预览删除范围</button><button className="primary-button" disabled={rightsLoading || !selectedEmployeeId || !rightsResult?.preview} onClick={() => void runSubjectDelete(true)}>{rightsLoading ? "处理中…" : "确认删除活动数据"}</button></div></div>
        {rightsResult && <div className="deep-link-card"><Archive size={22} /><span><strong>{rightsResult.applied ? "员工数据删除已完成" : "员工数据删除预览"}</strong><small>{rightsResult.applied ? `已删除活动事件 ${rightsResult.deleted.events} 条、Memory Summary ${rightsResult.deleted.memory_summaries} 条；保留隐私确认 ${rightsResult.preserved.privacy_acknowledgements} 条。` : `将删除活动事件 ${rightsResult.preview.events} 条、Memory Summary ${rightsResult.preview.memory_summaries} 条、生成任务 ${rightsResult.preview.generation_jobs} 条。`}</small></span></div>}
      </>}
    </SectionCard>
    <SectionCard title="固定隐私边界" description="以下能力不提供开关，避免把合规边界变成可误操作的设置."><div className="compliance-list"><ComplianceRow icon={<LockKey size={19} />} title="敏感资源排除" detail="键盘、剪贴板、截图、聊天正文和文件正文禁止采集" onToast={onToast} /><ComplianceRow icon={<Fingerprint size={19} />} title="访问审计" detail="个人时间线、导出和策略修改均写入审计日志" onToast={onToast} /><ComplianceRow icon={<Archive size={19} />} title="数据删除策略" detail="删除前预览，执行结果写入审计" onToast={onToast} /></div></SectionCard>
  </div>;
}
function ComplianceRow({ icon, title, detail, onToast }) { return <button type="button" className="compliance-row" onClick={() => onToast(`${title}说明已打开`)}>{icon}<span><strong>{title}</strong><small>{detail}</small></span><CheckCircle size={17} weight="fill" /></button>; }
function EmptyState({ title }) { return <div className="empty-state"><Database size={24} /><strong>{title}</strong><span>接入真实数据后会显示在这里。</span></div>; }

export { roleLabel };

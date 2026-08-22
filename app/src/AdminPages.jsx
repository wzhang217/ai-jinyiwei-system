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
  UserCircle,
  UsersThree,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { historyRecords } from "./data.js";
import { askHistory, downloadRecordMarkdown, getRecordStats } from "./services/historyService.js";
import { agentApiEnabled, getLiveDevices } from "./services/agentApi.js";
import { auditData, deviceData, employeeData, permissionRoles, settingsData, teamData } from "./adminData.js";

const roleLabel = { admin: "企业管理员", manager: "直属管理者", employee: "员工", auditor: "审计员" };

export function AdminPage({ page, role, query, target, onNavigate, onToast }) {
  switch (page) {
    case "overview": return <OverviewPage role={role} onNavigate={onNavigate} onToast={onToast} />;
    case "teams": return <TeamsPage role={role} target={target} onNavigate={onNavigate} onToast={onToast} />;
    case "employees": return <EmployeesPage role={role} query={query} target={target} onNavigate={onNavigate} onToast={onToast} />;
    case "memory": return <MemoryPage role={role} query={query} target={target} onNavigate={onNavigate} onToast={onToast} />;
    case "skill": return <SkillPage role={role} onNavigate={onNavigate} />;
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
  const config = { online: ["在线", "online"], active: ["工作中", "online"], idle: ["空闲", "idle"], offline: ["离线", "offline"], meeting: ["会议中", "meeting"], locked: ["已锁定", "offline"], generated: ["已生成", "online"], generating: ["生成中", "meeting"], pending: ["待补全", "idle"], failed: ["失败", "offline"], allow: ["允许", "online"], success: ["成功", "online"], attention: ["需关注", "idle"] }[status] || [status, "idle"];
  return <span className={`status-pill ${config[1]}`}><span />{config[0]}</span>;
}

function MiniBars({ values, labels }) {
  return <div className="mini-bars">{values.map((value, index) => <div className="mini-bar-group" key={`${value}-${index}`}><div className="mini-bar-track"><span style={{ height: `${value}%` }} /></div><small>{labels[index]}</small></div>)}</div>;
}

function OverviewPage({ role, onNavigate, onToast }) {
  const [tab, setTab] = useState("今日态势");
  const canSeeManagement = role !== "employee";
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
            { label: "活动覆盖率", value: role === "employee" ? "98%" : "94.8%", detail: role === "employee" ? "过去 24 小时" : "+3.2% 较昨日", icon: <Pulse size={20} />, good: true },
            { label: "当前在线设备", value: role === "employee" ? "1 / 1" : "20 / 26", detail: role === "employee" ? "WIN-WEI-01 在线" : "3 台需要关注", icon: <Monitor size={20} />, tone: "blue" },
            { label: "Memory Summary", value: role === "employee" ? "3" : "87", detail: role === "employee" ? "2 条 Leaf · 1 条 Rollup" : "已生成 91%，待补全 8 条", icon: <Sparkle size={20} />, tone: "gold" },
            { label: "会议活动", value: role === "employee" ? "14.2%" : "18.4%", detail: role === "employee" ? "最近 7 天" : "较上周下降 2.1%", icon: <UsersThree size={20} />, tone: "green", good: true },
          ]} />
          {role === "employee" ? <div className="two-column-grid">
            <SectionCard title="我的连续工作主题" description="只显示属于自己的 Memory Summary 上下文">
              <div className="summary-list">
                <button className="summary-row" onClick={() => onNavigate("memory", "memory-ai-0822-0840")}><span className="summary-icon"><Sparkle size={17} weight="fill" /></span><span><strong>AI锦衣卫产品规划</strong><small>Rollup · 6h · 研发与产品中心</small></span><ArrowSquareOut size={15} /></button>
                <button className="summary-row" onClick={() => onNavigate("history", "memory-ai-0822-0840")}><span className="summary-icon"><Clock size={17} /></span><span><strong>任务详情与历史系统梳理</strong><small>Leaf · 10min · 3 个应用</small></span><ArrowSquareOut size={15} /></button>
              </div>
            </SectionCard>
            <SectionCard title="我的最近记录" description="可补充说明的上下文会在详情中标记">
              <div className="summary-list">
                {historyRecords.slice(0, 2).map((record) => <button className="summary-row" key={record.id} onClick={() => onNavigate("memory", record.id)}><span className="summary-icon"><Sparkle size={17} weight="fill" /></span><span><strong>{record.title}</strong><small>{record.duration} · 置信度 {Math.round(record.confidence * 100)}%</small></span><ArrowSquareOut size={15} /></button>)}
              </div>
            </SectionCard>
          </div> : <div className="two-column-grid">
            <SectionCard title="团队工作主题" description="根据近期 Rollup Summary 整理" action={<button className="text-button" onClick={() => onNavigate("teams")}>查看全部 <ArrowSquareOut size={14} /></button>}>
              <div className="team-theme-list">
                {teamData.map((team) => (
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
                {historyRecords.filter((record) => record.recordType === "rollup").map((record) => (
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
            { label: "本周工作主题", value: "24", detail: "较上周 +5 个", icon: <Sparkle size={20} />, good: true },
            { label: "平均连续工作窗口", value: "74m", detail: "较上周 +8 分钟", icon: <Clock size={20} />, tone: "blue", good: true },
            { label: "应用切换密度", value: "8.6 / h", detail: "研发团队最高", icon: <Lightning size={20} />, tone: "gold" },
            { label: "未知活动比例", value: "4.2%", detail: "在目标范围内", icon: <WarningCircle size={20} />, tone: "green", good: true },
          ]} />
          <SectionCard title="活动趋势" description="过去 7 天的组织级活动构成">
            <MiniBars values={[58, 70, 64, 83, 76, 91, 78]} labels={["周一", "周二", "周三", "周四", "周五", "周六", "今天"]} />
            <div className="chart-legend"><span><i className="legend-dot purple" />工作活动</span><span><i className="legend-dot gray" />会议与沟通</span><span><i className="legend-dot amber" />未知活动</span></div>
          </SectionCard>
        </>
      )}
      {tab === "需要关注" && (
        <SectionCard title="需要关注" description="只展示工作负载、数据质量和疑似非工作活动，不作为自动绩效判断">
          <div className="attention-list">
            {canSeeManagement ? <>
              <AttentionRow tone="amber" title="Ming 的浏览器扩展待更新" detail="可能导致网页页面标题采集不完整 · 7 分钟前" action="查看设备" onClick={() => onNavigate("devices")} />
              <AttentionRow tone="purple" title="研发与产品中心周四下午任务切换较密集" detail="可能与任务详情验证和客户沟通有关 · 置信度 0.76" action="查看团队" onClick={() => onNavigate("teams")} />
              <AttentionRow tone="red" title="Ming 出现一段疑似非工作网站活动" detail="持续约 18 分钟 · 需要人工确认上下文，不自动定性" action="查看记录" onClick={() => onNavigate("employees")} />
            </> : <>
              <AttentionRow tone="amber" title="我的浏览器扩展待更新" detail="可能导致网页页面标题采集不完整 · 7 分钟前" action="查看设备" onClick={() => onNavigate("devices")} />
              <AttentionRow tone="purple" title="我的工作上下文有一段记录需要补充说明" detail="系统无法仅凭应用和网页元数据判断原因 · 可在详情中补充" action="查看历史" onClick={() => onNavigate("history")} />
            </>}
          </div>
        </SectionCard>
      )}
      {tab === "数据健康" && (
        <SectionCard title="数据健康" description="采集、摘要和权限链路的当前状态">
          <div className="health-grid">
            <HealthRow title="Windows Agent 在线率" value="96.2%" detail="25 / 26 台设备" status="online" />
            <HealthRow title="Memory Summary 生成队列" value="8 条" detail="预计 4 分钟内完成" status="generating" />
            <HealthRow title="Citations 完整度" value="98.4%" detail="过去 24 小时" status="online" />
            <HealthRow title="权限同步" value="正常" detail="最近同步 2 分钟前" status="online" />
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

function TeamsPage({ role, target, onNavigate, onToast }) {
  const [tab, setTab] = useState("团队列表");
  const visibleTeams = role === "manager" ? teamData.filter((team) => team.id === "team-product-dev") : teamData;
  const [selectedTeam, setSelectedTeam] = useState(() => visibleTeams.find((team) => team.id === target) || visibleTeams[0]);
  const [skillQuestion, setSkillQuestion] = useState("");
  const [skillAnswer, setSkillAnswer] = useState(null);
  const tabs = ["团队列表", "团队详情", "团队趋势", "工作主题", "团队 Skill"];
  const openTeam = (team) => { setSelectedTeam(team); setTab("团队详情"); };
  useEffect(() => {
    const nextTeam = visibleTeams.find((team) => team.id === target);
    if (nextTeam) {
      setSelectedTeam(nextTeam);
      setTab("团队详情");
    }
  }, [target, role]);
  return <div className="page-content"><PageHeader eyebrow="TEAM WORKSPACE" title="团队" description="以团队为单位查看工作主题、活动覆盖和 Memory Summary。" meta={`${visibleTeams.length} 个团队`} action={<button className="outline-button" onClick={() => onToast("创建团队需要连接组织目录 API")}><Plus size={17} />新建团队</button>} /><Tabs tabs={tabs} active={tab} onChange={setTab} />{tab === "团队列表" && <SectionCard title="团队列表" description="点击团队进入成员、趋势和工作主题详情"><div className="team-grid">{visibleTeams.map((team) => <button className="team-card" key={team.id} onClick={() => openTeam(team)}><div className="team-card-top"><span className="team-avatar">{team.name.slice(0, 1)}</span><span className="team-card-arrow"><ArrowSquareOut size={16} /></span></div><h3>{team.name}</h3><p>{team.focus}</p><div className="team-card-meta"><span><UsersThree size={14} />{team.members} 人</span><span><Pulse size={14} />{team.coverage}% 覆盖</span></div><div className="team-card-progress"><span style={{ width: `${team.coverage}%` }} /></div><small>负责人：{team.lead}</small></button>)}</div></SectionCard>}{tab === "团队详情" && <TeamDetail team={selectedTeam} onNavigate={onNavigate} onToast={onToast} />}{tab === "团队趋势" && <><KpiGrid items={[{ label: "平均活跃覆盖", value: `${selectedTeam.coverage}%`, detail: "较上周 +2.4%", icon: <Pulse size={20} />, good: true }, { label: "连续工作窗口", value: "68m", detail: "团队中位数", icon: <Clock size={20} />, tone: "blue" }, { label: "会议负载", value: "16.8%", detail: "低于组织平均", icon: <UsersThree size={20} />, tone: "green", good: true }, { label: "切换密度", value: "7.9 / h", detail: "需要结合任务判断", icon: <Lightning size={20} />, tone: "gold" }]} /><SectionCard title={`${selectedTeam.name} 活动趋势`} description="过去 7 天"><MiniBars values={[55, 62, 76, 69, 88, 74, 92]} labels={["周一", "周二", "周三", "周四", "周五", "周六", "今天"]} /></SectionCard></>}{tab === "工作主题" && <SectionCard title="连续工作主题" description="由团队 Rollup Summary 聚合"><div className="topic-list"><TopicRow rank="01" title={selectedTeam.focus} detail="9 条 Memory Summary · 4 位成员" value="42%" /><TopicRow rank="02" title="任务详情与结果验证" detail="6 条 Memory Summary · 3 位成员" value="26%" /><TopicRow rank="03" title="接口联调与问题排查" detail="5 条 Memory Summary · 4 位成员" value="18%" /><TopicRow rank="04" title="团队沟通与会议" detail="4 条 Memory Summary · 7 位成员" value="14%" /></div></SectionCard>}{tab === "团队 Skill" && <SectionCard title="团队 History Skill" description={`当前查询范围：${selectedTeam.name}`}><form className="team-skill-form" onSubmit={(event) => { event.preventDefault(); if (skillQuestion.trim()) setSkillAnswer(askHistory(skillQuestion, historyRecords)); }}><ChatCircleDots size={20} /><input value={skillQuestion} onChange={(event) => setSkillQuestion(event.target.value)} placeholder="询问这个团队最近的工作主题..." /><button className="primary-button" type="submit"><PaperPlaneTilt size={16} />提问</button></form>{skillAnswer ? <SkillAnswer result={skillAnswer} onOpen={() => onNavigate("history")} /> : <div className="question-grid"><button onClick={() => setSkillQuestion("这个团队本周主要在做什么？")}>这个团队本周主要在做什么？</button><button onClick={() => setSkillQuestion("团队是否存在频繁任务切换？")}>团队是否存在频繁任务切换？</button></div>}</SectionCard>}</div>;
}

function TeamDetail({ team, onNavigate, onToast }) {
  const members = employeeData.filter((employee) => employee.team.includes(team.name.replace("中心", "")) || employee.team === team.name);
  return <><SectionCard title={team.name} description={`${team.focus} · 负责人 ${team.lead}`} action={<button className="outline-button" onClick={() => onToast("团队设置将在组织目录接入后开放")}><GearSix size={16} />团队设置</button>}><div className="detail-summary-grid"><div><span>成员</span><strong>{team.members}</strong><small>活跃 {team.activeMembers} 人</small></div><div><span>采集覆盖</span><strong>{team.coverage}%</strong><small>过去 24 小时</small></div><div><span>主要工具</span><strong>{team.apps.length}</strong><small>{team.apps.slice(0, 2).join("、")}</small></div><div><span>当前主题</span><strong>4 个</strong><small>已关联 Memory Summary</small></div></div></SectionCard><div className="two-column-grid"><SectionCard title="团队成员" description="点击成员查看个人活动"><div className="compact-list">{members.length ? members.map((employee) => <button className="compact-row" key={employee.id} onClick={() => onNavigate("employees", employee.id)}><span className="person-avatar">{employee.name.slice(0, 1)}</span><span><strong>{employee.name}</strong><small>{employee.title} · {employee.focus}</small></span><StatusPill status={employee.status} /><ArrowSquareOut size={15} /></button>) : <EmptyState title="暂无成员数据" />}</div></SectionCard><SectionCard title="团队 Memory Summary" description="最近生成的团队级记录"><div className="summary-list"><button className="summary-row" onClick={() => onNavigate("memory")}><span className="summary-icon"><Sparkle size={17} weight="fill" /></span><span><strong>{team.focus} — 本周汇总</strong><small>Rollup · 6h · 4 个下层记录</small></span><ArrowSquareOut size={15} /></button><button className="summary-row" onClick={() => onNavigate("memory")}><span className="summary-icon"><Sparkle size={17} weight="fill" /></span><span><strong>团队协作上下文变化</strong><small>Rollup · 1d · 8 个来源</small></span><ArrowSquareOut size={15} /></button></div></SectionCard></div></>;
}

function TopicRow({ rank, title, detail, value }) {
  return <div className="topic-row"><span className="topic-rank">{rank}</span><span><strong>{title}</strong><small>{detail}</small></span><span className="topic-track"><span style={{ width: value }} /></span><b>{value}</b></div>;
}

function EmployeesPage({ role, query, target, onNavigate, onToast }) {
  const [tab, setTab] = useState("员工目录");
  const visibleEmployees = role === "manager" ? employeeData.filter((employee) => employee.team === "研发与产品中心") : employeeData;
  const [selected, setSelected] = useState(() => visibleEmployees.find((employee) => employee.id === target) || visibleEmployees[0]);
  const search = query.trim().toLowerCase();
  const employees = visibleEmployees.filter((employee) => !search || `${employee.name} ${employee.title} ${employee.team} ${employee.focus}`.toLowerCase().includes(search));
  useEffect(() => {
    const nextEmployee = visibleEmployees.find((employee) => employee.id === target);
    if (nextEmployee) {
      setSelected(nextEmployee);
      setTab("个人概览");
    }
  }, [target, role]);
  return <div className="page-content"><PageHeader eyebrow="PEOPLE DIRECTORY" title={role === "employee" ? "我的工作状态" : "员工"} description={role === "employee" ? "查看自己的历史记录、设备状态和隐私说明。" : "以个人为单位查看工作上下文和可授权的历史记录。"} meta={`${employees.length} 位成员`} action={<button className="outline-button" onClick={() => onToast("员工目录将通过组织目录 API 同步")}><UsersThree size={17} />同步成员</button>} /><Tabs tabs={["员工目录", "个人概览", "历史记录", "Memory Summary", "工作模式", "设备"]} active={tab} onChange={setTab} />{tab === "员工目录" && <SectionCard title="员工目录" description="所有员工使用统一采集规则，查看范围由组织关系决定"><div className="table-toolbar"><span className="table-count">{employees.length} 位成员</span><span className="table-hint"><MagnifyingGlass size={15} />左侧搜索可筛选姓名、团队和工作主题</span></div><div className="data-table"><div className="table-row table-head"><span>成员</span><span>团队与职位</span><span>当前主题</span><span>覆盖率</span><span>状态</span><span /></div>{employees.map((employee) => <button className="table-row" key={employee.id} onClick={() => { setSelected(employee); setTab("个人概览"); }}><span className="table-person"><span className="person-avatar">{employee.name.slice(0, 1)}</span><strong>{employee.name}</strong></span><span><strong>{employee.team}</strong><small>{employee.title}</small></span><span>{employee.focus}</span><span className="coverage-value">{employee.coverage}%</span><span><StatusPill status={employee.status} /></span><ArrowSquareOut size={16} /></button>)}</div></SectionCard>}{tab === "个人概览" && <EmployeeDetail employee={selected} onNavigate={onNavigate} onToast={onToast} />}{tab === "历史记录" && <SectionCard title={`${selected.name} 的历史记录`} description="个人时间线下钻入口"><div className="deep-link-card"><Sparkle size={24} /><span><strong>打开个人 Memory Summary 时间线</strong><small>按日期、Leaf/Rollup、应用和资源筛选</small></span><button className="primary-button" onClick={() => onNavigate("history")}><ArrowSquareOut size={16} />打开历史记录</button></div></SectionCard>}{tab === "Memory Summary" && <SectionCard title={`${selected.name} 的 Memory Summary`} description="管理个人记忆文档"><MemoryRows records={historyRecords.slice(0, 2)} onOpen={() => onNavigate("memory")} onExport={() => onToast("已开始导出个人 Memory Summary")} /></SectionCard>}{tab === "工作模式" && <WorkPattern employee={selected} />}{tab === "设备" && <SectionCard title={`${selected.name} 的设备`} description="当前设备与采集状态"><DeviceRow device={deviceData.find((device) => device.user === selected.name) || deviceData[0]} onToast={onToast} /></SectionCard>}</div>;
}

function EmployeeDetail({ employee, onNavigate, onToast }) {
  return <><SectionCard title={employee.name} description={`${employee.title} · ${employee.team}`} action={<button className="outline-button" onClick={() => onToast("个人权限详情已打开")}><LockKey size={16} />查看权限</button>}><div className="profile-summary"><span className="profile-avatar">{employee.name.slice(0, 1)}</span><div><strong>{employee.name}</strong><small>直属管理者：{employee.manager}</small><small>设备：{employee.device}</small></div><div className="profile-status"><StatusPill status={employee.status} /><span>覆盖率 {employee.coverage}%</span></div></div></SectionCard><div className="two-column-grid"><SectionCard title="个人活动概览" description="最近工作窗口"><KpiGrid items={[{ label: "活跃覆盖", value: `${employee.coverage}%`, detail: "过去 24 小时", icon: <Pulse size={19} />, good: true }, { label: "主要主题", value: "4 个", detail: employee.focus, icon: <Sparkle size={19} />, tone: "gold" }, { label: "连续窗口", value: "68m", detail: "个人中位数", icon: <Clock size={19} />, tone: "blue" }, { label: "需要说明", value: "1 条", detail: "等待员工补充", icon: <WarningCircle size={19} />, tone: "green" }]} /></SectionCard><SectionCard title="快速下钻" description="从个人概览进入原始历史和记忆文档"><div className="quick-link-list"><button onClick={() => onNavigate("history")}><ListBullets size={18} /><span><strong>历史时间线</strong><small>查看按日期组织的活动记录</small></span><ArrowSquareOut size={15} /></button><button onClick={() => onNavigate("memory")}><Sparkle size={18} /><span><strong>Memory Summary</strong><small>查看 Leaf、Rollup 和来源关系</small></span><ArrowSquareOut size={15} /></button></div></SectionCard></div></>;
}

function WorkPattern({ employee }) {
  return <SectionCard title={`${employee.name} 的工作模式`} description="趋势用于辅助理解上下文，不单独作为绩效结论"><div className="pattern-grid"><div className="pattern-card"><span>工作主题集中度</span><strong>82%</strong><small>最近 7 天</small></div><div className="pattern-card"><span>任务切换密度</span><strong>6.8 / h</strong><small>接近团队平均</small></div><div className="pattern-card"><span>会议时间</span><strong>14.2%</strong><small>低于组织平均</small></div><div className="pattern-card"><span>未知活动</span><strong>3.4%</strong><small>在目标范围内</small></div></div><MiniBars values={[62, 72, 60, 80, 76, 88, 82]} labels={["周一", "周二", "周三", "周四", "周五", "周六", "今天"]} /></SectionCard>;
}

function MemoryPage({ role, query, target, onNavigate, onToast }) {
  const [tab, setTab] = useState("全部记录");
  const [selected, setSelected] = useState(null);
  const records = historyRecords.filter((record) => tab === "全部记录" || (tab === "Leaf" ? record.recordType === "leaf" : tab === "Rollup" ? record.recordType === "rollup" : tab === "待生成" ? false : true)).filter((record) => !query.trim() || `${record.title} ${record.description} ${record.summary}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    const nextRecord = historyRecords.find((record) => record.id === target);
    if (nextRecord) setSelected(nextRecord);
  }, [target]);
  return <div className="page-content"><PageHeader eyebrow="MEMORY DOCUMENTS" title="Memory Summary" description="管理按工作主题生成的记忆文档、层级关系和来源引用。" meta={`${records.length} 条可见记录`} action={<button className="outline-button" onClick={() => onToast("Memory Summary 导出任务已创建")}><DownloadSimple size={17} />批量导出</button>} /><Tabs tabs={["全部记录", "Leaf", "Rollup", "待生成", "来源关系", "导出"]} active={tab} onChange={setTab} />{["全部记录", "Leaf", "Rollup"].includes(tab) && <SectionCard title={`${tab} Memory Summary`} description="数据库为权威数据源，Markdown 是标准化导出格式"><MemoryRows records={records} onOpen={(record) => setSelected(record)} onExport={(record) => { downloadRecordMarkdown(record); onToast("已导出 Memory Summary Markdown"); }} /></SectionCard>}{tab === "待生成" && <SectionCard title="摘要生成队列" description="当前没有失败任务，仍有少量记录等待生成"><div className="queue-card"><span className="queue-icon"><Sparkle size={20} weight="fill" /></span><span><strong>8 条活动窗口等待生成 Rollup Summary</strong><small>预计 4 分钟内完成 · 生成完成后会自动加入历史记录</small></span><StatusPill status="generating" /></div><div className="queue-card"><span className="queue-icon gold"><WarningCircle size={20} weight="fill" /></span><span><strong>1 条记录缺少完整 Citations</strong><small>来源文件路径需要重新脱敏</small></span><StatusPill status="pending" /></div></SectionCard>}{tab === "来源关系" && <SectionCard title="来源关系" description="从 Rollup Summary 回溯到 Leaf Summary 和原始事件"><div className="source-graph"><div className="source-node root"><Sparkle size={18} /><span><strong>AI锦衣卫 product planning</strong><small>Rollup · 6h</small></span></div><div className="graph-connector" /><div className="source-children"><div className="source-node"><Clock size={17} /><span><strong>Memory Summary window</strong><small>Leaf · 10min</small></span></div><div className="source-node"><FileText size={17} /><span><strong>Computer History 参考记录</strong><small>引用来源</small></span></div><div className="source-node"><Code size={17} /><span><strong>AI锦衣卫 v2 plan</strong><small>项目文件</small></span></div></div></div></SectionCard>}{tab === "导出" && <SectionCard title="导出中心" description="按权限导出 Memory Summary，不包含受保护的原始正文"><div className="export-list"><div><span><DownloadSimple size={19} /><strong>本周 Memory Summary</strong><small>26 条记录 · Markdown</small></span><button className="outline-button" onClick={() => onToast("已开始导出本周记录")}>导出</button></div><div><span><DownloadSimple size={19} /><strong>研发与产品中心 Rollup</strong><small>8 条记录 · Markdown</small></span><button className="outline-button" onClick={() => onToast("已开始导出团队汇总")}>导出</button></div></div></SectionCard>}{selected && <MemoryDrawer record={selected} onClose={() => setSelected(null)} onExport={() => { downloadRecordMarkdown(selected); onToast("已导出 Memory Summary Markdown"); }} onNavigate={onNavigate} />}</div>;
}

function MemoryRows({ records, onOpen, onExport }) {
  return <div className="memory-table"><div className="memory-row memory-head"><span>记录</span><span>类型</span><span>来源</span><span>状态</span><span /></div>{records.length ? records.map((record) => <div className="memory-row" key={record.id}><button className="memory-title" onClick={() => onOpen(record)}><span className="summary-icon"><Sparkle size={16} weight="fill" /></span><span><strong>{record.title}</strong><small>{record.duration} · {record.description.slice(0, 76)}...</small></span></button><span><span className={`record-type ${record.recordType}`}>{record.recordType === "rollup" ? "Rollup" : "Leaf"}</span></span><span className="source-count"><FileText size={14} />{record.resources.length + record.citations.length} 个来源</span><StatusPill status="generated" /><button className="row-action" onClick={() => onExport(record)} title="导出 Markdown"><DownloadSimple size={16} /></button></div>) : <EmptyState title="暂无记录" />}</div>;
}

function MemoryDrawer({ record, onClose, onExport, onNavigate }) {
  const stats = getRecordStats(record);
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><aside className="memory-drawer"><div className="drawer-header"><span className="page-eyebrow">MEMORY SUMMARY</span><button className="drawer-close" onClick={onClose}>×</button><h2>{record.title}</h2><p>{record.duration} · {record.recordType === "rollup" ? "Rollup Summary" : "Leaf Summary"} · 置信度 {stats.confidence}</p></div><div className="drawer-actions"><button className="outline-button" onClick={onExport}><DownloadSimple size={16} />导出 Markdown</button><button className="primary-button" onClick={() => { onClose(); onNavigate("history"); }}><ArrowSquareOut size={16} />打开时间线</button></div><div className="drawer-content"><DrawerSection title="Memory summary"><p>{record.summary}</p></DrawerSection><DrawerSection title="上下层关系"><div className="relation-line"><span className="relation-node">{record.recordType === "rollup" ? "Rollup" : "Leaf"}</span><span className="relation-arrow">→</span><span className="relation-node">{record.recordType === "rollup" ? `${record.timeline.length} 个下层窗口` : "原始活动事件"}</span></div></DrawerSection><DrawerSection title="Citations"><div className="citation-mini-list">{record.citations.map((citation) => <div key={citation.label}><FileText size={15} /><span><strong>{citation.label}</strong><small>{citation.detail}</small></span></div>)}</div></DrawerSection></div></aside></div>;
}

function DrawerSection({ title, children }) { return <section className="drawer-section"><h3>{title}</h3>{children}</section>; }

function SkillPage({ role, onNavigate }) {
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState(null);
  const [saved, setSaved] = useState(["我今天主要做了什么？", "研发团队本周有哪些工作主题？"]);
  const submit = (event) => { event.preventDefault(); if (question.trim()) setResult(askHistory(question, historyRecords)); };
  return <div className="page-content"><PageHeader eyebrow="HISTORY SKILL" title="询问计算机历史" description="用自然语言查询你有权限访问的工作活动和上下文。" meta={`${roleLabel[role]} · 只读`} action={<span className="scope-pill"><LockKey size={14} />权限范围已过滤</span>} /><div className="skill-page-grid"><SectionCard title="新建提问" description="问题会先经过权限范围过滤，再检索 Memory Summary 和证据"><form className="large-skill-form" onSubmit={submit}><ChatCircleDots size={22} /><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：过去三天哪些活动记录存在明显上下文中断？" /><button className="primary-button" type="submit"><PaperPlaneTilt size={17} />获取答案</button></form><div className="question-grid"><button onClick={() => setQuestion("我今天主要做了什么？")}>我今天主要做了什么？</button><button onClick={() => setQuestion("为什么我今天频繁切换应用？")}>为什么我今天频繁切换应用？</button><button onClick={() => setQuestion("研发团队本周有哪些连续工作主题？")}>研发团队本周有哪些连续工作主题？</button></div></SectionCard><SectionCard title="问题历史" description="最近询问过的问题"><div className="saved-question-list">{saved.map((item) => <button key={item} onClick={() => setQuestion(item)}><Clock size={16} /><span>{item}</span><ArrowSquareOut size={14} /></button>)}</div><button className="text-button add-question" onClick={() => setSaved((items) => [...items, "过去一周有哪些需要人工确认的上下文？"])}><Plus size={15} />添加示例问题</button></SectionCard></div>{result && <SectionCard title="回答结果" description="每个结论都应该能够回溯到 Memory Summary 或原始活动证据"><SkillAnswer result={result} onOpen={() => onNavigate("history")} /></SectionCard>}</div>;
}

function SkillAnswer({ result, onOpen }) {
  return <div className="skill-answer"><p>{result.answer}</p><div className="skill-answer-meta"><span><CheckCircle size={15} weight="fill" />已关联 {result.evidence.length} 条证据</span><span><Fingerprint size={15} />权限范围内</span></div><div className="evidence-list"><span className="evidence-label">证据记录</span>{result.evidence.map((record) => <button key={record.id} onClick={onOpen}><Sparkle size={16} weight="fill" /><span><strong>{record.title}</strong><small>{record.duration} · 置信度 {Math.round(record.confidence * 100)}%</small></span><ArrowSquareOut size={15} /></button>)}</div><div className="caveat-box"><WarningCircle size={16} /><span>{result.caveats[0]}</span></div></div>;
}

function DevicesPage({ role, query, target, onToast }) {
  const [tab, setTab] = useState("设备列表");
  const [selected, setSelected] = useState(null);
  const [liveDevices, setLiveDevices] = useState(null);
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
  const sourceDevices = liveDevices || deviceData;
  const scopedDevices = role === "employee" ? sourceDevices.filter((device) => device.user === "Wei") : sourceDevices;
  const devices = scopedDevices.filter((device) => !query.trim() || `${device.name} ${device.user} ${device.status} ${device.error}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => {
    const nextDevice = scopedDevices.find((device) => device.id === target);
    if (nextDevice) setSelected(nextDevice);
  }, [target, role]);
  return <div className="page-content"><PageHeader eyebrow="DEVICE FLEET" title="设备" description={agentApiEnabled ? "已连接 Agent 局域网服务，显示真实设备心跳和缓存状态。" : "管理 Windows Agent、设备在线状态和采集诊断。"} meta={`${devices.length} 台设备`} action={<button className="outline-button" onClick={() => onToast("设备注册链接已复制")}><Plus size={17} />注册设备</button>} />{liveError && <div className="error-box">Agent 服务暂时不可用：{liveError}</div>}<Tabs tabs={["设备列表", "Agent 状态", "采集策略", "事件诊断"]} active={tab} onChange={setTab} />{tab === "设备列表" && <SectionCard title="Windows 设备" description="点击设备查看会话、心跳、缓存和采集错误"><div className="data-table device-table"><div className="table-row table-head"><span>设备</span><span>使用者</span><span>系统 / Agent</span><span>会话</span><span>心跳</span><span>状态</span></div>{devices.map((device) => <button className="table-row" key={device.id} onClick={() => setSelected(device)}><span className="table-person"><span className="device-icon"><Monitor size={17} /></span><strong>{device.name}</strong></span><span>{device.user}</span><span><strong>{device.os}</strong><small>Agent {device.agent}</small></span><span>{device.session}</span><span>{device.heartbeat}</span><StatusPill status={device.status} /></button>)}</div></SectionCard>}{tab === "Agent 状态" && <><KpiGrid items={[{ label: "Agent 在线率", value: "96.2%", detail: "25 / 26 台", icon: <Pulse size={20} />, good: true }, { label: "当前版本", value: "0.8.2", detail: "23 台设备", icon: <Wrench size={20} />, tone: "blue" }, { label: "待升级", value: "3 台", detail: "不会停止采集", icon: <DownloadSimple size={20} />, tone: "gold" }, { label: "异常事件", value: "2 条", detail: "过去 24 小时", icon: <WarningCircle size={20} />, tone: "green" }]} /><SectionCard title="Agent 版本分布"><div className="version-list"><VersionRow version="0.8.2" count="23 台" width="88%" status="推荐" /><VersionRow version="0.8.1" count="2 台" width="8%" status="可升级" /><VersionRow version="0.7.9" count="1 台" width="4%" status="过旧" /></div></SectionCard></>}{tab === "采集策略" && <PolicyPreview onToast={onToast} />}{tab === "事件诊断" && <SectionCard title="最近采集事件" description="只显示 Agent 诊断元数据"><div className="diagnostic-list"><DiagnosticRow icon={<CheckCircle size={18} weight="fill" />} title="活动事件批次上传成功" detail="WIN-WEI-01 · 2 分钟前 · 24 条事件" /><DiagnosticRow icon={<WarningCircle size={18} weight="fill" />} title="浏览器扩展版本不一致" detail="WIN-MING-03 · 7 分钟前 · 页面标题可能缺失" /><DiagnosticRow icon={<WarningCircle size={18} weight="fill" />} title="设备离线超过 2 小时" detail="WIN-JIA-05 · 2 小时前 · 本地缓存 44 条" /></div></SectionCard>}{selected && <DeviceDrawer device={selected} onClose={() => setSelected(null)} onToast={onToast} />}</div>;
}

function VersionRow({ version, count, width, status }) { return <div className="version-row"><span><strong>{version}</strong><small>{count}</small></span><span className="version-track"><i style={{ width }} /></span><StatusPill status={status === "推荐" ? "online" : status === "过旧" ? "offline" : "pending"} /></div>; }
function PolicyPreview({ onToast }) { return <SectionCard title="采集策略" description="MVP 只记录前台应用、空闲状态和心跳，员工可查看自己的采集说明"><div className="policy-grid"><PolicyItem icon={<Browser size={19} />} title="应用活动" detail="记录前台应用名称和使用时长" enabled /><PolicyItem icon={<Clock size={19} />} title="系统空闲" detail="超过 5 分钟进入空闲状态" enabled /><PolicyItem icon={<Globe size={19} />} title="网站域名" detail="Chrome/Edge 扩展将在后续接入" enabled={false} /><PolicyItem icon={<DeviceMobile size={19} />} title="截图、键盘和正文" detail="明确禁止采集" enabled={false} /></div><button className="outline-button" onClick={() => onToast("采集策略编辑需要管理员权限")}><SlidersHorizontal size={16} />编辑采集策略</button></SectionCard>; }
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
function PolicyEditor({ onToast }) { return <SectionCard title="采集策略" description="统一控制应用、网页和文件元数据的采集范围"><div className="policy-grid"><PolicyItem icon={<Browser size={19} />} title="应用与窗口" detail="所有公司管理设备" enabled /><PolicyItem icon={<Globe size={19} />} title="浏览器域名和标题" detail="去除查询参数和 Token" enabled /><PolicyItem icon={<FileText size={19} />} title="文件元数据" detail="仅文件名、扩展名和脱敏路径" enabled /><PolicyItem icon={<DeviceMobile size={19} />} title="截图、键盘和剪贴板" detail="系统级禁止" enabled={false} /></div><button className="primary-button" onClick={() => onToast("采集策略已保存")}>保存采集策略</button></SectionCard>; }
function ExclusionPolicy({ onToast }) { return <SectionCard title="应用与网站排除" description="被排除的来源不会进入活动事件或 Memory Summary"><div className="exclusion-list"><ExclusionRow name="个人银行与支付网站" type="网站分类" enabled /><ExclusionRow name="密码管理器" type="应用分类" enabled /><ExclusionRow name="敏感客户项目目录" type="文件路径" enabled /><ExclusionRow name="社交与娱乐分类" type="默认分类" enabled={false} /></div><button className="outline-button" onClick={() => onToast("新增排除规则需要输入来源")}><Plus size={16} />新增排除规则</button></SectionCard>; }
function ExclusionRow({ name, type, enabled }) { return <div className="exclusion-row"><span className={`exclusion-switch ${enabled ? "on" : ""}`}><i /></span><span><strong>{name}</strong><small>{type}</small></span><button className="row-action"><ArrowSquareOut size={15} /></button></div>; }
function RetentionPolicy({ onToast }) { return <SectionCard title="数据保留策略" description="保留时长按企业政策执行，所有变更进入审计"><div className="retention-grid"><div><span>原始活动事件</span><strong>90 天</strong><small>到期自动删除</small></div><div><span>Leaf Summary</span><strong>1 年</strong><small>保留来源引用</small></div><div><span>Rollup Summary</span><strong>1 年</strong><small>可导出 Markdown</small></div></div><button className="outline-button" onClick={() => onToast("保留策略保持当前配置")}><Archive size={16} />查看删除计划</button></SectionCard>; }

function AuditPage({ role, query, onToast }) {
  const [tab, setTab] = useState("访问日志");
  const logs = auditData.filter((item) => !query.trim() || `${item.actor} ${item.action} ${item.target} ${item.result}`.toLowerCase().includes(query.toLowerCase()));
  return <div className="page-content"><PageHeader eyebrow="AUDIT TRAIL" title="审计" description="记录历史访问、导出、权限策略和 Agent 事件。" meta={`${logs.length} 条事件`} action={<button className="outline-button" onClick={() => onToast("审计日志导出已开始")}><DownloadSimple size={17} />导出日志</button>} /><Tabs tabs={["访问日志", "权限变更", "导出记录", "归档与删除", "Agent 事件"]} active={tab} onChange={setTab} /><SectionCard title={tab} description={role === "auditor" ? "当前为只读审计范围" : "所有操作均带有操作者、对象、时间和结果"}><div className="audit-table"><div className="audit-row audit-head"><span>时间</span><span>操作者</span><span>动作</span><span>对象</span><span>结果</span><span /></div>{logs.map((item, index) => <div className="audit-row" key={`${item.time}-${index}`}><span>{item.time}</span><span className="audit-actor">{item.actor}</span><span>{item.action}</span><span>{item.target}</span><StatusPill status={item.result === "允许" || item.result === "成功" || item.result === "完成" || item.result === "已生效" ? "online" : item.result === "需关注" ? "attention" : "idle"} /><button className="row-action" onClick={() => onToast(`已打开 ${item.action} 详情`)}><ArrowSquareOut size={15} /></button></div>)}</div></SectionCard></div>;
}

function SettingsPage({ role, onToast }) {
  const [tab, setTab] = useState("企业资料");
  return <div className="page-content"><PageHeader eyebrow="ORGANIZATION SETTINGS" title="设置" description="管理企业资料、工作会话、活动分类、AI、通知和数据集成。" meta={roleLabel[role]} action={<button className="primary-button" onClick={() => onToast("设置已保存")}>保存设置</button>} /><Tabs tabs={["企业资料", "工作会话", "活动分类", "AI 设置", "通知", "数据与集成", "安全合规"]} active={tab} onChange={setTab} />{tab === "企业资料" && <SettingsForm onToast={onToast} />}{tab === "工作会话" && <SectionCard title="工作会话" description="决定活动事件何时进入工作记录"><div className="settings-grid"><SettingField label="默认工作时间" value={settingsData.workHours} /><SettingField label="企业时区" value={settingsData.timezone} /><SettingField label="连续空闲阈值" value={settingsData.idleThreshold} /><SettingField label="锁屏后处理" value="立即结束当前会话" /></div></SectionCard>}{tab === "活动分类" && <CategorySettings onToast={onToast} />}{tab === "AI 设置" && <SectionCard title="AI 模型适配层" description="摘要和问答必须保留 Citations，并对事件文本进行不可信数据隔离"><div className="settings-grid"><SettingField label="摘要语言" value="简体中文 / English" /><SettingField label="默认模型" value="受控服务端模型" /><SettingField label="置信度阈值" value="0.70" /><SettingField label="原始内容读取" value="禁止" /></div></SectionCard>}{tab === "通知" && <NotificationSettings onToast={onToast} />}{tab === "数据与集成" && <IntegrationSettings onToast={onToast} />}{tab === "安全合规" && <ComplianceSettings onToast={onToast} />}</div>;
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

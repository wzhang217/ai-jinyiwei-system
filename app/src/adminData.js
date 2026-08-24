export const teamData = [
  {
    id: "team-product-dev",
    name: "研发与产品中心",
    lead: "Wei",
    members: 12,
    activeMembers: 9,
    coverage: 96,
    focus: "前端重构与 AI 工作流",
    summary: "本周主要围绕 AI锦衣卫 信息架构、Replacer Studio 任务详情和后端接口准备展开。",
    apps: ["VS Code", "Chrome", "Codex", "企业微信"],
  },
  {
    id: "team-sales",
    name: "客户与销售团队",
    lead: "Lin",
    members: 8,
    activeMembers: 7,
    coverage: 91,
    focus: "客户跟进与方案演示",
    summary: "近期工作集中在客户会议、方案跟进和演示材料准备。",
    apps: ["企业微信", "Chrome", "飞书", "文档"],
  },
  {
    id: "team-operations",
    name: "运营与支持团队",
    lead: "Ming",
    members: 6,
    activeMembers: 5,
    coverage: 88,
    focus: "服务响应与内容运营",
    summary: "团队正在处理客户支持、内容排期和内部知识库更新。",
    apps: ["企业微信", "Chrome", "Notion", "表格"],
  },
];

export const employeeData = [
  { id: "employee-wei", name: "Wei", title: "产品与研发负责人", team: "研发与产品中心", manager: "—", status: "active", focus: "AI锦衣卫 产品规划", coverage: 98, device: "WIN-WEI-01" },
  { id: "employee-lin", name: "Lin", title: "销售负责人", team: "客户与销售团队", manager: "Wei", status: "active", focus: "客户方案与演示", coverage: 94, device: "WIN-LIN-02" },
  { id: "employee-ming", name: "Ming", title: "运营专员", team: "运营与支持团队", manager: "Wei", status: "idle", focus: "客户支持知识库", coverage: 88, device: "WIN-MING-03" },
  { id: "employee-chen", name: "Chen", title: "前端工程师", team: "研发与产品中心", manager: "Wei", status: "active", focus: "任务详情与素材流程", coverage: 97, device: "WIN-CHEN-04" },
  { id: "employee-jia", name: "Jia", title: "客户成功经理", team: "客户与销售团队", manager: "Lin", status: "offline", focus: "客户回访", coverage: 79, device: "WIN-JIA-05" },
];

export const deviceData = [
  { id: "device-001", name: "WIN-WEI-01", user: "Wei", os: "Windows 11 Pro", agent: "0.8.2", status: "online", session: "active", heartbeat: "2 分钟前", cache: 0, error: "无" },
  { id: "device-002", name: "WIN-LIN-02", user: "Lin", os: "Windows 11 Pro", agent: "0.8.2", status: "online", session: "meeting", heartbeat: "3 分钟前", cache: 2, error: "无" },
  { id: "device-003", name: "WIN-MING-03", user: "Ming", os: "Windows 10 Enterprise", agent: "0.8.1", status: "idle", session: "idle", heartbeat: "7 分钟前", cache: 16, error: "浏览器扩展待更新" },
  { id: "device-004", name: "WIN-CHEN-04", user: "Chen", os: "Windows 11 Pro", agent: "0.8.2", status: "online", session: "active", heartbeat: "1 分钟前", cache: 0, error: "无" },
  { id: "device-005", name: "WIN-JIA-05", user: "Jia", os: "Windows 11 Pro", agent: "0.7.9", status: "offline", session: "locked", heartbeat: "2 小时前", cache: 44, error: "Agent 版本过旧" },
];

export const auditData = [
  { time: "今天 14:42", actor: "Wei", action: "查看个人时间线", target: "Chen / 研发与产品中心", result: "允许", type: "access" },
  { time: "今天 13:20", actor: "Wei", action: "导出 Memory Summary", target: "AI锦衣卫 product planning", result: "允许", type: "export" },
  { time: "今天 11:06", actor: "系统", action: "Agent 上线", target: "WIN-CHEN-04", result: "成功", type: "agent" },
  { time: "昨天 18:10", actor: "Wei", action: "修改采集策略", target: "研发与产品中心 / 浏览器", result: "已生效", type: "policy" },
  { time: "昨天 16:35", actor: "Lin", action: "询问 History Skill", target: "客户与销售团队 / 本周", result: "完成", type: "skill" },
  { time: "8月20日 19:14", actor: "系统", action: "Agent 离线", target: "WIN-JIA-05", result: "需关注", type: "agent" },
];

export const permissionRoles = [
  { role: "老板", scope: "整个企业", users: 1, description: "管理组织、设备、策略、审计和全企业历史记录。" },
  { role: "高管", scope: "直属团队", users: 5, description: "查看直属团队的趋势、历史记录和 Memory Summary。" },
  { role: "员工", scope: "本人", users: 26, description: "查看自己的活动历史、Memory Summary 和隐私说明。" },
];

export const settingsData = {
  workHours: "09:00 – 18:00",
  timezone: "Asia/Shanghai（UTC+8）",
  idleThreshold: "5 分钟",
  retention: "原始 90 天 · 汇总 1 年",
  language: "简体中文",
};

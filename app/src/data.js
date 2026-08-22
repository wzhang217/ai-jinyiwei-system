export const applications = {
  codex: { name: "Codex", kind: "AI 工作台", color: "#191919" },
  chrome: { name: "Google Chrome", kind: "浏览器", color: "#4285f4" },
  edge: { name: "Microsoft Edge", kind: "浏览器", color: "#0b8f8f" },
  browser360: { name: "360 浏览器", kind: "浏览器", color: "#2e9b61" },
  vscode: { name: "VS Code", kind: "开发工具", color: "#007acc" },
  finder: { name: "Finder", kind: "文件资源", color: "#4c9aff" },
  explorer: { name: "Windows 文件资源管理器", kind: "文件资源", color: "#3b82d0" },
  terminal: { name: "Windows 终端", kind: "终端", color: "#424242" },
  wechat: { name: "企业微信", kind: "沟通", color: "#20c36b" },
  slack: { name: "Slack", kind: "沟通", color: "#611f69" },
  teams: { name: "Microsoft Teams", kind: "沟通", color: "#6264a7" },
  collaboration: { name: "协作工具", kind: "沟通", color: "#3b82f6" },
  project: { name: "项目管理工具", kind: "项目管理", color: "#2563eb" },
  wps: { name: "WPS Office", kind: "文档", color: "#d94645" },
  word: { name: "Microsoft Word", kind: "文档", color: "#2b579a" },
  excel: { name: "Microsoft Excel", kind: "文档", color: "#217346" },
  powerpoint: { name: "Microsoft PowerPoint", kind: "文档", color: "#d24726" },
  notion: { name: "Notion", kind: "文档", color: "#161616" },
  figma: { name: "Figma", kind: "设计", color: "#f24e1e" },
  other: { name: "其他应用", kind: "未分类", color: "#7c8077" },
};

export const historyRecords = [
  {
    id: "memory-ai-0822-0840",
    day: "今天",
    time: "8:40",
    duration: "6h",
    recordType: "rollup",
    title: "AI锦衣卫 product planning",
    description:
      "You started a Computer History-like activity insight session for AI锦衣卫, refined the Memory Summary record format, and aligned the enterprise History Skill with the same traceable activity context.",
    applications: ["codex", "chrome", "notion"],
    resources: [
      { name: "AI锦衣卫 v2 implementation plan", type: "document", path: "企业工作洞察 / 产品规划" },
      { name: "Computer History Memory Summary", type: "document", path: "参考资料 / 记录格式" },
    ],
    summary:
      "这段工作围绕 AI锦衣卫 v2 的产品和数据模型展开。你把系统从传统的员工时长看板重新定位为 Computer History 风格的企业历史系统：持续采集活动上下文，生成带 Front Matter、摘要、上下文和引用的 Memory Summary，并通过 History Skill 进行权限内问答。",
    priorContext:
      "此前已经确定系统首版面向中小企业，使用公司管理的 Windows 设备，管理者可查看直属团队，员工和管理者都可以按权限询问历史记录。",
    nonObvious:
      "记录的核心颗粒度不是固定的应用日志，而是一个有连续工作主题的 Memory Summary。10min 和 6h 是可以并存的摘要窗口类型。",
    timeline: [
      { time: "8:40", text: "开始重新梳理 AI锦衣卫 v2 的 Memory Summary 产品结构", app: "codex" },
      { time: "9:05", text: "对照 Computer History 示例，补充 Front Matter、Applications 和 Citations", app: "chrome" },
      { time: "10:20", text: "确定 Leaf Summary、Rollup Summary 和 History Skill 的关系", app: "notion" },
      { time: "12:15", text: "整理企业权限、活动采集边界和只读问答规则", app: "codex" },
      { time: "14:30", text: "形成可直接实现的前端原型与接口计划", app: "codex" },
    ],
    citations: [
      { label: "Computer History 参考记录", detail: "Memory Summary / 记录格式", type: "memory" },
      { label: "AI锦衣卫 v2 implementation plan", detail: "产品规划 / 当前版本", type: "file" },
      { label: "Codex", detail: "活动应用 / 规划与整理", type: "app" },
    ],
    confidence: 0.94,
  },
  {
    id: "memory-replacer-0821-1900",
    day: "昨天",
    time: "夜间",
    duration: "10min",
    recordType: "leaf",
    title: "Replacer Studio prototype validation arc",
    description:
      "You iterated on the AI生图 / Replacer Studio prototype, validating video generation, asset workflows, recycle-bin behavior, library selection, face-swap output, and task-detail affordances.",
    applications: ["vscode", "chrome", "codex", "wechat", "finder"],
    resources: [
      { name: "TaskDetailModal.jsx", type: "code", path: "replacer-studio/src/components/tasks/" },
      { name: "App.jsx", type: "code", path: "replacer-studio/src/" },
      { name: "0002_asset_recycle_bin.sql", type: "code", path: "AI生图 / backend" },
    ],
    summary:
      "你继续验证 AI生图 / Replacer Studio 原型，重点检查任务详情入口是否能展示不同工作流的完整输入、状态、参数和生成结果。期间在 Chrome 中测试了换脸、文生视频和文生图任务，并回到 VS Code 检查前后端仓库准备情况。",
    priorContext:
      "前一个阶段刚完成素材库选择和换脸任务创建，新的问题集中在任务列表的小箭头应当打开完整详情，而不是只展示简短摘要。",
    nonObvious:
      "这次记录同时覆盖了 UI 验证、代码查看和仓库准备；应用切换本身不能直接解释为低效，而是同一个原型验证任务的不同证据。",
    timeline: [
      { time: "夜间", text: "在 Chrome 中打开本地 Replacer Studio 原型", app: "chrome" },
      { time: "夜间", text: "验证图片换脸、文生视频和文生图任务详情入口", app: "chrome" },
      { time: "夜间", text: "在 VS Code 中检查 TaskDetailModal.jsx 与 App.jsx", app: "vscode" },
      { time: "夜间", text: "查看资源回收站 SQL 和后端文档", app: "finder" },
    ],
    citations: [
      { label: "TaskDetailModal.jsx", detail: "replacer-studio/src/components/tasks/", type: "file" },
      { label: "App.jsx", detail: "replacer-studio/src/", type: "file" },
      { label: "Chrome prototype", detail: "localhost:5173 / 手动验证", type: "app" },
    ],
    confidence: 0.91,
  },
  {
    id: "memory-replacer-0820-1200",
    day: "8月20日星期四",
    time: "下午",
    duration: "6h",
    recordType: "rollup",
    title: "Replacer Studio auth and persistence buildout",
    description:
      "You spent the window moving Replacer Studio from frontend refactor through Supabase Auth/admin integration, local prototype validation, and generated-result persistence debugging.",
    applications: ["chrome", "vscode", "codex", "wechat", "finder"],
    resources: [
      { name: "README.md", type: "document", path: "AI生图 / backend" },
      { name: ".dev.vars", type: "sensitive", path: "AI生图 / backend / 已脱敏" },
      { name: "Supabase admin integration", type: "document", path: "backend / auth" },
    ],
    summary:
      "这段较长的工作记录围绕 Replacer Studio 的认证、持久化和前端验证展开。你先检查了 Supabase Auth/admin 接入，再在本地原型中验证生成结果和任务状态，最后查看 backend README 与环境配置，为前后端分开上传做准备。",
    priorContext:
      "这次工作承接了前端布局、任务和素材模块的拆分，后续计划是继续连接后端和 Supabase。",
    nonObvious:
      "环境变量文件被打开但内容没有进入摘要；它只作为敏感文件元数据出现在来源列表中。",
    timeline: [
      { time: "中午", text: "检查前端重构后的任务和素材流程", app: "vscode" },
      { time: "下午", text: "调试 Supabase Auth/admin 与生成结果持久化", app: "codex" },
      { time: "晚上", text: "在 Chrome 中验证本地原型和任务状态", app: "chrome" },
      { time: "晚上", text: "查看 backend README 与环境配置文件", app: "finder" },
    ],
    citations: [
      { label: "backend/README.md", detail: "后端说明文档", type: "file" },
      { label: ".dev.vars", detail: "敏感环境配置，内容已隐藏", type: "file" },
      { label: "Supabase Auth", detail: "认证与管理配置", type: "app" },
    ],
    confidence: 0.88,
  },
];

export const defaultQuestions = [
  "我今天主要做了什么？",
  "哪些活动和 AI锦衣卫 产品规划有关？",
  "为什么我今天频繁切换应用？",
];

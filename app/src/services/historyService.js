const formatDuration = (seconds) => {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
};

export function recordToMarkdown(record) {
  const applications = record.applications.map((key) => key).join(", ");
  const citations = record.citations.map((item) => `- ${item.label} — ${item.detail}`).join("\n");
  const timeline = record.timeline.map((item) => `- ${item.time} · ${item.text}`).join("\n");
  const resources = record.resources.map((item) => `- ${item.name} — ${item.path}`).join("\n");

  return `---\ntitle: ${record.title}\ndescription: ${record.description}\napplications: [${applications}]\nduration: ${record.duration}\nrecord_type: ${record.recordType}\nuser_id: employee_001\nperiod_start: 2026-08-22T08:40:00+08:00\nperiod_end: 2026-08-22T14:40:00+08:00\n---\n\n## Memory summary\n\n${record.summary}\n\n## Relevant prior context\n\n${record.priorContext}\n\n## Important non-obvious context\n\n${record.nonObvious}\n\n## Recording summary\n\n${timeline}\n\n## Resources\n\n${resources}\n\n## Citations\n\n${citations}\n`;
}

export function downloadRecordMarkdown(record) {
  const blob = new Blob([recordToMarkdown(record)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `2026-08-22T08-40-00-${record.id}-${record.duration}-memory-summary.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function askHistory(query, records) {
  const normalized = query.toLowerCase();
  const matched = records.filter((record) => {
    const haystack = [record.title, record.description, record.summary, record.priorContext, record.nonObvious, ...record.applications].join(" ").toLowerCase();
    return normalized.split(/\s+/).some((token) => token.length > 1 && haystack.includes(token)) || normalized.includes("今天") || normalized.includes("主要");
  });
  const evidence = (matched.length ? matched : records.slice(0, 2)).slice(0, 3);
  const applications = [...new Set(evidence.flatMap((record) => record.applications))];
  const answer = query.includes("切换")
    ? "今天的应用切换主要发生在同一个产品验证主题内：规划 AI锦衣卫 的记录格式、对照 Computer History 示例，并检查前端原型。应用切换并不等于工作主题切换，当前证据更像是跨工具完成同一项任务。"
    : query.includes("团队") || query.includes("哪些活动")
      ? "历史记录显示，最近的连续工作主题集中在 AI锦衣卫 Memory Summary 设计、Computer History 记录格式对齐，以及 Replacer Studio 的任务详情和后端准备。"
      : "最近记录显示，你主要在整理 AI锦衣卫 的企业历史系统，并继续验证 Replacer Studio 的任务详情和持久化流程。两类工作都通过 Codex、Chrome 和 VS Code 完成。";

  return {
    answer,
    evidence,
    applications,
    caveats: ["这是基于活动元数据和 Memory Summary 的解释，不读取文件或聊天正文，也不会把应用切换直接判断为低效。"],
  };
}

export function getRecordStats(record) {
  const durationSeconds = Number.isFinite(record.durationSeconds)
    ? record.durationSeconds
    : record.duration === "6h"
      ? 6 * 60 * 60
      : 10 * 60;
  return {
    applications: record.applications.length,
    resources: record.resources.length,
    timeline: record.timeline.length,
    confidence: `${Math.round(record.confidence * 100)}%`,
    duration: record.duration,
    durationReadable: formatDuration(durationSeconds),
  };
}

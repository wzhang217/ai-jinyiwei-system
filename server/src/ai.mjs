const DEFAULT_PROMPT_VERSION = "memory-v1";
const MAX_GENERATED_TEXT_LENGTH = 2000;

function text(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function clampConfidence(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function parseJsonContent(value) {
  const raw = text(value);
  if (!raw) return null;
  const withoutFence = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(withoutFence);
  } catch {
    return null;
  }
}

function validatedModelText(value, field) {
  if (typeof value !== "string") throw new Error(`AI ${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_GENERATED_TEXT_LENGTH) {
    throw new Error(`AI ${field} is empty or too long`);
  }
  if (/https?:\/\//i.test(trimmed) || /(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|var|tmp|private)\/)/.test(trimmed)) {
    throw new Error(`AI ${field} contains a protected URL or path`);
  }
  return trimmed;
}

function modelTextOrFallback(value, field, fallback) {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
    return fallback;
  }
  const normalized = Array.isArray(value)
    ? value.every((item) => typeof item === "string") ? value.join("；") : value
    : value;
  return validatedModelText(normalized, field);
}

function normalizeWorkThemeTitle(value, input, fallback) {
  const candidate = modelTextOrFallback(value, "title", fallback);
  const employeeName = text(input?.employee_name);
  const withoutEmployee = candidate
    .replace(new RegExp(`^${employeeName.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*[·:：-]\\s*`, "i"), "")
    .trim();
  const bareDomain = /^(?:[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}|localhost)$/i.test(withoutEmployee);
  const applications = (input?.application_names || input?.applications || [])
    .map((item) => text(item).toLowerCase())
    .filter(Boolean);
  const bareApplication = applications.some((application) => withoutEmployee.toLowerCase() === application);
  return bareDomain || bareApplication ? fallback : candidate;
}

function shanghaiDateTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function publicRecord(record) {
  return {
    id: record.id,
    record_type: record.record_type,
    rollup_scope: record.rollup_scope || null,
    employee_name: record.employee_name,
    employee_team: record.employee_team,
    title: record.title,
    description: record.description,
    applications: record.application_names || [],
    context_kinds: record.context_kinds || [],
    context_labels: record.context_labels || [],
    web_domains: record.web_domains || [],
    source_kinds: record.source_kinds || [],
    source_types: record.source_types || [],
    resource_types: record.resource_types || [],
    context_switches: record.context_switches || 0,
    duration_seconds: record.duration_seconds || 0,
    started_at: record.started_at,
    ended_at: record.ended_at,
    started_at_shanghai: shanghaiDateTime(record.started_at),
    ended_at_shanghai: shanghaiDateTime(record.ended_at),
    source_record_count: Array.isArray(record.source_record_ids) ? record.source_record_ids.length : 0,
    source_event_count: Array.isArray(record.source_event_ids) ? record.source_event_ids.length : 0,
    activity_sequence: (record.activity_sequence || []).slice(0, 100).map((item) => ({
      occurred_at: item?.occurred_at,
      occurred_at_shanghai: shanghaiDateTime(item?.occurred_at),
      duration_seconds: item?.duration_seconds,
      app: item?.app,
      context_kind: item?.context_kind,
      context_label: item?.context_label,
      web_domain: item?.web_domain,
      source_kind: item?.source_kind,
    })),
    resource_names: (record.resources || []).map((item) => item?.name).filter(Boolean).slice(0, 100),
    resource_details: (record.resources || []).map((item) => ({
      name: item?.name,
      source_type: item?.source_type,
    })).filter((item) => item.name).slice(0, 100),
    citation_labels: (record.citations || []).map((item) => item?.label).filter(Boolean).slice(0, 100),
    timeline: (record.timeline || []).slice(0, 100).map((item) => ({
      occurred_at: item?.occurred_at,
      occurred_at_shanghai: shanghaiDateTime(item?.occurred_at),
      text: item?.text,
      app: item?.app,
      duration_seconds: item?.duration_seconds,
      source_kind: item?.source_kind,
    })),
  };
}

function evidenceMetadata(records) {
  const starts = records.map((record) => Date.parse(record.started_at)).filter(Number.isFinite);
  const ends = records.map((record) => Date.parse(record.ended_at)).filter(Number.isFinite);
  return {
    applications: [...new Set(records.flatMap((record) => record.application_names || []))].slice(0, 12),
    context_labels: [...new Set(records.flatMap((record) => record.context_labels || []))].slice(0, 20),
    web_domains: [...new Set(records.flatMap((record) => record.web_domains || []))].slice(0, 20),
    time_range: starts.length && ends.length
      ? { start: new Date(Math.min(...starts)).toISOString(), end: new Date(Math.max(...ends)).toISOString() }
      : null,
  };
}

function fallbackSummary(input) {
  const importantContext = text(input.important_context || input.non_obvious, "该摘要不包含键盘、剪贴板、截图、聊天正文、文件正文或完整 URL。");
  return {
    title: text(input.title, `${text(input.employee_name, "员工")} · 活动记录`),
    description: text(input.description, "基于活动元数据生成的工作上下文记录。"),
    summary: text(input.summary, "这是一条基于应用活动、空闲状态和有限工作标识生成的 Memory Summary。"),
    prior_context: text(input.prior_context, "来源于 Windows Agent 的活动元数据采集。"),
    important_context: importantContext,
    non_obvious: importantContext,
    confidence: clampConfidence(input.confidence, 1),
  };
}

function fallbackAnswer(question, records) {
  if (!records.length) {
    return {
      answer: "在所查询的时间范围内没有找到可用的 Memory Summary。",
      evidence_ids: [],
      caveat: "当前时间范围内没有足够的活动元数据，系统没有用其他时间的记录替代答案。",
      uncertainty: "没有可用证据，无法判断该时间范围内的工作主题。",
      ...evidenceMetadata(records),
    };
  }
  const evidence = records.slice(0, 3);
  const evidenceIds = evidence.map((record) => record.id);
  const applications = [...new Set(evidence.flatMap((record) => record.application_names || []))];
  const metadata = evidenceMetadata(evidence);
  const normalized = text(question).toLowerCase();
  let answer;
  if (normalized.includes("切换")) {
    answer = `最近记录显示，活动主要在 ${applications.slice(0, 6).join("、") || "多个应用"} 之间切换；这些切换只能说明上下文发生变化，不能直接推断工作效率或绩效。`;
  } else if (normalized.includes("主要") || normalized.includes("做了什么") || normalized.includes("主题")) {
    const titles = [...new Set(evidence.map((record) => record.title).filter(Boolean))];
    answer = `最近可见的连续工作主题包括${titles.length ? `：${titles.join("、")}` : "活动记录"}。该结论只基于应用、时长、脱敏标识和网站域名等活动元数据。`;
  } else {
    answer = `已根据最近 ${evidence.length} 条 Memory Summary 找到相关活动记录，主要涉及 ${applications.slice(0, 6).join("、") || "多个工作上下文"}。`;
  }
  return {
    answer,
    evidence_ids: evidenceIds,
    caveat: "这是基于活动元数据和 Memory Summary 的解释，不读取文件或聊天正文，也不会把应用切换直接判断为低效。",
    uncertainty: "应用切换和持续时长只能说明活动上下文变化，不能单独证明工作效率、任务完成度或绩效。",
    ...metadata,
  };
}

function createPrompt({ system, input }) {
  return [
    { role: "system", content: system },
    { role: "user", content: JSON.stringify(input) },
  ];
}

export function createAiService({
  apiKey = process.env.AI_API_KEY || process.env.DASHSCOPE_API_KEY || "",
  apiUrl = process.env.AI_API_URL || process.env.DASHSCOPE_API_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  model = process.env.AI_MODEL || "qwen3.7-plus",
  enabled = process.env.AI_ENABLED === "true" || Boolean(apiKey),
  fetchImpl = globalThis.fetch,
  logger = console,
  promptVersion = DEFAULT_PROMPT_VERSION,
  maxRequestsPerMinute = Number(process.env.AI_MAX_REQUESTS_PER_MINUTE) || 30,
  maxInputRecords = Number(process.env.AI_MAX_INPUT_RECORDS) || 200,
  requestTimeoutMs = Number(process.env.AI_REQUEST_TIMEOUT_MS) || 60_000,
  enableThinking = process.env.AI_ENABLE_THINKING === "true",
} = {}) {
  const canCallModel = Boolean(enabled && apiKey && typeof fetchImpl === "function");
  const callTimestamps = [];

  async function complete(messages) {
    if (!canCallModel) return null;
    const now = Date.now();
    while (callTimestamps.length && now - callTimestamps[0] >= 60_000) callTimestamps.shift();
    if (callTimestamps.length >= Math.max(1, maxRequestsPerMinute)) {
      const error = new Error("AI request rate limit reached");
      error.code = "ai_rate_limited";
      throw error;
    }
    callTimestamps.push(now);
    const timeoutMs = Math.max(1, Number(requestTimeoutMs) || 20_000);
    const controller = typeof globalThis.AbortController === "function" ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          enable_thinking: enableThinking,
          messages,
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) throw new Error(`AI API HTTP ${response.status}`);
      const body = await response.json();
      return parseJsonContent(body.choices?.[0]?.message?.content);
    } catch (error) {
      if (controller?.signal.aborted) {
        const timeoutError = new Error(`AI API timeout after ${timeoutMs}ms`);
        timeoutError.code = "ai_timeout";
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return {
    model: canCallModel ? model : "rules-v1",
    promptVersion,
    mode: canCallModel ? "model" : "fallback",
    async summarizeMemory(input) {
      const fallback = fallbackSummary(input);
      if (!canCallModel) return { ...fallback, status: "fallback", model_name: "rules-v1" };
      try {
        const result = await complete(createPrompt({
          system: "你是企业 Computer History 的 Memory Summary 生成器。只根据输入的活动元数据生成 JSON。时间优先使用 *_shanghai 字段，统一按东八区表达。禁止猜测文件内容、聊天正文、网页正文、键盘输入、截图内容或绩效结论。只返回 title、description、summary、prior_context、important_context、confidence 字段。不要输出 URL、文件路径、原始窗口标题或敏感正文。标题必须是可读的工作主题，例如‘文件、文档、其他、沟通活动’或‘开发、浏览器、沟通活动’，不能只使用某个网站域名、单个应用名或员工姓名。描述和 summary 必须尽量包含东八区时间范围、涉及应用、按时间顺序的活动片段、应用切换次数、采集来源类型，以及资源类型（项目、文档、代码仓库、网站、沟通工具）和可见的网站/项目标识；资源类型只能使用输入中已有的证据，没有证据的内容明确说未记录。",
          input: { task: "summarize_memory", record: publicRecord(input) },
        }));
        if (!result || typeof result !== "object") throw new Error("AI summary was not valid JSON");
        const title = normalizeWorkThemeTitle(result.title, input, fallback.title);
        const description = modelTextOrFallback(result.description, "description", fallback.description);
        const summary = modelTextOrFallback(result.summary, "summary", fallback.summary);
        const priorContext = modelTextOrFallback(result.prior_context, "prior_context", fallback.prior_context);
        const importantContextValue = result.important_context ?? result.non_obvious;
        const importantContext = modelTextOrFallback(importantContextValue, "important_context", fallback.important_context);
        return {
          title,
          description,
          summary,
          prior_context: priorContext,
          important_context: importantContext,
          non_obvious: importantContext,
          confidence: clampConfidence(result.confidence, fallback.confidence),
          status: "generated",
          model_name: model,
        };
      } catch (error) {
        logger.warn?.(`AI memory summary fallback: ${error.message}`);
        return { ...fallback, status: "fallback", model_name: "rules-v1", retryable: true };
      }
    },
    async answerHistory({ question, records, timeRange = null }) {
      const fallback = fallbackAnswer(question, records);
      if (!canCallModel || !records.length) return { ...fallback, status: "fallback", model_name: "rules-v1" };
      try {
        const result = await complete(createPrompt({
          system: "你是企业 Computer History 的 History Skill。只根据提供的 Memory Summary 元数据回答问题。时间优先使用 *_shanghai 字段，统一按东八区表达。禁止编造文件、网页、聊天、键盘或绩效信息。只返回 JSON：answer 字符串、evidence_ids 数组、caveat 字符串、uncertainty 字符串。evidence_ids 只能使用输入记录的 id。答案应尽量明确时间范围、涉及应用、项目/工作标识和网站域名；缺少证据时要在 uncertainty 中说明。",
          input: {
            task: "answer_history_question",
            question: text(question),
            time_range: timeRange,
            records: records.slice(0, Math.max(1, maxInputRecords)).map(publicRecord),
          },
        }));
        if (!result || typeof result !== "object") throw new Error("AI history answer was not valid JSON");
        const answer = modelTextOrFallback(result.answer, "answer", fallback.answer);
        const caveat = modelTextOrFallback(result.caveat, "caveat", fallback.caveat);
        const uncertainty = modelTextOrFallback(result.uncertainty, "uncertainty", fallback.uncertainty);
        const validIds = new Set(records.map((record) => record.id));
        const evidenceIds = Array.isArray(result.evidence_ids)
          ? result.evidence_ids.filter((id) => typeof id === "string" && validIds.has(id)).slice(0, 5)
          : [];
        const selectedEvidence = (evidenceIds.length ? records.filter((record) => evidenceIds.includes(record.id)) : records.slice(0, 3));
        return {
          answer,
          evidence_ids: evidenceIds.length ? evidenceIds : fallback.evidence_ids,
          caveat,
          uncertainty,
          ...evidenceMetadata(selectedEvidence),
          status: "generated",
          model_name: model,
        };
      } catch (error) {
        logger.warn?.(`AI history answer fallback: ${error.message}`);
        return { ...fallback, status: "fallback", model_name: "rules-v1", retryable: true };
      }
    },
  };
}

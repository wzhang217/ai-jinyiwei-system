export const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function shanghaiDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : dateFormatter.format(date);
}

export function formatShanghaiTime(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, ...options });
}

export function formatShanghaiDate(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, ...options });
}

export function shanghaiDateInput(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 24 * 3600_000);
  return shanghaiDayKey(date);
}

export function shanghaiDateAtStart(daysAgo = 0) {
  return new Date(`${shanghaiDateInput(daysAgo)}T00:00:00+08:00`);
}

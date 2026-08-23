export const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function shanghaiDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = Object.fromEntries(dateFormatter.formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shanghaiWeekKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const dayKey = shanghaiDayKey(date);
  const localNoon = new Date(`${dayKey}T12:00:00+08:00`);
  const daysSinceMonday = (localNoon.getUTCDay() + 6) % 7;
  return shanghaiDayKey(localNoon.getTime() - daysSinceMonday * 24 * 3600_000);
}

export function formatShanghaiTime(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, hourCycle: "h23", ...options });
}

export function formatShanghaiDate(value, options = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("zh-CN", { timeZone: SHANGHAI_TIME_ZONE, ...options });
}

export function formatShanghaiFileStamp(value = new Date()) {
  return formatShanghaiTime(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).replaceAll(/[/:\s]/g, "-").replaceAll("年", "-").replaceAll("月", "-").replaceAll("日", "");
}

export function shanghaiDateInput(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 24 * 3600_000);
  return shanghaiDayKey(date);
}

export function shanghaiDateAtStart(daysAgo = 0) {
  return new Date(`${shanghaiDateInput(daysAgo)}T00:00:00+08:00`);
}

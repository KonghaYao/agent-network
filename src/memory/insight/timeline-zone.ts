/**
 * 时间线分组的时区解析与本地日期边界。
 *
 * IANA 时区优先：本地日期、日/周/月边界都由 Intl 按真实时区计算，DST 切换日
 * 不会退化成固定 offset。缺少 IANA 名称时回退到 `tz_offset_minutes`。
 */
import { BusinessError } from '../../contracts/errors';

export interface TimelineZone {
  timeZone: string | null;
  offsetMinutes: number;
}

export type TimelineGranularity = 'day' | 'week' | 'month';

export interface TimelineRange {
  key: string;
  label: string;
  start: string;
  end: string;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedDate extends CivilDate {
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** 只接受 IANA 区域名；固定偏移（+05:30）与未知名称都拒绝。 */
export function isValidTimeZoneName(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/u.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** schema 之外的兜底校验：`timezone` 优先于 `tz_offset_minutes`。 */
export function resolveTimelineZone(input: {
  timezone?: string;
  tz_offset_minutes?: number;
}): TimelineZone {
  const offsetMinutes = input.tz_offset_minutes ?? 0;
  if (input.timezone === undefined) return { timeZone: null, offsetMinutes };
  if (!isValidTimeZoneName(input.timezone)) {
    throw new BusinessError('INVALID_ARGUMENT', 'timezone 不是有效的 IANA 时区', {
      reason: 'invalid_timezone',
    });
  }
  return { timeZone: input.timezone, offsetMinutes };
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function zonedDate(ms: number, timeZone: string): ZonedDate {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const year = values.year ?? 1970;
  const month = values.month ?? 1;
  const day = values.day ?? 1;
  return {
    year,
    month,
    day,
    hour: values.hour === 24 ? 0 : (values.hour ?? 0),
    minute: values.minute ?? 0,
    second: values.second ?? 0,
    weekday: weekdayOf(year, month, day),
  };
}

/** 把「墙钟日期 + 时间」换算成 UTC 偏移（毫秒），按秒精度处理历史偏移。 */
function offsetMsAt(ms: number, timeZone: string): number {
  const parts = zonedDate(ms, timeZone);
  const wholeSecond = Math.floor(ms / 1000) * 1000;
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    wholeSecond
  );
}

function civilKey(date: CivilDate): number {
  return date.year * 10_000 + date.month * 100 + date.day;
}

function localKey(ms: number, timeZone: string): number {
  return civilKey(zonedDate(ms, timeZone));
}

function addDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * DAY_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** 本地日期的 00:00（夏令时跳过午夜时取当日第一个存在时刻）。 */
function startOfDayMs(date: CivilDate, zone: TimelineZone): number {
  const civil = Date.UTC(date.year, date.month - 1, date.day);
  if (!zone.timeZone) return civil - zone.offsetMinutes * MINUTE_MS;
  const key = civilKey(date);
  let candidate = civil - offsetMsAt(civil, zone.timeZone);
  candidate = civil - offsetMsAt(candidate, zone.timeZone);
  if (localKey(candidate, zone.timeZone) === key) return candidate;
  let low = candidate - 2 * DAY_MS;
  let high = candidate + 2 * DAY_MS;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (localKey(middle, zone.timeZone) >= key) high = middle;
    else low = middle + 1;
  }
  return low;
}

function dateParts(ms: number, zone: TimelineZone): CivilDate & { weekday: number } {
  if (!zone.timeZone) {
    const date = new Date(ms + zone.offsetMinutes * MINUTE_MS);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    return { year, month, day, weekday: weekdayOf(year, month, day) };
  }
  return zonedDate(ms, zone.timeZone);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function isoWeek(date: CivilDate): { year: number; week: number } {
  const thursday = addDays(date, 3);
  const week =
    Math.floor(
      (Date.UTC(thursday.year, thursday.month - 1, thursday.day) -
        Date.UTC(thursday.year, 0, 1)) /
        DAY_MS /
        7,
    ) + 1;
  return { year: thursday.year, week };
}

export function timelineRange(
  ms: number,
  granularity: TimelineGranularity,
  zone: TimelineZone,
): TimelineRange {
  const parts = dateParts(ms, zone);
  if (granularity === 'day') {
    const next = addDays(parts, 1);
    return {
      key: `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`,
      label: `${parts.year}年${parts.month}月${parts.day}日`,
      start: new Date(startOfDayMs(parts, zone)).toISOString(),
      end: new Date(startOfDayMs(next, zone)).toISOString(),
    };
  }
  if (granularity === 'week') {
    const weekStart = addDays(parts, -(parts.weekday || 7) + 1);
    const weekEnd = addDays(weekStart, 7);
    const week = isoWeek(weekStart);
    return {
      key: `${week.year}-W${pad2(week.week)}`,
      label: `${week.year}年第${week.week}周`,
      start: new Date(startOfDayMs(weekStart, zone)).toISOString(),
      end: new Date(startOfDayMs(weekEnd, zone)).toISOString(),
    };
  }
  const monthStart: CivilDate = { year: parts.year, month: parts.month, day: 1 };
  const nextMonth = new Date(Date.UTC(parts.year, parts.month, 1));
  const monthEnd: CivilDate = {
    year: nextMonth.getUTCFullYear(),
    month: nextMonth.getUTCMonth() + 1,
    day: 1,
  };
  return {
    key: `${parts.year}-${pad2(parts.month)}`,
    label: `${parts.year}年${parts.month}月`,
    start: new Date(startOfDayMs(monthStart, zone)).toISOString(),
    end: new Date(startOfDayMs(monthEnd, zone)).toISOString(),
  };
}

/**
 * 数据展示单源纯函数：时间、计数、入口摘要、文件大小与 MIME 友好名。
 *
 * 只做展示归一化，不读写 localStorage、不访问网络、不注册定时器，也不修改
 * 任何业务状态。调用方可以注入 `now` 与 `timeZone`，便于单测固定边界。
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** ECMAScript Date 可表示的最大时间戳（±8.64e15 ms），超出后 `toISOString()` 抛错。 */
const MAX_DATE_MS = 8.64e15;

export type DisplayTimeValue = string | number | Date | null | undefined;

export type DisplayTimeMode = 'compact' | 'detail';

export interface DisplayTimeOptions {
  /** 相对时间的参照点；默认 `Date.now()`。 */
  now?: number | Date;
  /** detail：24 小时内相对，否则绝对；compact：会话列表口径。 */
  mode?: DisplayTimeMode;
  /** IANA 时区；默认本机时区。无效时区回退本机时区。 */
  timeZone?: string;
}

export interface DisplayTimeResult {
  /** 展示值；无效输入为空串，绝不伪装成 0 或刚刚。 */
  display: string;
  /** 完整本地时间，例如 `2026年11月17日 16:10`；无效输入为空串。 */
  full: string;
  /** ISO 时间；无效输入为 null。 */
  iso: string | null;
  /** 解析后的毫秒时间戳；无效输入为 null。 */
  timestamp: number | null;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 只接受 Date 范围内的正数时间戳；0、负数、NaN、Infinity 与不可解析文本都视为未知。 */
function parseTimestamp(value: DisplayTimeValue): number | null {
  let ms: number;
  if (typeof value === 'number') {
    ms = value;
  } else if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    const numeric = Number(text);
    ms = Number.isFinite(numeric) ? numeric : Date.parse(text);
  } else {
    return null;
  }
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_DATE_MS) return null;
  return Math.trunc(ms);
}

function parseNow(value: DisplayTimeOptions['now']): number {
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS) {
    return value;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS) return ms;
  }
  return Date.now();
}

function localParts(date: Date): ZonedDateParts {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

function zonedParts(timestamp: number, timeZone: string | undefined): ZonedDateParts {
  const date = new Date(timestamp);
  if (!timeZone) return localParts(date);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    const parts: Record<string, string> = {};
    for (const part of formatter.formatToParts(date)) {
      if (part.type !== 'literal') parts[part.type] = part.value;
    }
    const read = (type: string): number => Number(parts[type] ?? 0);
    return {
      year: read('year'),
      month: read('month'),
      day: read('day'),
      hour: read('hour'),
      minute: read('minute'),
    };
  } catch {
    return localParts(date);
  }
}

/** 用 UTC 日序号比较时区内的“今天/昨天”，避开本地 DST 的 23/25 小时日。 */
function dayIndex(parts: ZonedDateParts): number {
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS);
}

function dateTimeLabel(parts: ZonedDateParts): string {
  return `${parts.month}月${parts.day}日 ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function detailLabel(
  parts: ZonedDateParts,
  nowParts: ZonedDateParts,
  now: number,
  timestamp: number,
): string {
  const elapsed = now - timestamp;
  if (elapsed >= 0 && elapsed < DAY_MS) {
    const minutes = Math.floor(elapsed / MINUTE_MS);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    return `${Math.floor(elapsed / HOUR_MS)} 小时前`;
  }
  const year = parts.year === nowParts.year ? '' : `${parts.year}年`;
  return `${year}${dateTimeLabel(parts)}`;
}

function compactLabel(parts: ZonedDateParts, nowParts: ZonedDateParts): string {
  const delta = dayIndex(nowParts) - dayIndex(parts);
  if (delta === 0) return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  if (delta === 1) return '昨天';
  if (parts.year === nowParts.year) return `${parts.month}/${parts.day}`;
  return `${parts.year}/${parts.month}/${parts.day}`;
}

/**
 * 统一时间展示。
 *
 * - detail：24 小时内 `刚刚` / `N 分钟前` / `N 小时前`，否则 `11月17日 16:10`
 *   （跨年补年份）。
 * - compact：保留会话列表既有口径，今天 `16:10`、昨天 `昨天`、同年 `11/17`。
 * - 未知时间返回空展示值；未来时间走绝对格式，不伪装成 `刚刚`。
 */
export function formatDisplayTime(
  value: DisplayTimeValue,
  options: DisplayTimeOptions = {},
): DisplayTimeResult {
  const timestamp = parseTimestamp(value);
  if (timestamp === null) {
    return { display: '', full: '', iso: null, timestamp: null };
  }
  const now = parseNow(options.now);
  const parts = zonedParts(timestamp, options.timeZone);
  const nowParts = zonedParts(now, options.timeZone);
  const display =
    (options.mode ?? 'detail') === 'compact'
      ? compactLabel(parts, nowParts)
      : detailLabel(parts, nowParts, now, timestamp);
  return {
    display,
    full: `${parts.year}年${dateTimeLabel(parts)}`,
    iso: new Date(timestamp).toISOString(),
    timestamp,
  };
}

export type CountValue = string | number | null | undefined;

export interface CountLabelOptions {
  /** 数量为 1 时替换单位，例如英文 `agent`；中文通常不需要。 */
  singularUnit?: string;
  /** 数量为 0 时替换整个文案；默认显示 `0 {unit}`。 */
  zeroLabel?: string;
  /** 未知值文案；默认省略（空串）。 */
  unknownLabel?: string;
}

/** 计数只接受有限非负数；非法值返回 null，交给调用方省略或显示未知。 */
export function normalizeCount(value: CountValue): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(count) || count < 0) return null;
  return Math.trunc(count);
}

/** 带单位计数：`3 条消息`、`2 个 Agent`；0 显示 `0 条消息`，未知省略。 */
export function formatCountLabel(
  value: CountValue,
  unit: string,
  options: CountLabelOptions = {},
): string {
  const count = normalizeCount(value);
  if (count === null) return options.unknownLabel ?? '';
  if (count === 0 && options.zeroLabel !== undefined) return options.zeroLabel;
  const label = count === 1 && options.singularUnit !== undefined ? options.singularUnit : unit;
  const trimmed = label.trim();
  return trimmed ? `${count} ${trimmed}` : String(count);
}

export interface EntryCountOptions {
  /** 只用于入口限幅；超过时显示 `{cap}+`。 */
  cap?: number;
}

/** 入口计数：未知为空串，超过上限显示 `{cap}+`。 */
export function formatEntryCount(
  value: CountValue,
  options: EntryCountOptions = {},
): string {
  const count = normalizeCount(value);
  if (count === null) return '';
  const cap = options.cap;
  if (cap !== undefined && Number.isFinite(cap) && cap >= 0 && count > Math.trunc(cap)) {
    return `${Math.trunc(cap)}+`;
  }
  return String(count);
}

export interface EntryMetaInput {
  messageCount?: CountValue;
  agentCount?: CountValue;
  time?: DisplayTimeValue;
  now?: number | Date;
  timeZone?: string;
  mode?: DisplayTimeMode;
}

/** 固定顺序 `N 条消息 · N 个 Agent · 时间`；未知项整段省略。 */
export function formatEntryMeta(input: EntryMetaInput = {}): string {
  const parts = [
    formatCountLabel(input.messageCount, '条消息'),
    formatCountLabel(input.agentCount, '个 Agent'),
    formatDisplayTime(input.time, {
      now: input.now,
      mode: input.mode ?? 'detail',
      timeZone: input.timeZone,
    }).display,
  ];
  return parts.filter((part) => part.length > 0).join(' · ');
}

/** `N 个 Agent 参与`；未知值省略。 */
export function formatParticipantCount(
  value: CountValue,
  options: CountLabelOptions = {},
): string {
  return formatCountLabel(value, '个 Agent 参与', options);
}

/** MIME 归一化：小写、去参数、去首尾空白。 */
export function normalizeMimeType(value: string | null | undefined): string {
  return String(value ?? '').toLowerCase().split(';')[0]?.trim() ?? '';
}

/** MIME 友好名；空值省略，未知类型回退为“文件”。 */
export function mimeFriendlyName(value: string | null | undefined): string {
  const mime = normalizeMimeType(value);
  if (!mime) return '';
  if (mime === 'application/pdf') return 'PDF';
  if (mime === 'text/html') return 'HTML';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'Markdown';
  if (mime === 'image/svg+xml' || mime === 'image/svg') return 'SVG';
  if (mime.startsWith('image/')) return '图片';
  if (mime.startsWith('audio/')) return '音频';
  if (mime.startsWith('video/')) return '视频';
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return '文本';
  }
  return '文件';
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * 文件大小：沿用既有 B/KB/MB 算法与舍入，只统一空值语义。
 *
 * `null` / `undefined` / 空串 / 非数字 / 负数返回空串；合法 0 显示 `0 B`。
 */
export function formatByteSize(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' && value.trim() === '') return '';
  if (typeof value !== 'number' && typeof value !== 'string') return '';
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${Math.round(size)} B`;
  let amount = size / 1024;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const rounded = amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unitIndex]!}`;
}

/**
 * MCP Events 阶段日志。
 *
 * 只允许记录标识、阶段、耗时、结果与原因：
 * - 不记录 Bearer、delivery.secret、签名、完整 callback URL 或事件正文；
 * - callback 只记录 host，用于区分目标；
 * - request_id 使用 JSON-RPC id，订阅阶段附 subscription_id 便于串联；
 * - 每行同时写入 stdout/journald 与可选的 `EVENTS_LOG_FILE`。
 */

import { writeEventsLogLine } from './log-file';

export type EventsLogValue = string | number | boolean | null | undefined | string[];

export interface EventsLogFields {
  [key: string]: EventsLogValue;
}

export type EventsLogLevel = 'info' | 'warn' | 'error';

const PREFIX = 'agent-network events';

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>]+/giu;
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\bwhsec_[A-Za-z0-9+/=_-]+/gu, '[redacted-secret]'],
  [/\bank_[A-Za-z0-9_-]{8,}/gu, '[redacted-token]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]'],
  [/\bv1,[A-Za-z0-9+/=]+/gu, 'v1,[redacted]'],
];

const SENSITIVE_KEYS = new Set([
  'authorization',
  'body',
  'callback_url',
  'challenge',
  'cookie',
  'payload',
  'secret',
  'signature',
  'token',
  'url',
  'webhook-signature',
  'webhook_signature',
]);

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith('_secret') ||
    normalized.endsWith('_token') ||
    normalized.endsWith('_signature')
  );
}

/**
 * 诊断文本脱敏：去掉完整 URL、secret/签名形态，压缩控制字符并截断。
 * 只用于日志与错误对象的 message，绝不回写协议响应。
 */
export function sanitizeDiagnosticText(input: string, maxLength = 240): string {
  let text = input.replace(URL_PATTERN, '[redacted-url]');
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.replace(/[\u0000-\u001F\u007F]+/gu, ' ').slice(0, maxLength);
}

function sanitizeValue(value: EventsLogValue): EventsLogValue {
  if (typeof value === 'string') return sanitizeDiagnosticText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticText(item));
  return value;
}

function emit(level: EventsLogLevel, stage: string, fields: EventsLogFields): void {
  const record: Record<string, unknown> = {
    level,
    stage,
    at: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    record[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeValue(value);
  }
  const line = `${PREFIX} ${JSON.stringify(record)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  try {
    writeEventsLogLine(line);
  } catch {
    // 文件 sink 自身 fail-open；这里再兜底，确保不影响请求。
  }
}

export function logEventsInfo(stage: string, fields: EventsLogFields = {}): void {
  emit('info', stage, fields);
}

export function logEventsWarn(stage: string, fields: EventsLogFields = {}): void {
  emit('warn', stage, fields);
}

export function logEventsError(stage: string, fields: EventsLogFields = {}): void {
  emit('error', stage, fields);
}

export interface EventsLogger {
  readonly method: string;
  readonly requestId: string | number | null;
  info(stage: string, fields?: EventsLogFields): void;
  warn(stage: string, fields?: EventsLogFields): void;
  error(stage: string, fields?: EventsLogFields): void;
}

/** 一次 JSON-RPC 请求的阶段日志；所有行都带 method 与 request_id。 */
export function createEventsLogger(
  method: string,
  requestId?: string | number | null,
): EventsLogger {
  const base: EventsLogFields = {
    method,
    request_id: requestId ?? null,
  };
  return {
    method,
    requestId: requestId ?? null,
    info: (stage, fields = {}) => logEventsInfo(stage, { ...base, ...fields }),
    warn: (stage, fields = {}) => logEventsWarn(stage, { ...base, ...fields }),
    error: (stage, fields = {}) => logEventsError(stage, { ...base, ...fields }),
  };
}

/** 不输出日志的默认实现，供内部调用与测试复用。 */
export function silentEventsLogger(method = 'events'): EventsLogger {
  return {
    method,
    requestId: null,
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

/** 仅提取 callback host；任何解析失败都返回 null，绝不回显完整 URL。 */
export function callbackHostOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/** 安全提取对象；日志与参数解析共用。 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

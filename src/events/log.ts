/**
 * MCP Events 阶段日志。
 *
 * 只允许记录标识、阶段、耗时、结果与原因：
 * - 不记录 Bearer、delivery.secret、签名、完整 callback URL 或事件正文；
 * - callback 只记录 host，用于区分目标；
 * - request_id 使用 JSON-RPC id，订阅阶段附 subscription_id 便于串联。
 */

export type EventsLogValue = string | number | boolean | null | undefined | string[];

export interface EventsLogFields {
  [key: string]: EventsLogValue;
}

export type EventsLogLevel = 'info' | 'warn' | 'error';

const PREFIX = 'agent-network events';

function emit(level: EventsLogLevel, stage: string, fields: EventsLogFields): void {
  const record: Record<string, unknown> = {
    level,
    stage,
    at: new Date().toISOString(),
  };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    record[key] = value;
  }
  const line = `${PREFIX} ${JSON.stringify(record)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
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

/** 输出约定：默认人类可读，`--json` 输出完整结果供脚本消费。 */

import type { ResolvedConfig } from './mcp';

export function emit<T>(
  config: ResolvedConfig,
  value: T,
  human: (value: T) => void,
): void {
  if (config.json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  human(value);
}

export function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

export function field(name: string, value: unknown): string {
  return `${name}=${value === null || value === undefined ? '-' : String(value)}`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 截断长文本，不改变 CLI 的字段语义。 */
export function shorten(text: string, max = 120): string {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

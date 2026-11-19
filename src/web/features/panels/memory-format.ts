import { formatByteSize, formatDisplayTime } from '../../lib/display-format';
import type { McpError } from '../../lib/mcp-client';

export type MemoryRecord = Record<string, unknown>;

export const EVIDENCE: Record<string, string> = {
  host_reported_submitted: '宿主报告已提交',
  gateway_observed_submitted: '网关观察已提交',
  served: '已交付',
};

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value ? value : fallback;
}

export function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 文件大小走 S2 单源；未知值显示“大小未知”，不伪装 0 B。 */
export function bytes(value: unknown): string {
  return formatByteSize(value) || '大小未知';
}

/** 时间走 S2 detail 口径；无效/非正时间显示 `—`，不落回 1970。 */
export function time(value: unknown): string {
  const input = typeof value === 'string' || typeof value === 'number' || value instanceof Date
    ? value
    : null;
  return formatDisplayTime(input, { mode: 'detail' }).display || '—';
}

export function excerpt(value: unknown, max = 160): string {
  const raw = String(value ?? '').replace(/\s+/gu, ' ').trim();
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

export function shortHash(value: unknown): string {
  const raw = text(value);
  return raw.length > 16 ? `${raw.slice(0, 8)}…${raw.slice(-4)}` : raw;
}

export function failureText(failure: unknown): string {
  return (failure as McpError)?.message || String(failure);
}

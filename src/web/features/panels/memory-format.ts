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

export function bytes(value: unknown): string {
  const size = num(value, 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function time(value: unknown): string {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleString('zh-CN') : '';
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

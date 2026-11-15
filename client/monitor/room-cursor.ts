/**
 * reconnect 补读游标的本地推进。
 *
 * 服务端 after 游标正常已经指向本页最后一条 `created_seq`；这里仍按本页
 * 最后一条消息推进，兼容旧服务端返回滞后的 `next_cursor`，并保证游标
 * 不后退。游标是版本化 base64url JSON，无法解析时保持原样。
 */

import type { JsonObject } from './rpc';

interface HistoryCursorPayload {
  seq: number;
  snapshot: number;
  [key: string]: unknown;
}

function decodeHistoryCursor(value: string): HistoryCursorPayload | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.seq !== 'number' || !Number.isFinite(record.seq)) return null;
    if (typeof record.snapshot !== 'number' || !Number.isFinite(record.snapshot)) return null;
    return record as HistoryCursorPayload;
  } catch {
    return null;
  }
}

function encodeHistoryCursor(payload: HistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** 本页最大的 `created_seq`；用于补偿服务端未前进的游标。 */
export function lastHistorySeq(items: readonly JsonObject[]): number {
  let max = 0;
  for (const item of items) {
    const raw = item.created_seq ?? item.seq;
    const seq = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0;
    if (Number.isSafeInteger(seq) && seq > max) max = seq;
  }
  return max;
}

/**
 * 计算下一游标：至少推进到本页最后一条消息，且不低于当前游标。
 *
 * 保留服务端游标的 scope/dir/snapshot 等字段；服务端游标已前进时原样返回。
 */
export function advanceHistoryCursor(
  current: string | null,
  next: string,
  items: readonly JsonObject[],
): string {
  const lastSeq = lastHistorySeq(items);
  const nextPayload = next.length > 0 ? decodeHistoryCursor(next) : null;
  const currentPayload =
    current !== null && current.length > 0 ? decodeHistoryCursor(current) : null;
  const base = nextPayload ?? currentPayload;
  if (base === null) return next.length > 0 ? next : (current ?? '');

  const target = Math.max(lastSeq, base.seq, currentPayload?.seq ?? 0);
  if (nextPayload !== null && nextPayload.seq >= target) return next;
  return encodeHistoryCursor({ ...base, seq: target });
}

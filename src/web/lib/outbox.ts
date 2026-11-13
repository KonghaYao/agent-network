import { LIMITS } from '../../contracts/limits';

/**
 * 浏览器发送意图（outbox）的持久化模型。
 *
 * 与 legacy 共用 `agent-network-outbox:v1:<actor_id>` key，避免灰度切换
 * 时丢掉用户在另一套页面里没发出去的消息。token、正文预览都不写日志。
 */

const OUTBOX_PREFIX = 'agent-network-outbox:v1:';

export type OutboxStatus = 'sending' | 'committed' | 'failed';

export interface OutboxIntent {
  client_message_id: string;
  request_id: string;
  room_id: string;
  body: string;
  reply_to: string | null;
  reply_version: string | null;
  invoke: string[];
  mentions: string[];
  invoke_explicit: boolean;
  status: OutboxStatus;
  retryable: boolean;
  error: string;
  attempt: number;
  created_at: number;
  updated_at: number;
  message_id?: string | null;
  delivery_ids?: string[];
  created_seq?: string | null;
  committed_at?: number;
}

const RETRYABLE_CODES = new Set(['RATE_LIMITED', 'CONFLICT', 'DRIVE_UNAVAILABLE']);

function storageKey(actorId: string): string {
  return `${OUTBOX_PREFIX}${actorId}`;
}

function isIntent(value: unknown): value is OutboxIntent {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<OutboxIntent>;
  return (
    typeof item.client_message_id === 'string' &&
    typeof item.request_id === 'string' &&
    typeof item.room_id === 'string' &&
    typeof item.body === 'string' &&
    Array.isArray(item.invoke) &&
    (item.status === 'sending' || item.status === 'committed' || item.status === 'failed')
  );
}

/** 只保留当前 actor 的意图；过期与超量条目在上限内截断。 */
export function pruneOutbox(items: OutboxIntent[], now = Date.now()): OutboxIntent[] {
  const kept = items.filter((item) => {
    if (!isIntent(item)) return false;
    if (item.status === 'committed') {
      const at = item.committed_at ?? item.updated_at;
      return now - at <= LIMITS.webOutboxCommittedMs;
    }
    return now - item.updated_at <= LIMITS.webOutboxTtlMs;
  });
  return kept.slice(Math.max(0, kept.length - LIMITS.webOutboxMax));
}

export function readOutbox(actorId: string, now = Date.now()): OutboxIntent[] {
  try {
    const raw = localStorage.getItem(storageKey(actorId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return pruneOutbox(parsed as OutboxIntent[], now);
  } catch {
    return [];
  }
}

export function writeOutbox(actorId: string, items: OutboxIntent[]): void {
  try {
    const key = storageKey(actorId);
    const pruned = pruneOutbox(items);
    if (pruned.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(pruned));
  } catch {
    // 隐私模式禁用存储时只影响跨刷新恢复，不阻塞当前发送。
  }
}

export function newRequestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function createOutboxIntent(input: {
  roomId: string;
  body: string;
  invoke: string[];
  mentions: string[];
  invokeExplicit: boolean;
  replyTo: string | null;
}): OutboxIntent {
  const at = Date.now();
  return {
    client_message_id: crypto.randomUUID(),
    request_id: newRequestId('web_msg'),
    room_id: input.roomId,
    body: input.body,
    reply_to: input.replyTo,
    reply_version: input.replyTo ? newRequestId('quote') : null,
    invoke: input.invoke.slice(),
    mentions: input.mentions.slice(),
    invoke_explicit: input.invokeExplicit,
    status: 'sending',
    retryable: false,
    error: '',
    attempt: 1,
    created_at: at,
    updated_at: at,
  };
}

function invokeKey(invoke: string[], mentions: string[], explicit: boolean): string {
  return `${explicit ? 'explicit' : 'omit'}:${invoke.slice().sort().join(',')}|${mentions
    .slice()
    .sort()
    .join(',')}`;
}

/** 同房间、同正文、同目标的失败意图复用原 ID，避免响应丢失后重复发送。 */
export function findReusableIntent(
  items: OutboxIntent[],
  input: {
    roomId: string;
    body: string;
    invoke: string[];
    mentions: string[];
    invokeExplicit: boolean;
    replyTo: string | null;
  },
): OutboxIntent | null {
  const key = invokeKey(input.invoke, input.mentions, input.invokeExplicit);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.room_id !== input.roomId || item.status !== 'failed' || !item.retryable) {
      continue;
    }
    if (item.body !== input.body) continue;
    if ((item.reply_to ?? null) !== (input.replyTo ?? null)) continue;
    const explicit = item.invoke_explicit === true || item.invoke.length > 0;
    if (invokeKey(item.invoke, item.mentions ?? [], explicit) !== key) continue;
    return item;
  }
  return null;
}

export function isRetryableError(error: { code?: string; message?: string } | null): boolean {
  if (!error || !error.code) return true;
  return RETRYABLE_CODES.has(error.code);
}

export function outboxPreview(body: string): string {
  const text = body.replace(/\s+/gu, ' ').trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export function updateIntent(
  items: OutboxIntent[],
  clientMessageId: string,
  patch: Partial<OutboxIntent>,
): OutboxIntent[] {
  return items.map((item) => {
    if (item.client_message_id !== clientMessageId) return item;
    return { ...item, ...patch, updated_at: Date.now() };
  });
}

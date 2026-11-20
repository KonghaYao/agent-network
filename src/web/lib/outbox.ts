import { LIMITS } from '../../contracts/limits';

/**
 * 浏览器发送意图（outbox）的持久化模型。
 *
 * 与 legacy 共用 `agent-network-outbox:v1:<actor_id>` key，避免灰度切换
 * 时丢掉用户在另一套页面里没发出去的消息。token、正文预览都不写日志。
 */

const OUTBOX_PREFIX = 'agent-network-outbox:v1:';
const JOURNAL_SEGMENT = ':i:';

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

/** 只依赖 Storage 的最小接口；单元测试注入内存实现。 */
export interface OutboxStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

interface JournalEntry {
  v?: number;
  updated_at: number;
  intent?: OutboxIntent | null;
  deleted?: boolean;
}

const RETRYABLE_CODES = new Set(['RATE_LIMITED', 'CONFLICT', 'DRIVE_UNAVAILABLE']);

function storageKey(actorId: string): string {
  return `${OUTBOX_PREFIX}${actorId}`;
}

function journalPrefix(actorId: string): string {
  return `${storageKey(actorId)}${JOURNAL_SEGMENT}`;
}

export function outboxStorageKey(actorId: string): string {
  return storageKey(actorId);
}

/** 同一 actor 的旧整份键与按意图 journal 键。 */
export function isOutboxStorageKey(actorId: string, key: string | null): boolean {
  if (!key) return false;
  return key === storageKey(actorId) || key.startsWith(journalPrefix(actorId));
}

function defaultStorage(): OutboxStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
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

export function isOutboxIntentExpired(intent: OutboxIntent, now = Date.now()): boolean {
  if (intent.status === 'committed') {
    return now - (intent.committed_at ?? intent.updated_at) > LIMITS.webOutboxCommittedMs;
  }
  return now - intent.updated_at > LIMITS.webOutboxTtlMs;
}

function readLegacy(actorId: string, storage: OutboxStorage): OutboxIntent[] {
  try {
    const raw = storage.getItem(storageKey(actorId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as OutboxIntent[]).filter(isIntent) : [];
  } catch {
    return [];
  }
}

function readJournal(actorId: string, storage: OutboxStorage): Map<string, JournalEntry> {
  const entries = new Map<string, JournalEntry>();
  const prefix = journalPrefix(actorId);
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const clientMessageId = key.slice(prefix.length);
      const raw = storage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as JournalEntry;
        if (!parsed || typeof parsed.updated_at !== 'number') continue;
        if (parsed.deleted === true) {
          entries.set(clientMessageId, { updated_at: parsed.updated_at, deleted: true });
          continue;
        }
        if (!isIntent(parsed.intent)) continue;
        entries.set(clientMessageId, { updated_at: parsed.updated_at, intent: parsed.intent });
      } catch {
        // 单条损坏只影响该意图。
      }
    }
  } catch {
    return entries;
  }
  return entries;
}

/**
 * 读取旧整份镜像与按意图 journal 的并集。
 *
 * 旧 key 继续可读；同 id 以 `updated_at` 较新者为准，删除用 tombstone
 * 阻止旧镜像复活。双标签各自更新自己的意图，不需要整份覆盖写。
 */
export function readOutbox(
  actorId: string,
  now = Date.now(),
  storage: OutboxStorage | null = defaultStorage(),
): OutboxIntent[] {
  if (!storage) return [];
  const records = new Map<string, { intent: OutboxIntent | null; at: number }>();
  for (const intent of readLegacy(actorId, storage)) {
    records.set(intent.client_message_id, { intent, at: intent.updated_at });
  }
  for (const [id, entry] of readJournal(actorId, storage)) {
    const existing = records.get(id);
    if (existing && existing.at > entry.updated_at) continue;
    records.set(id, {
      intent: entry.deleted === true ? null : entry.intent ?? null,
      at: entry.updated_at,
    });
  }
  const merged: OutboxIntent[] = [];
  for (const record of records.values()) {
    if (record.intent && isIntent(record.intent)) merged.push(record.intent);
  }
  merged.sort((left, right) => {
    const byTime = left.created_at - right.created_at;
    return byTime !== 0 ? byTime : left.client_message_id.localeCompare(right.client_message_id);
  });
  return pruneOutbox(merged, now);
}

function writeJournal(
  actorId: string,
  storage: OutboxStorage,
  clientMessageId: string,
  entry: JournalEntry,
): boolean {
  try {
    const existing = readJournal(actorId, storage).get(clientMessageId);
    if (existing && existing.updated_at > entry.updated_at) return false;
    storage.setItem(
      `${journalPrefix(actorId)}${clientMessageId}`,
      JSON.stringify({ v: 1, ...entry }),
    );
    return true;
  } catch {
    return false;
  }
}

function writeMirror(
  actorId: string,
  storage: OutboxStorage,
  incoming: OutboxIntent[],
  tombstones: Set<string>,
  now: number,
): void {
  const mirror = new Map<string, OutboxIntent>();
  for (const intent of readLegacy(actorId, storage)) {
    mirror.set(intent.client_message_id, intent);
  }
  for (const intent of incoming) {
    const existing = mirror.get(intent.client_message_id);
    if (!existing || intent.updated_at >= existing.updated_at) {
      mirror.set(intent.client_message_id, intent);
    }
  }
  for (const id of tombstones) mirror.delete(id);
  const pruned = pruneOutbox([...mirror.values()], now);
  try {
    if (pruned.length === 0) storage.removeItem(storageKey(actorId));
    else storage.setItem(storageKey(actorId), JSON.stringify(pruned));
  } catch {
    // 隐私模式/配额不足只影响旧客户端兼容镜像，不影响 journal。
  }
}

/**
 * 按意图原子更新，并维护旧整份镜像。
 *
 * - 只写传入意图的 journal 键，不会用本标签页的列表覆盖其他标签页；
 * - 已提交或过期的 journal 条目写 tombstone，避免旧镜像复活；
 * - 其他标签页尚未同步的 pending 意图不会被本标签页误删。
 */
export function writeOutbox(
  actorId: string,
  items: OutboxIntent[],
  options: { now?: number; storage?: OutboxStorage | null } = {},
): void {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return;
  const now = options.now ?? Date.now();
  const pruned = pruneOutbox(items, now);
  const journal = readJournal(actorId, storage);
  const incomingIds = new Set(pruned.map((item) => item.client_message_id));
  const tombstones = new Set<string>();
  const written: OutboxIntent[] = [];

  for (const intent of pruned) {
    const existing = journal.get(intent.client_message_id);
    if (existing && existing.updated_at > intent.updated_at) continue;
    if (writeJournal(actorId, storage, intent.client_message_id, {
      updated_at: intent.updated_at,
      intent,
    })) {
      written.push(intent);
    }
  }

  for (const [id, entry] of journal) {
    if (incomingIds.has(id) || entry.deleted === true) continue;
    const intent = entry.intent;
    if (!intent) continue;
    if (intent.status === 'committed' || isOutboxIntentExpired(intent, now)) {
      writeJournal(actorId, storage, id, { updated_at: now, deleted: true });
      tombstones.add(id);
    }
  }
  writeMirror(actorId, storage, written, tombstones, now);
}

/** 用户明确删除/已展示后清理：写 tombstone，旧镜像同样移除。 */
export function removeOutboxIntent(
  actorId: string,
  clientMessageId: string,
  options: { now?: number; storage?: OutboxStorage | null } = {},
): void {
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return;
  const now = options.now ?? Date.now();
  writeJournal(actorId, storage, clientMessageId, { updated_at: now, deleted: true });
  writeMirror(actorId, storage, [], new Set([clientMessageId]), now);
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
  now = Date.now(),
): OutboxIntent | null {
  const key = invokeKey(input.invoke, input.mentions, input.invokeExplicit);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item || item.room_id !== input.roomId || item.status !== 'failed' || !item.retryable) {
      continue;
    }
    if (isOutboxIntentExpired(item, now)) continue;
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

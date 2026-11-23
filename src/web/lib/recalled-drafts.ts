/**
 * 已撤回消息的本地原文副本。
 *
 * 撤回后服务端会清空 `body` 并写墓碑，原文只能来自本机留存：
 * - 发送成功时按 actor 保存输入框里的纯文本；
 * - 本人撤回前若本机没有副本，会临时读取服务端正文并保存（覆盖更新前、
 *   其他标签页发送的消息），读取失败或超时不影响撤回本身。
 * 副本按 actor 分 key 写入 sessionStorage：
 * - 不落 localStorage，刷新/关闭标签页后不保证保留；
 * - 单条 16KB、最多 30 条、总计 128KB，超限先丢最旧；
 * - 存储不可用（隐私模式/配额不足）时静默降级，绝不影响发送或撤回；
 * - 读取时校验信封里的 actor_id，与当前 actor 不一致直接丢弃。
 */

import { extractMessageFileLinks, MESSAGE_FILE_ID_SOURCE } from '../../contracts/file-links';

const PREFIX = 'agent-network-recalled-drafts:v1:';

/** 单条正文 UTF-8 上限；超过则不缓存，避免恢复出不完整的正文。 */
export const RECALLED_DRAFT_BODY_MAX_BYTES = 16 * 1024;
/** 单个 actor 最多保留的条数。 */
export const RECALLED_DRAFT_MAX_ITEMS = 30;
/** 单个 actor 的缓存总字节上限。 */
export const RECALLED_DRAFT_TOTAL_MAX_BYTES = 128 * 1024;

/** 只依赖 Storage 的最小接口；单元测试注入内存实现。 */
export interface RecalledDraftStorage {
  readonly length: number;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
}

export interface RecalledDraftEntry {
  message_id: string;
  body: string;
  /** 正文 UTF-8 字节数；读取时按实际正文重算，不信任存储值。 */
  bytes: number;
  saved_at: number;
}

interface Envelope {
  v: 1;
  actor_id: string;
  items: RecalledDraftEntry[];
}

const textEncoder = new TextEncoder();

/** 任意 origin / 相对路径的 `/f/<fileId>`；附件链接不进入撤回副本。 */
const FILE_LINK_ANY_ORIGIN = new RegExp(`/f/${MESSAGE_FILE_ID_SOURCE}(?![A-Za-z0-9_-])`, 'u');

function byteLength(text: string): number {
  return textEncoder.encode(text).length;
}

/**
 * 判断一段正文能否作为撤回副本。
 *
 * 空正文、含附件链接（重新编辑不恢复附件）或超过单条上限时返回 null；
 * 发送留存与撤回前读取共用同一规则，避免两条路径对附件处理不一致。
 */
export function cacheableRecalledDraftBody(
  body: string,
  origin: string | null = typeof window === 'undefined' ? null : window.location.origin,
): string | null {
  if (!body.trim()) return null;
  if (origin && extractMessageFileLinks(body, origin).length > 0) return null;
  if (FILE_LINK_ANY_ORIGIN.test(body)) return null;
  return byteLength(body) <= RECALLED_DRAFT_BODY_MAX_BYTES ? body : null;
}

function defaultStorage(): RecalledDraftStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function storageKey(actorId: string): string {
  return `${PREFIX}${actorId}`;
}

/** 缓存变化的模块级修订号；React 通过 useSyncExternalStore 订阅。 */
let revision = 0;
const listeners = new Set<() => void>();

export function subscribeRecalledDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recalledDraftsRevision(): number {
  return revision;
}

function emit(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

function sanitizeItems(value: unknown): RecalledDraftEntry[] {
  if (!Array.isArray(value)) return [];
  const items: RecalledDraftEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<RecalledDraftEntry>;
    if (typeof item.message_id !== 'string' || !item.message_id) continue;
    if (typeof item.body !== 'string' || !item.body.trim()) continue;
    const bytes = byteLength(item.body);
    if (bytes > RECALLED_DRAFT_BODY_MAX_BYTES) continue;
    if (items.some((existing) => existing.message_id === item.message_id)) continue;
    items.push({
      message_id: item.message_id,
      body: item.body,
      bytes,
      saved_at: typeof item.saved_at === 'number' ? item.saved_at : 0,
    });
  }
  return items;
}

function readEnvelope(
  actorId: string | null,
  storage: RecalledDraftStorage | null,
): Envelope | null {
  if (!actorId || !storage) return null;
  try {
    const raw = storage.getItem(storageKey(actorId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Envelope> | null;
    if (!parsed || parsed.v !== 1 || parsed.actor_id !== actorId) return null;
    return { v: 1, actor_id: actorId, items: sanitizeItems(parsed.items) };
  } catch {
    return null;
  }
}

function writeEnvelope(
  actorId: string,
  items: RecalledDraftEntry[],
  storage: RecalledDraftStorage,
): boolean {
  try {
    if (items.length === 0) storage.removeItem(storageKey(actorId));
    else {
      storage.setItem(
        storageKey(actorId),
        JSON.stringify({ v: 1, actor_id: actorId, items } satisfies Envelope),
      );
    }
    return true;
  } catch {
    // 隐私模式或配额不足：只影响重新编辑入口，不影响发送。
    return false;
  }
}

/** 当前 actor 的缓存副本，按新旧从新到旧排列；只用于测试与调试。 */
export function listRecalledDrafts(
  actorId: string | null,
  storage: RecalledDraftStorage | null = defaultStorage(),
): RecalledDraftEntry[] {
  return readEnvelope(actorId, storage)?.items ?? [];
}

/**
 * 发送成功后留存正文。
 *
 * 同一 message_id 会替换旧副本并移到最前；超出条数或总字节时丢最旧。
 * 空正文、纯空白、超过单条上限或存储不可用时静默忽略。
 */
export function rememberRecalledDraft(
  actorId: string | null,
  messageId: string | null,
  body: string,
  options: { now?: number; storage?: RecalledDraftStorage | null } = {},
): void {
  if (!actorId || !messageId || !body.trim()) return;
  const bytes = byteLength(body);
  if (bytes > RECALLED_DRAFT_BODY_MAX_BYTES) return;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  if (!storage) return;
  const existing = readEnvelope(actorId, storage)?.items ?? [];
  const items = [
    {
      message_id: messageId,
      body,
      bytes,
      saved_at: options.now ?? Date.now(),
    },
    ...existing.filter((item) => item.message_id !== messageId),
  ];
  while (items.length > RECALLED_DRAFT_MAX_ITEMS) items.pop();
  let total = items.reduce((sum, item) => sum + item.bytes, 0);
  while (items.length > 1 && total > RECALLED_DRAFT_TOTAL_MAX_BYTES) {
    const removed = items.pop();
    total -= removed?.bytes ?? 0;
  }
  if (writeEnvelope(actorId, items, storage)) emit();
}

/**
 * 读取某条消息的原文。
 *
 * 信封 actor_id 与入参不一致、正文为空或已超限时返回 null；渲染路径保持
 * 只读，不在读取时写存储，避免 React 渲染副作用。
 */
export function readRecalledDraft(
  actorId: string | null,
  messageId: string,
  storage: RecalledDraftStorage | null = defaultStorage(),
): string | null {
  const envelope = readEnvelope(actorId, storage);
  if (!envelope) return null;
  return envelope.items.find((item) => item.message_id === messageId)?.body ?? null;
}

/** 恢复成功后移除该条，避免反复复活同一份原文。 */
export function forgetRecalledDraft(
  actorId: string | null,
  messageId: string,
  storage: RecalledDraftStorage | null = defaultStorage(),
): void {
  if (!actorId || !storage) return;
  const envelope = readEnvelope(actorId, storage);
  if (!envelope) return;
  const items = envelope.items.filter((item) => item.message_id !== messageId);
  if (items.length === envelope.items.length) return;
  if (writeEnvelope(actorId, items, storage)) emit();
}

/**
 * 身份边界清理。
 *
 * 传入 actor 只删该 actor 的 key；传 null/省略时删除本命名空间下的全部
 * key（退出登录、切号与恢复轮确认身份变化）。
 */
export function clearRecalledDrafts(
  actorId: string | null = null,
  storage: RecalledDraftStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  if (actorId) {
    try {
      storage.removeItem(storageKey(actorId));
    } catch {
      return;
    }
    emit();
    return;
  }
  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(PREFIX)) storage.removeItem(key);
    }
  } catch {
    return;
  }
  emit();
}

/** 测试/诊断用：暴露 key 规则，避免调用方复制前缀。 */
export function recalledDraftStorageKey(actorId: string): string {
  return storageKey(actorId);
}

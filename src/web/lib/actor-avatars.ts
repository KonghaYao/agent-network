import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

/**
 * actor 头像的轻量缓存。
 *
 * 好友列表、会话列表与 `network_room_get` 成员都会带来 `avatar_url`；消息与
 * Task 摘要只持有 actor_id，因此这里把已加载的展示资料汇成一张内存表。
 * 缓存不发起请求、不持有凭据，仅作为缺失头像时的回退来源；权威数据仍在
 * React Query 与 MCP 工具响应里。
 */
export interface ActorAvatarRecord {
  actor_id: string;
  name: string;
  avatar_url: string | null;
}

const records = new Map<string, ActorAvatarRecord>();
let snapshot: ReadonlyMap<string, ActorAvatarRecord> = new Map();
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = new Map(records);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 合并一批来自服务端响应的 actor 展示资料；无变化时不触发重渲染。 */
export function rememberActorAvatars(
  entries: Iterable<ActorAvatarRecord | null | undefined>,
): void {
  let changed = false;
  for (const entry of entries) {
    if (!entry || !entry.actor_id) continue;
    const avatarUrl = entry.avatar_url ?? null;
    const previous = records.get(entry.actor_id);
    if (
      previous &&
      previous.name === entry.name &&
      previous.avatar_url === avatarUrl
    ) {
      continue;
    }
    records.set(entry.actor_id, {
      actor_id: entry.actor_id,
      name: entry.name,
      avatar_url: avatarUrl,
    });
    changed = true;
  }
  if (changed) notify();
}

export function actorAvatarRecord(actorId: string | null | undefined): ActorAvatarRecord | undefined {
  return actorId ? snapshot.get(actorId) : undefined;
}

/** 订阅单个 actor；未缓存或 actor_id 为空时返回 undefined，组件回退首字。 */
export function useActorAvatarRecord(
  actorId: string | null | undefined,
): ActorAvatarRecord | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (actorId ? snapshot.get(actorId) : undefined),
    () => undefined,
  );
}

/** 一次订阅整张表，供 Task 参与者等需要按多个 actor_id 查找的组件使用。 */
export function useActorAvatarMap(): ReadonlyMap<string, ActorAvatarRecord> {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** 退出登录/切换身份时清空，避免把上一个 actor 的记录留在内存。 */
export function clearActorAvatars(): void {
  if (records.size === 0) return;
  records.clear();
  notify();
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const NESTED_KEYS = [
  'items',
  'timeline_items',
  'members',
  'pages',
  'peer',
  'participants',
  'actor',
] as const;

/**
 * 在 React Query 已缓存的数据里就地替换某个 actor 的头像。
 *
 * 头像保存成功后，旧消息、成员缓存与会话 peer 不必等待全部重读就能同步；
 * 只改与 `actor_id`/`sender_id` 匹配的已知展示字段，不触碰正文或权限数据。
 */
function patchValue(value: unknown, actorId: string, avatarUrl: string | null): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const patched = patchValue(entry, actorId, avatarUrl);
      if (patched !== entry) changed = true;
      return patched;
    });
    return changed ? next : value;
  }
  if (!isRecord(value)) return value;

  let next: UnknownRecord | null = null;
  const assign = (key: string, entry: unknown) => {
    if (!next) next = { ...value };
    next[key] = entry;
  };

  if (
    value.sender_id === actorId &&
    'sender_avatar_url' in value &&
    value.sender_avatar_url !== avatarUrl
  ) {
    assign('sender_avatar_url', avatarUrl);
  }
  if (
    value.actor_id === actorId &&
    (('avatar_url' in value) || typeof value.kind === 'string') &&
    value.avatar_url !== avatarUrl
  ) {
    assign('avatar_url', avatarUrl);
  }
  for (const key of NESTED_KEYS) {
    if (!(key in value)) continue;
    const child = value[key];
    const patched = patchValue(child, actorId, avatarUrl);
    if (patched !== child) assign(key, patched);
  }
  return next ?? value;
}

/** 立即把某个 actor 的新头像写进相关查询缓存。 */
export function patchActorAvatarCaches(
  queryClient: QueryClient,
  actorId: string,
  avatarUrl: string | null,
): void {
  for (const queryKey of [['room'], ['rooms'], ['contacts'], ['contact-requests'], ['archived-agents']]) {
    queryClient.setQueriesData({ queryKey }, (data) => patchValue(data, actorId, avatarUrl));
  }
}

import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type { SyncInput } from '../contracts/schemas';
import { getActor, getMember, getRoom } from '../storage/queries';
import type { EventRow } from '../storage/rows';
import { actorId, type Principal } from './principal';
import { historyBoundary } from './room-history';

export interface EventRef {
  event_id: string;
  seq: string;
  scope: string;
  type: string;
  ref_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface SyncPage {
  scope: string;
  items: EventRef[];
  next_cursor: string;
  /** 当前 head 的游标；客户端首次建立本地游标时不必重放全部历史。 */
  head_cursor: string;
  has_more: boolean;
  head_seq: string;
  min_seq: string;
  reset_required: boolean;
}

interface ScopeInfo {
  kind: 'room' | 'inbox';
  id: string;
  head: number;
  min: number;
  /** 解散归档的事件上界；非归档为 null，不能截断策略/文件等大于消息 head 的事件。 */
  max: number | null;
}

async function resolveScope(
  db: D1Database,
  viewer: string,
  scope: string,
): Promise<ScopeInfo> {
  if (scope === 'inbox') {
    const actor = await getActor(db, viewer);
    if (!actor) throw new BusinessError('NOT_FOUND', 'actor 不存在');
    return { kind: 'inbox', id: viewer, head: actor.inbox_head_seq, min: actor.inbox_min_seq, max: null };
  }
  if (scope.startsWith('room:')) {
    const roomId = scope.slice('room:'.length);
    if (!roomId) throw new BusinessError('INVALID_ARGUMENT', 'scope 缺少 room_id');
    const room = await getRoom(db, roomId);
    if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
    const member = await getMember(db, roomId, viewer);
    if (!member || member.status !== 'active') {
      throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
    }
    // 旧游标只定位数据；加入前的事件不属于当前代次，不能通过补读重新获得。
    // 解散归档同时以 archived_head_seq 为读取上界。
    const boundary = historyBoundary(room, member);
    const floor = boundary.fromSeq;
    // 解散后的归档事件上界就是 room scope 的事件高水位；不能用消息 head_seq
    // 截断，否则 room_dissolved/文件/任务事件会被漏掉。
    const head = boundary.toSeq === null ? room.head_seq : boundary.toSeq;
    return {
      kind: 'room',
      id: roomId,
      head,
      min: Math.max(room.events_min_seq, floor),
      max: boundary.toSeq,
    };
  }
  throw new BusinessError('INVALID_ARGUMENT', 'scope 只支持 inbox 或 room:<room_id>');
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 资源读取返回的同步入口：从当前 head 之后继续。 */
export function headCursor(scope: string, head: number): string {
  return encodeCursor({ v: 1, scope: `sync:${scope}`, dir: 'after', seq: head, snapshot: head });
}

export async function sync(
  db: D1Database,
  principal: Principal,
  input: SyncInput,
): Promise<SyncPage> {
  const viewer = actorId(principal);
  const info = await resolveScope(db, viewer, input.scope);
  const cursorScope = `sync:${input.scope}`;
  const limit = clampPage(input.limit, LIMITS.syncPageDefault, LIMITS.syncPageMax);
  const cursor = input.cursor ? decodeCursor(input.cursor, cursorScope) : null;

  if (cursor && cursor.seq < info.min) {
    return {
      scope: input.scope,
      items: [],
      next_cursor: headCursor(input.scope, info.head),
      head_cursor: headCursor(input.scope, info.head),
      has_more: false,
      head_seq: String(info.head),
      min_seq: String(info.min),
      reset_required: true,
    };
  }

  const start = cursor?.seq ?? info.min;
  // 上下线时间线是独立历史，不属于普通 sync 契约；在 LIMIT 前过滤，
  // 避免 presence 事件占用分页额度或让客户端误以为房间有新消息。
  const rows = await db
    .prepare(
      `SELECT * FROM events
        WHERE scope_kind = ? AND scope_id = ? AND event_seq > ? AND (? IS NULL OR event_seq <= ?)
          AND event_type <> 'agent_presence_changed'
        ORDER BY event_seq ASC LIMIT ?`,
    )
    .bind(info.kind, info.id, start, info.max, info.max, limit + 1)
    .all<EventRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  const nextSeq = last?.event_seq ?? start;

  return {
    scope: input.scope,
    items: page.map((row) => ({
      event_id: String(row.event_seq),
      seq: String(row.event_seq),
      scope: `${row.scope_kind}:${row.scope_id}`,
      type: row.event_type,
      ref_id: row.ref_id,
      metadata: parseMetadata(row.metadata),
      created_at: String(row.created_at),
    })),
    next_cursor: headCursor(input.scope, nextSeq),
    head_cursor: headCursor(input.scope, info.head),
    has_more: hasMore,
    head_seq: String(info.head),
    min_seq: String(info.min),
    reset_required: false,
  };
}

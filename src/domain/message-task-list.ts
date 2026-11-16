/**
 * 房间常驻 Task 列表（只读）。
 *
 * 起点按 `created_seq DESC, message_id DESC` keyset 分页，不使用 OFFSET；
 * 游标绑定房间、成员代次、历史策略、筛选状态与 Task 集合 revision。
 * mark / unmark / complete / recall 会改变集合或完成态，旧游标因此失效并
 * 返回 `CURSOR_EXPIRED`，不能只依赖 `head_seq`（这些事件不推进 head）。
 *
 * 聚合只针对本页根批量执行，请求条数与页大小无关；不逐 Task 调摘要或
 * Trace。所有读取重新应用当前 `historyBoundary`，并保留撤回起点的 tombstone。
 */

import { encodeCursor } from '../contracts/cursor';
import { BusinessError } from '../contracts/errors';
import { clampPage, LIMITS } from '../contracts/limits';
import {
  MESSAGE_TASK_COMPLETED_EVENT,
  MESSAGE_TASK_MARKED_EVENT,
  MESSAGE_TASK_UNMARKED_EVENT,
} from '../contracts/events';
import type { Principal } from './principal';
import { roomCapabilitiesFor } from './room-access';
import {
  decodeHistoryCursor,
  historyCursorScope,
  historySnapshot,
  type HistorySnapshot,
} from './room-history';
import {
  orderedParticipants,
  taskMemberAggregates,
  TASK_ROOT_COLUMNS,
  type TaskRootRow,
} from './message-task-read';
import { readableRoom, type TaskSummaryParticipant } from './message-tasks';

export type TaskListStatus = 'open' | 'completed' | 'all';

export interface TaskListInput {
  room_id: string;
  limit?: number;
  cursor?: string;
  status?: TaskListStatus;
}

export interface TaskListRecentMessage {
  message_id: string;
  sender_id: string;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
  created_seq: string;
  created_at: string;
  preview: string;
  recalled: boolean;
}

export interface TaskListItem {
  root_message_id: string;
  room_id: string;
  preview: string;
  root_sender_id: string;
  root_sender_name: string | null;
  root_sender_kind: 'human' | 'agent' | null;
  root_created_seq: string;
  root_created_at: string;
  status: 'open' | 'completed';
  completed_at: string | null;
  completed_by: string | null;
  participants: TaskSummaryParticipant[];
  participant_count: number;
  message_count: number;
  latest_activity_seq: string;
  latest_activity_at: string;
  latest_message_id: string;
  recent_messages: TaskListRecentMessage[];
  can_unmark: boolean;
  can_complete: boolean;
}

export interface TaskListResult {
  items: TaskListItem[];
  total_count: number;
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  authorization: HistorySnapshot;
}

interface LatestRow {
  root_id: string;
  message_id: string;
  created_seq: number;
  created_at: number;
}

interface RecentRow {
  root_id: string;
  message_id: string;
  sender_id: string;
  created_seq: number;
  created_at: number;
  preview: string;
  body_bytes: number;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function limitedPreview(value: string): string {
  return value.length > LIMITS.taskListPreviewChars
    ? value.slice(0, LIMITS.taskListPreviewChars)
    : value;
}

function statusFilterSql(status: TaskListStatus): string {
  if (status === 'open') return 'm.task_completed_at IS NULL';
  if (status === 'completed') return 'm.task_completed_at IS NOT NULL';
  return '';
}

/**
 * Task 集合 revision：mark / unmark / complete / recall 的最新事件序号。
 *
 * 这些事件都不推进 `rooms.head_seq`，因此游标不能只绑定 head。普通新消息
 * 不改变 revision，避免翻页被无关聊天打断。
 */
async function taskSetRevision(db: D1Database, roomId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(MAX(event_seq), 0) AS n
         FROM events
        WHERE scope_kind = 'room' AND scope_id = ?
          AND event_type IN (?, ?, ?, ?)`,
    )
    .bind(
      roomId,
      MESSAGE_TASK_MARKED_EVENT,
      MESSAGE_TASK_UNMARKED_EVENT,
      MESSAGE_TASK_COMPLETED_EVENT,
      'message_recalled',
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function memberSql(rootCount: number): string {
  const marks = placeholders(rootCount);
  return `m.room_id = ? AND m.created_seq >= ? AND m.created_seq <= ?
      AND (m.task_root_id IN (${marks}) OR (m.task_root_id IS NULL AND m.root_id IN (${marks})))`;
}

function memberBinds(
  roomId: string,
  fromSeq: number,
  snapshot: number,
  rootIds: string[],
): unknown[] {
  return [roomId, fromSeq, snapshot, ...rootIds, ...rootIds];
}

async function latestActivity(
  db: D1Database,
  roomId: string,
  rootIds: string[],
  fromSeq: number,
  snapshot: number,
): Promise<Map<string, LatestRow>> {
  const rows = await db
    .prepare(
      `WITH member AS (
         SELECT COALESCE(m.task_root_id, m.root_id) AS root_id, m.message_id,
                m.created_seq, m.created_at
           FROM messages m
          WHERE ${memberSql(rootIds.length)}
       ), ranked AS (
         SELECT root_id, message_id, created_seq, created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY root_id ORDER BY created_seq DESC, message_id DESC
                ) AS rn
           FROM member
       )
       SELECT root_id, message_id, created_seq, created_at
         FROM ranked WHERE rn = 1`,
    )
    .bind(...memberBinds(roomId, fromSeq, snapshot, rootIds))
    .all<LatestRow>();
  return new Map(rows.results.map((row) => [row.root_id, row]));
}

/** 最近 3 条非根处理消息；按时间升序返回，撤回项保留 tombstone 预览。 */
async function recentMessages(
  db: D1Database,
  roomId: string,
  rootIds: string[],
  fromSeq: number,
  snapshot: number,
): Promise<Map<string, TaskListRecentMessage[]>> {
  const rows = await db
    .prepare(
      `WITH member AS (
         SELECT COALESCE(m.task_root_id, m.root_id) AS root_id, m.message_id,
                m.sender_id, m.created_seq, m.created_at, m.preview, m.body_bytes,
                ROW_NUMBER() OVER (
                  PARTITION BY COALESCE(m.task_root_id, m.root_id)
                  ORDER BY m.created_seq DESC, m.message_id DESC
                ) AS rn
           FROM messages m
          WHERE ${memberSql(rootIds.length)}
            AND m.message_id <> COALESCE(m.task_root_id, m.root_id)
       )
       SELECT member.root_id, member.message_id, member.sender_id,
              member.created_seq, member.created_at, member.preview, member.body_bytes,
              a.name AS sender_name, a.kind AS sender_kind
         FROM member
         LEFT JOIN actors a ON a.actor_id = member.sender_id
        WHERE member.rn <= ?
        ORDER BY member.root_id ASC, member.created_seq ASC, member.message_id ASC`,
    )
    .bind(...memberBinds(roomId, fromSeq, snapshot, rootIds), LIMITS.taskListRecentMessagesMax)
    .all<RecentRow>();

  const result = new Map<string, TaskListRecentMessage[]>();
  for (const row of rows.results) {
    const list = result.get(row.root_id) ?? [];
    list.push({
      message_id: row.message_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name,
      sender_kind: row.sender_kind,
      created_seq: String(row.created_seq),
      created_at: String(row.created_at),
      preview: limitedPreview(row.preview),
      recalled: row.body_bytes === 0,
    });
    result.set(row.root_id, list);
  }
  return result;
}

export async function messageTaskList(
  db: D1Database,
  principal: Principal,
  input: TaskListInput,
): Promise<TaskListResult> {
  const { room, member, boundary } = await readableRoom(db, principal, input.room_id);
  const status = input.status ?? 'open';
  const limit = clampPage(input.limit, LIMITS.taskListPageDefault, LIMITS.taskListPageMax);
  const revision = await taskSetRevision(db, room.room_id);
  const scope = `${historyCursorScope('task', room.room_id, boundary.memberGeneration)}:list:p${boundary.policyRevision}:s${status}:r${revision}`;
  const cursor = input.cursor ? decodeHistoryCursor(input.cursor, scope, room.room_id) : null;
  if (cursor && typeof cursor.key !== 'string') {
    throw new BusinessError('INVALID_ARGUMENT', 'cursor 缺少 Task 列表排序键');
  }
  const readHead =
    boundary.toSeq === null ? room.head_seq : Math.min(room.head_seq, boundary.toSeq);
  const snapshot = cursor ? Math.min(cursor.snapshot, readHead) : readHead;

  const baseFilters = [
    'm.room_id = ?',
    'm.task_root_id = m.message_id',
    'm.created_seq >= ?',
    'm.created_seq <= ?',
    statusFilterSql(status),
  ]
    .filter(Boolean)
    .join(' AND ');
  const cursorFilter = '(m.created_seq < ? OR (m.created_seq = ? AND m.message_id < ?))';
  const filters = cursor ? `${baseFilters} AND ${cursorFilter}` : baseFilters;
  const baseBinds: unknown[] = [room.room_id, boundary.fromSeq, snapshot];
  const pageBinds: unknown[] = cursor
    ? [...baseBinds, cursor.seq, cursor.seq, cursor.key]
    : baseBinds;

  const [page, total] = await Promise.all([
    db
      .prepare(
        `SELECT ${TASK_ROOT_COLUMNS}, a.name AS sender_name, a.kind AS sender_kind
           FROM messages m
           LEFT JOIN actors a ON a.actor_id = m.sender_id
          WHERE ${filters}
          ORDER BY m.created_seq DESC, m.message_id DESC
          LIMIT ?`,
      )
      .bind(...pageBinds, limit + 1)
      .all<TaskRootRow>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${baseFilters}`)
      .bind(...baseBinds)
      .first<{ n: number }>(),
  ]);

  const hasMore = page.results.length > limit;
  const roots = page.results.slice(0, limit);
  const rootIds = roots.map((row) => row.message_id);
  const canUnmark = roomCapabilitiesFor(room, member).send_message;

  // 聚合也固定在本次快照上，避免翻页期间新处理消息造成半页旧状态。
  const snapshotBoundary = { ...boundary, toSeq: snapshot };
  const aggregates = await taskMemberAggregates(
    db,
    room.room_id,
    rootIds,
    snapshotBoundary,
  );
  const [latest, recent] = await Promise.all([
    latestActivity(db, room.room_id, rootIds, boundary.fromSeq, snapshot),
    recentMessages(db, room.room_id, rootIds, boundary.fromSeq, snapshot),
  ]);

  const items = roots.map((root): TaskListItem => {
    const statusValue = root.task_completed_at === null ? 'open' : 'completed';
    const participants = orderedParticipants(
      aggregates.participants.get(root.message_id) ?? [],
      root.sender_id,
    );
    const activity = latest.get(root.message_id);
    return {
      root_message_id: root.message_id,
      room_id: root.room_id,
      preview: limitedPreview(root.preview),
      root_sender_id: root.sender_id,
      root_sender_name: root.sender_name,
      root_sender_kind: root.sender_kind,
      root_created_seq: String(root.created_seq),
      root_created_at: String(root.created_at),
      status: statusValue,
      completed_at:
        root.task_completed_at === null ? null : String(root.task_completed_at),
      completed_by: root.task_completed_by,
      participants: participants
        .slice(0, LIMITS.taskListParticipantsMax)
        .map((row) => ({
          actor_id: row.sender_id,
          name: row.name,
          kind: 'agent' as const,
          first_seq: String(row.first_seq),
        })),
      participant_count: participants.length,
      message_count:
        (aggregates.counts.get(root.message_id) ?? 0) +
        (aggregates.referenceCounts.get(root.message_id) ?? 0),
      latest_activity_seq: String(activity?.created_seq ?? root.created_seq),
      latest_activity_at: String(activity?.created_at ?? root.created_at),
      latest_message_id: activity?.message_id ?? root.message_id,
      recent_messages: recent.get(root.message_id) ?? [],
      can_unmark: canUnmark,
      can_complete: canUnmark && statusValue === 'open',
    };
  });

  const last = roots.at(-1);
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          v: 1,
          scope,
          dir: 'after',
          seq: last.created_seq,
          key: last.message_id,
          snapshot,
        })
      : null;

  return {
    items,
    total_count: total?.n ?? 0,
    next_cursor: nextCursor,
    has_more: hasMore,
    snapshot: String(snapshot),
    authorization: historySnapshot(boundary),
  };
}

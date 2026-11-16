/**
 * 消息式 Task / Trace 的 domain 实现（阶段 1）。
 *
 * 不引入任务实体：起点消息自身 `task_root_id = message_id`，处理消息在发送时
 * 显式归属或从父消息继承。集合成员为 `task_root_id = R` 的消息，以及
 * `task_root_id IS NULL AND root_id = R` 的既有线程消息；引用来源只取处理消息
 * 的一层 `reply_to`，按 message_id 去重。所有读取都重新应用当前
 * `historyBoundary`，不缓存跨成员代次的结果。
 *
 * 标记 / 取消标记只写 room scope 事件与 `room:<id>` outbox，只提示 active
 * human；不写 inbox、不改变 `pending_count`，也不推进 `head_seq` / 房间排序。
 */

import { encodeCursor } from '../contracts/cursor';
import { BusinessError } from '../contracts/errors';
import {
  MESSAGE_TASK_MARKED_EVENT,
  MESSAGE_TASK_UNMARKED_EVENT,
} from '../contracts/events';
import { clampPage, LIMITS } from '../contracts/limits';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement, outboxStatement, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getMember, getMessage } from '../storage/queries';
import type { MessageRow, RoomMemberRow, RoomRow } from '../storage/rows';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import {
  assertRoomWritable,
  capabilityGuardStatement,
  loadRoomAccess,
  requireRoomAccess,
  roomCapabilitiesFor,
  roomDissolvedGuardStatement,
} from './room-access';
import {
  decodeHistoryCursor,
  historyBoundary,
  historyCursorScope,
  historySnapshot,
  visibleMessage,
  type HistoryBoundary,
  type HistorySnapshot,
} from './room-history';
import {
  orderedParticipants,
  taskMemberAggregates,
  TASK_ROOT_COLUMNS,
  type TaskRootRow,
} from './message-task-read';
import {
  memoryTaskOfferChangeStatements,
  memoryTaskOfferRetractionStatements,
  nextTaskOfferRevision,
  type MemoryIntakeOptions,
} from '../memory/intake';

export interface TaskMarkInput {
  request_id: string;
  room_id: string;
  message_id: string;
}

export interface TaskMarkResult {
  room_id: string;
  message_id: string;
  task_root_id: string;
  marked: true;
}

export interface TaskUnmarkInput {
  request_id: string;
  room_id: string;
  message_id: string;
}

export interface TaskUnmarkResult {
  room_id: string;
  message_id: string;
  task_root_id: null;
  marked: false;
}

export interface TaskSummaryParticipant {
  actor_id: string;
  name: string;
  kind: 'agent';
  first_seq: string;
}

export interface TaskSummary {
  root_message_id: string;
  room_id: string;
  preview: string;
  root_sender_id: string;
  root_sender_name: string | null;
  root_sender_kind: 'human' | 'agent' | null;
  root_created_at: string;
  root_created_seq: string;
  participants: TaskSummaryParticipant[];
  participant_count: number;
  message_count: number;
  status: 'open' | 'completed';
  completed_at: string | null;
  completed_by: string | null;
  can_unmark: boolean;
  can_complete: boolean;
}

export interface TaskSummariesInput {
  room_id: string;
  root_message_ids: string[];
}

export interface TaskTraceInput {
  room_id: string;
  root_message_id: string;
  cursor?: string;
  /** 从搜索命中进入时定位的消息；无 cursor 时以它为首页起点。 */
  focus_message_id?: string;
  limit?: number;
}

export interface TaskTraceItem {
  message_id: string;
  sender_id: string;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
  created_seq: string;
  created_at: string;
  preview: string;
  body_bytes: number;
  recalled: boolean;
  role: 'root' | 'member' | 'reference';
  /** 只在引用目标仍属于当前可见集合时返回；否则为 null。 */
  reply_to: string | null;
  /** 纯引用项：最早引用它的集合消息；成员项为 null。 */
  referenced_by: string | null;
  has_unavailable_reference: boolean;
}

export interface TaskTraceResult {
  root_message_id: string;
  items: TaskTraceItem[];
  next_cursor: string | null;
  prev_cursor: string | null;
  has_more_before: boolean;
  has_more_after: boolean;
  message_count: number;
  /** 请求的焦点消息确实属于当前集合时返回原 ID；否则为 null。 */
  focus_message_id: string | null;
  /** Task 完成态；Trace 本身不改变它。 */
  status: 'open' | 'completed';
  completed_at: string | null;
  completed_by: string | null;
  authorization: HistorySnapshot;
}

type RootRow = TaskRootRow;

interface TraceQueryRow extends Pick<
  MessageRow,
  | 'message_id'
  | 'sender_id'
  | 'created_seq'
  | 'created_at'
  | 'preview'
  | 'body_bytes'
  | 'reply_to'
> {
  role: 'root' | 'member' | 'reference';
  referenced_by: string | null;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
}

function notVisible(): BusinessError {
  return new BusinessError('NOT_FOUND', '消息不存在、当前不可见或已撤回');
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/** 标记 / 摘要 / Trace / 搜索共用的活跃成员与历史边界。 */
export async function readableRoom(
  db: D1Database,
  principal: Principal,
  roomId: string,
): Promise<{ room: RoomRow; member: RoomMemberRow; boundary: HistoryBoundary }> {
  const viewer = actorId(principal);
  const { room, member } = await loadRoomAccess(db, roomId, viewer);
  return { room, member, boundary: historyBoundary(room, member) };
}

/**
 * 任务起点同批 Memory 来源。
 *
 * 只登记消息与 task_offer 角色来源，并为真实 pending/claimed delivery 生成
 * 预热资格；不根据正文 @ 字符串或空任务卡猜测对象。作者成员已退出时退回
 * 当前标记者的成员快照，仍以消息原始 created_seq 作为来源序号。
 */
async function taskOfferIntakeStatements(
  db: D1Database,
  memory: MemoryIntakeOptions,
  input: {
    room: RoomRow;
    member: RoomMemberRow;
    message: MessageRow;
    at: number;
  },
): Promise<D1PreparedStatement[]> {
  if (!memory.capture) return [];
  const senderMember =
    (await getMember(db, input.room.room_id, input.message.sender_id)) ?? input.member;
  const deliveries = await db
    .prepare(
      `SELECT delivery_id, recipient_id
         FROM deliveries
        WHERE message_id = ? AND state IN ('pending', 'claimed')
        ORDER BY delivery_id`,
    )
    .bind(input.message.message_id)
    .all<{ delivery_id: string; recipient_id: string }>();
  const taskRevision = await nextTaskOfferRevision(db, memory, input.message.message_id);
  return memoryTaskOfferChangeStatements(db, memory, {
    messageId: input.message.message_id,
    createdSeq: input.message.created_seq,
    eventKey: `message:${input.message.message_id}`,
    senderId: input.message.sender_id,
    body: input.message.body,
    bodyBytes: input.message.body_bytes,
    digest:
      input.message.body.length > 0 ? await sha256Hex(input.message.body) : null,
    createdAt: input.message.created_at,
    roomId: input.room.room_id,
    origin: {
      roomId: input.room.room_id,
      memberGeneration: senderMember.member_generation,
      policyRevision: input.room.policy_revision,
      joinedSeq: senderMember.joined_seq,
      joinedAt: senderMember.joined_at,
      archiveHeadSeq: input.room.archive_head_seq,
    },
    deliveries: deliveries.results.map((delivery) => ({
      deliveryId: delivery.delivery_id,
      recipientId: delivery.recipient_id,
    })),
    now: input.at,
    taskRevision,
  });
}

/**
 * 标记任意可见消息为 Task 起点。
 *
 * 权限沿用 `send_message`：能发言的 active 成员才能新增聚合入口。目标已存在
 * 的归属只有在指向另一个仍标记中的起点时才冲突；已是本起点按幂等成功返回，
 * 不重复写事件或改写标记审计。
 */
export async function messageTaskMark(
  db: D1Database,
  principal: Principal,
  input: TaskMarkInput,
  memory?: MemoryIntakeOptions | null,
): Promise<TaskMarkResult> {
  const actor = actorId(principal);
  const access = await requireRoomAccess(db, input.room_id, actor, 'send_message');
  assertRoomWritable(access.room);
  const boundary = historyBoundary(access.room, access.member);
  const target = await getMessage(db, input.message_id);
  if (
    !target ||
    target.room_id !== input.room_id ||
    !visibleMessage(target, boundary) ||
    target.body_bytes === 0
  ) {
    throw notVisible();
  }

  const alreadyMarked = target.task_root_id === target.message_id;
  if (!alreadyMarked) {
    const ownerRootId = target.task_root_id ?? target.root_id;
    if (ownerRootId && ownerRootId !== target.message_id) {
      const ownerRoot = await getMessage(db, ownerRootId);
      if (
        ownerRoot &&
        ownerRoot.room_id === input.room_id &&
        ownerRoot.task_root_id === ownerRoot.message_id
      ) {
        throw new BusinessError('CONFLICT', '消息已属于另一个 Task；请另选起点或先取消原标记');
      }
    }
  }

  const at = nowMs();
  const memoryStatements = memory?.capture
    ? await taskOfferIntakeStatements(db, memory, {
        room: access.room,
        member: access.member,
        message: target,
        at,
      })
    : [];
  const payloadHash = await sha256Hex(stableStringify(input));
  const result: TaskMarkResult = {
    room_id: input.room_id,
    message_id: target.message_id,
    task_root_id: target.message_id,
    marked: true,
  };

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => {
      const statements = [
        operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
        ...memoryStatements,
      ];
      if (alreadyMarked) return statements;
      const eventKey = `message_task_marked:${target.message_id}:${input.request_id}`;
      statements.push(
        roomDissolvedGuardStatement(db, access.room.room_id),
        capabilityGuardStatement(db, access.room.room_id, actor, 'send_message'),
        db
          .prepare(
            guardSql(
              'taskMarkUnavailable',
              `NOT EXISTS (
                 SELECT 1 FROM messages m
                  WHERE m.message_id = ? AND m.room_id = ? AND m.body_bytes > 0
                    AND m.created_seq >= ? AND (? IS NULL OR m.created_seq <= ?)
               )`,
            ),
          )
          .bind(
            target.message_id,
            access.room.room_id,
            boundary.fromSeq,
            boundary.toSeq,
            boundary.toSeq,
          ),
        db
          .prepare(
            guardSql(
              'taskMarkConflict',
              `EXISTS (
                 SELECT 1 FROM messages t
                 JOIN messages r ON r.message_id = COALESCE(t.task_root_id, t.root_id)
                  WHERE t.message_id = ? AND t.room_id = ?
                    AND t.task_root_id IS NOT t.message_id
                    AND r.task_root_id = r.message_id
               )`,
            ),
          )
          .bind(target.message_id, access.room.room_id),
        db
          .prepare(
            `UPDATE messages
                SET task_root_id = message_id, task_marked_by = ?, task_marked_at = ?
              WHERE message_id = ? AND room_id = ?
                AND (task_root_id IS NULL OR task_root_id = message_id)`,
          )
          .bind(actor, at, target.message_id, access.room.room_id),
        eventStatement(
          db,
          {
            eventKey,
            scopeKind: 'room',
            scopeId: access.room.room_id,
            eventType: MESSAGE_TASK_MARKED_EVENT,
            refId: target.message_id,
            metadata: {
              room_id: access.room.room_id,
              message_id: target.message_id,
              task_root_id: target.message_id,
              marked: true,
              marked_by: actor,
              changed_by: actor,
            },
          },
          at,
        ),
        outboxStatement(
          db,
          { topic: roomTopic(access.room.room_id), eventKey },
          at,
        ),
      );
      return statements;
    },
  });
  return result;
}

/**
 * 取消 Task 聚合入口。
 *
 * 任何可发言成员都可以取消（用户拍板），不要求是原标记者。只清空起点自身的
 * 三列；处理消息归属、引用关系与原消息全部保留，重新标记后集合恢复。
 */
export async function messageTaskUnmark(
  db: D1Database,
  principal: Principal,
  input: TaskUnmarkInput,
  memory?: MemoryIntakeOptions | null,
): Promise<TaskUnmarkResult> {
  const actor = actorId(principal);
  const access = await requireRoomAccess(db, input.room_id, actor, 'send_message');
  assertRoomWritable(access.room);
  const boundary = historyBoundary(access.room, access.member);
  const target = await getMessage(db, input.message_id);
  if (
    !target ||
    target.room_id !== input.room_id ||
    !visibleMessage(target, boundary)
  ) {
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  }

  const wasMarked = target.task_root_id === target.message_id;
  const at = nowMs();
  const memoryStatements =
    memory && wasMarked
      ? memoryTaskOfferRetractionStatements(db, memory, {
          messageId: target.message_id,
          now: at,
        })
      : [];
  const payloadHash = await sha256Hex(stableStringify(input));
  const result: TaskUnmarkResult = {
    room_id: input.room_id,
    message_id: target.message_id,
    task_root_id: null,
    marked: false,
  };

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => {
      const statements = [
        operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      ];
      if (!wasMarked) return statements;
      const eventKey = `message_task_unmarked:${target.message_id}:${input.request_id}`;
      statements.push(
        roomDissolvedGuardStatement(db, access.room.room_id),
        capabilityGuardStatement(db, access.room.room_id, actor, 'send_message'),
        db
          .prepare(
            `UPDATE messages
                SET task_root_id = NULL, task_marked_by = NULL, task_marked_at = NULL
              WHERE message_id = ? AND room_id = ? AND task_root_id = message_id`,
          )
          .bind(target.message_id, access.room.room_id),
        eventStatement(
          db,
          {
            eventKey,
            scopeKind: 'room',
            scopeId: access.room.room_id,
            eventType: MESSAGE_TASK_UNMARKED_EVENT,
            refId: target.message_id,
            metadata: {
              room_id: access.room.room_id,
              message_id: target.message_id,
              task_root_id: target.message_id,
              marked: false,
              changed_by: actor,
            },
          },
          at,
        ),
        outboxStatement(
          db,
          { topic: roomTopic(access.room.room_id), eventKey },
          at,
        ),
        // 取消标记让旧 task_offer 角色来源不可读；不写永久 tombstone，
        // 之后重新标记会生成新的 task revision。
        ...memoryStatements,
      );
      return statements;
    },
  });
  return result;
}

/**
 * 批量摘要。只返回已标记且当前可见的根；未标记 / 不可见直接省略。
 *
 * `message_count` 为集合成员与被引用来源按 message_id 去重后的数量；引用来源
 * 只取一层，且排除已经是同一集合成员的消息。参与者只统计 Agent 作者，按首次
 * 参与顺序去重。
 */
export async function messageTaskSummaries(
  db: D1Database,
  principal: Principal,
  input: TaskSummariesInput,
): Promise<{ items: TaskSummary[] }> {
  const { room, member, boundary } = await readableRoom(db, principal, input.room_id);
  const rootIds = [...new Set(input.root_message_ids)].slice(0, LIMITS.taskSummaryRootsMax);
  if (rootIds.length === 0) return { items: [] };

  const rootMarks = placeholders(rootIds.length);
  const rootRows = await db
    .prepare(
      `SELECT ${TASK_ROOT_COLUMNS}, a.name AS sender_name, a.kind AS sender_kind
         FROM messages m
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.message_id IN (${rootMarks}) AND m.room_id = ?
          AND m.task_root_id = m.message_id`,
    )
    .bind(...rootIds, room.room_id)
    .all<RootRow>();
  const rootsById = new Map<string, RootRow>();
  for (const row of rootRows.results) {
    if (visibleMessage(row, boundary)) rootsById.set(row.message_id, row);
  }
  const roots = rootIds
    .map((rootId) => rootsById.get(rootId))
    .filter((row): row is RootRow => row !== undefined);
  if (roots.length === 0) return { items: [] };

  const validIds = roots.map((row) => row.message_id);
  const aggregates = await taskMemberAggregates(db, room.room_id, validIds, boundary);
  const canUnmark = roomCapabilitiesFor(room, member).send_message;

  const items = roots.map((root): TaskSummary => {
    const participants = orderedParticipants(
      aggregates.participants.get(root.message_id) ?? [],
      root.sender_id,
    );
    const status = root.task_completed_at === null ? 'open' : 'completed';
    return {
      root_message_id: root.message_id,
      room_id: root.room_id,
      preview: root.preview,
      root_sender_id: root.sender_id,
      root_sender_name: root.sender_name,
      root_sender_kind: root.sender_kind,
      root_created_at: String(root.created_at),
      root_created_seq: String(root.created_seq),
      participants: participants.slice(0, LIMITS.taskParticipantsMax).map((row) => ({
        actor_id: row.sender_id,
        name: row.name,
        kind: 'agent' as const,
        first_seq: String(row.first_seq),
      })),
      participant_count: participants.length,
      message_count:
        (aggregates.counts.get(root.message_id) ?? 0) +
        (aggregates.referenceCounts.get(root.message_id) ?? 0),
      status,
      completed_at:
        root.task_completed_at === null ? null : String(root.task_completed_at),
      completed_by: root.task_completed_by,
      can_unmark: canUnmark,
      can_complete: canUnmark && status === 'open',
    };
  });
  return { items };
}

/**
 * 按原消息顺序分页读取 Trace。
 *
 * 集合成员与一层引用来源合并后按 `created_seq` 升序；游标绑定房间、根、成员
 * 代次、策略版本与首次请求的快照上界。`reply_to` 只在目标仍属于当前可见集合
 * 时返回，否则置空并标记 `has_unavailable_reference`，避免泄露不可见消息 ID。
 */
export async function messageTaskTrace(
  db: D1Database,
  principal: Principal,
  input: TaskTraceInput,
): Promise<TaskTraceResult> {
  const { room, boundary } = await readableRoom(db, principal, input.room_id);
  const rootRow = await db
    .prepare(
      `SELECT ${TASK_ROOT_COLUMNS}, a.name AS sender_name, a.kind AS sender_kind
         FROM messages m
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.message_id = ? AND m.room_id = ? AND m.task_root_id = m.message_id`,
    )
    .bind(input.root_message_id, room.room_id)
    .first<RootRow>();
  if (!rootRow || !visibleMessage(rootRow, boundary)) {
    throw new BusinessError('NOT_FOUND', 'Task 起点不存在、未标记或当前不可见');
  }

  const readHead = boundary.toSeq === null ? room.head_seq : Math.min(room.head_seq, boundary.toSeq);
  const scope = `${historyCursorScope('task', room.room_id, boundary.memberGeneration)}:r${rootRow.message_id}:p${boundary.policyRevision}`;
  const cursor = input.cursor ? decodeHistoryCursor(input.cursor, scope, room.room_id) : null;
  const snapshot = cursor ? Math.min(cursor.snapshot, readHead) : readHead;
  if (snapshot < rootRow.created_seq) {
    throw new BusinessError('CURSOR_EXPIRED', 'Trace 快照早于 Task 起点，请重新读取');
  }
  const limit = clampPage(input.limit, LIMITS.taskTracePageDefault, LIMITS.taskTracePageMax);
  const memberSql = `member AS (
         SELECT m.message_id, m.sender_id, m.created_seq, m.created_at, m.preview,
                m.body_bytes, m.reply_to,
                CASE WHEN m.message_id = ? THEN 'root' ELSE 'member' END AS role
           FROM messages m
          WHERE m.room_id = ?
            AND m.created_seq >= ? AND m.created_seq <= ?
            AND (m.task_root_id = ? OR (m.task_root_id IS NULL AND m.root_id = ?))
       )`;
  const refSql = `ref AS (
         SELECT s.message_id, s.sender_id, s.created_seq, s.created_at, s.preview,
                s.body_bytes, s.reply_to, 'reference' AS role,
                (SELECT m2.message_id FROM member m2
                  WHERE m2.reply_to = s.message_id AND m2.body_bytes > 0
                  ORDER BY m2.created_seq ASC LIMIT 1) AS referenced_by
           FROM member
           JOIN messages s ON s.message_id = member.reply_to AND s.room_id = ?
          WHERE member.body_bytes > 0
            AND s.created_seq >= ? AND s.created_seq <= ?
            AND s.message_id NOT IN (SELECT message_id FROM member)
          GROUP BY s.message_id
       )`;
  const collectionSql = `collection AS (
         SELECT message_id, sender_id, created_seq, created_at, preview, body_bytes, reply_to,
                role, NULL AS referenced_by
           FROM member
         UNION ALL
         SELECT message_id, sender_id, created_seq, created_at, preview, body_bytes, reply_to,
                role, referenced_by
           FROM ref
       )`;
  // 绑定顺序固定为 member -> ref；后续查询只在末尾追加自己的参数。
  const cteBinds = [
    rootRow.message_id,
    room.room_id,
    boundary.fromSeq,
    snapshot,
    rootRow.message_id,
    rootRow.message_id,
    room.room_id,
    boundary.fromSeq,
    snapshot,
  ] as const;

  let focusSeq: number | null = null;
  if (input.focus_message_id) {
    const focus = await db
      .prepare(
        `WITH ${memberSql}, ${refSql}, ${collectionSql}
         SELECT created_seq FROM collection WHERE message_id = ? LIMIT 1`,
      )
      .bind(...cteBinds, input.focus_message_id)
      .first<{ created_seq: number }>();
    if (!focus) {
      throw new BusinessError('NOT_FOUND', '焦点消息不在该 Task 中或当前不可见');
    }
    focusSeq = focus.created_seq;
  }

  // cursor 优先；没有 cursor 时从焦点开始（焦点位于首页第一条），否则从头开始。
  const direction = cursor?.dir ?? 'after';
  const anchor = cursor ? cursor.seq : focusSeq !== null ? focusSeq - 1 : boundary.fromSeq - 1;

  const rows = await db
    .prepare(
      `WITH ${memberSql}, ${refSql}, ${collectionSql}
       SELECT u.message_id, u.sender_id, u.created_seq, u.created_at, u.preview, u.body_bytes,
              u.reply_to, u.role, u.referenced_by, a.name AS sender_name, a.kind AS sender_kind
         FROM collection u
         LEFT JOIN actors a ON a.actor_id = u.sender_id
        WHERE u.created_seq ${direction === 'after' ? '>' : '<'} ?
        ORDER BY u.created_seq ${direction === 'after' ? 'ASC' : 'DESC'}
        LIMIT ?`,
    )
    .bind(...cteBinds, anchor, limit + 1)
    .all<TraceQueryRow>();

  // before 页按 DESC 取最近一页，再恢复升序返回；多取的一条用于判断更早页。
  const ordered = direction === 'after' ? rows.results : [...rows.results].reverse();
  const page = ordered.slice(0, limit);
  const first = page[0];
  const last = page.at(-1);

  let hasMoreBefore = false;
  let hasMoreAfter = false;
  if (first && last) {
    const flags = await db
      .prepare(
        `WITH ${memberSql}, ${refSql}, ${collectionSql}
         SELECT
           EXISTS (SELECT 1 FROM collection WHERE created_seq < ?) AS before_exists,
           EXISTS (SELECT 1 FROM collection WHERE created_seq > ?) AS after_exists`,
      )
      .bind(...cteBinds, first.created_seq, last.created_seq)
      .first<{ before_exists: number; after_exists: number }>();
    hasMoreBefore = flags?.before_exists === 1;
    hasMoreAfter = flags?.after_exists === 1;
  }

  const total = await db
    .prepare(
      `WITH ${memberSql}, ${refSql}, ${collectionSql}
       SELECT COUNT(*) AS n FROM collection`,
    )
    .bind(...cteBinds)
    .first<{ n: number }>();

  const replyIds = [
    ...new Set(
      page
        .map((row) => row.reply_to)
        .filter((value): value is string => value !== null),
    ),
  ];
  const availableReplies = new Set<string>();
  if (replyIds.length > 0) {
    const replyMarks = placeholders(replyIds.length);
    const available = await db
      .prepare(
        `SELECT s.message_id
           FROM messages s
          WHERE s.message_id IN (${replyMarks}) AND s.room_id = ?
            AND s.created_seq >= ? AND s.created_seq <= ?
            AND (
              s.task_root_id = ? OR (s.task_root_id IS NULL AND s.root_id = ?)
              OR EXISTS (
                SELECT 1 FROM messages m
                 WHERE m.room_id = s.room_id AND m.reply_to = s.message_id
                   AND m.body_bytes > 0
                   AND m.created_seq >= ? AND m.created_seq <= ?
                   AND (m.task_root_id = ? OR (m.task_root_id IS NULL AND m.root_id = ?))
              )
            )`,
      )
      .bind(
        ...replyIds,
        room.room_id,
        boundary.fromSeq,
        snapshot,
        rootRow.message_id,
        rootRow.message_id,
        boundary.fromSeq,
        snapshot,
        rootRow.message_id,
        rootRow.message_id,
      )
      .all<{ message_id: string }>();
    for (const row of available.results) availableReplies.add(row.message_id);
  }

  const items = page.map((row): TaskTraceItem => {
    const available = row.reply_to !== null && availableReplies.has(row.reply_to);
    return {
      message_id: row.message_id,
      sender_id: row.sender_id,
      sender_name: row.sender_name,
      sender_kind: row.sender_kind,
      created_seq: String(row.created_seq),
      created_at: String(row.created_at),
      preview: row.preview,
      body_bytes: row.body_bytes,
      recalled: row.body_bytes === 0,
      role: row.role,
      reply_to: available ? row.reply_to : null,
      referenced_by: row.referenced_by,
      has_unavailable_reference: row.reply_to !== null && !available,
    };
  });

  const nextCursor =
    hasMoreAfter && last
      ? encodeCursor({
          v: 1,
          scope,
          dir: 'after',
          seq: last.created_seq,
          snapshot,
        })
      : null;
  const prevCursor =
    hasMoreBefore && first
      ? encodeCursor({
          v: 1,
          scope,
          dir: 'before',
          seq: first.created_seq,
          snapshot,
        })
      : null;

  return {
    root_message_id: rootRow.message_id,
    items,
    next_cursor: nextCursor,
    prev_cursor: prevCursor,
    has_more_before: hasMoreBefore,
    has_more_after: hasMoreAfter,
    message_count: total?.n ?? 0,
    focus_message_id: input.focus_message_id ?? null,
    status: rootRow.task_completed_at === null ? 'open' : 'completed',
    completed_at:
      rootRow.task_completed_at === null ? null : String(rootRow.task_completed_at),
    completed_by: rootRow.task_completed_by,
    authorization: historySnapshot(boundary),
  };
}

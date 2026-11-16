/**
 * 消息式 Task 的共享读取规则。
 *
 * 摘要与房间 Task 列表必须使用同一套集合判定与计数口径：显式归属
 * `task_root_id = R`，或旧线程 `task_root_id IS NULL AND root_id = R`；
 * 计数再叠加处理消息一层 `reply_to` 来源，按 message_id 去重。所有读取
 * 都应用调用时的 `historyBoundary`，不缓存跨成员代次的结果。
 */

import type { HistoryBoundary } from './room-history';
import type { MessageRow } from '../storage/rows';

export interface TaskRootRow extends Pick<
  MessageRow,
  | 'message_id'
  | 'room_id'
  | 'sender_id'
  | 'created_seq'
  | 'created_at'
  | 'preview'
  | 'body_bytes'
  | 'task_root_id'
  | 'task_marked_by'
  | 'task_marked_at'
  | 'task_completed_at'
  | 'task_completed_by'
> {
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
}

/** 起点行选择列；调用方补充 actors join 与 WHERE。 */
export const TASK_ROOT_COLUMNS = `m.message_id, m.room_id, m.sender_id, m.created_seq, m.created_at,
        m.preview, m.body_bytes, m.task_root_id, m.task_marked_by, m.task_marked_at,
        m.task_completed_at, m.task_completed_by`;

export interface TaskParticipantRow {
  root_id: string;
  sender_id: string;
  name: string;
  first_seq: number;
}

export interface TaskAggregates {
  counts: Map<string, number>;
  referenceCounts: Map<string, number>;
  participants: Map<string, TaskParticipantRow[]>;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

/** 批量读取一页根的成员数、一层引用数与 Agent 参与者；请求条数固定。 */
export async function taskMemberAggregates(
  db: D1Database,
  roomId: string,
  rootIds: string[],
  boundary: HistoryBoundary,
): Promise<TaskAggregates> {
  const aggregates: TaskAggregates = {
    counts: new Map(),
    referenceCounts: new Map(),
    participants: new Map(),
  };
  if (rootIds.length === 0) return aggregates;

  const marks = placeholders(rootIds.length);
  const memberFilter = `m.room_id = ? AND m.created_seq >= ? AND (? IS NULL OR m.created_seq <= ?)
      AND (m.task_root_id IN (${marks}) OR (m.task_root_id IS NULL AND m.root_id IN (${marks})))`;
  const memberBinds: unknown[] = [
    roomId,
    boundary.fromSeq,
    boundary.toSeq,
    boundary.toSeq,
    ...rootIds,
    ...rootIds,
  ];

  const [counts, participantRows, referenceCounts] = await Promise.all([
    db
      .prepare(
        `SELECT COALESCE(m.task_root_id, m.root_id) AS root_id,
                COUNT(DISTINCT m.message_id) AS n
           FROM messages m
          WHERE ${memberFilter}
          GROUP BY COALESCE(m.task_root_id, m.root_id)`,
      )
      .bind(...memberBinds)
      .all<{ root_id: string; n: number }>(),
    db
      .prepare(
        `WITH member AS (
           SELECT COALESCE(m.task_root_id, m.root_id) AS root_id, m.message_id,
                  m.sender_id, m.body_bytes, m.created_seq
             FROM messages m
            WHERE ${memberFilter}
         )
         SELECT member.root_id, member.sender_id, a.name, MIN(member.created_seq) AS first_seq
           FROM member JOIN actors a ON a.actor_id = member.sender_id
          WHERE member.body_bytes > 0 AND a.kind = 'agent'
          GROUP BY member.root_id, member.sender_id
          ORDER BY member.root_id ASC, first_seq ASC`,
      )
      .bind(...memberBinds)
      .all<TaskParticipantRow>(),
    db
      .prepare(
        `WITH member AS (
           SELECT COALESCE(m.task_root_id, m.root_id) AS root_id, m.message_id,
                  m.reply_to, m.body_bytes
             FROM messages m
            WHERE ${memberFilter}
         ), ref AS (
           SELECT member.root_id, s.message_id
             FROM member
             JOIN messages s ON s.message_id = member.reply_to AND s.room_id = ?
            WHERE member.body_bytes > 0
              AND s.created_seq >= ? AND (? IS NULL OR s.created_seq <= ?)
              AND NOT EXISTS (
                SELECT 1 FROM member m2
                 WHERE m2.root_id = member.root_id AND m2.message_id = s.message_id
              )
            GROUP BY member.root_id, s.message_id
         )
         SELECT root_id, COUNT(*) AS n FROM ref GROUP BY root_id`,
      )
      .bind(
        ...memberBinds,
        roomId,
        boundary.fromSeq,
        boundary.toSeq,
        boundary.toSeq,
      )
      .all<{ root_id: string; n: number }>(),
  ]);

  for (const row of counts.results) aggregates.counts.set(row.root_id, row.n);
  for (const row of referenceCounts.results) {
    aggregates.referenceCounts.set(row.root_id, row.n);
  }
  for (const row of participantRows.results) {
    const list = aggregates.participants.get(row.root_id) ?? [];
    list.push(row);
    aggregates.participants.set(row.root_id, list);
  }
  return aggregates;
}

/** 起点作者优先、其余按首次参与顺序；与既有摘要头像组一致。 */
export function orderedParticipants(
  rows: TaskParticipantRow[],
  rootSenderId: string,
): TaskParticipantRow[] {
  return [...rows].sort((a, b) => {
    const aRoot = a.sender_id === rootSenderId ? 0 : 1;
    const bRoot = b.sender_id === rootSenderId ? 0 : 1;
    if (aRoot !== bRoot) return aRoot - bRoot;
    return a.first_seq - b.first_seq;
  });
}

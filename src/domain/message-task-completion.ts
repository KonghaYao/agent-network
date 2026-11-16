/**
 * 消息式 Task 完成。
 *
 * 完成只是给起点写一条完成事实（时间 + 操作者），不清除标记、不删除处理消息、
 * 不取消或完成任何 delivery，也不改变 `pending_count`、已读、`head_seq` 或
 * 房间排序。`open` / `completed` 由 `task_completed_at` 是否为 NULL 推导，
 * 不引入任务状态机。
 *
 * 并发完成同一 root 时，条件 UPDATE 的获胜者写入事件；失败者读取同一事务内
 * 已提交的完成事实，重复请求返回首次完成人与时间。
 */

import { BusinessError } from '../contracts/errors';
import { MESSAGE_TASK_COMPLETED_EVENT } from '../contracts/events';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { outboxStatementIfAbsent, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getMessage } from '../storage/queries';
import type { MessageRow } from '../storage/rows';
import {
  isEventKeyConflict,
  operationsStatement,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import {
  assertRoomWritable,
  capabilityGuardStatement,
  requireRoomAccess,
  roomDissolvedGuardStatement,
} from './room-access';
import { historyBoundary, visibleMessage } from './room-history';

export interface TaskCompleteInput {
  request_id: string;
  room_id: string;
  root_message_id: string;
}

export interface TaskCompleteResult {
  room_id: string;
  root_message_id: string;
  status: 'completed';
  completed_at: string;
  completed_by: string;
}

function completionOf(
  row: Pick<
    MessageRow,
    'message_id' | 'room_id' | 'task_completed_at' | 'task_completed_by'
  >,
): TaskCompleteResult | null {
  if (row.task_completed_at === null || row.task_completed_by === null) return null;
  return {
    room_id: row.room_id,
    root_message_id: row.message_id,
    status: 'completed',
    completed_at: String(row.task_completed_at),
    completed_by: row.task_completed_by,
  };
}

async function persistReplay(
  db: D1Database,
  actor: string,
  input: TaskCompleteInput,
  payloadHash: string,
  result: TaskCompleteResult,
): Promise<void> {
  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, nowMs()),
    ],
  });
}

export async function messageTaskComplete(
  db: D1Database,
  principal: Principal,
  input: TaskCompleteInput,
): Promise<TaskCompleteResult> {
  const actor = actorId(principal);
  const access = await requireRoomAccess(db, input.room_id, actor, 'send_message');
  assertRoomWritable(access.room);
  const boundary = historyBoundary(access.room, access.member);
  const target = await getMessage(db, input.root_message_id);
  if (
    !target ||
    target.room_id !== input.room_id ||
    target.task_root_id !== target.message_id ||
    !visibleMessage(target, boundary)
  ) {
    throw new BusinessError('NOT_FOUND', 'Task 起点不存在、未标记或当前不可见');
  }

  const payloadHash = await sha256Hex(stableStringify(input));
  const alreadyCompleted = completionOf(target);
  if (alreadyCompleted) {
    await persistReplay(db, actor, input, payloadHash, alreadyCompleted);
    return alreadyCompleted;
  }

  const at = nowMs();
  const eventKey = `${MESSAGE_TASK_COMPLETED_EVENT}:${target.message_id}`;
  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result: {
      room_id: input.room_id,
      root_message_id: target.message_id,
      status: 'completed',
      completed_at: String(at),
      completed_by: actor,
    } satisfies TaskCompleteResult,
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, access.room.room_id),
      capabilityGuardStatement(db, access.room.room_id, actor, 'send_message'),
      db
        .prepare(
          guardSql(
            'taskMarkUnavailable',
            `NOT EXISTS (
               SELECT 1 FROM messages m
                WHERE m.message_id = ? AND m.room_id = ?
                  AND m.task_root_id = m.message_id
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
          `UPDATE messages
              SET task_completed_at = ?, task_completed_by = ?
            WHERE message_id = ? AND room_id = ? AND task_root_id = message_id
              AND task_completed_at IS NULL`,
        )
        .bind(at, actor, target.message_id, access.room.room_id),
      // 只有本次条件 UPDATE 真正获胜时才写事件；并发的失败者不重复写。
      db
        .prepare(
          `INSERT INTO events
             (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
           SELECT 'room', ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM messages
               WHERE message_id = ? AND room_id = ?
                 AND task_completed_at = ? AND task_completed_by = ?
            )`,
        )
        .bind(
          access.room.room_id,
          MESSAGE_TASK_COMPLETED_EVENT,
          target.message_id,
          JSON.stringify({
            room_id: access.room.room_id,
            message_id: target.message_id,
            task_root_id: target.message_id,
            status: 'completed',
            completed_by: actor,
            completed_at: at,
            changed_by: actor,
          }),
          eventKey,
          at,
          target.message_id,
          access.room.room_id,
          at,
          actor,
        ),
      outboxStatementIfAbsent(db, { topic: roomTopic(access.room.room_id), eventKey }, at),
      // operations 的结果必须来自最终行：并发失败者在这里读到的也是首次完成事实。
      db
        .prepare(
          `UPDATE operations
              SET result_json = (
                SELECT json_object(
                         'room_id', m.room_id,
                         'root_message_id', m.message_id,
                         'status', 'completed',
                         'completed_at', CAST(m.task_completed_at AS TEXT),
                         'completed_by', m.task_completed_by
                       )
                  FROM messages m
                 WHERE m.message_id = ?
              )
            WHERE actor_id = ? AND request_id = ?`,
        )
        .bind(target.message_id, actor, input.request_id),
    ],
    onUniqueConflict: async (error) => {
      // 同一 actor 在同一毫秒内并发完成时事件键可能相撞；读取已提交事实收敛。
      if (!isEventKeyConflict(error)) return undefined;
      const current = await getMessage(db, target.message_id);
      return current ? completionOf(current) ?? undefined : undefined;
    },
  });

  const stored = await getMessage(db, target.message_id);
  const completed = stored ? completionOf(stored) : null;
  if (!completed) {
    throw new BusinessError('CONFLICT', 'Task 完成事务已提交但读不到完成事实');
  }
  return completed;
}

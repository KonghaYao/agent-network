import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  TaskAddInput,
  TaskClaimInput,
  TaskCompleteInput,
  TaskDeleteInput,
  TaskFailInput,
  TaskListGetInput,
  TaskSummaryInput,
  TaskUpdateInput,
} from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement, outboxStatement, roomTopic } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getMember, getOperation, getRoom, getRoomTask } from '../storage/queries';
import type { RoomRow, RoomTaskRow } from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';

/**
 * 房间任务列表（room_tasks）。
 *
 * - 每个房间一个 `default` 列表；`list_id` 只是为未来多列表预留。
 * - 任何 active 成员都能添加任务；只有 Agent 成员能 claim/complete/fail；
 *   创建者或房间 owner 能修改描述/删除。
 * - 描述与结果只保存短文本（≤120 码点，拒绝换行/控制字符）；长内容走 .md 文件。
 * - 任务变更只写 room scope informational 事件与 room outbox，不碰
 *   `rooms.head_seq`、`last_message_id`、inbox 或 `pending_count`，因此不会
 *   产生未读，也不会唤醒 Agent。Agent 在定时/唤醒后自行 list。
 */

const DEFAULT_LIST_ID = 'default';
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface RoomTaskView {
  task_id: string;
  room_id: string;
  description: string;
  status: 'pending' | 'claimed' | 'done' | 'failed';
  assignee_actor_id: string | null;
  assignee_name: string | null;
  result: string | null;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  can_edit: boolean;
  can_claim: boolean;
  can_complete: boolean;
}

export interface RoomTaskListResult {
  tasks: RoomTaskView[];
  total: number;
  done: number;
}

export interface RoomTaskResult {
  task: RoomTaskView;
}

export interface RoomTaskDeletedResult {
  task_id: string;
  deleted: true;
}

export interface RoomTaskSummaryResult {
  items: { room_id: string; total: number; done: number }[];
}

interface ViewContext {
  caller: string;
  callerKind: 'human' | 'agent';
  room: Pick<RoomRow, 'room_id' | 'owner_id'>;
  names: Map<string, string>;
}

function canEditTask(task: RoomTaskRow, context: ViewContext): boolean {
  return task.created_by === context.caller || context.room.owner_id === context.caller;
}

function taskView(task: RoomTaskRow, context: ViewContext): RoomTaskView {
  const assignee = task.assignee_actor_id;
  return {
    task_id: task.task_id,
    room_id: task.room_id,
    description: task.description,
    status: task.status,
    assignee_actor_id: assignee,
    assignee_name: assignee ? (context.names.get(assignee) ?? null) : null,
    result: task.result,
    created_by: task.created_by,
    created_by_name: context.names.get(task.created_by) ?? '',
    created_at: String(task.created_at),
    updated_at: String(task.updated_at),
    completed_at: task.completed_at === null ? null : String(task.completed_at),
    can_edit: canEditTask(task, context),
    can_claim: context.callerKind === 'agent' && task.status === 'pending',
    can_complete:
      context.callerKind === 'agent' &&
      task.status === 'claimed' &&
      task.assignee_actor_id === context.caller,
  };
}

async function actorNames(db: D1Database, actorIds: string[]): Promise<Map<string, string>> {
  const unique = Array.from(new Set(actorIds.filter((id) => id.length > 0)));
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => '?').join(', ');
  const result = await db
    .prepare(`SELECT actor_id, name FROM actors WHERE actor_id IN (${placeholders})`)
    .bind(...unique)
    .all<{ actor_id: string; name: string }>();
  return new Map(result.results.map((row) => [row.actor_id, row.name]));
}

export function normalizeTaskText(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new BusinessError('INVALID_ARGUMENT', `${label}不能为空`);
  if (CONTROL_CHARS.test(trimmed)) {
    throw new BusinessError('INVALID_ARGUMENT', `${label}不能包含换行或控制字符`);
  }
  if (Array.from(trimmed).length > LIMITS.roomTaskTextMax) {
    throw new BusinessError(
      'INVALID_ARGUMENT',
      `${label}不能超过 ${LIMITS.roomTaskTextMax} 个字符；长内容请写成 .md 文件`,
    );
  }
  return trimmed;
}

async function requireRoomMember(
  db: D1Database,
  principal: Principal,
  roomId: string,
): Promise<{ caller: string; room: RoomRow }> {
  const caller = actorId(principal);
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, caller);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  return { caller, room };
}

function requireAgent(principal: Principal): void {
  if (!principal.actor || principal.actor.kind !== 'agent') {
    throw new BusinessError('INVALID_ARGUMENT', '只有 Agent 成员可以领取或结束任务');
  }
}

function memberGuard(db: D1Database, roomId: string, actor: string): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'notMember',
        'NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = \'active\')',
      ),
    )
    .bind(roomId, actor);
}

function taskEditorGuard(
  db: D1Database,
  taskId: string,
  actor: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'taskEditor',
        `NOT EXISTS (
           SELECT 1 FROM room_tasks t
            WHERE t.task_id = ?
              AND (t.created_by = ? OR EXISTS (
                SELECT 1 FROM rooms r WHERE r.room_id = t.room_id AND r.owner_id = ?
              ))
         )`,
      ),
    )
    .bind(taskId, actor, actor);
}

function taskEventStatement(
  db: D1Database,
  task: Pick<RoomTaskRow, 'task_id' | 'room_id' | 'status'>,
  eventType: string,
  changedBy: string,
  at: number,
): { eventKey: string; statement: D1PreparedStatement; outbox: D1PreparedStatement } {
  const eventKey = `room_task:${eventType}:${task.task_id}:${crypto.randomUUID().replaceAll('-', '')}`;
  return {
    eventKey,
    statement: eventStatement(
      db,
      {
        eventKey,
        scopeKind: 'room',
        scopeId: task.room_id,
        eventType,
        refId: task.task_id,
        metadata: { task_id: task.task_id, status: task.status, changed_by: changedBy },
      },
      at,
    ),
    outbox: outboxStatement(db, { topic: roomTopic(task.room_id), eventKey }, at),
  };
}

async function contextFor(
  db: D1Database,
  principal: Principal,
  caller: string,
  room: RoomRow,
  tasks: RoomTaskRow[],
): Promise<ViewContext> {
  const ids: string[] = [];
  for (const task of tasks) {
    ids.push(task.created_by);
    if (task.assignee_actor_id) ids.push(task.assignee_actor_id);
  }
  return {
    caller,
    callerKind: principal.actor?.kind ?? 'human',
    room,
    names: await actorNames(db, ids),
  };
}

export async function taskListGet(
  db: D1Database,
  principal: Principal,
  input: TaskListGetInput,
): Promise<RoomTaskListResult> {
  const { caller, room } = await requireRoomMember(db, principal, input.room_id);
  const result = await db
    .prepare(
      `SELECT * FROM room_tasks
        WHERE room_id = ? AND list_id = ?
        ORDER BY sort_order ASC, task_id ASC`,
    )
    .bind(room.room_id, DEFAULT_LIST_ID)
    .all<RoomTaskRow>();
  const context = await contextFor(db, principal, caller, room, result.results);
  const tasks = result.results.map((task) => taskView(task, context));
  return {
    tasks,
    total: tasks.length,
    done: tasks.filter((task) => task.status === 'done').length,
  };
}

/**
 * 一次汇总当前身份所有 active 房间的任务进度。
 *
 * 可选 room_ids 只用于过滤；非成员房间不会出现在结果里，也不暴露房间是否存在。
 */
export async function taskSummary(
  db: D1Database,
  principal: Principal,
  input: TaskSummaryInput,
): Promise<RoomTaskSummaryResult> {
  const caller = actorId(principal);
  const filters = input.room_ids ?? [];
  const placeholders = filters.length > 0 ? ` AND m.room_id IN (${filters.map(() => '?').join(', ')})` : '';
  const result = await db
    .prepare(
      `SELECT m.room_id AS room_id,
              COUNT(t.task_id) AS total,
              COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0) AS done
         FROM room_members m
         LEFT JOIN room_tasks t
           ON t.room_id = m.room_id AND t.list_id = ?
        WHERE m.actor_id = ? AND m.status = 'active'${placeholders}
        GROUP BY m.room_id
        ORDER BY m.room_id ASC`,
    )
    .bind(DEFAULT_LIST_ID, caller, ...filters)
    .all<{ room_id: string; total: number; done: number }>();
  return {
    items: result.results.map((row) => ({
      room_id: row.room_id,
      total: row.total,
      done: row.done,
    })),
  };
}

export async function taskAdd(
  db: D1Database,
  principal: Principal,
  input: TaskAddInput,
): Promise<RoomTaskResult> {
  const { caller, room } = await requireRoomMember(db, principal, input.room_id);
  const description = normalizeTaskText(input.description, '任务描述');
  const payloadHash = await sha256Hex(
    stableStringify({ room_id: room.room_id, description }),
  );
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as RoomTaskResult;

  const at = nowMs();
  const task: RoomTaskRow = {
    task_id: `task_${crypto.randomUUID().replaceAll('-', '')}`,
    room_id: room.room_id,
    list_id: DEFAULT_LIST_ID,
    description,
    status: 'pending',
    assignee_actor_id: null,
    result: null,
    created_by: caller,
    created_at: at,
    updated_at: at,
    completed_at: null,
    sort_order: 0,
  };
  const context: ViewContext = {
    caller,
    callerKind: principal.actor?.kind ?? 'human',
    room,
    names: await actorNames(db, [caller]),
  };
  const result: RoomTaskResult = { task: taskView(task, context) };
  const event = taskEventStatement(db, task, 'room_task_added', caller, at);

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, room.room_id, caller),
      db
        .prepare(
          guardSql(
            'roomTaskLimit',
            '(SELECT COUNT(*) FROM room_tasks WHERE room_id = ? AND list_id = ?) >= ?',
          ),
        )
        .bind(room.room_id, DEFAULT_LIST_ID, LIMITS.roomTasksPerRoom),
      db
        .prepare(
          `INSERT INTO room_tasks
             (task_id, room_id, list_id, description, status, assignee_actor_id,
              result, created_by, created_at, updated_at, completed_at, sort_order)
           VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, NULL,
             (SELECT COALESCE(MAX(sort_order), 0) + 1
                FROM room_tasks WHERE room_id = ? AND list_id = ?))`,
        )
        .bind(
          task.task_id,
          task.room_id,
          task.list_id,
          task.description,
          task.created_by,
          task.created_at,
          task.updated_at,
          task.room_id,
          task.list_id,
        ),
      event.statement,
      event.outbox,
    ],
  });
  return result;
}

export async function taskClaim(
  db: D1Database,
  principal: Principal,
  input: TaskClaimInput,
): Promise<RoomTaskResult> {
  requireAgent(principal);
  const caller = actorId(principal);
  const payloadHash = await sha256Hex(stableStringify({ task_id: input.task_id }));
  // 幂等重放先于状态校验：任务被领取/完成后，相同 request_id 仍返回原结果。
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as RoomTaskResult;

  const existing = await getRoomTask(db, input.task_id);
  if (!existing) throw new BusinessError('NOT_FOUND', '任务不存在');
  const { room } = await requireRoomMember(db, principal, existing.room_id);
  if (existing.status !== 'pending') {
    throw new BusinessError('CLAIM_CONFLICT', '任务已被领取或状态已变化', {
      task_id: existing.task_id,
    });
  }

  const at = nowMs();
  const task: RoomTaskRow = {
    ...existing,
    status: 'claimed',
    assignee_actor_id: caller,
    updated_at: at,
  };
  const context = await contextFor(db, principal, caller, room, [task]);
  const result: RoomTaskResult = { task: taskView(task, context) };
  const event = taskEventStatement(db, task, 'room_task_claimed', caller, at);

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, room.room_id, caller),
      db
        .prepare(
          `UPDATE room_tasks
              SET status = 'claimed', assignee_actor_id = ?, updated_at = ?
            WHERE task_id = ? AND status = 'pending'`,
        )
        .bind(caller, at, task.task_id),
      db
        .prepare(
          guardSql(
            'taskConflict',
            `NOT EXISTS (
               SELECT 1 FROM room_tasks
                WHERE task_id = ? AND status = 'claimed' AND assignee_actor_id = ?
             )`,
          ),
        )
        .bind(task.task_id, caller),
      event.statement,
      event.outbox,
    ],
  });
  return result;
}

async function finishTask(
  db: D1Database,
  principal: Principal,
  input: TaskCompleteInput | TaskFailInput,
  status: 'done' | 'failed',
): Promise<RoomTaskResult> {
  requireAgent(principal);
  const caller = actorId(principal);
  const text =
    status === 'done'
      ? normalizeTaskText((input as TaskCompleteInput).result, '任务结果')
      : normalizeTaskText((input as TaskFailInput).error, '失败原因');
  const payloadHash = await sha256Hex(stableStringify({ task_id: input.task_id, result: text }));
  // 幂等重放先于状态校验：任务已完成/失败后，相同 request_id 仍返回原结果。
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as RoomTaskResult;

  const existing = await getRoomTask(db, input.task_id);
  if (!existing) throw new BusinessError('NOT_FOUND', '任务不存在');
  const { room } = await requireRoomMember(db, principal, existing.room_id);
  if (existing.status !== 'claimed' || existing.assignee_actor_id !== caller) {
    throw new BusinessError('CLAIM_CONFLICT', '任务不是由当前身份领取或状态已变化', {
      task_id: existing.task_id,
    });
  }

  const at = nowMs();
  const task: RoomTaskRow = {
    ...existing,
    status,
    result: text,
    updated_at: at,
    completed_at: at,
  };
  const context = await contextFor(db, principal, caller, room, [task]);
  const result: RoomTaskResult = { task: taskView(task, context) };
  const event = taskEventStatement(
    db,
    task,
    status === 'done' ? 'room_task_completed' : 'room_task_failed',
    caller,
    at,
  );

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, room.room_id, caller),
      db
        .prepare(
          `UPDATE room_tasks
              SET status = ?, result = ?, updated_at = ?, completed_at = ?
            WHERE task_id = ? AND status = 'claimed' AND assignee_actor_id = ?`,
        )
        .bind(status, text, at, at, task.task_id, caller),
      db
        .prepare(
          guardSql(
            'taskConflict',
            `NOT EXISTS (
               SELECT 1 FROM room_tasks
                WHERE task_id = ? AND status = ? AND assignee_actor_id = ?
             )`,
          ),
        )
        .bind(task.task_id, status, caller),
      event.statement,
      event.outbox,
    ],
  });
  return result;
}

export function taskComplete(
  db: D1Database,
  principal: Principal,
  input: TaskCompleteInput,
): Promise<RoomTaskResult> {
  return finishTask(db, principal, input, 'done');
}

export function taskFail(
  db: D1Database,
  principal: Principal,
  input: TaskFailInput,
): Promise<RoomTaskResult> {
  return finishTask(db, principal, input, 'failed');
}

export async function taskUpdate(
  db: D1Database,
  principal: Principal,
  input: TaskUpdateInput,
): Promise<RoomTaskResult> {
  const caller = actorId(principal);
  const description = normalizeTaskText(input.description, '任务描述');
  const payloadHash = await sha256Hex(
    stableStringify({ task_id: input.task_id, description }),
  );
  // 幂等重放先于权限/状态校验；任务被删除后仍能返回原结果。
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as RoomTaskResult;

  const existing = await getRoomTask(db, input.task_id);
  if (!existing) throw new BusinessError('NOT_FOUND', '任务不存在');
  const { room } = await requireRoomMember(db, principal, existing.room_id);
  if (existing.created_by !== caller && room.owner_id !== caller) {
    throw new BusinessError('NOT_OWNER', '只有任务创建者或房间 owner 可以修改任务');
  }

  const at = nowMs();
  const task: RoomTaskRow = { ...existing, description, updated_at: at };
  const context = await contextFor(db, principal, caller, room, [task]);
  const result: RoomTaskResult = { task: taskView(task, context) };
  const event = taskEventStatement(db, task, 'room_task_updated', caller, at);

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, room.room_id, caller),
      taskEditorGuard(db, task.task_id, caller),
      db
        .prepare('UPDATE room_tasks SET description = ?, updated_at = ? WHERE task_id = ?')
        .bind(description, at, task.task_id),
      event.statement,
      event.outbox,
    ],
  });
  return result;
}

export async function taskDelete(
  db: D1Database,
  principal: Principal,
  input: TaskDeleteInput,
): Promise<RoomTaskDeletedResult> {
  const caller = actorId(principal);
  const payloadHash = await sha256Hex(stableStringify({ task_id: input.task_id }));
  // 删除成功后任务行已不存在；重放必须先读 operations。
  const replay = await getOperation(db, caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as RoomTaskDeletedResult;

  const existing = await getRoomTask(db, input.task_id);
  if (!existing) throw new BusinessError('NOT_FOUND', '任务不存在');
  const { room } = await requireRoomMember(db, principal, existing.room_id);
  if (existing.created_by !== caller && room.owner_id !== caller) {
    throw new BusinessError('NOT_OWNER', '只有任务创建者或房间 owner 可以删除任务');
  }

  const at = nowMs();
  const result: RoomTaskDeletedResult = { task_id: existing.task_id, deleted: true };
  const event = taskEventStatement(db, existing, 'room_task_deleted', caller, at);

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      memberGuard(db, room.room_id, caller),
      taskEditorGuard(db, existing.task_id, caller),
      db.prepare('DELETE FROM room_tasks WHERE task_id = ?').bind(existing.task_id),
      event.statement,
      event.outbox,
    ],
  });
  return result;
}

/**
 * D04 任务转交与接任确认。
 *
 * 权威关系：`tasks` + `task_assignments` 决定责任，`task_transfers` 只保存
 * 待确认提议。接受前原负责人继续负责；拒绝、取消、过期不改变 assignment。
 * 接受事务原子换人、递增 assignment_version、撤销旧 active assignment 并
 * 关闭旧 assignment 仍有效的任务投递。
 *
 * 任务事件是 human-only 提示：只写 room scope 事件与 `room:{id}` outbox，
 * 不创建 delivery、不增加 Agent pending_count、不推进 rooms.head_seq。
 */

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  TaskTransferAcceptInput,
  TaskTransferCancelInput,
  TaskTransferGetInput,
  TaskTransferListInput,
  TaskTransferProposeInput,
  TaskTransferRejectInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement, inboxHeadStatement } from '../storage/events';
import { guardSql } from '../storage/guards';
import {
  getDelivery,
  getMember,
  getOperation,
  getTask,
  getTaskAssignment,
  getTaskCard,
  getTaskTransfer,
} from '../storage/queries';
import type {
  TaskAssignmentRow,
  TaskDeliveryRow,
  TaskRow,
  TaskTransferRow,
} from '../storage/rows';
import {
  operationsStatement,
  resolveOperation,
  runIdempotent,
} from '../storage/transactions/runner';
import { contactBlockGuardStatement } from './contact-blocks';
import { actorId, type Principal } from './principal';
import {
  activeAssignmentGuard,
  actualTaskState,
  actorNames,
  assertTaskParticipant,
  blockedBetween,
  canDispatch,
  isOwnerOrAdmin,
  memberGuard,
  normalizeTaskBody,
  requireVisibleTask,
  rethrowWithActualState,
  staleTaskError,
  taskDeliveryIds,
  taskRevisionGuard,
  taskRoomEvent,
  taskStateGuard,
  viewFromKnownRow,
  type TaskContext,
  type TaskResult,
  type TaskView,
} from './tasks';
import { historySnapshot } from './room-history';
import { handoffReadinessForTransfer } from './task-handoff-packs';

export type TaskTransferStatus = TaskTransferRow['status'];

export interface TaskTransferView {
  transfer_id: string;
  task_id: string;
  room_id: string;
  task_title: string;
  task_status: TaskRow['status'];
  task_revision: number;
  from_assignment_id: string | null;
  from_assignment_version: number | null;
  from_owner_actor_id: string | null;
  from_owner_name: string | null;
  to_actor_id: string;
  to_actor_name: string;
  requested_by: string;
  requested_by_name: string;
  status: TaskTransferStatus;
  /** `pending` 但已过有效期时显示为 `expired`，不修改原 assignment。 */
  effective_status: TaskTransferStatus;
  expires_at: string;
  created_at: string;
  responded_at: string | null;
  responded_by: string | null;
  context: Record<string, unknown>;
  /** 最新交接包对该提议目标是否就绪；没有包时为 false（D04 兼容）。 */
  context_ready: boolean;
  note: string | null;
  can_accept: boolean;
  can_reject: boolean;
  can_cancel: boolean;
}

export interface TaskTransferResult {
  transfer: TaskTransferView;
  task: TaskView;
}

export interface TaskTransferListResult {
  transfers: TaskTransferView[];
  next_cursor: null;
  has_more: false;
}

function parseContext(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function noteOf(context: Record<string, unknown>): string | null {
  const note = context.note;
  return typeof note === 'string' && note.trim() ? note : null;
}

function normalizeTransferReason(
  value: string | undefined,
  label: string,
): string | null {
  const normalized = normalizeTaskBody(value, label, LIMITS.taskCancelReasonBytes);
  return normalized || null;
}

function normalizeTransferNote(value: string | undefined): string | null {
  const normalized = normalizeTaskBody(value, '交接说明', LIMITS.taskProgressNoteBytes);
  return normalized || null;
}

function effectiveStatus(row: TaskTransferRow, at: number): TaskTransferStatus {
  if (row.status === 'pending' && row.expires_at <= at) return 'expired';
  return row.status;
}

function isTransferParticipant(
  task: TaskRow,
  context: TaskContext,
  transfer: Pick<TaskTransferRow, 'to_actor_id' | 'created_by'>,
): boolean {
  return (
    transfer.to_actor_id === context.caller ||
    transfer.created_by === context.caller ||
    task.created_by === context.caller ||
    task.reviewer_actor_id === context.caller ||
    task.owner_actor_id === context.caller ||
    isOwnerOrAdmin(context.room, context.member)
  );
}

async function transferView(
  db: D1Database,
  context: TaskContext,
  task: TaskRow,
  row: TaskTransferRow,
  at: number,
): Promise<TaskTransferView> {
  const assignment = row.from_assignment_id
    ? await getTaskAssignment(db, row.from_assignment_id)
    : task.current_assignment_id
      ? await getTaskAssignment(db, task.current_assignment_id)
      : null;
  const contextValues = parseContext(row.context_json);
  const handoff = await handoffReadinessForTransfer(
    db,
    task,
    row.from_assignment_id,
    row.to_actor_id,
  );
  const names = await actorNames(db, [
    row.to_actor_id,
    row.created_by,
    ...(assignment ? [assignment.owner_actor_id] : []),
  ]);
  const live = effectiveStatus(row, at);
  const ownerMatches =
    assignment !== null &&
    task.current_assignment_id === assignment.assignment_id &&
    assignment.status === 'active';
  return {
    transfer_id: row.transfer_id,
    task_id: row.task_id,
    room_id: task.room_id,
    task_title: task.title,
    task_status: task.status,
    task_revision: task.revision,
    from_assignment_id: row.from_assignment_id,
    from_assignment_version: row.from_assignment_version,
    from_owner_actor_id: assignment?.owner_actor_id ?? null,
    from_owner_name: assignment ? (names.get(assignment.owner_actor_id) ?? null) : null,
    to_actor_id: row.to_actor_id,
    to_actor_name: names.get(row.to_actor_id) ?? '',
    requested_by: row.created_by,
    requested_by_name: names.get(row.created_by) ?? '',
    status: row.status,
    effective_status: live,
    expires_at: String(row.expires_at),
    created_at: String(row.created_at),
    responded_at: row.responded_at === null ? null : String(row.responded_at),
    responded_by: row.responded_by,
    context: {
      ...contextValues,
      ...(handoff.has_pack
        ? {
            pack_id: handoff.pack_id,
            pack_version: handoff.pack_version,
            required_missing: handoff.required_missing,
            context_ready: handoff.context_ready,
          }
        : {}),
    },
    context_ready: handoff.context_ready,
    note: noteOf(contextValues),
    can_accept:
      live === 'pending' &&
      row.to_actor_id === context.caller &&
      ownerMatches &&
      (task.status === 'in_progress' || task.status === 'blocked'),
    can_reject: live === 'pending' && row.to_actor_id === context.caller,
    can_cancel:
      live === 'pending' &&
      (row.created_by === context.caller ||
        task.created_by === context.caller ||
        task.owner_actor_id === context.caller ||
        isOwnerOrAdmin(context.room, context.member)),
  };
}

async function loadTransfer(
  db: D1Database,
  transferId: string,
): Promise<TaskTransferRow> {
  const row = await getTaskTransfer(db, transferId);
  if (!row) throw new BusinessError('NOT_FOUND', '交接提议不存在');
  return row;
}

function transferRow(input: {
  transferId: string;
  task: TaskRow;
  assignment: TaskAssignmentRow;
  toActorId: string;
  createdBy: string;
  note: string | null;
  at: number;
  expiresAt: number;
}): TaskTransferRow {
  return {
    transfer_id: input.transferId,
    task_id: input.task.task_id,
    from_assignment_id: input.assignment.assignment_id,
    from_assignment_version: input.assignment.assignment_version,
    to_actor_id: input.toActorId,
    status: 'pending',
    context_json: JSON.stringify({
      prepared: false,
      note: input.note,
      from_assignment_version: input.assignment.assignment_version,
      task_revision: input.task.revision,
      caveat: 'D05 上下文包尚未生成；接受后请读取任务详情与附件。',
    }),
    version: 1,
    created_by: input.createdBy,
    created_at: input.at,
    expires_at: input.expiresAt,
    responded_at: null,
    responded_by: null,
  };
}

/**
 * 事务内构造“提交成果使待处理交接失效”语句，供 D06 的 submit 直接展开。
 *
 * 只关闭 pending 提议；已接受/拒绝/取消的行保持不变。事件是可选的 room
 * 提示，不改变 assignment 或 task revision。
 */
export async function cancelPendingTransfersForTask(
  db: D1Database,
  input: {
    taskId: string;
    actor: string;
    requestId: string;
    at: number;
    reason: string;
    /** 触发失效率的业务动作；默认保持 D06 提交语义。 */
    invalidatedBy?: 'submit' | 'cancel' | 'retry';
  },
): Promise<D1PreparedStatement[]> {
  const rows = await db
    .prepare("SELECT * FROM task_transfers WHERE task_id = ? AND status = 'pending'")
    .bind(input.taskId)
    .all<TaskTransferRow>();
  const task = await getTask(db, input.taskId);
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    const context = parseContext(row.context_json);
    statements.push(
      db
        .prepare(
          `UPDATE task_transfers
              SET status = 'cancelled', responded_at = ?, responded_by = ?, context_json = ?
            WHERE transfer_id = ? AND status = 'pending'`,
        )
        .bind(
          input.at,
          input.actor,
          JSON.stringify({
            ...context,
            response_reason: input.reason,
            invalidated_by: input.invalidatedBy ?? 'submit',
          }),
          row.transfer_id,
        ),
    );
    if (task) {
      statements.push(
        ...taskRoomEvent(
          db,
          task,
          'task_transfer_cancelled',
          `task:transfer-cancelled:${row.transfer_id}:${input.requestId}`,
          input.at,
          {
            changed_by: input.actor,
            transfer_id: row.transfer_id,
            to_actor_id: row.to_actor_id,
            reason: input.reason,
          },
        ).statements,
      );
    }
  }
  return statements;
}

/**
 * 成员失权/停用/移除时撤销任务执行资格。
 *
 * 由成员生命周期事务调用，返回可展开的语句。`in_progress/blocked` 任务转为
 * blocked + `owner_lost_eligibility`；尚未接受的 `offered` 任务回到
 * `unassigned`，避免把未接手的邀请算成已执行工作。旧 assignment 撤销，
 * 该 assignment 仍 pending/claimed 的任务投递关闭，pending 交接取消。
 * 外部副作用保持未知，这里不自动重跑任何执行。
 */
export async function revokeTaskEligibilityStatements(
  db: D1Database,
  input: {
    actorId: string;
    /** 只处理指定房间；null 表示该 actor 在所有房间的任务（停用 Agent）。 */
    roomId: string | null;
    requestId: string;
    at: number;
    reason?: string;
  },
): Promise<D1PreparedStatement[]> {
  const scope = input.roomId ? ' AND t.room_id = ?' : '';
  const binds = input.roomId
    ? [input.roomId, input.actorId, input.actorId]
    : [input.actorId, input.actorId];
  const tasks = await db
    .prepare(
      `SELECT t.* FROM tasks t
         LEFT JOIN task_assignments a ON a.assignment_id = t.current_assignment_id
        WHERE t.status IN ('offered', 'in_progress', 'blocked')${scope}
          AND (
            t.owner_actor_id = ?
            OR (a.owner_actor_id = ? AND a.status IN ('offered', 'active'))
          )
        ORDER BY t.task_id ASC`,
    )
    .bind(...binds)
    .all<TaskRow>();
  const statements: D1PreparedStatement[] = [];
  for (const task of tasks.results) {
    const assignment = task.current_assignment_id
      ? await getTaskAssignment(db, task.current_assignment_id)
      : null;
    const reason = input.reason ?? 'owner_lost_eligibility';

    if (task.status === 'offered') {
      // offered 还没有被接受，不冒充“执行中”；撤销邀请后回到 unassigned。
      if (
        !assignment ||
        assignment.owner_actor_id !== input.actorId ||
        assignment.status !== 'offered'
      ) {
        continue;
      }
      const unassignedTask: TaskRow = {
        ...task,
        status: 'unassigned',
        revision: task.revision + 1,
        owner_actor_id: null,
        current_assignment_id: null,
        blocked_reason: null,
        blocked_at: null,
        updated_at: input.at,
      };
      statements.push(
        db
          .prepare(
            `UPDATE tasks
                SET status = 'unassigned', owner_actor_id = NULL, current_assignment_id = NULL,
                    blocked_reason = NULL, blocked_at = NULL,
                    revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND revision = ? AND status = 'offered'
                AND current_assignment_id = ?`,
          )
          .bind(input.at, task.task_id, task.revision, assignment.assignment_id),
        db
          .prepare(
            `UPDATE task_assignments
                SET status = 'revoked', ended_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status = 'offered'`,
          )
          .bind(input.at, input.at, assignment.assignment_id),
        ...(await closeTaskDeliveries(
          db,
          assignment,
          task,
          input.actorId,
          reason,
          input.requestId,
          input.at,
        )).statements,
        ...(await cancelPendingTransferStatements(
          db,
          task,
          input.actorId,
          input.requestId,
          input.at,
          'owner_lost_eligibility',
        )),
        ...taskRoomEvent(
          db,
          unassignedTask,
          'task_offer_declined',
          `task:eligibility-lost:${task.task_id}:${input.requestId}`,
          input.at,
          {
            changed_by: input.actorId,
            reason: 'owner_lost_eligibility',
            previous_owner_actor_id: input.actorId,
            assignment_id: assignment.assignment_id,
            assignment_version: assignment.assignment_version,
          },
        ).statements,
      );
      continue;
    }

    if (task.owner_actor_id !== input.actorId) {
      // 已 blocked 且没有任务负责人、但旧 assignment 仍指向该成员：只撤销
      // 执行资格与投递，不改写他人负责的任务状态。
      if (assignment && assignment.owner_actor_id === input.actorId) {
        statements.push(
          db
            .prepare(
              `UPDATE task_assignments
                  SET status = 'revoked', ended_at = ?, updated_at = ?
                WHERE assignment_id = ? AND status IN ('offered', 'active')`,
            )
            .bind(input.at, input.at, assignment.assignment_id),
          ...(await closeTaskDeliveries(
            db,
            assignment,
            task,
            input.actorId,
            reason,
            input.requestId,
            input.at,
          )).statements,
        );
      }
      continue;
    }

    const nextRevision = task.revision + 1;
    const blockedTask: TaskRow = {
      ...task,
      status: 'blocked',
      revision: nextRevision,
      owner_actor_id: null,
      current_assignment_id: null,
      blocked_reason: 'owner_lost_eligibility',
      blocked_at: input.at,
      updated_at: input.at,
    };
    statements.push(
      db
        .prepare(
          `UPDATE tasks
              SET status = 'blocked', owner_actor_id = NULL, current_assignment_id = NULL,
                  blocked_reason = 'owner_lost_eligibility',
                  blocked_at = ?, revision = revision + 1, updated_at = ?
            WHERE task_id = ? AND revision = ? AND owner_actor_id = ?`,
        )
        .bind(input.at, input.at, task.task_id, task.revision, input.actorId),
    );
    if (assignment) {
      statements.push(
        db
          .prepare(
            `UPDATE task_assignments
                SET status = 'revoked', ended_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status IN ('offered', 'active')`,
          )
          .bind(input.at, input.at, assignment.assignment_id),
        ...(await closeTaskDeliveries(
          db,
          assignment,
          task,
          input.actorId,
          reason,
          input.requestId,
          input.at,
        )).statements,
      );
    }
    statements.push(
      ...(await cancelPendingTransferStatements(
        db,
        task,
        input.actorId,
        input.requestId,
        input.at,
        'owner_lost_eligibility',
      )),
      ...taskRoomEvent(
        db,
        blockedTask,
        'task_blocked',
        `task:eligibility-lost:${task.task_id}:${input.requestId}`,
        input.at,
        {
          changed_by: input.actorId,
          reason: 'owner_lost_eligibility',
          previous_owner_actor_id: input.actorId,
          ...(assignment
            ? {
                assignment_id: assignment.assignment_id,
                assignment_version: assignment.assignment_version,
              }
            : {}),
        },
      ).statements,
    );
  }
  return statements;
}

async function cancelPendingTransferStatements(
  db: D1Database,
  task: TaskRow,
  actor: string,
  requestId: string,
  at: number,
  reason: string,
): Promise<D1PreparedStatement[]> {
  const rows = await db
    .prepare("SELECT * FROM task_transfers WHERE task_id = ? AND status = 'pending'")
    .bind(task.task_id)
    .all<TaskTransferRow>();
  return rows.results.flatMap((row) => {
    const context = parseContext(row.context_json);
    return [
      db
        .prepare(
          `UPDATE task_transfers
              SET status = 'cancelled', responded_at = ?, responded_by = ?, context_json = ?
            WHERE transfer_id = ? AND status = 'pending'`,
        )
        .bind(
          at,
          actor,
          JSON.stringify({ ...context, response_reason: reason }),
          row.transfer_id,
        ),
      ...taskRoomEvent(
        db,
        task,
        'task_transfer_cancelled',
        `task:transfer-cancelled:${row.transfer_id}:${requestId}`,
        at,
        {
          changed_by: actor,
          transfer_id: row.transfer_id,
          to_actor_id: row.to_actor_id,
          reason,
        },
      ).statements,
    ];
  });
}

/** 关闭某旧 assignment 仍 pending/claimed 的任务投递；不向 recipient 写 outbox。 */
export async function closeTaskDeliveries(
  db: D1Database,
  assignment: TaskAssignmentRow,
  task: TaskRow,
  actor: string,
  reason: string,
  requestId: string,
  at: number,
): Promise<{ statements: D1PreparedStatement[]; deliveryIds: string[] }> {
  const rows = await db
    .prepare('SELECT * FROM task_deliveries WHERE assignment_id = ?')
    .bind(assignment.assignment_id)
    .all<TaskDeliveryRow>();
  const statements: D1PreparedStatement[] = [];
  const deliveryIds: string[] = [];
  for (const row of rows.results) {
    const delivery = await getDelivery(db, row.delivery_id);
    if (!delivery) continue;
    deliveryIds.push(delivery.delivery_id);
    if (delivery.state !== 'pending' && delivery.state !== 'claimed') continue;
    const inboxKey = `transfer:${delivery.delivery_id}:${requestId}`;
    statements.push(
      db
        .prepare(
          `UPDATE actors
              SET pending_count = pending_count - (
                    SELECT CASE WHEN state = 'pending' THEN 1 ELSE 0 END
                      FROM deliveries WHERE delivery_id = ?
                  ),
                  updated_at = ?
            WHERE actor_id = ?`,
        )
        .bind(delivery.delivery_id, at, delivery.recipient_id),
      db
        .prepare(
          `UPDATE deliveries SET state = 'cancelled', error = ?, updated_at = ?
            WHERE delivery_id = ? AND state IN ('pending', 'claimed')`,
        )
        .bind(reason, at, delivery.delivery_id),
      eventStatement(
        db,
        {
          eventKey: inboxKey,
          scopeKind: 'inbox',
          scopeId: delivery.recipient_id,
          eventType: 'delivery_cancelled',
          refId: delivery.delivery_id,
          metadata: {
            reason,
            actor_id: actor,
            room_id: delivery.room_id,
            message_id: delivery.message_id,
            sender_id: task.created_by,
            task_id: task.task_id,
            assignment_id: assignment.assignment_id,
          },
        },
        at,
      ),
      inboxHeadStatement(db, delivery.recipient_id, inboxKey, at, 0),
    );
  }
  return { statements, deliveryIds };
}

async function transferTaskResult(
  db: D1Database,
  context: TaskContext,
  task: TaskRow,
  assignment: TaskAssignmentRow | null,
  deliveryIds: string[],
): Promise<TaskView> {
  const card = await getTaskCard(db, task.task_id);
  const attachments = await db
    .prepare(
      `SELECT file_id, label FROM task_attachments
        WHERE task_id = ? ORDER BY created_at ASC, file_id ASC`,
    )
    .bind(task.task_id)
    .all<{ file_id: string; label: string }>();
  const names = await actorNames(db, [
    task.created_by,
    task.reviewer_actor_id,
    ...(task.owner_actor_id ? [task.owner_actor_id] : []),
    ...(assignment ? [assignment.owner_actor_id] : []),
  ]);
  return viewFromKnownRow(
    db,
    context,
    task,
    card?.message_id ?? '',
    assignment,
    deliveryIds,
    attachments.results,
    names,
  );
}

export async function taskTransferPropose(
  db: D1Database,
  principal: Principal,
  input: TaskTransferProposeInput,
): Promise<TaskTransferResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const note = normalizeTransferNote(input.note);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      to_actor_id: input.to_actor_id,
      note,
      assignment_id: input.assignment_id ?? null,
      assignment_version: input.assignment_version ?? null,
      expected_revision: input.expected_revision ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskTransferResult;

  const isCurrentOwner = task.owner_actor_id === context.caller;
  const dispatcher = canDispatch(task, context);
  if (!isCurrentOwner && !dispatcher) {
    const prior = await db
      .prepare(
        'SELECT 1 AS n FROM task_assignments WHERE task_id = ? AND owner_actor_id = ? LIMIT 1',
      )
      .bind(task.task_id, context.caller)
      .first<{ n: number }>();
    if (prior) {
      throw await staleTaskError(
        db,
        task.task_id,
        'ASSIGNMENT_STALE',
        '当前执行资格已失效，不能以旧负责人身份转交任务',
      );
    }
    throw new BusinessError(
      'PERMISSION_DENIED',
      '只有当前负责人、创建者或群 owner/管理员可以发起任务交接',
    );
  }
  if (task.status !== 'in_progress' && task.status !== 'blocked') {
    throw new BusinessError('CONFLICT', '只有进行中或受阻任务可以发起交接', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  if (
    !assignment ||
    assignment.status !== 'active' ||
    assignment.owner_actor_id !== task.owner_actor_id
  ) {
    throw await staleTaskError(
      db,
      task.task_id,
      'ASSIGNMENT_STALE',
      '当前执行资格已失效，不能发起交接',
    );
  }
  if (input.assignment_id !== undefined && input.assignment_id !== assignment.assignment_id) {
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '任务执行版本已变化');
  }
  if (
    input.assignment_version !== undefined &&
    input.assignment_version !== assignment.assignment_version
  ) {
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '任务执行版本已变化');
  }
  if (input.to_actor_id === context.caller) {
    throw new BusinessError('INVALID_ARGUMENT', '不能把任务交接给自己');
  }
  if (input.to_actor_id === task.owner_actor_id) {
    throw new BusinessError('INVALID_ARGUMENT', '目标已经是当前负责人');
  }
  if (input.to_actor_id === task.reviewer_actor_id) {
    throw new BusinessError('INVALID_ARGUMENT', '目标不能是当前验收人');
  }
  await assertTaskParticipant(
    db,
    context.room,
    input.to_actor_id,
    '接任者',
    task.created_at,
  );
  if (await blockedBetween(db, context.caller, input.to_actor_id)) {
    throw new BusinessError('BLOCKED', '调用者与接任者之间存在拉黑关系');
  }
  if (
    task.created_by !== context.caller &&
    (await blockedBetween(db, task.created_by, input.to_actor_id))
  ) {
    throw new BusinessError('BLOCKED', '任务创建者与接任者之间存在拉黑关系');
  }
  if (
    task.reviewer_actor_id !== context.caller &&
    (await blockedBetween(db, task.reviewer_actor_id, input.to_actor_id))
  ) {
    throw new BusinessError('BLOCKED', '验收人与接任者之间存在拉黑关系');
  }

  const at = nowMs();
  const pendingRows = await db
    .prepare("SELECT * FROM task_transfers WHERE task_id = ? AND status = 'pending'")
    .bind(task.task_id)
    .all<TaskTransferRow>();
  const livePending = pendingRows.results.filter((row) => row.expires_at > at);
  if (livePending.length > 0) {
    throw new BusinessError('CONFLICT', '该任务已有待处理的交接提议', {
      task_id: task.task_id,
      transfer_id: livePending[0]?.transfer_id,
    });
  }
  const transferId = newId('trf');
  const expiresAt = at + LIMITS.taskTransferTtlMs;
  const row = transferRow({
    transferId,
    task,
    assignment,
    toActorId: input.to_actor_id,
    createdBy: context.caller,
    note,
    at,
    expiresAt,
  });
  const view = await transferView(db, context, task, row, at);
  const result: TaskTransferResult = {
    transfer: view,
    task: (await resultForTask(db, context, task)).task,
  };

  const expiredStatements: D1PreparedStatement[] = [];
  for (const expired of pendingRows.results.filter((item) => item.expires_at <= at)) {
    expiredStatements.push(
      db
        .prepare(
          `UPDATE task_transfers SET status = 'expired', responded_at = ?, responded_by = NULL
            WHERE transfer_id = ? AND status = 'pending'`,
        )
        .bind(at, expired.transfer_id),
      ...taskRoomEvent(
        db,
        task,
        'task_transfer_expired',
        `task:transfer-expired:${expired.transfer_id}`,
        at,
        {
          changed_by: context.caller,
          transfer_id: expired.transfer_id,
          to_actor_id: expired.to_actor_id,
        },
      ).statements,
    );
  }

  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        taskRevisionGuard(db, task.task_id, task.revision),
        taskStateGuard(
          db,
          task.task_id,
          "status IN ('in_progress', 'blocked') AND current_assignment_id = ? AND owner_actor_id = ?",
          assignment.assignment_id,
          assignment.owner_actor_id,
        ),
        activeAssignmentGuard(db, assignment),
        contactBlockGuardStatement(db, context.caller, input.to_actor_id),
        ...(task.created_by !== context.caller
          ? [contactBlockGuardStatement(db, task.created_by, input.to_actor_id)]
          : []),
        ...(task.reviewer_actor_id !== context.caller
          ? [contactBlockGuardStatement(db, task.reviewer_actor_id, input.to_actor_id)]
          : []),
        db
          .prepare(
            guardSql(
              'invalidTarget',
              `NOT EXISTS (
                 SELECT 1 FROM room_members
                  WHERE room_id = ? AND actor_id = ? AND status = 'active'
               ) OR EXISTS (
                 SELECT 1 FROM actors WHERE actor_id = ? AND disabled_at IS NOT NULL
               )`,
            ),
          )
          .bind(task.room_id, input.to_actor_id, input.to_actor_id),
        ...expiredStatements,
        db
          .prepare(
            `INSERT INTO task_transfers
               (transfer_id, task_id, from_assignment_id, from_assignment_version,
                to_actor_id, status, context_json, version, created_by, created_at,
                expires_at, responded_at, responded_by)
             VALUES (?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, NULL, NULL)`,
          )
          .bind(
            transferId,
            task.task_id,
            assignment.assignment_id,
            assignment.assignment_version,
            input.to_actor_id,
            row.context_json,
            context.caller,
            at,
            expiresAt,
          ),
        ...taskRoomEvent(
          db,
          task,
          'task_transfer_proposed',
          `task:transfer-proposed:${transferId}`,
          at,
          {
            changed_by: context.caller,
            transfer_id: transferId,
            to_actor_id: input.to_actor_id,
            assignment_id: assignment.assignment_id,
            assignment_version: assignment.assignment_version,
          },
        ).statements,
      ],
      onUniqueConflict: async (error) => {
        if (String(error).includes('idx_task_transfers_pending')) {
          throw new BusinessError('CONFLICT', '该任务已有待处理的交接提议', {
            task_id: task.task_id,
          });
        }
        return undefined;
      },
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

async function resultForTask(
  db: D1Database,
  context: TaskContext,
  task: TaskRow,
): Promise<TaskResult> {
  return {
    task: await viewFromKnownRow(
      db,
      context,
      task,
      (await getTaskCard(db, task.task_id))?.message_id ?? '',
      task.current_assignment_id
        ? await getTaskAssignment(db, task.current_assignment_id)
        : null,
      await taskDeliveryIds(db, task.task_id),
      (
        await db
          .prepare(
            `SELECT file_id, label FROM task_attachments
              WHERE task_id = ? ORDER BY created_at ASC, file_id ASC`,
          )
          .bind(task.task_id)
          .all<{ file_id: string; label: string }>()
      ).results,
      await actorNames(db, [
        task.created_by,
        task.reviewer_actor_id,
        ...(task.owner_actor_id ? [task.owner_actor_id] : []),
      ]),
    ),
    authorization: historySnapshot(context.boundary),
  };
}

export async function taskTransferAccept(
  db: D1Database,
  principal: Principal,
  input: TaskTransferAcceptInput,
): Promise<TaskTransferResult> {
  const initial = await loadTransfer(db, input.transfer_id);
  const { task, context } = await requireVisibleTask(db, principal, initial.task_id);
  const payloadHash = await sha256Hex(
    stableStringify({
      transfer_id: initial.transfer_id,
      expected_revision: input.expected_revision ?? null,
      from_assignment_version: input.from_assignment_version ?? null,
    }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskTransferResult;

  if (initial.to_actor_id !== context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '只有交接提议的目标可以接受');
  }
  if (initial.status === 'accepted') {
    if (initial.responded_by === context.caller) {
      return {
        transfer: await transferView(db, context, task, initial, nowMs()),
        task: (await resultForTask(db, context, task)).task,
      };
    }
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '交接提议已被处理');
  }
  if (initial.status !== 'pending') {
    throw new BusinessError('CONFLICT', '交接提议已结束，不能接受', {
      transfer_id: initial.transfer_id,
      status: initial.status,
    });
  }
  const at = nowMs();
  if (initial.expires_at <= at) {
    throw new BusinessError('REQUEST_EXPIRED', '交接提议已过期', {
      ...(await actualTaskState(db, task.task_id)),
      transfer_id: initial.transfer_id,
    });
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.status !== 'in_progress' && task.status !== 'blocked') {
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '任务已不在执行阶段');
  }
  const assignment = task.current_assignment_id
    ? await getTaskAssignment(db, task.current_assignment_id)
    : null;
  if (
    !assignment ||
    assignment.status !== 'active' ||
    assignment.assignment_id !== initial.from_assignment_id ||
    assignment.assignment_version !== initial.from_assignment_version
  ) {
    throw await staleTaskError(
      db,
      task.task_id,
      'ASSIGNMENT_STALE',
      '交接提议对应的执行资格已失效',
    );
  }
  if (
    input.from_assignment_version !== undefined &&
    input.from_assignment_version !== assignment.assignment_version
  ) {
    throw await staleTaskError(db, task.task_id, 'ASSIGNMENT_STALE', '任务执行版本已变化');
  }
  if (task.reviewer_actor_id === context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '验收人不能接任自己验收的任务');
  }
  for (const [counterpart, label] of [
    [initial.created_by, '提议者'],
    [task.created_by, '任务创建者'],
    [task.reviewer_actor_id, '验收人'],
  ] as const) {
    if (counterpart === context.caller) continue;
    if (await blockedBetween(db, context.caller, counterpart)) {
      throw new BusinessError('BLOCKED', `接任者与${label}之间存在拉黑关系`);
    }
  }

  const assignmentId = newId('asg');
  const versionRow = await db
    .prepare(
      'SELECT COALESCE(MAX(assignment_version), 0) + 1 AS version FROM task_assignments WHERE task_id = ?',
    )
    .bind(task.task_id)
    .first<{ version: number }>();
  const assignmentVersion = Math.max(
    versionRow?.version ?? 1,
    assignment.assignment_version + 1,
  );
  // D05：包存在但必需引用未就绪时，接任成功但任务立即受阻，等待补充上下文；
  // 没有包时保持 D04 行为，不阻断接任。
  const handoff = await handoffReadinessForTransfer(
    db,
    task,
    initial.from_assignment_id,
    context.caller,
  );
  const contextIncomplete = handoff.has_pack && !handoff.context_ready;
  const updated: TaskRow = {
    ...task,
    status: contextIncomplete ? 'blocked' : task.status,
    blocked_reason: contextIncomplete ? 'context_incomplete' : task.blocked_reason,
    blocked_at: contextIncomplete ? at : task.blocked_at,
    owner_actor_id: context.caller,
    current_assignment_id: assignmentId,
    revision: task.revision + 1,
    last_progress_at: at,
    updated_at: at,
  };
  const nextAssignment: TaskAssignmentRow = {
    assignment_id: assignmentId,
    task_id: task.task_id,
    assignment_version: assignmentVersion,
    owner_actor_id: context.caller,
    status: 'active',
    offered_by: initial.created_by,
    offer_expires_at: null,
    accepted_at: at,
    ended_at: null,
    last_progress_at: at,
    delivery_id: null,
    created_at: at,
    updated_at: at,
  };
  const acceptedRow: TaskTransferRow = {
    ...initial,
    status: 'accepted',
    responded_at: at,
    responded_by: context.caller,
  };
  const deliveries = await closeTaskDeliveries(
    db,
    assignment,
    task,
    context.caller,
    'task transferred',
    input.request_id,
    at,
  );
  const allDeliveryIds = Array.from(
    new Set([...(await taskDeliveryIds(db, task.task_id)), ...deliveries.deliveryIds]),
  );
  const view = await transferTaskResult(
    db,
    context,
    updated,
    nextAssignment,
    allDeliveryIds,
  );
  const result: TaskTransferResult = {
    transfer: {
      ...(await transferView(db, context, updated, acceptedRow, at)),
      can_accept: false,
      can_reject: false,
      can_cancel: false,
    },
    task: view,
  };

  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        taskRevisionGuard(db, task.task_id, task.revision),
        taskStateGuard(
          db,
          task.task_id,
          "status IN ('in_progress', 'blocked') AND current_assignment_id = ? AND owner_actor_id = ? AND reviewer_actor_id <> ?",
          assignment.assignment_id,
          assignment.owner_actor_id,
          context.caller,
        ),
        activeAssignmentGuard(db, assignment),
        db
          .prepare(
            guardSql(
              'requestExpired',
              `EXISTS (
                 SELECT 1 FROM task_transfers
                  WHERE transfer_id = ? AND status = 'pending' AND expires_at <= ?
               )`,
            ),
          )
          .bind(initial.transfer_id, at),
        db
          .prepare(
            guardSql(
              'assignmentStale',
              `NOT EXISTS (
                 SELECT 1 FROM task_transfers
                  WHERE transfer_id = ? AND task_id = ? AND to_actor_id = ?
                    AND status = 'pending' AND from_assignment_id = ?
                    AND from_assignment_version = ? AND expires_at > ?
               )`,
            ),
          )
          .bind(
            initial.transfer_id,
            task.task_id,
            context.caller,
            assignment.assignment_id,
            assignment.assignment_version,
            at,
          ),
        contactBlockGuardStatement(db, context.caller, initial.created_by),
        ...(task.created_by !== context.caller
          ? [contactBlockGuardStatement(db, context.caller, task.created_by)]
          : []),
        ...(task.reviewer_actor_id !== context.caller
          ? [contactBlockGuardStatement(db, context.caller, task.reviewer_actor_id)]
          : []),
        db
          .prepare(
            `UPDATE tasks
                SET owner_actor_id = ?, current_assignment_id = ?,
                    status = ?, blocked_reason = ?, blocked_at = ?,
                    revision = revision + 1, last_progress_at = ?, updated_at = ?
              WHERE task_id = ? AND revision = ?
                AND current_assignment_id = ? AND owner_actor_id = ?
                AND status IN ('in_progress', 'blocked')`,
          )
          .bind(
            context.caller,
            assignmentId,
            updated.status,
            updated.blocked_reason,
            updated.blocked_at,
            at,
            at,
            task.task_id,
            task.revision,
            assignment.assignment_id,
            assignment.owner_actor_id,
          ),
        db
          .prepare(
            `UPDATE task_assignments
                SET status = 'revoked', ended_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status = 'active' AND assignment_version = ?`,
          )
          .bind(at, at, assignment.assignment_id, assignment.assignment_version),
        db
          .prepare(
            `INSERT INTO task_assignments
               (assignment_id, task_id, assignment_version, owner_actor_id, status,
                offered_by, offer_expires_at, accepted_at, ended_at, last_progress_at,
                delivery_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, NULL, ?, NULL, ?, ?)`,
          )
          .bind(
            assignmentId,
            task.task_id,
            assignmentVersion,
            context.caller,
            initial.created_by,
            at,
            at,
            at,
            at,
          ),
        db
          .prepare(
            `UPDATE task_transfers
                SET status = 'accepted', responded_at = ?, responded_by = ?, version = version + 1
              WHERE transfer_id = ? AND status = 'pending'`,
          )
          .bind(at, context.caller, initial.transfer_id),
        ...deliveries.statements,
        ...taskRoomEvent(
          db,
          updated,
          'task_transfer_accepted',
          `task:transfer-accepted:${initial.transfer_id}`,
          at,
          {
            changed_by: context.caller,
            transfer_id: initial.transfer_id,
            assignment_id: assignmentId,
            assignment_version: assignmentVersion,
            previous_assignment_id: assignment.assignment_id,
            previous_assignment_version: assignment.assignment_version,
            owner_actor_id: context.caller,
            previous_owner_actor_id: assignment.owner_actor_id,
            context_incomplete: contextIncomplete,
            ...(contextIncomplete
              ? {
                  handoff_pack_id: handoff.pack_id,
                  handoff_pack_version: handoff.pack_version,
                  required_missing: handoff.required_missing,
                }
              : {}),
          },
        ).statements,
      ],
      onUniqueConflict: async (error) => {
        const text = String(error);
        if (
          text.includes('idx_task_assignments_version') ||
          text.includes('idx_task_assignments_current')
        ) {
          throw new BusinessError('CONFLICT', '任务负责人已变化，请刷新后重试', {
            ...(await actualTaskState(db, task.task_id)),
          });
        }
        return undefined;
      },
    });
  } catch (error) {
    const fresh = await getTaskTransfer(db, initial.transfer_id);
    if (fresh?.status === 'accepted' && fresh.responded_by === context.caller) {
      const freshTask = await getTask(db, task.task_id);
      if (freshTask) {
        return {
          transfer: await transferView(db, context, freshTask, fresh, nowMs()),
          task: (await resultForTask(db, context, freshTask)).task,
        };
      }
    }
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

export async function taskTransferReject(
  db: D1Database,
  principal: Principal,
  input: TaskTransferRejectInput,
): Promise<TaskTransferResult> {
  const initial = await loadTransfer(db, input.transfer_id);
  const { task, context } = await requireVisibleTask(db, principal, initial.task_id);
  const reason = normalizeTransferReason(input.reason, '拒绝原因');
  const payloadHash = await sha256Hex(
    stableStringify({ transfer_id: initial.transfer_id, reason }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskTransferResult;

  if (initial.to_actor_id !== context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '只有交接提议的目标可以拒绝');
  }
  if (initial.status !== 'pending') {
    throw new BusinessError('CONFLICT', '交接提议已结束，不能拒绝', {
      transfer_id: initial.transfer_id,
      status: initial.status,
    });
  }
  const at = nowMs();
  if (initial.expires_at <= at) {
    throw new BusinessError('REQUEST_EXPIRED', '交接提议已过期', {
      transfer_id: initial.transfer_id,
    });
  }
  const contextJson = parseContext(initial.context_json);
  const rejected: TaskTransferRow = {
    ...initial,
    status: 'rejected',
    responded_at: at,
    responded_by: context.caller,
    context_json: JSON.stringify({ ...contextJson, response_reason: reason }),
  };
  const result: TaskTransferResult = {
    transfer: {
      ...(await transferView(db, context, task, rejected, at)),
      can_accept: false,
      can_reject: false,
      can_cancel: false,
    },
    task: (await resultForTask(db, context, task)).task,
  };
  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        db
          .prepare(
            guardSql(
              'requestExpired',
              `EXISTS (
                 SELECT 1 FROM task_transfers
                  WHERE transfer_id = ? AND status = 'pending' AND expires_at <= ?
               )`,
            ),
          )
          .bind(initial.transfer_id, at),
        db
          .prepare(
            guardSql(
              'assignmentStale',
              `NOT EXISTS (
                 SELECT 1 FROM task_transfers
                  WHERE transfer_id = ? AND to_actor_id = ? AND status = 'pending'
                    AND expires_at > ?
               )`,
            ),
          )
          .bind(initial.transfer_id, context.caller, at),
        db
          .prepare(
            `UPDATE task_transfers
                SET status = 'rejected', responded_at = ?, responded_by = ?, context_json = ?,
                    version = version + 1
              WHERE transfer_id = ? AND status = 'pending'`,
          )
          .bind(at, context.caller, rejected.context_json, initial.transfer_id),
        ...taskRoomEvent(
          db,
          task,
          'task_transfer_rejected',
          `task:transfer-rejected:${initial.transfer_id}`,
          at,
          {
            changed_by: context.caller,
            transfer_id: initial.transfer_id,
            to_actor_id: initial.to_actor_id,
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

export async function taskTransferCancel(
  db: D1Database,
  principal: Principal,
  input: TaskTransferCancelInput,
): Promise<TaskTransferResult> {
  const initial = await loadTransfer(db, input.transfer_id);
  const { task, context } = await requireVisibleTask(db, principal, initial.task_id);
  const reason = normalizeTransferReason(input.reason, '取消原因');
  const payloadHash = await sha256Hex(
    stableStringify({ transfer_id: initial.transfer_id, reason }),
  );
  const replay = await getOperation(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskTransferResult;

  if (!isTransferParticipant(task, context, initial)) {
    throw new BusinessError('NOT_FOUND', '交接提议不存在');
  }
  const canCancel =
    initial.created_by === context.caller ||
    task.created_by === context.caller ||
    task.owner_actor_id === context.caller ||
    isOwnerOrAdmin(context.room, context.member);
  if (!canCancel) {
    throw new BusinessError('PERMISSION_DENIED', '当前身份不能取消该交接提议');
  }
  if (initial.status !== 'pending') {
    throw new BusinessError('CONFLICT', '交接提议已结束，不能取消', {
      transfer_id: initial.transfer_id,
      status: initial.status,
    });
  }
  const at = nowMs();
  if (initial.expires_at <= at) {
    throw new BusinessError('REQUEST_EXPIRED', '交接提议已过期', {
      transfer_id: initial.transfer_id,
    });
  }
  const contextJson = parseContext(initial.context_json);
  const cancelled: TaskTransferRow = {
    ...initial,
    status: 'cancelled',
    responded_at: at,
    responded_by: context.caller,
    context_json: JSON.stringify({ ...contextJson, response_reason: reason }),
  };
  const result: TaskTransferResult = {
    transfer: {
      ...(await transferView(db, context, task, cancelled, at)),
      can_accept: false,
      can_reject: false,
      can_cancel: false,
    },
    task: (await resultForTask(db, context, task)).task,
  };
  try {
    await runIdempotent(db, {
      actorId: context.caller,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, context.caller, input.request_id, payloadHash, resultJson, at),
        memberGuard(db, task.room_id, context.caller),
        db
          .prepare(
            guardSql(
              'requestExpired',
              `EXISTS (
                 SELECT 1 FROM task_transfers
                  WHERE transfer_id = ? AND status = 'pending' AND expires_at <= ?
               )`,
            ),
          )
          .bind(initial.transfer_id, at),
        db
          .prepare(
            guardSql(
              'assignmentStale',
              `NOT EXISTS (
                 SELECT 1 FROM task_transfers
                  WHERE transfer_id = ? AND status = 'pending' AND expires_at > ?
               )`,
            ),
          )
          .bind(initial.transfer_id, at),
        db
          .prepare(
            `UPDATE task_transfers
                SET status = 'cancelled', responded_at = ?, responded_by = ?, context_json = ?,
                    version = version + 1
              WHERE transfer_id = ? AND status = 'pending'`,
          )
          .bind(at, context.caller, cancelled.context_json, initial.transfer_id),
        ...taskRoomEvent(
          db,
          task,
          'task_transfer_cancelled',
          `task:transfer-cancelled:${initial.transfer_id}`,
          at,
          {
            changed_by: context.caller,
            transfer_id: initial.transfer_id,
            to_actor_id: initial.to_actor_id,
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  return result;
}

export async function taskTransferGet(
  db: D1Database,
  principal: Principal,
  input: TaskTransferGetInput,
): Promise<{ transfer: TaskTransferView }> {
  const row = await loadTransfer(db, input.transfer_id);
  const { task, context } = await requireVisibleTask(db, principal, row.task_id);
  if (!isTransferParticipant(task, context, row)) {
    throw new BusinessError('NOT_FOUND', '交接提议不存在');
  }
  return { transfer: await transferView(db, context, task, row, nowMs()) };
}

export async function taskTransferList(
  db: D1Database,
  principal: Principal,
  input: TaskTransferListInput,
): Promise<TaskTransferListResult> {
  const caller = actorId(principal);
  const limit = Math.min(
    input.limit ?? LIMITS.taskTransferListDefault,
    LIMITS.taskTransferListMax,
  );
  const status = input.status ?? 'pending';
  const at = nowMs();

  function statusFilter(alias: string | null): { sql: string; bind: number | string } {
    const prefix = alias ? `${alias}.` : '';
    if (status === 'pending') {
      return {
        sql: `${prefix}status = 'pending' AND ${prefix}expires_at > ?`,
        bind: at,
      };
    }
    if (status === 'expired') {
      return {
        sql: `(${prefix}status = 'expired' OR (${prefix}status = 'pending' AND ${prefix}expires_at <= ?))`,
        bind: at,
      };
    }
    return { sql: `${prefix}status = ?`, bind: status };
  }

  if (input.task_id) {
    const { task, context } = await requireVisibleTask(db, principal, input.task_id);
    const filter = statusFilter(null);
    const rows = await db
      .prepare(
        `SELECT * FROM task_transfers WHERE task_id = ? AND ${filter.sql}
          ORDER BY created_at DESC, transfer_id DESC LIMIT ?`,
      )
      .bind(task.task_id, filter.bind, limit)
      .all<TaskTransferRow>();
    const transfers: TaskTransferView[] = [];
    for (const row of rows.results) {
      if (!isTransferParticipant(task, context, row)) continue;
      transfers.push(await transferView(db, context, task, row, at));
    }
    return { transfers, next_cursor: null, has_more: false };
  }

  const filter = statusFilter('t');
  const rows = await db
    .prepare(
      `SELECT t.* FROM task_transfers t
        JOIN tasks k ON k.task_id = t.task_id
        JOIN room_members m ON m.room_id = k.room_id AND m.actor_id = ? AND m.status = 'active'
        WHERE (t.to_actor_id = ? OR t.created_by = ?) AND ${filter.sql}
        ORDER BY t.created_at DESC, t.transfer_id DESC LIMIT ?`,
    )
    .bind(caller, caller, caller, filter.bind, limit * 2)
    .all<TaskTransferRow>();
  const transfers: TaskTransferView[] = [];
  for (const row of rows.results) {
    if (transfers.length >= limit) break;
    const task = await getTask(db, row.task_id);
    if (!task) continue;
    const member = await getMember(db, task.room_id, caller);
    if (!member || member.status !== 'active') continue;
    let context: TaskContext;
    try {
      context = (await requireVisibleTask(db, principal, task.task_id)).context;
    } catch (error) {
      if (error instanceof BusinessError && error.code === 'NOT_FOUND') continue;
      throw error;
    }
    if (!isTransferParticipant(task, context, row)) continue;
    transfers.push(await transferView(db, context, task, row, at));
  }
  return { transfers, next_cursor: null, has_more: false };
}

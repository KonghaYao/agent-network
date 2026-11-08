/**
 * D08 外部执行未知与对账恢复。
 *
 * 断线、心跳超时或响应丢失只把任务标记为 blocked + execution_unknown，并
 * 在 `task_external_actions` 记录稳定 action_id。服务端不会因为租约过期、
 * 断线或提醒超时自动重跑可能已有外部副作用的步骤；只有当前负责人显式
 * 记录对账结论后，任务才恢复 in_progress 或继续 blocked。
 */

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  TaskExecutionResolveInput,
  TaskExecutionUnknownInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, stableStringify, utf8Bytes } from '../storage/db';
import { getTaskExternalAction } from '../storage/queries';
import type {
  TaskAssignmentRow,
  TaskExternalActionRow,
  TaskExternalActionState,
  TaskRow,
} from '../storage/rows';
import { operationsStatement, resolveOperation, runIdempotent } from '../storage/transactions/runner';
import { type Principal } from './principal';
import {
  activeAssignmentGuard,
  actorNames,
  actualTaskState,
  attachmentsFor,
  memberGuard,
  requireVisibleTask,
  rethrowWithActualState,
  taskDeliveryIds,
  taskGet,
  taskRevisionGuard,
  taskRoomEvent,
  taskStateGuard,
  viewFromKnownRow,
} from './tasks';
import { normalizeBlockReason, progressStatement } from './task-progress';

export interface TaskExternalActionView {
  action_id: string;
  task_id: string;
  intent: string;
  state: TaskExternalActionState;
  evidence: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

export interface TaskRecoveryResult {
  task: Awaited<ReturnType<typeof taskGet>>['task'];
  action: TaskExternalActionView;
  authorization: Awaited<ReturnType<typeof taskGet>>['authorization'];
}

function normalizeActionId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new BusinessError('INVALID_ARGUMENT', 'action_id 不能为空');
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new BusinessError('INVALID_ARGUMENT', 'action_id 不能包含控制字符');
  }
  const bytes = utf8Bytes(normalized);
  if (bytes > LIMITS.taskExternalActionIdBytes) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      `action_id 超过 ${LIMITS.taskExternalActionIdBytes} 字节`,
      { bytes, max: LIMITS.taskExternalActionIdBytes },
    );
  }
  return normalized;
}

function normalizeEvidence(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new BusinessError('INVALID_ARGUMENT', '对账证据不能为空');
  }
  const bytes = utf8Bytes(normalized);
  if (bytes > LIMITS.taskRecoveryEvidenceBytes) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      `对账证据超过 ${LIMITS.taskRecoveryEvidenceBytes} 字节`,
      { bytes, max: LIMITS.taskRecoveryEvidenceBytes },
    );
  }
  return normalized;
}

function actionView(
  row: TaskExternalActionRow,
  names: Map<string, string>,
): TaskExternalActionView {
  return {
    action_id: row.action_id,
    task_id: row.task_id,
    intent: row.intent,
    state: row.state,
    evidence: row.evidence,
    created_by: row.created_by,
    created_by_name: names.get(row.created_by) ?? '',
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

async function recoveryResult(
  db: D1Database,
  principal: Principal,
  task: TaskRow,
  context: Awaited<ReturnType<typeof requireVisibleTask>>['context'],
  assignment: TaskAssignmentRow | null,
  action: TaskExternalActionRow,
): Promise<TaskRecoveryResult> {
  const names = await actorNames(db, [
    task.created_by,
    task.reviewer_actor_id,
    ...(task.owner_actor_id ? [task.owner_actor_id] : []),
    ...(task.cancelled_by ? [task.cancelled_by] : []),
    action.created_by,
  ]);
  const card = await db
    .prepare('SELECT message_id FROM task_cards WHERE task_id = ?')
    .bind(task.task_id)
    .first<{ message_id: string }>();
  const view = await viewFromKnownRow(
    db,
    context,
    task,
    card?.message_id ?? '',
    assignment,
    await taskDeliveryIds(db, task.task_id),
    await attachmentsFor(db, task.task_id),
    names,
  );
  return {
    task: view,
    action: actionView(action, names),
    authorization: (await taskGet(db, principal, { task_id: task.task_id })).authorization,
  };
}

function actionGuard(
  db: D1Database,
  taskId: string,
  actionId: string,
  intent: string,
  createdBy: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_external_actions
         (action_id, task_id, intent, state, evidence, created_by, created_at, updated_at)
       SELECT ?, ?, ?, 'unknown', '', ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM task_external_actions WHERE task_id = ? AND action_id = ?
        )`,
    )
    .bind(actionId, taskId, intent, createdBy, at, at, taskId, actionId);
}

export async function taskExecutionUnknown(
  db: D1Database,
  principal: Principal,
  input: TaskExecutionUnknownInput,
): Promise<TaskRecoveryResult> {
  const { task, context } = await requireVisibleTask(db, principal, input.task_id);
  const actionId = normalizeActionId(input.action_id);
  const reason = normalizeBlockReason(input.reason);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      action_id: actionId,
      reason,
      expected_revision: input.expected_revision ?? null,
      assignment_id: input.assignment_id ?? null,
      assignment_version: input.assignment_version ?? null,
    }),
  );
  const replay = await getOperationForActor(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskRecoveryResult;

  const existing = await getTaskExternalAction(db, task.task_id, actionId);
  if (existing) {
    if (existing.state !== 'unknown') {
      throw new BusinessError('CONFLICT', '该 action_id 已记录对账结论，不能再次标记未知', {
        action_id: actionId,
        state: existing.state,
      });
    }
    if (task.status !== 'blocked' || task.blocked_reason !== 'execution_unknown') {
      throw new BusinessError('CONFLICT', '该 action_id 已记录为未知，等待对账结论', {
        action_id: actionId,
        status: task.status,
      });
    }
    const assignment = task.current_assignment_id
      ? await getAssignment(db, task.current_assignment_id)
      : null;
    return recoveryResult(db, principal, task, context, assignment, existing);
  }

  if (task.status !== 'in_progress') {
    throw new BusinessError('CONFLICT', '只有进行中的任务可以标记外部执行未知', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.owner_actor_id !== context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '只有当前负责人可以标记外部执行未知', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const assignment = task.current_assignment_id
    ? await getAssignment(db, task.current_assignment_id)
    : null;
  if (!assignment || assignment.status !== 'active' || assignment.owner_actor_id !== context.caller) {
    throw new BusinessError('ASSIGNMENT_STALE', '当前执行资格已失效，不能标记外部执行未知', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (input.assignment_id !== undefined && input.assignment_id !== assignment.assignment_id) {
    throw new BusinessError('ASSIGNMENT_STALE', '任务执行版本已变化，请刷新后重试', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (
    input.assignment_version !== undefined &&
    input.assignment_version !== assignment.assignment_version
  ) {
    throw new BusinessError('ASSIGNMENT_STALE', '任务执行版本已变化，请刷新后重试', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }

  const at = nowMs();
  const nextRevision = task.revision + 1;
  const action: TaskExternalActionRow = {
    action_id: actionId,
    task_id: task.task_id,
    intent: reason,
    state: 'unknown',
    evidence: '',
    created_by: context.caller,
    created_at: at,
    updated_at: at,
  };
  const updated: TaskRow = {
    ...task,
    status: 'blocked',
    blocked_reason: 'execution_unknown',
    blocked_at: at,
    last_progress_at: at,
    revision: nextRevision,
    updated_at: at,
  };
  const progressRow = {
    progress_id: newId('prg'),
    task_id: task.task_id,
    task_revision: nextRevision,
    assignment_id: assignment.assignment_id,
    assignment_version: assignment.assignment_version,
    actor_id: context.caller,
    prior_status: task.status,
    status: 'blocked' as const,
    percent: null,
    note: '',
    blocked_reason: 'execution_unknown',
    created_at: at,
  };
  const names = await actorNames(db, [task.created_by, task.reviewer_actor_id, context.caller]);
  const result = await recoveryResult(db, principal, updated, context, assignment, action);

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
          'status = ? AND owner_actor_id = ? AND current_assignment_id = ?',
          task.status,
          context.caller,
          assignment.assignment_id,
        ),
        activeAssignmentGuard(db, assignment),
        actionGuard(db, task.task_id, actionId, reason, context.caller, at),
        db
          .prepare(
            `UPDATE tasks
                SET status = 'blocked', blocked_reason = 'execution_unknown', blocked_at = ?,
                    last_progress_at = ?, revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND status = 'in_progress' AND revision = ?
                AND owner_actor_id = ? AND current_assignment_id = ?`,
          )
          .bind(
            at,
            at,
            at,
            task.task_id,
            task.revision,
            context.caller,
            assignment.assignment_id,
          ),
        db
          .prepare(
            `UPDATE task_assignments SET last_progress_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status = 'active' AND assignment_version = ?`,
          )
          .bind(at, at, assignment.assignment_id, assignment.assignment_version),
        progressStatement(db, {
          progressId: progressRow.progress_id,
          taskId: progressRow.task_id,
          revision: progressRow.task_revision,
          assignmentId: progressRow.assignment_id,
          assignmentVersion: progressRow.assignment_version,
          actorId: progressRow.actor_id,
          priorStatus: progressRow.prior_status,
          status: progressRow.status,
          percent: progressRow.percent,
          note: progressRow.note,
          blockedReason: progressRow.blocked_reason,
          at,
        }),
        ...taskRoomEvent(
          db,
          updated,
          'task_execution_unknown',
          `task:execution-unknown:${task.task_id}:${actionId}`,
          at,
          {
            changed_by: context.caller,
            action_id: actionId,
            assignment_id: assignment.assignment_id,
            assignment_version: assignment.assignment_version,
            reason,
            // 未知原因只作为状态说明，不写外部结果或证据正文。
            blocked_reason: 'execution_unknown',
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  // 重新读取 action，确保返回的是事务内的真实行。
  const stored = await getTaskExternalAction(db, task.task_id, actionId);
  if (!stored) {
    throw new BusinessError('CONFLICT', '外部动作记录未落库', { action_id: actionId });
  }
  return {
    ...result,
    action: actionView(stored, names),
  };
}

async function getAssignment(
  db: D1Database,
  assignmentId: string,
): Promise<TaskAssignmentRow | null> {
  return db
    .prepare('SELECT * FROM task_assignments WHERE assignment_id = ?')
    .bind(assignmentId)
    .first<TaskAssignmentRow>();
}

async function getOperationForActor(
  db: D1Database,
  actor: string,
  requestId: string,
) {
  return db
    .prepare('SELECT * FROM operations WHERE actor_id = ? AND request_id = ?')
    .bind(actor, requestId)
    .first<import('../storage/rows').OperationRow>();
}

export async function taskExecutionResolve(
  db: D1Database,
  principal: Principal,
  input: TaskExecutionResolveInput,
): Promise<TaskRecoveryResult> {
  const actionId = normalizeActionId(input.action_id);
  let taskId = input.task_id ?? null;
  if (taskId === null) {
    const rows = await db
      .prepare(
        'SELECT task_id FROM task_external_actions WHERE action_id = ? LIMIT 2',
      )
      .bind(actionId)
      .all<{ task_id: string }>();
    if (rows.results.length === 0) {
      throw new BusinessError('NOT_FOUND', '外部动作记录不存在', { action_id: actionId });
    }
    if (rows.results.length > 1) {
      throw new BusinessError('INVALID_ARGUMENT', 'action_id 在多个任务中存在，请传 task_id', {
        action_id: actionId,
      });
    }
    const only = rows.results[0];
    if (!only) {
      throw new BusinessError('NOT_FOUND', '外部动作记录不存在', { action_id: actionId });
    }
    taskId = only.task_id;
  }
  if (taskId === null) {
    throw new BusinessError('NOT_FOUND', '外部动作记录不存在', { action_id: actionId });
  }
  const { task, context } = await requireVisibleTask(db, principal, taskId);
  const evidence = normalizeEvidence(input.evidence);
  const payloadHash = await sha256Hex(
    stableStringify({
      task_id: task.task_id,
      action_id: actionId,
      outcome: input.outcome,
      evidence,
      expected_revision: input.expected_revision ?? null,
      assignment_id: input.assignment_id ?? null,
      assignment_version: input.assignment_version ?? null,
    }),
  );
  const replay = await getOperationForActor(db, context.caller, input.request_id);
  if (replay) return resolveOperation(replay, payloadHash) as TaskRecoveryResult;

  const actionRecord = await getTaskExternalAction(db, task.task_id, actionId);
  if (!actionRecord) {
    throw new BusinessError('NOT_FOUND', '外部动作记录不存在', { action_id: actionId });
  }
  if (actionRecord.state !== 'unknown') {
    throw new BusinessError('CONFLICT', '该 action_id 已记录对账结论', {
      action_id: actionId,
      state: actionRecord.state,
    });
  }
  if (task.status !== 'blocked' || task.blocked_reason !== 'execution_unknown') {
    throw new BusinessError('CONFLICT', '任务不在外部执行未知状态，不能记录对账结论', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (task.owner_actor_id !== context.caller) {
    throw new BusinessError('PERMISSION_DENIED', '只有当前负责人可以记录外部执行结论', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  const assignment = task.current_assignment_id
    ? await getAssignment(db, task.current_assignment_id)
    : null;
  if (!assignment || assignment.status !== 'active' || assignment.owner_actor_id !== context.caller) {
    throw new BusinessError('ASSIGNMENT_STALE', '当前执行资格已失效，不能记录对账结论', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (
    (input.assignment_id !== undefined && input.assignment_id !== assignment.assignment_id) ||
    (input.assignment_version !== undefined &&
      input.assignment_version !== assignment.assignment_version)
  ) {
    throw new BusinessError('ASSIGNMENT_STALE', '任务执行版本已变化，请刷新后重试', {
      ...(await actualTaskState(db, task.task_id)),
    });
  }
  if (input.expected_revision !== undefined && input.expected_revision !== task.revision) {
    throw new BusinessError('VERSION_CONFLICT', '任务版本已变化，请刷新后重试', {
      expected: input.expected_revision,
      ...(await actualTaskState(db, task.task_id)),
    });
  }

  const at = nowMs();
  const nextRevision = task.revision + 1;
  const resumed = input.outcome !== 'rejected';
  const nextStatus: TaskRow['status'] = resumed ? 'in_progress' : 'blocked';
  const nextReason = resumed ? null : 'execution_rejected';
  const updated: TaskRow = {
    ...task,
    status: nextStatus,
    blocked_reason: nextReason,
    blocked_at: resumed ? null : task.blocked_at,
    last_progress_at: at,
    revision: nextRevision,
    updated_at: at,
  };
  const action: TaskExternalActionRow = {
    ...actionRecord,
    state: input.outcome,
    evidence,
    updated_at: at,
  };
  const progressRow = {
    progress_id: newId('prg'),
    task_id: task.task_id,
    task_revision: nextRevision,
    assignment_id: assignment.assignment_id,
    assignment_version: assignment.assignment_version,
    actor_id: context.caller,
    prior_status: task.status,
    status: nextStatus,
    percent: null,
    note: '',
    blocked_reason: nextReason,
    created_at: at,
  };
  const names = await actorNames(db, [task.created_by, task.reviewer_actor_id, context.caller]);
  const result = await recoveryResult(db, principal, updated, context, assignment, action);

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
          "status = 'blocked' AND blocked_reason = 'execution_unknown' AND owner_actor_id = ? AND current_assignment_id = ?",
          context.caller,
          assignment.assignment_id,
        ),
        activeAssignmentGuard(db, assignment),
        db
          .prepare(
            `UPDATE task_external_actions
                SET state = ?, evidence = ?, updated_at = ?
              WHERE task_id = ? AND action_id = ? AND state = 'unknown'`,
          )
          .bind(input.outcome, evidence, at, task.task_id, actionId),
        db
          .prepare(
            `UPDATE tasks
                SET status = ?, blocked_reason = ?, blocked_at = ?, last_progress_at = ?,
                    revision = revision + 1, updated_at = ?
              WHERE task_id = ? AND revision = ? AND status = 'blocked'
                AND blocked_reason = 'execution_unknown' AND owner_actor_id = ?
                AND current_assignment_id = ?`,
          )
          .bind(
            nextStatus,
            nextReason,
            resumed ? null : task.blocked_at,
            at,
            at,
            task.task_id,
            task.revision,
            context.caller,
            assignment.assignment_id,
          ),
        db
          .prepare(
            `UPDATE task_assignments SET last_progress_at = ?, updated_at = ?
              WHERE assignment_id = ? AND status = 'active' AND assignment_version = ?`,
          )
          .bind(at, at, assignment.assignment_id, assignment.assignment_version),
        progressStatement(db, {
          progressId: progressRow.progress_id,
          taskId: progressRow.task_id,
          revision: progressRow.task_revision,
          assignmentId: progressRow.assignment_id,
          assignmentVersion: progressRow.assignment_version,
          actorId: progressRow.actor_id,
          priorStatus: progressRow.prior_status,
          status: progressRow.status,
          percent: progressRow.percent,
          note: progressRow.note,
          blockedReason: progressRow.blocked_reason,
          at,
        }),
        ...taskRoomEvent(
          db,
          updated,
          'task_execution_resolved',
          `task:execution-resolved:${task.task_id}:${actionId}:${input.outcome}`,
          at,
          {
            changed_by: context.caller,
            action_id: actionId,
            outcome: input.outcome,
            assignment_id: assignment.assignment_id,
            assignment_version: assignment.assignment_version,
            // 证据只存 task_external_actions，不进事件或消息正文。
            evidence_bytes: utf8Bytes(evidence),
            resumed,
          },
        ).statements,
      ],
    });
  } catch (error) {
    await rethrowWithActualState(db, task.task_id, error);
  }
  const stored = await getTaskExternalAction(db, task.task_id, actionId);
  if (!stored) {
    throw new BusinessError('NOT_FOUND', '外部动作记录不存在', { action_id: actionId });
  }
  return { ...result, action: actionView(stored, names) };
}

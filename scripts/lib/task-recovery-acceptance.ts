/**
 * D08 催办取消与异常恢复（D08-T01..T04）。
 *
 * 事务/状态部分使用内存 SQLite 与真实 migrations 直接调用 domain，覆盖：
 * - D08-T01 外部响应丢失只标未知，不自动重跑；对账结论决定恢复或保持 blocked；
 * - D08-T02 取消与完成/转交/重试交错时的原子失效、成果审计与 outbox 一致性；
 * - D08-T03 固定时钟下的提醒边界、重复窗口、停止条件与 delivery 去重。
 *
 * 重启部分自托管独立 Bun 实例与临时 DATA_DIR：
 * - D08-T04 停止服务后用新 SQLite/D1 连接读取同一 DATA_DIR 并写入提醒事件，
 *   再启动新进程；新连接读取任务列表、inbox reminder 与 room task 事件，
 *   验证 outbox 可补发、任务不静默丢失。
 */

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { McpSubscription } from '@modelcontextprotocol/client';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { BusinessError } from '../../src/contracts/errors';
import { LIMITS } from '../../src/contracts/limits';
import type { Principal } from '../../src/domain/principal';
import { taskExecutionResolve, taskExecutionUnknown } from '../../src/domain/task-recovery';
import { remindStaleTasks } from '../../src/domain/task-reminders';
import { taskReviewAccept, taskSubmit } from '../../src/domain/task-submissions';
import {
  taskAccept,
  taskCancel,
  taskCreate,
  taskOffer,
  taskReportProgress,
  taskResume,
  taskRetry,
} from '../../src/domain/tasks';
import { taskTransferAccept, taskTransferPropose } from '../../src/domain/task-transfers';
import type { ActorRow, TaskRow } from '../../src/storage/rows';
import {
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  waitUntil,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  inbox,
  registerIdentity,
  type RoomDetail,
} from './acceptance-helpers';

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const ROOM = 'rm_d08';
const OWNER = 'usr_d08_owner';
const REVIEWER = 'usr_d08_reviewer';
const HUMAN_WORKER = 'usr_d08_human';
const AGENT_ONE = 'agt_d08_one';
const AGENT_TWO = 'agt_d08_two';
const BASE = Date.now() - 30 * 60_000;

type D1 = ReturnType<typeof createD1>;

function seed(db: Database): void {
  const at = BASE - 10_000;
  db.exec(`
    INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
                        inbox_min_seq, pending_count, created_at, updated_at)
    VALUES
      ('${OWNER}', 'human', NULL, 'D08 Owner', '{}', 0, 0, 0, ${at}, ${at}),
      ('${REVIEWER}', 'human', NULL, 'D08 Reviewer', '{}', 0, 0, 0, ${at}, ${at}),
      ('${HUMAN_WORKER}', 'human', NULL, 'D08 Human Worker', '{}', 0, 0, 0, ${at}, ${at}),
      ('${AGENT_ONE}', 'agent', 'sess_d08_one', 'D08 Agent One', '{}', 0, 0, 0, ${at}, ${at}),
      ('${AGENT_TWO}', 'agent', 'sess_d08_two', 'D08 Agent Two', '{}', 0, 0, 0, ${at}, ${at});

    INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
                       member_seq, last_message_id, created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${OWNER}', 'D08 任务恢复', NULL, ${BASE - 5_000}, 0, 0,
            NULL, ${at}, ${at});

    INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES
      ('${ROOM}', '${OWNER}', 'owner', 'active', 0, 0, ${at}),
      ('${ROOM}', '${REVIEWER}', 'member', 'active', 0, 0, ${at}),
      ('${ROOM}', '${HUMAN_WORKER}', 'member', 'active', 0, 0, ${at}),
      ('${ROOM}', '${AGENT_ONE}', 'member', 'active', 0, 0, ${at}),
      ('${ROOM}', '${AGENT_TWO}', 'member', 'active', 0, 0, ${at});
  `);
}

function openMemoryDb(): { sqlite: Database; d1: D1 } {
  const sqlite = new Database(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  migrate(sqlite, MIGRATIONS);
  seed(sqlite);
  return { sqlite, d1: createD1(sqlite) };
}

function principalFor(db: Database, actorId: string): Principal {
  const actor = db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actorId) as ActorRow;
  return {
    credentialHash: `unit:${actorId}`,
    actor,
    credential: {
      credential_id: `cred_${actorId}`,
      actor_id: actorId,
      device_id: 'dev_d08_unit',
      token_hash: `hash_${actorId}`,
      revoked_at: null,
      created_at: 1,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}

function taskRow(db: Database, taskId: string): TaskRow {
  return db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as TaskRow;
}

function count(db: Database, sql: string, ...binds: string[]): number {
  return (db.prepare(sql).get(...binds) as { n: number }).n;
}

function taskReminderEvents(db: Database, taskId: string): number {
  return count(
    db,
    "SELECT COUNT(*) AS n FROM events WHERE scope_kind = 'inbox' AND event_type = 'task_reminder' AND ref_id = ?",
    taskId,
  );
}

function taskDeliveries(db: Database, taskId: string): number {
  return count(
    db,
    'SELECT COUNT(*) AS n FROM task_deliveries WHERE task_id = ?',
    taskId,
  );
}

function assignmentVersions(db: Database, taskId: string): number[] {
  return (
    db
      .prepare('SELECT assignment_version FROM task_assignments WHERE task_id = ? ORDER BY assignment_version')
      .all(taskId) as { assignment_version: number }[]
  ).map((row) => row.assignment_version);
}

interface CreatedTask {
  task: Awaited<ReturnType<typeof taskCreate>>['task'];
}

async function createTask(
  d1: D1,
  db: Database,
  input: {
    title: string;
    assignee?: string;
    reviewer?: string;
    prefix?: string;
  },
): Promise<TaskRow & { assignment_id: string; assignment_version: number }> {
  const result = await taskCreate(d1, principalFor(db, OWNER), {
    request_id: newRequestId(input.prefix ?? 'd08_create'),
    room_id: ROOM,
    title: input.title,
    description: 'D08 单元验收任务',
    acceptance_criteria: '状态、版本与通知一致',
    ...(input.assignee ? { assignee_actor_id: input.assignee } : {}),
    reviewer_actor_id: input.reviewer ?? REVIEWER,
  });
  const task = taskRow(db, result.task.task_id);
  const assignment = db
    .prepare('SELECT * FROM task_assignments WHERE task_id = ? AND status IN (\'offered\',\'active\')')
    .get(task.task_id) as { assignment_id: string; assignment_version: number } | null;
  return {
    ...task,
    assignment_id: assignment?.assignment_id ?? '',
    assignment_version: assignment?.assignment_version ?? 0,
  };
}

async function acceptTask(
  d1: D1,
  db: Database,
  task: TaskRow,
  actorId: string,
): Promise<void> {
  await taskAccept(d1, principalFor(db, actorId), {
    request_id: newRequestId('d08_accept'),
    task_id: task.task_id,
    expected_revision: task.revision,
  });
}

function markOfferDelivery(
  db: Database,
  taskId: string,
  state: 'completed' | 'claimed' | 'cancelled',
  at = BASE,
): { delivery_id: string; recipient_id: string } | null {
  const row = db
    .prepare(
      `SELECT td.delivery_id, d.recipient_id, d.state
         FROM task_deliveries td JOIN deliveries d ON d.delivery_id = td.delivery_id
        WHERE td.task_id = ? AND td.kind = 'task_offer'
        ORDER BY td.created_at ASC LIMIT 1`,
    )
    .get(taskId) as { delivery_id: string; recipient_id: string; state: string } | null;
  if (!row) return null;
  if (row.state === 'pending') {
    db.prepare(
      'UPDATE actors SET pending_count = MAX(pending_count - 1, 0) WHERE actor_id = ?',
    ).run(row.recipient_id);
  }
  db.prepare(
    `UPDATE deliveries SET state = ?, attempt = 1, claim_id = ?, claimed_at = ?,
            progress_at = ?, updated_at = ?
      WHERE delivery_id = ?`,
  ).run(
    state,
    state === 'claimed' ? `clm_${row.delivery_id}` : null,
    state === 'claimed' ? at : null,
    state === 'claimed' ? at : null,
    at,
    row.delivery_id,
  );
  return row;
}

async function expectBusinessError(
  label: string,
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    check(
      label,
      error instanceof BusinessError && error.code === code,
      error instanceof Error ? error.message : error,
    );
    return;
  }
  check(label, false, `期望 ${code}，实际成功`);
}

async function expectBusinessErrorAny(
  label: string,
  promise: Promise<unknown>,
  codes: string[],
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    check(
      label,
      error instanceof BusinessError && codes.includes(error.code),
      error instanceof BusinessError ? error.code : error,
    );
    return;
  }
  check(label, false, `期望 ${codes.join('/')}，实际成功`);
}

async function runT01(): Promise<void> {
  console.log('  · D08-T01 响应丢失与外部执行未知');
  const { sqlite, d1 } = openMemoryDb();
  try {
    const task = await createTask(d1, sqlite, {
      title: 'D08 T01 外部发布',
      assignee: AGENT_ONE,
      prefix: 'd08_t01_create',
    });
    const agent = principalFor(sqlite, AGENT_ONE);
    await acceptTask(d1, sqlite, task, AGENT_ONE);
    markOfferDelivery(sqlite, task.task_id, 'completed');
    const accepted = taskRow(sqlite, task.task_id);
    const assignmentBefore = sqlite
      .prepare('SELECT * FROM task_assignments WHERE task_id = ? ORDER BY assignment_version DESC LIMIT 1')
      .get(task.task_id) as { assignment_id: string; assignment_version: number; status: string };
    const deliveriesBefore = taskDeliveries(sqlite, task.task_id);
    const pendingBefore = (
      sqlite.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(AGENT_ONE) as {
        pending_count: number;
      }
    ).pending_count;

    const unknown = await taskExecutionUnknown(d1, agent, {
      request_id: newRequestId('d08_t01_unknown'),
      task_id: task.task_id,
      action_id: 'action-t01-publish',
      reason: '外部发布请求已发出，响应丢失',
      expected_revision: accepted.revision,
    });
    checkEqual('D08-T01 响应丢失后任务 blocked', unknown.task.status, 'blocked');
    checkEqual(
      'D08-T01 记录 execution_unknown 阻塞原因',
      unknown.task.blocked_reason,
      'execution_unknown',
    );
    checkEqual('D08-T01 action 记为 unknown', unknown.action.state, 'unknown');
    checkEqual('D08-T01 action 绑定当前负责人', unknown.action.created_by, AGENT_ONE);
    const blockedRevision = unknown.task.revision;
    checkEqual(
      'D08-T01 标记未知不创建新 delivery',
      taskDeliveries(sqlite, task.task_id),
      deliveriesBefore,
    );
    checkEqual(
      'D08-T01 标记未知不改变 assignment 版本',
      assignmentVersions(sqlite, task.task_id).length,
      1,
    );
    checkEqual(
      'D08-T01 当前 assignment 仍为原 active 版本',
      (
        sqlite
          .prepare("SELECT status, assignment_version FROM task_assignments WHERE assignment_id = ?")
          .get(assignmentBefore.assignment_id) as { status: string; assignment_version: number }
      ).status,
      'active',
    );
    checkEqual(
      'D08-T01 标记未知不增加 Agent pending_count',
      (
        sqlite.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(AGENT_ONE) as {
          pending_count: number;
        }
      ).pending_count,
      pendingBefore,
    );

    await expectBusinessError(
      'D08-T01 未知状态不能用 resume 绕过对账',
      taskResume(d1, agent, {
        request_id: newRequestId('d08_t01_resume'),
        task_id: task.task_id,
        assignment_id: assignmentBefore.assignment_id,
        assignment_version: assignmentBefore.assignment_version,
        expected_revision: blockedRevision,
      }),
      'CONFLICT',
    );

    const repeated = await taskExecutionUnknown(d1, agent, {
      request_id: newRequestId('d08_t01_unknown_again'),
      task_id: task.task_id,
      action_id: 'action-t01-publish',
      reason: '响应仍然丢失',
      expected_revision: blockedRevision,
    });
    checkEqual('D08-T01 重复上报同一 action 不递增 revision', repeated.task.revision, blockedRevision);
    checkEqual(
      'D08-T01 同一 action 只有一条外部动作记录',
      count(
        sqlite,
        'SELECT COUNT(*) AS n FROM task_external_actions WHERE task_id = ? AND action_id = ?',
        task.task_id,
        'action-t01-publish',
      ),
      1,
    );

    await expectBusinessError(
      'D08-T01 旧的 expected_revision 不能记录结论',
      taskExecutionResolve(d1, agent, {
        request_id: newRequestId('d08_t01_resolve_stale'),
        task_id: task.task_id,
        action_id: 'action-t01-publish',
        outcome: 'confirmed',
        evidence: '远端按 action_id 查询确认成功',
        expected_revision: blockedRevision - 1,
      }),
      'VERSION_CONFLICT',
    );

    const resolved = await taskExecutionResolve(d1, agent, {
      request_id: newRequestId('d08_t01_resolve_ok'),
      task_id: task.task_id,
      action_id: 'action-t01-publish',
      outcome: 'confirmed',
      evidence: '远端按 action_id 查询确认发布成功',
      expected_revision: blockedRevision,
    });
    checkEqual('D08-T01 confirmed 后恢复 in_progress', resolved.task.status, 'in_progress');
    checkEqual('D08-T01 confirmed 清空 blocked_reason', resolved.task.blocked_reason, null);
    checkEqual('D08-T01 confirmed 记录结论', resolved.action.state, 'confirmed');
    checkEqual(
      'D08-T01 结论证据只存外部动作表',
      (
        sqlite
          .prepare(
            'SELECT evidence FROM task_external_actions WHERE task_id = ? AND action_id = ?',
          )
          .get(task.task_id, 'action-t01-publish') as { evidence: string }
      ).evidence,
      '远端按 action_id 查询确认发布成功',
    );
    checkEqual(
      'D08-T01 恢复不创建新 assignment',
      assignmentVersions(sqlite, task.task_id).length,
      1,
    );
    checkEqual(
      'D08-T01 恢复不创建新 delivery',
      taskDeliveries(sqlite, task.task_id),
      deliveriesBefore,
    );

    const current = taskRow(sqlite, task.task_id);
    const unknownTwo = await taskExecutionUnknown(d1, agent, {
      request_id: newRequestId('d08_t01_unknown_two'),
      task_id: task.task_id,
      action_id: 'action-t01-push',
      reason: '第二次外部推送响应丢失',
      expected_revision: current.revision,
    });
    const resolvedTwo = await taskExecutionResolve(d1, agent, {
      request_id: newRequestId('d08_t01_resolve_two'),
      task_id: task.task_id,
      action_id: 'action-t01-push',
      outcome: 'not_executed',
      evidence: '远端查询确认未执行',
      expected_revision: unknownTwo.task.revision,
    });
    checkEqual('D08-T01 not_executed 后恢复 in_progress', resolvedTwo.task.status, 'in_progress');
    checkEqual('D08-T01 not_executed 记录结论', resolvedTwo.action.state, 'not_executed');

    const currentTwo = taskRow(sqlite, task.task_id);
    const unknownThree = await taskExecutionUnknown(d1, agent, {
      request_id: newRequestId('d08_t01_unknown_three'),
      task_id: task.task_id,
      action_id: 'action-t01-rejected',
      reason: '第三次外部操作结果未知',
      expected_revision: currentTwo.revision,
    });
    const resolvedThree = await taskExecutionResolve(d1, agent, {
      request_id: newRequestId('d08_t01_resolve_three'),
      task_id: task.task_id,
      action_id: 'action-t01-rejected',
      outcome: 'rejected',
      evidence: '远端明确拒绝该操作',
      expected_revision: unknownThree.task.revision,
    });
    checkEqual('D08-T01 rejected 保持 blocked', resolvedThree.task.status, 'blocked');
    checkEqual(
      'D08-T01 rejected 使用独立阻塞原因',
      resolvedThree.task.blocked_reason,
      'execution_rejected',
    );
    checkEqual('D08-T01 rejected 记录结论', resolvedThree.action.state, 'rejected');

    await expectBusinessError(
      'D08-T01 已结论 action 不能再标记未知',
      taskExecutionUnknown(d1, agent, {
        request_id: newRequestId('d08_t01_unknown_concluded'),
        task_id: task.task_id,
        action_id: 'action-t01-rejected',
        reason: '再次标记未知',
      }),
      'CONFLICT',
    );

    const resumed = await taskResume(d1, agent, {
      request_id: newRequestId('d08_t01_resume_rejected'),
      task_id: task.task_id,
      assignment_id: assignmentBefore.assignment_id,
      assignment_version: assignmentBefore.assignment_version,
      expected_revision: resolvedThree.task.revision,
    });
    checkEqual('D08-T01 rejected 后可由负责人显式恢复', resumed.task.status, 'in_progress');
    checkEqual(
      'D08-T01 全程外部动作记录数稳定',
      count(sqlite, 'SELECT COUNT(*) AS n FROM task_external_actions WHERE task_id = ?', task.task_id),
      3,
    );
  } finally {
    sqlite.close();
  }
}

async function runT02(): Promise<void> {
  console.log('  · D08-T02 取消、完成、转交与重试交错');
  const { sqlite, d1 } = openMemoryDb();
  try {
    const owner = principalFor(sqlite, OWNER);
    const reviewer = principalFor(sqlite, REVIEWER);
    const agentOne = principalFor(sqlite, AGENT_ONE);
    const agentTwo = principalFor(sqlite, AGENT_TWO);
    const humanWorker = principalFor(sqlite, HUMAN_WORKER);

    // 1. pending offer delivery + pending transfer 被取消原子失效。
    const taskA = await createTask(d1, sqlite, {
      title: 'D08 T02 取消待接手',
      assignee: AGENT_ONE,
      prefix: 'd08_t02_a_create',
    });
    await acceptTask(d1, sqlite, taskA, AGENT_ONE);
    const acceptedA = taskRow(sqlite, taskA.task_id);
    const transferA = await taskTransferPropose(d1, owner, {
      request_id: newRequestId('d08_t02_transfer'),
      task_id: taskA.task_id,
      to_actor_id: AGENT_TWO,
      expected_revision: acceptedA.revision,
    });
    const pendingBeforeCancel = (
      sqlite.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(AGENT_ONE) as {
        pending_count: number;
      }
    ).pending_count;
    const cancelledA = await taskCancel(d1, owner, {
      request_id: newRequestId('d08_t02_cancel_a'),
      task_id: taskA.task_id,
      reason: '需求取消，停止外部通知',
      expected_revision: acceptedA.revision,
    });
    checkEqual('D08-T02 取消后任务为 cancelled', cancelledA.task.status, 'cancelled');
    checkEqual('D08-T02 记录取消操作者', cancelledA.task.cancelled_by, OWNER);
    checkEqual('D08-T02 记录取消原因', cancelledA.task.cancel_reason, '需求取消，停止外部通知');
    checkEqual(
      'D08-T02 进行中任务默认外部停止状态 unknown',
      cancelledA.task.external_stop_status,
      'unknown',
    );
    const assignmentA = sqlite
      .prepare("SELECT status FROM task_assignments WHERE assignment_id = ?")
      .get(taskA.assignment_id) as { status: string };
    checkEqual('D08-T02 当前 assignment 被撤销', assignmentA.status, 'revoked');
    const transferStatus = sqlite
      .prepare('SELECT status FROM task_transfers WHERE transfer_id = ?')
      .get(transferA.transfer.transfer_id) as { status: string };
    checkEqual('D08-T02 pending 交接被取消', transferStatus.status, 'cancelled');
    const offerA = sqlite
      .prepare(
        `SELECT d.state FROM task_deliveries td JOIN deliveries d ON d.delivery_id = td.delivery_id
          WHERE td.task_id = ? AND td.kind = 'task_offer'`,
      )
      .get(taskA.task_id) as { state: string };
    checkEqual('D08-T02 pending task_offer delivery 被取消', offerA.state, 'cancelled');
    checkEqual(
      'D08-T02 取消 pending 投递递减 pending_count',
      (
        sqlite.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(AGENT_ONE) as {
          pending_count: number;
        }
      ).pending_count,
      pendingBeforeCancel - 1,
    );
    checkEqual(
      'D08-T02 同一事务写入 task_cancelled outbox',
      count(
        sqlite,
        `SELECT COUNT(*) AS n FROM outbox o JOIN events e ON e.event_seq = o.event_seq
          WHERE e.event_type = 'task_cancelled' AND e.scope_kind = 'room' AND e.ref_id = ?`,
        taskA.task_id,
      ),
      1,
    );
    checkEqual(
      'D08-T02 同一事务写入 delivery_cancelled outbox',
      count(
        sqlite,
        `SELECT COUNT(*) AS n FROM outbox o JOIN events e ON e.event_seq = o.event_seq
          WHERE e.event_type = 'delivery_cancelled' AND e.scope_kind = 'inbox'`,
      ),
      1,
    );
    const cancelMetadata = JSON.parse(
      (
        sqlite
          .prepare(
            "SELECT metadata FROM events WHERE event_type = 'task_cancelled' AND ref_id = ? ORDER BY event_seq DESC LIMIT 1",
          )
          .get(taskA.task_id) as { metadata: string }
      ).metadata,
    ) as Record<string, unknown>;
    checkEqual(
      'D08-T02 取消事件记录 external_stop_status',
      cancelMetadata.external_stop_status,
      'unknown',
    );
    checkEqual('D08-T02 取消事件记录 operator', cancelMetadata.operator, OWNER);
    checkEqual(
      'D08-T02 取消事件声明仅尽力通知宿主',
      cancelMetadata.host_notify_attempted,
      true,
    );

    await expectBusinessErrorAny(
      'D08-T02 已取消任务的交接不能被迟到接受',
      taskTransferAccept(d1, agentTwo, {
        request_id: newRequestId('d08_t02_transfer_accept'),
        transfer_id: transferA.transfer.transfer_id,
        expected_revision: cancelledA.task.revision,
      }),
      ['CONFLICT', 'ASSIGNMENT_STALE', 'REQUEST_EXPIRED'],
    );
    await expectBusinessError(
      'D08-T02 已取消任务不能重试',
      taskRetry(d1, owner, {
        request_id: newRequestId('d08_t02_retry_cancelled'),
        task_id: taskA.task_id,
        reason: '错误地重试已取消任务',
      }),
      'CONFLICT',
    );
    await expectBusinessError(
      'D08-T02 已取消任务不能接受 offer',
      taskAccept(d1, agentOne, {
        request_id: newRequestId('d08_t02_accept_cancelled'),
        task_id: taskA.task_id,
        expected_revision: cancelledA.task.revision,
      }),
      'ASSIGNMENT_STALE',
    );
    await expectBusinessError(
      'D08-T02 已取消任务不能提交成果',
      taskSubmit(d1, agentOne, {
        request_id: newRequestId('d08_t02_submit_cancelled'),
        task_id: taskA.task_id,
        summary: '不应提交',
        evidence: ['不应提交'],
      }),
      'CONFLICT',
    );
    await expectBusinessError(
      'D08-T02 取消是终态，不能重复取消',
      taskCancel(d1, owner, {
        request_id: newRequestId('d08_t02_cancel_again'),
        task_id: taskA.task_id,
        reason: '再次取消',
      }),
      'CONFLICT',
    );

    // 2. claimed offer 与 task_reminder 投递同样失效。
    const taskB = await createTask(d1, sqlite, {
      title: 'D08 T02 取消已领取',
      assignee: AGENT_ONE,
      prefix: 'd08_t02_b_create',
    });
    await acceptTask(d1, sqlite, taskB, AGENT_ONE);
    markOfferDelivery(sqlite, taskB.task_id, 'claimed');
    const cardMessage = (
      sqlite
        .prepare('SELECT message_id FROM task_cards WHERE task_id = ?')
        .get(taskB.task_id) as { message_id: string }
    ).message_id;
    sqlite
      .prepare(
        `INSERT INTO deliveries
           (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id, claimed_at,
            progress_at, result_message_id, error, created_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, 0, ?, ?)`,
      )
      .run('dlv_d08_reminder', AGENT_TWO, cardMessage, ROOM, BASE, BASE);
    sqlite
      .prepare(
        `INSERT INTO task_deliveries
           (delivery_id, task_id, assignment_id, assignment_version, task_revision, kind, created_at)
         VALUES (?, ?, ?, ?, ?, 'task_reminder', ?)`,
      )
      .run('dlv_d08_reminder', taskB.task_id, taskB.assignment_id, taskB.assignment_version, taskB.revision, BASE);
    sqlite.prepare('UPDATE actors SET pending_count = pending_count + 1 WHERE actor_id = ?').run(AGENT_TWO);
    const taskBRevision = taskRow(sqlite, taskB.task_id).revision;
    const cancelledB = await taskCancel(d1, owner, {
      request_id: newRequestId('d08_t02_cancel_b'),
      task_id: taskB.task_id,
      reason: '外部执行已停止（操作者声明）',
      external_stop_status: 'confirmed',
      expected_revision: taskBRevision,
    });
    checkEqual(
      'D08-T02 取消记录操作者声明的 confirmed',
      cancelledB.task.external_stop_status,
      'confirmed',
    );
    const claimedState = sqlite
      .prepare("SELECT state FROM deliveries WHERE delivery_id = 'dlv_d08_reminder'")
      .get() as { state: string };
    checkEqual('D08-T02 task_reminder 投递被取消', claimedState.state, 'cancelled');
    checkEqual(
      'D08-T02 取消 claimed task_reminder 不重复递减 pending_count',
      (
        sqlite.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(AGENT_TWO) as {
          pending_count: number;
        }
      ).pending_count,
      0,
    );
    const claimedOffer = sqlite
      .prepare(
        `SELECT d.state, d.attempt, d.claim_id FROM task_deliveries td
           JOIN deliveries d ON d.delivery_id = td.delivery_id
          WHERE td.task_id = ? AND td.kind = 'task_offer'`,
      )
      .get(taskB.task_id) as { state: string; attempt: number; claim_id: string };
    checkEqual('D08-T02 claimed task_offer 保留 attempt 并取消', claimedOffer.state, 'cancelled');
    checkEqual('D08-T02 claimed task_offer 未被删除', claimedOffer.attempt, 1);

    // 3. 取消 submitted 保留成果审计；取消 accepted 被拒绝。
    const taskC = await createTask(d1, sqlite, {
      title: 'D08 T02 取消待验收',
      assignee: HUMAN_WORKER,
      prefix: 'd08_t02_c_create',
    });
    await acceptTask(d1, sqlite, taskC, HUMAN_WORKER);
    const acceptedC = taskRow(sqlite, taskC.task_id);
    const submittedC = await taskSubmit(d1, humanWorker, {
      request_id: newRequestId('d08_t02_submit_c'),
      task_id: taskC.task_id,
      summary: '已交付成果',
      evidence: ['证据：验收脚本输出'],
      assignment_id: taskC.assignment_id,
      assignment_version: taskC.assignment_version,
      expected_revision: acceptedC.revision,
    });
    const cancelledC = await taskCancel(d1, owner, {
      request_id: newRequestId('d08_t02_cancel_c'),
      task_id: taskC.task_id,
      reason: '验收前取消，保留成果审计',
      expected_revision: submittedC.task.revision,
    });
    checkEqual('D08-T02 submitted 可被有权限者取消', cancelledC.task.status, 'cancelled');
    checkEqual(
      'D08-T02 submitted 取消不需要外部停止',
      cancelledC.task.external_stop_status,
      'not_required',
    );
    checkEqual(
      'D08-T02 取消保留成果记录',
      count(sqlite, 'SELECT COUNT(*) AS n FROM task_submissions WHERE task_id = ?', taskC.task_id),
      1,
    );
    checkEqual(
      'D08-T02 取消不删除 pending 成果审计',
      (
        sqlite
          .prepare('SELECT status FROM task_submissions WHERE submission_id = ?')
          .get(submittedC.submission.submission_id) as { status: string }
      ).status,
      'pending',
    );
    const submittedCancelMetadata = JSON.parse(
      (
        sqlite
          .prepare(
            "SELECT metadata FROM events WHERE event_type = 'task_cancelled' AND ref_id = ? ORDER BY event_seq DESC LIMIT 1",
          )
          .get(taskC.task_id) as { metadata: string }
      ).metadata,
    ) as Record<string, unknown>;
    checkEqual(
      'D08-T02 取消事件记录保留成果数量',
      submittedCancelMetadata.preserved_submission_count,
      1,
    );
    await expectBusinessErrorAny(
      'D08-T02 取消后不能继续验收',
      taskReviewAccept(d1, reviewer, {
        request_id: newRequestId('d08_t02_review_cancelled'),
        task_id: taskC.task_id,
        submission_id: submittedC.submission.submission_id,
        version: submittedC.submission.version,
        checklist: [{ item: '验收条件', passed: true }],
        expected_revision: cancelledC.task.revision,
      }),
      ['REVIEW_STALE', 'CONFLICT'],
    );

    const taskD = await createTask(d1, sqlite, {
      title: 'D08 T02 已完成任务',
      assignee: HUMAN_WORKER,
      prefix: 'd08_t02_d_create',
    });
    await acceptTask(d1, sqlite, taskD, HUMAN_WORKER);
    const acceptedD = taskRow(sqlite, taskD.task_id);
    const submittedD = await taskSubmit(d1, humanWorker, {
      request_id: newRequestId('d08_t02_submit_d'),
      task_id: taskD.task_id,
      summary: '已完成成果',
      evidence: ['证据：全部通过'],
      expected_revision: acceptedD.revision,
    });
    const acceptedResult = await taskReviewAccept(d1, reviewer, {
      request_id: newRequestId('d08_t02_review_d'),
      task_id: taskD.task_id,
      submission_id: submittedD.submission.submission_id,
      version: submittedD.submission.version,
      checklist: [{ item: '验收条件', passed: true }],
      expected_revision: submittedD.task.revision,
    });
    checkEqual('D08-T02 accepted 是终态', acceptedResult.task.status, 'accepted');
    await expectBusinessError(
      'D08-T02 已验收任务不能取消',
      taskCancel(d1, owner, {
        request_id: newRequestId('d08_t02_cancel_done'),
        task_id: taskD.task_id,
        reason: '不应取消',
        expected_revision: acceptedResult.task.revision,
      }),
      'CONFLICT',
    );

    // 4. failed 任务重试：新 revision/assignment_version，旧执行资格失效。
    const taskE = await createTask(d1, sqlite, {
      title: 'D08 T02 重试失败任务',
      assignee: AGENT_ONE,
      prefix: 'd08_t02_e_create',
    });
    await acceptTask(d1, sqlite, taskE, AGENT_ONE);
    const acceptedE = taskRow(sqlite, taskE.task_id);
    await taskReportProgress(d1, agentOne, {
      request_id: newRequestId('d08_t02_progress_e'),
      task_id: taskE.task_id,
      note: '旧执行者进度',
      assignment_id: taskE.assignment_id,
      assignment_version: taskE.assignment_version,
      expected_revision: acceptedE.revision,
    });
    const beforeRetryE = taskRow(sqlite, taskE.task_id);
    await taskTransferPropose(d1, owner, {
      request_id: newRequestId('d08_t02_transfer_e'),
      task_id: taskE.task_id,
      to_actor_id: AGENT_TWO,
      expected_revision: beforeRetryE.revision,
    });
    sqlite
      .prepare("UPDATE tasks SET status = 'failed', revision = revision + 1, updated_at = ? WHERE task_id = ?")
      .run(BASE, taskE.task_id);
    const failedE = taskRow(sqlite, taskE.task_id);
    const versionsBeforeRetry = assignmentVersions(sqlite, taskE.task_id);
    const pendingAgentOne = (
      sqlite.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(AGENT_ONE) as {
        pending_count: number;
      }
    ).pending_count;
    const retriedE = await taskRetry(d1, owner, {
      request_id: newRequestId('d08_t02_retry_e'),
      task_id: taskE.task_id,
      reason: '旧执行环境失败，重新派发给新负责人',
      assignee_actor_id: AGENT_TWO,
      expected_revision: failedE.revision,
    });
    checkEqual('D08-T02 failed 重试回到 offered', retriedE.task.status, 'offered');
    checkEqual('D08-T02 重试递增 task revision', retriedE.task.revision, failedE.revision + 1);
    checkEqual('D08-T02 重试后 owner 等待接受', retriedE.task.owner_actor_id, null);
    check(
      'D08-T02 重试生成新的 assignment_version',
      retriedE.task.assignment !== null &&
        retriedE.task.assignment.assignment_version > Math.max(...versionsBeforeRetry),
      retriedE.task.assignment,
    );
    checkEqual(
      'D08-T02 旧 assignment 被撤销',
      (
        sqlite
          .prepare('SELECT status FROM task_assignments WHERE assignment_id = ?')
          .get(taskE.assignment_id) as { status: string }
      ).status,
      'revoked',
    );
    checkEqual(
      'D08-T02 重试取消旧 pending 交接',
      count(
        sqlite,
        "SELECT COUNT(*) AS n FROM task_transfers WHERE task_id = ? AND status = 'pending'",
        taskE.task_id,
      ),
      0,
    );
    checkEqual(
      'D08-T02 重试关闭旧投递并递减 pending_count',
      (
        sqlite.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(AGENT_ONE) as {
          pending_count: number;
        }
      ).pending_count,
      pendingAgentOne - 1,
    );
    checkEqual(
      'D08-T02 新候选收到一条 pending 投递',
      count(
        sqlite,
        `SELECT COUNT(*) AS n FROM task_deliveries td JOIN deliveries d ON d.delivery_id = td.delivery_id
          WHERE td.task_id = ? AND d.recipient_id = ? AND d.state = 'pending'`,
        taskE.task_id,
        AGENT_TWO,
      ),
      1,
    );
    checkEqual(
      'D08-T02 重试事件记录 previous assignment',
      JSON.parse(
        (
          sqlite
            .prepare(
              "SELECT metadata FROM events WHERE event_type = 'task_retried' AND ref_id = ? ORDER BY event_seq DESC LIMIT 1",
            )
            .get(taskE.task_id) as { metadata: string }
        ).metadata,
      ).previous_assignment_id,
      taskE.assignment_id,
    );
    await expectBusinessErrorAny(
      'D08-T02 旧执行者不能写新进度',
      taskReportProgress(d1, agentOne, {
        request_id: newRequestId('d08_t02_progress_old'),
        task_id: taskE.task_id,
        note: '旧执行者不应继续',
        expected_revision: retriedE.task.revision,
      }),
      ['ASSIGNMENT_STALE', 'CONFLICT'],
    );
    await expectBusinessErrorAny(
      'D08-T02 旧执行者不能提交旧成果',
      taskSubmit(d1, agentOne, {
        request_id: newRequestId('d08_t02_submit_old'),
        task_id: taskE.task_id,
        summary: '旧成果',
        evidence: ['旧证据'],
      }),
      ['CONFLICT', 'ASSIGNMENT_STALE', 'PERMISSION_DENIED'],
    );
    const newAssignmentE = retriedE.task.assignment;
    check('D08-T02 新候选获得 assignment', newAssignmentE !== null, retriedE.task.assignment);
    await taskAccept(d1, agentTwo, {
      request_id: newRequestId('d08_t02_accept_new'),
      task_id: taskE.task_id,
      assignment_id: newAssignmentE!.assignment_id,
      expected_revision: retriedE.task.revision,
    });
    const acceptedNewE = taskRow(sqlite, taskE.task_id);
    await taskReportProgress(d1, agentTwo, {
      request_id: newRequestId('d08_t02_progress_new'),
      task_id: taskE.task_id,
      note: '新执行者进度',
      assignment_id: newAssignmentE!.assignment_id,
      assignment_version: newAssignmentE!.assignment_version,
      expected_revision: acceptedNewE.revision,
    });
    checkEqual('D08-T02 新执行者可继续写进度', taskRow(sqlite, taskE.task_id).status, 'in_progress');

    await expectBusinessError(
      'D08-T02 非派发者不能重试',
      taskRetry(d1, agentOne, {
        request_id: newRequestId('d08_t02_retry_denied'),
        task_id: taskE.task_id,
        reason: '越权重试',
      }),
      'PERMISSION_DENIED',
    );

    // 5. 不带 assignee 的重试回到 unassigned，下一次 offer 使用新版本。
    const taskF = await createTask(d1, sqlite, {
      title: 'D08 T02 重试回未指派',
      assignee: AGENT_ONE,
      prefix: 'd08_t02_f_create',
    });
    await acceptTask(d1, sqlite, taskF, AGENT_ONE);
    sqlite
      .prepare("UPDATE tasks SET status = 'failed', revision = revision + 1, updated_at = ? WHERE task_id = ?")
      .run(BASE, taskF.task_id);
    const failedF = taskRow(sqlite, taskF.task_id);
    const retriedF = await taskRetry(d1, owner, {
      request_id: newRequestId('d08_t02_retry_f'),
      task_id: taskF.task_id,
      reason: '先回到未指派，等待重新分派',
      expected_revision: failedF.revision,
    });
    checkEqual('D08-T02 无 assignee 重试回到 unassigned', retriedF.task.status, 'unassigned');
    checkEqual('D08-T02 unassigned 重试清空当前 assignment', retriedF.task.assignment, null);
    const offeredF = await taskOffer(d1, owner, {
      request_id: newRequestId('d08_t02_offer_f'),
      task_id: taskF.task_id,
      assignee_actor_id: AGENT_TWO,
      expected_revision: retriedF.task.revision,
    });
    check(
      'D08-T02 重新派发生成更高 assignment_version',
      offeredF.task.assignment !== null &&
        offeredF.task.assignment.assignment_version > taskF.assignment_version,
      offeredF.task.assignment,
    );
  } finally {
    sqlite.close();
  }
}

function setLastProgress(db: Database, taskId: string, value: number): void {
  db.prepare('UPDATE tasks SET last_progress_at = ? WHERE task_id = ?').run(value, taskId);
}

interface ReminderInvariants {
  deliveries: number;
  assignments: number;
  roomHead: number;
  roomEvents: number;
  roomOutbox: number;
  pendingWorker: number;
  pendingReviewer: number;
  pendingAgent: number;
}

function reminderInvariants(db: Database): ReminderInvariants {
  return {
    deliveries: count(db, 'SELECT COUNT(*) AS n FROM deliveries'),
    assignments: count(db, 'SELECT COUNT(*) AS n FROM task_assignments'),
    roomHead: (
      db.prepare('SELECT head_seq FROM rooms WHERE room_id = ?').get(ROOM) as { head_seq: number }
    ).head_seq,
    roomEvents: count(
      db,
      "SELECT COUNT(*) AS n FROM events WHERE scope_kind = 'room' AND scope_id = ?",
      ROOM,
    ),
    roomOutbox: count(db, 'SELECT COUNT(*) AS n FROM outbox WHERE topic = ?', `room:${ROOM}`),
    pendingWorker: (
      db.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(HUMAN_WORKER) as {
        pending_count: number;
      }
    ).pending_count,
    pendingReviewer: (
      db.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(REVIEWER) as {
        pending_count: number;
      }
    ).pending_count,
    pendingAgent: (
      db.prepare('SELECT pending_count FROM actors WHERE actor_id = ?').get(AGENT_ONE) as {
        pending_count: number;
      }
    ).pending_count,
  };
}

function checkReminderSideEffects(before: ReminderInvariants, after: ReminderInvariants): void {
  checkEqual('D08-T03 提醒不创建 delivery', after.deliveries, before.deliveries);
  checkEqual('D08-T03 提醒不创建 assignment', after.assignments, before.assignments);
  checkEqual('D08-T03 提醒不推进房间 head', after.roomHead, before.roomHead);
  checkEqual('D08-T03 提醒不写 room scope 事件', after.roomEvents, before.roomEvents);
  checkEqual('D08-T03 提醒不写 room outbox', after.roomOutbox, before.roomOutbox);
  checkEqual('D08-T03 提醒不增加负责人 pending_count', after.pendingWorker, before.pendingWorker);
  checkEqual('D08-T03 提醒不影响验收人 pending_count', after.pendingReviewer, before.pendingReviewer);
  checkEqual('D08-T03 提醒不影响其他 Agent pending_count', after.pendingAgent, before.pendingAgent);
}

async function runT03(): Promise<void> {
  console.log('  · D08-T03 提醒频率与停止条件');
  const { sqlite, d1 } = openMemoryDb();
  try {
    const threshold = LIMITS.taskReminderMs;
    const humanWorker = principalFor(sqlite, HUMAN_WORKER);

    const task = await createTask(d1, sqlite, {
      title: 'D08 T03 人类负责人催办',
      assignee: HUMAN_WORKER,
      prefix: 'd08_t03_create',
    });
    await acceptTask(d1, sqlite, task, HUMAN_WORKER);
    const before = reminderInvariants(sqlite);

    setLastProgress(sqlite, task.task_id, BASE - threshold + 1);
    const beforeBoundary = await remindStaleTasks(d1, BASE);
    checkEqual('D08-T03 未到 3 分钟不提醒', beforeBoundary.scanned, 0);
    checkEqual(
      'D08-T03 未到阈值不写 reminder 事件',
      taskReminderEvents(sqlite, task.task_id),
      0,
    );

    setLastProgress(sqlite, task.task_id, BASE - threshold);
    const first = await remindStaleTasks(d1, BASE);
    checkEqual('D08-T03 到达 3 分钟提醒一次', first.reminded, 1);
    checkEqual('D08-T03 首条 reminder 写入 inbox', taskReminderEvents(sqlite, task.task_id), 1);
    const firstReminder = sqlite
      .prepare(
        `SELECT scope_id, metadata FROM events
          WHERE event_type = 'task_reminder' AND ref_id = ? ORDER BY event_seq ASC LIMIT 1`,
      )
      .get(task.task_id) as { scope_id: string; metadata: string };
    checkEqual('D08-T03 提醒只发给当前责任者', firstReminder.scope_id, HUMAN_WORKER);
    checkEqual('D08-T03 提醒不发给验收人', firstReminder.scope_id === REVIEWER, false);
    checkEqual('D08-T03 提醒不发给创建者', firstReminder.scope_id === OWNER, false);
    const firstMetadata = JSON.parse(firstReminder.metadata) as Record<string, unknown>;
    check('D08-T03 reminder 携带 task_id', firstMetadata.task_id === task.task_id, firstMetadata);
    check(
      'D08-T03 reminder 携带 assignment 版本',
      firstMetadata.assignment_id === task.assignment_id &&
        firstMetadata.assignment_version === task.assignment_version,
      firstMetadata,
    );
    check(
      'D08-T03 reminder 携带期限与阻塞原因字段',
      Object.hasOwn(firstMetadata, 'due_at') && Object.hasOwn(firstMetadata, 'blocked_reason'),
      firstMetadata,
    );
    checkEqual(
      'D08-T03 reminder 写入持久窗口',
      count(sqlite, 'SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ?', task.task_id),
      1,
    );
    checkEqual(
      'D08-T03 reminder 写入 inbox outbox',
      count(
        sqlite,
        `SELECT COUNT(*) AS n FROM outbox o JOIN events e ON e.event_seq = o.event_seq
          WHERE e.event_type = 'task_reminder' AND e.ref_id = ?`,
        task.task_id,
      ),
      1,
    );
    checkReminderSideEffects(before, reminderInvariants(sqlite));

    const sameWindow = await remindStaleTasks(d1, BASE);
    checkEqual('D08-T03 同一窗口重复扫描不重复提醒', sameWindow.reminded, 0);
    checkEqual('D08-T03 同一窗口仍只有一条 reminder', taskReminderEvents(sqlite, task.task_id), 1);
    const beforeSecondWindow = await remindStaleTasks(d1, BASE + threshold - 1);
    checkEqual('D08-T03 间隔未到不重复提醒', beforeSecondWindow.reminded, 0);
    const second = await remindStaleTasks(d1, BASE + threshold);
    checkEqual('D08-T03 间隔到达后再次提醒', second.reminded, 1);
    checkEqual('D08-T03 第二个窗口新增事件', taskReminderEvents(sqlite, task.task_id), 2);
    checkEqual(
      'D08-T03 两个窗口持久化两条记录',
      count(sqlite, 'SELECT COUNT(*) AS n FROM task_reminders WHERE task_id = ?', task.task_id),
      2,
    );
    const eventKeys = sqlite
      .prepare('SELECT event_key FROM task_reminders WHERE task_id = ? ORDER BY created_at')
      .all(task.task_id) as { event_key: string }[];
    checkEqual('D08-T03 每个窗口 event_key 唯一', new Set(eventKeys.map((row) => row.event_key)).size, 2);
    const afterTwoReminders = reminderInvariants(sqlite);
    checkReminderSideEffects(before, afterTwoReminders);

    // 进度上报重置窗口；用返回的 last_progress_at 驱动固定时钟，不 sleep。
    const taskNow = taskRow(sqlite, task.task_id);
    const reported = await taskReportProgress(d1, humanWorker, {
      request_id: newRequestId('d08_t03_progress'),
      task_id: task.task_id,
      note: '已处理一半',
      assignment_id: task.assignment_id,
      assignment_version: task.assignment_version,
      expected_revision: taskNow.revision,
    });
    const progressAt = Number(reported.task.last_progress_at);
    check('D08-T03 进度上报刷新 last_progress_at', Number.isFinite(progressAt), reported.task.last_progress_at);
    checkEqual(
      'D08-T03 上报后立即不提醒',
      (await remindStaleTasks(d1, progressAt + threshold - 1)).reminded,
      0,
    );
    checkEqual(
      'D08-T03 上报后新窗口到达再提醒',
      (await remindStaleTasks(d1, progressAt + threshold)).reminded,
      1,
    );
    checkEqual('D08-T03 第三个窗口新增事件', taskReminderEvents(sqlite, task.task_id), 3);

    // 人类不要求持续心跳：长时间无更新只提醒，不自动失败。
    const late = await remindStaleTasks(d1, progressAt + 10 * threshold);
    check('D08-T03 长时间无更新仍只提醒', late.reminded >= 1, late);
    checkEqual('D08-T03 催办不自动失败任务', taskRow(sqlite, task.task_id).status, 'in_progress');

    const beforeCancel = taskReminderEvents(sqlite, task.task_id);
    const current = taskRow(sqlite, task.task_id);
    await taskCancel(d1, principalFor(sqlite, OWNER), {
      request_id: newRequestId('d08_t03_cancel'),
      task_id: task.task_id,
      reason: '取消后停止催办',
      expected_revision: current.revision,
    });
    const cancelSweep = await remindStaleTasks(d1, progressAt + 20 * threshold);
    checkEqual('D08-T03 取消后不再提醒', cancelSweep.reminded, 0);
    checkEqual('D08-T03 取消后 event 数不增长', taskReminderEvents(sqlite, task.task_id), beforeCancel);

    // 提交后停止提醒。
    const submitTask = await createTask(d1, sqlite, {
      title: 'D08 T03 提交后停止',
      assignee: HUMAN_WORKER,
      prefix: 'd08_t03_submit_create',
    });
    await acceptTask(d1, sqlite, submitTask, HUMAN_WORKER);
    setLastProgress(sqlite, submitTask.task_id, BASE - threshold);
    const submitBefore = taskRow(sqlite, submitTask.task_id);
    await taskSubmit(d1, principalFor(sqlite, HUMAN_WORKER), {
      request_id: newRequestId('d08_t03_submit'),
      task_id: submitTask.task_id,
      summary: '提交后应停止催办',
      evidence: ['证据：提交完成'],
      assignment_id: submitTask.assignment_id,
      assignment_version: submitTask.assignment_version,
      expected_revision: submitBefore.revision,
    });
    const submitSweep = await remindStaleTasks(d1, BASE);
    checkEqual('D08-T03 提交后不再提醒', submitSweep.reminded, 0);
    checkEqual(
      'D08-T03 提交后没有 reminder 事件',
      taskReminderEvents(sqlite, submitTask.task_id),
      0,
    );

    // 验收通过后同样不提醒。
    const acceptedTask = await createTask(d1, sqlite, {
      title: 'D08 T03 验收后停止',
      assignee: HUMAN_WORKER,
      prefix: 'd08_t03_accepted_create',
    });
    await acceptTask(d1, sqlite, acceptedTask, HUMAN_WORKER);
    const acceptedBefore = taskRow(sqlite, acceptedTask.task_id);
    const submitted = await taskSubmit(d1, principalFor(sqlite, HUMAN_WORKER), {
      request_id: newRequestId('d08_t03_accepted_submit'),
      task_id: acceptedTask.task_id,
      summary: '已验收成果',
      evidence: ['证据：验收通过'],
      expected_revision: acceptedBefore.revision,
    });
    await taskReviewAccept(d1, principalFor(sqlite, REVIEWER), {
      request_id: newRequestId('d08_t03_accepted_review'),
      task_id: acceptedTask.task_id,
      submission_id: submitted.submission.submission_id,
      version: submitted.submission.version,
      checklist: [{ item: '验收条件', passed: true }],
      expected_revision: submitted.task.revision,
    });
    setLastProgress(sqlite, acceptedTask.task_id, BASE - threshold);
    checkEqual(
      'D08-T03 验收后不再提醒',
      (await remindStaleTasks(d1, BASE + 2 * threshold)).reminded,
      0,
    );
    checkEqual(
      'D08-T03 验收后没有 reminder 事件',
      taskReminderEvents(sqlite, acceptedTask.task_id),
      0,
    );

    // 同一 assignment 仍有 pending/claimed task_offer delivery 时跳过。
    const deliveryTask = await createTask(d1, sqlite, {
      title: 'D08 T03 delivery 去重',
      assignee: AGENT_ONE,
      prefix: 'd08_t03_delivery_create',
    });
    await acceptTask(d1, sqlite, deliveryTask, AGENT_ONE);
    setLastProgress(sqlite, deliveryTask.task_id, BASE - threshold);
    const skipped = await remindStaleTasks(d1, BASE);
    checkEqual('D08-T03 同 assignment 有 pending offer 时跳过', skipped.reminded, 0);
    checkEqual(
      'D08-T03 跳过时不写 task_reminder',
      taskReminderEvents(sqlite, deliveryTask.task_id),
      0,
    );
    markOfferDelivery(sqlite, deliveryTask.task_id, 'completed');
    setLastProgress(sqlite, deliveryTask.task_id, BASE - threshold);
    const afterDelivery = await remindStaleTasks(d1, BASE);
    checkEqual('D08-T03 offer 完成后恢复任务提醒', afterDelivery.reminded, 1);
    const deliveredReminder = sqlite
      .prepare(
        `SELECT scope_id FROM events WHERE event_type = 'task_reminder' AND ref_id = ?
          ORDER BY event_seq DESC LIMIT 1`,
      )
      .get(deliveryTask.task_id) as { scope_id: string };
    checkEqual('D08-T03 Agent 提醒发给 Agent 本人', deliveredReminder.scope_id, AGENT_ONE);
  } finally {
    sqlite.close();
  }
}

interface ServerProcess {
  kill(signal?: string | number): void;
  exited: Promise<number>;
}

async function waitForHealth(base: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // 服务尚未监听
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(`D08 重启验收实例未在 12s 内就绪: ${base}`);
}

async function startServer(dataDir: string): Promise<{ base: string; proc: ServerProcess }> {
  const port = 19000 + Math.floor(Math.random() * 800);
  const base = `http://127.0.0.1:${port}`;
  const proc = Bun.spawn(['bun', resolve(import.meta.dir, '../../src/bun/main.ts')], {
    cwd: resolve(import.meta.dir, '../..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: base,
      DRIVE_DISABLED: '1',
      AGENT_PRESENCE_ACTIVITY_TTL_MS: process.env.AGENT_PRESENCE_ACTIVITY_TTL_MS ?? '5000',
      AGENT_PRESENCE_GRACE_MS: process.env.AGENT_PRESENCE_GRACE_MS ?? '2000',
      AGENT_PRESENCE_SWEEP_MS: process.env.AGENT_PRESENCE_SWEEP_MS ?? '1000',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  try {
    await waitForHealth(base);
  } catch (error) {
    proc.kill('SIGKILL');
    await proc.exited.catch(() => undefined);
    throw error;
  }
  return { base, proc: proc as unknown as ServerProcess };
}

async function stopServer(proc: ServerProcess, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  proc.kill(signal);
  await proc.exited.catch(() => undefined);
}

interface TaskView {
  task_id: string;
  room_id: string;
  status: string;
  revision: number;
  owner_actor_id: string | null;
  assignment: {
    assignment_id: string;
    assignment_version: number;
    status: string;
  } | null;
}

interface SyncPageView {
  items: {
    type: string;
    ref_id: string | null;
    metadata: Record<string, unknown>;
  }[];
  next_cursor: string;
  has_more: boolean;
}

interface StreamItemView {
  source?: string;
  task_id?: string;
  attention?: string;
}

type Collector = ReturnType<typeof notificationCollector>;

function streamItems(collector: Collector): StreamItemView[] {
  const items: StreamItemView[] = [];
  for (const event of collector.events) {
    if (event.params.uri !== 'agentnet://stream') continue;
    const meta = event.params._meta as Record<string, unknown> | undefined;
    const payload = meta?.['io.agent-network/event'] as { items?: StreamItemView[] } | undefined;
    if (payload?.items) items.push(...payload.items);
  }
  return items;
}

async function waitForStreamItem(
  collector: Collector,
  predicate: (item: StreamItemView) => boolean,
  label: string,
): Promise<StreamItemView> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = streamItems(collector).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`${label}: 等待 stream item 超时 (${JSON.stringify(streamItems(collector))})`);
    }
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

async function runT04(): Promise<void> {
  console.log('  · D08-T04 服务重启、断线重连与 outbox 补读');
  const previousBase = process.env.AGENTNET_URL;
  const dataDir = mkdtempSync(join(tmpdir(), 'agentnet-d08-restart-'));
  let server: { base: string; proc: ServerProcess } | null = null;
  let humanConn: McpConnection | null = null;
  let agentConn: McpConnection | null = null;
  let agentAgain: McpConnection | null = null;
  let humanAgain: McpConnection | null = null;
  let agentSub: McpSubscription | null = null;
  let humanSub: McpSubscription | null = null;
  try {
    server = await startServer(dataDir);
    process.env.AGENTNET_URL = server.base;

    const humanToken = newToken();
    const agentToken = newToken();
    humanConn = await connectClient(humanToken);
    agentConn = await connectClient(agentToken);
    const human = await registerIdentity(humanConn, { kind: 'human', name: 'D08 重启人类' });
    const agent = await registerIdentity(agentConn, {
      kind: 'agent',
      name: 'D08 重启 Agent',
      sessionId: `d08_restart_${crypto.randomUUID()}`,
    });
    await befriend(humanConn, human.actor_id, agentConn, agent.actor_id);
    const room = await callTool<RoomDetail>(humanConn.client, 'network_room_create', {
      request_id: newRequestId('d08_t04_room'),
      kind: 'group',
      members: [agent.actor_id],
      title: 'D08 重启恢复',
    });
    await acceptGroupInvites(agentConn, room.room.room_id);
    const created = await callTool<{ task: TaskView }>(humanConn.client, 'network_task_create', {
      request_id: newRequestId('d08_t04_create'),
      room_id: room.room.room_id,
      title: 'D08 重启恢复任务',
      description: '服务重启后任务与提醒可补读',
      acceptance_criteria: '任务不丢失，提醒可补读',
      assignee_actor_id: agent.actor_id,
      reviewer_actor_id: human.actor_id,
    });
    const assignment = created.task.assignment;
    if (!assignment) throw new Error('D08 重启任务缺少 assignment');
    const accepted = await callTool<{ task: TaskView }>(agentConn.client, 'network_task_accept', {
      request_id: newRequestId('d08_t04_accept'),
      task_id: created.task.task_id,
      assignment_id: assignment.assignment_id,
      expected_revision: created.task.revision,
    });
    // 先完成 offer delivery，让任务催办（而非 delivery 提醒）覆盖这个任务。
    const offerInbox = await inbox(agentConn, 'pending');
    const offerDelivery = offerInbox.items[0];
    if (!offerDelivery) throw new Error('D08 重启任务缺少 pending offer delivery');
    const claimed = await callTool<{ attempt: number; claim_id: string }>(
      agentConn.client,
      'network_delivery_claim',
      {
        request_id: newRequestId('d08_t04_claim'),
        delivery_id: offerDelivery.delivery_id,
      },
    );
    await callTool(agentConn.client, 'network_delivery_complete', {
      request_id: newRequestId('d08_t04_complete'),
      delivery_id: offerDelivery.delivery_id,
      attempt: claimed.attempt,
      claim_id: claimed.claim_id,
      final_body: '任务已接手，后续由任务催办负责',
    });
    const second = await callTool<{ task: TaskView }>(humanConn.client, 'network_task_create', {
      request_id: newRequestId('d08_t04_create_second'),
      room_id: room.room.room_id,
      title: 'D08 重启待接手任务',
      description: '重启后 pending offer 与任务列表都应恢复',
      acceptance_criteria: '待接手状态保持',
      assignee_actor_id: agent.actor_id,
      reviewer_actor_id: human.actor_id,
    });
    const acceptedRevision = accepted.task.revision;
    const taskId = created.task.task_id;
    const secondTaskId = second.task.task_id;
    const roomId = room.room.room_id;

    await agentConn.close();
    agentConn = null;
    await humanConn.close();
    humanConn = null;
    await stopServer(server.proc, 'SIGTERM');
    server = null;

    // 新 SQLite / D1 连接读取同一 DATA_DIR：模拟维护进程或新进程写入提醒。
    const dbPath = join(dataDir, 'agent-network.sqlite');
    const inspect = new Database(dbPath);
    inspect.exec('PRAGMA foreign_keys = ON;');
    const now = Date.now();
    inspect.prepare('UPDATE tasks SET last_progress_at = 0 WHERE task_id = ?').run(taskId);
    const d1 = createD1(inspect);
    const reminder = await remindStaleTasks(d1, now);
    checkEqual('D08-T04 新 DB 连接写入一条任务提醒', reminder.reminded, 1);
    checkEqual(
      'D08-T04 重启前任务仍持久化',
      count(inspect, 'SELECT COUNT(*) AS n FROM tasks WHERE task_id IN (?, ?)', taskId, secondTaskId),
      2,
    );
    checkEqual(
      'D08-T04 重启前 assignment 未被重建',
      count(inspect, 'SELECT COUNT(*) AS n FROM task_assignments WHERE task_id = ?', taskId),
      1,
    );
    checkEqual(
      'D08-T04 重启前 reminder 事件已持久化',
      taskReminderEvents(inspect, taskId),
      1,
    );
    checkEqual(
      'D08-T04 重启前 reminder outbox 为 pending',
      count(
        inspect,
        `SELECT COUNT(*) AS n FROM outbox o JOIN events e ON e.event_seq = o.event_seq
          WHERE e.event_type = 'task_reminder' AND e.ref_id = ? AND o.status = 'pending'`,
        taskId,
      ),
      1,
    );
    inspect.close();

    // 新进程读取同一 DATA_DIR；不恢复旧进程栈，所有可见性来自持久表。
    server = await startServer(dataDir);
    process.env.AGENTNET_URL = server.base;
    agentAgain = await connectClient(agentToken);
    humanAgain = await connectClient(humanToken);
    await registerOnReconnect(agentAgain);
    await registerOnReconnect(humanAgain);

    const listed = await callTool<{ tasks: TaskView[] }>(agentAgain.client, 'network_task_list', {
      room_id: roomId,
      limit: 50,
    });
    const restored = listed.tasks.find((item) => item.task_id === taskId);
    const restoredSecond = listed.tasks.find((item) => item.task_id === secondTaskId);
    check('D08-T04 重启后任务列表包含进行中任务', restored !== undefined, listed.tasks);
    check('D08-T04 重启后任务列表包含待接手任务', restoredSecond !== undefined, listed.tasks);
    checkEqual('D08-T04 进行中任务状态恢复', restored?.status, 'in_progress');
    checkEqual('D08-T04 进行中任务负责人恢复', restored?.owner_actor_id, agent.actor_id);
    checkEqual('D08-T04 进行中任务 revision 未丢失', restored?.revision, acceptedRevision);
    checkEqual('D08-T04 待接手任务状态恢复', restoredSecond?.status, 'offered');

    const detail = await callTool<{ task: TaskView }>(agentAgain.client, 'network_task_get', {
      task_id: taskId,
    });
    checkEqual('D08-T04 重启后详情可读', detail.task.status, 'in_progress');
    checkEqual(
      'D08-T04 重启后 assignment 仍指向原版本',
      detail.task.assignment?.assignment_id,
      assignment.assignment_id,
    );

    const inboxSync = await callTool<SyncPageView>(agentAgain.client, 'network_sync', {
      scope: 'inbox',
      limit: 100,
    });
    const reminderItem = inboxSync.items.find(
      (item) => item.type === 'task_reminder' && item.ref_id === taskId,
    );
    check(
      'D08-T04 sync 不再补读旧 task_reminder',
      reminderItem === undefined,
      inboxSync.items,
    );

    const roomSync = await callTool<SyncPageView>(humanAgain.client, 'network_sync', {
      scope: `room:${roomId}`,
      limit: 100,
    });
    check(
      'D08-T04 sync 不再补读旧 task_created',
      !roomSync.items.some((item) => item.type === 'task_created' && item.ref_id === taskId),
      roomSync.items,
    );
    check(
      'D08-T04 sync 不再补读旧 task_offer_accepted',
      !roomSync.items.some(
        (item) => item.type === 'task_offer_accepted' && item.ref_id === taskId,
      ),
      roomSync.items,
    );

    // outbox 在新进程请求后完成发布；事件仍在 sync 中可补读。
    const outboxCheck = new Database(dbPath, { readonly: true });
    try {
      await waitUntil(
        'D08-T04 新进程完成 reminder outbox 发布',
        () =>
          (
            outboxCheck
              .prepare(
                `SELECT COUNT(*) AS n FROM outbox o JOIN events e ON e.event_seq = o.event_seq
                  WHERE e.event_type = 'task_reminder' AND e.ref_id = ? AND o.status = 'completed'`,
              )
              .get(taskId) as { n: number }
          ).n >= 1,
        15_000,
      );
    } finally {
      outboxCheck.close();
    }

    const agentCollector = notificationCollector(agentAgain.client);
    agentSub = await openSubscription(agentAgain.client, ['agentnet://stream']);
    await callTool(agentAgain.client, 'network_login', {});
    // 订阅建立后，用另一个新 DB 连接写入下一提醒窗口；随后由请求触发
    // outbox drain，验证通知不是依赖旧进程内存状态。
    const writer = new Database(dbPath);
    try {
      writer.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      // 把首个窗口标记为已过去，让下一窗口的 outbox 使用当前时间而不是
      // 固定测试时钟的未来时间，确保 30s 扫描/请求 fast-path 能立即发布。
      writer
        .prepare('UPDATE task_reminders SET created_at = ? WHERE task_id = ?')
        .run(Date.now() - LIMITS.taskReminderMs - 1, taskId);
      const next = await remindStaleTasks(createD1(writer), Date.now());
      checkEqual('D08-T04 运行中可由新 DB 连接写入下一提醒窗口', next.reminded, 1);
    } finally {
      writer.close();
    }
    await callTool(agentAgain.client, 'network_me', {});
    const pushed = await waitForStreamItem(
      agentCollector,
      (item) => item.source === 'task.reminder' && item.task_id === taskId,
      'D08-T04 重启后的提醒通知',
    );
    checkEqual('D08-T04 重启后提醒 attention 为 action_required', pushed.attention, 'action_required');
    await agentSub.close();
    agentSub = null;

    const humanCollector = notificationCollector(humanAgain.client);
    humanSub = await openSubscription(humanAgain.client, ['agentnet://stream']);
    await callTool(humanAgain.client, 'network_me', {});

    // 新进程中的任务写路径仍校验当前 revision/assignment；该请求产生的
    // room 事件由 human 订阅接收为 task.updated。
    const beforeProgress = detail.task.revision;
    const progressed = await callTool<{ task: TaskView }>(agentAgain.client, 'network_task_progress', {
      request_id: newRequestId('d08_t04_progress'),
      task_id: taskId,
      note: '重启后继续执行',
      expected_revision: beforeProgress,
    });
    checkEqual('D08-T04 重启后仍可写进度', progressed.task.status, 'in_progress');
    checkEqual('D08-T04 重启后写进度递增 revision', progressed.task.revision, beforeProgress + 1);

    const taskUpdated = await waitForStreamItem(
      humanCollector,
      (item) => item.source === 'task.updated' && item.task_id === taskId,
      'D08-T04 重启后的 task.updated',
    );
    checkEqual('D08-T04 task.updated 为 informational', taskUpdated.attention, 'informational');
    await humanSub.close();
    humanSub = null;
  } finally {
    if (agentSub) await agentSub.close().catch(() => undefined);
    if (humanSub) await humanSub.close().catch(() => undefined);
    await Promise.all([
      agentConn?.close().catch(() => undefined),
      humanConn?.close().catch(() => undefined),
      agentAgain?.close().catch(() => undefined),
      humanAgain?.close().catch(() => undefined),
    ]);
    if (server) await stopServer(server.proc, 'SIGKILL');
    if (previousBase === undefined) delete process.env.AGENTNET_URL;
    else process.env.AGENTNET_URL = previousBase;
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * 重连后的空注册是可选的：服务端按 Bearer 返回同一 actor。这里显式确认
 * token 仍解析到原身份，避免测试只因连接成功而误判恢复。
 */
async function registerOnReconnect(connection: McpConnection): Promise<void> {
  await callTool(connection.client, 'network_me', {});
}

export async function runTaskRecoveryAcceptance(): Promise<void> {
  console.log('· D08 催办取消与异常恢复');
  const start = checksPassed();
  await runT01();
  const afterT01 = checksPassed();
  await runT02();
  const afterT02 = checksPassed();
  await runT03();
  const afterT03 = checksPassed();
  await runT04();
  const end = checksPassed();
  console.log(
    `D08 专项通过: ${end - start} 项（T01 ${afterT01 - start} / T02 ${afterT02 - afterT01} / ` +
      `T03 ${afterT03 - afterT02} / T04 ${end - afterT03}）`,
  );
}

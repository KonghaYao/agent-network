/**
 * D02 接单拒单与原子领取验收（D02-T01..T04）。
 *
 * 只通过公开 MCP 工具调用，覆盖：
 * - D02-T01 human 与 Agent 并发领取公开任务，仅一个成功；
 * - D02-T02 同人两设备并发接受只生成一个 assignment，旧 offer 失效；
 * - D02-T03 接受/拒绝/取消并发只产生一种合法状态，delivery 完成不等于任务验收；
 * - D02-T04 task_revision/assignment CAS、非候选者与验收人边界。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  ToolError,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  inbox,
  registerIdentity,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

interface AssignmentView {
  assignment_id: string;
  assignment_version: number;
  owner_actor_id: string;
  owner_name: string | null;
  status: 'offered' | 'active' | 'submitted' | 'declined' | 'revoked' | 'expired';
  delivery_id: string | null;
}

interface TaskView {
  task_id: string;
  room_id: string;
  status:
    | 'unassigned'
    | 'offered'
    | 'in_progress'
    | 'blocked'
    | 'submitted'
    | 'accepted'
    | 'failed'
    | 'cancelled'
    | 'legacy_completed';
  revision: number;
  owner_actor_id: string | null;
  owner_name: string | null;
  reviewer_actor_id: string;
  assignment: AssignmentView | null;
  delivery_ids: string[];
  can_claim: boolean;
  can_accept: boolean;
  can_decline: boolean;
}

interface TaskResult {
  task: TaskView;
}

interface DeliveryView {
  delivery_id: string;
  state: string;
  attempt: number;
  claim_id: string | null;
}

const CONFLICT_CODES = new Set(['ASSIGNMENT_STALE', 'CLAIM_CONFLICT', 'CONFLICT', 'VERSION_CONFLICT']);

function errorCode(reason: unknown): string {
  return reason instanceof ToolError ? reason.code : String(reason);
}

function errorDetails(reason: unknown): Record<string, unknown> {
  if (!(reason instanceof ToolError)) return {};
  const details = reason.body.details;
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

async function createTask(
  connection: McpConnection,
  args: Record<string, unknown>,
): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_create', {
      request_id: newRequestId('d02_create'),
      ...args,
    })
  ).task;
}

async function getTask(connection: McpConnection, taskId: string): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_get', { task_id: taskId })
  ).task;
}

async function offer(
  connection: McpConnection,
  task: TaskView,
  assignee: string,
): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_offer', {
      request_id: newRequestId('d02_offer'),
      task_id: task.task_id,
      assignee_actor_id: assignee,
      expected_revision: task.revision,
    })
  ).task;
}

function accept(
  connection: McpConnection,
  task: TaskView,
  requestId = newRequestId('d02_accept'),
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_accept', {
    request_id: requestId,
    task_id: task.task_id,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    expected_revision: task.revision,
  });
}

function decline(
  connection: McpConnection,
  task: TaskView,
  reason?: string,
  requestId = newRequestId('d02_decline'),
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_decline', {
    request_id: requestId,
    task_id: task.task_id,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    expected_revision: task.revision,
    ...(reason ? { reason } : {}),
  });
}

function claim(
  connection: McpConnection,
  task: TaskView,
  expectedRevision: number | undefined = task.revision,
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_claim', {
    request_id: newRequestId('d02_claim'),
    task_id: task.task_id,
    ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
  });
}

async function cancel(
  connection: McpConnection,
  task: TaskView,
  reason: string,
): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_cancel', {
      request_id: newRequestId('d02_cancel'),
      task_id: task.task_id,
      reason,
      expected_revision: task.revision,
    })
  ).task;
}

export async function runTaskAssignmentAcceptance(): Promise<void> {
  console.log('· D02 接单拒单与原子领取');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const u3Conn = await connectClient(newToken());
  const b1Conn = await connectClient(newToken());
  const b2Conn = await connectClient(newToken());
  const extraConnections: McpConnection[] = [];

  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'D02 创建者 U1' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'D02 候选 U2' });
    const u3 = await registerIdentity(u3Conn, { kind: 'human', name: 'D02 验收人 U3' });
    const b1 = await registerIdentity(b1Conn, {
      kind: 'agent',
      name: 'D02 Agent B1',
      sessionId: `d02_b1_${crypto.randomUUID()}`,
    });
    const b2 = await registerIdentity(b2Conn, {
      kind: 'agent',
      name: 'D02 Agent B2',
      sessionId: `d02_b2_${crypto.randomUUID()}`,
    });
    const b1SecondConn = await connectClient(b1Conn.token);
    extraConnections.push(b1SecondConn);
    check(
      'D02 身份注册成功且 B1 有第二设备',
      Boolean(
        u1.actor_id &&
          u2.actor_id &&
          u3.actor_id &&
          b1.actor_id &&
          b2.actor_id &&
          b1SecondConn.token === b1Conn.token,
      ),
    );

    for (const peer of [u2Conn, u3Conn, b1Conn, b2Conn]) {
      await befriend(u1Conn, u1.actor_id, peer, (await callTool<Identity>(peer.client, 'network_me', {})).actor_id);
    }
    const group = await callTool<RoomDetail>(u1Conn.client, 'network_room_create', {
      request_id: newRequestId('d02_room'),
      kind: 'group',
      title: 'D02 接单验收群',
      members: [u2.actor_id, u3.actor_id, b1.actor_id, b2.actor_id],
    });
    const roomId = group.room.room_id;
    for (const connection of [u2Conn, u3Conn, b1Conn, b2Conn]) {
      await acceptGroupInvites(connection, roomId);
    }

    // ---------- D02-T01：human 与 Agent 并发领取，只有一个成功 ----------
    const t01 = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D02-T01 抢单',
      reviewer_actor_id: u1.actor_id,
    });
    const t01Attempts = await Promise.allSettled([
      claim(u2Conn, t01),
      claim(b1Conn, t01),
    ]);
    const t01Winners = t01Attempts.filter(
      (item): item is PromiseFulfilledResult<TaskResult> => item.status === 'fulfilled',
    );
    const t01Losers = t01Attempts.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    checkEqual('D02-T01 human/Agent 并发领取恰好一个成功', t01Winners.length, 1);
    checkEqual('D02-T01 并发领取失败方只有一个', t01Losers.length, 1);
    checkEqual('D02-T01 失败方返回 CLAIM_CONFLICT', errorCode(t01Losers[0]?.reason), 'CLAIM_CONFLICT');
    const t01WinnerActor = t01Winners[0]?.value.task.owner_actor_id ?? null;
    check(
      'D02-T01 成功方是 U2 或 B1',
      t01WinnerActor === u2.actor_id || t01WinnerActor === b1.actor_id,
      t01WinnerActor,
    );
    const t01Actual = await getTask(
      t01WinnerActor === u2.actor_id ? b1Conn : u2Conn,
      t01.task_id,
    );
    checkEqual('D02-T01 失败方读取到真实负责人', t01Actual.owner_actor_id, t01WinnerActor);
    checkEqual('D02-T01 失败方读取到 in_progress', t01Actual.status, 'in_progress');
    checkEqual('D02-T01 失败方不再可领取', t01Actual.can_claim, false);
    checkEqual(
      'D02-T01 错误详情携带真实负责人',
      errorDetails(t01Losers[0]?.reason).owner_actor_id,
      t01WinnerActor,
    );

    // ---------- D02-T02：同人两设备并发接受，只生成一个 assignment ----------
    const t02 = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D02-T02 同人双设备接受',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    checkEqual('D02-T02 offer 初始状态为 offered', t02.status, 'offered');
    const t02Attempts = await Promise.allSettled([
      accept(b1Conn, t02),
      accept(b1SecondConn, t02),
    ]);
    const t02Winners = t02Attempts.filter(
      (item): item is PromiseFulfilledResult<TaskResult> => item.status === 'fulfilled',
    );
    const t02Losers = t02Attempts.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    check(
      'D02-T02 同人双设备并发接受恰好一个成功',
      t02Winners.length === 1,
      t02Attempts.map((item) =>
        item.status === 'rejected'
          ? item.reason instanceof ToolError
            ? { code: item.reason.code, details: item.reason.body.details }
            : String(item.reason)
          : 'ok',
      ),
    );
    checkEqual('D02-T02 另一设备接受失败', t02Losers.length, 1);
    check(
      'D02-T02 失败设备返回版本/assignment 冲突',
      CONFLICT_CODES.has(errorCode(t02Losers[0]?.reason)),
      errorCode(t02Losers[0]?.reason),
    );
    const t02Accepted = await getTask(u1Conn, t02.task_id);
    checkEqual('D02-T02 最终状态为 in_progress', t02Accepted.status, 'in_progress');
    checkEqual('D02-T02 负责人为 B1', t02Accepted.owner_actor_id, b1.actor_id);
    checkEqual('D02-T02 只有一个当前 assignment', t02Accepted.assignment?.assignment_version, 1);
    checkEqual('D02-T02 assignment 状态为 active', t02Accepted.assignment?.status, 'active');
    checkEqual('D02-T02 接受只推进一次 revision', t02Accepted.revision, t02.revision + 1);
    checkEqual(
      'D02-T02 失败设备读取到真实负责人',
      (await getTask(b1SecondConn, t02.task_id)).owner_actor_id,
      b1.actor_id,
    );

    // 旧 offer 再接受失败：B2 拒绝后任务重新指派给 B1，B2 的旧 assignment 失效。
    const oldOfferTask = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D02-T02 旧 offer 失效',
      reviewer_actor_id: u1.actor_id,
    });
    const oldOffer = await offer(u1Conn, oldOfferTask, b2.actor_id);
    const declined = (await decline(b2Conn, oldOffer, '先不接这个任务')).task;
    checkEqual('D02-T02 拒绝后任务回到 unassigned', declined.status, 'unassigned');
    checkEqual('D02-T02 拒绝后没有当前 assignment', declined.assignment, null);
    checkEqual('D02-T02 拒绝不自动指派其他成员', declined.owner_actor_id, null);
    const reoffered = await offer(u1Conn, declined, b1.actor_id);
    checkEqual('D02-T02 重新指派生成新 assignment', reoffered.assignment?.assignment_version, 2);
    await expectToolError(
      'D02-T02 旧 offer 再接受返回 ASSIGNMENT_STALE',
      accept(b2Conn, oldOffer),
      'ASSIGNMENT_STALE',
    );
    const afterOldAccept = await getTask(u1Conn, oldOfferTask.task_id);
    checkEqual('D02-T02 旧 offer 失败不覆盖新指派', afterOldAccept.assignment?.owner_actor_id, b1.actor_id);
    checkEqual('D02-T02 旧 offer 失败后仍为 offered', afterOldAccept.status, 'offered');

    // ---------- D02-T03：拒绝/取消/接受并发只有一种合法状态 ----------
    const t03 = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D02-T03 三路竞争',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const t03Attempts = await Promise.allSettled([
      accept(b1Conn, t03),
      decline(b1Conn, t03, '并发拒绝'),
      cancel(u1Conn, t03, '并发取消'),
    ]);
    const t03Winners = t03Attempts.filter((item) => item.status === 'fulfilled');
    checkEqual('D02-T03 接受/拒绝/取消恰好一个成功', t03Winners.length, 1);
    checkEqual('D02-T03 其余两路失败', t03Attempts.length - t03Winners.length, 2);
    const t03Final = await getTask(u1Conn, t03.task_id);
    check(
      'D02-T03 终态只可能是 in_progress/unassigned/cancelled',
      ['in_progress', 'unassigned', 'cancelled'].includes(t03Final.status),
      t03Final.status,
    );
    check(
      'D02-T03 终态与成功操作一致',
      (t03Final.status === 'in_progress' && t03Final.owner_actor_id === b1.actor_id) ||
        (t03Final.status === 'unassigned' && t03Final.owner_actor_id === null) ||
        (t03Final.status === 'cancelled' && t03Final.owner_actor_id === null),
      t03Final,
    );
    if (t03Final.status === 'in_progress') {
      await cancel(u1Conn, t03Final, 'D02-T03 清理');
    }

    // delivery claim/complete 只表示通知处理，不改变业务任务状态。
    const notifyTask = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D02-T03 通知完成不等于验收',
      assignee_actor_id: b2.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const notifyDeliveryId = notifyTask.delivery_ids[0];
    check('D02-T03 指派 Agent 生成 delivery', Boolean(notifyDeliveryId));
    const b2PendingBefore = (await inbox(b2Conn, 'pending')).pending_count;
    const notifyClaim = await callTool<DeliveryView>(b2Conn.client, 'network_delivery_claim', {
      request_id: newRequestId('d02_delivery_claim'),
      delivery_id: notifyDeliveryId,
    });
    checkEqual('D02-T03 delivery 进入 claimed', notifyClaim.state, 'claimed');
    checkEqual(
      'D02-T03 仅 claim delivery 不改变任务状态',
      (await getTask(u1Conn, notifyTask.task_id)).status,
      'offered',
    );
    await callTool(b2Conn.client, 'network_delivery_complete', {
      request_id: newRequestId('d02_delivery_complete'),
      delivery_id: notifyDeliveryId,
      attempt: notifyClaim.attempt,
      claim_id: notifyClaim.claim_id,
      final_body: '已收到接手请求，等待确认。',
      client_message_id: `d02_notice_${crypto.randomUUID()}`,
    });
    const afterNotify = await getTask(u1Conn, notifyTask.task_id);
    checkEqual('D02-T03 通知完成不自动接单', afterNotify.status, 'offered');
    checkEqual('D02-T03 通知完成不伪造 owner', afterNotify.owner_actor_id, null);
    checkEqual('D02-T03 通知完成不进入 accepted', afterNotify.status === 'accepted', false);
    const notifyAccepted = (await accept(b2Conn, notifyTask)).task;
    checkEqual('D02-T03 显式接受才进入 in_progress', notifyAccepted.status, 'in_progress');
    checkEqual('D02-T03 接受不是验收终态', notifyAccepted.status === 'accepted', false);
    checkEqual(
      'D02-T03 claim 减少一次 pending_count',
      (await inbox(b2Conn, 'pending')).pending_count,
      b2PendingBefore - 1,
    );
    await cancel(u1Conn, notifyAccepted, 'D02-T03 清理通知任务');

    // ---------- D02-T04：revision CAS 与 owner/reviewer 规则 ----------
    const t04 = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D02-T04 迟到领取',
      reviewer_actor_id: u3.actor_id,
    });
    const t04Offered = await offer(u1Conn, t04, b1.actor_id);
    await expectToolError(
      'D02-T04 基于旧 revision 的领取返回 VERSION_CONFLICT',
      claim(u2Conn, t04, t04.revision),
      'VERSION_CONFLICT',
    );
    const t04AfterStale = await getTask(u1Conn, t04.task_id);
    checkEqual('D02-T04 迟到领取不覆盖新指派', t04AfterStale.assignment?.owner_actor_id, b1.actor_id);
    checkEqual('D02-T04 迟到领取后仍为 offered', t04AfterStale.status, 'offered');

    await expectToolError(
      'D02-T04 非候选者接受返回 PERMISSION_DENIED',
      accept(b2Conn, t04Offered),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'D02-T04 非候选者拒绝返回 PERMISSION_DENIED',
      decline(b2Conn, t04Offered),
      'PERMISSION_DENIED',
    );
    check(
      'D02-T04 非候选者不能改变 owner',
      (await getTask(u1Conn, t04Offered.task_id)).owner_actor_id === null,
    );

    const reviewerTask = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D02-T04 验收人不能领取',
      reviewer_actor_id: u3.actor_id,
    });
    await expectToolError(
      'D02-T04 不能被指派为验收人自己的任务',
      callTool(u1Conn.client, 'network_task_offer', {
        request_id: newRequestId('d02_offer_reviewer'),
        task_id: reviewerTask.task_id,
        assignee_actor_id: u3.actor_id,
        expected_revision: reviewerTask.revision,
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      'D02-T04 验收人领取自己验收的公开任务被拒',
      claim(u3Conn, reviewerTask),
      'PERMISSION_DENIED',
    );
    checkEqual(
      'D02-T04 验收人领取失败后任务仍可被他人领取',
      (await getTask(u1Conn, reviewerTask.task_id)).status,
      'unassigned',
    );

    console.log('D02 接单拒单验收通过');
  } finally {
    await Promise.all(extraConnections.map((connection) => connection.close().catch(() => undefined)));
    await Promise.all([
      u1Conn.close(),
      u2Conn.close(),
      u3Conn.close(),
      b1Conn.close(),
      b2Conn.close(),
    ]);
  }
}

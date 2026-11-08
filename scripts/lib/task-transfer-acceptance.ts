/**
 * D04 任务交接与接任确认验收（D04-T01..T04）。
 *
 * 只通过公开 MCP 工具验证实时语义；另用内存 SQLite 与真实 migrations
 * 模拟 D06 提交成果时调用 `cancelPendingTransfersForTask`，以及 24 小时
 * 过期路径——这两条无法在实时验收里等待或直接调用。
 *
 * 覆盖：
 * - D04-T01 提议不转移责任、拒绝/接受、旧负责人失权、旧投递关闭；
 * - D04-T02 接受与取消/退群/移除/停用并发，只留下合法终态；
 * - D04-T03 旧 revision、旧 assignment_version、旧 attempt、迟到重试被拒；
 * - D04-T04 重复接受同一提议不递增版本、不生成新派活。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import type { McpSubscription } from '@modelcontextprotocol/client';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { BusinessError } from '../../src/contracts/errors';
import type { Principal } from '../../src/domain/principal';
import { taskAccept, taskCreate } from '../../src/domain/tasks';
import {
  cancelPendingTransfersForTask,
  taskTransferAccept,
  taskTransferList,
  taskTransferPropose,
} from '../../src/domain/task-transfers';
import type { ActorRow } from '../../src/storage/rows';
import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  sleep,
  ToolError,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  acceptGroupInvitesWithToken,
  befriend,
  inbox,
  registerIdentity,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';
const MIGRATIONS = join(import.meta.dir, '../../migrations');

type TransferStatus = 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';

interface TaskAssignmentView {
  assignment_id: string;
  assignment_version: number;
  owner_actor_id: string;
  status: string;
}

interface TaskView {
  task_id: string;
  room_id: string;
  title: string;
  status: string;
  revision: number;
  owner_actor_id: string | null;
  reviewer_actor_id: string;
  blocked_reason: string | null;
  assignment: TaskAssignmentView | null;
  delivery_ids: string[];
  can_report_progress: boolean;
  can_block: boolean;
  can_resume: boolean;
}

interface TaskResult {
  task: TaskView;
}

interface TransferView {
  transfer_id: string;
  task_id: string;
  status: TransferStatus;
  effective_status: TransferStatus;
  from_assignment_id: string | null;
  from_assignment_version: number | null;
  from_owner_actor_id: string | null;
  to_actor_id: string;
  requested_by: string;
  expires_at: string;
  responded_at: string | null;
  responded_by: string | null;
  context_ready: boolean;
  note: string | null;
  can_accept: boolean;
  can_reject: boolean;
  can_cancel: boolean;
}

interface TransferResult {
  transfer: TransferView;
  task: TaskView;
}

interface TransferList {
  transfers: TransferView[];
}

interface AgentCreateView {
  actor_id: string;
  token: string;
}

interface DeliveryView {
  delivery_id: string;
  state: string;
}

interface InboxPage {
  items: DeliveryView[];
  pending_count: number;
}

interface StreamItemView {
  source?: string;
  attention?: string;
  task_id?: string;
  change?: string;
  status?: string;
  revision?: number;
}

type Collector = ReturnType<typeof notificationCollector>;

function streamItems(collector: Collector, from: number): StreamItemView[] {
  const items: StreamItemView[] = [];
  for (const event of collector.events.slice(from)) {
    if (event.params.uri !== STREAM_URI) continue;
    const meta = event.params._meta as Record<string, unknown> | undefined;
    const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
    if (payload?.items) items.push(...payload.items);
  }
  return items;
}

async function waitForStreamItem(
  collector: Collector,
  from: number,
  predicate: (item: StreamItemView) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<StreamItemView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = streamItems(collector, from).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`${label}: 等待 stream item 超时`);
    await sleep(100);
  }
}

async function getTask(connection: McpConnection, taskId: string): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_get', { task_id: taskId })
  ).task;
}

async function createTask(
  connection: McpConnection,
  args: Record<string, unknown>,
): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_create', {
      request_id: newRequestId('d04_create'),
      ...args,
    })
  ).task;
}

async function acceptOffer(
  connection: McpConnection,
  task: TaskView,
): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_accept', {
      request_id: newRequestId('d04_accept_offer'),
      task_id: task.task_id,
      ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
      expected_revision: task.revision,
    })
  ).task;
}

async function createOwnedTask(
  creatorConn: McpConnection,
  assigneeConn: McpConnection,
  roomId: string,
  title: string,
  assignee: string,
  creator: string,
): Promise<TaskView> {
  const offered = await createTask(creatorConn, {
    room_id: roomId,
    title,
    assignee_actor_id: assignee,
    reviewer_actor_id: creator,
  });
  return acceptOffer(assigneeConn, offered);
}

function propose(
  connection: McpConnection,
  task: TaskView,
  toActorId: string,
  options: {
    requestId?: string;
    note?: string;
    expectedRevision?: number;
    assignmentId?: string;
    assignmentVersion?: number;
  } = {},
): Promise<TransferResult> {
  return callTool<TransferResult>(connection.client, 'network_task_transfer_propose', {
    request_id: options.requestId ?? newRequestId('d04_propose'),
    task_id: task.task_id,
    to_actor_id: toActorId,
    ...(options.note === undefined ? {} : { note: options.note }),
    expected_revision: options.expectedRevision ?? task.revision,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    ...(task.assignment ? { assignment_version: task.assignment.assignment_version } : {}),
    ...(options.assignmentId === undefined ? {} : { assignment_id: options.assignmentId }),
    ...(options.assignmentVersion === undefined
      ? {}
      : { assignment_version: options.assignmentVersion }),
  });
}

function acceptTransfer(
  connection: McpConnection,
  transfer: TransferView,
  options: {
    requestId?: string;
    expectedRevision?: number;
    fromAssignmentVersion?: number;
  } = {},
): Promise<TransferResult> {
  return callTool<TransferResult>(connection.client, 'network_task_transfer_accept', {
    request_id: options.requestId ?? newRequestId('d04_accept_transfer'),
    transfer_id: transfer.transfer_id,
    ...(options.expectedRevision === undefined
      ? {}
      : { expected_revision: options.expectedRevision }),
    ...(options.fromAssignmentVersion === undefined
      ? {}
      : { from_assignment_version: options.fromAssignmentVersion }),
  });
}

function rejectTransfer(
  connection: McpConnection,
  transfer: TransferView,
  reason?: string,
): Promise<TransferResult> {
  return callTool<TransferResult>(connection.client, 'network_task_transfer_reject', {
    request_id: newRequestId('d04_reject_transfer'),
    transfer_id: transfer.transfer_id,
    ...(reason ? { reason } : {}),
  });
}

function cancelTransfer(
  connection: McpConnection,
  transfer: TransferView,
  reason?: string,
): Promise<TransferResult> {
  return callTool<TransferResult>(connection.client, 'network_task_transfer_cancel', {
    request_id: newRequestId('d04_cancel_transfer'),
    transfer_id: transfer.transfer_id,
    ...(reason ? { reason } : {}),
  });
}

async function listTransfers(
  connection: McpConnection,
  args: Record<string, unknown>,
): Promise<TransferList> {
  return callTool<TransferList>(connection.client, 'network_task_transfer_list', args);
}

function reportProgress(
  connection: McpConnection,
  task: TaskView,
  note: string,
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_progress', {
    request_id: newRequestId('d04_progress'),
    task_id: task.task_id,
    note,
    expected_revision: task.revision,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    ...(task.assignment ? { assignment_version: task.assignment.assignment_version } : {}),
  });
}

function blockTask(
  connection: McpConnection,
  task: TaskView,
  reason: string,
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_block', {
    request_id: newRequestId('d04_block'),
    task_id: task.task_id,
    reason,
    expected_revision: task.revision,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    ...(task.assignment ? { assignment_version: task.assignment.assignment_version } : {}),
  });
}

function cancelTask(
  connection: McpConnection,
  task: TaskView,
  reason: string,
  expectedRevision: number | null = task.revision,
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_cancel', {
    request_id: newRequestId('d04_cancel_task'),
    task_id: task.task_id,
    reason,
    ...(expectedRevision === null ? {} : { expected_revision: expectedRevision }),
  });
}

function leaveRoom(
  connection: McpConnection,
  roomId: string,
): Promise<{ room_id: string; left: true }> {
  return callTool<{ room_id: string; left: true }>(connection.client, 'network_room_leave', {
    request_id: newRequestId('d04_leave'),
    room_id: roomId,
    confirm_in_flight: true,
  });
}

function removeMember(
  connection: McpConnection,
  roomId: string,
  actorId: string,
): Promise<RoomDetail> {
  return callTool<RoomDetail>(connection.client, 'network_room_members_update', {
    request_id: newRequestId('d04_remove'),
    room_id: roomId,
    remove: [actorId],
  });
}

function errorCode(reason: unknown): string | undefined {
  return reason instanceof ToolError ? reason.code : undefined;
}

function pendingTransferOrThrow(result: TransferResult, label: string): TransferView {
  checkEqual(`${label} 提议状态为 pending`, result.transfer.status, 'pending');
  checkEqual(`${label} 提议未过期`, result.transfer.effective_status, 'pending');
  return result.transfer;
}

// ---------------------------------------------------------------------------
// 内存 SQLite：模拟 D06 submit 失效 pending 交接与 24 小时过期。
// ---------------------------------------------------------------------------

const UNIT_OWNER = 'usr_d04_unit_owner';
const UNIT_EXEC = 'agt_d04_unit_exec';
const UNIT_TARGET = 'agt_d04_unit_target';
const UNIT_ROOM = 'rm_d04_unit';
const UNIT_AT = 1_700_000_000_000;

function principalFor(db: Database, actorId: string): Principal {
  const row = db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actorId) as ActorRow;
  return {
    credentialHash: `d04:${actorId}`,
    actor: row,
    credential: {
      credential_id: `cred_${actorId}`,
      actor_id: actorId,
      device_id: `dev_${actorId}`,
      token_hash: `hash_${actorId}`,
      revoked_at: null,
      created_at: 1,
      last_used_at: null,
      revoked_by: null,
      label: null,
    },
  };
}

function unitDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${UNIT_OWNER}', 'human', NULL, 'D04 Unit Owner', '{}', 0, 0, 0, ${UNIT_AT}, ${UNIT_AT}),
      ('${UNIT_EXEC}', 'agent', 'sess_d04_unit_exec', 'D04 Unit Exec', '{}', 0, 0, 0, ${UNIT_AT}, ${UNIT_AT}),
      ('${UNIT_TARGET}', 'agent', 'sess_d04_unit_target', 'D04 Unit Target', '{}', 0, 0, 0, ${UNIT_AT}, ${UNIT_AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
       member_seq, last_message_id, created_at, updated_at)
    VALUES ('${UNIT_ROOM}', 'group', '${UNIT_OWNER}', 'D04 Unit Room', NULL, 0, 0, 0, NULL,
            ${UNIT_AT}, ${UNIT_AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
    VALUES
      ('${UNIT_ROOM}', '${UNIT_OWNER}', 'owner', 'active', 0, 0, ${UNIT_AT}),
      ('${UNIT_ROOM}', '${UNIT_EXEC}', 'member', 'active', 0, 0, ${UNIT_AT}),
      ('${UNIT_ROOM}', '${UNIT_TARGET}', 'member', 'active', 0, 0, ${UNIT_AT});
  `);
  return db;
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

async function runTransferUnitChecks(): Promise<void> {
  console.log('  D04-UNIT 提交失效与过期路径');
  const db = unitDb();
  const d1 = createD1(db);
  const owner = principalFor(db, UNIT_OWNER);
  const exec = principalFor(db, UNIT_EXEC);
  const target = principalFor(db, UNIT_TARGET);

  const created = await taskCreate(d1, owner, {
    request_id: newRequestId('unit_create'),
    room_id: UNIT_ROOM,
    title: 'D04 单元任务',
    assignee_actor_id: UNIT_EXEC,
    reviewer_actor_id: UNIT_OWNER,
  });
  const accepted = await taskAccept(d1, exec, {
    request_id: newRequestId('unit_accept'),
    task_id: created.task.task_id,
    assignment_id: created.task.assignment?.assignment_id,
    expected_revision: created.task.revision,
  });
  checkEqual('D04-UNIT 任务进入 in_progress', accepted.task.status, 'in_progress');
  check('D04-UNIT 旧负责人持有 active assignment', Boolean(accepted.task.assignment));

  const proposed = await taskTransferPropose(d1, exec, {
    request_id: newRequestId('unit_propose'),
    task_id: accepted.task.task_id,
    to_actor_id: UNIT_TARGET,
    expected_revision: accepted.task.revision,
    assignment_id: accepted.task.assignment?.assignment_id,
    assignment_version: accepted.task.assignment?.assignment_version,
  });
  const pending = pendingTransferOrThrow(proposed, 'D04-UNIT 提交前');
  checkEqual('D04-UNIT 提议不改变任务负责人', proposed.task.owner_actor_id, UNIT_EXEC);

  // D06 submit 将展开这些语句：pending 提议取消，任务与 assignment 不变。
  const statements = await cancelPendingTransfersForTask(d1, {
    taskId: accepted.task.task_id,
    actor: UNIT_EXEC,
    requestId: newRequestId('unit_submit'),
    at: Date.now(),
    reason: '成果已提交',
  });
  await d1.batch(statements);
  const afterSubmit = await d1
    .prepare('SELECT * FROM tasks WHERE task_id = ?')
    .bind(accepted.task.task_id)
    .first<{ owner_actor_id: string; revision: number }>();
  checkEqual('D04-UNIT 提交失效后负责人不变', afterSubmit?.owner_actor_id, UNIT_EXEC);
  checkEqual('D04-UNIT 提交失效不递增任务 revision', afterSubmit?.revision, accepted.task.revision);
  const submittedList = await taskTransferList(d1, target, {
    task_id: accepted.task.task_id,
    status: 'cancelled',
  });
  checkEqual('D04-UNIT 提交把 pending 提议置为 cancelled', submittedList.transfers.length, 1);
  const submittedRow = await d1
    .prepare("SELECT status, context_json FROM task_transfers WHERE transfer_id = ?")
    .bind(pending.transfer_id)
    .first<{ status: string; context_json: string }>();
  checkEqual('D04-UNIT 取消行状态为 cancelled', submittedRow?.status, 'cancelled');
  check(
    'D04-UNIT 取消原因记录为提交失效',
    String(submittedRow?.context_json ?? '').includes('invalidated_by'),
    submittedRow?.context_json,
  );
  await expectBusinessError(
    'D04-UNIT 已取消提议不能接受',
    taskTransferAccept(d1, target, {
      request_id: newRequestId('unit_accept_cancelled'),
      transfer_id: pending.transfer_id,
    }),
    'CONFLICT',
  );

  // 过期：再次提议后把 expires_at 拨到过去，接受必须失败且不改任务。
  const reproposed = await taskTransferPropose(d1, exec, {
    request_id: newRequestId('unit_repropose'),
    task_id: accepted.task.task_id,
    to_actor_id: UNIT_TARGET,
    expected_revision: accepted.task.revision,
    assignment_id: accepted.task.assignment?.assignment_id,
    assignment_version: accepted.task.assignment?.assignment_version,
  });
  await d1
    .prepare('UPDATE task_transfers SET expires_at = ? WHERE transfer_id = ?')
    .bind(Date.now() - 1_000, reproposed.transfer.transfer_id)
    .run();
  const expiredList = await taskTransferList(d1, target, {
    task_id: accepted.task.task_id,
    status: 'expired',
  });
  checkEqual(
    'D04-UNIT 过期提议按 expired 返回',
    expiredList.transfers[0]?.effective_status,
    'expired',
  );
  await expectBusinessError(
    'D04-UNIT 过期接受返回 REQUEST_EXPIRED',
    taskTransferAccept(d1, target, {
      request_id: newRequestId('unit_accept_expired'),
      transfer_id: reproposed.transfer.transfer_id,
    }),
    'REQUEST_EXPIRED',
  );
  const afterExpired = await d1
    .prepare('SELECT owner_actor_id, revision FROM tasks WHERE task_id = ?')
    .bind(accepted.task.task_id)
    .first<{ owner_actor_id: string; revision: number }>();
  checkEqual('D04-UNIT 过期后原负责人仍负责', afterExpired?.owner_actor_id, UNIT_EXEC);
  checkEqual('D04-UNIT 过期不递增任务 revision', afterExpired?.revision, accepted.task.revision);

  // 新提议覆盖已过期行，接受后 assignment_version 严格递增。
  const third = await taskTransferPropose(d1, exec, {
    request_id: newRequestId('unit_third'),
    task_id: accepted.task.task_id,
    to_actor_id: UNIT_TARGET,
    expected_revision: accepted.task.revision,
    assignment_id: accepted.task.assignment?.assignment_id,
    assignment_version: accepted.task.assignment?.assignment_version,
  });
  const acceptedTransfer = await taskTransferAccept(d1, target, {
    request_id: newRequestId('unit_accept_third'),
    transfer_id: third.transfer.transfer_id,
    expected_revision: accepted.task.revision,
    from_assignment_version: accepted.task.assignment?.assignment_version,
  });
  checkEqual('D04-UNIT 接受后负责人为目标', acceptedTransfer.task.owner_actor_id, UNIT_TARGET);
  checkEqual(
    'D04-UNIT 新 assignment_version = 旧版本 + 1',
    acceptedTransfer.task.assignment?.assignment_version,
    (accepted.task.assignment?.assignment_version ?? 0) + 1,
  );
  const duplicate = await taskTransferAccept(d1, target, {
    request_id: newRequestId('unit_accept_duplicate'),
    transfer_id: third.transfer.transfer_id,
  });
  checkEqual(
    'D04-UNIT 重复接受不递增任务 revision',
    duplicate.task.revision,
    acceptedTransfer.task.revision,
  );
  checkEqual(
    'D04-UNIT 重复接受不换 assignment',
    duplicate.task.assignment?.assignment_id,
    acceptedTransfer.task.assignment?.assignment_id,
  );
}

// ---------------------------------------------------------------------------
// 实时 MCP 验收。
// ---------------------------------------------------------------------------

export async function runTaskTransferAcceptance(): Promise<void> {
  console.log('· D04 任务交接与接任确认');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const b1Conn = await connectClient(newToken());
  const b2Conn = await connectClient(newToken());
  const b3Conn = await connectClient(newToken());
  const extraConnections: McpConnection[] = [];
  const subscriptions: McpSubscription[] = [];

  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'D04 创建者 U1' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'D04 执行者 U2' });
    const b1 = await registerIdentity(b1Conn, {
      kind: 'agent',
      name: 'D04 Agent B1',
      sessionId: `d04_b1_${crypto.randomUUID()}`,
    });
    const b2 = await registerIdentity(b2Conn, {
      kind: 'agent',
      name: 'D04 Agent B2',
      sessionId: `d04_b2_${crypto.randomUUID()}`,
    });
    const b3 = await registerIdentity(b3Conn, {
      kind: 'agent',
      name: 'D04 Agent B3',
      sessionId: `d04_b3_${crypto.randomUUID()}`,
    });

    const b4Created = await callTool<AgentCreateView>(u1Conn.client, 'network_agent_create', {
      request_id: newRequestId('d04_b4'),
      name: 'D04 Agent B4 被移除',
    });
    const b5Created = await callTool<AgentCreateView>(u1Conn.client, 'network_agent_create', {
      request_id: newRequestId('d04_b5'),
      name: 'D04 Agent B5 被停用',
    });
    const b4Conn = await connectClient(b4Created.token);
    const b5Conn = await connectClient(b5Created.token);
    extraConnections.push(b4Conn, b5Conn);

    check(
      'D04 身份注册成功',
      Boolean(
        u1.actor_id &&
          u2.actor_id &&
          b1.actor_id &&
          b2.actor_id &&
          b3.actor_id &&
          b4Created.actor_id &&
          b5Created.actor_id,
      ),
    );

    for (const peer of [u2Conn, b1Conn, b2Conn, b3Conn]) {
      const peerId = (await callTool<Identity>(peer.client, 'network_me', {})).actor_id;
      await befriend(u1Conn, u1.actor_id, peer, peerId);
    }
    const group = await callTool<RoomDetail>(u1Conn.client, 'network_room_create', {
      request_id: newRequestId('d04_room'),
      kind: 'group',
      title: 'D04 任务交接验收群',
      members: [
        u2.actor_id,
        b1.actor_id,
        b2.actor_id,
        b3.actor_id,
        b4Created.actor_id,
        b5Created.actor_id,
      ],
    });
    const roomId = group.room.room_id;
    for (const connection of [u2Conn, b1Conn, b2Conn, b3Conn]) {
      await acceptGroupInvites(connection, roomId);
    }
    // 管理者自有 Agent 可能直接 active；即使已 active，也调用一次以覆盖邀请路径。
    await acceptGroupInvitesWithToken(b4Created.token, roomId);
    await acceptGroupInvitesWithToken(b5Created.token, roomId);

    const u1Collector = notificationCollector(u1Conn.client);
    const b1Collector = notificationCollector(b1Conn.client);
    subscriptions.push(await openSubscription(u1Conn.client, [STREAM_URI]));
    subscriptions.push(await openSubscription(b1Conn.client, [STREAM_URI]));
    await callTool(b1Conn.client, 'network_login', {});
    await sleep(200);

    // ---------- D04-T01：提议不转移责任，拒绝/接受与旧负责人失权 ----------
    const t01 = await createOwnedTask(
      u1Conn,
      u2Conn,
      roomId,
      'D04-T01 人类负责人交接',
      u2.actor_id,
      u1.actor_id,
    );
    const t01Revision = t01.revision;
    const t01Proposed = await propose(u2Conn, t01, b1.actor_id, {
      note: 'D04-T01 请接手数据核对',
    });
    const t01Transfer = pendingTransferOrThrow(t01Proposed, 'D04-T01');
    checkEqual('D04-T01 提议后原负责人不变', t01Proposed.task.owner_actor_id, u2.actor_id);
    checkEqual('D04-T01 提议后任务仍为 in_progress', t01Proposed.task.status, 'in_progress');
    checkEqual('D04-T01 提议不递增任务 revision', t01Proposed.task.revision, t01Revision);
    checkEqual('D04-T01 提议目标记录正确', t01Transfer.to_actor_id, b1.actor_id);
    checkEqual('D04-T01 24 小时有效期字段存在', Boolean(t01Transfer.expires_at), true);
    checkEqual('D04-T01 上下文包未就绪', t01Transfer.context_ready, false);
    checkEqual('D04-T01 发起人视角不能自行接受', t01Transfer.can_accept, false);
    checkEqual('D04-T01 发起人视角可以撤回', t01Transfer.can_cancel, true);

    const t01TargetGet = await callTool<{ transfer: TransferView }>(b1Conn.client, 'network_task_transfer_get', {
      transfer_id: t01Transfer.transfer_id,
    });
    checkEqual('D04-T01 目标可读取提议', t01TargetGet.transfer.transfer_id, t01Transfer.transfer_id);
    checkEqual('D04-T01 目标读取到 can_accept', t01TargetGet.transfer.can_accept, true);
    const t01TargetList = await listTransfers(b1Conn, { task_id: t01.task_id });
    check(
      'D04-T01 目标能在任务维度列表看到待处理提议',
      t01TargetList.transfers.some((item) => item.transfer_id === t01Transfer.transfer_id),
      t01TargetList.transfers,
    );
    const t01ProposerGet = await callTool<{ transfer: TransferView }>(u2Conn.client, 'network_task_transfer_get', {
      transfer_id: t01Transfer.transfer_id,
    });
    checkEqual('D04-T01 提议人可撤回', t01ProposerGet.transfer.can_cancel, true);
    checkEqual('D04-T01 提议人不能接受', t01ProposerGet.transfer.can_accept, false);

    const t01StreamStart = u1Collector.events.length;
    const t01Rejected = await rejectTransfer(b1Conn, t01Transfer, '当前排期不允许');
    checkEqual('D04-T01 拒绝后提议为 rejected', t01Rejected.transfer.status, 'rejected');
    checkEqual('D04-T01 拒绝后负责人仍是 U2', t01Rejected.task.owner_actor_id, u2.actor_id);
    checkEqual('D04-T01 拒绝后任务 revision 不变', t01Rejected.task.revision, t01Revision);
    checkEqual('D04-T01 拒绝后 assignment 版本不变', t01Rejected.task.assignment?.assignment_version, 1);
    const t01AfterRejectTask = await getTask(u2Conn, t01.task_id);
    const t01ProgressAfterReject = await reportProgress(
      u2Conn,
      t01AfterRejectTask,
      'D04-T01 拒绝后原负责人继续执行',
    );
    checkEqual(
      'D04-T01 拒绝后原负责人仍可写进度',
      t01ProgressAfterReject.task.owner_actor_id,
      u2.actor_id,
    );
    const t01TransferEvent = await waitForStreamItem(
      u1Collector,
      t01StreamStart,
      (item) => item.task_id === t01.task_id && item.change === 'transfer_rejected',
      'D04-T01 拒绝事件',
    );
    checkEqual('D04-T01 交接事件为 informational', t01TransferEvent.attention, 'informational');
    checkEqual('D04-T01 交接事件来源为 task.updated', t01TransferEvent.source, 'task.updated');
    const b1TaskEvents = streamItems(b1Collector, 0).filter(
      (item) => item.task_id === t01.task_id && item.source === 'task.updated',
    );
    checkEqual('D04-T01 Agent 不接收 task.updated 交接事件', b1TaskEvents.length, 0);

    const t01RetryTask = await getTask(u2Conn, t01.task_id);
    const t01SecondProposal = await propose(u2Conn, t01RetryTask, b1.actor_id);
    const t01SecondTransfer = pendingTransferOrThrow(t01SecondProposal, 'D04-T01 第二次');
    await expectToolError(
      'D04-T01 非目标不能接受交接',
      acceptTransfer(u2Conn, t01SecondTransfer),
      'PERMISSION_DENIED',
    );
    const t01Accepted = await acceptTransfer(b1Conn, t01SecondTransfer, {
      expectedRevision: t01SecondProposal.task.revision,
      fromAssignmentVersion: t01SecondTransfer.from_assignment_version ?? undefined,
    });
    checkEqual('D04-T01 接受后负责人为 B1', t01Accepted.task.owner_actor_id, b1.actor_id);
    checkEqual('D04-T01 接受后仍为 in_progress', t01Accepted.task.status, 'in_progress');
    checkEqual(
      'D04-T01 接受后 assignment_version 递增',
      t01Accepted.task.assignment?.assignment_version,
      (t01SecondTransfer.from_assignment_version ?? 0) + 1,
    );
    check(
      'D04-T01 接受后生成新 assignment',
      Boolean(
        t01Accepted.task.assignment &&
          t01Accepted.task.assignment.assignment_id !== t01SecondTransfer.from_assignment_id,
      ),
      t01Accepted.task.assignment,
    );
    checkEqual('D04-T01 接受后提议为 accepted', t01Accepted.transfer.status, 'accepted');
    const t01NewOwner = await getTask(b1Conn, t01.task_id);
    await reportProgress(b1Conn, t01NewOwner, 'D04-T01 新负责人接续');
    const t01StaleProgress = await expectToolError(
      'D04-T01 旧负责人写进度返回 ASSIGNMENT_STALE',
      reportProgress(u2Conn, t01NewOwner, '旧负责人尝试写入'),
      'ASSIGNMENT_STALE',
    );
    check(
      'D04-T01 旧负责人错误详情携带真实负责人',
      String(JSON.stringify(t01StaleProgress.body.details ?? {})).includes(b1.actor_id),
      t01StaleProgress.body.details,
    );
    await expectToolError(
      'D04-T01 旧负责人报告阻塞返回 ASSIGNMENT_STALE',
      blockTask(u2Conn, t01NewOwner, '旧负责人尝试阻塞'),
      'ASSIGNMENT_STALE',
    );
    await expectToolError(
      'D04-T01 旧负责人再次发起交接返回 ASSIGNMENT_STALE',
      propose(u2Conn, t01NewOwner, b2.actor_id),
      'ASSIGNMENT_STALE',
    );
    await expectToolError(
      'D04-T01 旧 assignment 不能再被接受',
      callTool(u2Conn.client, 'network_task_accept', {
        request_id: newRequestId('d04_old_offer'),
        task_id: t01.task_id,
        assignment_id: t01SecondTransfer.from_assignment_id,
        expected_revision: t01NewOwner.revision,
      }),
      'ASSIGNMENT_STALE',
    );

    // Agent 旧负责人：接受交接会关闭旧 assignment 的待处理 delivery。
    const t01b = await createOwnedTask(
      u1Conn,
      b2Conn,
      roomId,
      'D04-T01 Agent 负责人交接',
      b2.actor_id,
      u1.actor_id,
    );
    check('D04-T01 Agent 接单生成 delivery', t01b.delivery_ids.length > 0, t01b.delivery_ids);
    const t01bDeliveryId = t01b.delivery_ids[0] ?? '';
    const t01bInboxBefore = await inbox(b2Conn, 'pending');
    const t01bPendingBefore = t01bInboxBefore.pending_count;
    const t01bProposed = await propose(b2Conn, t01b, b1.actor_id);
    const t01bTransfer = pendingTransferOrThrow(t01bProposed, 'D04-T01 Agent');
    const t01bAccepted = await acceptTransfer(b1Conn, t01bTransfer, {
      expectedRevision: t01bProposed.task.revision,
      fromAssignmentVersion: t01bTransfer.from_assignment_version ?? undefined,
    });
    checkEqual('D04-T01 Agent 交接接受成功', t01bAccepted.task.owner_actor_id, b1.actor_id);
    const t01bInboxAfter = await inbox(b2Conn, 'pending');
    check(
      'D04-T01 pending_count 只减少旧 delivery',
      t01bPendingBefore >= 1 && t01bInboxAfter.pending_count === t01bPendingBefore - 1,
      { before: t01bPendingBefore, after: t01bInboxAfter.pending_count },
    );
    const t01bDeliveryRow = (await inbox(b2Conn, 'all')).items.find(
      (item) => item.delivery_id === t01bDeliveryId,
    );
    checkEqual('D04-T01 旧 assignment delivery 被取消', t01bDeliveryRow?.state, 'cancelled');

    // ---------- D04-T03：旧版本、旧 attempt 与迟到重试 ----------
    const t03 = await createOwnedTask(
      u1Conn,
      b2Conn,
      roomId,
      'D04-T03 旧版本重试',
      b2.actor_id,
      u1.actor_id,
    );
    const t03Proposed = await propose(b2Conn, t03, b1.actor_id);
    const t03Transfer = pendingTransferOrThrow(t03Proposed, 'D04-T03');
    await expectToolError(
      'D04-T03 不匹配的 assignment_version 接受返回 ASSIGNMENT_STALE',
      acceptTransfer(b1Conn, t03Transfer, {
        fromAssignmentVersion: (t03Transfer.from_assignment_version ?? 1) + 1,
      }),
      'ASSIGNMENT_STALE',
    );
    await expectToolError(
      'D04-T03 旧任务 revision 接受返回 VERSION_CONFLICT',
      acceptTransfer(b1Conn, t03Transfer, {
        expectedRevision: t03Proposed.task.revision - 1,
      }),
      'VERSION_CONFLICT',
    );
    const t03TaskAfterFailures = await getTask(b2Conn, t03.task_id);
    checkEqual('D04-T03 失败接受不改变负责人', t03TaskAfterFailures.owner_actor_id, b2.actor_id);
    checkEqual('D04-T03 失败接受不改变 assignment', t03TaskAfterFailures.assignment?.assignment_version, 1);
    const t03Reject = await rejectTransfer(b1Conn, t03Transfer);
    checkEqual('D04-T03 拒绝关闭提议', t03Reject.transfer.status, 'rejected');
    await expectToolError(
      'D04-T03 已拒绝提议迟到接受返回 CONFLICT',
      acceptTransfer(b1Conn, t03Transfer),
      'CONFLICT',
    );

    // 新增 assignment 后，旧提议不能基于旧执行版本接受。
    const t03Second = await propose(b2Conn, await getTask(b2Conn, t03.task_id), b1.actor_id);
    const t03SecondTransfer = pendingTransferOrThrow(t03Second, 'D04-T03 第二提议');
    const t03SecondAccepted = await acceptTransfer(b1Conn, t03SecondTransfer, {
      expectedRevision: t03Second.task.revision,
      fromAssignmentVersion: t03SecondTransfer.from_assignment_version ?? undefined,
    });
    checkEqual('D04-T03 新提议接受成功', t03SecondAccepted.task.owner_actor_id, b1.actor_id);
    const t03Third = await propose(b1Conn, t03SecondAccepted.task, b2.actor_id);
    const t03ThirdTransfer = pendingTransferOrThrow(t03Third, 'D04-T03 迟到重试');
    await expectToolError(
      'D04-T03 迟到接受使用旧 assignment_version 返回 ASSIGNMENT_STALE',
      acceptTransfer(b2Conn, t03ThirdTransfer, {
        fromAssignmentVersion: t03SecondTransfer.from_assignment_version ?? undefined,
      }),
      'ASSIGNMENT_STALE',
    );
    await expectToolError(
      'D04-T03 旧负责人基于旧 assignment 再次提议返回 ASSIGNMENT_STALE',
      propose(b2Conn, t03SecondAccepted.task, b2.actor_id),
      'ASSIGNMENT_STALE',
    );

    // 拉黑目标时必须在事务前拒绝，不留下 pending 提议。
    const t03Blocked = await createOwnedTask(
      u1Conn,
      u2Conn,
      roomId,
      'D04-T03 拉黑目标',
      u2.actor_id,
      u1.actor_id,
    );
    await callTool(u1Conn.client, 'network_contact_block', {
      request_id: newRequestId('d04_block_target'),
      actor_id: b2.actor_id,
    });
    await expectToolError(
      'D04-T03 创建者与目标拉黑返回 BLOCKED',
      propose(u2Conn, t03Blocked, b2.actor_id),
      'BLOCKED',
    );
    const t03BlockedList = await listTransfers(u2Conn, { task_id: t03Blocked.task_id });
    checkEqual('D04-T03 拉黑失败不留下提议', t03BlockedList.transfers.length, 0);
    await callTool(u1Conn.client, 'network_contact_unblock', {
      request_id: newRequestId('d04_unblock_target'),
      actor_id: b2.actor_id,
    });

    // ---------- D04-T04：重复接受不递增版本或生成新派活 ----------
    const t04 = await createOwnedTask(
      u1Conn,
      b2Conn,
      roomId,
      'D04-T04 重复接受',
      b2.actor_id,
      u1.actor_id,
    );
    const t04Proposed = await propose(b2Conn, t04, b1.actor_id);
    const t04Transfer = pendingTransferOrThrow(t04Proposed, 'D04-T04');
    const t04RequestId = newRequestId('d04_accept_once');
    const t04First = await acceptTransfer(b1Conn, t04Transfer, {
      requestId: t04RequestId,
      expectedRevision: t04Proposed.task.revision,
      fromAssignmentVersion: t04Transfer.from_assignment_version ?? undefined,
    });
    const t04Replay = await acceptTransfer(b1Conn, t04Transfer, {
      requestId: t04RequestId,
      expectedRevision: t04Proposed.task.revision,
      fromAssignmentVersion: t04Transfer.from_assignment_version ?? undefined,
    });
    checkEqual('D04-T04 同 request_id 重放返回同一 revision', t04Replay.task.revision, t04First.task.revision);
    checkEqual('D04-T04 同 request_id 重放返回同一 assignment', t04Replay.task.assignment?.assignment_id, t04First.task.assignment?.assignment_id);
    const t04Second = await acceptTransfer(b1Conn, t04Transfer);
    checkEqual('D04-T04 新 request_id 重复接受不递增 revision', t04Second.task.revision, t04First.task.revision);
    checkEqual(
      'D04-T04 新 request_id 重复接受不递增 assignment_version',
      t04Second.task.assignment?.assignment_version,
      t04First.task.assignment?.assignment_version,
    );
    checkEqual(
      'D04-T04 新 request_id 重复接受不换 assignment',
      t04Second.task.assignment?.assignment_id,
      t04First.task.assignment?.assignment_id,
    );
    checkEqual('D04-T04 重复接受不新增 delivery', t04Second.task.delivery_ids.length, t04First.task.delivery_ids.length);
    checkEqual('D04-T04 重复接受返回 accepted', t04Second.transfer.status, 'accepted');

    // ---------- D04-T02：接受与取消/退群/移除/停用并发 ----------
    // 接受 vs 撤回提议：只能留下“接受并换人”或“撤回且原负责人不变”。
    for (let round = 0; round < 2; round += 1) {
      const task = await createOwnedTask(
        u1Conn,
        b2Conn,
        roomId,
        `D04-T02 接受 vs 撤回 ${round + 1}`,
        b2.actor_id,
        u1.actor_id,
      );
      const proposed = await propose(b2Conn, task, b1.actor_id);
      const transfer = pendingTransferOrThrow(proposed, `D04-T02 撤回 ${round + 1}`);
      const settled = await Promise.allSettled([
        acceptTransfer(b1Conn, transfer, { expectedRevision: proposed.task.revision }),
        cancelTransfer(b2Conn, transfer),
      ]);
      const acceptedOk = settled[0]?.status === 'fulfilled';
      const cancelledOk = settled[1]?.status === 'fulfilled';
      check(
        `D04-T02 接受/撤回至少一个成功（第 ${round + 1} 轮）`,
        acceptedOk || cancelledOk,
        settled.map((item) => (item.status === 'rejected' ? errorCode(item.reason) : 'ok')),
      );
      const actual = await getTask(u1Conn, task.task_id);
      const row = await callTool<{ transfer: TransferView }>(u1Conn.client, 'network_task_transfer_get', {
        transfer_id: transfer.transfer_id,
      });
      if (acceptedOk) {
        checkEqual(`D04-T02 接受成功后负责人为 B1（第 ${round + 1} 轮）`, actual.owner_actor_id, b1.actor_id);
        checkEqual(`D04-T02 接受成功后提议为 accepted（第 ${round + 1} 轮）`, row.transfer.status, 'accepted');
        checkEqual(
          `D04-T02 接受成功只有一个 active assignment（第 ${round + 1} 轮）`,
          actual.assignment?.status,
          'active',
        );
      } else {
        checkEqual(`D04-T02 撤回成功后负责人仍为 B2（第 ${round + 1} 轮）`, actual.owner_actor_id, b2.actor_id);
        checkEqual(`D04-T02 撤回成功后提议为 cancelled（第 ${round + 1} 轮）`, row.transfer.status, 'cancelled');
      }
    }

    // 接受 vs 取消任务：最终只能是 cancelled，或接受后仍被取消。
    {
      const task = await createOwnedTask(
        u1Conn,
        b2Conn,
        roomId,
        'D04-T02 接受 vs 取消任务',
        b2.actor_id,
        u1.actor_id,
      );
      const proposed = await propose(b2Conn, task, b1.actor_id);
      const transfer = pendingTransferOrThrow(proposed, 'D04-T02 取消任务');
      await Promise.allSettled([
        acceptTransfer(b1Conn, transfer, { expectedRevision: proposed.task.revision }),
        cancelTask(u1Conn, task, 'D04-T02 并发取消', null),
      ]);
      const actual = await getTask(u1Conn, task.task_id);
      if (actual.status === 'cancelled') {
        checkEqual('D04-T02 取消先生效时任务为 cancelled', actual.status, 'cancelled');
        checkEqual('D04-T02 取消先生效时没有 active assignment', actual.assignment, null);
        checkEqual('D04-T02 取消先生效时没有负责人', actual.owner_actor_id, null);
      } else {
        checkEqual('D04-T02 接受先生效时任务仍为 in_progress', actual.status, 'in_progress');
        checkEqual('D04-T02 接受先生效时负责人为 B1', actual.owner_actor_id, b1.actor_id);
        checkEqual('D04-T02 接受先生效时 assignment active', actual.assignment?.status, 'active');
      }
    }

    // 接受 vs 目标退群：退群后必须撤销执行资格，任务不得悬空归 B3。
    {
      const task = await createOwnedTask(
        u1Conn,
        b3Conn,
        roomId,
        'D04-T02 接受 vs 退群',
        b3.actor_id,
        u1.actor_id,
      );
      const proposed = await propose(b3Conn, task, b2.actor_id);
      const transfer = pendingTransferOrThrow(proposed, 'D04-T02 退群');
      const settled = await Promise.allSettled([
        acceptTransfer(b2Conn, transfer, { expectedRevision: proposed.task.revision }),
        leaveRoom(b3Conn, roomId),
      ]);
      check(
        'D04-T02 退群成功',
        settled[1]?.status === 'fulfilled',
        settled[1]?.status === 'rejected' ? errorCode(settled[1].reason) : 'ok',
      );
      const actual = await getTask(u1Conn, task.task_id);
      const transferRow = await callTool<{ transfer: TransferView }>(u1Conn.client, 'network_task_transfer_get', {
        transfer_id: transfer.transfer_id,
      });
      if (actual.status === 'blocked') {
        checkEqual('D04-T02 退群先生效时原因为 owner_lost_eligibility', actual.blocked_reason, 'owner_lost_eligibility');
        checkEqual('D04-T02 退群先生效时任务没有负责人', actual.owner_actor_id, null);
        checkEqual('D04-T02 退群先生效时没有 current assignment', actual.assignment, null);
        checkEqual('D04-T02 退群先生效时交接被取消', transferRow.transfer.status, 'cancelled');
      } else {
        checkEqual('D04-T02 接受先生效时任务仍为 in_progress', actual.status, 'in_progress');
        checkEqual('D04-T02 接受先生效时负责人为 B2', actual.owner_actor_id, b2.actor_id);
        checkEqual('D04-T02 接受先生效时 assignment active', actual.assignment?.status, 'active');
        checkEqual('D04-T02 接受先生效时交接为 accepted', transferRow.transfer.status, 'accepted');
      }
      const pending = await listTransfers(u1Conn, { task_id: task.task_id });
      checkEqual('D04-T02 退群后没有待处理交接', pending.transfers.length, 0);
    }

    // 成员被移除：归属任务立即 blocked，pending 交接取消。
    {
      const task = await createOwnedTask(
        u1Conn,
        b4Conn,
        roomId,
        'D04-T02 成员被移除',
        b4Created.actor_id,
        u1.actor_id,
      );
      const proposed = await propose(b4Conn, task, b1.actor_id);
      const transfer = pendingTransferOrThrow(proposed, 'D04-T02 移除');
      await removeMember(u1Conn, roomId, b4Created.actor_id);
      const actual = await getTask(u1Conn, task.task_id);
      checkEqual('D04-T02 移除成员后任务为 blocked', actual.status, 'blocked');
      checkEqual('D04-T02 移除成员后原因为 owner_lost_eligibility', actual.blocked_reason, 'owner_lost_eligibility');
      checkEqual('D04-T02 移除成员后没有负责人', actual.owner_actor_id, null);
      const transferRow = await callTool<{ transfer: TransferView }>(b1Conn.client, 'network_task_transfer_get', {
        transfer_id: transfer.transfer_id,
      });
      checkEqual('D04-T02 移除成员取消 pending 交接', transferRow.transfer.status, 'cancelled');
    }

    // 成员被停用：跨房间撤销执行资格，pending 交接取消。
    {
      const task = await createOwnedTask(
        u1Conn,
        b5Conn,
        roomId,
        'D04-T02 成员被停用',
        b5Created.actor_id,
        u1.actor_id,
      );
      const proposed = await propose(b5Conn, task, b1.actor_id);
      const transfer = pendingTransferOrThrow(proposed, 'D04-T02 停用');
      const disabled = await callTool<{ disabled: boolean; stopped: { open_tasks: { task_id: string }[] } }>(
        u1Conn.client,
        'network_agent_disable',
        {
          request_id: newRequestId('d04_disable'),
          actor_id: b5Created.actor_id,
          reason: 'D04 验收停用',
        },
      );
      checkEqual('D04-T02 停用返回 disabled', disabled.disabled, true);
      check(
        'D04-T02 停用报告未完成任务',
        disabled.stopped.open_tasks.some((item) => item.task_id === task.task_id),
        disabled.stopped.open_tasks,
      );
      const actual = await getTask(u1Conn, task.task_id);
      checkEqual('D04-T02 停用后任务为 blocked', actual.status, 'blocked');
      checkEqual('D04-T02 停用后原因为 owner_lost_eligibility', actual.blocked_reason, 'owner_lost_eligibility');
      checkEqual('D04-T02 停用后没有负责人', actual.owner_actor_id, null);
      const transferRow = await callTool<{ transfer: TransferView }>(b1Conn.client, 'network_task_transfer_get', {
        transfer_id: transfer.transfer_id,
      });
      checkEqual('D04-T02 停用取消 pending 交接', transferRow.transfer.status, 'cancelled');
    }

    // 发起交接后提交成果（D06 未上线）：用内存单元测试模拟。
    await runTransferUnitChecks();

    // 技能正文必须与工具能力一致。
    const skillResource = await u1Conn.client.readResource({
      uri: 'skill://agent-network/agent-network/SKILL.md',
    });
    const skillContent = skillResource.contents?.[0];
    const skillText =
      skillContent && 'text' in skillContent ? String(skillContent.text) : '';
    check(
      'D04 技能正文包含交接工具与不转移责任语义',
      skillText.includes('network_task_transfer_propose') &&
        skillText.includes('network_task_transfer_accept') &&
        skillText.includes('pending 期间原负责人责任不变'),
      skillText.slice(0, 240),
    );
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.close().catch(() => undefined)));
    await Promise.all(extraConnections.map((connection) => connection.close()));
    await Promise.all([
      u1Conn.close(),
      u2Conn.close(),
      b1Conn.close(),
      b2Conn.close(),
      b3Conn.close(),
    ]);
  }
}

/**
 * D05 可授权交接上下文包验收（D05-T01..T03）。
 *
 * 只通过公开 MCP 工具验证实时语义：
 * - D05-T01 版本化交接包；仅凭包可定位目标、当前成果版本、代码引用与下一步；
 *   生成包不改变任务状态、负责人、revision、inbox 待办或房间 head；
 * - D05-T02 跨群私有文件默认未授权、无 URL、目标不可读；源范围负责人显式
 *   授权后目标可读，撤回后 URL 立即失效；必需引用缺失时接任进入
 *   blocked + context_incomplete；
 * - D05-T03 源范围失权后重读包显示 omitted / authorization_source_lost，
 *   旧下载 URL 立即失效。
 *
 * 仓库没有消息撤回功能，T03 用“授权人失去源范围成员资格”表达源撤回；
 * 消息只按 message_id 引用，不伪造 quote anchor（M04 不在本波次）。
 */

import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
  uploadTestFile,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  registerIdentity,
  sendMessage,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

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
}

interface PackFileView {
  file_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  available: boolean;
  public_url: string | null;
  preview_url: string | null;
  download_url: string | null;
}

interface PackItemView {
  item_id: string;
  kind: string;
  ref: string;
  label: string;
  summary: string | null;
  source_room_id: string | null;
  source_scope: 'task_room' | 'external';
  required: boolean;
  authorized: boolean;
  authorized_by_name: string | null;
  revoked_at: string | null;
  status: 'available' | 'missing' | 'omitted';
  reason: string | null;
  verified: boolean;
  file: PackFileView | null;
  message: { message_id: string; created_at: string; preview: string } | null;
  submission: { submission_id: string; version: number; status: string } | null;
}

interface PackGapView {
  item_id: string;
  kind: string;
  ref: string;
  label: string;
  required: boolean;
  status: 'missing' | 'omitted';
  reason: string;
}

interface PackRequestView {
  context_request_id: string;
  requested_by: string;
  requested_by_name: string;
  note: string;
  created_at: string;
}

interface PackView {
  pack_id: string;
  task_id: string;
  room_id: string;
  version: number;
  latest_version: number;
  versions: number[];
  from_assignment_version: number;
  from_owner_actor_id: string | null;
  created_by: string;
  goal: string;
  completed: string[];
  current_result: {
    summary: string;
    submission_id: string | null;
    submission_version: number | null;
    submission_status: string | null;
  };
  unresolved: string[];
  next_steps: string[];
  source_room_id: string | null;
  items: PackItemView[];
  missing: PackGapView[];
  omitted: PackGapView[];
  required_missing: string[];
  context_ready: boolean;
  context_incomplete: boolean;
  viewer_is_successor: boolean;
  can_authorize: boolean;
  can_request_more: boolean;
  requests: PackRequestView[];
}

interface PackResult {
  pack: PackView;
}

interface RequestMoreResult {
  pack: PackView;
  request: PackRequestView;
}

interface TransferView {
  transfer_id: string;
  task_id: string;
  effective_status: string;
  from_assignment_id: string | null;
  from_assignment_version: number | null;
  from_owner_actor_id: string | null;
  to_actor_id: string;
  context_ready: boolean;
  can_accept: boolean;
}

interface TransferResult {
  transfer: TransferView;
  task: TaskView;
}

interface SubmissionView {
  submission_id: string;
  version: number;
  status: string;
}

async function getTask(connection: McpConnection, taskId: string): Promise<TaskView> {
  return (
    await callTool<{ task: TaskView }>(connection.client, 'network_task_get', {
      task_id: taskId,
    })
  ).task;
}

async function createOwnedTask(
  creatorConn: McpConnection,
  assigneeConn: McpConnection,
  roomId: string,
  title: string,
  creator: string,
  assignee: string,
): Promise<TaskView> {
  const offered = await callTool<{ task: TaskView }>(creatorConn.client, 'network_task_create', {
    request_id: newRequestId('d05_create'),
    room_id: roomId,
    title,
    description: 'D05 交接上下文包验收任务',
    acceptance_criteria: '包能定位目标、成果版本、代码引用与下一步',
    assignee_actor_id: assignee,
    reviewer_actor_id: creator,
  });
  return (
    await callTool<{ task: TaskView }>(assigneeConn.client, 'network_task_accept', {
      request_id: newRequestId('d05_accept'),
      task_id: offered.task.task_id,
      ...(offered.task.assignment
        ? { assignment_id: offered.task.assignment.assignment_id }
        : {}),
      expected_revision: offered.task.revision,
    })
  ).task;
}

function assignmentArgs(task: TaskView): Record<string, unknown> {
  if (!task.assignment) return {};
  return {
    assignment_id: task.assignment.assignment_id,
    assignment_version: task.assignment.assignment_version,
  };
}

function createPack(
  connection: McpConnection,
  task: TaskView,
  input: Record<string, unknown>,
): Promise<PackResult> {
  return callTool<PackResult>(connection.client, 'network_task_handoff_pack_create', {
    request_id: newRequestId('d05_pack'),
    task_id: task.task_id,
    ...assignmentArgs(task),
    expected_revision: task.revision,
    ...input,
  });
}

function getPack(
  connection: McpConnection,
  taskId: string,
  options: { packId?: string; version?: number } = {},
): Promise<PackResult> {
  return callTool<PackResult>(connection.client, 'network_task_handoff_pack_get', {
    task_id: taskId,
    ...(options.packId ? { pack_id: options.packId } : {}),
    ...(options.version === undefined ? {} : { version: options.version }),
  });
}

function propose(
  connection: McpConnection,
  task: TaskView,
  toActorId: string,
): Promise<TransferResult> {
  return callTool<TransferResult>(connection.client, 'network_task_transfer_propose', {
    request_id: newRequestId('d05_propose'),
    task_id: task.task_id,
    to_actor_id: toActorId,
    expected_revision: task.revision,
    ...assignmentArgs(task),
  });
}

function acceptTransfer(
  connection: McpConnection,
  transfer: TransferView,
  task: TaskView,
): Promise<TransferResult> {
  return callTool<TransferResult>(connection.client, 'network_task_transfer_accept', {
    request_id: newRequestId('d05_accept_transfer'),
    transfer_id: transfer.transfer_id,
    expected_revision: task.revision,
  });
}

function authorize(
  connection: McpConnection,
  task: TaskView,
  pack: PackView,
  item: PackItemView,
  action: 'grant' | 'revoke',
): Promise<PackResult> {
  return callTool<PackResult>(connection.client, 'network_task_handoff_pack_authorize', {
    request_id: newRequestId('d05_authorize'),
    task_id: task.task_id,
    pack_id: pack.pack_id,
    item_id: item.item_id,
    action,
    ...assignmentArgs(task),
    expected_revision: task.revision,
  });
}

async function fetchStatus(url: string): Promise<number> {
  const response = await fetch(url, { redirect: 'follow' });
  await response.text().catch(() => '');
  return response.status;
}

function itemByRef(pack: PackView, ref: string): PackItemView {
  const item = pack.items.find((candidate) => candidate.ref === ref);
  if (!item) throw new Error(`交接包缺少引用 ${ref}`);
  return item;
}

export async function runTaskHandoffAcceptance(): Promise<void> {
  console.log('· D05 可授权交接上下文包');
  const u1Conn = await connectClient(newToken());
  const b1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());

  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'D05 创建者 U1' });
    const b1 = await registerIdentity(b1Conn, {
      kind: 'agent',
      name: 'D05 Agent B1',
      sessionId: `d05_b1_${crypto.randomUUID()}`,
    });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'D05 接任者 U2' });
    check('D05 身份注册成功', Boolean(u1.actor_id && b1.actor_id && u2.actor_id));

    await befriend(u1Conn, u1.actor_id, u2Conn, u2.actor_id);
    await befriend(u1Conn, u1.actor_id, b1Conn, b1.actor_id);

    const roomA = await callTool<RoomDetail>(u1Conn.client, 'network_room_create', {
      request_id: newRequestId('d05_room_a'),
      kind: 'group',
      title: 'D05 任务房间',
      members: [b1.actor_id, u2.actor_id],
    });
    const taskRoomId = roomA.room.room_id;
    await acceptGroupInvites(b1Conn, taskRoomId);
    await acceptGroupInvites(u2Conn, taskRoomId);

    const roomB = await callTool<RoomDetail>(u1Conn.client, 'network_room_create', {
      request_id: newRequestId('d05_room_b'),
      kind: 'group',
      title: 'D05 源范围',
      members: [b1.actor_id],
    });
    const sourceRoomId = roomB.room.room_id;
    await acceptGroupInvites(b1Conn, sourceRoomId);

    await callTool(b1Conn.client, 'network_login', {});

    // ---------- D05-T01：版本化包与仅凭包接续 ----------
    const task1 = await createOwnedTask(
      u1Conn,
      b1Conn,
      taskRoomId,
      'D05-T01 交接包定位',
      u1.actor_id,
      b1.actor_id,
    );
    const revisionBeforeSubmit = task1.revision;
    const submitted1 = await callTool<{ submission: SubmissionView }>(
      b1Conn.client,
      'network_task_submit',
      {
        request_id: newRequestId('d05_submit'),
        task_id: task1.task_id,
        summary: 'D05-T01 第一阶段成果',
        commit_sha: 'abc1234',
        evidence: ['bun run typecheck'],
        ...assignmentArgs(task1),
        expected_revision: task1.revision,
      },
    );
    checkEqual('D05-T01 成果版本从 v1 开始', submitted1.submission.version, 1);
    const submittedTask = await getTask(b1Conn, task1.task_id);
    checkEqual('D05-T01 提交后任务 revision 递增', submittedTask.revision, revisionBeforeSubmit + 1);
    await callTool(u1Conn.client, 'network_task_submission_return', {
      request_id: newRequestId('d05_return'),
      task_id: task1.task_id,
      submission_id: submitted1.submission.submission_id,
      reason: 'D05-T01 退回后继续补交接包',
      expected_revision: submittedTask.revision,
    });
    const returnedTask = await getTask(b1Conn, task1.task_id);
    checkEqual('D05-T01 退回后任务恢复 in_progress', returnedTask.status, 'in_progress');
    checkEqual('D05-T01 退回后由原负责人继续', returnedTask.owner_actor_id, b1.actor_id);
    check('D05-T01 退回后存在新的 active assignment', Boolean(
      returnedTask.assignment && returnedTask.assignment.status === 'active',
    ));

    const message = await sendMessage(u1Conn, taskRoomId, 'D05-T01 交接说明消息');
    const roomBefore = await callTool<RoomDetail>(u1Conn.client, 'network_room_get', {
      room_id: taskRoomId,
    });
    const meBefore = await callTool<Identity>(b1Conn.client, 'network_me', {});
    const packV1 = await createPack(b1Conn, returnedTask, {
      goal: '完成 Webots 平价能力并交付可复核证据',
      completed: ['收拢目标与验收条件', '完成第一轮实现'],
      current_result: {
        summary: '核心路径已实现，等待复核',
        submission_id: submitted1.submission.submission_id,
        submission_version: 1,
      },
      unresolved: ['跨范围私有材料仍需授权'],
      next_steps: ['补齐交接包引用', '在目标房间复跑协议验收'],
      items: [
        { kind: 'message', ref: message.message.message_id, label: '交接说明消息' },
        {
          kind: 'branch',
          ref: 'feat/webots-parity',
          label: '实现分支',
          summary: '主线实现分支',
        },
        { kind: 'commit', ref: 'abc1234', label: '实现提交' },
        { kind: 'test', ref: 'bun run test:protocol', label: '协议验收命令' },
      ],
    });
    const v1 = packV1.pack;
    checkEqual('D05-T01 首版包版本为 1', v1.version, 1);
    checkEqual('D05-T01 latest_version 为 1', v1.latest_version, 1);
    checkEqual('D05-T01 当前结果绑定成果 v1', v1.current_result.submission_version, 1);
    checkEqual('D05-T01 当前结果记录成果状态', v1.current_result.submission_status, 'returned');
    checkEqual('D05-T01 目标写入包', v1.goal, '完成 Webots 平价能力并交付可复核证据');
    checkEqual('D05-T01 原执行版本记录为 assignment_version', v1.from_assignment_version, returnedTask.assignment!.assignment_version);
    checkEqual('D05-T01 消息引用只含预览', Boolean(v1.items[0]?.message?.preview), true);
    checkEqual('D05-T01 分支引用可用', itemByRef(v1, 'feat/webots-parity').status, 'available');
    checkEqual('D05-T01 提交引用可用', itemByRef(v1, 'abc1234').status, 'available');
    checkEqual('D05-T01 测试引用可用', itemByRef(v1, 'bun run test:protocol').status, 'available');
    checkEqual('D05-T01 当前视图上下文完整', v1.context_ready, true);

    const taskAfterPack = await getTask(b1Conn, task1.task_id);
    checkEqual('D05-T01 生成包不改变任务状态', taskAfterPack.status, returnedTask.status);
    checkEqual('D05-T01 生成包不改变负责人', taskAfterPack.owner_actor_id, b1.actor_id);
    checkEqual('D05-T01 生成包不改变 revision', taskAfterPack.revision, returnedTask.revision);
    checkEqual(
      'D05-T01 生成包不改变 assignment',
      taskAfterPack.assignment?.assignment_id,
      returnedTask.assignment?.assignment_id,
    );
    const roomAfterPack = await callTool<RoomDetail>(u1Conn.client, 'network_room_get', {
      room_id: taskRoomId,
    });
    checkEqual('D05-T01 生成包不推进房间 head_seq', roomAfterPack.room.head_seq, roomBefore.room.head_seq);
    const meAfterPack = await callTool<Identity>(b1Conn.client, 'network_me', {});
    checkEqual('D05-T01 生成包不增加 Agent pending_count', meAfterPack.pending_count, meBefore.pending_count);

    const packV2 = await createPack(b1Conn, await getTask(b1Conn, task1.task_id), {
      goal: '完成 Webots 平价能力并交付可复核证据（v2 更新下一步）',
      completed: ['收拢目标与验收条件', '完成第一轮实现', '补记交接引用'],
      current_result: {
        summary: '核心路径已实现，复核项已登记',
        submission_id: submitted1.submission.submission_id,
        submission_version: 1,
      },
      unresolved: ['跨范围私有材料仍需授权'],
      next_steps: ['在目标房间复跑协议验收', '接任者确认无遗漏'],
      items: [
        { kind: 'message', ref: message.message.message_id, label: '交接说明消息' },
        {
          kind: 'branch',
          ref: 'feat/webots-parity',
          label: '实现分支',
          summary: '主线实现分支',
        },
        { kind: 'commit', ref: 'abc1234', label: '实现提交' },
        { kind: 'test', ref: 'bun run test:protocol', label: '协议验收命令' },
      ],
    });
    checkEqual('D05-T01 新版本为 2', packV2.pack.version, 2);
    checkEqual('D05-T01 latest_version 为 2', packV2.pack.latest_version, 2);
    checkEqual(
      'D05-T01 versions 同时包含 1 与 2',
      packV2.pack.versions.includes(1) && packV2.pack.versions.includes(2),
      true,
    );
    const oldV1 = await getPack(b1Conn, task1.task_id, { version: 1 });
    checkEqual('D05-T01 旧版本目标原样保留', oldV1.pack.goal, v1.goal);
    checkEqual('D05-T01 旧版本下一步原样保留', oldV1.pack.next_steps[0], v1.next_steps[0]);
    checkEqual('D05-T01 默认读取返回最新版本', (await getPack(b1Conn, task1.task_id)).pack.version, 2);

    const transfer1 = await propose(b1Conn, await getTask(b1Conn, task1.task_id), u2.actor_id);
    checkEqual('D05-T01 交接提议待接受', transfer1.transfer.effective_status, 'pending');
    const successorView = (await getPack(u2Conn, task1.task_id)).pack;
    checkEqual('D05-T01 接任者视角标记 successor', successorView.viewer_is_successor, true);
    checkEqual('D05-T01 接任者仅凭包读取目标', successorView.goal, packV2.pack.goal);
    checkEqual('D05-T01 接任者仅凭包读取当前结果', successorView.current_result.summary, packV2.pack.current_result.summary);
    checkEqual('D05-T01 接任者仅凭包读取成果版本', successorView.current_result.submission_version, 1);
    checkEqual('D05-T01 接任者仅凭包读取代码引用', itemByRef(successorView, 'abc1234').status, 'available');
    checkEqual('D05-T01 接任者仅凭包读取下一步', successorView.next_steps[0], packV2.pack.next_steps[0]);
    checkEqual('D05-T01 接任者视图上下文完整', successorView.context_ready, true);

    const beforeRequest = await getTask(b1Conn, task1.task_id);
    const requested = await callTool<RequestMoreResult>(
      u2Conn.client,
      'network_task_handoff_pack_request_more',
      {
        request_id: newRequestId('d05_request_more'),
        task_id: task1.task_id,
        pack_id: successorView.pack_id,
        transfer_id: transfer1.transfer.transfer_id,
        note: '请补充跨群验收日志',
      },
    );
    checkEqual('D05-T01 请求补充上下文写入 note', requested.request.note, '请补充跨群验收日志');
    checkEqual('D05-T01 请求后包内可见请求', requested.pack.requests[0]?.note, '请补充跨群验收日志');
    const afterRequest = await getTask(b1Conn, task1.task_id);
    checkEqual('D05-T01 请求补充不改变负责人', afterRequest.owner_actor_id, beforeRequest.owner_actor_id);
    checkEqual('D05-T01 请求补充不改变任务状态', afterRequest.status, beforeRequest.status);
    checkEqual('D05-T01 请求补充不改变 revision', afterRequest.revision, beforeRequest.revision);

    // ---------- D05-T02：跨范围私有文件授权与未授权缺项 ----------
    const upload = await uploadTestFile(b1Conn.token, {
      name: 'd05-source-log.txt',
      mimeType: 'text/plain',
      body: 'D05 源群私有材料',
    });
    await callTool(b1Conn.client, 'network_room_file_bind', {
      request_id: newRequestId('d05_bind'),
      room_id: sourceRoomId,
      file_id: upload.fileId,
    });
    const task2 = await createOwnedTask(
      u1Conn,
      b1Conn,
      taskRoomId,
      'D05-T02 跨群材料授权',
      u1.actor_id,
      b1.actor_id,
    );
    const pack2 = (
      await createPack(b1Conn, task2, {
        goal: '带着源群日志完成 T02',
        current_result: { summary: '实现完成，源群日志待授权' },
        next_steps: ['授权源群日志后复核'],
        source_room_id: sourceRoomId,
        items: [
          {
            kind: 'file',
            ref: upload.fileId,
            label: '源群验收日志',
            source_room_id: sourceRoomId,
            required: true,
          },
        ],
      })
    ).pack;
    const selfItem = itemByRef(pack2, upload.fileId);
    checkEqual('D05-T02 未授权跨范围文件为 omitted', selfItem.status, 'omitted');
    checkEqual('D05-T02 未授权项不返回文件 URL', selfItem.file, null);
    checkEqual('D05-T02 未授权项不返回可用文件', selfItem.authorized, false);
    checkEqual('D05-T02 必需引用缺失进入 required_missing', pack2.required_missing.length, 1);
    checkEqual('D05-T02 未授权时上下不完整', pack2.context_ready, false);

    const directStatus = await fetchStatus(`${baseUrl()}/f/${upload.fileId}`);
    check('D05-T02 未授权文件裸链不可读', directStatus !== 200, directStatus);

    const transfer2 = await propose(b1Conn, task2, u2.actor_id);
    const successorUnauthorized = (await getPack(u2Conn, task2.task_id)).pack;
    const successorItem = itemByRef(successorUnauthorized, upload.fileId);
    checkEqual('D05-T02 接任者看到未授权项', successorItem.status, 'omitted');
    checkEqual('D05-T02 接任者拿不到文件 URL', successorItem.file, null);
    checkEqual('D05-T02 接任者视图 required_missing 一致', successorUnauthorized.required_missing.length, 1);

    const request2 = await callTool<RequestMoreResult>(
      u2Conn.client,
      'network_task_handoff_pack_request_more',
      {
        request_id: newRequestId('d05_request_source'),
        task_id: task2.task_id,
        pack_id: successorUnauthorized.pack_id,
        transfer_id: transfer2.transfer.transfer_id,
        note: '请授权源群验收日志',
      },
    );
    checkEqual('D05-T02 接任者请求补充成功', request2.request.note, '请授权源群验收日志');
    checkEqual(
      'D05-T02 请求补充不改变原负责人',
      (await getTask(b1Conn, task2.task_id)).owner_actor_id,
      b1.actor_id,
    );

    const grantedPack = (
      await authorize(b1Conn, task2, pack2, selfItem, 'grant')
    ).pack;
    const grantedItem = itemByRef(grantedPack, upload.fileId);
    checkEqual('D05-T02 授权后文件项可用', grantedItem.status, 'available');
    checkEqual('D05-T02 授权后记录授权人', grantedItem.authorized_by_name, 'D05 Agent B1');
    check('D05-T02 授权后返回下载 URL', Boolean(grantedItem.file?.download_url), grantedItem.file);
    checkEqual('D05-T02 授权后 context_ready', grantedPack.context_ready, true);
    checkEqual('D05-T02 授权后 required_missing 清空', grantedPack.required_missing.length, 0);

    const successorGranted = (await getPack(u2Conn, task2.task_id)).pack;
    const successorGrantedItem = itemByRef(successorGranted, upload.fileId);
    checkEqual('D05-T02 接任者重读看到授权', successorGrantedItem.status, 'available');
    const targetUrl = successorGrantedItem.file?.download_url;
    check('D05-T02 接任者获得下载 URL', Boolean(targetUrl), successorGrantedItem.file);
    checkEqual('D05-T02 接任者可用 URL 读取文件', await fetchStatus(targetUrl!), 200);

    const accepted2 = await acceptTransfer(u2Conn, transfer2.transfer, await getTask(b1Conn, task2.task_id));
    checkEqual('D05-T02 授权完整时接任后任务继续', accepted2.task.status, 'in_progress');
    checkEqual('D05-T02 接任后负责人为接任者', accepted2.task.owner_actor_id, u2.actor_id);

    const revokedPack = (
      await authorize(u2Conn, accepted2.task, successorGranted, successorGrantedItem, 'revoke')
    ).pack;
    const revokedItem = itemByRef(revokedPack, upload.fileId);
    checkEqual('D05-T02 撤回后文件项 omitted', revokedItem.status, 'omitted');
    checkEqual('D05-T02 撤回后不返回 URL', revokedItem.file, null);
    checkEqual('D05-T02 撤回后旧 URL 立即失效', await fetchStatus(targetUrl!), 404);

    // 必需引用缺失时接受交接：任务 blocked + context_incomplete。
    const task3 = await createOwnedTask(
      u1Conn,
      b1Conn,
      taskRoomId,
      'D05-T02 缺项接任阻断',
      u1.actor_id,
      b1.actor_id,
    );
    const pack3 = (
      await createPack(b1Conn, task3, {
        goal: '验证缺项接任',
        current_result: { summary: '等待源群材料' },
        next_steps: ['补齐材料后恢复'],
        items: [
          {
            kind: 'file',
            ref: upload.fileId,
            label: '源群验收日志',
            source_room_id: sourceRoomId,
            required: true,
          },
        ],
      })
    ).pack;
    checkEqual('D05-T02 新包未授权项为 omitted', itemByRef(pack3, upload.fileId).status, 'omitted');
    const transfer3 = await propose(b1Conn, task3, u2.actor_id);
    const accepted3 = await acceptTransfer(
      u2Conn,
      transfer3.transfer,
      await getTask(b1Conn, task3.task_id),
    );
    checkEqual('D05-T02 缺项接任后任务 blocked', accepted3.task.status, 'blocked');
    checkEqual('D05-T02 缺项接任阻塞原因为 context_incomplete', accepted3.task.blocked_reason, 'context_incomplete');
    checkEqual('D05-T02 缺项接任仍完成换人', accepted3.task.owner_actor_id, u2.actor_id);
    const acceptedPack = (await getPack(u2Conn, task3.task_id)).pack;
    checkEqual('D05-T02 接任后包仍标记上下文不完整', acceptedPack.context_incomplete, true);
    const ownerRequest = await callTool<RequestMoreResult>(
      u2Conn.client,
      'network_task_handoff_pack_request_more',
      {
        request_id: newRequestId('d05_request_owner'),
        task_id: task3.task_id,
        pack_id: acceptedPack.pack_id,
        note: '作为接任者请求源群日志',
        ...assignmentArgs(accepted3.task),
        expected_revision: accepted3.task.revision,
      },
    );
    checkEqual('D05-T02 接任者成为负责人后仍可请求补充', ownerRequest.request.note, '作为接任者请求源群日志');
    checkEqual('D05-T02 请求补充不解除 blocked', (await getTask(u2Conn, task3.task_id)).status, 'blocked');

    // ---------- D05-T03：源范围失权后包重读反映变化 ----------
    const task4 = await createOwnedTask(
      u1Conn,
      b1Conn,
      taskRoomId,
      'D05-T03 源范围失权',
      u1.actor_id,
      b1.actor_id,
    );
    const pack4 = (
      await createPack(b1Conn, task4, {
        goal: '验证源范围失权',
        current_result: { summary: '材料已授权' },
        next_steps: ['复核后接任'],
        source_room_id: sourceRoomId,
        items: [
          {
            kind: 'file',
            ref: upload.fileId,
            label: '源群验收日志',
            source_room_id: sourceRoomId,
            required: true,
          },
        ],
      })
    ).pack;
    const granted4 = (await authorize(b1Conn, task4, pack4, itemByRef(pack4, upload.fileId), 'grant')).pack;
    const transfer4 = await propose(b1Conn, task4, u2.actor_id);
    const beforeLoss = (await getPack(u2Conn, task4.task_id)).pack;
    const beforeLossItem = itemByRef(beforeLoss, upload.fileId);
    checkEqual('D05-T03 失权前接任者可见材料', beforeLossItem.status, 'available');
    check('D05-T03 失权前接任者拿到 URL', Boolean(beforeLossItem.file?.download_url), beforeLossItem.file);

    await callTool(b1Conn.client, 'network_room_leave', {
      request_id: newRequestId('d05_leave_source'),
      room_id: sourceRoomId,
    });
    const afterLoss = (await getPack(u2Conn, task4.task_id)).pack;
    const afterLossItem = itemByRef(afterLoss, upload.fileId);
    checkEqual('D05-T03 授权人失权后文件项 omitted', afterLossItem.status, 'omitted');
    checkEqual('D05-T03 失权原因为 authorization_source_lost', afterLossItem.reason, 'authorization_source_lost');
    checkEqual('D05-T03 失权后不返回文件 URL', afterLossItem.file, null);
    checkEqual('D05-T03 失权后 required_missing 重新出现', afterLoss.required_missing.length, 1);
    checkEqual(
      'D05-T03 失权后旧 URL 立即失效',
      await fetchStatus(beforeLossItem.file!.download_url!),
      404,
    );
    check(
      'D05-T03 失权后 omitted 汇总包含该引用',
      afterLoss.omitted.some((gap) => gap.ref === upload.fileId),
      afterLoss.omitted,
    );
    checkEqual('D05-T03 失权不改变任务负责人', (await getTask(u2Conn, task4.task_id)).owner_actor_id, b1.actor_id);
    checkEqual('D05-T03 失权不改变任务状态', (await getTask(u2Conn, task4.task_id)).status, 'in_progress');

  } finally {
    await u1Conn.close();
    await b1Conn.close();
    await u2Conn.close();
  }
}

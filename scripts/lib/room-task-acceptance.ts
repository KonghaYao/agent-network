/**
 * D01 消息转任务与任务卡片验收（D01-T01..T04）。
 *
 * 使用独立身份与群房间，只通过公开 MCP 工具调用；同时验证持久通知、
 * delivery 唤醒、公开任务不唤醒、卡片定位、长正文与越权直读。
 */

import type { McpSubscription } from '@modelcontextprotocol/client';

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
  uploadTestFile,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  inbox,
  readWholeMessage,
  registerIdentity,
  sendMessage,
  type RoomDetail,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface TaskView {
  task_id: string;
  room_id: string;
  title: string;
  description: string;
  acceptance_criteria: string;
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
  source_message_id: string | null;
  card_message_id: string | null;
  created_by: string;
  created_by_name: string;
  owner_actor_id: string | null;
  owner_name: string | null;
  reviewer_actor_id: string;
  reviewer_name: string;
  due_at: string | null;
  business_authority: 'native' | 'external';
  assignment: {
    assignment_id: string;
    assignment_version: number;
    owner_actor_id: string;
    owner_name: string | null;
    status: 'offered' | 'active' | 'submitted' | 'declined' | 'revoked' | 'expired';
    delivery_id: string | null;
  } | null;
  delivery_ids: string[];
  attachments: { file_id: string; label: string }[];
  can_offer: boolean;
  can_claim: boolean;
  can_cancel: boolean;
  can_accept: boolean;
  can_decline: boolean;
}

interface TaskResult {
  task: TaskView;
}

interface TaskList {
  tasks: TaskView[];
  next_cursor: string | null;
  has_more: boolean;
}

interface TaskSummary {
  items: {
    room_id: string;
    pending: number;
    claimed: number;
    done: number;
    failed: number;
    total: number;
  }[];
}

interface IdentityView {
  actor_id: string;
  pending_count: number;
}

interface StreamItemView {
  source?: string;
  kind?: string;
  attention?: string;
  room_id?: string;
  message_id?: string;
  delivery_id?: string;
  task_id?: string;
  assignment_id?: string;
  ref_id?: string;
  change?: string;
  status?: string;
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

async function waitForItem(
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

async function createTask(
  connection: McpConnection,
  args: Record<string, unknown>,
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_create', {
    request_id: newRequestId('task_create'),
    ...args,
  });
}

async function getTask(connection: McpConnection, taskId: string): Promise<TaskView> {
  return (await callTool<TaskResult>(connection.client, 'network_task_get', {
    task_id: taskId,
  })).task;
}

async function listTasks(
  connection: McpConnection,
  args: Record<string, unknown>,
): Promise<TaskList> {
  return callTool<TaskList>(connection.client, 'network_task_list', args);
}

async function pendingCount(connection: McpConnection): Promise<number> {
  return (await callTool<IdentityView>(connection.client, 'network_me', {})).pending_count;
}

export async function runRoomTaskAcceptance(): Promise<void> {
  console.log('· D01 消息转任务与任务卡片');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const b1Conn = await connectClient(newToken());
  const b2Conn = await connectClient(newToken());
  const removedConn = await connectClient(newToken());
  const outsiderConn = await connectClient(newToken());
  const subscriptions: McpSubscription[] = [];

  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'D01 创建者 U1' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'D01 接手人 U2' });
    const b1 = await registerIdentity(b1Conn, {
      kind: 'agent',
      name: 'D01 Agent B1',
      sessionId: `d01_b1_${crypto.randomUUID()}`,
    });
    const b2 = await registerIdentity(b2Conn, {
      kind: 'agent',
      name: 'D01 Agent B2',
      sessionId: `d01_b2_${crypto.randomUUID()}`,
    });
    const removed = await registerIdentity(removedConn, {
      kind: 'agent',
      name: 'D01 待移除 Agent',
      sessionId: `d01_removed_${crypto.randomUUID()}`,
    });
    const outsider = await registerIdentity(outsiderConn, {
      kind: 'agent',
      name: 'D01 房间外 Agent',
      sessionId: `d01_outsider_${crypto.randomUUID()}`,
    });
    check(
      'D01 身份注册成功',
      Boolean(u1.actor_id && u2.actor_id && b1.actor_id && b2.actor_id && removed.actor_id && outsider.actor_id),
    );

    await befriend(u1Conn, u1.actor_id, u2Conn, u2.actor_id);
    await befriend(u1Conn, u1.actor_id, b1Conn, b1.actor_id);
    await befriend(u1Conn, u1.actor_id, b2Conn, b2.actor_id);
    await befriend(u1Conn, u1.actor_id, removedConn, removed.actor_id);

    const group = await callTool<RoomDetail>(u1Conn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      title: 'D01 任务验收群',
      members: [u2.actor_id, b1.actor_id, b2.actor_id, removed.actor_id],
    });
    const roomId = group.room.room_id;
    await acceptGroupInvites(u2Conn, roomId);
    await acceptGroupInvites(b1Conn, roomId);
    await acceptGroupInvites(b2Conn, roomId);
    await acceptGroupInvites(removedConn, roomId);

    const u2Collector = notificationCollector(u2Conn.client);
    const b1Collector = notificationCollector(b1Conn.client);
    subscriptions.push(await openSubscription(u2Conn.client, [STREAM_URI]));
    subscriptions.push(await openSubscription(b1Conn.client, [STREAM_URI]));
    const b1Login = await callTool<{ pending_count: number }>(b1Conn.client, 'network_login', {});
    checkEqual('B1 上线后无历史待办', b1Login.pending_count, 0);
    await sleep(200);

    // ---------- D01-T01：U1 从消息创建任务并指定 U2 ----------
    const t01Message = await sendMessage(u1Conn, roomId, 'T01 来源消息：请 U2 接手');
    const u2PendingBefore = (await callTool<IdentityView>(u2Conn.client, 'network_me', {}))
      .pending_count;
    const u2From = u2Collector.events.length;
    const t01 = (await createTask(u1Conn, {
      room_id: roomId,
      title: 'T01 接手任务',
      description: '完整目标：U2 接手后先确认范围。',
      source_message_id: t01Message.message.message_id,
      assignee_actor_id: u2.actor_id,
      reviewer_actor_id: u1.actor_id,
    })).task;
    checkEqual('D01-T01 指定 human 后状态为 offered', t01.status, 'offered');
    checkEqual('D01-T01 offer 尚未产生 owner', t01.owner_actor_id, null);
    checkEqual('D01-T01 assignment 候选人为 U2', t01.assignment?.owner_actor_id, u2.actor_id);
    checkEqual('D01-T01 human offer 不创建 delivery', t01.delivery_ids.length, 0);
    checkEqual('D01-T01 assignment 不伪造 delivery', t01.assignment?.delivery_id, null);
    checkEqual('D01-T01 来源消息被记录', t01.source_message_id, t01Message.message.message_id);
    check('D01-T01 生成了真实任务卡片消息', Boolean(t01.card_message_id));

    const u2Notice = await waitForItem(
      u2Collector,
      u2From,
      (item) =>
        item.source === 'task.updated' &&
        item.change === 'offered' &&
        item.task_id === t01.task_id,
      'D01-T01 U2 接手通知',
      3_000,
    ).catch(() => null);
    if (u2Notice) {
      checkEqual(
        'D01-T01 U2 通知 attention 为 action_required',
        u2Notice.attention,
        'action_required',
      );
      checkEqual('D01-T01 U2 通知不是 delivery', u2Notice.kind, 'task');
      checkEqual('D01-T01 U2 通知携带卡片消息', u2Notice.message_id, t01.card_message_id);
    }
    // 阶段 2 起 sync 过滤旧任务事件；旧任务通知仍可从任务工具读取，但不再补读事件。
    const u2Sync = await callTool<{
      items: { type: string; ref_id: string | null; metadata: Record<string, unknown> }[];
    }>(u2Conn.client, 'network_sync', { scope: 'inbox', limit: 100 });
    check(
      'D01-T01 sync 不再返回旧 task_offered',
      !u2Sync.items.some((item) => item.type === 'task_offered'),
      u2Sync.items,
    );
    checkEqual(
      'D01-T01 human 接手通知不增加 pending_count',
      (await callTool<IdentityView>(u2Conn.client, 'network_me', {})).pending_count,
      u2PendingBefore,
    );
    const u2Read = await getTask(u2Conn, t01.task_id);
    checkEqual('D01-T01 U2 可读取同一 task_id', u2Read.task_id, t01.task_id);
    checkEqual('D01-T01 U2 读取状态仍为 offered', u2Read.status, 'offered');

    // ---------- D01-T02：指定 B1 只产生一个关联投递，重放不重复 ----------
    const t02Message = await sendMessage(u1Conn, roomId, 'T02 来源消息：请 B1 执行');
    const b1PendingBefore = (await inbox(b1Conn, 'pending')).pending_count;
    const b1From = b1Collector.events.length;
    const t02Request = newRequestId('task_create');
    const t02 = (await callTool<TaskResult>(u1Conn.client, 'network_task_create', {
      request_id: t02Request,
      room_id: roomId,
      title: 'T02 指定 Agent 任务',
      description: 'B1 执行，U2 验收。',
      source_message_id: t02Message.message.message_id,
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u2.actor_id,
    })).task;
    checkEqual('D01-T02 Agent 指派状态为 offered', t02.status, 'offered');
    checkEqual('D01-T02 只生成一个关联 delivery', t02.delivery_ids.length, 1);
    checkEqual(
      'D01-T02 assignment 绑定同一 delivery',
      t02.assignment?.delivery_id,
      t02.delivery_ids[0],
    );
    checkEqual(
      'D01-T02 Agent 指派增加 pending_count',
      (await inbox(b1Conn, 'pending')).pending_count,
      b1PendingBefore + 1,
    );
    const deliveryId = t02.delivery_ids[0] as string;
    const b1Notice = await waitForItem(
      b1Collector,
      b1From,
      (item) => item.source === 'delivery.created' && item.delivery_id === deliveryId,
      'D01-T02 B1 delivery 唤醒',
    );
    checkEqual('D01-T02 B1 收到 action_required', b1Notice.attention, 'action_required');
    checkEqual('D01-T02 delivery 关联任务卡片消息', b1Notice.message_id, t02.card_message_id);

    const replay = (await callTool<TaskResult>(u1Conn.client, 'network_task_create', {
      request_id: t02Request,
      room_id: roomId,
      title: 'T02 指定 Agent 任务',
      description: 'B1 执行，U2 验收。',
      source_message_id: t02Message.message.message_id,
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u2.actor_id,
    })).task;
    checkEqual('D01-T02 同一 request_id 重放返回同一任务', replay.task_id, t02.task_id);
    checkEqual('D01-T02 重放 assignment 不变', replay.assignment?.assignment_id, t02.assignment?.assignment_id);
    checkEqual('D01-T02 重放 delivery 不变', replay.delivery_ids.join(','), t02.delivery_ids.join(','));
    checkEqual(
      'D01-T02 重放不增加 B1 pending_count',
      (await inbox(b1Conn, 'pending')).pending_count,
      b1PendingBefore + 1,
    );

    const sameSource = (await createTask(u1Conn, {
      room_id: roomId,
      title: 'T02 指定 Agent 任务',
      description: 'B1 执行，U2 验收。',
      source_message_id: t02Message.message.message_id,
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u2.actor_id,
    })).task;
    checkEqual('D01-T02 同一来源消息只生成一个任务', sameSource.task_id, t02.task_id);
    checkEqual('D01-T02 同一来源不产生第二个投递', sameSource.delivery_ids.length, 1);
    checkEqual(
      'D01-T02 同一来源重放不增加 B1 pending_count',
      (await inbox(b1Conn, 'pending')).pending_count,
      b1PendingBefore + 1,
    );
    await sleep(600);
    const deliveryNotices = streamItems(b1Collector, b1From).filter(
      (item) => item.source === 'delivery.created' && item.delivery_id === deliveryId,
    );
    checkEqual('D01-T02 重放不重复唤醒 B1', deliveryNotices.length, 1);

    // 同一来源但任一语义参数不同都必须 CONFLICT，不能静默丢弃新参数。
    const t02Base = {
      room_id: roomId,
      title: 'T02 指定 Agent 任务',
      description: 'B1 执行，U2 验收。',
      source_message_id: t02Message.message.message_id,
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u2.actor_id,
    };
    await expectToolError(
      'D01-T02 同来源不同描述返回 CONFLICT',
      createTask(u1Conn, { ...t02Base, description: '新的目标描述' }),
      'CONFLICT',
    );
    await expectToolError(
      'D01-T02 同来源不同标题返回 CONFLICT',
      createTask(u1Conn, { ...t02Base, title: 'T02 另一个标题' }),
      'CONFLICT',
    );
    await expectToolError(
      'D01-T02 同来源不同验收条件返回 CONFLICT',
      createTask(u1Conn, { ...t02Base, acceptance_criteria: '新的验收条件' }),
      'CONFLICT',
    );
    await expectToolError(
      'D01-T02 同来源省略负责人返回 CONFLICT',
      createTask(u1Conn, {
        room_id: roomId,
        title: t02Base.title,
        description: t02Base.description,
        source_message_id: t02Base.source_message_id,
        reviewer_actor_id: t02Base.reviewer_actor_id,
      }),
      'CONFLICT',
    );
    await expectToolError(
      'D01-T02 同来源不同验收人返回 CONFLICT',
      createTask(u1Conn, { ...t02Base, reviewer_actor_id: b2.actor_id }),
      'CONFLICT',
    );
    await expectToolError(
      'D01-T02 同来源不同期限返回 CONFLICT',
      createTask(u1Conn, {
        ...t02Base,
        due_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
      'CONFLICT',
    );
    const t02Attachment = await uploadTestFile(u1Conn.token, {
      name: 'd01-t02-conflict.txt',
      mimeType: 'text/plain',
      body: 'D01 conflict attachment',
    });
    await callTool(u1Conn.client, 'network_room_file_bind', {
      request_id: newRequestId('task_attachment_bind'),
      room_id: roomId,
      file_id: t02Attachment.fileId,
    });
    await expectToolError(
      'D01-T02 同来源不同附件返回 CONFLICT',
      createTask(u1Conn, { ...t02Base, attachment_file_ids: [t02Attachment.fileId] }),
      'CONFLICT',
    );
    checkEqual(
      'D01-T02 参数冲突不产生第二个任务或投递',
      (await getTask(u1Conn, t02.task_id)).delivery_ids.length,
      1,
    );

    const t02History = await callTool<{ items: { message_id: string; preview: string }[] }>(
      u1Conn.client,
      'network_history_list',
      { room_id: roomId, limit: 50 },
    );
    check(
      'D01-T02 任务卡片出现在聊天历史',
      t02History.items.some((item) => item.message_id === t02.card_message_id),
    );
    checkEqual(
      'D01-T02 卡片正文可完整读取',
      t02.card_message_id ? await readWholeMessage(u1Conn, t02.card_message_id) : '',
      '【任务卡】T02 指定 Agent 任务',
    );

    // 后续 accept 不改变创建语义：相同参数重放仍返回创建时的任务。
    const t02Accepted = (await callTool<TaskResult>(b1Conn.client, 'network_task_accept', {
      request_id: newRequestId('task_accept'),
      task_id: t02.task_id,
      assignment_id: t02.assignment?.assignment_id,
    })).task;
    checkEqual('D01-T02 指定任务接受后为 in_progress', t02Accepted.status, 'in_progress');
    const t02AcceptReplay = (await createTask(u1Conn, t02Base)).task;
    checkEqual(
      'D01-T02 接受后相同参数重放返回同一任务',
      t02AcceptReplay.task_id,
      t02.task_id,
    );
    checkEqual(
      'D01-T02 接受后重放返回当前负责人',
      t02AcceptReplay.owner_actor_id,
      b1.actor_id,
    );

    // 后续 reoffer 也不改变创建语义：创建时负责人仍是 B1，而不是当前候选 B2。
    const reofferMessage = await sendMessage(u1Conn, roomId, 'D01-T02 重派重放来源消息');
    const reofferBase = {
      room_id: roomId,
      title: 'T02 重派后重放',
      description: 'B1 拒绝后重派给 B2。',
      source_message_id: reofferMessage.message.message_id,
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u2.actor_id,
    };
    const reofferCreated = (await createTask(u1Conn, reofferBase)).task;
    const reofferDeclined = (await callTool<TaskResult>(b1Conn.client, 'network_task_decline', {
      request_id: newRequestId('task_decline'),
      task_id: reofferCreated.task_id,
      assignment_id: reofferCreated.assignment?.assignment_id,
      reason: 'D01 重派重放回归',
    })).task;
    const reoffered = (await callTool<TaskResult>(u1Conn.client, 'network_task_offer', {
      request_id: newRequestId('task_offer'),
      task_id: reofferCreated.task_id,
      assignee_actor_id: b2.actor_id,
      expected_revision: reofferDeclined.revision,
    })).task;
    checkEqual(
      'D01-T02 重派生成第二个 assignment',
      reoffered.assignment?.assignment_version,
      2,
    );
    const reofferReplay = (await createTask(u1Conn, reofferBase)).task;
    checkEqual(
      'D01-T02 重派后相同参数重放返回同一任务',
      reofferReplay.task_id,
      reofferCreated.task_id,
    );
    checkEqual(
      'D01-T02 重派后重放不改变当前候选',
      reofferReplay.assignment?.owner_actor_id,
      b2.actor_id,
    );

    // ---------- D01-T03：公开任务不唤醒 Agent，三个入口同一状态 ----------
    const t03Message = await sendMessage(u1Conn, roomId, 'T03 来源消息：公开任务');
    const t03From = b1Collector.events.length;
    const b1PendingBeforePublic = (await inbox(b1Conn, 'pending')).pending_count;
    const t03 = (await createTask(u1Conn, {
      room_id: roomId,
      title: 'T03 公开任务',
      description: '任何成员都可以领取。',
      source_message_id: t03Message.message.message_id,
      reviewer_actor_id: u1.actor_id,
    })).task;
    checkEqual('D01-T03 公开任务状态为 unassigned', t03.status, 'unassigned');
    checkEqual('D01-T03 公开任务没有 assignment', t03.assignment, null);
    checkEqual('D01-T03 公开任务没有 delivery', t03.delivery_ids.length, 0);
    checkEqual(
      'D01-T03 公开任务不增加 Agent pending_count',
      (await inbox(b1Conn, 'pending')).pending_count,
      b1PendingBeforePublic,
    );
    await sleep(600);
    const publicActionItems = streamItems(b1Collector, t03From).filter(
      (item) => item.attention === 'action_required' && item.task_id === t03.task_id,
    );
    checkEqual('D01-T03 公开任务不向 Agent 发 action_required', publicActionItems.length, 0);

    const t03ByAgent = await getTask(b1Conn, t03.task_id);
    checkEqual('D01-T03 Agent 可读取公开任务', t03ByAgent.task_id, t03.task_id);
    checkEqual('D01-T03 task_get 状态一致', t03ByAgent.status, 'unassigned');
    checkEqual('D01-T03 task_get 负责人一致', t03ByAgent.owner_actor_id, null);
    const t03RoomList = await listTasks(b1Conn, { room_id: roomId });
    const t03RoomEntry = t03RoomList.tasks.find((task) => task.task_id === t03.task_id);
    checkEqual('D01-T03 房间列表定位同一 task_id', t03RoomEntry?.task_id, t03.task_id);
    checkEqual('D01-T03 房间列表状态一致', t03RoomEntry?.status, 'unassigned');
    checkEqual('D01-T03 房间列表负责人一致', t03RoomEntry?.owner_actor_id, null);
    const t03Mine = await listTasks(u1Conn, { scope: 'mine' });
    check(
      'D01-T03 我的任务包含创建者公开任务',
      t03Mine.tasks.some((task) => task.task_id === t03.task_id),
      t03Mine.tasks.map((task) => task.task_id),
    );
    const t03History = await callTool<{ items: { message_id: string }[] }>(
      u1Conn.client,
      'network_history_list',
      { room_id: roomId, limit: 50 },
    );
    check(
      'D01-T03 公开任务卡片进入聊天历史',
      t03History.items.some((item) => item.message_id === t03.card_message_id),
    );

    const t03Claim = (await callTool<TaskResult>(b1Conn.client, 'network_task_claim', {
      request_id: newRequestId('task_claim'),
      task_id: t03.task_id,
    })).task;
    checkEqual('D01-T03 公开领取转为 in_progress', t03Claim.status, 'in_progress');
    checkEqual('D01-T03 领取记录负责人', t03Claim.owner_actor_id, b1.actor_id);
    checkEqual('D01-T03 领取不创建 delivery', t03Claim.delivery_ids.length, 0);
    check(
      'D01-T03 领取后我的任务包含该任务',
      (await listTasks(b1Conn, { scope: 'mine' })).tasks.some(
        (task) => task.task_id === t03.task_id,
      ),
    );

    // 公开任务没有创建时负责人；领取产生的 assignment 不能反推创建参数。
    const t03ReplayParams = {
      room_id: roomId,
      title: 'T03 公开任务',
      description: '任何成员都可以领取。',
      source_message_id: t03Message.message.message_id,
      reviewer_actor_id: u1.actor_id,
    };
    const t03Replay = (await createTask(u1Conn, t03ReplayParams)).task;
    checkEqual(
      'D01-T03 公开任务领取后相同参数重放返回同一任务',
      t03Replay.task_id,
      t03.task_id,
    );
    checkEqual('D01-T03 重放返回领取后的状态', t03Replay.status, 'in_progress');
    checkEqual('D01-T03 重放返回领取后的负责人', t03Replay.owner_actor_id, b1.actor_id);
    checkEqual(
      'D01-T03 重放返回领取后的 assignment',
      t03Replay.assignment?.assignment_id,
      t03Claim.assignment?.assignment_id,
    );
    checkEqual('D01-T03 重放不创建 delivery', t03Replay.delivery_ids.length, 0);
    const t03RoomTasks = (await listTasks(b1Conn, { room_id: roomId, limit: 100 })).tasks.filter(
      (task) => task.task_id === t03.task_id,
    );
    checkEqual('D01-T03 重放后房间仍只有一个该任务', t03RoomTasks.length, 1);
    const t03Cards = (await callTool<{ items: { message_id: string; preview: string }[] }>(
      u1Conn.client,
      'network_history_list',
      { room_id: roomId, limit: 100 },
    )).items.filter((item) => item.preview === '【任务卡】T03 公开任务');
    checkEqual('D01-T03 重放后仍只有一张任务卡片', t03Cards.length, 1);

    // ---------- D01-T07：创建者立即 self-claim 后真实 HTTP 重放 ----------
    // 同一毫秒内 claim 产生的 v1 assignment 由创建者发出，不能反推为创建时
    // 负责人；60 轮真实 HTTP 同时覆盖非同一毫秒的普通路径。
    const selfClaimRounds = 60;
    let selfClaimReplayFailures = 0;
    let selfClaimStateFailures = 0;
    for (let round = 0; round < selfClaimRounds; round += 1) {
      const source = await sendMessage(
        u1Conn,
        roomId,
        `D01-T07 创建者自我领取来源 ${round}`,
      );
      const params = {
        room_id: roomId,
        title: `T07 创建者自我领取 ${round}`,
        description: '创建者立即领取后用相同参数重放。',
        source_message_id: source.message.message_id,
        reviewer_actor_id: u2.actor_id,
      };
      const created = (await createTask(u1Conn, params)).task;
      const claimed = (await callTool<TaskResult>(u1Conn.client, 'network_task_claim', {
        request_id: newRequestId('task_claim_self'),
        task_id: created.task_id,
      })).task;
      const replay = (await createTask(u1Conn, params)).task;
      if (replay.task_id !== created.task_id) selfClaimReplayFailures += 1;
      if (
        claimed.status !== 'in_progress' ||
        replay.status !== 'in_progress' ||
        replay.owner_actor_id !== u1.actor_id
      ) {
        selfClaimStateFailures += 1;
      }
    }
    checkEqual(
      `D01-T07 创建者自我领取后真实 HTTP ${selfClaimRounds} 次重放均返回原任务`,
      selfClaimReplayFailures,
      0,
    );
    checkEqual(
      'D01-T07 重放返回领取后的状态与负责人',
      selfClaimStateFailures,
      0,
    );

    // 公开领取必须原子：并发只有一个成功，失败方得到 CLAIM_CONFLICT 并看到真实负责人。
    const raceTask = (await createTask(u1Conn, {
      room_id: roomId,
      title: 'D01 并发领取',
      reviewer_actor_id: u1.actor_id,
    })).task;
    const raceAttempts = await Promise.allSettled([
      callTool<TaskResult>(b1Conn.client, 'network_task_claim', {
        request_id: newRequestId('task_claim_race'),
        task_id: raceTask.task_id,
      }),
      callTool<TaskResult>(b2Conn.client, 'network_task_claim', {
        request_id: newRequestId('task_claim_race'),
        task_id: raceTask.task_id,
      }),
    ]);
    const raceWinners = raceAttempts.filter(
      (item): item is PromiseFulfilledResult<TaskResult> => item.status === 'fulfilled',
    );
    const raceLosers = raceAttempts.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    checkEqual('D01 并发领取恰好一个成功', raceWinners.length, 1);
    check(
      'D01 并发领取失败方返回 CLAIM_CONFLICT',
      raceLosers.length === 1 &&
        raceLosers[0]?.reason instanceof ToolError &&
        raceLosers[0].reason.code === 'CLAIM_CONFLICT',
      raceLosers.map((item) => String(item.reason)),
    );
    const raceView = await getTask(u1Conn, raceTask.task_id);
    checkEqual('D01 并发领取后任务为 in_progress', raceView.status, 'in_progress');
    checkEqual(
      'D01 并发领取后负责人是成功方',
      raceView.owner_actor_id,
      raceWinners[0]?.value.task.owner_actor_id,
    );
    const loserSeen = await getTask(
      raceLosers[0]?.reason instanceof ToolError && raceWinners[0]?.value.task.owner_actor_id === b2.actor_id
        ? b1Conn
        : b2Conn,
      raceTask.task_id,
    );
    checkEqual('D01 失败方读取到真实负责人', loserSeen.owner_name, raceView.owner_name);

    // ---------- D01-T04：长正文完整读取、非成员与已移除成员不能直读 ----------
    const longDescription = `详细目标：${'验收正文'.repeat(2000)}`;
    check('D01-T04 长正文超过旧 120 字上限', longDescription.length > 120);
    const t04Message = await sendMessage(u1Conn, roomId, 'T04 来源消息：长目标');
    const t04 = (await createTask(u1Conn, {
      room_id: roomId,
      title: 'T04 短标题',
      description: longDescription,
      acceptance_criteria: '逐字核对完整目标与验收条件。',
      source_message_id: t04Message.message.message_id,
      reviewer_actor_id: u1.actor_id,
    })).task;
    checkEqual('D01-T04 短标题用于列表', t04.title, 'T04 短标题');
    const t04Read = await getTask(u1Conn, t04.task_id);
    checkEqual('D01-T04 长目标逐字返回', t04Read.description, longDescription);
    checkEqual(
      'D01-T04 验收条件完整返回',
      t04Read.acceptance_criteria,
      '逐字核对完整目标与验收条件。',
    );
    checkEqual('D01-T04 业务权威来源为站内', t04Read.business_authority, 'native');
    const t04RoomList = await listTasks(u1Conn, { room_id: roomId });
    const t04Entry = t04RoomList.tasks.find((task) => task.task_id === t04.task_id);
    checkEqual('D01-T04 列表显示短标题', t04Entry?.title, 'T04 短标题');

    await expectToolError(
      'D01-T04 非成员 task_id 直读返回 NOT_FOUND',
      callTool(outsiderConn.client, 'network_task_get', { task_id: t04.task_id }),
      'NOT_FOUND',
    );
    await expectToolError(
      'D01-T04 非成员列表返回 NOT_MEMBER',
      callTool(outsiderConn.client, 'network_task_list', { room_id: roomId }),
      'NOT_MEMBER',
    );

    await callTool(u1Conn.client, 'network_room_members_update', {
      request_id: newRequestId('member_remove'),
      room_id: roomId,
      remove: [removed.actor_id],
    });
    await expectToolError(
      'D01-T04 被移除成员直读任务返回 NOT_FOUND',
      callTool(removedConn.client, 'network_task_get', { task_id: t04.task_id }),
      'NOT_FOUND',
    );
    await expectToolError(
      'D01-T04 被移除成员列表返回 NOT_MEMBER',
      callTool(removedConn.client, 'network_task_list', { room_id: roomId }),
      'NOT_MEMBER',
    );

    // ---------- 权限与生命周期边界 ----------
    await expectToolError(
      'D01 验收人必须是房间有效成员',
      callTool(u1Conn.client, 'network_task_create', {
        request_id: newRequestId('task_create'),
        room_id: roomId,
        title: '非法验收人',
        reviewer_actor_id: outsider.actor_id,
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      'D01 验收人不能与负责人相同',
      callTool(u1Conn.client, 'network_task_create', {
        request_id: newRequestId('task_create'),
        room_id: roomId,
        title: '负责人兼验收人',
        assignee_actor_id: b2.actor_id,
        reviewer_actor_id: b2.actor_id,
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      'D01 自己执行必须指定独立验收人',
      callTool(u1Conn.client, 'network_task_create', {
        request_id: newRequestId('task_create'),
        room_id: roomId,
        title: '自己执行',
        assignee_actor_id: u1.actor_id,
      }),
      'INVALID_ARGUMENT',
    );

    // 指定接手 offer 的幂等与取消。
    const offerTask = (await createTask(u1Conn, {
      room_id: roomId,
      title: 'D01 指派与取消',
      description: '从公开任务转为指定 B2。',
      reviewer_actor_id: u1.actor_id,
    })).task;
    const b2PendingBefore = await pendingCount(b2Conn);
    const offerRequest = newRequestId('task_offer');
    const offered = (await callTool<TaskResult>(u1Conn.client, 'network_task_offer', {
      request_id: offerRequest,
      task_id: offerTask.task_id,
      assignee_actor_id: b2.actor_id,
      expected_revision: offerTask.revision,
    })).task;
    checkEqual('D01 offer 将公开任务转为 offered', offered.status, 'offered');
    checkEqual('D01 offer 生成单个 delivery', offered.delivery_ids.length, 1);
    checkEqual('D01 offer 增加 B2 pending_count', await pendingCount(b2Conn), b2PendingBefore + 1);
    const offerReplay = (await callTool<TaskResult>(u1Conn.client, 'network_task_offer', {
      request_id: offerRequest,
      task_id: offerTask.task_id,
      assignee_actor_id: b2.actor_id,
      expected_revision: offerTask.revision,
    })).task;
    checkEqual('D01 offer 重放返回同一 assignment', offerReplay.assignment?.assignment_id, offered.assignment?.assignment_id);
    checkEqual('D01 offer 重放不重复 pending', await pendingCount(b2Conn), b2PendingBefore + 1);

    const cancelled = (await callTool<TaskResult>(u1Conn.client, 'network_task_cancel', {
      request_id: newRequestId('task_cancel'),
      task_id: offered.task_id,
      reason: 'D01 验收取消指派',
    })).task;
    checkEqual('D01 取消任务后状态为 cancelled', cancelled.status, 'cancelled');
    checkEqual('D01 取消撤销 assignment', cancelled.assignment, null);
    checkEqual('D01 取消关闭 pending delivery', await pendingCount(b2Conn), b2PendingBefore);

    // D01-T05：附件引用进入任务视图，文件由任务引用保留。
    const uploaded = await uploadTestFile(u1Conn.token, {
      name: 'd01-task-attachment.txt',
      mimeType: 'text/plain',
      body: 'D01 task attachment',
    });
    await callTool(u1Conn.client, 'network_room_file_bind', {
      request_id: newRequestId('task_attachment_bind'),
      room_id: roomId,
      file_id: uploaded.fileId,
    });
    const attachmentTask = (await createTask(u1Conn, {
      room_id: roomId,
      title: 'D01 带附件任务',
      reviewer_actor_id: u1.actor_id,
      attachment_file_ids: [uploaded.fileId],
    })).task;
    checkEqual('D01-T05 任务附件数量为 1', attachmentTask.attachments.length, 1);
    checkEqual('D01-T05 任务附件保留 file_id', attachmentTask.attachments[0]?.file_id, uploaded.fileId);

    const summary = await callTool<TaskSummary>(u1Conn.client, 'network_task_summary', {});
    const roomSummary = summary.items.find((item) => item.room_id === roomId);
    check('D01 任务概览包含当前房间', Boolean(roomSummary), summary.items);
    check('D01 概览 total 覆盖已创建任务', (roomSummary?.total ?? 0) >= 5, roomSummary);

    console.log('D01 任务验收通过');
  } finally {
    await Promise.all(
      subscriptions.map((subscription) => subscription.close().catch(() => undefined)),
    );
    await Promise.all([
      u1Conn.close(),
      u2Conn.close(),
      b1Conn.close(),
      b2Conn.close(),
      removedConn.close(),
      outsiderConn.close(),
    ]);
  }
}

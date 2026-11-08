/**
 * D03 统一任务业务状态与进度验收（D03-T01..T04）。
 *
 * 只通过公开 MCP 工具调用，覆盖：
 * - D03-T01 get/list/summary 的状态、文案与阶段一致，非法流转被拒；
 * - D03-T02 delivery 完成只结束通知处理，不产生 accepted 或历史完成；
 * - D03-T03 进度幂等、乱序与旧 execution 版本拒绝，且不制造消息/未读/待办；
 * - D03-T04 非负责人、旧负责人、百分比与阻塞原因的持久化边界。
 *
 * `legacy_completed` 无法经 D03 工具创建，其“历史完成”文案由
 * `scripts/lib/room-task-summary-unit.ts` 使用真实迁移与内存 SQLite 验证。
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
  readResourceJson,
  sleep,
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

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

type TaskStatus =
  | 'unassigned'
  | 'offered'
  | 'in_progress'
  | 'blocked'
  | 'submitted'
  | 'accepted'
  | 'failed'
  | 'cancelled'
  | 'legacy_completed';

interface TaskProgressView {
  progress_id: string;
  revision: number;
  prior_status: TaskStatus;
  prior_status_label: string;
  status: TaskStatus;
  status_label: string;
  percent: number | null;
  note: string;
  blocked_reason: string | null;
  actor_id: string;
  actor_name: string;
  created_at: string;
}

interface TaskView {
  task_id: string;
  room_id: string;
  title: string;
  status: TaskStatus;
  status_label: string;
  status_hint: string;
  phase: 'dispatch' | 'execution' | 'review' | 'closed';
  phase_label: string;
  revision: number;
  owner_actor_id: string | null;
  owner_name: string | null;
  blocked_reason: string | null;
  blocked_at: string | null;
  last_progress_at: string | null;
  progress: TaskProgressView | null;
  progress_history?: TaskProgressView[];
  assignment: {
    assignment_id: string;
    assignment_version: number;
    owner_actor_id: string;
    status: string;
  } | null;
  delivery_ids: string[];
  can_report_progress: boolean;
  can_block: boolean;
  can_resume: boolean;
  can_accept: boolean;
}

interface TaskResult {
  task: TaskView;
}

interface TaskList {
  tasks: TaskView[];
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

interface DeliveryView {
  delivery_id: string;
  state: string;
  attempt: number;
  claim_id: string | null;
}

interface StreamSnapshot {
  pending_count: number;
  inbox_head_seq: string;
  rooms: {
    room_id: string;
    head_seq: string;
    my_last_read_seq: string;
    unread: boolean;
  }[];
}

interface StreamItemView {
  source?: string;
  attention?: string;
  room_id?: string;
  message_id?: string;
  task_id?: string;
  delivery_id?: string;
  change?: string;
  status?: string;
  revision?: number;
  changed_by?: string;
}

interface HistoryPage {
  items: { message_id: string }[];
}

type Collector = ReturnType<typeof notificationCollector>;

function errorDetails(reason: unknown): Record<string, unknown> {
  if (!(reason instanceof ToolError)) return {};
  const details = reason.body.details;
  return typeof details === 'object' && details !== null
    ? (details as Record<string, unknown>)
    : {};
}

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
): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_create', {
      request_id: newRequestId('d03_create'),
      ...args,
    })
  ).task;
}

async function getTask(connection: McpConnection, taskId: string): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_get', { task_id: taskId })
  ).task;
}

async function listTasks(
  connection: McpConnection,
  args: Record<string, unknown>,
): Promise<TaskList> {
  return callTool<TaskList>(connection.client, 'network_task_list', args);
}

async function summary(
  connection: McpConnection,
  roomId: string,
): Promise<TaskSummary> {
  return callTool<TaskSummary>(connection.client, 'network_task_summary', {
    room_ids: [roomId],
  });
}

function claim(connection: McpConnection, task: TaskView): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_claim', {
    request_id: newRequestId('d03_claim'),
    task_id: task.task_id,
    expected_revision: task.revision,
  });
}

function cancel(
  connection: McpConnection,
  task: TaskView,
  reason: string,
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_cancel', {
    request_id: newRequestId('d03_cancel'),
    task_id: task.task_id,
    reason,
    expected_revision: task.revision,
  });
}

interface ProgressOptions {
  requestId?: string;
  note?: string;
  percent?: number;
  expectedRevision?: number;
  assignmentId?: string;
  assignmentVersion?: number;
}

function report(
  connection: McpConnection,
  task: TaskView,
  options: ProgressOptions = {},
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_progress', {
    request_id: options.requestId ?? newRequestId('d03_progress'),
    task_id: task.task_id,
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.percent === undefined ? {} : { percent: options.percent }),
    ...(options.expectedRevision === undefined
      ? { expected_revision: task.revision }
      : { expected_revision: options.expectedRevision }),
    ...(options.assignmentId === undefined ? {} : { assignment_id: options.assignmentId }),
    ...(options.assignmentVersion === undefined
      ? {}
      : { assignment_version: options.assignmentVersion }),
  });
}

function block(
  connection: McpConnection,
  task: TaskView,
  reason: string,
  options: Omit<ProgressOptions, 'note' | 'percent'> = {},
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_block', {
    request_id: options.requestId ?? newRequestId('d03_block'),
    task_id: task.task_id,
    reason,
    ...(options.expectedRevision === undefined
      ? { expected_revision: task.revision }
      : { expected_revision: options.expectedRevision }),
    ...(options.assignmentId === undefined ? {} : { assignment_id: options.assignmentId }),
    ...(options.assignmentVersion === undefined
      ? {}
      : { assignment_version: options.assignmentVersion }),
  });
}

function resume(
  connection: McpConnection,
  task: TaskView,
  options: ProgressOptions = {},
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_resume', {
    request_id: options.requestId ?? newRequestId('d03_resume'),
    task_id: task.task_id,
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.expectedRevision === undefined
      ? { expected_revision: task.revision }
      : { expected_revision: options.expectedRevision }),
    ...(options.assignmentId === undefined ? {} : { assignment_id: options.assignmentId }),
    ...(options.assignmentVersion === undefined
      ? {}
      : { assignment_version: options.assignmentVersion }),
  });
}

function progressOf(task: TaskView, label: string): TaskProgressView {
  if (!task.progress) throw new Error(`${label}: 缺少 progress`);
  return task.progress;
}

export async function runTaskStatusAcceptance(): Promise<void> {
  console.log('· D03 任务业务状态与进度');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const b1Conn = await connectClient(newToken());
  const b2Conn = await connectClient(newToken());
  const subscriptions: McpSubscription[] = [];

  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'D03 创建者 U1' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'D03 成员 U2' });
    const b1 = await registerIdentity(b1Conn, {
      kind: 'agent',
      name: 'D03 Agent B1',
      sessionId: `d03_b1_${crypto.randomUUID()}`,
    });
    const b2 = await registerIdentity(b2Conn, {
      kind: 'agent',
      name: 'D03 Agent B2',
      sessionId: `d03_b2_${crypto.randomUUID()}`,
    });
    check(
      'D03 身份注册成功',
      Boolean(u1.actor_id && u2.actor_id && b1.actor_id && b2.actor_id),
    );

    for (const peer of [u2Conn, b1Conn, b2Conn]) {
      const peerId = (await callTool<Identity>(peer.client, 'network_me', {})).actor_id;
      await befriend(u1Conn, u1.actor_id, peer, peerId);
    }
    const group = await callTool<RoomDetail>(u1Conn.client, 'network_room_create', {
      request_id: newRequestId('d03_room'),
      kind: 'group',
      title: 'D03 任务状态验收群',
      members: [u2.actor_id, b1.actor_id, b2.actor_id],
    });
    const roomId = group.room.room_id;
    for (const connection of [u2Conn, b1Conn, b2Conn]) {
      await acceptGroupInvites(connection, roomId);
    }

    const u1Collector = notificationCollector(u1Conn.client);
    const b1Collector = notificationCollector(b1Conn.client);
    subscriptions.push(await openSubscription(u1Conn.client, [STREAM_URI]));
    subscriptions.push(await openSubscription(b1Conn.client, [STREAM_URI]));
    await callTool(b1Conn.client, 'network_login', {});
    await sleep(200);

    // ---------- D03-T01：统一状态、文案、列表/概览与非法流转 ----------
    const t01 = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D03-T01 状态流',
      reviewer_actor_id: u1.actor_id,
    });
    checkEqual('D03-T01 新建任务为 unassigned', t01.status, 'unassigned');
    checkEqual('D03-T01 新建任务文案为待领取', t01.status_label, '待领取');
    check('D03-T01 待领取提示说明可公开领取', t01.status_hint.includes('领取'), t01.status_hint);
    checkEqual('D03-T01 新建任务阶段为 dispatch', t01.phase, 'dispatch');
    checkEqual('D03-T01 新建任务阶段文案为派发', t01.phase_label, '派发');
    checkEqual('D03-T01 新建任务没有 progress', t01.progress, null);
    checkEqual('D03-T01 非负责人不能上报进度', t01.can_report_progress, false);

    const t01List = await listTasks(u2Conn, { room_id: roomId, limit: 50 });
    const t01ListEntry = t01List.tasks.find((task) => task.task_id === t01.task_id);
    checkEqual('D03-T01 列表与 task_get 状态一致', t01ListEntry?.status, 'unassigned');
    checkEqual('D03-T01 列表与 task_get 文案一致', t01ListEntry?.status_label, '待领取');
    checkEqual('D03-T01 列表与 task_get 阶段一致', t01ListEntry?.phase, 'dispatch');

    const t01SummaryBefore = (await summary(u2Conn, roomId)).items[0];
    checkEqual('D03-T01 概览 total 包含新任务', t01SummaryBefore?.total, 1);
    checkEqual('D03-T01 概览 pending 计入未领取', t01SummaryBefore?.pending, 1);
    checkEqual('D03-T01 概览 claimed 初始为 0', t01SummaryBefore?.claimed, 0);

    const t01Claimed = (await claim(b1Conn, t01)).task;
    checkEqual('D03-T01 领取后状态为 in_progress', t01Claimed.status, 'in_progress');
    checkEqual('D03-T01 领取后文案为进行中', t01Claimed.status_label, '进行中');
    checkEqual('D03-T01 领取后阶段为 execution', t01Claimed.phase, 'execution');
    checkEqual('D03-T01 领取后阶段文案为执行', t01Claimed.phase_label, '执行');
    checkEqual('D03-T01 负责人可以上报进度', t01Claimed.can_report_progress, true);
    checkEqual('D03-T01 负责人可以报告阻塞', t01Claimed.can_block, true);
    checkEqual('D03-T01 进行中不能恢复', t01Claimed.can_resume, false);
    checkEqual('D03-T01 领取后 assignment active', t01Claimed.assignment?.status, 'active');

    const t01SummaryClaimed = (await summary(b1Conn, roomId)).items[0];
    checkEqual('D03-T01 概览 claimed 只计当前负责人', t01SummaryClaimed?.claimed, 1);
    checkEqual('D03-T01 概览 pending 随领取归零', t01SummaryClaimed?.pending, 0);

    const t01Reported = (
      await report(b1Conn, t01Claimed, { note: '已完成数据核对', percent: 40 })
    ).task;
    checkEqual('D03-T01 上报进度不改变业务状态', t01Reported.status, 'in_progress');
    checkEqual('D03-T01 上报进度文案仍为进行中', t01Reported.status_label, '进行中');
    checkEqual('D03-T01 上报递增 revision', t01Reported.revision, t01Claimed.revision + 1);
    check('D03-T01 上报写入 last_progress_at', Boolean(t01Reported.last_progress_at));
    const t01Progress = progressOf(t01Reported, 'D03-T01 首次进度');
    checkEqual('D03-T01 进度 revision 与任务一致', t01Progress.revision, t01Reported.revision);
    checkEqual('D03-T01 进度前状态为 in_progress', t01Progress.prior_status, 'in_progress');
    checkEqual('D03-T01 进度状态保持 in_progress', t01Progress.status, 'in_progress');
    checkEqual('D03-T01 进度百分比持久化', t01Progress.percent, 40);
    checkEqual('D03-T01 进度说明持久化', t01Progress.note, '已完成数据核对');
    checkEqual('D03-T01 进度记录负责人', t01Progress.actor_id, b1.actor_id);
    checkEqual('D03-T01 进度记录负责人名称', t01Progress.actor_name, b1.name);
    const t01FirstGet = await getTask(b1Conn, t01.task_id);
    checkEqual('D03-T01 首次上报历史一条', t01FirstGet.progress_history?.length, 1);
    checkEqual('D03-T01 写操作结果不放大进度历史', t01Reported.progress_history, undefined);

    const t01GetAfter = await getTask(u2Conn, t01.task_id);
    checkEqual('D03-T01 get 返回同一 revision', t01GetAfter.revision, t01Reported.revision);
    checkEqual('D03-T01 get 返回同一进度', t01GetAfter.progress?.percent, 40);
    checkEqual('D03-T01 get 进度说明一致', t01GetAfter.progress?.note, '已完成数据核对');
    const t01ListAfter = await listTasks(u2Conn, { room_id: roomId, limit: 50 });
    const t01ListAfterEntry = t01ListAfter.tasks.find((task) => task.task_id === t01.task_id);
    checkEqual('D03-T01 列表进度与详情一致', t01ListAfterEntry?.progress?.percent, 40);
    checkEqual('D03-T01 列表 revision 与详情一致', t01ListAfterEntry?.revision, t01Reported.revision);
    checkEqual('D03-T01 列表不返回 progress_history', t01ListAfterEntry?.progress_history, undefined);

    const t01ReportedTwice = (
      await report(b1Conn, t01Reported, { note: '继续推进', percent: 75 })
    ).task;
    checkEqual('D03-T01 第二次上报再次递增 revision', t01ReportedTwice.revision, t01Reported.revision + 1);
    checkEqual('D03-T01 最新进度为 75', t01ReportedTwice.progress?.percent, 75);
    const t01SecondGet = await getTask(b1Conn, t01.task_id);
    checkEqual('D03-T01 第二次上报历史两条', t01SecondGet.progress_history?.length, 2);
    checkEqual(
      'D03-T01 历史按时间倒序',
      t01SecondGet.progress_history?.[0]?.percent,
      75,
    );

    const t01Blocked = (
      await block(b1Conn, t01ReportedTwice, '等待 U1 提供测试数据')
    ).task;
    checkEqual('D03-T01 阻塞后状态为 blocked', t01Blocked.status, 'blocked');
    checkEqual('D03-T01 阻塞文案为受阻', t01Blocked.status_label, '受阻');
    checkEqual('D03-T01 阻塞阶段仍为 execution', t01Blocked.phase, 'execution');
    checkEqual('D03-T01 阻塞原因写入任务', t01Blocked.blocked_reason, '等待 U1 提供测试数据');
    check('D03-T01 阻塞时间写入任务', Boolean(t01Blocked.blocked_at));
    checkEqual('D03-T01 阻塞后可以恢复', t01Blocked.can_resume, true);
    checkEqual('D03-T01 阻塞后不能上报进度', t01Blocked.can_report_progress, false);
    const t01BlockProgress = progressOf(t01Blocked, 'D03-T01 阻塞');
    checkEqual('D03-T01 阻塞审计前状态为 in_progress', t01BlockProgress.prior_status, 'in_progress');
    checkEqual('D03-T01 阻塞审计状态为 blocked', t01BlockProgress.status, 'blocked');
    checkEqual('D03-T01 阻塞审计保留原因', t01BlockProgress.blocked_reason, '等待 U1 提供测试数据');
    const t01BlockGet = await getTask(b1Conn, t01.task_id);
    checkEqual('D03-T01 阻塞审计历史三条', t01BlockGet.progress_history?.length, 3);
    const t01BlockedList = await listTasks(u2Conn, { room_id: roomId, limit: 50 });
    const t01BlockedEntry = t01BlockedList.tasks.find((task) => task.task_id === t01.task_id);
    checkEqual('D03-T01 列表同步显示受阻', t01BlockedEntry?.status_label, '受阻');
    checkEqual('D03-T01 受阻不重复计入 claimed', (await summary(b1Conn, roomId)).items[0]?.claimed, 0);

    const t01Resumed = (await resume(b1Conn, t01Blocked, { note: '数据已补齐' })).task;
    checkEqual('D03-T01 恢复后状态为 in_progress', t01Resumed.status, 'in_progress');
    checkEqual('D03-T01 恢复后文案为进行中', t01Resumed.status_label, '进行中');
    checkEqual('D03-T01 恢复清空 blocked_reason', t01Resumed.blocked_reason, null);
    checkEqual('D03-T01 恢复清空 blocked_at', t01Resumed.blocked_at, null);
    checkEqual('D03-T01 恢复后不能再次恢复', t01Resumed.can_resume, false);
    checkEqual('D03-T01 恢复后可以继续上报', t01Resumed.can_report_progress, true);
    const t01ResumeProgress = progressOf(t01Resumed, 'D03-T01 恢复');
    checkEqual('D03-T01 恢复审计前状态为 blocked', t01ResumeProgress.prior_status, 'blocked');
    checkEqual('D03-T01 恢复审计状态为 in_progress', t01ResumeProgress.status, 'in_progress');
    checkEqual('D03-T01 恢复审计说明持久化', t01ResumeProgress.note, '数据已补齐');
    const t01ResumeGet = await getTask(b1Conn, t01.task_id);
    checkEqual('D03-T01 恢复审计历史四条', t01ResumeGet.progress_history?.length, 4);
    checkEqual(
      'D03-T01 概览恢复后 claimed 回到 1',
      (await summary(b1Conn, roomId)).items[0]?.claimed,
      1,
    );

    const t01ResumeConflict = await expectToolError(
      'D03-T01 进行中不能再次恢复，返回 CONFLICT',
      resume(b1Conn, t01Resumed, { note: '重复恢复' }),
      'CONFLICT',
    );
    checkEqual(
      'D03-T01 非法恢复返回真实状态',
      errorDetails(t01ResumeConflict).status,
      'in_progress',
    );
    checkEqual(
      'D03-T01 非法恢复不推进 revision',
      (await getTask(b1Conn, t01.task_id)).revision,
      t01Resumed.revision,
    );

    const t01SecondBlock = (await block(b1Conn, t01Resumed, '再次受阻')).task;
    const t01BlockConflict = await expectToolError(
      'D03-T01 已阻塞不能再阻塞，返回 CONFLICT',
      block(b1Conn, t01SecondBlock, '重复阻塞'),
      'CONFLICT',
    );
    checkEqual('D03-T01 非法阻塞返回真实状态', errorDetails(t01BlockConflict).status, 'blocked');
    const t01SecondResumed = (
      await resume(b1Conn, t01SecondBlock, { note: '清理阻塞' })
    ).task;

    const t01Public = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D03-T01 未领取不能上报',
      reviewer_actor_id: u1.actor_id,
    });
    const t01PublicConflict = await expectToolError(
      'D03-T01 未领取任务不能上报进度',
      report(b1Conn, t01Public, { percent: 10 }),
      'CONFLICT',
    );
    checkEqual(
      'D03-T01 未领取非法上报返回真实状态',
      errorDetails(t01PublicConflict).status,
      'unassigned',
    );

    const t01Offered = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D03-T01 待接手不能上报',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const t01OfferedConflict = await expectToolError(
      'D03-T01 待接手任务不能上报进度',
      report(b1Conn, t01Offered, { percent: 10 }),
      'CONFLICT',
    );
    checkEqual(
      'D03-T01 待接手非法上报返回真实状态',
      errorDetails(t01OfferedConflict).status,
      'offered',
    );
    await cancel(u1Conn, t01Offered, 'D03-T01 清理待接手任务');

    const t01Cancelled = (await cancel(u1Conn, t01SecondResumed, 'D03-T01 结束任务')).task;
    checkEqual('D03-T01 取消后状态为 cancelled', t01Cancelled.status, 'cancelled');
    checkEqual('D03-T01 取消后文案为已取消', t01Cancelled.status_label, '已取消');
    checkEqual('D03-T01 取消后阶段为 closed', t01Cancelled.phase, 'closed');
    checkEqual('D03-T01 取消后阶段文案为已结束', t01Cancelled.phase_label, '已结束');
    checkEqual('D03-T01 取消后不能上报', t01Cancelled.can_report_progress, false);
    const t01CancelledConflict = await expectToolError(
      'D03-T01 已取消任务不能上报进度',
      report(b1Conn, t01Cancelled, { percent: 99 }),
      'CONFLICT',
    );
    checkEqual(
      'D03-T01 已取消非法上报返回真实状态',
      errorDetails(t01CancelledConflict).status,
      'cancelled',
    );
    const t01SummaryAfter = (await summary(b1Conn, roomId)).items[0];
    checkEqual('D03-T01 取消不进入 done', t01SummaryAfter?.done, 0);
    checkEqual('D03-T01 取消不计入 claimed', t01SummaryAfter?.claimed, 0);

    // ---------- D03-T02：delivery 完成不等于任务完成 ----------
    const t02 = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D03-T02 通知完成',
      assignee_actor_id: b2.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    checkEqual('D03-T02 指派后状态为 offered', t02.status, 'offered');
    checkEqual('D03-T02 指派后文案为待接手', t02.status_label, '待接手');
    checkEqual('D03-T02 指派后阶段为 dispatch', t02.phase, 'dispatch');
    checkEqual('D03-T02 指派生成 delivery', t02.delivery_ids.length, 1);

    const t02DeliveryId = t02.delivery_ids[0] as string;
    const t02Claim = await callTool<DeliveryView>(b2Conn.client, 'network_delivery_claim', {
      request_id: newRequestId('d03_delivery_claim'),
      delivery_id: t02DeliveryId,
    });
    checkEqual('D03-T02 delivery claim 只进入 claimed', t02Claim.state, 'claimed');
    checkEqual(
      'D03-T02 claim 不改变任务业务状态',
      (await getTask(u1Conn, t02.task_id)).status,
      'offered',
    );
    await callTool(b2Conn.client, 'network_delivery_complete', {
      request_id: newRequestId('d03_delivery_complete'),
      delivery_id: t02DeliveryId,
      attempt: t02Claim.attempt,
      claim_id: t02Claim.claim_id,
      final_body: '已收到任务通知，等待明确接手。',
      client_message_id: `d03_notice_${crypto.randomUUID()}`,
    });
    const t02AfterComplete = await getTask(u1Conn, t02.task_id);
    checkEqual('D03-T02 delivery 完成后任务仍为 offered', t02AfterComplete.status, 'offered');
    checkEqual('D03-T02 delivery 完成不伪造负责人', t02AfterComplete.owner_actor_id, null);
    checkEqual('D03-T02 delivery 完成不产生 accepted', t02AfterComplete.status === 'accepted', false);
    checkEqual('D03-T02 delivery 完成不写进度', t02AfterComplete.progress, null);
    checkEqual('D03-T02 delivery 完成不改变 revision', t02AfterComplete.revision, t02.revision);
    checkEqual(
      'D03-T02 delivery 完成后任务文案仍为待接手',
      t02AfterComplete.status_label,
      '待接手',
    );
    checkEqual(
      'D03-T02 delivery 完成后 delivery_ids 不变',
      t02AfterComplete.delivery_ids.join(','),
      t02.delivery_ids.join(','),
    );

    const t02Accepted = (
      await callTool<TaskResult>(b2Conn.client, 'network_task_accept', {
        request_id: newRequestId('d03_accept'),
        task_id: t02.task_id,
        assignment_id: t02.assignment?.assignment_id,
        expected_revision: t02AfterComplete.revision,
      })
    ).task;
    checkEqual('D03-T02 显式接受后为 in_progress', t02Accepted.status, 'in_progress');
    checkEqual('D03-T02 接受不是 accepted', t02Accepted.status === 'accepted', false);
    checkEqual('D03-T02 接受后文案为进行中', t02Accepted.status_label, '进行中');
    const t02Progressed = (
      await report(b2Conn, t02Accepted, { note: '通知处理后开始执行', percent: 20 })
    ).task;
    checkEqual('D03-T02 接受后上报保持 in_progress', t02Progressed.status, 'in_progress');
    checkEqual('D03-T02 上报后仍非 accepted', t02Progressed.status === 'accepted', false);
    const t02Cancelled = (
      await cancel(u1Conn, t02Progressed, 'D03-T02 结束任务')
    ).task;
    checkEqual('D03-T02 取消后为 cancelled', t02Cancelled.status, 'cancelled');
    checkEqual('D03-T02 取消文案为已取消', t02Cancelled.status_label, '已取消');
    check('D03-T02 全流程从未出现已验收文案', t02Cancelled.status_label !== '已验收');

    // ---------- D03-T03：进度幂等、乱序与不制造未读/待办 ----------
    const t03 = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D03-T03 乱序进度',
      reviewer_actor_id: u1.actor_id,
    });
    const t03Claimed = (await claim(b1Conn, t03)).task;
    const t03Base = await getTask(u1Conn, t03.task_id);
    const t03RoomBefore = await callTool<RoomDetail>(u1Conn.client, 'network_room_get', {
      room_id: roomId,
    });
    const t03InboxBefore = await inbox(b1Conn, 'pending');
    const t03StreamBefore = await readResourceJson<StreamSnapshot>(u1Conn.client, STREAM_URI);
    const t03HistoryBefore = await callTool<HistoryPage>(u1Conn.client, 'network_history_list', {
      room_id: roomId,
      limit: 50,
    });
    const t03RoomStreamBefore = t03StreamBefore.rooms.find((room) => room.room_id === roomId);
    const t03U1From = u1Collector.events.length;
    const t03B1From = b1Collector.events.length;
    const t03RequestId = newRequestId('d03_progress_replay');

    const t03First = (
      await report(b1Conn, t03Claimed, {
        requestId: t03RequestId,
        note: '第一次进度上报',
        percent: 30,
      })
    ).task;
    checkEqual('D03-T03 首次上报成功', t03First.progress?.percent, 30);
    checkEqual('D03-T03 首次上报 revision +1', t03First.revision, t03Base.revision + 1);
    const t03Notice = await waitForItem(
      u1Collector,
      t03U1From,
      (item) =>
        item.source === 'task.updated' &&
        item.change === 'progress_reported' &&
        item.task_id === t03.task_id,
      'D03-T03 人类成员收到进度刷新提示',
      3_000,
    );
    checkEqual('D03-T03 进度提示是 informational', t03Notice.attention, 'informational');
    checkEqual('D03-T03 进度提示携带业务 revision', t03Notice.revision, t03First.revision);
    checkEqual('D03-T03 进度提示记录操作者', t03Notice.changed_by, b1.actor_id);
    checkEqual('D03-T03 进度提示不带 delivery', t03Notice.delivery_id, undefined);

    const t03Replayed = (
      await report(b1Conn, t03Claimed, {
        requestId: t03RequestId,
        note: '第一次进度上报',
        percent: 30,
      })
    ).task;
    checkEqual('D03-T03 幂等重放返回同一 revision', t03Replayed.revision, t03First.revision);
    checkEqual(
      'D03-T03 幂等重放返回同一 progress_id',
      t03Replayed.progress?.progress_id,
      t03First.progress?.progress_id,
    );
    const t03AfterReplay = await getTask(u1Conn, t03.task_id);
    checkEqual('D03-T03 幂等重放不新增历史', t03AfterReplay.progress_history?.length, 1);
    checkEqual('D03-T03 幂等重放不推进 revision', t03AfterReplay.revision, t03First.revision);

    await expectToolError(
      'D03-T03 同一 request_id 改参数返回 IDEMPOTENCY_CONFLICT',
      report(b1Conn, t03Claimed, {
        requestId: t03RequestId,
        note: '不同的进度说明',
        percent: 31,
      }),
      'IDEMPOTENCY_CONFLICT',
    );

    await expectToolError(
      'D03-T03 旧 expected_revision 返回 VERSION_CONFLICT',
      report(b1Conn, t03AfterReplay, {
        note: '迟到更新',
        percent: 40,
        expectedRevision: t03Base.revision,
      }),
      'VERSION_CONFLICT',
    );
    await expectToolError(
      'D03-T03 旧 assignment_version 返回 ASSIGNMENT_STALE',
      report(b1Conn, t03AfterReplay, {
        note: '旧执行版本',
        percent: 50,
        assignmentVersion: 999,
      }),
      'ASSIGNMENT_STALE',
    );
    const t03AfterStale = await getTask(u1Conn, t03.task_id);
    checkEqual('D03-T03 旧版本失败不推进 revision', t03AfterStale.revision, t03First.revision);
    checkEqual('D03-T03 旧版本失败不新增历史', t03AfterStale.progress_history?.length, 1);

    const t03Race = await Promise.allSettled([
      report(b1Conn, t03AfterStale, { note: '并发更新 A', percent: 60 }),
      report(b1Conn, t03AfterStale, { note: '并发更新 B', percent: 61 }),
    ]);
    const t03Winners = t03Race.filter(
      (item): item is PromiseFulfilledResult<TaskResult> => item.status === 'fulfilled',
    );
    const t03Losers = t03Race.filter(
      (item): item is PromiseRejectedResult => item.status === 'rejected',
    );
    checkEqual('D03-T03 同 revision 并发上报只成功一次', t03Winners.length, 1);
    checkEqual('D03-T03 并发失败方只有一个', t03Losers.length, 1);
    const t03LoserReason = t03Losers[0]?.reason;
    check(
      'D03-T03 并发失败方返回版本冲突',
      t03LoserReason instanceof ToolError &&
        ['VERSION_CONFLICT', 'ASSIGNMENT_STALE'].includes(t03LoserReason.code),
      t03LoserReason instanceof ToolError ? t03LoserReason.code : String(t03LoserReason),
    );
    const t03Final = await getTask(u1Conn, t03.task_id);
    checkEqual('D03-T03 并发只推进一次 revision', t03Final.revision, t03First.revision + 1);
    checkEqual('D03-T03 并发只追加一条历史', t03Final.progress_history?.length, 2);
    checkEqual(
      'D03-T03 并发最新进度来自成功方',
      t03Final.progress?.percent,
      t03Winners[0]?.value.task.progress?.percent,
    );

    await sleep(600);
    const t03B1Items = streamItems(b1Collector, t03B1From).filter(
      (item) => item.task_id === t03.task_id,
    );
    checkEqual('D03-T03 进度不向 Agent 发任务提示', t03B1Items.length, 0);
    checkEqual(
      'D03-T03 进度不增加 Agent pending_count',
      (await inbox(b1Conn, 'pending')).pending_count,
      t03InboxBefore.pending_count,
    );
    checkEqual(
      'D03-T03 进度不新增 Agent 待办',
      (await inbox(b1Conn, 'pending')).items.map((item) => item.delivery_id).join(','),
      t03InboxBefore.items.map((item) => item.delivery_id).join(','),
    );
    const t03RoomAfter = await callTool<RoomDetail>(u1Conn.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual(
      'D03-T03 进度不推进房间 head_seq',
      t03RoomAfter.room.head_seq,
      t03RoomBefore.room.head_seq,
    );
    checkEqual(
      'D03-T03 进度不改变已读位置',
      t03RoomAfter.room.my_last_read_seq,
      t03RoomBefore.room.my_last_read_seq,
    );
    checkEqual(
      'D03-T03 进度不改变最后消息',
      t03RoomAfter.room.last_message?.message_id ?? null,
      t03RoomBefore.room.last_message?.message_id ?? null,
    );
    const t03HistoryAfter = await callTool<HistoryPage>(u1Conn.client, 'network_history_list', {
      room_id: roomId,
      limit: 50,
    });
    checkEqual(
      'D03-T03 进度不新增聊天消息',
      t03HistoryAfter.items.length,
      t03HistoryBefore.items.length,
    );
    const t03StreamAfter = await readResourceJson<StreamSnapshot>(u1Conn.client, STREAM_URI);
    checkEqual(
      'D03-T03 进度不改变 stream pending_count',
      t03StreamAfter.pending_count,
      t03StreamBefore.pending_count,
    );
    checkEqual(
      'D03-T03 进度不改变 stream inbox_head_seq',
      t03StreamAfter.inbox_head_seq,
      t03StreamBefore.inbox_head_seq,
    );
    const t03RoomStreamAfter = t03StreamAfter.rooms.find((room) => room.room_id === roomId);
    checkEqual(
      'D03-T03 进度不改变 stream 房间 head',
      t03RoomStreamAfter?.head_seq,
      t03RoomStreamBefore?.head_seq,
    );
    checkEqual(
      'D03-T03 进度不改变 stream 未读状态',
      t03RoomStreamAfter?.unread,
      t03RoomStreamBefore?.unread,
    );
    checkEqual(
      'D03-T03 进度不改变任务 delivery_ids',
      t03Final.delivery_ids.join(','),
      t03Claimed.delivery_ids.join(','),
    );
    await cancel(u1Conn, t03Final, 'D03-T03 结束任务');

    // ---------- D03-T04：旧负责人、越权与字段持久化 ----------
    const t04 = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D03-T04 权限与持久化',
      reviewer_actor_id: u1.actor_id,
    });
    const t04Claimed = (await claim(b1Conn, t04)).task;

    const t04NonOwner = await expectToolError(
      'D03-T04 非负责人上报返回 PERMISSION_DENIED',
      report(u2Conn, t04Claimed, { note: '越权进度', percent: 10 }),
      'PERMISSION_DENIED',
    );
    checkEqual(
      'D03-T04 越权错误携带真实负责人',
      errorDetails(t04NonOwner).owner_actor_id,
      b1.actor_id,
    );
    await expectToolError(
      'D03-T04 非负责人阻塞返回 PERMISSION_DENIED',
      block(u2Conn, t04Claimed, '越权阻塞'),
      'PERMISSION_DENIED',
    );
    const t04BeforeOwner = await getTask(u2Conn, t04.task_id);
    checkEqual('D03-T04 越权失败不推进 revision', t04BeforeOwner.revision, t04Claimed.revision);
    checkEqual('D03-T04 越权失败不写进度', t04BeforeOwner.progress, null);
    const t04EarlyBlocked = (
      await block(b1Conn, t04Claimed, '越权恢复前置阻塞')
    ).task;
    await expectToolError(
      'D03-T04 非负责人恢复返回 PERMISSION_DENIED',
      resume(u2Conn, t04EarlyBlocked, { note: '越权恢复' }),
      'PERMISSION_DENIED',
    );
    const t04Ready = (
      await resume(b1Conn, t04EarlyBlocked, { note: '负责人恢复' })
    ).task;
    const t04NonOwnerView = await getTask(u2Conn, t04.task_id);
    checkEqual('D03-T04 非负责人不能上报', t04NonOwnerView.can_report_progress, false);
    checkEqual('D03-T04 非负责人不能阻塞', t04NonOwnerView.can_block, false);
    checkEqual('D03-T04 非负责人不能恢复', t04NonOwnerView.can_resume, false);
    checkEqual('D03-T04 越权失败不写进度', t04NonOwnerView.progress?.actor_id, b1.actor_id);
    checkEqual('D03-T04 越权失败保留负责人', t04NonOwnerView.owner_actor_id, b1.actor_id);

    await expectToolError(
      'D03-T04 空进度上报返回 INVALID_ARGUMENT',
      report(b1Conn, t04Ready, { note: '   ' }),
      'INVALID_ARGUMENT',
    );
    checkEqual(
      'D03-T04 空进度失败不推进 revision',
      (await getTask(b1Conn, t04.task_id)).revision,
      t04Ready.revision,
    );

    const t04Percent = (
      await report(b1Conn, t04Ready, {
        note: '  多行进度  \n第二阶段完成  ',
        percent: 55,
      })
    ).task;
    checkEqual('D03-T04 百分比 55 持久化', t04Percent.progress?.percent, 55);
    checkEqual(
      'D03-T04 进度说明去除首尾空白并保留换行',
      t04Percent.progress?.note,
      '多行进度  \n第二阶段完成',
    );
    checkEqual('D03-T04 列表返回最新百分比', (await listTasks(u2Conn, {
      room_id: roomId,
      limit: 50,
    })).tasks.find((task) => task.task_id === t04.task_id)?.progress?.percent, 55);

    const t04Blocked = (
      await block(b1Conn, t04Percent, '  等待外部接口\n- 已联系对方  ')
    ).task;
    checkEqual('D03-T04 阻塞状态持久化', t04Blocked.status, 'blocked');
    checkEqual(
      'D03-T04 阻塞原因去除首尾空白并保留换行',
      t04Blocked.blocked_reason,
      '等待外部接口\n- 已联系对方',
    );
    checkEqual(
      'D03-T04 阻塞审计保留原因',
      t04Blocked.progress?.blocked_reason,
      '等待外部接口\n- 已联系对方',
    );
    const t04Resumed = (
      await resume(b1Conn, t04Blocked, { note: '接口已恢复' })
    ).task;
    checkEqual('D03-T04 恢复清空任务阻塞原因', t04Resumed.blocked_reason, null);
    checkEqual('D03-T04 恢复清空任务阻塞时间', t04Resumed.blocked_at, null);
    const t04History = await getTask(b1Conn, t04.task_id);
    checkEqual('D03-T04 恢复保留历史阻塞原因', t04History.progress_history?.[1]?.blocked_reason, '等待外部接口\n- 已联系对方');
    checkEqual('D03-T04 恢复审计状态', t04Resumed.progress?.status, 'in_progress');
    checkEqual('D03-T04 恢复审计前状态', t04Resumed.progress?.prior_status, 'blocked');
    checkEqual('D03-T04 恢复审计说明', t04Resumed.progress?.note, '接口已恢复');
    checkEqual('D03-T04 历史保留百分比', t04History.progress_history?.[2]?.percent, 55);

    // 旧负责人：B1 放弃投递后任务改派给 B2，B1 的旧视图不能再写进度。
    const t04Handover = await createTask(u1Conn, {
      room_id: roomId,
      title: 'D03-T04 旧负责人',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const t04Declined = (await callTool<TaskResult>(b1Conn.client, 'network_task_decline', {
      request_id: newRequestId('d03_decline'),
      task_id: t04Handover.task_id,
      assignment_id: t04Handover.assignment?.assignment_id,
      expected_revision: t04Handover.revision,
      reason: '不接手该任务',
    })).task;
    checkEqual('D03-T04 放弃后任务回到 unassigned', t04Declined.status, 'unassigned');
    const t04Reoffered = (
      await callTool<TaskResult>(u1Conn.client, 'network_task_offer', {
        request_id: newRequestId('d03_reoffer'),
        task_id: t04Handover.task_id,
        assignee_actor_id: b2.actor_id,
        expected_revision: t04Declined.revision,
      })
    ).task;
    const t04Accepted = (await callTool<TaskResult>(b2Conn.client, 'network_task_accept', {
      request_id: newRequestId('d03_accept_handover'),
      task_id: t04Handover.task_id,
      assignment_id: t04Reoffered.assignment?.assignment_id,
      expected_revision: t04Reoffered.revision,
    })).task;
    checkEqual('D03-T04 改派后由 B2 负责', t04Accepted.owner_actor_id, b2.actor_id);
    const t04OldOwner = await expectToolError(
      'D03-T04 旧负责人写入新执行期返回 ASSIGNMENT_STALE',
      report(b1Conn, t04Handover, { note: '旧负责人进度', percent: 80 }),
      'ASSIGNMENT_STALE',
    );
    checkEqual(
      'D03-T04 旧负责人错误携带新负责人',
      errorDetails(t04OldOwner).owner_actor_id,
      b2.actor_id,
    );
    checkEqual(
      'D03-T04 旧负责人覆盖失败后仍由 B2 负责',
      (await getTask(u1Conn, t04Handover.task_id)).owner_actor_id,
      b2.actor_id,
    );
    await cancel(u1Conn, t04Accepted, 'D03-T04 清理改派任务');
    await expectToolError(
      'D03-T04 已取消任务拒绝旧负责人上报',
      report(b1Conn, t04Handover, { note: '取消后进度', percent: 90 }),
      'CONFLICT',
    );

    console.log('D03 任务业务状态与进度验收通过');
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.close().catch(() => undefined)));
    await Promise.all([u1Conn.close(), u2Conn.close(), b1Conn.close(), b2Conn.close()]);
  }
}

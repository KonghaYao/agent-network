/**
 * D07 验收退回与重新交付（D07-T01..T03）。
 *
 * 只通过公开 MCP 工具验证：验收权限、版本绑定、逐项核对、并发单终态、
 * 重复通过的通知幂等、验收人退群与负责人失权后的状态。
 *
 * 覆盖：
 * - D07-T01 负责人自验、非验收人验收、旧版本验收与未通过 checklist 全部失败；
 *   正确通过后 accepted 为终态，重复通过返回同一快照；
 * - D07-T02 通过与退回并发只有一个终态，失败方得到 REVIEW_STALE；重复通过
 *   不重复通知、不增加 Agent pending_count、不推进 head_seq；
 * - D07-T03 验收人退群任务保持 submitted 且必须显式改派；负责人失权退回转
 *   blocked 且旧资格不复活；重交后对旧版本的迟到验收返回 REVIEW_STALE。
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

interface ChecklistItemView {
  item: string;
  passed: boolean;
  note: string;
}

interface SubmissionReviewView {
  reviewer_actor_id: string;
  reviewer_name: string;
  decision: 'accept' | 'return';
  reason: string;
  checklist: ChecklistItemView[];
  created_at: string;
}

interface SubmissionSummary {
  submission_id: string;
  version: number;
  status: string;
  submitted_at: string;
}

interface SubmissionView {
  submission_id: string;
  task_id: string;
  version: number;
  status: string;
  summary: string;
  assignment_id: string;
  assignment_version: number;
  submitted_by: string;
  reviewed_at: string | null;
  review: SubmissionReviewView | null;
  is_current: boolean;
}

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
  acceptance_criteria: string;
  status: string;
  revision: number;
  owner_actor_id: string | null;
  reviewer_actor_id: string;
  reviewer_available: boolean;
  accepted_at: string | null;
  blocked_reason: string | null;
  parent_task_id: string | null;
  related_task_id: string | null;
  assignment: TaskAssignmentView | null;
  current_submission: SubmissionSummary | null;
  can_submit: boolean;
  can_return: boolean;
  can_accept_review: boolean;
  can_set_reviewer: boolean;
}

interface TaskResult {
  task: TaskView;
}

interface SubmissionResult {
  submission: SubmissionView;
  task: TaskView;
}

interface StreamItemView {
  source?: string;
  attention?: string;
  task_id?: string;
  change?: string;
  status?: string;
  revision?: number;
  submission_id?: string;
  submission_version?: number;
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
    if (Date.now() > deadline) {
      const seen = streamItems(collector, from).map((item) => ({
        task_id: item.task_id,
        change: item.change,
      }));
      throw new Error(`${label}: 等待 stream item 超时 (${JSON.stringify(seen)})`);
    }
    await sleep(100);
  }
}

async function getTask(connection: McpConnection, taskId: string): Promise<TaskView> {
  return (await callTool<TaskResult>(connection.client, 'network_task_get', { task_id: taskId }))
    .task;
}

async function getSubmission(
  connection: McpConnection,
  taskId: string,
  version: number,
): Promise<SubmissionView> {
  return (
    await callTool<{ submission: SubmissionView }>(
      connection.client,
      'network_task_submission_get',
      { task_id: taskId, version },
    )
  ).submission;
}

async function createOfferedTask(
  connection: McpConnection,
  args: Record<string, unknown>,
): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_create', {
      request_id: newRequestId('d07_create'),
      ...args,
    })
  ).task;
}

async function acceptOffer(connection: McpConnection, task: TaskView): Promise<TaskView> {
  return (
    await callTool<TaskResult>(connection.client, 'network_task_accept', {
      request_id: newRequestId('d07_accept_offer'),
      task_id: task.task_id,
      ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
      expected_revision: task.revision,
    })
  ).task;
}

async function createOwnedTask(
  creatorConn: McpConnection,
  assigneeConn: McpConnection,
  args: Record<string, unknown>,
): Promise<TaskView> {
  const offered = await createOfferedTask(creatorConn, args);
  return acceptOffer(assigneeConn, offered);
}

function submitTask(
  connection: McpConnection,
  task: TaskView,
  summary: string,
): Promise<SubmissionResult> {
  return callTool<SubmissionResult>(connection.client, 'network_task_submit', {
    request_id: newRequestId('d07_submit'),
    task_id: task.task_id,
    summary,
    commit_sha: `abcdef${task.revision}`,
    expected_revision: task.revision,
    ...(task.assignment ? { assignment_id: task.assignment.assignment_id } : {}),
    ...(task.assignment ? { assignment_version: task.assignment.assignment_version } : {}),
  });
}

function checklistFor(criteria: string): Array<Record<string, unknown>> {
  return [
    {
      item: criteria,
      passed: true,
      note: 'D07 逐项核对通过',
    },
  ];
}

function reviewAccept(
  connection: McpConnection,
  task: TaskView,
  submissionId: string,
  version: number,
  checklist: Array<Record<string, unknown>>,
  options: { requestId?: string; expectedRevision?: number } = {},
): Promise<SubmissionResult> {
  return callTool<SubmissionResult>(connection.client, 'network_task_review_accept', {
    request_id: options.requestId ?? newRequestId('d07_review_accept'),
    task_id: task.task_id,
    submission_id: submissionId,
    version,
    checklist,
    ...(options.expectedRevision === undefined
      ? {}
      : { expected_revision: options.expectedRevision }),
  });
}

function reviewReturn(
  connection: McpConnection,
  task: TaskView,
  submissionId: string,
  version: number,
  reason: string,
  options: { requestId?: string; expectedRevision?: number } = {},
): Promise<SubmissionResult> {
  return callTool<SubmissionResult>(connection.client, 'network_task_review_return', {
    request_id: options.requestId ?? newRequestId('d07_review_return'),
    task_id: task.task_id,
    submission_id: submissionId,
    version,
    reason,
    ...(options.expectedRevision === undefined
      ? {}
      : { expected_revision: options.expectedRevision }),
  });
}

function reviewerSet(
  connection: McpConnection,
  task: TaskView,
  reviewerActorId: string,
): Promise<TaskResult> {
  return callTool<TaskResult>(connection.client, 'network_task_reviewer_set', {
    request_id: newRequestId('d07_reviewer_set'),
    task_id: task.task_id,
    reviewer_actor_id: reviewerActorId,
    expected_revision: task.revision,
  });
}

async function roomHead(connection: McpConnection, roomId: string): Promise<string> {
  const detail = await callTool<RoomDetail>(connection.client, 'network_room_get', {
    room_id: roomId,
  });
  return detail.room.head_seq;
}

async function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, code: error.code };
    throw error;
  }
}

export async function runTaskReviewAcceptance(): Promise<void> {
  console.log('· D07 验收退回与重新交付');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const u3Conn = await connectClient(newToken());
  const b1Conn = await connectClient(newToken());
  const b2Conn = await connectClient(newToken());
  const subscriptions: McpSubscription[] = [];

  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'D07 创建者 U1' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'D07 接任验收人 U2' });
    const u3 = await registerIdentity(u3Conn, { kind: 'human', name: 'D07 退群验收人 U3' });
    const b1 = await registerIdentity(b1Conn, {
      kind: 'agent',
      name: 'D07 执行 Agent B1',
      sessionId: `d07_b1_${crypto.randomUUID()}`,
    });
    const b2 = await registerIdentity(b2Conn, {
      kind: 'agent',
      name: 'D07 无关 Agent B2',
      sessionId: `d07_b2_${crypto.randomUUID()}`,
    });
    check(
      'D07 身份注册成功',
      [u1, u2, u3, b1, b2].every((identity) => Boolean(identity.actor_id)),
      { u1, u2, u3, b1, b2 },
    );

    for (const [connection, identity] of [
      [u2Conn, u2],
      [u3Conn, u3],
      [b1Conn, b1],
      [b2Conn, b2],
    ] as Array<[McpConnection, Identity]>) {
      await befriend(u1Conn, u1.actor_id, connection, identity.actor_id);
    }

    const group = await callTool<RoomDetail>(u1Conn.client, 'network_room_create', {
      request_id: newRequestId('d07_room'),
      kind: 'group',
      title: 'D07 验退回与重交验收群',
      members: [u2.actor_id, u3.actor_id, b1.actor_id, b2.actor_id],
    });
    const roomId = group.room.room_id;
    for (const connection of [u2Conn, u3Conn, b1Conn, b2Conn]) {
      await acceptGroupInvites(connection, roomId);
    }

    const u1Collector = notificationCollector(u1Conn.client);
    const b1Collector = notificationCollector(b1Conn.client);
    subscriptions.push(await openSubscription(u1Conn.client, [STREAM_URI]));
    subscriptions.push(await openSubscription(b1Conn.client, [STREAM_URI]));
    await callTool(b1Conn.client, 'network_login', {});
    await sleep(200);

    // ---------- D07-T01：权限、版本与逐项核对 ----------
    const t01 = await createOwnedTask(u1Conn, b1Conn, {
      room_id: roomId,
      title: 'D07-T01 验收权限',
      description: '验证验收人、版本与 checklist 约束',
      acceptance_criteria: 'D07-T01 逐项核对通过',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const t01Submitted = await submitTask(b1Conn, t01, 'D07-T01 首版成果');
    const t01Revision = t01Submitted.task.revision;
    checkEqual('D07-T01 提交后任务为 submitted', t01Submitted.task.status, 'submitted');
    checkEqual('D07-T01 提交生成 v1', t01Submitted.submission.version, 1);
    checkEqual(
      'D07-T01 验收人看到 can_accept_review',
      (await getTask(u1Conn, t01.task_id)).can_accept_review,
      true,
    );

    await expectToolError(
      'D07-T01 负责人自验返回 PERMISSION_DENIED',
      reviewAccept(
        b1Conn,
        t01Submitted.task,
        t01Submitted.submission.submission_id,
        1,
        checklistFor(t01.acceptance_criteria),
      ),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'D07-T01 非验收人验收返回 PERMISSION_DENIED',
      reviewAccept(
        b2Conn,
        t01Submitted.task,
        t01Submitted.submission.submission_id,
        1,
        checklistFor(t01.acceptance_criteria),
      ),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'D07-T01 负责人退回自己的成果返回 PERMISSION_DENIED',
      reviewReturn(
        b1Conn,
        t01Submitted.task,
        t01Submitted.submission.submission_id,
        1,
        '自我退回',
      ),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'D07-T01 针对旧版本的验收返回 REVIEW_STALE',
      reviewAccept(
        u1Conn,
        t01Submitted.task,
        t01Submitted.submission.submission_id,
        2,
        checklistFor(t01.acceptance_criteria),
      ),
      'REVIEW_STALE',
    );
    await expectToolError(
      'D07-T01 针对旧版本的退回返回 REVIEW_STALE',
      reviewReturn(
        u1Conn,
        t01Submitted.task,
        t01Submitted.submission.submission_id,
        2,
        '旧版本退回',
      ),
      'REVIEW_STALE',
    );
    await expectToolError(
      'D07-T01 存在未通过项时不能验收通过',
      reviewAccept(
        u1Conn,
        t01Submitted.task,
        t01Submitted.submission.submission_id,
        1,
        [{ item: t01.acceptance_criteria, passed: false, note: '缺少证据' }],
      ),
      'INVALID_ARGUMENT',
    );
    const t01StillSubmitted = await getTask(u1Conn, t01.task_id);
    checkEqual('D07-T01 失败尝试不改变任务状态', t01StillSubmitted.status, 'submitted');
    checkEqual('D07-T01 失败尝试不递增 revision', t01StillSubmitted.revision, t01Revision);

    const t01Accepted = await reviewAccept(
      u1Conn,
      t01Submitted.task,
      t01Submitted.submission.submission_id,
      1,
      checklistFor(t01.acceptance_criteria),
    );
    checkEqual('D07-T01 验收通过后任务为 accepted', t01Accepted.task.status, 'accepted');
    checkEqual('D07-T01 验收通过递增 revision', t01Accepted.task.revision, t01Revision + 1);
    check(
      'D07-T01 验收通过记录 accepted_at',
      typeof t01Accepted.task.accepted_at === 'string' &&
        t01Accepted.task.accepted_at.length > 0,
      t01Accepted.task.accepted_at,
    );
    checkEqual('D07-T01 submission 状态为 accepted', t01Accepted.submission.status, 'accepted');
    checkEqual(
      'D07-T01 review 决策为 accept',
      t01Accepted.submission.review?.decision,
      'accept',
    );
    checkEqual(
      'D07-T01 checklist 写入 review',
      t01Accepted.submission.review?.checklist.length,
      1,
    );
    checkEqual(
      'D07-T01 checklist 保留逐项结果',
      t01Accepted.submission.review?.checklist[0]?.passed,
      true,
    );
    checkEqual(
      'D07-T01 accepted 后不能再次验收',
      t01Accepted.task.can_accept_review,
      false,
    );
    const t01AcceptEvent = await waitForStreamItem(
      u1Collector,
      0,
      (item) => item.task_id === t01.task_id && item.change === 'accepted',
      'D07-T01 验收通过事件',
    );
    checkEqual('D07-T01 验收事件为 informational', t01AcceptEvent.attention, 'informational');
    const t01HeadAfterAccept = await roomHead(u1Conn, roomId);
    const t01PendingAfterAccept = (await inbox(b1Conn, 'pending')).pending_count;
    const t01AcceptedEvents = streamItems(u1Collector, 0).filter(
      (item) => item.task_id === t01.task_id && item.change === 'accepted',
    ).length;

    const t01Repeat = await reviewAccept(
      u1Conn,
      t01Accepted.task,
      t01Submitted.submission.submission_id,
      1,
      checklistFor(t01.acceptance_criteria),
    );
    checkEqual('D07-T01 重复通过返回同一任务 revision', t01Repeat.task.revision, t01Accepted.task.revision);
    checkEqual('D07-T01 重复通过返回同一 submission', t01Repeat.submission.submission_id, t01Submitted.submission.submission_id);
    checkEqual('D07-T01 重复通过仍为 accepted', t01Repeat.task.status, 'accepted');
    const t01AcceptedEventsAfter = streamItems(u1Collector, 0).filter(
      (item) => item.task_id === t01.task_id && item.change === 'accepted',
    ).length;
    checkEqual(
      'D07-T01 重复通过不重复通知',
      t01AcceptedEventsAfter,
      t01AcceptedEvents,
    );
    checkEqual(
      'D07-T01 重复通过不增加 Agent 待办',
      (await inbox(b1Conn, 'pending')).pending_count,
      t01PendingAfterAccept,
    );
    checkEqual(
      'D07-T01 重复通过不推进房间 head',
      await roomHead(u1Conn, roomId),
      t01HeadAfterAccept,
    );
    const t01ReviewGet = await getSubmission(u1Conn, t01.task_id, 1);
    checkEqual('D07-T01 读取 v1 仍为 accepted', t01ReviewGet.status, 'accepted');
    checkEqual(
      'D07-T01 读取 v1 保留 checklist',
      t01ReviewGet.review?.checklist.length,
      1,
    );
    const t01AgentEvents = streamItems(b1Collector, 0).filter(
      (item) => item.task_id === t01.task_id,
    );
    checkEqual('D07-T01 任务验收事件不唤醒 Agent', t01AgentEvents.length, 0);

    // 创建者自己执行时必须在创建阶段指定独立验收人。
    await expectToolError(
      'D07-T01 创建者自己执行且未指定验收人返回 INVALID_ARGUMENT',
      callTool(u1Conn.client, 'network_task_create', {
        request_id: newRequestId('d07_self_execute'),
        room_id: roomId,
        title: 'D07 自执行无独立验收人',
        assignee_actor_id: u1.actor_id,
      }),
      'INVALID_ARGUMENT',
    );

    // accepted 是终态；追加工作必须创建关联新任务。
    const t01FollowUp = await createOfferedTask(u1Conn, {
      room_id: roomId,
      title: 'D07-T01 追加工作',
      parent_task_id: t01.task_id,
      assignee_actor_id: u2.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    checkEqual('D07-T01 父任务关联已保存', t01FollowUp.parent_task_id, t01.task_id);
    const t01FollowUpGet = await getTask(u1Conn, t01FollowUp.task_id);
    checkEqual('D07-T01 详情返回 parent_task_id', t01FollowUpGet.parent_task_id, t01.task_id);
    await expectToolError(
      'D07-T01 父任务必须是已结束任务',
      callTool(u1Conn.client, 'network_task_create', {
        request_id: newRequestId('d07_parent_running'),
        room_id: roomId,
        title: 'D07 非法父任务',
        parent_task_id: t01FollowUp.task_id,
      }),
      'CONFLICT',
    );
    await expectToolError(
      'D07-T01 关联任务必须在同一房间',
      callTool(u1Conn.client, 'network_task_create', {
        request_id: newRequestId('d07_parent_missing'),
        room_id: roomId,
        title: 'D07 不存在关联任务',
        related_task_id: 'tsk_d07_missing_related',
      }),
      'NOT_FOUND',
    );

    // ---------- D07-T02：并发单终态与重复通过 ----------
    const t02 = await createOwnedTask(u1Conn, b1Conn, {
      room_id: roomId,
      title: 'D07-T02 通过退回并发',
      acceptance_criteria: 'D07-T02 并发只保留一个终态',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const t02Submitted = await submitTask(b1Conn, t02, 'D07-T02 并发版本');
    const t02Checklist = checklistFor(t02.acceptance_criteria);
    const t02Results = await Promise.all([
      settle(
        reviewAccept(
          u1Conn,
          t02Submitted.task,
          t02Submitted.submission.submission_id,
          1,
          t02Checklist,
          { requestId: newRequestId('d07_t02_accept') },
        ),
      ),
      settle(
        reviewReturn(
          u1Conn,
          t02Submitted.task,
          t02Submitted.submission.submission_id,
          1,
          'D07-T02 并发退回原因',
          { requestId: newRequestId('d07_t02_return') },
        ),
      ),
    ]);
    const t02Successes = t02Results.filter((result) => result.ok).length;
    checkEqual('D07-T02 通过与退回并发只有一个成功', t02Successes, 1);
    const t02Failure = t02Results.find(
      (result): result is { ok: false; code: string } => !result.ok,
    );
    checkEqual('D07-T02 并发失败方得到 REVIEW_STALE', t02Failure?.code, 'REVIEW_STALE');
    const t02Final = await getTask(u1Conn, t02.task_id);
    const t02FinalSubmission = await getSubmission(u1Conn, t02.task_id, 1);
    check(
      'D07-T02 并发后任务与 submission 终态一致',
      (t02Final.status === 'accepted' && t02FinalSubmission.status === 'accepted') ||
        (t02Final.status === 'in_progress' && t02FinalSubmission.status === 'returned'),
      { task: t02Final.status, submission: t02FinalSubmission.status },
    );
    const t02Events = streamItems(u1Collector, 0).filter(
      (item) =>
        item.task_id === t02.task_id &&
        (item.change === 'accepted' || item.change === 'returned'),
    );
    checkEqual('D07-T02 并发只产生一个验收结论事件', t02Events.length, 1);

    const t02b = await createOwnedTask(u1Conn, b1Conn, {
      room_id: roomId,
      title: 'D07-T02 重复通过幂等',
      acceptance_criteria: 'D07-T02 重复通过不重复通知',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const t02bSubmitted = await submitTask(b1Conn, t02b, 'D07-T02 幂等版本');
    const t02bAccepted = await reviewAccept(
      u1Conn,
      t02bSubmitted.task,
      t02bSubmitted.submission.submission_id,
      1,
      checklistFor(t02b.acceptance_criteria),
    );
    const t02bHead = await roomHead(u1Conn, roomId);
    const t02bPending = (await inbox(b1Conn, 'pending')).pending_count;
    const t02bEvents = (): number =>
      streamItems(u1Collector, 0).filter(
        (item) => item.task_id === t02b.task_id && item.change === 'accepted',
      ).length;
    const t02bEventCount = t02bEvents();
    const t02bRepeat = await reviewAccept(
      u1Conn,
      t02bAccepted.task,
      t02bSubmitted.submission.submission_id,
      1,
      checklistFor(t02b.acceptance_criteria),
      { requestId: newRequestId('d07_t02b_repeat') },
    );
    checkEqual('D07-T02 重复通过不改变 revision', t02bRepeat.task.revision, t02bAccepted.task.revision);
    checkEqual('D07-T02 重复通过事件数不变', t02bEvents(), t02bEventCount);
    checkEqual('D07-T02 重复通过不增加待办', (await inbox(b1Conn, 'pending')).pending_count, t02bPending);
    checkEqual('D07-T02 重复通过不推进 head', await roomHead(u1Conn, roomId), t02bHead);

    // ---------- D07-T03：验收人退群、负责人失权与迟到旧版本 ----------
    const t03a = await createOwnedTask(u1Conn, b1Conn, {
      room_id: roomId,
      title: 'D07-T03 验收人退群',
      acceptance_criteria: 'D07-T03 退群后必须显式改派',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u3.actor_id,
    });
    const t03aSubmitted = await submitTask(b1Conn, t03a, 'D07-T03 退群前版本');
    await callTool(u3Conn.client, 'network_room_leave', {
      request_id: newRequestId('d07_u3_leave'),
      room_id: roomId,
      confirm_in_flight: true,
    });
    const t03aAfterLeave = await getTask(u1Conn, t03a.task_id);
    checkEqual('D07-T03 验收人退群后任务保持 submitted', t03aAfterLeave.status, 'submitted');
    checkEqual('D07-T03 验收人退群后标记不可用', t03aAfterLeave.reviewer_available, false);
    checkEqual(
      'D07-T03 任务不会自动通过',
      (await getSubmission(u1Conn, t03a.task_id, 1)).status,
      'pending',
    );
    await expectToolError(
      'D07-T03 退群验收人的迟到通过被拒绝',
      reviewAccept(
        u3Conn,
        t03aSubmitted.task,
        t03aSubmitted.submission.submission_id,
        1,
        checklistFor(t03a.acceptance_criteria),
      ),
      'NOT_FOUND',
    );
    await expectToolError(
      'D07-T03 退群验收人的迟到退回被拒绝',
      reviewReturn(
        u3Conn,
        t03aSubmitted.task,
        t03aSubmitted.submission.submission_id,
        1,
        '退群后迟到退回',
      ),
      'NOT_FOUND',
    );
    await expectToolError(
      'D07-T03 无权限成员不能改派验收人',
      reviewerSet(b2Conn, t03aAfterLeave, u2.actor_id),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'D07-T03 不能把负责人设为验收人',
      reviewerSet(u1Conn, t03aAfterLeave, b1.actor_id),
      'INVALID_ARGUMENT',
    );
    const t03aReassigned = await reviewerSet(u1Conn, t03aAfterLeave, u2.actor_id);
    checkEqual('D07-T03 改派后验收人更新', t03aReassigned.task.reviewer_actor_id, u2.actor_id);
    checkEqual('D07-T03 改派递增 revision', t03aReassigned.task.revision, t03aAfterLeave.revision + 1);
    checkEqual('D07-T03 改派后任务仍为 submitted', t03aReassigned.task.status, 'submitted');
    checkEqual('D07-T03 改派后验收人可用', t03aReassigned.task.reviewer_available, true);
    const t03aAccepted = await reviewAccept(
      u2Conn,
      t03aReassigned.task,
      t03aSubmitted.submission.submission_id,
      1,
      checklistFor(t03a.acceptance_criteria),
    );
    checkEqual('D07-T03 新验收人可以完成通过', t03aAccepted.task.status, 'accepted');

    const t03b = await createOwnedTask(u1Conn, b1Conn, {
      room_id: roomId,
      title: 'D07-T03 负责人失权退回',
      acceptance_criteria: 'D07-T03 失权后退回转 blocked',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const t03bSubmitted = await submitTask(b1Conn, t03b, 'D07-T03 失权前版本');
    await callTool(u1Conn.client, 'network_room_members_update', {
      request_id: newRequestId('d07_remove_b1'),
      room_id: roomId,
      remove: [b1.actor_id],
    });
    const t03bReturned = await reviewReturn(
      u1Conn,
      t03bSubmitted.task,
      t03bSubmitted.submission.submission_id,
      1,
      'D07-T03 负责人已离开房间，任务转为 blocked',
    );
    checkEqual('D07-T03 负责人失权退回后任务 blocked', t03bReturned.task.status, 'blocked');
    checkEqual('D07-T03 blocked 记录原因', t03bReturned.task.blocked_reason, 'owner_lost_eligibility');
    checkEqual('D07-T03 blocked 不保留负责人', t03bReturned.task.owner_actor_id, null);
    checkEqual('D07-T03 blocked 不保留 assignment', t03bReturned.task.assignment, null);
    checkEqual('D07-T03 旧 submission 为 returned', t03bReturned.submission.status, 'returned');
    checkEqual(
      'D07-T03 失权退回递增 revision',
      t03bReturned.task.revision,
      t03bSubmitted.task.revision + 1,
    );
    await expectToolError(
      'D07-T03 失权负责人不能继续读取任务',
      getTask(b1Conn, t03b.task_id),
      'NOT_FOUND',
    );
    await callTool(u1Conn.client, 'network_room_members_update', {
      request_id: newRequestId('d07_readd_b1'),
      room_id: roomId,
      add: [b1.actor_id],
    });

    const t03c = await createOwnedTask(u1Conn, b1Conn, {
      room_id: roomId,
      title: 'D07-T03 重交后迟到旧版本',
      acceptance_criteria: 'D07-T03 旧版本不能覆盖新提交',
      assignee_actor_id: b1.actor_id,
      reviewer_actor_id: u1.actor_id,
    });
    const t03cV1 = await submitTask(b1Conn, t03c, 'D07-T03 v1');
    const t03cReturned = await reviewReturn(
      u1Conn,
      t03cV1.task,
      t03cV1.submission.submission_id,
      1,
      'D07-T03 请补充边界证据后重提',
    );
    checkEqual('D07-T03 退回后任务回到 in_progress', t03cReturned.task.status, 'in_progress');
    checkEqual('D07-T03 退回生成新 assignment_version', t03cReturned.task.assignment?.assignment_version, 2);
    checkEqual(
      'D07-T03 退回重建 active assignment',
      t03cReturned.task.assignment?.status,
      'active',
    );
    const t03cV2 = await submitTask(b1Conn, t03cReturned.task, 'D07-T03 v2');
    checkEqual('D07-T03 重交生成 v2', t03cV2.submission.version, 2);
    await expectToolError(
      'D07-T03 重交后对 v1 的迟到通过返回 REVIEW_STALE',
      reviewAccept(
        u1Conn,
        t03cV2.task,
        t03cV1.submission.submission_id,
        1,
        checklistFor(t03c.acceptance_criteria),
      ),
      'REVIEW_STALE',
    );
    await expectToolError(
      'D07-T03 重交后对 v1 的迟到退回返回 REVIEW_STALE',
      reviewReturn(
        u1Conn,
        t03cV2.task,
        t03cV1.submission.submission_id,
        1,
        '重交后迟到退回',
      ),
      'REVIEW_STALE',
    );
    const t03cAccepted = await reviewAccept(
      u1Conn,
      t03cV2.task,
      t03cV2.submission.submission_id,
      2,
      checklistFor(t03c.acceptance_criteria),
    );
    checkEqual('D07-T03 新版本可以正常通过', t03cAccepted.task.status, 'accepted');
    const t03cV1Get = await getSubmission(u1Conn, t03c.task_id, 1);
    checkEqual('D07-T03 v1 保留退回结论', t03cV1Get.status, 'returned');
    checkEqual('D07-T03 v1 review 为 return', t03cV1Get.review?.decision, 'return');
    checkEqual('D07-T03 v1 不再是当前版本', t03cV1Get.is_current, false);
    const t03cV2Get = await getSubmission(u1Conn, t03c.task_id, 2);
    checkEqual('D07-T03 v2 为当前版本', t03cV2Get.is_current, true);
    checkEqual('D07-T03 v2 review 为 accept', t03cV2Get.review?.decision, 'accept');
  } finally {
    for (const subscription of subscriptions) {
      try {
        await subscription.close();
      } catch {
        // 订阅关闭失败不掩盖测试结果。
      }
    }
    for (const connection of [u1Conn, u2Conn, u3Conn, b1Conn, b2Conn]) {
      await connection.close();
    }
  }
}

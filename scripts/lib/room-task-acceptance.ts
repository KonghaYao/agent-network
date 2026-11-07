/**
 * 房间任务端到端验收：权限、状态机、幂等、摘要、任务流事件与“无未读/无 inbox”。
 *
 * 使用独立身份与群房间；只通过公开工具调用，本地与远端部署都能运行。
 */

import type { McpSubscription } from '@modelcontextprotocol/client';
import { resolve } from 'node:path';

import {
  baseUrl,
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
  type McpConnection,
} from './harness';
import { befriend, inbox, registerIdentity, type LoginResult, type RoomDetail } from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface TaskView {
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

interface TaskList {
  tasks: TaskView[];
  total: number;
  done: number;
}

interface TaskResult {
  task: TaskView;
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

interface StreamItemView {
  source?: string;
  kind?: string;
  attention?: string;
  room_id?: string;
  ref_id?: string;
  change?: string;
  status?: string;
}

interface CollectedEvent {
  method: string;
  params: Record<string, unknown>;
}

type Collector = ReturnType<typeof notificationCollector>;

function taskItems(collector: Collector, from: number): StreamItemView[] {
  const items: StreamItemView[] = [];
  for (const event of collector.events.slice(from)) {
    if (event.params.uri !== STREAM_URI) continue;
    const meta = event.params._meta as Record<string, unknown> | undefined;
    const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
    if (payload?.items) items.push(...payload.items);
  }
  return items;
}

async function waitForTaskItem(
  collector: Collector,
  from: number,
  predicate: (item: StreamItemView) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<StreamItemView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = taskItems(collector, from).find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`${label}: 等待任务 stream item 超时`);
    await sleep(100);
  }
}

async function listTasks(connection: McpConnection, roomId: string): Promise<TaskList> {
  return callTool<TaskList>(connection.client, 'network_task_list_get', { room_id: roomId });
}

export async function runRoomTaskAcceptance(): Promise<void> {
  console.log('· 房间任务');
  const humanConn = await connectClient(newToken());
  const agentAConn = await connectClient(newToken());
  const agentBConn = await connectClient(newToken());
  const outsiderConn = await connectClient(newToken());
  const subscriptions: McpSubscription[] = [];

  try {
    const human = await registerIdentity(humanConn, { kind: 'human', name: '任务验收人类' });
    const agentA = await registerIdentity(agentAConn, {
      kind: 'agent',
      name: '任务验收 Agent A',
      sessionId: `task_a_${crypto.randomUUID()}`,
    });
    const agentB = await registerIdentity(agentBConn, {
      kind: 'agent',
      name: '任务验收 Agent B',
      sessionId: `task_b_${crypto.randomUUID()}`,
    });
    const outsider = await registerIdentity(outsiderConn, {
      kind: 'agent',
      name: '任务验收外部 Agent',
      sessionId: `task_c_${crypto.randomUUID()}`,
    });
    check('任务验收身份注册成功', Boolean(
      human.actor_id && agentA.actor_id && agentB.actor_id && outsider.actor_id,
    ));

    await befriend(humanConn, human.actor_id, agentAConn, agentA.actor_id);
    await befriend(humanConn, human.actor_id, agentBConn, agentB.actor_id);
    const group = await callTool<RoomDetail>(humanConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      title: '任务验收群',
      members: [agentA.actor_id, agentB.actor_id],
    });
    const roomId = group.room.room_id;
    // 第二/第三房间用于验证 login 与 per-room summary 的跨房间聚合和成员过滤。
    const secondRoom = await callTool<RoomDetail>(humanConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [agentA.actor_id],
    });
    const secondRoomId = secondRoom.room.room_id;
    const thirdRoom = await callTool<RoomDetail>(humanConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [agentB.actor_id],
    });
    const thirdRoomId = thirdRoom.room.room_id;
    for (const created of [group, secondRoom, thirdRoom]) {
      await callTool(humanConn.client, 'network_room_mark_read', {
        room_id: created.room.room_id,
        through_seq: created.room.head_seq,
      });
    }
    const headBefore = (await callTool<RoomDetail>(humanConn.client, 'network_room_get', {
      room_id: roomId,
    })).room.head_seq;
    const aPendingBefore = (await inbox(agentAConn, 'pending')).pending_count;

    const initial = await listTasks(humanConn, roomId);
    checkEqual('任务列表初始为空', initial.total, 0);
    checkEqual('任务列表初始 done 为 0', initial.done, 0);

    const addRequest = newRequestId('task_add');
    const added = await callTool<TaskResult>(humanConn.client, 'network_task_add', {
      request_id: addRequest,
      room_id: roomId,
      description: '  验收任务一  ',
    });
    const task1 = added.task;
    checkEqual('任务描述被 trim', task1.description, '验收任务一');
    checkEqual('新任务为 pending', task1.status, 'pending');
    checkEqual('新任务创建者为 human', task1.created_by, human.actor_id);
    check('human 创建者可编辑任务', task1.can_edit);
    check('human 不能 claim 任务', !task1.can_claim);

    const addReplay = await callTool<TaskResult>(humanConn.client, 'network_task_add', {
      request_id: addRequest,
      room_id: roomId,
      description: '  验收任务一  ',
    });
    checkEqual('add 幂等重放返回同一任务', addReplay.task.task_id, task1.task_id);
    await expectToolError(
      'add 同 request_id 不同描述返回 IDEMPOTENCY_CONFLICT',
      callTool(humanConn.client, 'network_task_add', {
        request_id: addRequest,
        room_id: roomId,
        description: '不同描述',
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectToolError(
      '任务描述超过 120 字返回 INVALID_ARGUMENT',
      callTool(humanConn.client, 'network_task_add', {
        request_id: newRequestId('task_add'),
        room_id: roomId,
        description: '任'.repeat(121),
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      '任务描述含换行返回 INVALID_ARGUMENT',
      callTool(humanConn.client, 'network_task_add', {
        request_id: newRequestId('task_add'),
        room_id: roomId,
        description: '第一行\n第二行',
      }),
      'INVALID_ARGUMENT',
    );

    await expectToolError(
      'human 不能 claim 任务',
      callTool(humanConn.client, 'network_task_claim', {
        request_id: newRequestId('task_claim'),
        task_id: task1.task_id,
      }),
      'INVALID_ARGUMENT',
    );
    const claimRequest = newRequestId('task_claim');
    const claimed = await callTool<TaskResult>(agentAConn.client, 'network_task_claim', {
      request_id: claimRequest,
      task_id: task1.task_id,
    });
    checkEqual('Agent claim 后状态为 claimed', claimed.task.status, 'claimed');
    checkEqual('claim 记录 assignee', claimed.task.assignee_actor_id, agentA.actor_id);
    check('assignee 可以 complete', claimed.task.can_complete);
    const claimReplay = await callTool<TaskResult>(agentAConn.client, 'network_task_claim', {
      request_id: claimRequest,
      task_id: task1.task_id,
    });
    checkEqual('claim 幂等重放返回同一 assignee', claimReplay.task.assignee_actor_id, agentA.actor_id);
    await expectToolError(
      '重复 claim 返回 CLAIM_CONFLICT',
      callTool(agentBConn.client, 'network_task_claim', {
        request_id: newRequestId('task_claim'),
        task_id: task1.task_id,
      }),
      'CLAIM_CONFLICT',
    );
    await expectToolError(
      '非 assignee complete 返回 CLAIM_CONFLICT',
      callTool(agentBConn.client, 'network_task_complete', {
        request_id: newRequestId('task_done'),
        task_id: task1.task_id,
        result: '越权完成',
      }),
      'CLAIM_CONFLICT',
    );

    const completeRequest = newRequestId('task_done');
    const completed = await callTool<TaskResult>(agentAConn.client, 'network_task_complete', {
      request_id: completeRequest,
      task_id: task1.task_id,
      result: '已完成验收',
    });
    checkEqual('complete 后状态为 done', completed.task.status, 'done');
    checkEqual('complete 保存结果', completed.task.result, '已完成验收');
    check('complete 记录完成时间', Boolean(completed.task.completed_at));
    const completeReplay = await callTool<TaskResult>(agentAConn.client, 'network_task_complete', {
      request_id: completeRequest,
      task_id: task1.task_id,
      result: '已完成验收',
    });
    checkEqual('complete 幂等重放返回 done', completeReplay.task.status, 'done');
    await expectToolError(
      '再次 complete 同一任务返回 CLAIM_CONFLICT',
      callTool(agentAConn.client, 'network_task_complete', {
        request_id: newRequestId('task_done'),
        task_id: task1.task_id,
        result: '重复完成',
      }),
      'CLAIM_CONFLICT',
    );

    const listAfterDone = await listTasks(humanConn, roomId);
    checkEqual('列表 total 为 1', listAfterDone.total, 1);
    checkEqual('列表 done 为 1', listAfterDone.done, 1);
    checkEqual('列表返回 done 状态', listAfterDone.tasks[0]?.status, 'done');

    const task2 = (await callTool<TaskResult>(agentAConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: roomId,
      description: 'Agent 添加的失败任务',
    })).task;
    checkEqual('Agent 成员可添加任务', task2.created_by, agentA.actor_id);
    await callTool(agentBConn.client, 'network_task_claim', {
      request_id: newRequestId('task_claim'),
      task_id: task2.task_id,
    });
    const failed = await callTool<TaskResult>(agentBConn.client, 'network_task_fail', {
      request_id: newRequestId('task_fail'),
      task_id: task2.task_id,
      error: '缺少测试环境',
    });
    checkEqual('fail 后状态为 failed', failed.task.status, 'failed');
    checkEqual('fail 保存错误', failed.task.result, '缺少测试环境');

    await expectToolError(
      '非创建者/非 owner 修改描述返回 NOT_OWNER',
      callTool(agentBConn.client, 'network_task_update', {
        request_id: newRequestId('task_update'),
        task_id: task2.task_id,
        description: '越权修改',
      }),
      'NOT_OWNER',
    );
    const task3 = (await callTool<TaskResult>(agentAConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: roomId,
      description: '创建者可改的任务',
    })).task;
    const updatedByCreator = await callTool<TaskResult>(agentAConn.client, 'network_task_update', {
      request_id: newRequestId('task_update'),
      task_id: task3.task_id,
      description: '创建者更新后的描述',
    });
    checkEqual('创建者可修改描述', updatedByCreator.task.description, '创建者更新后的描述');
    const updatedByOwner = await callTool<TaskResult>(humanConn.client, 'network_task_update', {
      request_id: newRequestId('task_update'),
      task_id: task3.task_id,
      description: 'owner 更新后的描述',
    });
    checkEqual('房间 owner 可修改描述', updatedByOwner.task.description, 'owner 更新后的描述');
    checkEqual('修改描述不改变状态', updatedByOwner.task.status, 'pending');
    await expectToolError(
      '非创建者/非 owner 删除任务返回 NOT_OWNER',
      callTool(agentBConn.client, 'network_task_delete', {
        request_id: newRequestId('task_delete'),
        task_id: task3.task_id,
      }),
      'NOT_OWNER',
    );
    const deletedTask2 = await callTool<{ task_id: string; deleted: true }>(
      humanConn.client,
      'network_task_delete',
      { request_id: newRequestId('task_delete'), task_id: task2.task_id },
    );
    checkEqual('房间 owner 可删除他人创建的任务', deletedTask2.task_id, task2.task_id);

    const task4 = (await callTool<TaskResult>(humanConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: roomId,
      description: '待领取任务',
    })).task;
    const listFinal = await listTasks(agentAConn, roomId);
    checkEqual('删除后列表 total 正确', listFinal.total, 3);
    checkEqual('删除后列表 done 正确', listFinal.done, 1);
    check('列表包含待领取任务', listFinal.tasks.some((task) => task.task_id === task4.task_id));

    const summary = await callTool<TaskSummary>(humanConn.client, 'network_task_summary', {});
    const groupSummary = summary.items.find((item) => item.room_id === roomId);
    checkEqual('summary 返回当前房间 total', groupSummary?.total, 3);
    checkEqual('summary 返回当前房间 done', groupSummary?.done, 1);
    const filtered = await callTool<TaskSummary>(humanConn.client, 'network_task_summary', {
      room_ids: [roomId, 'rm_not_a_member'],
    });
    checkEqual('summary 过滤只返回 active 房间', filtered.items.length, 1);
    checkEqual('summary 过滤保留目标房间', filtered.items[0]?.room_id, roomId);

    await expectToolError(
      '非成员读取任务列表返回 NOT_MEMBER',
      listTasks(outsiderConn, roomId),
      'NOT_MEMBER',
    );
    await expectToolError(
      '非成员添加任务返回 NOT_MEMBER',
      callTool(outsiderConn.client, 'network_task_add', {
        request_id: newRequestId('task_add'),
        room_id: roomId,
        description: '越权添加',
      }),
      'NOT_MEMBER',
    );
    const outsiderSummary = await callTool<TaskSummary>(
      outsiderConn.client,
      'network_task_summary',
      { room_ids: [roomId] },
    );
    checkEqual('summary 不暴露非成员房间', outsiderSummary.items.length, 0);

    // 概览语义：claimed 只含当前 actor；pending/done/failed/total 是房间总量。
    const taskMine = (await callTool<TaskResult>(humanConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: roomId,
      description: 'A 自己领取的任务',
    })).task;
    await callTool(agentAConn.client, 'network_task_claim', {
      request_id: newRequestId('task_claim'),
      task_id: taskMine.task_id,
    });
    const taskOther = (await callTool<TaskResult>(humanConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: roomId,
      description: 'B 领取的任务',
    })).task;
    await callTool(agentBConn.client, 'network_task_claim', {
      request_id: newRequestId('task_claim'),
      task_id: taskOther.task_id,
    });
    const taskFailedByOther = (await callTool<TaskResult>(humanConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: roomId,
      description: 'B 失败的任务',
    })).task;
    await callTool(agentBConn.client, 'network_task_claim', {
      request_id: newRequestId('task_claim'),
      task_id: taskFailedByOther.task_id,
    });
    await callTool(agentBConn.client, 'network_task_fail', {
      request_id: newRequestId('task_fail'),
      task_id: taskFailedByOther.task_id,
      error: '验收失败',
    });
    const taskSecond = (await callTool<TaskResult>(humanConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: secondRoomId,
      description: '第二房间待领取任务',
    })).task;
    await callTool(agentAConn.client, 'network_task_claim', {
      request_id: newRequestId('task_claim'),
      task_id: taskSecond.task_id,
    });
    await callTool(humanConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: thirdRoomId,
      description: 'A 未加入房间的任务',
    });

    const summaryA = await callTool<TaskSummary>(agentAConn.client, 'network_task_summary', {});
    const mainA = summaryA.items.find((item) => item.room_id === roomId);
    checkEqual('per-room summary total 含他人 claimed', mainA?.total, 6);
    checkEqual('per-room summary pending 是未领取', mainA?.pending, 2);
    checkEqual('per-room summary claimed 只含 A 本人', mainA?.claimed, 1);
    checkEqual('per-room summary done 是房间总量', mainA?.done, 1);
    checkEqual('per-room summary failed 是房间总量', mainA?.failed, 1);
    const secondA = summaryA.items.find((item) => item.room_id === secondRoomId);
    checkEqual('per-room summary 跨房间统计 A 的 claimed', secondA?.claimed, 1);
    checkEqual('第二房间 pending', secondA?.pending, 0);
    check(
      'per-room summary 不包含 A 未加入的第三房间',
      !summaryA.items.some((item) => item.room_id === thirdRoomId),
      summaryA.items,
    );
    const filteredA = await callTool<TaskSummary>(agentAConn.client, 'network_task_summary', {
      room_ids: [roomId, thirdRoomId],
    });
    checkEqual('summary room_ids 过滤只保留 A 的 active 房间', filteredA.items.length, 1);
    checkEqual('summary room_ids 过滤保留目标房间', filteredA.items[0]?.room_id, roomId);

    const summaryB = await callTool<TaskSummary>(agentBConn.client, 'network_task_summary', {});
    const mainB = summaryB.items.find((item) => item.room_id === roomId);
    checkEqual('B 视角 total 与 A 一致', mainB?.total, 6);
    checkEqual('B 的 claimed 只含 B 本人', mainB?.claimed, 1);
    const thirdB = summaryB.items.find((item) => item.room_id === thirdRoomId);
    checkEqual('B 能看到自己加入的第三房间', thirdB?.total, 1);
    checkEqual('B 的第三房间 pending', thirdB?.pending, 1);
    checkEqual('B 的第三房间 claimed', thirdB?.claimed, 0);
    check(
      'A 的第二房间不出现在 B 的 summary',
      !summaryB.items.some((item) => item.room_id === secondRoomId),
      summaryB.items,
    );

    const summaryHuman = await callTool<TaskSummary>(humanConn.client, 'network_task_summary', {});
    const mainHuman = summaryHuman.items.find((item) => item.room_id === roomId);
    checkEqual('human summary claimed 恒为 0', mainHuman?.claimed, 0);
    checkEqual('不同身份看到相同 total', mainHuman?.total, 6);
    checkEqual('不同身份看到相同 done', mainHuman?.done, 1);
    checkEqual('不同身份看到相同 failed', mainHuman?.failed, 1);

    // 命令行 summary 的帮助与实际输出必须描述同一组字段。
    const repoRoot = resolve(import.meta.dir, '../..');
    const scriptPath = resolve(repoRoot, 'public/skills/agent_tasks.sh');
    const scriptHelp = Bun.spawnSync({
      cmd: ['bash', scriptPath, 'help'],
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const scriptHelpText = scriptHelp.stdout.toString();
    checkEqual('agent_tasks.sh help 退出码为 0', scriptHelp.exitCode, 0);
    check(
      'agent_tasks.sh summary 帮助包含字段语义',
      scriptHelpText.includes('claimed 只含本人') &&
        scriptHelpText.includes('pending 是未领取') &&
        scriptHelpText.includes('total'),
      scriptHelpText,
    );
    const scriptRun = Bun.spawnSync({
      cmd: ['bash', scriptPath, 'summary', '--rooms', roomId],
      cwd: repoRoot,
      env: { ...process.env, AGENTNET_URL: baseUrl(), AGENTNET_TOKEN: agentAConn.token },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const scriptOut = scriptRun.stdout.toString().trim();
    checkEqual('agent_tasks.sh summary 退出码为 0', scriptRun.exitCode, 0);
    const scriptLine = scriptOut.split('\n').find((line) => line.startsWith(roomId));
    check('agent_tasks.sh summary 输出目标房间', Boolean(scriptLine), scriptOut);
    const scriptFields = new Set((scriptLine ?? '').split('\t').slice(1));
    for (const expected of ['pending=2', 'claimed=1', 'done=1', 'failed=1', 'total=6']) {
      check(`agent_tasks.sh summary 输出 ${expected}`, scriptFields.has(expected), scriptOut);
    }

    // 任务写操作不改变 head、未读或 Agent inbox。
    const after = await callTool<RoomDetail>(humanConn.client, 'network_room_get', { room_id: roomId });
    checkEqual('任务操作不推进房间 head_seq', after.room.head_seq, headBefore);
    checkEqual(
      '任务操作不产生未读（已读位置仍等于 head）',
      after.room.my_last_read_seq,
      headBefore,
    );
    const aPendingAfter = (await inbox(agentAConn, 'pending')).pending_count;
    checkEqual('任务操作不增加 Agent pending_count', aPendingAfter, aPendingBefore);

    // 任务事件只通知 active human；Agent 不收到、也不会被唤醒。
    const humanCollector = notificationCollector(humanConn.client);
    const agentCollector = notificationCollector(agentAConn.client);
    const humanSub = await openSubscription(humanConn.client, [STREAM_URI]);
    const agentSub = await openSubscription(agentAConn.client, [STREAM_URI]);
    subscriptions.push(humanSub, agentSub);
    const login = await callTool<LoginResult>(agentAConn.client, 'network_login', {});
    checkEqual('login 返回任务概览 pending', login.task_summary.pending, 2);
    checkEqual('login 返回任务概览 claimed 只含 A 本人', login.task_summary.claimed, 2);
    checkEqual('login 返回任务概览 done', login.task_summary.done, 1);
    checkEqual('login 返回任务概览 failed', login.task_summary.failed, 1);
    checkEqual('login 返回任务概览 total 含他人 claimed', login.task_summary.total, 7);
    const loginB = await callTool<LoginResult>(agentBConn.client, 'network_login', {});
    checkEqual('B login 返回任务概览 pending', loginB.task_summary.pending, 3);
    checkEqual('B login claimed 只含 B 本人', loginB.task_summary.claimed, 1);
    checkEqual('B login 返回任务概览 done', loginB.task_summary.done, 1);
    checkEqual('B login 返回任务概览 failed', loginB.task_summary.failed, 1);
    checkEqual('B login 返回任务概览 total', loginB.task_summary.total, 7);
    const loginAgain = await callTool<LoginResult>(agentAConn.client, 'network_login', {});
    checkEqual(
      '重复 login 返回同一任务概览',
      JSON.stringify(loginAgain.task_summary),
      JSON.stringify(login.task_summary),
    );
    checkEqual('重复 login 不改变 pending_count', loginAgain.pending_count, login.pending_count);
    checkEqual('重复 login 不改变 inbox_head_seq', loginAgain.inbox_head_seq, login.inbox_head_seq);
    checkEqual(
      'login 不推进房间 head',
      (await callTool<RoomDetail>(humanConn.client, 'network_room_get', { room_id: roomId })).room
        .head_seq,
      headBefore,
    );
    checkEqual(
      'login 任务概览不改变 pending_count',
      login.pending_count,
      (await inbox(agentAConn, 'pending')).pending_count,
    );
    const humanFrom = humanCollector.events.length;
    const agentFrom = agentCollector.events.length;

    const streamTask = (await callTool<TaskResult>(humanConn.client, 'network_task_add', {
      request_id: newRequestId('task_add'),
      room_id: roomId,
      description: '用于任务流验收',
    })).task;
    const item = await waitForTaskItem(
      humanCollector,
      humanFrom,
      (entry) => entry.source === 'room.tasks' && entry.ref_id === streamTask.task_id,
      'human 任务流事件',
    );
    checkEqual('任务事件 source 为 room.tasks', item.source, 'room.tasks');
    checkEqual('任务事件 kind 为 tasks', item.kind, 'tasks');
    checkEqual('任务事件 attention 为 informational', item.attention, 'informational');
    checkEqual('任务事件带 room_id', item.room_id, roomId);
    checkEqual('任务事件 change 为 added', item.change, 'added');
    await sleep(300);
    check(
      '任务事件不投递给 Agent',
      taskItems(agentCollector, agentFrom).every((entry) => entry.source !== 'room.tasks'),
      taskItems(agentCollector, agentFrom),
    );
    checkEqual(
      '任务事件后 head_seq 仍不变',
      (await callTool<RoomDetail>(humanConn.client, 'network_room_get', { room_id: roomId })).room.head_seq,
      headBefore,
    );
    checkEqual(
      '任务事件后 Agent pending_count 仍不变',
      (await inbox(agentAConn, 'pending')).pending_count,
      aPendingBefore,
    );
  } finally {
    await Promise.all(
      subscriptions.map((subscription) => subscription.close().catch(() => undefined)),
    );
    await Promise.all([
      humanConn.close(),
      agentAConn.close(),
      agentBConn.close(),
      outsiderConn.close(),
    ]);
  }
}

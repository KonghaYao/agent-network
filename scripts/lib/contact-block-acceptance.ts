/**
 * A05 删除拉黑与骚扰控制验收（T01–T03）。
 *
 * T01 拉黑拒绝私聊/申请/direct 邀请，阻止 pending 重放与管理绕过；
 * T02 共同群消息可见、定向 @ 按个人设置静默、群治理事件不受影响；
 * T03 解封不恢复好友、再申请冷却、发送者窗口限额与幂等重试。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  sleep,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  inbox,
  readWholeMessage,
  registerIdentity,
  sendMessage,
  type ContactRequestResultView,
  type Identity,
  type RoomDetail,
  type SendResult,
} from './acceptance-helpers';
import { LIMITS } from '../../src/contracts/limits';

interface ContactRow {
  actor_id: string;
  relation: 'active' | 'none';
}

interface ContactPage {
  items: ContactRow[];
}

interface ContactRequestView {
  contact_request_id: string;
  status: string;
}

interface ContactRequestPage {
  items: ContactRequestView[];
}

interface BlockView {
  block_id: string;
  active: boolean;
  mute_mentions: boolean;
  blocked_actor: { actor_id: string };
}

interface BlockResult {
  block: BlockView;
  already_blocked: boolean;
}

interface BlockPage {
  items: BlockView[];
}

interface UnblockResult {
  block: BlockView | null;
  released: boolean;
}

interface ReportView {
  report_id: string;
  status: string;
  category: string;
  room_id: string | null;
  message_id: string | null;
  target_actor: { actor_id: string };
}

interface TaskView {
  task_id: string;
  status: string;
  revision: number;
  assignment: { assignment_id: string; owner_actor_id: string } | null;
  delivery_ids: string[];
}

interface RoomRoleView {
  members: { actor_id: string; role: string; role_revision: number }[];
}

interface HistoryPage {
  items: { message_id: string; sender_id: string; preview: string }[];
}

async function contactsOf(connection: McpConnection): Promise<ContactPage> {
  return callTool<ContactPage>(connection.client, 'network_contacts_list', { limit: 100 });
}

async function relationOf(connection: McpConnection, target: string): Promise<string | null> {
  const page = await contactsOf(connection);
  return page.items.find((item) => item.actor_id === target)?.relation ?? null;
}

async function requestsOf(
  connection: McpConnection,
  status: string,
): Promise<ContactRequestPage> {
  return callTool<ContactRequestPage>(connection.client, 'network_contact_requests_list', {
    direction: 'outgoing',
    status,
    limit: 100,
  });
}

async function directRoom(connection: McpConnection, target: string): Promise<RoomDetail> {
  return callTool<RoomDetail>(connection.client, 'network_room_create', {
    request_id: newRequestId('a05_direct'),
    kind: 'direct',
    members: [target],
  });
}

async function historyOf(connection: McpConnection, roomId: string): Promise<HistoryPage> {
  return callTool<HistoryPage>(connection.client, 'network_history_list', {
    room_id: roomId,
    limit: 100,
  });
}

async function blockActor(
  connection: McpConnection,
  target: string,
  options: { muteMentions?: boolean } = {},
): Promise<BlockResult> {
  return callTool<BlockResult>(connection.client, 'network_contact_block', {
    request_id: newRequestId('a05_block'),
    actor_id: target,
    ...(options.muteMentions === undefined ? {} : { mute_mentions: options.muteMentions }),
  });
}

async function unblockActor(connection: McpConnection, target: string): Promise<UnblockResult> {
  return callTool<UnblockResult>(connection.client, 'network_contact_unblock', {
    request_id: newRequestId('a05_unblock'),
    actor_id: target,
  });
}

async function createRequest(
  connection: McpConnection,
  target: string,
  requestId = newRequestId('a05_creq'),
): Promise<ContactRequestResultView> {
  return callTool<ContactRequestResultView>(connection.client, 'network_contact_request', {
    request_id: requestId,
    actor_id: target,
  });
}

async function respondRequest(
  connection: McpConnection,
  contactRequestId: string,
  action: 'accept' | 'reject',
): Promise<ContactRequestResultView> {
  return callTool<ContactRequestResultView>(connection.client, 'network_contact_request_respond', {
    request_id: newRequestId('a05_cres'),
    contact_request_id: contactRequestId,
    action,
  });
}

/** T01：拉黑封堵私聊/申请/direct 邀请，pending 重放不产生新状态，管理者不能绕过。 */
async function runBlockedContactBypass(): Promise<void> {
  console.log('  · A05-T01 拉黑拒绝私聊、申请、direct 邀请与管理绕过');
  const aConn = await connectClient(newToken());
  const bConn = await connectClient(newToken());
  const sConn = await connectClient(newToken());
  const managerConn = await connectClient(newToken());
  let agentConn: McpConnection | null = null;
  try {
    const a = await registerIdentity(aConn, { kind: 'human', name: 'A05 用户 A' });
    const b = await registerIdentity(bConn, { kind: 'human', name: 'A05 用户 B' });
    const s = await registerIdentity(sConn, { kind: 'human', name: 'A05 陌生人 S' });
    const manager = await registerIdentity(managerConn, {
      kind: 'human',
      name: 'A05 管理者 M',
    });
    const created = await callTool<{ actor_id: string; token: string }>(
      managerConn.client,
      'network_agent_create',
      { request_id: newRequestId('a05_agent'), name: 'A05 受管 Agent G' },
    );
    agentConn = await connectClient(created.token);
    try {
      const g = await callTool<Identity>(agentConn.client, 'network_me');

      await befriend(aConn, a.actor_id, bConn, b.actor_id);
      await befriend(bConn, b.actor_id, sConn, s.actor_id);
      const room = await directRoom(aConn, b.actor_id);
      const beforeBlock = await sendMessage(aConn, room.room.room_id, '拉黑前的历史消息');
      const bGroup = await callTool<RoomDetail>(bConn.client, 'network_room_create', {
        request_id: newRequestId('a05_b_group'),
        kind: 'group',
        members: [s.actor_id],
        title: 'A05 B 的群',
      });
      await acceptGroupInvites(sConn, bGroup.room.room_id);

      // 任务提议拒绝用例：A 为群主，M 为管理员，G 为 Agent 候选。
      await befriend(aConn, a.actor_id, managerConn, manager.actor_id);
      const agentFriendRequest = await callTool<ContactRequestResultView>(
        aConn.client,
        'network_contact_request',
        {
          request_id: newRequestId('a05_g_request'),
          actor_id: g.actor_id,
        },
      );
      if (agentFriendRequest.status === 'pending' && agentFriendRequest.request) {
        await callTool<ContactRequestResultView>(
          managerConn.client,
          'network_contact_request_respond',
          {
            request_id: newRequestId('a05_g_accept'),
            contact_request_id: agentFriendRequest.request.contact_request_id,
            action: 'accept',
          },
        );
      }
      const taskGroup = await callTool<RoomDetail>(aConn.client, 'network_room_create', {
        request_id: newRequestId('a05_task_group'),
        kind: 'group',
        members: [b.actor_id, manager.actor_id, g.actor_id],
        title: 'A05 任务提议群',
      });
      const taskRoomId = taskGroup.room.room_id;
      await acceptGroupInvites(bConn, taskRoomId);
      await acceptGroupInvites(managerConn, taskRoomId);
      await acceptGroupInvites(agentConn, taskRoomId);
      const taskRoom = await callTool<RoomRoleView>(aConn.client, 'network_room_get', {
        room_id: taskRoomId,
      });
      const managerMember = taskRoom.members.find(
        (member) => member.actor_id === manager.actor_id,
      );
      if (!managerMember) throw new Error('A05 管理者不在任务群成员列表中');
      await callTool(aConn.client, 'network_room_role_set', {
        request_id: newRequestId('a05_task_admin'),
        room_id: taskRoomId,
        actor_id: manager.actor_id,
        role: 'admin',
        expected_role_revision: managerMember.role_revision,
      });

      const blocked = await blockActor(aConn, b.actor_id);
      checkEqual('T01 拉黑结果 active', blocked.block.active, true);
      checkEqual('T01 首次拉黑 already_blocked=false', blocked.already_blocked, false);
      checkEqual('T01 拉黑立即结束好友关系（A 视角）', await relationOf(aConn, b.actor_id), 'none');
      checkEqual('T01 拉黑立即结束好友关系（B 视角）', await relationOf(bConn, a.actor_id), 'none');

      const keptHistory = await historyOf(bConn, room.room.room_id);
      check(
        'T01 拉黑保留双方历史消息',
        keptHistory.items.some((item) => item.message_id === beforeBlock.message.message_id),
        keptHistory.items,
      );

      await expectToolError(
        'T01 被拉黑者不能创建 direct',
        directRoom(bConn, a.actor_id),
        'BLOCKED',
      );
      await expectToolError(
        'T01 被拉黑者不能向旧 direct 发送新消息',
        sendMessage(bConn, room.room.room_id, '绕过拉黑'),
        'BLOCKED',
      );
      await expectToolError(
        'T01 被拉黑者不能发起好友申请',
        createRequest(bConn, a.actor_id),
        'BLOCKED',
      );
      await expectToolError(
        'T01 被拉黑者不能把拉黑者加入群聊',
        callTool(bConn.client, 'network_room_members_update', {
          request_id: newRequestId('a05_b_add'),
          room_id: bGroup.room.room_id,
          add: [a.actor_id],
        }),
        'BLOCKED',
      );
      await expectToolError(
        'T01 被拉黑者不能借建群定向邀请拉黑者',
        callTool(bConn.client, 'network_room_create', {
          request_id: newRequestId('a05_b_invite'),
          kind: 'group',
          members: [a.actor_id],
          title: 'A05 绕过群',
        }),
        'BLOCKED',
      );

      // 拉黑取消 pending 申请；旧 request_id 重放只返回首次结果，不产生新行。
      const pending = await createRequest(sConn, a.actor_id);
      const pendingId = pending.request?.contact_request_id ?? '';
      check('T01 拉黑前申请进入 pending', pending.status === 'pending' && pendingId.startsWith('creq_'));
      const replayed = await createRequest(sConn, a.actor_id, newRequestId('a05_replay'));
      checkEqual('T01 重复申请返回同一 pending', replayed.request?.contact_request_id, pendingId);

      await blockActor(aConn, s.actor_id);
      const cancelled = await callTool<ContactRequestPage>(
        sConn.client,
        'network_contact_requests_list',
        { direction: 'outgoing', status: 'cancelled', limit: 100 },
      );
      check(
        'T01 拉黑取消同 pair 的 pending 申请',
        cancelled.items.some((item) => item.contact_request_id === pendingId),
        cancelled.items,
      );
      await expectToolError(
        'T01 新 request_id 无法绕过拉黑',
        createRequest(sConn, a.actor_id),
        'BLOCKED',
      );
      checkEqual(
        'T01 重放/新申请都不建立关系',
        await relationOf(sConn, a.actor_id),
        null,
      );

      // 管理者不能替被拉黑的 Agent 接受申请。
      const s2Conn = await connectClient(newToken());
      try {
        const s2 = await registerIdentity(s2Conn, { kind: 'human', name: 'A05 陌生人 S2' });
        const toAgent = await createRequest(s2Conn, g.actor_id);
        const toAgentId = toAgent.request?.contact_request_id ?? '';
        checkEqual('T01 陌生人对 Agent 的申请为 pending', toAgent.status, 'pending');
        await blockActor(agentConn, s2.actor_id);
        await expectToolError(
          'T01 管理者不能绕过拉黑替 Agent 接受',
          respondRequest(managerConn, toAgentId, 'accept'),
          'BLOCKED',
        );
        checkEqual(
          'T01 被拒绝后 Agent 仍无好友关系',
          await relationOf(agentConn, s2.actor_id),
          null,
        );
        const agentInbox = await inbox(agentConn, 'pending');
        checkEqual('T01 拉黑不产生 Agent delivery', agentInbox.items.length, 0);
        checkEqual('T01 拉黑不增加 Agent pending_count', agentInbox.pending_count, 0);
      } finally {
        await s2Conn.close();
      }

      // 任务提议：创建者拉黑候选后，管理员也不能代派；解除后恢复正常。
      const task = (
        await callTool<{ task: TaskView }>(aConn.client, 'network_task_create', {
          request_id: newRequestId('a05_task'),
          room_id: taskRoomId,
          title: 'A05 任务提议拒绝',
        })
      ).task;
      checkEqual('T01 任务提议前任务为 unassigned', task.status, 'unassigned');
      await blockActor(aConn, g.actor_id);
      const pendingBeforeTaskOffer = (await inbox(agentConn, 'pending')).pending_count;
      await expectToolError(
        'T01 管理员不能把任务提议给被创建者拉黑的 Agent',
        callTool(managerConn.client, 'network_task_offer', {
          request_id: newRequestId('a05_task_offer_blocked'),
          task_id: task.task_id,
          assignee_actor_id: g.actor_id,
          expected_revision: task.revision,
        }),
        'BLOCKED',
      );
      const blockedTask = (
        await callTool<{ task: TaskView }>(aConn.client, 'network_task_get', {
          task_id: task.task_id,
        })
      ).task;
      checkEqual('T01 被拒绝的任务提议不生成 assignment', blockedTask.assignment, null);
      checkEqual('T01 被拒绝的任务提议不生成 delivery', blockedTask.delivery_ids.length, 0);
      checkEqual(
        'T01 被拒绝的任务提议不增加候选 pending_count',
        (await inbox(agentConn, 'pending')).pending_count,
        pendingBeforeTaskOffer,
      );

      await unblockActor(aConn, g.actor_id);
      const offeredTask = (
        await callTool<{ task: TaskView }>(managerConn.client, 'network_task_offer', {
          request_id: newRequestId('a05_task_offer_allowed'),
          task_id: task.task_id,
          assignee_actor_id: g.actor_id,
          expected_revision: blockedTask.revision,
        })
      ).task;
      checkEqual('T01 解除拉黑后任务提议可正常派发', offeredTask.assignment?.owner_actor_id, g.actor_id);
      checkEqual('T01 正常任务提议只生成一条 delivery', offeredTask.delivery_ids.length, 1);
      checkEqual(
        'T01 正常任务提议增加候选 pending_count',
        (await inbox(agentConn, 'pending')).pending_count,
        pendingBeforeTaskOffer + 1,
      );
      await callTool(aConn.client, 'network_task_cancel', {
        request_id: newRequestId('a05_task_cancel'),
        task_id: task.task_id,
        reason: 'A05 清理任务提议',
        expected_revision: offeredTask.revision,
      });
      checkEqual(
        'T01 取消任务后 pending_count 恢复',
        (await inbox(agentConn, 'pending')).pending_count,
        pendingBeforeTaskOffer,
      );

      const bInbox = await inbox(bConn, 'pending');
      checkEqual('T01 拉黑不唤醒被拉黑者', bInbox.items.length, 0);
      const aMe = await callTool<{ pending_count: number }>(aConn.client, 'network_me');
      checkEqual('T01 拉黑不增加拉黑者待办', aMe.pending_count, 0);
    } finally {
      await agentConn.close();
    }
  } finally {
    await aConn.close();
    await bConn.close();
    await sConn.close();
    await managerConn.close();
    if (agentConn) await agentConn.close();
  }
}

/** T02：同群可见、定向 @ 静默、个人设置生效与群治理不受影响。 */
async function runGroupSilenceAndGovernance(): Promise<void> {
  console.log('  · A05-T02 共同群消息可见、私人通知静默与治理事件');
  const ownerConn = await connectClient(newToken());
  const g1Conn = await connectClient(newToken());
  const g2Conn = await connectClient(newToken());
  try {
    const owner = await registerIdentity(ownerConn, { kind: 'human', name: 'A05 群主 H' });
    const g1 = await registerIdentity(g1Conn, {
      kind: 'agent',
      name: 'A05 Agent 一号',
      sessionId: `a05-g1-${crypto.randomUUID()}`,
    });
    const g2 = await registerIdentity(g2Conn, {
      kind: 'agent',
      name: 'A05 Agent 二号',
      sessionId: `a05-g2-${crypto.randomUUID()}`,
    });

    await befriend(ownerConn, owner.actor_id, g1Conn, g1.actor_id);
    await befriend(ownerConn, owner.actor_id, g2Conn, g2.actor_id);
    const group = await callTool<RoomDetail>(ownerConn.client, 'network_room_create', {
      request_id: newRequestId('a05_group'),
      kind: 'group',
      members: [g1.actor_id, g2.actor_id],
      title: 'A05 共同群',
    });
    const roomId = group.room.room_id;
    await acceptGroupInvites(g1Conn, roomId);
    await acceptGroupInvites(g2Conn, roomId);
    // 拉黑前的定向 @ 投递必须被取消，避免拉黑后仍被旧提醒唤醒。
    const preBlockMention = await sendMessage(
      g1Conn,
      roomId,
      '@A05 Agent 二号 拉黑前的定向提醒',
    );
    checkEqual('T02 拉黑前定向 @ 创建 delivery', preBlockMention.delivery_ids.length, 1);
    const preBlockInbox = await inbox(g2Conn, 'pending');
    checkEqual('T02 拉黑前待办包含定向投递', preBlockInbox.items.length, 1);
    checkEqual('T02 拉黑前 pending_count 为 1', preBlockInbox.pending_count, 1);

    await blockActor(g2Conn, g1.actor_id);
    const postBlockInbox = await inbox(g2Conn, 'pending');
    checkEqual('T02 拉黑取消来自被拉黑者的旧投递', postBlockInbox.items.length, 0);
    checkEqual('T02 拉黑后 pending_count 归零', postBlockInbox.pending_count, 0);
    const afterBlock = await callTool<RoomDetail>(ownerConn.client, 'network_room_get', {
      room_id: roomId,
    });
    const blockedMember = afterBlock.members.find((member) => member.actor_id === g1.actor_id);
    checkEqual('T02 拉黑不改变共同群成员身份', blockedMember?.actor_id, g1.actor_id);

    const mention = await sendMessage(g1Conn, roomId, '@A05 Agent 二号 请看一下这条群消息');
    checkEqual('T02 来自被拉黑者的定向 @ 不创建 delivery', mention.delivery_ids.length, 0);
    const g2History = await historyOf(g2Conn, roomId);
    const mentionMessage = g2History.items.find(
      (item) => item.message_id === mention.message.message_id,
    );
    check('T02 群消息仍对被拉黑者可见', Boolean(mentionMessage), g2History.items);
    checkEqual(
      'T02 群消息正文保留 @ 文本',
      await readWholeMessage(g2Conn, mention.message.message_id),
      '@A05 Agent 二号 请看一下这条群消息',
    );
    const g2Inbox = await inbox(g2Conn, 'pending');
    checkEqual('T02 静默的 @ 不进入被拉黑者待办', g2Inbox.items.length, 0);

    // 群聊普通广播默认不产生定向 delivery；这里再用显式 invoke: [] 验证 opt-out。
    const ownerMessage = await sendMessage(ownerConn, roomId, '群主广播：治理事件仍可见', {
      invoke: [],
    });
    check('T02 群主消息正常广播', ownerMessage.message.message_id.startsWith('msg_'));
    checkEqual(
      'T02 群主消息不创建定向 delivery',
      ownerMessage.delivery_ids.length,
      0,
    );
    checkEqual(
      'T02 被拉黑者仍能读到群主广播',
      await readWholeMessage(g2Conn, ownerMessage.message.message_id),
      '群主广播：治理事件仍可见',
    );

    // 个人设置：显式关闭静默后，同一 @ 重新产生定向投递。
    await unblockActor(g2Conn, g1.actor_id);
    await blockActor(g2Conn, g1.actor_id, { muteMentions: false });
    const loudMention = await sendMessage(g1Conn, roomId, '@A05 Agent 二号 这条需要你处理');
    checkEqual('T02 mute_mentions=false 时 @ 恢复投递', loudMention.delivery_ids.length, 1);
    checkEqual(
      'T02 恢复投递的 recipient 是正确的 Agent',
      loudMention.delivery_ids.length === 1
        ? (await callTool<{ items: { recipient_id: string }[] }>(g2Conn.client, 'network_inbox_list', { state: 'pending' })).items[0]?.recipient_id
        : null,
      g2.actor_id,
    );

    // 群治理：owner 仍可移除成员；拉黑不影响管理员成员事件。
    const removed = await callTool<RoomDetail>(ownerConn.client, 'network_room_members_update', {
      request_id: newRequestId('a05_remove'),
      room_id: roomId,
      remove: [g1.actor_id],
    });
    check(
      'T02 群主仍可移除被拉黑成员',
      !removed.members.some((member) => member.actor_id === g1.actor_id),
      removed.members,
    );
    const readded = await callTool<RoomDetail>(ownerConn.client, 'network_room_members_update', {
      request_id: newRequestId('a05_add'),
      room_id: roomId,
      add: [g1.actor_id],
    });
    check(
      'T02 群主仍可重新加入成员',
      readded.members.some((member) => member.actor_id === g1.actor_id),
      readded.members,
    );
    const g2After = await callTool<RoomDetail>(g2Conn.client, 'network_room_get', { room_id: roomId });
    checkEqual('T02 拉黑不阻止被拉黑者读取群', g2After.room.room_id, roomId);

    const reports = await callTool<{ items: ReportView[] }>(ownerConn.client, 'network_contact_reports_list', {
      limit: 50,
    });
    checkEqual('T02 未举报时列表为空', reports.items.length, 0);
  } finally {
    await ownerConn.close();
    await g1Conn.close();
    await g2Conn.close();
  }
}

/** T03：解封不恢复好友、再申请冷却、发送者窗口限额与幂等重试。 */
async function runCooldownLimitsAndUnblock(): Promise<void> {
  console.log('  · A05-T03 解封、冷却、限额、幂等与举报');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const u3Conn = await connectClient(newToken());
  const u4Conn = await connectClient(newToken());
  const overLimitConn = await connectClient(newToken());
  const extra: McpConnection[] = [];
  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'A05 T03 U1' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'A05 T03 U2' });
    const u3 = await registerIdentity(u3Conn, { kind: 'human', name: 'A05 T03 U3' });
    const u4 = await registerIdentity(u4Conn, { kind: 'human', name: 'A05 T03 U4' });
    const overLimit = await registerIdentity(overLimitConn, {
      kind: 'human',
      name: 'A05 T03 超限目标',
    });

    await befriend(u1Conn, u1.actor_id, u2Conn, u2.actor_id);
    const firstBlock = await blockActor(u1Conn, u2.actor_id);
    const repeatedBlock = await blockActor(u1Conn, u2.actor_id);
    checkEqual('T03 重复拉黑返回同一 block', repeatedBlock.block.block_id, firstBlock.block.block_id);
    checkEqual('T03 重复拉黑 already_blocked=true', repeatedBlock.already_blocked, true);
    const unblocked = await unblockActor(u1Conn, u2.actor_id);
    checkEqual('T03 解除拉黑返回 released=true', unblocked.released, true);
    const unblockAgain = await unblockActor(u1Conn, u2.actor_id);
    checkEqual('T03 重复解除拉黑 released=false', unblockAgain.released, false);
    checkEqual('T03 重复解除拉黑不返回 block', unblockAgain.block, null);
    checkEqual('T03 解除拉黑后关系仍未恢复', await relationOf(u1Conn, u2.actor_id), 'none');
    await expectToolError(
      'T03 解除拉黑后不能直接创建 direct',
      directRoom(u2Conn, u1.actor_id),
      'FRIEND_REQUIRED',
    );
    await expectToolError(
      'T03 解封后立即申请命中冷却',
      createRequest(u2Conn, u1.actor_id),
      'RATE_LIMITED',
    );
    checkEqual('T03 冷却期间仍无好友关系', await relationOf(u2Conn, u1.actor_id), 'none');
    await sleep(LIMITS.contactUnblockCooldownMs + 300);
    const renewed = await createRequest(u2Conn, u1.actor_id);
    checkEqual('T03 冷却结束后必须重新申请', renewed.status, 'pending');
    const accepted = await respondRequest(
      u1Conn,
      renewed.request?.contact_request_id ?? '',
      'accept',
    );
    checkEqual('T03 重新申请接受后关系恢复', accepted.relation?.status, 'active');

    // 幂等重试：同一 request_id 返回同一申请，不产生第二行。
    const firstRequestId = newRequestId('a05_idem');
    const first = await createRequest(u3Conn, u4.actor_id, firstRequestId);
    const firstId = first.request?.contact_request_id ?? '';
    const replay = await createRequest(u3Conn, u4.actor_id, firstRequestId);
    checkEqual('T03 同一 request_id 重放返回同一申请', replay.request?.contact_request_id, firstId);
    const differentId = await createRequest(u3Conn, u4.actor_id);
    checkEqual('T03 pending 期间新 request_id 复用同一申请', differentId.request?.contact_request_id, firstId);
    const pendingRows = await callTool<ContactRequestPage>(
      u3Conn.client,
      'network_contact_requests_list',
      { direction: 'outgoing', status: 'pending', limit: 100 },
    );
    checkEqual(
      'T03 重试不增加重复申请',
      pendingRows.items.filter((item) => item.contact_request_id === firstId).length,
      1,
    );

    // 发送者窗口限额：补足 LIMITS.contactRequestWindowMax 条成功申请，
    // 下一条必须 RATE_LIMITED；阈值只从 LIMITS 读取，不在测试里复制数字。
    const budget = LIMITS.contactRequestWindowMax;
    const targets: string[] = [u4.actor_id];
    for (let index = 1; index < budget; index += 1) {
      const conn = await connectClient(newToken());
      extra.push(conn);
      const identity = await registerIdentity(conn, {
        kind: 'human',
        name: `A05 T03 限额目标 ${index}`,
      });
      targets.push(identity.actor_id);
    }
    for (const target of targets.slice(1)) {
      const result = await createRequest(u3Conn, target);
      checkEqual(`T03 目标 ${target} 申请进入 pending`, result.status, 'pending');
    }
    await expectToolError(
      'T03 超过发送者窗口限额返回 RATE_LIMITED',
      createRequest(u3Conn, overLimit.actor_id),
      'RATE_LIMITED',
    );
    const outgoing = await callTool<ContactRequestPage>(
      u3Conn.client,
      'network_contact_requests_list',
      { direction: 'outgoing', limit: 100 },
    );
    checkEqual('T03 超限失败没有新增申请', outgoing.items.length, budget);

    // 举报：只保存定位与接收状态，不复制正文、不产生 delivery。
    const reportRequestId = newRequestId('a05_report');
    const blockedReport = await callTool<{ report: ReportView }>(u1Conn.client, 'network_contact_report', {
      request_id: reportRequestId,
      target_actor_id: u2.actor_id,
      category: 'harassment',
      note: '反复发送好友申请',
      room_id: (await directRoom(u1Conn, u2.actor_id)).room.room_id,
    });
    checkEqual('T03 举报返回接收状态', blockedReport.report.status, 'received');
    checkEqual('T03 举报记录被举报者', blockedReport.report.target_actor.actor_id, u2.actor_id);
    const replayReport = await callTool<{ report: ReportView }>(u1Conn.client, 'network_contact_report', {
      request_id: reportRequestId,
      target_actor_id: u2.actor_id,
      category: 'harassment',
      note: '反复发送好友申请',
      room_id: blockedReport.report.room_id,
    });
    checkEqual('T03 同一 request_id 举报重放返回同一回执', replayReport.report.report_id, blockedReport.report.report_id);
    const reportList = await callTool<{ items: ReportView[] }>(u1Conn.client, 'network_contact_reports_list', {
      limit: 50,
    });
    checkEqual(
      'T03 举报列表包含同一回执',
      reportList.items.some((item) => item.report_id === blockedReport.report.report_id),
      true,
    );
    checkEqual(
      'T03 重放举报不增加重复行',
      reportList.items.filter((item) => item.report_id === blockedReport.report.report_id).length,
      1,
    );
    const u1Inbox = await inbox(u1Conn, 'pending');
    checkEqual('T03 举报不产生 delivery', u1Inbox.items.length, 0);
  } finally {
    await u1Conn.close();
    await u2Conn.close();
    await u3Conn.close();
    await u4Conn.close();
    await overLimitConn.close();
    for (const conn of extra) await conn.close();
  }
}

export async function runContactBlockAcceptance(): Promise<void> {
  console.log('  A05 删除拉黑与骚扰控制');
  await runBlockedContactBypass();
  await runGroupSilenceAndGovernance();
  await runCooldownLimitsAndUnblock();
}

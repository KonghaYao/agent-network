/**
 * 群主消息管理 v1 端到端验收。
 *
 * 覆盖 owner 撤回他人/Agent 消息、admin 拒绝、delivery 取消与禁止 retry、
 * 置顶三条上限/幂等/读取/审计与 sync 提示。文件与历史边界的持久行断言
 * 由 `scripts/verify-group-message-moderation.ts` 专项覆盖。
 */
import {
  check,
  checkEqual,
  callTool,
  expectToolError,
  newRequestId,
  type McpConnection,
} from './harness';
import { inbox } from './acceptance-helpers';
import {
  createActor,
  createRoom,
  makeFriends,
  sendMessage,
} from './group-history-helpers';

interface PinnedMessageView {
  message_id: string;
  preview: string;
  sender: { actor_id: string; name: string | null; kind: 'human' | 'agent' | null };
  created_seq: string;
  pinned_at: string;
}

interface ModerationDetail {
  room: {
    room_id: string;
    head_seq: string;
    capabilities: Record<string, boolean>;
  };
  members: { actor_id: string; role: string; role_revision: number }[];
  pinned_messages: PinnedMessageView[];
}

async function detail(connection: McpConnection, roomId: string): Promise<ModerationDetail> {
  return callTool<ModerationDetail>(connection.client, 'network_room_get', { room_id: roomId });
}

export async function runGroupMessageModerationAcceptance(): Promise<void> {
  const owner = await createActor('MOD 群主', 'human');
  const member = await createActor('MOD 成员', 'human');
  const agent = await createActor('MOD Agent', 'agent');
  await makeFriends(owner, member);
  await makeFriends(owner, agent);
  try {
    const roomId = await createRoom(
      owner.connection,
      [member.actor.actor_id, agent.actor.actor_id],
      'MOD 群主管理验收',
    );
    const memberMessage = await sendMessage(member.connection, roomId, '成员待撤回消息');
    const ownerMessage = await sendMessage(owner.connection, roomId, '群主消息');
    const agentMessage = await sendMessage(agent.connection, roomId, 'Agent 消息');

    const ownerDetail = await detail(owner.connection, roomId);
    check('MOD owner 获得 manage_messages', ownerDetail.room.capabilities.manage_messages === true);
    const memberDetail = await detail(member.connection, roomId);
    check('MOD member 不获得 manage_messages', memberDetail.room.capabilities.manage_messages === false);

    // owner 撤回成员消息
    await callTool(owner.connection.client, 'network_message_recall', {
      request_id: newRequestId('mod_recall_member'),
      message_id: memberMessage.message.message_id,
    });
    const memberHistory = await callTool<{ items: { message_id: string; preview: string }[] }>(
      member.connection.client,
      'network_history_list',
      { room_id: roomId, limit: 50 },
    );
    checkEqual(
      'MOD owner 撤回后成员看到 tombstone 预览',
      memberHistory.items.find((item) => item.message_id === memberMessage.message.message_id)?.preview,
      '此消息已撤回',
    );

    // admin 仍不能撤回他人
    const revision = memberDetail.members.find(
      (item) => item.actor_id === member.actor.actor_id,
    )?.role_revision;
    await callTool(owner.connection.client, 'network_room_role_set', {
      request_id: newRequestId('mod_admin'),
      room_id: roomId,
      actor_id: member.actor.actor_id,
      role: 'admin',
      expected_role_revision: revision,
    });
    await expectToolError(
      'MOD admin 撤回他人被拒绝',
      callTool(member.connection.client, 'network_message_recall', {
        request_id: newRequestId('mod_admin_recall'),
        message_id: ownerMessage.message.message_id,
      }),
      'PERMISSION_DENIED',
    );

    // owner 撤回 Agent 消息
    const headBeforeAgentRecall = (await detail(owner.connection, roomId)).room.head_seq;
    await callTool(owner.connection.client, 'network_message_recall', {
      request_id: newRequestId('mod_recall_agent'),
      message_id: agentMessage.message.message_id,
    });
    const afterAgentRecall = await detail(owner.connection, roomId);
    checkEqual(
      'MOD 撤回 Agent 消息不推进 head',
      afterAgentRecall.room.head_seq,
      headBeforeAgentRecall,
    );

    // 带投递的消息：撤回取消 pending，并禁止 retry
    const work = await callTool<{ message: { message_id: string }; delivery_ids: string[] }>(
      owner.connection.client,
      'network_message_send',
      {
        request_id: newRequestId('mod_work'),
        client_message_id: `cm_${crypto.randomUUID()}`,
        room_id: roomId,
        body: '给 Agent 的工作',
        invoke: [agent.actor.actor_id],
      },
    );
    const deliveryId = work.delivery_ids[0];
    check('MOD 派活生成 delivery', typeof deliveryId === 'string', work.delivery_ids);
    await callTool(owner.connection.client, 'network_message_recall', {
      request_id: newRequestId('mod_recall_work'),
      message_id: work.message.message_id,
    });
    const cancelled = await inbox(agent.connection, 'cancelled');
    check(
      'MOD 撤回后 Agent inbox 看到 cancelled',
      cancelled.items.some(
        (item) => item.delivery_id === deliveryId && item.state === 'cancelled',
      ),
      cancelled.items,
    );
    await expectToolError(
      'MOD 撤回后 retry 被拒绝',
      callTool(agent.connection.client, 'network_delivery_retry', {
        request_id: newRequestId('mod_retry'),
        delivery_id: deliveryId,
        expected_attempt: 0,
      }),
      'CONFLICT',
    );

    // 置顶：三条上限、幂等、读取、审计
    const extraB = await sendMessage(owner.connection, roomId, '置顶候选 B');
    const extraC = await sendMessage(owner.connection, roomId, '置顶候选 C');
    const pin = (messageId: string, pinned: boolean, prefix: string) =>
      callTool<{ message_id: string; pinned: boolean }>(
        owner.connection.client,
        'network_room_message_pin',
        {
          request_id: newRequestId(prefix),
          room_id: roomId,
          message_id: messageId,
          pinned,
        },
      );
    const headBeforePin = (await detail(owner.connection, roomId)).room.head_seq;
    await pin(ownerMessage.message.message_id, true, 'mod_pin_a');
    await pin(ownerMessage.message.message_id, true, 'mod_pin_a_again');
    await pin(extraB.message.message_id, true, 'mod_pin_b');
    await pin(extraC.message.message_id, true, 'mod_pin_c');
    const pinnedView = await detail(owner.connection, roomId);
    checkEqual('MOD 三条置顶可见', pinnedView.pinned_messages.length, 3);
    checkEqual('MOD 置顶不推进 head', pinnedView.room.head_seq, headBeforePin);
    check(
      'MOD 置顶预览与发送者来自当前消息',
      pinnedView.pinned_messages.some(
        (item) =>
          item.message_id === ownerMessage.message.message_id &&
          item.preview === '群主消息' &&
          item.sender.actor_id === owner.actor.actor_id,
      ),
      pinnedView.pinned_messages,
    );
    const memberPins = await detail(member.connection, roomId);
    checkEqual('MOD 普通成员可读取置顶', memberPins.pinned_messages.length, 3);

    const fourth = await sendMessage(owner.connection, roomId, '置顶候选 D');
    const limitError = await expectToolError(
      'MOD 第 4 条置顶被拒绝',
      pin(fourth.message.message_id, true, 'mod_pin_d'),
      'CONFLICT',
    );
    checkEqual('MOD 上限原因', (limitError.body.details as { reason?: string } | undefined)?.reason, 'pin_limit');
    await expectToolError(
      'MOD 已撤回消息不能置顶',
      pin(memberMessage.message.message_id, true, 'mod_pin_recalled'),
      'CONFLICT',
    );

    await pin(extraB.message.message_id, false, 'mod_unpin_b');
    checkEqual(
      'MOD 取消置顶后剩两条',
      (await detail(owner.connection, roomId)).pinned_messages.length,
      2,
    );

    const audit = await callTool<{ items: { action: string }[] }>(
      owner.connection.client,
      'network_room_role_history',
      { room_id: roomId },
    );
    check(
      'MOD 管理审计包含撤回与置顶动作',
      audit.items.some((item) => item.action === 'message_recalled') &&
        audit.items.some((item) => item.action === 'message_pinned') &&
        audit.items.some((item) => item.action === 'message_unpinned'),
      audit.items.map((item) => item.action),
    );

    const sync = await callTool<{ items: { type: string; metadata?: Record<string, unknown> }[] }>(
      owner.connection.client,
      'network_sync',
      { scope: `room:${roomId}`, limit: 200 },
    );
    const pinnedEvent = sync.items.find((item) => item.type === 'message_pinned');
    check('MOD sync 可补读置顶事件', pinnedEvent !== undefined, sync.items.map((item) => item.type));
    check(
      'MOD 置顶事件不含正文/预览',
      pinnedEvent !== undefined &&
        !JSON.stringify(pinnedEvent.metadata ?? {}).includes('群主消息'),
      pinnedEvent?.metadata,
    );

    // 已撤回 fresh request 保持幂等
    await callTool(owner.connection.client, 'network_message_recall', {
      request_id: newRequestId('mod_recall_again'),
      message_id: memberMessage.message.message_id,
    });
    const afterReplay = await callTool<{ items: { message_id: string; preview: string }[] }>(
      owner.connection.client,
      'network_history_list',
      { room_id: roomId, limit: 50 },
    );
    checkEqual(
      'MOD 已撤回重放仍返回 tombstone',
      afterReplay.items.find((item) => item.message_id === memberMessage.message.message_id)?.preview,
      '此消息已撤回',
    );
  } finally {
    await Promise.all([owner.connection.close(), member.connection.close(), agent.connection.close()]);
  }
}

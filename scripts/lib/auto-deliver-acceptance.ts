/**
 * 群聊 human 回复自动投递上一条 Agent 的端到端验收。
 *
 * 覆盖紧邻上一条 Agent 无 @ 自动投递、上一条 human/无消息/已移除成员不投递、
 * 显式 invoke 与正文 @Agent/@human 阻断自动、@未知成员仍自动、direct 与
 * Agent 发送不自动、同 request_id 重放不重复，以及 pending_count 与统一流通知。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
} from './harness';
import {
  inbox,
  registerIdentity,
  sendMessage,
  type Identity,
  type LoginResult,
  type RoomDetail,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface StreamItemView {
  source?: string;
  kind?: string;
  attention?: string;
  message_id?: string;
  delivery_id?: string;
}

function streamItemsOf(event: { params: Record<string, unknown> }): StreamItemView[] {
  const meta = event.params._meta as Record<string, unknown> | undefined;
  const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
  return payload?.items ?? [];
}

function hasStreamItem(
  event: { params: Record<string, unknown> },
  predicate: (item: StreamItemView) => boolean,
): boolean {
  return event.params.uri === STREAM_URI && streamItemsOf(event).some(predicate);
}

function deliveryFor(
  page: Awaited<ReturnType<typeof inbox>>,
  messageId: string,
  recipientId: string,
): boolean {
  return page.items.some(
    (item) => item.message_id === messageId && item.recipient_id === recipientId,
  );
}

export async function runGroupAutoDeliverAcceptance(): Promise<void> {
  console.log('  · 群聊 human 回复自动投递上一条 Agent');
  const human = await connectClient(newToken());
  const agentAConnection = await connectClient(newToken());
  const agentBConnection = await connectClient(newToken());
  const agentCConnection = await connectClient(newToken());
  let subscription: Awaited<ReturnType<typeof openSubscription>> | null = null;
  try {
    const owner = await registerIdentity(human, { kind: 'human', name: 'Auto Owner 用户' });
    const agentA = await registerIdentity(agentAConnection, {
      kind: 'agent',
      name: 'Auto Agent A',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const agentB = await registerIdentity(agentBConnection, {
      kind: 'agent',
      name: 'Auto Agent B',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const agentC = await registerIdentity(agentCConnection, {
      kind: 'agent',
      name: 'Auto Agent C',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const agents: Identity[] = [agentA, agentB, agentC];
    for (const agent of agents) {
      await callTool(human.client, 'network_contact_add', {
        request_id: newRequestId('auto_contact'),
        actor_id: agent.actor_id,
      });
    }
    const group = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('auto_room'),
      kind: 'group',
      title: '自动投递验收群',
      members: agents.map((agent) => agent.actor_id),
    });
    const groupId = group.room.room_id;
    const direct = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('auto_room'),
      kind: 'direct',
      members: [agentA.actor_id],
    });

    const collector = notificationCollector(agentAConnection.client);
    subscription = await openSubscription(agentAConnection.client, [STREAM_URI]);
    const login = await callTool<LoginResult>(agentAConnection.client, 'network_login');
    checkEqual('自动投递验收：Agent A 上线成功', login.online, true);
    await collector.waitFor(
      (event) => hasStreamItem(event, (item) => item.source === 'session.login'),
      '等待自动投递验收 login 帧',
    );
    collector.reset();

    const aBase = await inbox(agentAConnection, 'pending');
    const bBase = await inbox(agentBConnection, 'pending');

    const first = await sendMessage(human, groupId, '群里第一条，没有上一条 Agent');
    checkEqual('群聊首条 human 消息不自动投递', first.delivery_ids.length, 0);

    const agentFirst = await sendMessage(agentAConnection, groupId, 'Agent A 先说话');
    checkEqual('Agent 发送不自动投递', agentFirst.delivery_ids.length, 0);

    const auto = await sendMessage(human, groupId, '收到，继续');
    checkEqual('human 紧跟 Agent 且无 @ 自动创建 1 条 delivery', auto.delivery_ids.length, 1);
    const aAfterAuto = await inbox(agentAConnection, 'pending');
    const bAfterAuto = await inbox(agentBConnection, 'pending');
    check(
      '自动投递目标为紧邻上一条 Agent 的发送者',
      deliveryFor(aAfterAuto, auto.message.message_id, agentA.actor_id),
      aAfterAuto.items,
    );
    check(
      '自动投递不投给其他 Agent',
      !deliveryFor(bAfterAuto, auto.message.message_id, agentB.actor_id),
      bAfterAuto.items,
    );
    checkEqual('自动投递后目标 pending_count +1', aAfterAuto.pending_count, aBase.pending_count + 1);
    await collector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.created' &&
            item.message_id === auto.message.message_id &&
            item.attention === 'action_required',
        ),
      '等待自动投递 delivery.created 通知',
    );
    check('自动投递推送 action_required 通知', true);

    const humanFollowUp = await sendMessage(human, groupId, '再补一句');
    checkEqual('上一条是 human 时不自动投递', humanFollowUp.delivery_ids.length, 0);
    checkEqual(
      '上一条是 human 时不改变 Agent A pending_count',
      (await inbox(agentAConnection, 'pending')).pending_count,
      aAfterAuto.pending_count,
    );

    const agentBFirst = await sendMessage(agentBConnection, groupId, 'Agent B 先说话');
    checkEqual('Agent B 发送不自动投递', agentBFirst.delivery_ids.length, 0);
    const explicit = await sendMessage(human, groupId, '显式找 A 处理', {
      invoke: [agentA.actor_id],
    });
    checkEqual('显式 invoke 只创建 1 条 delivery', explicit.delivery_ids.length, 1);
    const aExplicit = await inbox(agentAConnection, 'pending');
    const bExplicit = await inbox(agentBConnection, 'pending');
    check(
      '显式 invoke 只投给显式目标',
      deliveryFor(aExplicit, explicit.message.message_id, agentA.actor_id),
      aExplicit.items,
    );
    check(
      '显式 invoke 不追加紧邻上一条 Agent B',
      !deliveryFor(bExplicit, explicit.message.message_id, agentB.actor_id),
      bExplicit.items,
    );

    const agentBSecond = await sendMessage(agentBConnection, groupId, 'Agent B 又说一句');
    checkEqual('Agent B 第二次发送不自动投递', agentBSecond.delivery_ids.length, 0);
    const mentionAgent = await sendMessage(human, groupId, `@${agentA.name} 请处理`);
    checkEqual('正文 @Agent 只创建 1 条 delivery', mentionAgent.delivery_ids.length, 1);
    const aMentionAgent = await inbox(agentAConnection, 'pending');
    const bMentionAgent = await inbox(agentBConnection, 'pending');
    check(
      '正文 @Agent 投给被点名 Agent',
      deliveryFor(aMentionAgent, mentionAgent.message.message_id, agentA.actor_id),
      aMentionAgent.items,
    );
    check(
      '正文 @Agent 不自动追加紧邻上一条 Agent B',
      !deliveryFor(bMentionAgent, mentionAgent.message.message_id, agentB.actor_id),
      bMentionAgent.items,
    );

    const agentBThird = await sendMessage(agentBConnection, groupId, 'Agent B 再补一句');
    checkEqual('Agent B 第三次发送不自动投递', agentBThird.delivery_ids.length, 0);
    const mentionHuman = await sendMessage(human, groupId, `@${owner.name} 这条是普通回复`);
    checkEqual('正文 @human 成员阻断自动投递', mentionHuman.delivery_ids.length, 0);
    const bMentionHuman = await inbox(agentBConnection, 'pending');
    check(
      '正文 @human 成员不投给紧邻上一条 Agent B',
      !deliveryFor(bMentionHuman, mentionHuman.message.message_id, agentB.actor_id),
      bMentionHuman.items,
    );

    const agentBFourth = await sendMessage(agentBConnection, groupId, 'Agent B 等待未知 @');
    checkEqual('Agent B 第四次发送不自动投递', agentBFourth.delivery_ids.length, 0);
    const unknownMention = await sendMessage(human, groupId, '@Ghost 不存在 请继续');
    checkEqual('@未知成员不阻断自动投递', unknownMention.delivery_ids.length, 1);
    const bUnknown = await inbox(agentBConnection, 'pending');
    check(
      '@未知成员时自动投递给紧邻上一条 Agent B',
      deliveryFor(bUnknown, unknownMention.message.message_id, agentB.actor_id),
      bUnknown.items,
    );

    const directAgent = await sendMessage(agentAConnection, direct.room.room_id, 'direct 里的 Agent 消息');
    checkEqual('direct 中 Agent 发送不自动投递', directAgent.delivery_ids.length, 0);
    const directReply = await sendMessage(human, direct.room.room_id, 'direct 回复不自动');
    checkEqual('direct 中 human 回复不自动投递', directReply.delivery_ids.length, 0);

    const agentBFifth = await sendMessage(agentBConnection, groupId, 'Agent B 之后 Agent A 说话');
    checkEqual('Agent B 第五次发送不自动投递', agentBFifth.delivery_ids.length, 0);
    const agentReply = await sendMessage(agentAConnection, groupId, 'Agent A 普通回复');
    checkEqual('Agent 发送不自动投递给上一条 Agent', agentReply.delivery_ids.length, 0);
    check(
      'Agent 发送后自己没有新 delivery',
      !deliveryFor(await inbox(agentAConnection, 'pending'), agentReply.message.message_id, agentA.actor_id),
    );

    const replayRequest = newRequestId('auto_replay');
    const replayClient = `cm_${crypto.randomUUID()}`;
    const replayFirst = await sendMessage(human, groupId, '重放自动投递', {
      requestId: replayRequest,
      clientMessageId: replayClient,
    });
    checkEqual('自动投递首次创建 1 条 delivery', replayFirst.delivery_ids.length, 1);
    const aAfterReplayFirst = await inbox(agentAConnection, 'pending');
    check(
      '自动投递重放前目标收到该消息',
      deliveryFor(aAfterReplayFirst, replayFirst.message.message_id, agentA.actor_id),
      aAfterReplayFirst.items,
    );
    const replaySecond = await sendMessage(human, groupId, '重放自动投递', {
      requestId: replayRequest,
      clientMessageId: replayClient,
    });
    checkEqual('同 request_id 重放返回同一消息', replaySecond.message.message_id, replayFirst.message.message_id);
    checkEqual('同 request_id 重放不新增 delivery', replaySecond.delivery_ids.length, 1);
    checkEqual(
      '同 request_id 重放 delivery_ids 稳定',
      replaySecond.delivery_ids.join(','),
      replayFirst.delivery_ids.join(','),
    );
    const aAfterReplaySecond = await inbox(agentAConnection, 'pending');
    checkEqual(
      '自动投递重放不增加 pending_count',
      aAfterReplaySecond.pending_count,
      aAfterReplayFirst.pending_count,
    );
    checkEqual(
      '自动投递重放只保留一条该消息的 delivery',
      aAfterReplaySecond.items.filter(
        (item) => item.message_id === replayFirst.message.message_id && item.recipient_id === agentA.actor_id,
      ).length,
      1,
    );

    const agentCSend = await sendMessage(agentCConnection, groupId, '即将被移除的 Agent C');
    checkEqual('Agent C 发送不自动投递', agentCSend.delivery_ids.length, 0);
    await callTool(human.client, 'network_room_members_update', {
      request_id: newRequestId('auto_remove'),
      room_id: groupId,
      remove: [agentC.actor_id],
    });
    const removedReply = await sendMessage(human, groupId, '上一条 Agent 已移除');
    checkEqual('上一条 Agent 已被移除时不自动投递', removedReply.delivery_ids.length, 0);
    const cAfterRemoval = await inbox(agentCConnection, 'all');
    check(
      '被移除 Agent 没有新 delivery',
      !deliveryFor(cAfterRemoval, removedReply.message.message_id, agentC.actor_id),
      cAfterRemoval.items,
    );
  } finally {
    await subscription?.close().catch(() => undefined);
    await Promise.all([
      human.close(),
      agentAConnection.close(),
      agentBConnection.close(),
      agentCConnection.close(),
    ]);
  }
}

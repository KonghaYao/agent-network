/**
 * M03 无隐式投递验收：紧跟 Agent、附件、代码、引用、转发与普通回复都不派活。
 *
 * 与 mention-acceptance 的正向用例互补：这里只断言“没有创建 delivery”，
 * 包括 pending_count 不变、消息仍写入历史、mentions 不包含被误唤醒的 Agent。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
} from './harness';
import {
  acceptGroupInvites,
  befriend,
  inbox,
  registerIdentity,
  sendMessage,
  type Identity,
  type InboxPage,
  type RoomDetail,
} from './acceptance-helpers';

function deliveryFor(page: InboxPage, messageId: string, recipientId: string): boolean {
  return page.items.some(
    (item) => item.message_id === messageId && item.recipient_id === recipientId,
  );
}

export async function runGroupNoImplicitDeliveryAcceptance(): Promise<void> {
  console.log('  · 群聊无隐式投递（紧跟 Agent / 附件 / 代码 / 引用）');
  const human = await connectClient(newToken());
  const agentAConnection = await connectClient(newToken());
  const agentBConnection = await connectClient(newToken());
  try {
    const owner = await registerIdentity(human, { kind: 'human', name: '无隐式投递用户' });
    const agentA = await registerIdentity(agentAConnection, {
      kind: 'agent',
      name: '无隐式 Agent A',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const agentB = await registerIdentity(agentBConnection, {
      kind: 'agent',
      name: '无隐式 Agent B',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const agents: Identity[] = [agentA, agentB];
    const connections = [agentAConnection, agentBConnection];
    for (let index = 0; index < agents.length; index += 1) {
      await befriend(
        human,
        owner.actor_id,
        connections[index]!,
        (agents[index] as Identity).actor_id,
      );
    }
    const group = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('no_implicit_room'),
      kind: 'group',
      title: '无隐式投递验收群',
      members: agents.map((agent) => agent.actor_id),
    });
    const groupId = group.room.room_id;
    for (const connection of connections) {
      await acceptGroupInvites(connection, groupId);
    }
    const direct = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('no_implicit_room'),
      kind: 'direct',
      members: [agentA.actor_id],
    });

    const aBase = await inbox(agentAConnection, 'pending');
    const bBase = await inbox(agentBConnection, 'pending');

    const agentFirst = await sendMessage(agentAConnection, groupId, 'Agent A 先说话');
    checkEqual('Agent 发送不创建 delivery', agentFirst.delivery_ids.length, 0);
    const adjacent = await sendMessage(human, groupId, '收到，继续');
    checkEqual('紧跟 Agent 的普通回复不创建 delivery', adjacent.delivery_ids.length, 0);
    checkEqual('紧跟 Agent 的普通回复没有 mentions', adjacent.message.mentions.length, 0);
    const aAfterAdjacent = await inbox(agentAConnection, 'pending');
    checkEqual(
      '紧跟 Agent 不改变 Agent A pending_count',
      aAfterAdjacent.pending_count,
      aBase.pending_count,
    );
    check(
      '紧跟 Agent 不留下投递记录',
      !deliveryFor(aAfterAdjacent, adjacent.message.message_id, agentA.actor_id),
      aAfterAdjacent.items,
    );

    const followUp = await sendMessage(human, groupId, '再补一句普通回复');
    checkEqual('连续普通回复不创建 delivery', followUp.delivery_ids.length, 0);

    const codeBlock = await sendMessage(human, groupId, '```\n@无隐式 Agent A\n```');
    checkEqual('围栏代码中的 @ 不创建 delivery', codeBlock.delivery_ids.length, 0);
    checkEqual('围栏代码中的 @ 不记录 mentions', codeBlock.message.mentions.length, 0);

    const inlineCode = await sendMessage(human, groupId, '示例 `@无隐式 Agent A` 仅代码');
    checkEqual('行内代码中的 @ 不创建 delivery', inlineCode.delivery_ids.length, 0);

    const quoted = await sendMessage(
      human,
      groupId,
      '> @无隐式 Agent A 历史消息\n收到',
    );
    checkEqual('引用历史中的 @ 不创建 delivery', quoted.delivery_ids.length, 0);
    checkEqual('引用历史中的 @ 不记录 mentions', quoted.message.mentions.length, 0);

    const urlAttachment = await sendMessage(
      human,
      groupId,
      '附件：https://example.com/f/@无隐式 Agent A.txt',
    );
    checkEqual('附件 URL 中的 @ 不创建 delivery', urlAttachment.delivery_ids.length, 0);

    const fileAndText = await sendMessage(
      human,
      groupId,
      '看一下这个文件\nhttps://net.example/f/f_abcdefghijklmnopqrstuv',
    );
    checkEqual('上传附件后发送不创建 delivery', fileAndText.delivery_ids.length, 0);
    checkEqual('上传附件后发送没有 mentions', fileAndText.message.mentions.length, 0);

    const unknownMention = await sendMessage(human, groupId, '@Ghost 不存在 请继续');
    checkEqual('@非成员名字不创建 delivery', unknownMention.delivery_ids.length, 0);

    const optOut = await sendMessage(human, groupId, '@无隐式 Agent A 只是文字', {
      invoke: [],
    });
    checkEqual('显式 invoke: [] 关闭派活', optOut.delivery_ids.length, 0);
    checkEqual('显式 invoke: [] 不记录 mentions', optOut.message.mentions.length, 0);

    const aAfterSequence = await inbox(agentAConnection, 'pending');
    checkEqual(
      '整段无显式目标的消息不改变 pending_count',
      aAfterSequence.pending_count,
      aBase.pending_count,
    );

    const explicit = await sendMessage(human, groupId, '显式找 A 处理', {
      invoke: [agentA.actor_id],
    });
    checkEqual('显式 invoke 创建 1 条 delivery', explicit.delivery_ids.length, 1);
    checkEqual(
      '显式 invoke 记录 explicit Agent 提及',
      JSON.stringify(explicit.message.mentions),
      JSON.stringify([{ actor_id: agentA.actor_id, kind: 'agent', source: 'explicit' }]),
    );
    const aAfterExplicit = await inbox(agentAConnection, 'pending');
    const bAfterExplicit = await inbox(agentBConnection, 'pending');
    check(
      '显式 invoke 只投给指定 Agent',
      deliveryFor(aAfterExplicit, explicit.message.message_id, agentA.actor_id) &&
        !deliveryFor(bAfterExplicit, explicit.message.message_id, agentB.actor_id),
      { a: aAfterExplicit.items, b: bAfterExplicit.items },
    );
    checkEqual(
      '显式 invoke 只改变目标 pending_count',
      aAfterExplicit.pending_count,
      aBase.pending_count + 1,
    );
    checkEqual('显式 invoke 不改变其他 Agent pending_count', bAfterExplicit.pending_count, bBase.pending_count);

    const replayRequest = newRequestId('no_implicit_replay');
    const replayClient = `cm_${crypto.randomUUID()}`;
    const replayFirst = await sendMessage(human, groupId, '重放显式目标', {
      requestId: replayRequest,
      clientMessageId: replayClient,
      invoke: [agentA.actor_id],
    });
    const replaySecond = await sendMessage(human, groupId, '重放显式目标', {
      requestId: replayRequest,
      clientMessageId: replayClient,
      invoke: [agentA.actor_id],
    });
    checkEqual('同 request_id 重放返回同一消息', replaySecond.message.message_id, replayFirst.message.message_id);
    checkEqual('同 request_id 重放不新增 delivery', replaySecond.delivery_ids.length, 1);
    checkEqual(
      '同 request_id 重放 delivery_ids 稳定',
      replaySecond.delivery_ids.join(','),
      replayFirst.delivery_ids.join(','),
    );

    const directAgent = await sendMessage(agentAConnection, direct.room.room_id, 'direct 里的 Agent 消息');
    checkEqual('direct 中 Agent 发送不创建 delivery', directAgent.delivery_ids.length, 0);
    const directReply = await sendMessage(human, direct.room.room_id, 'direct 普通回复');
    checkEqual('direct 服务端普通回复不自动创建 delivery', directReply.delivery_ids.length, 0);

    const agentBMessage = await sendMessage(agentBConnection, groupId, 'Agent B 即将被移除');
    checkEqual('Agent B 发送不创建 delivery', agentBMessage.delivery_ids.length, 0);
    await callTool(human.client, 'network_room_members_update', {
      request_id: newRequestId('no_implicit_remove'),
      room_id: groupId,
      remove: [agentB.actor_id],
    });
    const removedPlain = await sendMessage(human, groupId, '上一条 Agent 已移除');
    checkEqual('上一条 Agent 已移除时普通回复不创建 delivery', removedPlain.delivery_ids.length, 0);
    const cAfterRemoval = await inbox(agentBConnection, 'all');
    check(
      '被移除 Agent 没有新 delivery',
      !deliveryFor(cAfterRemoval, removedPlain.message.message_id, agentB.actor_id),
      cAfterRemoval.items,
    );
  } finally {
    await Promise.all([human.close(), agentAConnection.close(), agentBConnection.close()]);
  }
}

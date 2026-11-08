/**
 * Agent 群消息自动 @ 前一个有效成员验收。
 *
 * 自动 @ 只是显示与人类提醒：不进入 invoke、不创建 Agent delivery、
 * 不增加 pending_count，也不额外推进房间 head。显式 invoke/mentions、
 * direct、同名歧义、成员移除、正文上限与幂等重放都在这里覆盖。
 */

import { LIMITS } from '../../src/contracts/limits';
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
  readWholeMessage,
  registerIdentity,
  sendMessage,
  type Identity,
  type InboxPage,
  type RoomDetail,
  type SendResult,
} from './acceptance-helpers';

interface InboxEventRef {
  type: string;
  ref_id: string | null;
  metadata: Record<string, unknown>;
}

async function inboxEvents(connection: Awaited<ReturnType<typeof connectClient>>): Promise<InboxEventRef[]> {
  const page = await callTool<{ items: InboxEventRef[] }>(connection.client, 'network_sync', {
    scope: 'inbox',
    limit: 100,
  });
  return page.items;
}

function reminderFor(events: InboxEventRef[], messageId: string): InboxEventRef | undefined {
  return events.find(
    (event) => event.type === 'mention_reminder' && event.metadata.message_id === messageId,
  );
}

function mentionSignature(message: SendResult['message']): string {
  return message.mentions
    .map((mention) => `${mention.actor_id}:${mention.kind}:${mention.source}`)
    .sort()
    .join(',');
}

async function roomHead(
  connection: Awaited<ReturnType<typeof connectClient>>,
  roomId: string,
): Promise<string> {
  const detail = await callTool<RoomDetail>(connection.client, 'network_room_get', {
    room_id: roomId,
  });
  return detail.room.head_seq;
}

async function assertNoDelivery(
  connection: Awaited<ReturnType<typeof connectClient>>,
  label: string,
  result: SendResult,
): Promise<void> {
  checkEqual(`${label}不创建 delivery`, result.delivery_ids.length, 0);
  const page: InboxPage = await inbox(connection, 'all');
  check(
    `${label}不留下投递记录`,
    !page.items.some((item) => item.message_id === result.message.message_id),
    page.items,
  );
}

export async function runAutoMentionAcceptance(): Promise<void> {
  console.log('  · Agent 群消息自动 @ 前一个有效成员');
  const ownerConnection = await connectClient(newToken());
  const agentAConnection = await connectClient(newToken());
  const agentBConnection = await connectClient(newToken());
  const sameAConnection = await connectClient(newToken());
  const sameBConnection = await connectClient(newToken());
  const targetConnection = await connectClient(newToken());
  const noTargetConnection = await connectClient(newToken());
  const connections = [
    ownerConnection,
    agentAConnection,
    agentBConnection,
    sameAConnection,
    sameBConnection,
    targetConnection,
    noTargetConnection,
  ];
  try {
    const owner = await registerIdentity(ownerConnection, {
      kind: 'human',
      name: '自动提及用户',
    });
    const agentA = await registerIdentity(agentAConnection, {
      kind: 'agent',
      name: '自动提及 Agent A',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const agentB = await registerIdentity(agentBConnection, {
      kind: 'agent',
      name: '自动提及 Agent B',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const sameA = await registerIdentity(sameAConnection, {
      kind: 'agent',
      name: '同名自动代理',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const sameB = await registerIdentity(sameBConnection, {
      kind: 'agent',
      name: '同名自动代理',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const target = await registerIdentity(targetConnection, {
      kind: 'human',
      name: '回退目标',
    });
    const noTarget = await registerIdentity(noTargetConnection, {
      kind: 'human',
      name: '无目标成员',
    });

    const befriendAll = async (
      connection: (typeof connections)[number],
      identity: Identity,
    ): Promise<void> => {
      await befriend(ownerConnection, owner.actor_id, connection, identity.actor_id);
    };
    for (const [connection, identity] of [
      [agentAConnection, agentA],
      [agentBConnection, agentB],
      [sameAConnection, sameA],
      [sameBConnection, sameB],
      [targetConnection, target],
      [noTargetConnection, noTarget],
    ] as const) {
      await befriendAll(connection, identity);
    }

    const createGroup = async (
      title: string,
      members: { connection: (typeof connections)[number]; identity: Identity }[],
    ): Promise<string> => {
      const group = await callTool<RoomDetail>(ownerConnection.client, 'network_room_create', {
        request_id: newRequestId('auto_mention_room'),
        kind: 'group',
        title,
        members: members.map((item) => item.identity.actor_id),
      });
      const roomId = group.room.room_id;
      for (const member of members) {
        await acceptGroupInvites(member.connection, roomId);
      }
      return roomId;
    };

    const mainRoom = await createGroup('自动提及验收群', [
      { connection: agentAConnection, identity: agentA },
      { connection: agentBConnection, identity: agentB },
    ]);
    const ambiguityRoom = await createGroup('自动提及歧义群', [
      { connection: sameAConnection, identity: sameA },
      { connection: sameBConnection, identity: sameB },
    ]);
    const removalRoom = await createGroup('自动提及移除群', [
      { connection: targetConnection, identity: target },
      { connection: agentAConnection, identity: agentA },
    ]);
    const noTargetRoom = await createGroup('自动提及无目标群', [
      { connection: noTargetConnection, identity: noTarget },
      { connection: agentAConnection, identity: agentA },
    ]);
    const direct = await callTool<RoomDetail>(ownerConnection.client, 'network_room_create', {
      request_id: newRequestId('auto_mention_direct'),
      kind: 'direct',
      members: [agentA.actor_id],
    });
    const directRoom = direct.room.room_id;

    // 1. 人类前一条 → Agent 回复自动 @ 人类，只产生提醒。
    const aBase = await inbox(agentAConnection, 'pending');
    const bBase = await inbox(agentBConnection, 'pending');
    const humanFirst = await sendMessage(ownerConnection, mainRoom, '自动提及：请开始');
    const aReply = await sendMessage(agentAConnection, mainRoom, '收到，已开始');
    const aReplyBody = await readWholeMessage(agentAConnection, aReply.message.message_id);
    check(
      '人类前一条：Agent 回复自动 @ 人类',
      aReplyBody === '收到，已开始\n@自动提及用户',
      aReplyBody,
    );
    checkEqual(
      '人类前一条：自动 @ 记录为 text 提及',
      mentionSignature(aReply.message),
      `${owner.actor_id}:human:text`,
    );
    await assertNoDelivery(agentAConnection, '人类前一条：自动 @', aReply);
    const aAfterHuman = await inbox(agentAConnection, 'pending');
    checkEqual('人类前一条：Agent pending_count 不变', aAfterHuman.pending_count, aBase.pending_count);
    checkEqual('人类前一条：房间 head 只到消息本身', await roomHead(ownerConnection, mainRoom), aReply.message.created_seq);
    check(
      '人类前一条：人类收到 mention_reminder',
      Boolean(reminderFor(await inboxEvents(ownerConnection), aReply.message.message_id)),
    );
    check('人类前一条：普通消息仍写入历史', Boolean(humanFirst.message.message_id));

    // 2. Agent 前一条 → 自动 @ Agent，但没有 delivery/pending。
    const bReply = await sendMessage(agentBConnection, mainRoom, 'B 继续');
    const bReplyBody = await readWholeMessage(agentBConnection, bReply.message.message_id);
    check(
      'Agent 前一条：自动 @ 上一个 Agent',
      bReplyBody === 'B 继续\n@自动提及 Agent A',
      bReplyBody,
    );
    checkEqual(
      'Agent 前一条：记录 text 提及',
      mentionSignature(bReply.message),
      `${agentA.actor_id}:agent:text`,
    );
    await assertNoDelivery(agentBConnection, 'Agent 前一条：自动 @', bReply);
    const aAfterB = await inbox(agentAConnection, 'pending');
    const bAfterB = await inbox(agentBConnection, 'pending');
    checkEqual('Agent 前一条：目标 pending_count 不变', aAfterB.pending_count, aBase.pending_count);
    checkEqual('Agent 前一条：发送者 pending_count 不变', bAfterB.pending_count, bBase.pending_count);
    checkEqual('Agent 前一条：房间 head 只到消息本身', await roomHead(ownerConnection, mainRoom), bReply.message.created_seq);

    // 3. 两个 Agent 互相回复仍不产生隐式 delivery。
    const aAgain = await sendMessage(agentAConnection, mainRoom, 'A 再回复');
    const aAgainBody = await readWholeMessage(agentAConnection, aAgain.message.message_id);
    checkEqual('两个 Agent 互相回复自动 @ 对方', aAgainBody, 'A 再回复\n@自动提及 Agent B');
    await assertNoDelivery(agentAConnection, '两个 Agent 互相回复', aAgain);

    // 4. direct 不追加。
    await sendMessage(ownerConnection, directRoom, 'direct 前一条');
    const directReply = await sendMessage(agentAConnection, directRoom, 'direct 回复');
    checkEqual(
      'direct 不追加自动 @',
      await readWholeMessage(agentAConnection, directReply.message.message_id),
      'direct 回复',
    );
    checkEqual('direct 不记录 mentions', directReply.message.mentions.length, 0);
    await assertNoDelivery(agentAConnection, 'direct 自动 @', directReply);

    // 5. 正文已经包含精确 @：不重复追加。
    await sendMessage(ownerConnection, mainRoom, '去重前一条');
    const dedupe = await sendMessage(
      agentAConnection,
      mainRoom,
      '请 @自动提及用户 看一下',
    );
    const dedupeBody = await readWholeMessage(agentAConnection, dedupe.message.message_id);
    checkEqual('正文已有 @ 时不重复追加', dedupeBody, '请 @自动提及用户 看一下');
    checkEqual(
      '正文已有 @ 只保留一条提及',
      mentionSignature(dedupe.message),
      `${owner.actor_id}:human:text`,
    );
    await assertNoDelivery(agentAConnection, '正文已有 @', dedupe);

    // 6. 显式 invoke 优先：不追加，仍只投给显式目标。
    await sendMessage(ownerConnection, mainRoom, '显式派活前一条');
    const explicitInvoke = await sendMessage(agentAConnection, mainRoom, '显式派活', {
      invoke: [agentB.actor_id],
    });
    checkEqual(
      '显式 invoke 不追加自动 @',
      await readWholeMessage(agentAConnection, explicitInvoke.message.message_id),
      '显式派活',
    );
    checkEqual('显式 invoke 仍只创建一条 delivery', explicitInvoke.delivery_ids.length, 1);
    checkEqual(
      '显式 invoke 只记录显式目标',
      mentionSignature(explicitInvoke.message),
      `${agentB.actor_id}:agent:explicit`,
    );
    const explicitDelivery = (await inbox(agentBConnection, 'pending')).items.find(
      (item) => item.message_id === explicitInvoke.message.message_id,
    );
    check('显式 invoke 投递给指定 Agent', Boolean(explicitDelivery), explicitDelivery);
    if (explicitDelivery) {
      const claim = await callTool<{ delivery_id: string; attempt: number; claim_id: string }>(
        agentBConnection.client,
        'network_delivery_claim',
        {
          request_id: newRequestId('auto_mention_claim'),
          delivery_id: explicitDelivery.delivery_id,
        },
      );
      await callTool(agentBConnection.client, 'network_delivery_complete', {
        request_id: newRequestId('auto_mention_complete'),
        delivery_id: claim.delivery_id,
        attempt: claim.attempt,
        claim_id: claim.claim_id,
      });
    }

    // 7. 显式 invoke: [] 不追加。
    await sendMessage(ownerConnection, mainRoom, '显式关闭前一条');
    const optOut = await sendMessage(agentAConnection, mainRoom, '明确不派活', {
      invoke: [],
    });
    checkEqual(
      '显式 invoke: [] 不追加自动 @',
      await readWholeMessage(agentAConnection, optOut.message.message_id),
      '明确不派活',
    );
    checkEqual('显式 invoke: [] 不记录 mentions', optOut.message.mentions.length, 0);
    await assertNoDelivery(agentAConnection, '显式 invoke: []', optOut);

    // 8. 非空 mentions 不追加。
    await sendMessage(ownerConnection, mainRoom, '显式提醒前一条');
    const explicitMention = await sendMessage(agentAConnection, mainRoom, '显式提醒', {
      mentions: [owner.actor_id],
    });
    checkEqual(
      '非空 mentions 不追加自动 @',
      await readWholeMessage(agentAConnection, explicitMention.message.message_id),
      '显式提醒',
    );
    checkEqual(
      '非空 mentions 只记录显式人类提醒',
      mentionSignature(explicitMention.message),
      `${owner.actor_id}:human:explicit`,
    );
    await assertNoDelivery(agentAConnection, '非空 mentions', explicitMention);

    // 9. 前一条发送者被移除：回退到更早的 active 成员。
    await sendMessage(ownerConnection, removalRoom, '更早的有效消息');
    await sendMessage(targetConnection, removalRoom, '将被移除的消息');
    await callTool(ownerConnection.client, 'network_room_members_update', {
      request_id: newRequestId('auto_mention_remove'),
      room_id: removalRoom,
      remove: [target.actor_id],
    });
    const fallback = await sendMessage(agentAConnection, removalRoom, '回退测试');
    checkEqual(
      '前一条发送者被移除后回退到更早 active 成员',
      await readWholeMessage(agentAConnection, fallback.message.message_id),
      '回退测试\n@自动提及用户',
    );
    await assertNoDelivery(agentAConnection, '移除后回退', fallback);

    // 10. 前一条发送者被移除且没有更早消息：不追加。
    await sendMessage(noTargetConnection, noTargetRoom, '唯一历史消息');
    await callTool(ownerConnection.client, 'network_room_members_update', {
      request_id: newRequestId('auto_mention_remove'),
      room_id: noTargetRoom,
      remove: [noTarget.actor_id],
    });
    const noTargetMessage = await sendMessage(agentAConnection, noTargetRoom, '无目标测试');
    checkEqual(
      '没有更早 active 成员时不追加',
      await readWholeMessage(agentAConnection, noTargetMessage.message.message_id),
      '无目标测试',
    );
    checkEqual('无目标时不记录 mentions', noTargetMessage.message.mentions.length, 0);
    await assertNoDelivery(agentAConnection, '无目标', noTargetMessage);

    // 11. 目标名字在当前 active 成员中不唯一：跳过自动 @。
    await sendMessage(ownerConnection, ambiguityRoom, '歧义前一条');
    const sameAFirst = await sendMessage(sameAConnection, ambiguityRoom, '同名 A 说话');
    check(
      '同名场景中唯一的人类目标仍可自动 @',
      (await readWholeMessage(sameAConnection, sameAFirst.message.message_id)).endsWith(
        '@自动提及用户',
      ),
    );
    const ambiguous = await sendMessage(sameBConnection, ambiguityRoom, '同名歧义测试');
    checkEqual(
      '同名歧义时跳过自动 @',
      await readWholeMessage(sameBConnection, ambiguous.message.message_id),
      '同名歧义测试',
    );
    checkEqual('同名歧义时不记录 mentions', ambiguous.message.mentions.length, 0);
    await assertNoDelivery(sameBConnection, '同名歧义', ambiguous);

    // 12. 接近正文上限：追加会超限时跳过自动 @，消息仍按原正文发送。
    await sendMessage(ownerConnection, mainRoom, '上限前一条');
    const nearLimitBody = 'a'.repeat(LIMITS.messageBodyBytes);
    const nearLimit = await sendMessage(agentAConnection, mainRoom, nearLimitBody);
    checkEqual(
      '接近正文上限时跳过自动 @',
      nearLimit.message.body_bytes,
      LIMITS.messageBodyBytes,
    );
    checkEqual('超限跳过时不记录 mentions', nearLimit.message.mentions.length, 0);
    await assertNoDelivery(agentAConnection, '接近正文上限', nearLimit);

    // 13. 幂等重放返回原消息与原文，不重复追加。
    await sendMessage(ownerConnection, mainRoom, '重放前一条');
    const replayRequest = newRequestId('auto_mention_replay');
    const replayClient = `cm_${crypto.randomUUID()}`;
    const replayFirst = await sendMessage(agentAConnection, mainRoom, '重放消息', {
      requestId: replayRequest,
      clientMessageId: replayClient,
    });
    const replaySecond = await sendMessage(agentAConnection, mainRoom, '重放消息', {
      requestId: replayRequest,
      clientMessageId: replayClient,
    });
    checkEqual('同 request_id 重放返回同一消息', replaySecond.message.message_id, replayFirst.message.message_id);
    checkEqual(
      '重放返回原消息原文且只追加一次',
      await readWholeMessage(agentAConnection, replaySecond.message.message_id),
      '重放消息\n@自动提及用户',
    );
    checkEqual('重放不新增 delivery', replaySecond.delivery_ids.length, 0);

    // 14. 同一 client_message_id 重放（新 request_id）仍按原正文幂等。
    const clientReplay = await sendMessage(agentAConnection, mainRoom, '重放消息', {
      clientMessageId: replayClient,
    });
    checkEqual(
      '同 client_message_id 重放返回同一消息',
      clientReplay.message.message_id,
      replayFirst.message.message_id,
    );
    checkEqual(
      '同 client_message_id 重放不重复追加',
      await readWholeMessage(agentAConnection, clientReplay.message.message_id),
      '重放消息\n@自动提及用户',
    );
  } finally {
    await Promise.all(connections.map((connection) => connection.close()));
  }
}

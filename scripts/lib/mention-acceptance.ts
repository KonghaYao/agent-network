/**
 * 群聊 @ 名字服务端解析的端到端验收。
 *
 * 覆盖省略 invoke、显式 invoke 优先、invoke: [] opt-out、direct/claim/
 * final_body 不解析、最长匹配、同名与超限错误、幂等重放、成员移除、
 * pending_count 与统一 stream 通知。不修改全局验收流程的其他用例。
 */

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
  rawRpc,
} from './harness';
import {
  acceptGroupInvitesWithToken,
  registerIdentity,
  sendMessage,
  type Delivery,
  type Identity,
  type InboxPage,
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

interface RawToolResult<T> {
  isError?: boolean;
  structuredContent?: T;
  content?: { type: string; text?: string }[];
}

async function rawTool<T>(
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, { token });
  const result = response.body.result as RawToolResult<T> | undefined;
  if (!result) throw new Error(`工具 ${name} 无结果: ${JSON.stringify(response.body)}`);
  if (result.isError) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(`工具 ${name} 返回错误: ${text ?? JSON.stringify(result)}`);
  }
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error(`工具 ${name} 没有结构化结果`);
  return JSON.parse(text) as T;
}

async function inboxOf(token: string, state = 'pending'): Promise<InboxPage> {
  return rawTool<InboxPage>(token, 'network_inbox_list', { state });
}

function hasMessage(page: InboxPage, messageId: string): boolean {
  return page.items.some((item) => item.message_id === messageId);
}

async function roomHead(humanToken: string, roomId: string): Promise<string> {
  const room = await rawTool<RoomDetail>(humanToken, 'network_room_get', { room_id: roomId });
  return room.room.head_seq;
}

interface RawAgent {
  token: string;
  identity: Identity;
}

async function registerRawAgent(name: string): Promise<RawAgent> {
  const token = newToken();
  const identity = await rawTool<Identity>(token, 'network_register', {
    request_id: newRequestId('mention_reg'),
    kind: 'agent',
    name,
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  return { token, identity };
}

interface RawContactRequestResult {
  request: { contact_request_id: string } | null;
  status: string;
}

/** raw token 之间的好友申请；目标自行接受，不因 kind=agent 自动同意。 */
async function rawBefriend(
  requesterToken: string,
  targetToken: string,
  targetActorId: string,
): Promise<void> {
  const requested = await rawTool<RawContactRequestResult>(
    requesterToken,
    'network_contact_request',
    {
      request_id: newRequestId('mention_contact'),
      actor_id: targetActorId,
    },
  );
  if (requested.status === 'accepted') return;
  if (!requested.request) throw new Error('好友申请缺少 request');
  await rawTool(targetToken, 'network_contact_request_respond', {
    request_id: newRequestId('mention_contact_ok'),
    contact_request_id: requested.request.contact_request_id,
    action: 'accept',
  });
}

export async function runGroupMentionAcceptance(): Promise<void> {
  console.log('  · 群聊 @ 名字服务端解析');
  const humanToken = newToken();
  const human = await connectClient(humanToken);
  const m1Token = newToken();
  const m1 = await connectClient(m1Token);
  const m2Token = newToken();
  const m2 = await connectClient(m2Token);
  let subscription: Awaited<ReturnType<typeof openSubscription>> | null = null;
  try {
    const owner = await registerIdentity(human, { kind: 'human', name: '小明 🤖 同学 用户' });
    const m1Identity = await registerIdentity(m1, {
      kind: 'agent',
      name: '小明 🤖',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const m2Identity = await registerIdentity(m2, {
      kind: 'agent',
      name: '小明 🤖 同学',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });

    const caseBot = await registerRawAgent('CaseBot');
    const sameA = await registerRawAgent('同名机器人');
    const sameB = await registerRawAgent('同名机器人');
    const extras: RawAgent[] = [];
    for (let index = 1; index <= 6; index += 1) {
      extras.push(await registerRawAgent(`并行 Agent ${index}`));
    }
    const agents = [m1Identity, m2Identity, caseBot.identity, sameA.identity, sameB.identity, ...extras.map((item) => item.identity)];
    const agentTokens = [
      m1Token,
      m2Token,
      caseBot.token,
      sameA.token,
      sameB.token,
      ...extras.map((item) => item.token),
    ];

    for (let index = 0; index < agents.length; index += 1) {
      await rawBefriend(
        humanToken,
        agentTokens[index] as string,
        (agents[index] as Identity).actor_id,
      );
    }
    const group = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('mention_room'),
      kind: 'group',
      title: '@解析验收群',
      members: agents.map((agent) => agent.actor_id),
    });
    const groupId = group.room.room_id;
    for (const token of agentTokens) {
      await acceptGroupInvitesWithToken(token as string, groupId);
    }
    const direct = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('mention_room'),
      kind: 'direct',
      members: [m2Identity.actor_id],
    });

    // 订阅 + login：确认省略 invoke 的 @ 会创建 delivery 并推送。
    const collector = notificationCollector(m1.client);
    subscription = await openSubscription(m1.client, [STREAM_URI]);
    const login = await callTool<LoginResult>(m1.client, 'network_login');
    checkEqual('群 @ 验收：M1 上线成功', login.online, true);
    await collector.waitFor(
      (event) => hasStreamItem(event, (item) => item.source === 'session.login'),
      '等待群 @ 验收 login 帧',
    );
    collector.reset();

    const beforeFirst = await inboxOf(m1Token);
    const first = await sendMessage(human, groupId, '@小明 🤖 请处理第一条');
    checkEqual('省略 invoke 时正文 @Agent 创建 1 条 delivery', first.delivery_ids.length, 1);
    await collector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.created' &&
            item.message_id === first.message.message_id &&
            item.attention === 'action_required',
        ),
      '等待群 @ delivery.created 通知',
    );
    check('群 @ 创建 delivery 后推送 action_required 通知', true);
    const afterFirst = await inboxOf(m1Token);
    checkEqual('群 @ 创建 delivery 后 pending_count 增加 1', afterFirst.pending_count, beforeFirst.pending_count + 1);
    const firstDelivery = afterFirst.items.find(
      (item) => item.message_id === first.message.message_id && item.recipient_id === m1Identity.actor_id,
    );
    checkEqual('群 @ delivery 属于被 @ 的 Agent', firstDelivery?.recipient_id, m1Identity.actor_id);

    const multi = await sendMessage(human, groupId, '@小明 🤖 和 @CaseBot 请处理');
    checkEqual('多个 @Agent 各创建一条 delivery', multi.delivery_ids.length, 2);
    const m1Pending = await inboxOf(m1Token);
    const casePending = await inboxOf(caseBot.token);
    check(
      '多个 @ 的每个 Agent 都有自己的 delivery',
      hasMessage(m1Pending, multi.message.message_id) &&
        hasMessage(casePending, multi.message.message_id),
      { m1: m1Pending.items, case: casePending.items },
    );

    const repeated = await sendMessage(human, groupId, '@CaseBot @CaseBot 重复点名');
    checkEqual('同一名字重复 @ 只创建一条 delivery', repeated.delivery_ids.length, 1);
    const repeatedInbox = await inboxOf(caseBot.token);
    check(
      '重复 @ 只产生一条 delivery',
      repeatedInbox.items.filter((item) => item.message_id === repeated.message.message_id).length === 1,
      repeatedInbox.items,
    );

    const optOut = await sendMessage(human, groupId, '@小明 🤖 这是普通回复', { invoke: [] });
    checkEqual('invoke: [] 显式关闭群 @ 解析', optOut.delivery_ids.length, 0);
    const optOutM1 = await inboxOf(m1Token);
    check('invoke: [] 不创建 M1 delivery', !hasMessage(optOutM1, optOut.message.message_id), optOutM1.items);

    const explicitBody = await sendMessage(human, groupId, '@小明 🤖 正文目标', {
      invoke: [m2Identity.actor_id],
    });
    checkEqual('显式 invoke 优先且不解析正文', explicitBody.delivery_ids.length, 1);
    const explicitM1 = await inboxOf(m1Token);
    const explicitM2 = await inboxOf(m2Token);
    check(
      '显式 invoke 只投给显式目标',
      !hasMessage(explicitM1, explicitBody.message.message_id) &&
        hasMessage(explicitM2, explicitBody.message.message_id),
      { m1: explicitM1.items, m2: explicitM2.items },
    );

    const explicitBoth = await sendMessage(human, groupId, '@小明 🤖 和 @小明 🤖 同学 都点名', {
      invoke: [m1Identity.actor_id],
    });
    checkEqual('正文多个 @ 且显式 invoke 时只投显式目标', explicitBoth.delivery_ids.length, 1);
    const explicitBothM2 = await inboxOf(m2Token);
    check(
      '显式 invoke 不因正文 @ 追加目标',
      !hasMessage(explicitBothM2, explicitBoth.message.message_id),
      explicitBothM2.items,
    );

    const humanMention = await sendMessage(human, groupId, '@小明 🤖 同学 用户 请处理');
    checkEqual('@非 Agent 成员不创建 delivery', humanMention.delivery_ids.length, 0);
    const humanMentionM2 = await inboxOf(m2Token);
    check(
      '更长非 Agent 名字阻断短 Agent 前缀',
      !hasMessage(humanMentionM2, humanMention.message.message_id),
      humanMentionM2.items,
    );

    const selfMention = await sendMessage(m1, groupId, '@小明 🤖 自我回复');
    checkEqual('发送者 @ 自己不创建 delivery', selfMention.delivery_ids.length, 0);

    const missingMention = await sendMessage(human, groupId, '@不存在的人 请处理');
    checkEqual('@非成员名字不阻断自动投递上一条 Agent', missingMention.delivery_ids.length, 1);
    const missingMentionInbox = await inboxOf(m1Token);
    check(
      '@非成员名字时自动投递给上一条 Agent 发送者',
      hasMessage(missingMentionInbox, missingMention.message.message_id),
      missingMentionInbox.items,
    );

    const lowerCase = await sendMessage(human, groupId, '@casebot 大小写不同');
    checkEqual('@名字大小写敏感：小写不匹配', lowerCase.delivery_ids.length, 0);
    const exactCase = await sendMessage(human, groupId, '@CaseBot 大小写精确');
    checkEqual('@名字大小写敏感：精确匹配', exactCase.delivery_ids.length, 1);

    const wrongSpaces = await sendMessage(human, groupId, '@小明  🤖 空格不同');
    checkEqual('名字中的空格按存储值精确匹配', wrongSpaces.delivery_ids.length, 0);

    const longest = await sendMessage(human, groupId, '@小明 🤖 同学 请处理');
    checkEqual('最长名字优先：只投给更长名字的 Agent', longest.delivery_ids.length, 1);
    const longestInbox = await inboxOf(m2Token);
    const longestM1 = await inboxOf(m1Token);
    check(
      '最长匹配不投给较短前缀 Agent',
      hasMessage(longestInbox, longest.message.message_id) &&
        !hasMessage(longestM1, longest.message.message_id),
      { m2: longestInbox.items, m1: longestM1.items },
    );

    const sameABefore = await inboxOf(sameA.token);
    const sameBBefore = await inboxOf(sameB.token);
    const headBeforeDuplicate = await roomHead(humanToken, groupId);
    const duplicateError = await expectToolError(
      '两个 active Agent 同名时返回 INVALID_ARGUMENT',
      sendMessage(human, groupId, '@同名机器人 请处理'),
      'INVALID_ARGUMENT',
    );
    check(
      '同名错误不回显成员名字',
      typeof duplicateError.body.message === 'string' &&
        !duplicateError.body.message.includes('同名机器人'),
      duplicateError.body,
    );
    checkEqual('同名解析失败不推进房间 head', await roomHead(humanToken, groupId), headBeforeDuplicate);
    const sameAAfter = await inboxOf(sameA.token);
    const sameBAfter = await inboxOf(sameB.token);
    checkEqual('同名解析失败不改变 A 的 pending_count', sameAAfter.pending_count, sameABefore.pending_count);
    checkEqual('同名解析失败不改变 B 的 pending_count', sameBAfter.pending_count, sameBBefore.pending_count);

    const explicitSame = await sendMessage(human, groupId, '@同名机器人 显式指定', {
      invoke: [sameA.identity.actor_id],
    });
    checkEqual('同名场景仍可用显式 invoke', explicitSame.delivery_ids.length, 1);
    const sameAInbox = await inboxOf(sameA.token);
    const sameBInbox = await inboxOf(sameB.token);
    check(
      '显式 invoke 只投给指定同名 Agent',
      hasMessage(sameAInbox, explicitSame.message.message_id) &&
        !hasMessage(sameBInbox, explicitSame.message.message_id),
      { a: sameAInbox.items, b: sameBInbox.items },
    );

    const manyMentions = [
      m1Identity.name,
      m2Identity.name,
      caseBot.identity.name,
      ...extras.map((item) => item.identity.name),
    ]
      .map((name) => `@${name}`)
      .join(' ');
    checkEqual('超限 fixture 含 9 个不同 Agent 名字', manyMentions.split('@').length - 1, 9);
    const headBeforeMany = await roomHead(humanToken, groupId);
    const manyError = await expectToolError(
      '正文解析出的目标超过 8 个时返回 INVALID_ARGUMENT',
      sendMessage(human, groupId, `${manyMentions} 请处理`),
      'INVALID_ARGUMENT',
    );
    check(
      '超限错误沿用 invoke 上限文案',
      typeof manyError.body.message === 'string' && manyError.body.message.includes('8'),
      manyError.body,
    );
    checkEqual('超限解析失败不推进房间 head', await roomHead(humanToken, groupId), headBeforeMany);

    const codeBlock = await sendMessage(human, groupId, '```\n@CaseBot\n```');
    checkEqual('原文解析不跳过 Markdown 代码块', codeBlock.delivery_ids.length, 1);

    const directSend = await sendMessage(human, direct.room.room_id, '@小明 🤖 同学 单聊不解析');
    checkEqual('direct 省略 invoke 不解析正文 @', directSend.delivery_ids.length, 0);
    const directM2 = await inboxOf(m2Token);
    check('direct 不创建对方 delivery', !hasMessage(directM2, directSend.message.message_id), directM2.items);

    // claim 回复与 final_body 都不解析正文 @。
    const claimTarget = afterFirst.items.find(
      (item) => item.message_id === first.message.message_id && item.recipient_id === m1Identity.actor_id,
    );
    check('找到用于 claim 回复的投递', Boolean(claimTarget), afterFirst.items);
    const claim = await callTool<Delivery>(m1.client, 'network_delivery_claim', {
      request_id: newRequestId('mention_claim'),
      delivery_id: claimTarget!.delivery_id,
    });
    const claimReply = await sendMessage(m1, groupId, '@小明 🤖 同学 阶段回复', {
      claim: { delivery_id: claim.delivery_id, attempt: claim.attempt, claim_id: claim.claim_id! },
    });
    checkEqual('带 claim 的回复不解析正文 @', claimReply.delivery_ids.length, 0);
    const claimReplyM2 = await inboxOf(m2Token);
    check(
      'claim 回复不创建新 delivery',
      !hasMessage(claimReplyM2, claimReply.message.message_id),
      claimReplyM2.items,
    );
    const completed = await callTool<{ message: { message_id: string } | null }>(
      m1.client,
      'network_delivery_complete',
      {
        request_id: newRequestId('mention_complete'),
        delivery_id: claim.delivery_id,
        attempt: claim.attempt,
        claim_id: claim.claim_id!,
        final_body: '@小明 🤖 同学 已完成',
      },
    );
    check('final_body 仍写入最终消息', Boolean(completed.message?.message_id));
    const finalBodyM2 = await inboxOf(m2Token);
    check(
      'final_body 中的 @ 不创建新 delivery',
      !hasMessage(finalBodyM2, completed.message!.message_id),
      finalBodyM2.items,
    );
    const m1All = await inboxOf(m1Token, 'all');
    const completedDelivery = m1All.items.find((item) => item.delivery_id === claim.delivery_id);
    checkEqual('claim 回复后原投递仍由 complete 结束', completedDelivery?.state, 'completed');

    const replayRequest = newRequestId('mention_replay');
    const replayClientMessage = `cm_${crypto.randomUUID()}`;
    const replayFirst = await sendMessage(human, groupId, '@CaseBot 幂等重放', {
      requestId: replayRequest,
      clientMessageId: replayClientMessage,
    });
    const replaySecond = await sendMessage(human, groupId, '@CaseBot 幂等重放', {
      requestId: replayRequest,
      clientMessageId: replayClientMessage,
    });
    checkEqual('幂等重放返回同一消息', replaySecond.message.message_id, replayFirst.message.message_id);
    checkEqual('幂等重放不增加 delivery', replaySecond.delivery_ids.length, 1);
    checkEqual('幂等重放 delivery_ids 稳定', replaySecond.delivery_ids.join(','), replayFirst.delivery_ids.join(','));

    await callTool(human.client, 'network_room_members_update', {
      request_id: newRequestId('mention_remove'),
      room_id: groupId,
      remove: [extras[5]!.identity.actor_id],
    });
    const removedMention = await sendMessage(human, groupId, `@${extras[5]!.identity.name} 已移除`);
    checkEqual('成员移除后 @ 名字不再创建 delivery', removedMention.delivery_ids.length, 0);
    const removedInbox = await inboxOf(extras[5]!.token);
    check(
      '被移除成员没有新 delivery',
      !hasMessage(removedInbox, removedMention.message.message_id),
      removedInbox.items,
    );
  } finally {
    await subscription?.close().catch(() => undefined);
    await Promise.all([m1.close(), m2.close(), human.close()]);
  }
}

/**
 * 群聊结构化提及、确定性唤醒与正文兜底解析的端到端验收。
 *
 * 覆盖显式 invoke/mentions、唯一精确正文兜底、代码/引用/URL 不参与、
 * 同名歧义与超限错误、@所有人 权限、human 个人提醒事件、幂等重放、
 * 成员移除、pending_count 与统一 stream 通知。
 */

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

interface InboxEventRef {
  type: string;
  ref_id: string | null;
  metadata: Record<string, unknown>;
}

/** 读取 inbox 事件（human 没有 delivery，也用同一入口验证个人提醒）。 */
async function inboxEvents(token: string): Promise<InboxEventRef[]> {
  const page = await rawTool<{ items: InboxEventRef[] }>(token, 'network_sync', {
    scope: 'inbox',
    limit: 100,
  });
  return page.items;
}

function reminderOf(
  events: InboxEventRef[],
  messageId: string,
): InboxEventRef | undefined {
  return events.find(
    (event) => event.type === 'mention_reminder' && event.metadata.message_id === messageId,
  );
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
  console.log('  · 群聊结构化提及与确定性唤醒');
  const humanToken = newToken();
  const human = await connectClient(humanToken);
  const peerToken = newToken();
  const peer = await connectClient(peerToken);
  const m1Token = newToken();
  const m1 = await connectClient(m1Token);
  const m2Token = newToken();
  const m2 = await connectClient(m2Token);
  let subscription: Awaited<ReturnType<typeof openSubscription>> | null = null;
  try {
    const owner = await registerIdentity(human, { kind: 'human', name: '小明 🤖 同学 用户' });
    const peerIdentity = await registerIdentity(peer, { kind: 'human', name: '提醒人类' });
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
    const exactBot = await registerRawAgent('ExactBot');
    const sameA = await registerRawAgent('同名机器人');
    const sameB = await registerRawAgent('同名机器人');
    const extras: RawAgent[] = [];
    for (let index = 1; index <= 6; index += 1) {
      extras.push(await registerRawAgent(`并行 Agent ${index}`));
    }
    const agents = [m1Identity, m2Identity, caseBot.identity, exactBot.identity, sameA.identity, sameB.identity, ...extras.map((item) => item.identity)];
    const agentTokens = [
      m1Token,
      m2Token,
      caseBot.token,
      exactBot.token,
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
    await rawBefriend(humanToken, peerToken, peerIdentity.actor_id);
    const group = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('mention_room'),
      kind: 'group',
      title: '@解析验收群',
      members: [...agents.map((agent) => agent.actor_id), peerIdentity.actor_id],
    });
    const groupId = group.room.room_id;
    for (const token of [...agentTokens, peerToken]) {
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
    checkEqual(
      '正文唯一匹配记录为 text 提及',
      JSON.stringify(first.message.mentions),
      JSON.stringify([{ actor_id: m1Identity.actor_id, kind: 'agent', source: 'text' }]),
    );
    const firstHistory = await rawTool<{
      items: { message_id: string; mentions: { actor_id: string; source: string }[] }[];
    }>(humanToken, 'network_history_list', { room_id: groupId, limit: 20 });
    const firstHistoryItem = firstHistory.items.find(
      (item) => item.message_id === first.message.message_id,
    );
    checkEqual(
      '历史列表回读同一条提及记录',
      JSON.stringify(firstHistoryItem?.mentions),
      JSON.stringify([{ actor_id: m1Identity.actor_id, kind: 'agent', source: 'text' }]),
    );

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
    checkEqual('@人类成员不创建 delivery', humanMention.delivery_ids.length, 0);
    const humanMentionM2 = await inboxOf(m2Token);
    check(
      '更长人类名字阻断短 Agent 前缀',
      !hasMessage(humanMentionM2, humanMention.message.message_id),
      humanMentionM2.items,
    );
    checkEqual(
      '发送者 @ 自己不生成个人提醒',
      reminderOf(await inboxEvents(humanToken), humanMention.message.message_id),
      undefined,
    );

    const peerMention = await sendMessage(human, groupId, `@${peerIdentity.name} 请看一下`);
    checkEqual('正文 @人类成员不创建 delivery', peerMention.delivery_ids.length, 0);
    const peerReminder = reminderOf(
      await inboxEvents(peerToken),
      peerMention.message.message_id,
    );
    checkEqual('正文 @人类成员写入个人提醒事件', peerReminder?.type, 'mention_reminder');
    checkEqual('正文 @人类提醒来源为 text', peerReminder?.metadata.source, 'text');
    checkEqual('正文 @人类提醒不标记 @所有人', peerReminder?.metadata.mention_all, false);

    const selfMention = await sendMessage(m1, groupId, '@小明 🤖 自我回复');
    checkEqual('发送者 @ 自己不创建 delivery', selfMention.delivery_ids.length, 0);

    const missingMention = await sendMessage(human, groupId, '@不存在的人 请处理');
    checkEqual('@非成员名字不创建 delivery', missingMention.delivery_ids.length, 0);
    const missingMentionInbox = await inboxOf(m1Token);
    check(
      '@非成员名字不投递给任何 Agent',
      !hasMessage(missingMentionInbox, missingMention.message.message_id),
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

    // M03 边界：名字后缀、邮箱地址与 @所有人 后缀都不能误触发。
    const suffixLetter = await sendMessage(human, groupId, '@ExactBotX 不是点名');
    checkEqual('@ 名字后紧跟字母不创建 delivery', suffixLetter.delivery_ids.length, 0);
    checkEqual('@ 名字后紧跟字母不记录提及', suffixLetter.message.mentions.length, 0);
    const suffixWord = await sendMessage(human, groupId, '@ExactBottle 不是点名');
    checkEqual('@ 名字后紧跟更多字母不创建 delivery', suffixWord.delivery_ids.length, 0);
    const emailText = await sendMessage(human, groupId, 'foo@ExactBot.com 是邮箱地址');
    checkEqual('邮箱地址中的 @ 不创建 delivery', emailText.delivery_ids.length, 0);
    checkEqual('邮箱地址中的 @ 不记录提及', emailText.message.mentions.length, 0);
    const exactInbox = await inboxOf(exactBot.token);
    check(
      '边界文本不投递给 ExactBot',
      !hasMessage(exactInbox, suffixLetter.message.message_id) &&
        !hasMessage(exactInbox, suffixWord.message.message_id) &&
        !hasMessage(exactInbox, emailText.message.message_id),
      exactInbox.items,
    );

    const allSuffix = await sendMessage(human, groupId, '@所有人X 不是全体提醒');
    checkEqual('@所有人 后紧跟字母不创建 delivery', allSuffix.delivery_ids.length, 0);
    checkEqual('@所有人X 不记录群级提及', allSuffix.message.mentions.length, 0);
    checkEqual(
      '@所有人X 不写个人提醒',
      reminderOf(await inboxEvents(peerToken), allSuffix.message.message_id),
      undefined,
    );

    const spaceBoundary = await sendMessage(human, groupId, '@ExactBot 空格边界');
    checkEqual('@ 名字后接空格正常创建 delivery', spaceBoundary.delivery_ids.length, 1);
    const commaBoundary = await sendMessage(human, groupId, '@ExactBot，中文标点边界');
    checkEqual('@ 名字后接中文标点正常创建 delivery', commaBoundary.delivery_ids.length, 1);
    const allPunctuation = await sendMessage(human, groupId, '@所有人，标点边界');
    checkEqual('@所有人 后接中文标点仍触发群级提醒', allPunctuation.delivery_ids.length, 0);
    checkEqual(
      '@所有人，标点边界记录 all 来源人类成员',
      JSON.stringify(allPunctuation.message.mentions),
      JSON.stringify([{ actor_id: peerIdentity.actor_id, kind: 'human', source: 'all' }]),
    );
    checkEqual(
      '@所有人，标点边界写入个人提醒',
      reminderOf(await inboxEvents(peerToken), allPunctuation.message.message_id)?.metadata
        .mention_all,
      true,
    );

    // M03-T01：同名 Agent 只能通过显式 actor_id 区分；纯文本同名必须报歧义且不投递。
    const sameABefore = await inboxOf(sameA.token);
    const sameBBefore = await inboxOf(sameB.token);
    const headBeforeDuplicate = await roomHead(humanToken, groupId);
    const duplicateError = await expectToolError(
      '两个 active Agent 同名时返回 INVALID_ARGUMENT',
      sendMessage(human, groupId, '@同名机器人 请处理'),
      'INVALID_ARGUMENT',
    );
    check(
      '同名错误不回显成员名字并提示选择器或显式目标',
      typeof duplicateError.body.message === 'string' &&
        !duplicateError.body.message.includes('同名机器人') &&
        (duplicateError.body.message.includes('选择器') ||
          duplicateError.body.message.includes('invoke/mentions')),
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
    const explicitSameB = await sendMessage(human, groupId, '@同名机器人 显式指定另一个', {
      invoke: [sameB.identity.actor_id],
    });
    checkEqual('同名场景可显式指定另一个 Agent', explicitSameB.delivery_ids.length, 1);
    const sameAByB = await inboxOf(sameA.token);
    const sameBByB = await inboxOf(sameB.token);
    check(
      '第二次显式 invoke 只投给另一个同名 Agent',
      !hasMessage(sameAByB, explicitSameB.message.message_id) &&
        hasMessage(sameBByB, explicitSameB.message.message_id),
      { a: sameAByB.items, b: sameBByB.items },
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

    // M03-T02：代码、引用、附件 URL 与普通回复都不参与派活解析。
    const codeBlock = await sendMessage(human, groupId, '```\n@CaseBot\n```');
    checkEqual('Markdown 围栏代码块不参与派活解析', codeBlock.delivery_ids.length, 0);
    const inlineCode = await sendMessage(human, groupId, '示例：`@CaseBot` 只是代码');
    checkEqual('行内代码不参与派活解析', inlineCode.delivery_ids.length, 0);
    const quoted = await sendMessage(human, groupId, '> @CaseBot 历史引用\n普通回复');
    checkEqual('引用行（粘贴历史）不参与派活解析', quoted.delivery_ids.length, 0);
    const urlOnly = await sendMessage(
      human,
      groupId,
      '附件：https://example.com/f/@CaseBot.png 请查收',
    );
    checkEqual('附件 URL 中的 @ 不参与派活解析', urlOnly.delivery_ids.length, 0);

    const explicitHuman = await sendMessage(human, groupId, '结构化人类提醒', {
      mentions: [peerIdentity.actor_id],
    });
    checkEqual('显式 mentions 不创建 delivery', explicitHuman.delivery_ids.length, 0);
    checkEqual(
      '显式 mentions 记录为 explicit 人类提及',
      JSON.stringify(explicitHuman.message.mentions),
      JSON.stringify([{ actor_id: peerIdentity.actor_id, kind: 'human', source: 'explicit' }]),
    );
    const explicitHumanReminder = reminderOf(
      await inboxEvents(peerToken),
      explicitHuman.message.message_id,
    );
    checkEqual('显式 mentions 写入个人提醒事件', explicitHumanReminder?.type, 'mention_reminder');
    checkEqual('显式 mentions 提醒来源为 explicit', explicitHumanReminder?.metadata.source, 'explicit');

    const mixedTargets = await sendMessage(human, groupId, '结构化派活与提醒', {
      invoke: [caseBot.identity.actor_id],
      mentions: [peerIdentity.actor_id],
    });
    checkEqual('显式 invoke + mentions 只创建 Agent delivery', mixedTargets.delivery_ids.length, 1);
    const mixedInbox = await inboxOf(caseBot.token);
    check(
      '显式 invoke 投给指定 Agent 而不投给被提醒人类',
      hasMessage(mixedInbox, mixedTargets.message.message_id),
      mixedInbox.items,
    );
    checkEqual(
      '混合目标按 source 分别记录',
      JSON.stringify(
        [...mixedTargets.message.mentions].sort((a, b) => a.actor_id.localeCompare(b.actor_id)),
      ),
      JSON.stringify(
        [
          { actor_id: caseBot.identity.actor_id, kind: 'agent', source: 'explicit' },
          { actor_id: peerIdentity.actor_id, kind: 'human', source: 'explicit' },
        ].sort((a, b) => a.actor_id.localeCompare(b.actor_id)),
      ),
    );

    // M03-T04：CLI 与 MCP 对同样输入产生相同的提醒与派活结果。
    const cliScript = resolve(import.meta.dir, '../../public/skills/agentnet.sh');
    const cliEnv = { ...process.env, AGENTNET_URL: baseUrl(), AGENTNET_TOKEN: humanToken };
    const cliRun = Bun.spawnSync(
      [
        'bash',
        cliScript,
        'send',
        '--room',
        groupId,
        '--body',
        '结构化派活与提醒',
        '--invoke',
        caseBot.identity.actor_id,
        '--mention',
        peerIdentity.actor_id,
        '--request-id',
        newRequestId('mention_cli'),
        '--client-message-id',
        `cm_${crypto.randomUUID()}`,
      ],
      { env: cliEnv, stdout: 'pipe', stderr: 'pipe' },
    );
    checkEqual('CLI send 退出码为 0', cliRun.exitCode, 0);
    const cliResult = JSON.parse(cliRun.stdout.toString()) as {
      message: {
        message_id: string;
        mentions: { actor_id: string; kind: string; source: string }[];
      };
      delivery_ids: string[];
    };
    checkEqual('CLI 显式 invoke 只创建一个 delivery', cliResult.delivery_ids.length, 1);
    checkEqual(
      'CLI 与 MCP 的提及记录一致',
      JSON.stringify(
        [...cliResult.message.mentions].sort((a, b) => a.actor_id.localeCompare(b.actor_id)),
      ),
      JSON.stringify(
        [...mixedTargets.message.mentions].sort((a, b) => a.actor_id.localeCompare(b.actor_id)),
      ),
    );
    const cliInbox = await inboxOf(caseBot.token);
    check('CLI 派活进入指定 Agent 待办', hasMessage(cliInbox, cliResult.message.message_id), cliInbox.items);
    const cliReminder = reminderOf(await inboxEvents(peerToken), cliResult.message.message_id);
    checkEqual('CLI 人类提及产生个人提醒', cliReminder?.type, 'mention_reminder');
    checkEqual('CLI 人类提醒来源为 explicit', cliReminder?.metadata.source, 'explicit');

    const cliOptOutRun = Bun.spawnSync(
      [
        'bash',
        cliScript,
        'send',
        '--room',
        groupId,
        '--body',
        '@CaseBot CLI 显式不派活',
        '--no-invoke',
        '--request-id',
        newRequestId('mention_cli_opt_out'),
        '--client-message-id',
        `cm_${crypto.randomUUID()}`,
      ],
      { env: cliEnv, stdout: 'pipe', stderr: 'pipe' },
    );
    checkEqual('CLI --no-invoke 退出码为 0', cliOptOutRun.exitCode, 0);
    const cliOptOut = JSON.parse(cliOptOutRun.stdout.toString()) as {
      message: { mentions: unknown[] };
      delivery_ids: string[];
    };
    checkEqual('CLI --no-invoke 显式关闭派活', cliOptOut.delivery_ids.length, 0);
    checkEqual('CLI --no-invoke 不产生提及', cliOptOut.message.mentions.length, 0);

    const headBeforeInvalidMention = await roomHead(humanToken, groupId);
    await expectToolError(
      'mentions 指向 Agent 时返回 INVALID_ARGUMENT',
      sendMessage(human, groupId, '错误提醒目标', {
        mentions: [caseBot.identity.actor_id],
      }),
      'INVALID_ARGUMENT',
    );
    checkEqual(
      '无效 mentions 不推进房间 head',
      await roomHead(humanToken, groupId),
      headBeforeInvalidMention,
    );
    await expectToolError(
      'mentions 指向非成员时返回 INVALID_ARGUMENT',
      sendMessage(human, groupId, '未知提醒目标', {
        mentions: ['act_missing_mention'],
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      'mentions 包含发送者自己时返回 INVALID_ARGUMENT',
      sendMessage(human, groupId, '提醒自己', {
        mentions: [owner.actor_id],
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      'mentions 超过 8 个时显式报错',
      sendMessage(human, groupId, '过多提醒目标', {
        mentions: Array.from({ length: 9 }, (_, index) => `act_missing_${index}`),
      }),
      'INVALID_ARGUMENT',
    );

    // M03-T03：定向 @ 只产生一条投递；@所有人 只发提醒，越权与超限稳定拒绝。
    const ownerAll = await sendMessage(human, groupId, '@所有人 群主提醒');
    checkEqual('@所有人 不创建批量 delivery', ownerAll.delivery_ids.length, 0);
    checkEqual(
      '@所有人 以 all 来源记录人类成员',
      JSON.stringify(ownerAll.message.mentions),
      JSON.stringify([{ actor_id: peerIdentity.actor_id, kind: 'human', source: 'all' }]),
    );
    const ownerAllReminder = reminderOf(
      await inboxEvents(peerToken),
      ownerAll.message.message_id,
    );
    checkEqual('@所有人 写入个人提醒事件', ownerAllReminder?.type, 'mention_reminder');
    checkEqual('@所有人 提醒标记 mention_all', ownerAllReminder?.metadata.mention_all, true);
    checkEqual(
      '发送者不因自己的 @所有人 收到提醒',
      reminderOf(await inboxEvents(humanToken), ownerAll.message.message_id),
      undefined,
    );

    const quotedAll = await sendMessage(peer, groupId, '> @所有人 引用历史\n普通回复');
    checkEqual('引用中的 @所有人 不创建 delivery', quotedAll.delivery_ids.length, 0);
    checkEqual(
      '引用中的 @所有人 不触发提醒',
      reminderOf(await inboxEvents(humanToken), quotedAll.message.message_id),
      undefined,
    );
    const headBeforeDeniedAll = await roomHead(humanToken, groupId);
    await expectToolError(
      '普通成员 @所有人 返回 PERMISSION_DENIED',
      sendMessage(peer, groupId, '@所有人 越权提醒'),
      'PERMISSION_DENIED',
    );
    checkEqual(
      '越权 @所有人 不推进房间 head',
      await roomHead(humanToken, groupId),
      headBeforeDeniedAll,
    );

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
    await Promise.all([m1.close(), m2.close(), peer.close(), human.close()]);
  }
}

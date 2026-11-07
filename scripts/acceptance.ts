/**
 * 端到端验收：身份、好友、房间、消息、交付闭环、订阅与重连。
 *
 * 只使用官方 `@modelcontextprotocol/client` 的 2026-07-28 模式；
 * 通过 AGENTNET_URL 可对本地 wrangler dev 或部署后的 Cloudflare 服务运行。
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  baseUrl,
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  rawRpc,
  readResourceJson,
  sleep,
  subscriptionIdOf,
  waitUntil,
} from './lib/harness';
import {
  acceptGroupInvites,
  befriend,
  inbox,
  readWholeMessage,
  registerIdentity,
  sendMessage,
  waitClosed,
  type Delivery,
  type HistoryPage,
  type Identity,
  type LoginResult,
  type MessageView,
  type RoomDetail,
} from './lib/acceptance-helpers';
import { runUnifiedStreamAcceptance } from './lib/stream-acceptance';
import { runRoomFileAcceptance } from './lib/room-file-acceptance';
import { runPrivateFileAcceptance } from './lib/m07-acceptance';
import { runAgentArchiveAcceptance } from './lib/agent-archive-acceptance';
import { runAgentIdentityAcceptance } from './lib/agent-identity-acceptance';
import { runAgentPresenceAcceptance } from './lib/presence-acceptance';
import { runRoomMonitorAcceptance } from './lib/room-monitor-acceptance';
import { runRoomTaskAcceptance } from './lib/room-task-acceptance';
import { runTaskAssignmentAcceptance } from './lib/task-assignment-acceptance';
import { runFeedbackAcceptance } from './lib/feedback-acceptance';
import { runGroupMentionAcceptance } from './lib/mention-acceptance';
import { runGroupNoImplicitDeliveryAcceptance } from './lib/no-implicit-delivery-acceptance';
import { runGroupRoleAcceptance } from './lib/group-role-acceptance';
import { runOwnerTransferAcceptance } from './lib/owner-transfer-acceptance';
import { runGroupInviteAcceptance } from './lib/group-invite-acceptance';
import { runGroupInviteLinkAcceptance } from './lib/group-invite-link-acceptance';
import { runGroupHistoryAcceptance } from './lib/group-history-acceptance';
import { runGroupPolicyAcceptance } from './lib/group-policy-acceptance';
import { runMessageReliabilityAcceptance } from './lib/m02-acceptance';
import {
  ensureTestCertificate,
  removeTestData,
  startTestReceiver,
} from './lib/events-harness';
import { runEventsAcceptance } from './lib/events-acceptance';
import { runContactRelationAcceptance } from './lib/contact-relation-acceptance';
import { runContactBlockAcceptance } from './lib/contact-block-acceptance';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface StreamItemView {
  source?: string;
  kind?: string;
  attention?: string;
  room_id?: string;
  message_id?: string;
  delivery_id?: string;
  sender_id?: string;
  state?: string;
  change?: string;
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

async function main(): Promise<void> {
  console.log(`端到端验收: ${baseUrl()}`);

  const discover = await rawRpc('server/discover');
  const discoverResult = discover.body.result as
    | { capabilities?: { events?: unknown } }
    | undefined;
  if (discoverResult?.capabilities?.events !== undefined) {
    check('server/discover 声明 events', true);
    const eventsList = await rawRpc('events/list');
    const eventsResult = eventsList.body.result as
      | { events?: { name?: string }[] }
      | undefined;
    check(
      'events/list 返回 agentnet.message.created',
      eventsResult?.events?.[0]?.name === 'agentnet.message.created',
      eventsResult,
    );
    const unauth = await rawRpc('events/subscribe', {
      name: 'agentnet.message.created',
      arguments: {},
      delivery: {
        mode: 'webhook',
        url: 'https://127.0.0.1:9/callback',
        secret: `whsec_${Buffer.from('01234567890123456789012345678901').toString('base64')}`,
      },
    });
    const unauthError = unauth.body.error as { code?: number } | undefined;
    checkEqual('未注册身份 events/subscribe 返回 -32024', unauthError?.code, -32024);

    if (process.env.EVENTS_ACCEPTANCE === '1') {
      const directory = join(
        tmpdir(),
        `an-events-acceptance-${crypto.randomUUID().replaceAll('-', '')}`,
      );
      const certificate = await ensureTestCertificate(join(directory, 'certs'));
      const receiver = startTestReceiver({ certificate });
      try {
        const secret = `whsec_${Buffer.from(
          crypto.getRandomValues(new Uint8Array(32)),
        ).toString('base64')}`;
        await runEventsAcceptance({ receiver, secret });
      } finally {
        receiver.stop();
        removeTestData(directory);
      }
    } else {
      console.log(
        '  · events 已声明但未设置 EVENTS_ACCEPTANCE=1，跳过本地 webhook 闭环',
      );
    }
  } else {
    console.log('  · 目标未声明 events 能力，跳过 MCP Events 验收');
  }

  const agentA = await connectClient(newToken());
  const agentB = await connectClient(newToken());
  const humanC = await connectClient(newToken());

  try {
    const a = await registerIdentity(agentA, {
      kind: 'agent',
      name: '验收 Agent A',
      sessionId: `sess_${crypto.randomUUID()}`,
    });
    const b = await registerIdentity(agentB, {
      kind: 'agent',
      name: '验收 Agent B',
      sessionId: `sess_${crypto.randomUUID()}`,
    });
    const c = await registerIdentity(humanC, { kind: 'human', name: '验收人类 C' });
    check('三个身份注册成功', Boolean(a.actor_id && b.actor_id && c.actor_id), { a: a.actor_id, b: b.actor_id, c: c.actor_id });

    // 旧式自注册 Agent 默认 unclaimed；必须由 Agent 发起、human 确认两端绑定。
    const mainClaim = await callTool<{ claim_id: string; code: string }>(
      agentA.client,
      'network_agent_claim_start',
      { request_id: newRequestId('claim_start') },
    );
    const mainClaimConfirmed = await callTool<{ manager_id: string; agent_id: string }>(
      humanC.client,
      'network_agent_claim_confirm',
      {
        request_id: newRequestId('claim_confirm'),
        claim_id: mainClaim.claim_id,
        code: mainClaim.code,
      },
    );
    check('认领后 human C 成为 Agent A 的管理者', mainClaimConfirmed.manager_id === c.actor_id && mainClaimConfirmed.agent_id === a.actor_id);

    check(
      '资源入口只包含统一 stream',
      a.resources.length === 1 && a.resources[0] === STREAM_URI,
      a.resources,
    );

    const me = await callTool<Identity>(agentA.client, 'network_me');
    checkEqual('network_me 返回当前身份', me.actor_id, a.actor_id);
    const profile = await callTool<Identity>(agentA.client, 'network_profile_update', {
      request_id: newRequestId('profile'),
      name: '验收 Agent A+',
    });
    checkEqual('profile_update 更新名称', profile.name, '验收 Agent A+');

    const selfRenameRequest = newRequestId('me_rename');
    const selfRenamed = await callTool<{ actor_id: string; name: string }>(
      humanC.client,
      'network_me_rename',
      { request_id: selfRenameRequest, name: '  验收人类 C 新名  ' },
    );
    checkEqual('human 可自助改名并 trim', selfRenamed.name, '验收人类 C 新名');
    checkEqual('self rename 返回调用者 actor_id', selfRenamed.actor_id, c.actor_id);
    const selfRenamedMe = await callTool<Identity>(humanC.client, 'network_me');
    checkEqual('self rename 后 network_me 返回新名称', selfRenamedMe.name, '验收人类 C 新名');
    const selfRenamedReplay = await callTool<{ name: string }>(
      humanC.client,
      'network_me_rename',
      { request_id: selfRenameRequest, name: '  验收人类 C 新名  ' },
    );
    checkEqual('self rename 幂等重放返回同一名称', selfRenamedReplay.name, '验收人类 C 新名');
    await expectToolError(
      'self rename 同一 request_id 改不同名称返回 IDEMPOTENCY_CONFLICT',
      callTool(humanC.client, 'network_me_rename', {
        request_id: selfRenameRequest,
        name: '另一个名字',
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectToolError(
      'self rename 拒绝空名称',
      callTool(humanC.client, 'network_me_rename', {
        request_id: newRequestId('me_rename_empty'),
        name: '   ',
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      'self rename 拒绝控制字符',
      callTool(humanC.client, 'network_me_rename', {
        request_id: newRequestId('me_rename_control'),
        name: '坏\n名',
      }),
      'INVALID_ARGUMENT',
    );

    const renameRequest = newRequestId('rename');
    const renamed = await callTool<{ actor_id: string; name: string }>(
      humanC.client,
      'network_agent_rename',
      {
        request_id: renameRequest,
        actor_id: a.actor_id,
        name: '  验收 Agent A 全局名  ',
      },
    );
    checkEqual('管理者可重命名自己创建的 Agent', renamed.name, '验收 Agent A 全局名');
    const renamedReplay = await callTool<{ actor_id: string; name: string }>(
      humanC.client,
      'network_agent_rename',
      {
        request_id: renameRequest,
        actor_id: a.actor_id,
        name: '  验收 Agent A 全局名  ',
      },
    );
    checkEqual('rename 幂等重放返回同一名称', renamedReplay.name, renamed.name);
    const renamedMe = await callTool<Identity>(agentA.client, 'network_me');
    checkEqual('rename 对所有人全局生效', renamedMe.name, '验收 Agent A 全局名');
    await expectToolError(
      'rename 未知 actor 返回 NOT_FOUND',
      callTool(humanC.client, 'network_agent_rename', {
        request_id: newRequestId('rename'),
        actor_id: 'agt_missing_actor',
        name: '不存在',
      }),
      'NOT_FOUND',
    );
    await expectToolError(
      'rename 目标为人类时返回 INVALID_ARGUMENT',
      callTool(humanC.client, 'network_agent_rename', {
        request_id: newRequestId('rename'),
        actor_id: c.actor_id,
        name: '人类不能这样改',
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      '同一 request_id 改不同名称返回 IDEMPOTENCY_CONFLICT',
      callTool(humanC.client, 'network_agent_rename', {
        request_id: renameRequest,
        actor_id: a.actor_id,
        name: '另一个名称',
      }),
      'IDEMPOTENCY_CONFLICT',
    );

    // Agent token 注销重发：使用独立 Agent，避免影响主流程后续调用。
    const reissueOldToken = newToken();
    const reissueAgent = await connectClient(reissueOldToken);
    try {
      const reissueTarget = await registerIdentity(reissueAgent, {
        kind: 'agent',
        name: '验收重发 Agent',
        sessionId: `sess_${crypto.randomUUID()}`,
      });
      const reissueClaim = await callTool<{ claim_id: string; code: string }>(
        reissueAgent.client,
        'network_agent_claim_start',
        { request_id: newRequestId('claim_start') },
      );
      await callTool(humanC.client, 'network_agent_claim_confirm', {
        request_id: newRequestId('claim_confirm'),
        claim_id: reissueClaim.claim_id,
        code: reissueClaim.code,
      });
      const reissueRequest = newRequestId('reissue');
      const reissued = await callTool<{
        actor_id: string;
        token: string;
        mcp_url: string;
        revoked_count: number;
        issued_at: string;
      }>(humanC.client, 'network_agent_reissue_token', {
        request_id: reissueRequest,
        actor_id: reissueTarget.actor_id,
      });
      checkEqual('reissue 保持 actor_id 不变', reissued.actor_id, reissueTarget.actor_id);
      check(
        'reissue 返回撤销数量',
        Number.isInteger(reissued.revoked_count) && reissued.revoked_count >= 1,
        reissued.revoked_count,
      );
      check(
        'reissue 返回新的 mcp_url 与 token',
        reissued.token !== reissueOldToken &&
          new URL(reissued.mcp_url).searchParams.get('token') === reissued.token,
        { mcp_url: reissued.mcp_url.replace(/token=[^&]+/u, 'token=<redacted>') },
      );
      const oldTokenCall = await rawRpc(
        'tools/call',
        { name: 'network_me', arguments: {} },
        { token: reissueOldToken },
      );
      const oldTokenError = oldTokenCall.body.error as
        | { data?: { code?: string } }
        | undefined;
      checkEqual(
        'reissue 后旧 token 立即返回 CREDENTIAL_INVALID',
        oldTokenError?.data?.code,
        'CREDENTIAL_INVALID',
      );
      const newTokenCall = await rawRpc(
        'tools/call',
        { name: 'network_me', arguments: {} },
        { token: reissued.token },
      );
      const newTokenIdentity = (
        newTokenCall.body.result as
          | { structuredContent?: { actor_id?: string } }
          | undefined
      )?.structuredContent;
      checkEqual('reissue 新 token 可读取同一 actor', newTokenIdentity?.actor_id, reissueTarget.actor_id);
      const otherMe = await callTool<Identity>(agentA.client, 'network_me');
      checkEqual('reissue 不影响其他 Agent 的凭据', otherMe.actor_id, a.actor_id);
      const callerMe = await callTool<Identity>(humanC.client, 'network_me');
      checkEqual('reissue 不撤销 human 调用者凭据', callerMe.actor_id, c.actor_id);
      await expectToolError(
        'reissue 目标为人类时返回 INVALID_ARGUMENT',
        callTool(humanC.client, 'network_agent_reissue_token', {
          request_id: newRequestId('reissue'),
          actor_id: c.actor_id,
        }),
        'INVALID_ARGUMENT',
      );
      await expectToolError(
        'reissue 未知 actor 返回 NOT_FOUND',
        callTool(humanC.client, 'network_agent_reissue_token', {
          request_id: newRequestId('reissue'),
          actor_id: 'agt_missing_reissue',
        }),
        'NOT_FOUND',
      );
      await expectToolError(
        'reissue 同一 request_id 重放不返回 token',
        callTool(humanC.client, 'network_agent_reissue_token', {
          request_id: reissueRequest,
          actor_id: reissueTarget.actor_id,
        }),
        'TOKEN_NOT_REPLAYABLE',
      );
    } finally {
      await reissueAgent.close();
    }

    await befriend(agentA, a.actor_id, agentB, b.actor_id);
    const contacts = await callTool<{ items: { actor_id: string }[] }>(
      agentA.client,
      'network_contacts_list',
      {},
    );
    check('A 的好友列表包含 B', contacts.items.some((item) => item.actor_id === b.actor_id), contacts.items);

    await expectToolError(
      '非好友不能加入群聊',
      callTool(humanC.client, 'network_room_create', {
        request_id: newRequestId('room'),
        kind: 'group',
        members: [b.actor_id],
        title: '越权群',
      }),
      'FRIEND_REQUIRED',
    );

    const directA = await callTool<RoomDetail>(agentA.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [b.actor_id],
    });
    const directB = await callTool<RoomDetail>(agentB.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [a.actor_id],
    });
    const roomId = directA.room.room_id;
    checkEqual('双方创建单聊收敛到同一 room_id', directB.room.room_id, roomId);
    checkEqual('单聊没有 owner', directA.room.owner_id, null);
    checkEqual('单聊参与者为两人', directA.members.length, 2);

    const presenceBeforeLogin = await callTool<RoomDetail>(agentA.client, 'network_room_get', {
      room_id: roomId,
    });
    check(
      '近期有请求的 Agent 无需 login 也显示在线',
      presenceBeforeLogin.members
        .filter((member) => member.kind === 'agent')
        .every((member) => member.online === true),
      presenceBeforeLogin.members,
    );

    await expectToolError(
      '非成员读取房间返回 NOT_MEMBER',
      callTool(humanC.client, 'network_room_get', { room_id: roomId }),
      'NOT_MEMBER',
    );
    await expectToolError(
      '非成员发送消息返回 NOT_MEMBER',
      callTool(humanC.client, 'network_message_send', {
        request_id: newRequestId('send'),
        client_message_id: `cm_${crypto.randomUUID()}`,
        room_id: roomId,
        body: 'should fail',
      }),
      'NOT_MEMBER',
    );

    const hello = await sendMessage(agentA, roomId, 'hello B');
    checkEqual('普通消息不产生 delivery', hello.delivery_ids.length, 0);
    const firstHistory = await callTool<HistoryPage>(agentB.client, 'network_history_list', {
      room_id: roomId,
    });
    check(
      'B 历史包含 A 的消息',
      firstHistory.items.some((item) => item.message_id === hello.message.message_id),
      firstHistory.items,
    );

    const longBody = 'x'.repeat(70_000);
    const long = await sendMessage(agentA, roomId, longBody);
    checkEqual('长消息 body_bytes 记录正确', long.message.body_bytes, 70_000);
    check('长消息预览被截断', long.message.preview.length < 600, long.message.preview.length);
    const whole = await readWholeMessage(agentB, long.message.message_id);
    checkEqual('分块读取可还原完整正文', whole.length, longBody.length);

    const p1 = await sendMessage(agentA, roomId, 'page-1');
    const p2 = await sendMessage(agentA, roomId, 'page-2');
    const p3 = await sendMessage(agentA, roomId, 'page-3');
    const pageOne = await callTool<HistoryPage>(agentB.client, 'network_history_list', {
      room_id: roomId,
      limit: 2,
    });
    checkEqual('历史分页 limit 生效', pageOne.items.length, 2);
    check('历史分页 has_more', pageOne.has_more, pageOne);
    check('历史分页返回 next_cursor', Boolean(pageOne.next_cursor), pageOne.next_cursor);
    const pageTwo = await callTool<HistoryPage>(agentB.client, 'network_history_list', {
      room_id: roomId,
      limit: 100,
      cursor: pageOne.next_cursor as string,
    });
    const seen = new Set([...pageOne.items, ...pageTwo.items].map((item) => item.message_id));
    check(
      '两次分页覆盖 p1..p3 且没有重复',
      [p1, p2, p3].every((item) => seen.has(item.message.message_id)) && seen.size === pageOne.items.length + pageTwo.items.length,
      { seen: seen.size },
    );
    const tailStart = await callTool<HistoryPage>(agentB.client, 'network_history_list', {
      room_id: roomId,
      direction: 'after',
    });
    checkEqual('after 模式初始页为空', tailStart.items.length, 0);
    check('after 模式返回 resume cursor', Boolean(tailStart.next_cursor), tailStart.next_cursor);
    const tailMessage = await sendMessage(agentA, roomId, 'tail-1');
    const tailPage = await callTool<HistoryPage>(agentB.client, 'network_history_list', {
      room_id: roomId,
      direction: 'after',
      cursor: tailStart.next_cursor as string,
    });
    check(
      'after 模式只返回新增消息',
      tailPage.items.some((item) => item.message_id === tailMessage.message.message_id),
      {
        tailStart: { cursor: tailStart.next_cursor, head: tailStart.head_seq, snapshot: tailStart.snapshot },
        newMessage: { id: tailMessage.message.message_id, seq: tailMessage.message.created_seq },
        tailPage,
      },
    );

    const mark = await callTool<{ room_id: string; last_read_seq: string }>(
      agentB.client,
      'network_room_mark_read',
      { room_id: roomId, through_seq: tailMessage.message.created_seq },
    );
    checkEqual('mark_read 返回房间 id', mark.room_id, roomId);
    const rooms = await callTool<{ items: { room_id: string; last_message: { message_id: string } | null }[] }>(
      agentB.client,
      'network_rooms_list',
      {},
    );
    const listedRoom = rooms.items.find((item) => item.room_id === roomId);
    check('B 的房间列表包含单聊', Boolean(listedRoom), rooms.items);
    checkEqual('房间摘要指向最新消息', listedRoom?.last_message?.message_id, tailMessage.message.message_id);

    const collector = notificationCollector(agentB.client);
    const subscription = await openSubscription(agentB.client, [STREAM_URI]);
    check(
      '订阅 ack 只覆盖统一 stream',
      (subscription.honoredFilter.resourceSubscriptions ?? []).length === 1 &&
        subscription.honoredFilter.resourceSubscriptions?.[0] === STREAM_URI,
      subscription.honoredFilter,
    );
    const login = await callTool<LoginResult>(agentB.client, 'network_login');
    checkEqual('Agent 显式上线成功', login.online, true);
    checkEqual('上线返回自己的 actor_id', login.actor_id, b.actor_id);
    const presenceAfterLogin = await callTool<RoomDetail>(agentA.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual(
      'login 后其他成员能看到 Agent 在线',
      presenceAfterLogin.members.find((member) => member.actor_id === b.actor_id)?.online,
      true,
    );
    await collector.waitFor(
      (event) => hasStreamItem(event, (item) => item.source === 'session.login'),
      '等待统一 stream 上线帧',
    );
    collector.reset();
    const notified = await sendMessage(agentA, roomId, 'notify-1');
    await collector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'room.message' &&
            item.message_id === notified.message.message_id,
        ),
      '等待统一 stream 房间消息',
    );
    check('通知与真实写入一致', notified.message.message_id.length > 0);

    // 普通消息只产生 informational room.message；inbox 只在产生新待办时变化。
    const invoke = await sendMessage(agentA, roomId, 'task-1', { invoke: [b.actor_id] });
    const createdEvent = await collector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.created' &&
            item.delivery_id === invoke.delivery_ids[0],
        ),
      '等待统一 stream 投递帧',
    );
    check(
      '统一 stream 通知携带 subscriptionId',
      Boolean(subscriptionIdOf(createdEvent.params)),
      createdEvent.params,
    );
    checkEqual('invoke 创建一条 delivery', invoke.delivery_ids.length, 1);

    const senderCollector = notificationCollector(agentA.client);
    const senderSubscription = await openSubscription(agentA.client, [STREAM_URI]);
    await waitUntil('等待发送方统一 stream 建立', () =>
      Boolean(senderSubscription.honoredFilter.resourceSubscriptions?.length),
    );
    await callTool(agentA.client, 'network_login');

    await befriend(agentA, a.actor_id, humanC, c.actor_id);
    const humanRoom = await callTool<RoomDetail>(agentA.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      members: [c.actor_id],
      title: '人类目标校验',
    });
    await acceptGroupInvites(humanC, humanRoom.room.room_id);
    await expectToolError(
      'invoke 指向人类成员返回 INVALID_ARGUMENT',
      sendMessage(agentA, humanRoom.room.room_id, 'human-target', { invoke: [c.actor_id] }),
      'INVALID_ARGUMENT',
    );
    const deliveryId = invoke.delivery_ids[0] as string;

    const pendingInbox = await inbox(agentB, 'pending');
    check('pending 列表包含新 delivery', pendingInbox.items.some((item) => item.delivery_id === deliveryId), pendingInbox.items);
    check('pending_count 与列表一致', pendingInbox.pending_count >= 1, pendingInbox.pending_count);

    const claimRequest = newRequestId('claim');
    // claim/report/complete/fail 只通知发送方房间，不再唤醒 recipient 自己。
    collector.reset();
    const claimed = await callTool<Delivery>(agentB.client, 'network_delivery_claim', {
      request_id: claimRequest,
      delivery_id: deliveryId,
    });
    checkEqual('claim 后状态为 claimed', claimed.state, 'claimed');
    checkEqual('claim 后 attempt 为 1', claimed.attempt, 1);
    check('claim 返回 claim_id', Boolean(claimed.claim_id), claimed.claim_id);
    const replayClaim = await callTool<Delivery>(agentB.client, 'network_delivery_claim', {
      request_id: claimRequest,
      delivery_id: deliveryId,
    });
    checkEqual('相同 request_id 重放 claim 返回同一 claim_id', replayClaim.claim_id, claimed.claim_id);

    const claimedHistory = await callTool<HistoryPage>(agentA.client, 'network_history_list', {
      room_id: roomId,
      limit: 20,
    });
    const claimedRow = claimedHistory.items.find((item) => item.message_id === invoke.message.message_id);
    checkEqual('claim 后发送方 history 显示 claimed 回执', claimedRow?.delivery_states.claimed, 1);
    check(
      'history 返回 claimed 领取时间供超时提示',
      typeof claimedRow?.delivery_claimed_at === 'string' && Number(claimedRow.delivery_claimed_at) > 0,
      claimedRow,
    );
    check(
      'history 返回 claimed 更新时间供超时提示',
      typeof claimedRow?.delivery_updated_at === 'string' && Number(claimedRow.delivery_updated_at) > 0,
      claimedRow,
    );
    await senderCollector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.updated' &&
            item.delivery_id === deliveryId &&
            item.state === 'claimed',
        ),
      '等待 claim 回执统一 stream 通知',
    );
    check('claim 回执通过统一 stream 推送', senderCollector.events.length > 0);
    await sleep(1000);
    check(
      'claim 不再向 recipient 自己发回执',
      !collector.events.some((event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.updated' && item.delivery_id === deliveryId,
        ),
      ),
      collector.events,
    );

    collector.reset();
    const report = await callTool<{ delivery_id: string; attempt: number; progress_at: string }>(
      agentB.client,
      'network_delivery_report',
      {
        request_id: newRequestId('report'),
        delivery_id: deliveryId,
        attempt: claimed.attempt,
        claim_id: claimed.claim_id,
        status: '正在处理',
      },
    );
    checkEqual('report 记录当前 attempt', report.attempt, 1);
    await sleep(500);
    check(
      'report 不再向 recipient 自己发回执',
      !collector.events.some((event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.updated' && item.delivery_id === deliveryId,
        ),
      ),
      collector.events,
    );
    const reportedHistory = await callTool<HistoryPage>(agentA.client, 'network_history_list', {
      room_id: roomId,
      limit: 20,
    });
    const reportedRow = reportedHistory.items.find(
      (item) => item.message_id === invoke.message.message_id,
    );
    check(
      'report 刷新 claimed 更新时间',
      Number(reportedRow?.delivery_updated_at) >= Number(reportedRow?.delivery_claimed_at),
      reportedRow,
    );
    const notificationsBeforeComplete = senderCollector.events.length;

    collector.reset();
    const completed = await callTool<{ delivery: Delivery; message: MessageView | null }>(
      agentB.client,
      'network_delivery_complete',
      {
        request_id: newRequestId('complete'),
        delivery_id: deliveryId,
        attempt: claimed.attempt,
        claim_id: claimed.claim_id,
        final_body: 'done-1',
      },
    );
    checkEqual('complete 后 delivery 状态为 completed', completed.delivery.state, 'completed');
    check('complete 返回最终消息', Boolean(completed.message?.message_id), completed.message);

    const completedHistory = await callTool<HistoryPage>(agentA.client, 'network_history_list', {
      room_id: roomId,
      limit: 20,
    });
    const completedRow = completedHistory.items.find(
      (item) => item.message_id === invoke.message.message_id,
    );
    checkEqual('complete 后发送方 history 显示 completed 回执', completedRow?.delivery_states.completed, 1);
    await waitUntil(
      '等待 complete 回执房间通知',
      () => senderCollector.events.length > notificationsBeforeComplete,
    );
    await sleep(800);
    check(
      'complete 不再向 recipient 自己发回执',
      !collector.events.some((event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.updated' && item.delivery_id === deliveryId,
        ),
      ),
      collector.events,
    );
    const completedInboxState = await inbox(agentB, 'all');
    checkEqual(
      'complete 后没有 claimed 粘滞',
      completedInboxState.claimed_delivery_id,
      null,
    );
    await senderSubscription.close();

    const afterCompleteHistory = await callTool<HistoryPage>(agentA.client, 'network_history_list', {
      room_id: roomId,
      limit: 5,
    });
    check(
      'A 能看到 B 的最终答复',
      afterCompleteHistory.items.some(
        (item) => item.message_id === completed.message?.message_id && item.sender_id === b.actor_id,
      ),
      afterCompleteHistory.items,
    );
    checkEqual('最终答复的 reply_to 指向任务消息', completed.message?.reply_to, invoke.message.message_id);

    const staleComplete = await expectToolError(
      '重复 complete 返回 STALE_ATTEMPT',
      callTool(agentB.client, 'network_delivery_complete', {
        request_id: newRequestId('complete'),
        delivery_id: deliveryId,
        attempt: claimed.attempt,
        claim_id: claimed.claim_id,
      }),
      'STALE_ATTEMPT',
    );
    check('STALE_ATTEMPT 语义清晰', staleComplete.body.message !== undefined, staleComplete.body);

    const completedInbox = await inbox(agentB, 'completed');
    check(
      'completed 过滤能看到该 delivery',
      completedInbox.items.some((item) => item.delivery_id === deliveryId),
      completedInbox.items,
    );

    // 接收者被卡在 claimed 时，fail 不自我唤醒，retry 可把投递放回 pending 自恢复。
    const stuckSend = await sendMessage(agentA, roomId, 'recipient-recovery', {
      invoke: [b.actor_id],
    });
    const stuckDeliveryId = stuckSend.delivery_ids[0] as string;
    const stuckClaim = await callTool<Delivery>(agentB.client, 'network_delivery_claim', {
      request_id: newRequestId('claim'),
      delivery_id: stuckDeliveryId,
    });
    collector.reset();
    const stuckFailed = await callTool<Delivery>(agentB.client, 'network_delivery_fail', {
      request_id: newRequestId('fail'),
      delivery_id: stuckDeliveryId,
      attempt: stuckClaim.attempt,
      claim_id: stuckClaim.claim_id,
      error: '阶段性阻塞，先放回队列',
    });
    checkEqual('fail 后状态为 failed', stuckFailed.state, 'failed');
    await sleep(800);
    check(
      'fail 不再向 recipient 自己发回执',
      !collector.events.some((event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.updated' && item.delivery_id === stuckDeliveryId,
        ),
      ),
      collector.events,
    );
    const recipientRetry = await callTool<Delivery>(agentB.client, 'network_delivery_retry', {
      request_id: newRequestId('retry'),
      delivery_id: stuckDeliveryId,
      expected_attempt: stuckClaim.attempt,
    });
    checkEqual('recipient 可 retry 自己的 claimed 投递自恢复', recipientRetry.state, 'pending');
    await collector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.retried' && item.delivery_id === stuckDeliveryId,
        ),
      '等待 retry 重新入队 stream 提示',
    );
    await callTool(agentA.client, 'network_delivery_cancel', {
      request_id: newRequestId('cancel'),
      delivery_id: stuckDeliveryId,
      reason: '自恢复验收结束',
    });

    const concurrentA = await sendMessage(agentA, roomId, 'task-race-1', { invoke: [b.actor_id] });
    const concurrentB = await sendMessage(agentA, roomId, 'task-race-2', { invoke: [b.actor_id] });
    const raceDeliveryA = concurrentA.delivery_ids[0] as string;
    const raceDeliveryB = concurrentB.delivery_ids[0] as string;
    const raceResults = await Promise.allSettled([
      callTool<Delivery>(agentB.client, 'network_delivery_claim', {
        request_id: newRequestId('claim'),
        delivery_id: raceDeliveryA,
      }),
      callTool<Delivery>(agentB.client, 'network_delivery_claim', {
        request_id: newRequestId('claim'),
        delivery_id: raceDeliveryB,
      }),
    ]);
    const fulfilled = raceResults.filter((result) => result.status === 'fulfilled');
    checkEqual('并发 claim 恰好一个成功', fulfilled.length, 1);
    const rejected = raceResults.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    checkEqual('另一个并发 claim 返回 CLAIM_CONFLICT', (rejected.reason as { code?: string }).code, 'CLAIM_CONFLICT');
    const racedClaim = (fulfilled[0] as PromiseFulfilledResult<Delivery>).value;
    const racedDelivery = racedClaim.delivery_id;
    const idleDelivery = racedDelivery === raceDeliveryA ? raceDeliveryB : raceDeliveryA;

    await callTool(agentA.client, 'network_delivery_retry', {
      request_id: newRequestId('retry'),
      delivery_id: racedDelivery,
      expected_attempt: racedClaim.attempt,
    });
    const retried = await inbox(agentB, 'all');
    const retriedView = retried.items.find((item) => item.delivery_id === racedDelivery);
    checkEqual('retry 后回到 pending', retriedView?.state, 'pending');
    checkEqual('retry 不改变 attempt', retriedView?.attempt, racedClaim.attempt);
    await expectToolError(
      '旧 claim 在 retry 后失效',
      callTool(agentB.client, 'network_delivery_complete', {
        request_id: newRequestId('complete'),
        delivery_id: racedDelivery,
        attempt: racedClaim.attempt,
        claim_id: racedClaim.claim_id,
      }),
      'STALE_ATTEMPT',
    );

    const reclaim = await callTool<Delivery>(agentB.client, 'network_delivery_claim', {
      request_id: newRequestId('claim'),
      delivery_id: racedDelivery,
    });
    checkEqual('重新 claim 后 attempt 递增', reclaim.attempt, racedClaim.attempt + 1);
    const failed = await callTool<Delivery>(agentB.client, 'network_delivery_fail', {
      request_id: newRequestId('fail'),
      delivery_id: racedDelivery,
      attempt: reclaim.attempt,
      claim_id: reclaim.claim_id,
      error: '模型暂时不可用',
    });
    checkEqual('fail 后状态为 failed', failed.state, 'failed');

    await callTool(agentA.client, 'network_delivery_retry', {
      request_id: newRequestId('retry'),
      delivery_id: racedDelivery,
      expected_attempt: reclaim.attempt,
    });
    const finalClaim = await callTool<Delivery>(agentB.client, 'network_delivery_claim', {
      request_id: newRequestId('claim'),
      delivery_id: racedDelivery,
    });
    checkEqual('retry 后再次 claim 的 attempt', finalClaim.attempt, reclaim.attempt + 1);
    const cancelled = await callTool<Delivery>(agentA.client, 'network_delivery_cancel', {
      request_id: newRequestId('cancel'),
      delivery_id: racedDelivery,
      reason: '任务已被撤销',
    });
    checkEqual('cancel 后状态为 cancelled', cancelled.state, 'cancelled');
    await expectToolError(
      '取消后旧 claim 不能 complete',
      callTool(agentB.client, 'network_delivery_complete', {
        request_id: newRequestId('complete'),
        delivery_id: racedDelivery,
        attempt: finalClaim.attempt,
        claim_id: finalClaim.claim_id,
      }),
      'STALE_ATTEMPT',
    );

    await callTool(agentA.client, 'network_delivery_cancel', {
      request_id: newRequestId('cancel'),
      delivery_id: idleDelivery,
      reason: '竞态测试结束',
    });
    await expectToolError(
      '取消 pending 后 claim 返回 CLAIM_CONFLICT',
      callTool(agentB.client, 'network_delivery_claim', {
        request_id: newRequestId('claim'),
        delivery_id: idleDelivery,
      }),
      'CLAIM_CONFLICT',
    );

    const idempotentClientId = `cm_${crypto.randomUUID()}`;
    const firstSend = await sendMessage(agentA, roomId, 'idempotent-body', {
      clientMessageId: idempotentClientId,
    });
    const secondSend = await sendMessage(agentA, roomId, 'idempotent-body', {
      clientMessageId: idempotentClientId,
    });
    checkEqual('相同 client_message_id 返回同一消息', secondSend.message.message_id, firstSend.message.message_id);
    checkEqual('相同 client_message_id 不新增 delivery', secondSend.delivery_ids.length, firstSend.delivery_ids.length);
    await expectToolError(
      '相同 client_message_id 携带不同正文返回 IDEMPOTENCY_CONFLICT',
      sendMessage(agentA, roomId, 'idempotent-body-changed', {
        clientMessageId: idempotentClientId,
      }),
      'IDEMPOTENCY_CONFLICT',
    );

    const syncInbox = await callTool<{
      items: { type: string }[];
      next_cursor: string;
      reset_required: boolean;
    }>(agentB.client, 'network_sync', { scope: 'inbox' });
    check('inbox sync 返回变更事件', syncInbox.items.length > 0, syncInbox.items.length);
    check('inbox sync 不需要重置', syncInbox.reset_required === false);
    check('inbox sync 返回 next_cursor', Boolean(syncInbox.next_cursor));

    const syncRoom = await callTool<{ items: { type: string }[]; scope: string }>(
      agentB.client,
      'network_sync',
      { scope: `room:${roomId}` },
    );
    check('room sync 返回变更事件', syncRoom.items.length > 0, syncRoom.items.length);
    checkEqual('room sync scope 保持原样', syncRoom.scope, `room:${roomId}`);

    const syncDenied = await expectToolError(
      '非成员读取房间 sync 返回 NOT_MEMBER',
      callTool(humanC.client, 'network_sync', { scope: `room:${roomId}` }),
      'NOT_MEMBER',
    );
    check('sync 越权错误可读', syncDenied.body.retryable === false, syncDenied.body);

    const legacyListen = await rawRpc(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [`agentnet://actors/${a.actor_id}/inbox`] } },
      { token: agentB.token },
    );
    const legacyError = legacyListen.body.error as Record<string, unknown> | undefined;
    checkEqual('旧 inbox URI 订阅被拒绝', legacyError?.code, -32602);
    checkEqual(
      '旧 inbox URI 错误码为 INVALID_ARGUMENT',
      (legacyError?.data as Record<string, unknown> | undefined)?.code,
      'INVALID_ARGUMENT',
    );

    const group = await callTool<RoomDetail>(agentA.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      members: [b.actor_id],
      title: '成员变化验收群',
    });
    const groupId = group.room.room_id;
    checkEqual('群聊创建者为 owner', group.room.my_role, 'owner');
    // G01：非建群者自有 Agent 的成员先收到邀请，验收显式接受后才进入 active。
    await acceptGroupInvites(agentB, groupId);
    const groupSubscription = await openSubscription(agentB.client, [STREAM_URI]);
    await waitUntil('等待统一 stream 建立', () =>
      Boolean(groupSubscription.honoredFilter.resourceSubscriptions?.length),
    );
    await callTool(agentA.client, 'network_room_members_update', {
      request_id: newRequestId('members'),
      room_id: groupId,
      remove: [b.actor_id],
    });
    await collector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'room.membership' &&
            item.change === 'removed' &&
            item.room_id === groupId,
        ),
      '等待成员移除通知',
    );
    const closedRace = await Promise.race([
      groupSubscription.closed.then(() => 'closed' as const),
      sleep(400).then(() => 'open' as const),
    ]);
    checkEqual('成员被移除后统一 stream 不关闭', closedRace, 'open');
    await expectToolError(
      '被移除成员不能继续读房间',
      callTool(agentB.client, 'network_room_get', { room_id: groupId }),
      'NOT_MEMBER',
    );

    await groupSubscription.close();
    await subscription.close();
    checkEqual('主动关闭订阅标记为 local', await waitClosed(subscription, 5000), 'local');
    await sleep(1000);
    await waitUntil('关闭最后一个连接后成员显示离线', async () => {
      const detail = await callTool<RoomDetail>(agentA.client, 'network_room_get', {
        room_id: roomId,
      });
      return detail.members.find((member) => member.actor_id === b.actor_id)?.online === false;
    }, 30_000);
    const offlineCollector = notificationCollector(agentB.client);
    const resubscribed = await openSubscription(agentB.client, [STREAM_URI]);
    checkEqual(
      '同一客户端可重新建立统一 stream',
      resubscribed.honoredFilter.resourceSubscriptions?.[0],
      STREAM_URI,
    );
    const offlineSend = await sendMessage(agentA, roomId, 'offline-task', {
      invoke: [b.actor_id],
    });
    await sleep(1500);
    check(
      '订阅建立但未上线时收不到 stream 帧',
      !offlineCollector.events.some((event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.created' &&
            item.delivery_id === offlineSend.delivery_ids[0],
        ),
      ),
      offlineCollector.events,
    );
    await expectToolError(
      '人类调用 network_login 返回 INVALID_ARGUMENT',
      callTool(humanC.client, 'network_login'),
      'INVALID_ARGUMENT',
    );
    const relogin = await callTool<LoginResult>(agentB.client, 'network_login');
    checkEqual('断线后可重新上线', relogin.online, true);
    check('上线返回排队待办数量', relogin.pending_count >= 1, relogin);
    await offlineCollector.waitFor(
      (event) => hasStreamItem(event, (item) => item.source === 'session.login'),
      '等待上线补发 stream 帧',
    );
    const queued = await inbox(agentB, 'pending');
    check(
      '上线后可读到离线期间排队的投递',
      queued.items.some((item) => item.delivery_id === offlineSend.delivery_ids[0]),
      queued.items,
    );
    const onlineTask = await sendMessage(agentA, roomId, 'online-task', { invoke: [b.actor_id] });
    await waitUntil(
      '上线后收到新的投递 stream 帧',
      () =>
        offlineCollector.events.some((event) =>
          hasStreamItem(
            event,
            (item) =>
              item.source === 'delivery.created' &&
              item.delivery_id === onlineTask.delivery_ids[0],
          ),
        ),
    );
    await resubscribed.close();

    // 网页人类发送回归：页面把房间内 Agent 成员填入 invoke，人类成员不产生 delivery。
    await befriend(humanC, c.actor_id, agentB, b.actor_id);
    const webCollector = notificationCollector(agentB.client);
    const webSubscription = await openSubscription(agentB.client, [STREAM_URI]);
    await waitUntil('等待网页回归统一 stream 建立', () =>
      Boolean(webSubscription.honoredFilter.resourceSubscriptions?.length),
    );
    await callTool(agentB.client, 'network_login');
    await webCollector.waitFor(
      (event) => hasStreamItem(event, (item) => item.source === 'session.login'),
      '等待网页回归上线帧',
    );
    webCollector.reset();
    const webRoom = await callTool<RoomDetail>(humanC.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [b.actor_id],
    });
    const webRoomId = webRoom.room.room_id;
    const webPresence = await callTool<RoomDetail>(humanC.client, 'network_room_get', {
      room_id: webRoomId,
    });
    checkEqual(
      'room_get 为 Agent 成员返回在线',
      webPresence.members.find((member) => member.actor_id === b.actor_id)?.online,
      true,
    );
    checkEqual(
      '人类成员不返回在线状态',
      webPresence.members.find((member) => member.actor_id === c.actor_id)?.online,
      null,
    );
    check(
      '网页人类单聊成员包含 human 与 agent 类型',
      webRoom.members.some((member) => member.actor_id === c.actor_id && member.kind === 'human') &&
        webRoom.members.some((member) => member.actor_id === b.actor_id && member.kind === 'agent'),
      webRoom.members,
    );
    const inboxBeforeWeb = await inbox(agentB, 'pending');
    const webSend = await sendMessage(humanC, webRoomId, 'web-human-hello', {
      invoke: [b.actor_id],
    });
    checkEqual('网页人类发送为 Agent 创建 delivery', webSend.delivery_ids.length, 1);
    const webEvent = await webCollector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) =>
            item.source === 'delivery.created' &&
            item.delivery_id === webSend.delivery_ids[0],
        ),
      '等待网页消息触发统一 stream 通知',
    );
    check(
      '网页消息触发统一 stream 通知',
      Boolean(subscriptionIdOf(webEvent.params)),
      webEvent.params,
    );
    const inboxAfterWeb = await inbox(agentB, 'pending');
    check(
      'Agent inbox 出现网页消息 delivery',
      inboxAfterWeb.items.some((item) => item.delivery_id === webSend.delivery_ids[0]),
      inboxAfterWeb.items,
    );
    checkEqual(
      '网页消息使 Agent pending_count 增加 1',
      inboxAfterWeb.pending_count,
      inboxBeforeWeb.pending_count + 1,
    );
    const humanInbox = await inbox(humanC, 'all');
    check(
      '人类发送者没有给自己的 delivery',
      !humanInbox.items.some((item) => item.message_id === webSend.message.message_id),
      humanInbox.items,
    );
    await expectToolError(
      '网页人类发送不能 invoke 人类成员',
      sendMessage(humanC, webRoomId, 'web-human-target', { invoke: [c.actor_id] }),
      'INVALID_ARGUMENT',
    );
    await webSubscription.close();

    // 群聊：显式 invoke 仍创建 delivery；新 Web group 省略 invoke，由服务端解析正文 @。
    const webGroup = await callTool<RoomDetail>(agentA.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      members: [b.actor_id, c.actor_id],
      title: '网页群聊回归',
    });
    const webGroupId = webGroup.room.room_id;
    await acceptGroupInvites(agentB, webGroupId);
    await acceptGroupInvites(humanC, webGroupId);
    const groupSend = await sendMessage(humanC, webGroupId, 'web-group-hello', {
      invoke: [a.actor_id, b.actor_id],
    });
    checkEqual('显式 invoke 多个 Agent 时各创建一条 delivery', new Set(groupSend.delivery_ids).size, 2);
    const groupInboxA = await inbox(agentA, 'pending');
    const groupInboxB = await inbox(agentB, 'pending');
    check(
      '显式 invoke 的目标都出现在 inbox',
      groupInboxA.items.some((item) => item.message_id === groupSend.message.message_id) &&
        groupInboxB.items.some((item) => item.message_id === groupSend.message.message_id),
      { a: groupInboxA.items, b: groupInboxB.items },
    );
    const groupHumanInbox = await inbox(humanC, 'all');
    check(
      '网页群聊不产生人类成员 delivery',
      !groupHumanInbox.items.some((item) => item.message_id === groupSend.message.message_id),
      groupHumanInbox.items,
    );

    // 群聊 delivery 与单聊共用回执状态：pending → claimed → completed。
    const groupDeliveryA = groupInboxA.items.find(
      (item) => item.message_id === groupSend.message.message_id && item.recipient_id === a.actor_id,
    );
    const groupDeliveryB = groupInboxB.items.find(
      (item) => item.message_id === groupSend.message.message_id && item.recipient_id === b.actor_id,
    );
    checkEqual('群聊 delivery 初始为 pending', groupDeliveryA?.state, 'pending');
    const groupClaimedA = await callTool<Delivery>(agentA.client, 'network_delivery_claim', {
      request_id: newRequestId('claim'),
      delivery_id: groupDeliveryA!.delivery_id,
    });
    const groupClaimedHistory = await callTool<HistoryPage>(humanC.client, 'network_history_list', {
      room_id: webGroupId,
      limit: 20,
    });
    const groupClaimedRow = groupClaimedHistory.items.find(
      (item) => item.message_id === groupSend.message.message_id,
    );
    checkEqual('群聊 claim 后发送方 history 显示 claimed 回执', groupClaimedRow?.delivery_states.claimed, 1);
    checkEqual('群聊 claim 后另一条投递仍为 pending', groupClaimedRow?.delivery_states.pending, 1);
    await callTool(agentA.client, 'network_delivery_complete', {
      request_id: newRequestId('complete'),
      delivery_id: groupDeliveryA!.delivery_id,
      attempt: groupClaimedA.attempt,
      claim_id: groupClaimedA.claim_id,
      final_body: 'group completed by A',
    });
    const groupCompletedHistory = await callTool<HistoryPage>(humanC.client, 'network_history_list', {
      room_id: webGroupId,
      limit: 20,
    });
    const groupCompletedRow = groupCompletedHistory.items.find(
      (item) => item.message_id === groupSend.message.message_id,
    );
    checkEqual('群聊 complete 后发送方 history 显示 completed 回执', groupCompletedRow?.delivery_states.completed, 1);
    const groupClaimedB = await callTool<Delivery>(agentB.client, 'network_delivery_claim', {
      request_id: newRequestId('claim'),
      delivery_id: groupDeliveryB!.delivery_id,
    });
    await callTool(agentB.client, 'network_delivery_complete', {
      request_id: newRequestId('complete'),
      delivery_id: groupDeliveryB!.delivery_id,
      attempt: groupClaimedB.attempt,
      claim_id: groupClaimedB.claim_id,
      final_body: 'group completed by B',
    });
    const groupAllCompletedHistory = await callTool<HistoryPage>(humanC.client, 'network_history_list', {
      room_id: webGroupId,
      limit: 20,
    });
    const groupAllCompletedRow = groupAllCompletedHistory.items.find(
      (item) => item.message_id === groupSend.message.message_id,
    );
    checkEqual('群聊所有投递完成后 completed 回执为 2', groupAllCompletedRow?.delivery_states.completed, 2);
    checkEqual('群聊所有投递完成后没有 pending 回执', groupAllCompletedRow?.delivery_states.pending, undefined);

    const mentionSend = await sendMessage(
      humanC,
      webGroupId,
      '@验收 Agent A 全局名 请处理这条群消息',
      { invoke: [a.actor_id] },
    );
    checkEqual('群 @ 只为被 @ 的 Agent 创建 delivery', mentionSend.delivery_ids.length, 1);
    const mentionInboxA = await inbox(agentA, 'pending');
    const mentionInboxB = await inbox(agentB, 'pending');
    check(
      '被 @ 的 Agent A 收到群消息 delivery',
      mentionInboxA.items.some((item) => item.message_id === mentionSend.message.message_id),
      mentionInboxA.items,
    );
    check(
      '未 @ 的 Agent B 没有该群消息 delivery',
      !mentionInboxB.items.some((item) => item.message_id === mentionSend.message.message_id),
      mentionInboxB.items,
    );

    const plainGroupSend = await sendMessage(humanC, webGroupId, '没有 @ 的普通群消息');
    checkEqual('未 @ 的群消息不创建 delivery', plainGroupSend.delivery_ids.length, 0);
    const plainInboxA = await inbox(agentA, 'pending');
    const plainInboxB = await inbox(agentB, 'pending');
    check(
      '普通群消息不进入任何 Agent inbox',
      !plainInboxA.items.some((item) => item.message_id === plainGroupSend.message.message_id) &&
        !plainInboxB.items.some((item) => item.message_id === plainGroupSend.message.message_id),
      { a: plainInboxA.items, b: plainInboxB.items },
    );

    const resourceStream = await readResourceJson<{ actor_id: string }>(
      agentB.client,
      STREAM_URI,
    );
    checkEqual('resources/read agentnet://stream 返回身份', resourceStream.actor_id, b.actor_id);

    const badScope = await expectToolError(
      '未知 sync scope 返回 INVALID_ARGUMENT',
      callTool(agentB.client, 'network_sync', { scope: 'everything' }),
      'INVALID_ARGUMENT',
    );
    check('未知 scope 错误可读', typeof badScope.body.message === 'string', badScope.body);

    await runUnifiedStreamAcceptance();
    const toolList = await rawRpc('tools/list');
    const hasDrive =
      (toolList.body.result as { tools?: { name?: string }[] } | undefined)?.tools?.some(
        (tool) => tool.name === 'drive_file_info',
      ) ?? false;
    if (hasDrive) {
      await runRoomFileAcceptance();
      await runPrivateFileAcceptance();
    } else {
      console.log('  · Drive 未启用，跳过房间文件端到端片段');
    }
    await runAgentIdentityAcceptance();
    await runContactRelationAcceptance();
    await runContactBlockAcceptance();
    await runAgentArchiveAcceptance();
    await runAgentPresenceAcceptance();
    await runRoomMonitorAcceptance();
    await runRoomTaskAcceptance();
    await runTaskAssignmentAcceptance();
    await runFeedbackAcceptance();
    await runGroupMentionAcceptance();
    await runGroupNoImplicitDeliveryAcceptance();
    await runGroupRoleAcceptance();
    await runOwnerTransferAcceptance();
    await runGroupInviteAcceptance();
    await runGroupInviteLinkAcceptance();
    await runGroupHistoryAcceptance({ hasDrive });
    await runGroupPolicyAcceptance({ hasDrive });
    await runMessageReliabilityAcceptance();

    console.log(`端到端验收通过: ${checksPassed()} 项`);
  } finally {
    await Promise.all([agentA.close(), agentB.close(), humanC.close()]);
  }
}

await main().catch((error) => {
  console.error('端到端验收失败:', error);
  process.exit(1);
});

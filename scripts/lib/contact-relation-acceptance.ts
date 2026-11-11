/**
 * A03 好友申请与双向关系验收（T01–T04）。
 *
 * T01 申请/接受/拒绝/撤销与陌生人禁写；T02 并发收敛、重复接受与过期；
 * T03 管理者自有 Agent 自动建联、其他 Agent 遵守接收策略；T04 单侧
 * `contacts` 只是个人历史，旧单聊历史保留但新消息需要关系。
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
  sleep,
  type McpConnection,
} from './harness';
import {
  befriend,
  inbox,
  registerIdentity,
  sendMessage,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface ContactRequestView {
  contact_request_id: string;
  status: string;
  direction: 'incoming' | 'outgoing';
  message: string;
  auto_accepted: boolean;
  can_respond: boolean;
  can_cancel: boolean;
  from_actor: { actor_id: string; kind: string; name: string };
  to_actor: { actor_id: string; kind: string; name: string };
}

interface ContactRequestResult {
  request: ContactRequestView | null;
  relation: { status: string; source: string } | null;
  status: string;
  already_friends: boolean;
  auto_accepted: boolean;
}

interface ContactRequestPage {
  items: ContactRequestView[];
  next_cursor: string | null;
  has_more: boolean;
}

interface ContactRow {
  actor_id: string;
  relation: 'active' | 'none';
}

interface ContactPage {
  items: ContactRow[];
}

interface PolicyView {
  actor_id: string;
  policy: 'self_approval' | 'manager_approval' | 'auto_accept';
  configured: boolean;
  approver_actor_id: string | null;
}

interface StreamItemView {
  source?: string;
  kind?: string;
  ref_id?: string;
}

function streamItemsOf(event: { params: Record<string, unknown> }): StreamItemView[] {
  const meta = event.params._meta as Record<string, unknown> | undefined;
  const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
  return payload?.items ?? [];
}

function hasContactStreamItem(event: { params: Record<string, unknown> }): boolean {
  return event.params.uri === STREAM_URI && streamItemsOf(event).some((item) => item.kind === 'contact');
}

async function requestContact(
  connection: McpConnection,
  target: string,
  options: { message?: string; expiresInMs?: number; requestId?: string } = {},
): Promise<ContactRequestResult> {
  return callTool<ContactRequestResult>(connection.client, 'network_contact_request', {
    request_id: options.requestId ?? newRequestId('creq'),
    actor_id: target,
    ...(options.message !== undefined ? { message: options.message } : {}),
    ...(options.expiresInMs !== undefined ? { expires_in_ms: options.expiresInMs } : {}),
  });
}

async function respondContact(
  connection: McpConnection,
  contactRequestId: string,
  action: 'accept' | 'reject',
): Promise<ContactRequestResult> {
  return callTool<ContactRequestResult>(connection.client, 'network_contact_request_respond', {
    request_id: newRequestId('cres'),
    contact_request_id: contactRequestId,
    action,
  });
}

async function cancelContact(
  connection: McpConnection,
  contactRequestId: string,
): Promise<ContactRequestResult> {
  return callTool<ContactRequestResult>(connection.client, 'network_contact_request_cancel', {
    request_id: newRequestId('ccan'),
    contact_request_id: contactRequestId,
  });
}

async function listRequests(
  connection: McpConnection,
  direction: 'all' | 'incoming' | 'outgoing',
  status?: string,
): Promise<ContactRequestPage> {
  return callTool<ContactRequestPage>(connection.client, 'network_contact_requests_list', {
    direction,
    ...(status ? { status } : {}),
    limit: 50,
  });
}

async function contacts(connection: McpConnection): Promise<ContactPage> {
  return callTool<ContactPage>(connection.client, 'network_contacts_list', { limit: 100 });
}

async function directRoom(connection: McpConnection, target: string): Promise<RoomDetail> {
  return callTool<RoomDetail>(connection.client, 'network_room_create', {
    request_id: newRequestId('room'),
    kind: 'direct',
    members: [target],
  });
}

async function relationOf(connection: McpConnection, target: string): Promise<string | null> {
  const page = await contacts(connection);
  return page.items.find((item) => item.actor_id === target)?.relation ?? null;
}

/** T01：双向同意才建立关系；陌生人不能创建 direct 或写入消息。 */
async function runBilateralConsent(): Promise<void> {
  console.log('  · A03-T01 好友申请与双向同意');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const u3Conn = await connectClient(newToken());
  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'A03 用户一' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'A03 用户二' });
    const u3 = await registerIdentity(u3Conn, { kind: 'human', name: 'A03 用户三' });

    const requested = await requestContact(u1Conn, u2.actor_id, { message: '你好，我是用户一' });
    checkEqual('T01 申请初始为 pending', requested.status, 'pending');
    checkEqual('T01 发起方 direction=outgoing', requested.request?.direction, 'outgoing');
    checkEqual('T01 申请附言保存在申请本身', requested.request?.message, '你好，我是用户一');
    const requestId = requested.request?.contact_request_id ?? '';
    check('T01 申请返回 contact_request_id', requestId.startsWith('creq_'), requestId);

    const incoming = await listRequests(u2Conn, 'incoming', 'pending');
    const incomingView = incoming.items.find((item) => item.contact_request_id === requestId);
    checkEqual('T01 目标可在独立申请收件箱看到申请', incomingView?.direction, 'incoming');
    checkEqual('T01 目标可以处理申请', incomingView?.can_respond, true);

    await expectToolError(
      'T01 pending 期间不能创建 direct',
      directRoom(u1Conn, u2.actor_id),
      'FRIEND_REQUIRED',
    );
    checkEqual('T01 未接受前没有好友关系', await relationOf(u1Conn, u2.actor_id), null);

    const accepted = await respondContact(u2Conn, requestId, 'accept');
    checkEqual('T01 目标接受后状态为 accepted', accepted.status, 'accepted');
    checkEqual('T01 接受后关系 active', accepted.relation?.status, 'active');
    checkEqual('T01 关系来源为 request', accepted.relation?.source, 'request');
    checkEqual('T01 发起方看到 active 关系', await relationOf(u1Conn, u2.actor_id), 'active');
    checkEqual('T01 目标看到 active 关系', await relationOf(u2Conn, u1.actor_id), 'active');

    const room = await directRoom(u1Conn, u2.actor_id);
    checkEqual('T01 接受后可创建 direct', room.room.kind, 'direct');
    const sent = await sendMessage(u1Conn, room.room.room_id, '好友消息');
    check('T01 接受后可发送消息', sent.message.message_id.startsWith('msg_'), sent.message);

    const rejectedRequest = await requestContact(u3Conn, u1.actor_id, { message: '陌生人申请' });
    const rejected = await respondContact(u1Conn, rejectedRequest.request?.contact_request_id ?? '', 'reject');
    checkEqual('T01 拒绝后状态为 rejected', rejected.status, 'rejected');
    checkEqual('T01 拒绝后没有关系', rejected.relation, null);
    await expectToolError(
      'T01 被拒绝后不能创建 direct',
      directRoom(u3Conn, u1.actor_id),
      'FRIEND_REQUIRED',
    );

    const cancelledRequest = await requestContact(u3Conn, u1.actor_id);
    const cancelled = await cancelContact(u3Conn, cancelledRequest.request?.contact_request_id ?? '');
    checkEqual('T01 撤销后状态为 cancelled', cancelled.status, 'cancelled');
    const cancelledList = await listRequests(u1Conn, 'incoming', 'cancelled');
    check(
      'T01 撤销后的申请仍可查询',
      cancelledList.items.some((item) => item.contact_request_id === cancelled.request?.contact_request_id),
      cancelledList.items,
    );

    const humanInbox = await inbox(u2Conn, 'pending');
    checkEqual('T01 好友申请不产生 delivery', humanInbox.items.length, 0);
  } finally {
    await u1Conn.close();
    await u2Conn.close();
    await u3Conn.close();
  }
}

/** T02：双向并发收敛、重复接受幂等、过期与 Agent 不被唤醒。 */
async function runConcurrencyAndExpiry(): Promise<void> {
  console.log('  · A03-T02 并发收敛、幂等与过期');
  const u1Conn = await connectClient(newToken());
  const u2Conn = await connectClient(newToken());
  const u4Conn = await connectClient(newToken());
  const u5Conn = await connectClient(newToken());
  const agentConn = await connectClient(newToken());
  let agentSubscription: Awaited<ReturnType<typeof openSubscription>> | null = null;
  try {
    const u1 = await registerIdentity(u1Conn, { kind: 'human', name: 'A03 并发一' });
    const u2 = await registerIdentity(u2Conn, { kind: 'human', name: 'A03 并发二' });
    const u4 = await registerIdentity(u4Conn, { kind: 'human', name: 'A03 过期一' });
    const u5 = await registerIdentity(u5Conn, { kind: 'human', name: 'A03 过期二' });
    const agent = await registerIdentity(agentConn, {
      kind: 'agent',
      name: 'A03 通知 Agent',
      sessionId: `a03_agent_${crypto.randomUUID().replaceAll('-', '')}`,
    });

    const [fromOne, fromTwo] = await Promise.all([
      requestContact(u1Conn, u2.actor_id),
      requestContact(u2Conn, u1.actor_id),
    ]);
    checkEqual('T02 双向同时申请都返回 pending', fromOne.status, 'pending');
    checkEqual('T02 双向同时申请共享一条记录', fromTwo.status, 'pending');
    const sharedId = fromOne.request?.contact_request_id ?? '';
    checkEqual(
      'T02 双向同时申请收敛到同一 contact_request_id',
      fromTwo.request?.contact_request_id,
      sharedId,
    );

    const responder = fromOne.request?.from_actor.actor_id === u1.actor_id ? u2Conn : u1Conn;
    const [acceptA, acceptB] = await Promise.all([
      respondContact(responder, sharedId, 'accept'),
      respondContact(responder, sharedId, 'accept'),
    ]);
    checkEqual('T02 并发接受都收敛为 accepted #1', acceptA.status, 'accepted');
    checkEqual('T02 并发接受都收敛为 accepted #2', acceptB.status, 'accepted');
    checkEqual('T02 并发接受只产生一个 active 关系', await relationOf(u1Conn, u2.actor_id), 'active');

    const requester = responder === u1Conn ? u2Conn : u1Conn;
    const requesterMe = await callTool<{ inbox_head_seq: string }>(requester.client, 'network_me', {});
    const duplicate = await respondContact(responder, sharedId, 'accept');
    checkEqual('T02 重复接受返回 accepted', duplicate.status, 'accepted');
    const requesterMeAfter = await callTool<{ inbox_head_seq: string }>(requester.client, 'network_me', {});
    checkEqual(
      'T02 重复接受不重复推进通知 head',
      requesterMeAfter.inbox_head_seq,
      requesterMe.inbox_head_seq,
    );

    const expiring = await requestContact(u4Conn, u5.actor_id, { expiresInMs: 1_000 });
    checkEqual('T02 可缩短有效期的申请为 pending', expiring.status, 'pending');
    await sleep(1_200);
    const expiredList = await listRequests(u4Conn, 'outgoing', 'expired');
    check(
      'T02 过期申请在读取时标记为 expired',
      expiredList.items.some((item) => item.contact_request_id === expiring.request?.contact_request_id),
      expiredList.items,
    );
    await expectToolError(
      'T02 过期申请不能再接受',
      respondContact(u5Conn, expiring.request?.contact_request_id ?? '', 'accept'),
      'REQUEST_EXPIRED',
    );
    await expectToolError(
      'T02 过期后仍不能创建 direct',
      directRoom(u4Conn, u5.actor_id),
      'FRIEND_REQUIRED',
    );

    const collector = notificationCollector(agentConn.client);
    await callTool(agentConn.client, 'network_login');
    agentSubscription = await openSubscription(agentConn.client, [STREAM_URI]);
    const beforePending = await inbox(agentConn, 'pending');
    const pendingRequestId = newRequestId('creq_agent');
    const pendingToAgent = await requestContact(u1Conn, agent.actor_id, {
      message: '不唤醒 Agent',
      requestId: pendingRequestId,
    });
    const agentMe = await callTool<{ inbox_head_seq: string }>(agentConn.client, 'network_me', {});
    await requestContact(u1Conn, agent.actor_id, {
      message: '不唤醒 Agent',
      requestId: pendingRequestId,
    });
    const agentMeAfterReplay = await callTool<{ inbox_head_seq: string }>(
      agentConn.client,
      'network_me',
      {},
    );
    checkEqual(
      'T02 重复申请同一 request_id 不重复推进 Agent 通知 head',
      agentMeAfterReplay.inbox_head_seq,
      agentMe.inbox_head_seq,
    );
    checkEqual('T02 重复申请返回同一 pending', pendingToAgent.status, 'pending');
    await sleep(600);
    const afterPending = await inbox(agentConn, 'pending');
    checkEqual('T02 好友申请不增加 Agent 待办', afterPending.items.length, beforePending.items.length);
    check(
      'T02 好友申请不向 Agent 推送 contact stream 项',
      !collector.events.some(hasContactStreamItem),
      collector.events.map((event) => event.params.uri),
    );

    // Agent 作为发起方被拒绝：拒绝事件只落持久 inbox，不写 outbox。
    const rejectedByHuman = await requestContact(agentConn, u5.actor_id);
    await respondContact(u5Conn, rejectedByHuman.request?.contact_request_id ?? '', 'reject');
    await sleep(600);
    check(
      'T02 拒绝好友申请不向 Agent 推送 contact stream 项',
      !collector.events.some(hasContactStreamItem),
      collector.events.map((event) => event.params.uri),
    );
    const afterReject = await inbox(agentConn, 'pending');
    checkEqual('T02 拒绝好友申请不增加 Agent 待办', afterReject.items.length, beforePending.items.length);
  } finally {
    if (agentSubscription) await agentSubscription.close().catch(() => undefined);
    await u1Conn.close();
    await u2Conn.close();
    await u4Conn.close();
    await u5Conn.close();
    await agentConn.close();
  }
}

/** T03：自有 Agent 自动建联；其他 Agent 遵守接收策略。 */
async function runAgentPolicies(): Promise<void> {
  console.log('  · A03-T03 自有 Agent 与接收策略');
  const h1Conn = await connectClient(newToken());
  const h2Conn = await connectClient(newToken());
  const h3Conn = await connectClient(newToken());
  let agentConn: McpConnection | null = null;
  try {
    const h1 = await registerIdentity(h1Conn, { kind: 'human', name: 'A03 管理者' });
    const h2 = await registerIdentity(h2Conn, { kind: 'human', name: 'A03 外部用户' });
    const h3 = await registerIdentity(h3Conn, { kind: 'human', name: 'A03 待审批用户' });
    const created = await callTool<
      Identity & { token: string; agent_session_id: string }
    >(h1Conn.client, 'network_agent_create', {
      request_id: newRequestId('agent'),
      name: 'A03 自有 Agent',
    });
    agentConn = await connectClient(created.token);
    const own = await requestContact(h1Conn, created.actor_id);
    checkEqual('T03 管理者向自有 Agent 申请自动接受', own.status, 'accepted');
    checkEqual('T03 自动接受标记 auto_accepted', own.auto_accepted, true);
    checkEqual('T03 关系来源 auto_manager', own.relation?.source, 'auto_manager');
    const ownRoom = await directRoom(h1Conn, created.actor_id);
    checkEqual('T03 自有 Agent 可立即建立 direct', ownRoom.room.kind, 'direct');

    const policy = await callTool<PolicyView>(h1Conn.client, 'network_contact_policy_get', {
      actor_id: created.actor_id,
    });
    checkEqual('T03 有管理者的 Agent 默认管理者确认', policy.policy, 'manager_approval');
    checkEqual('T03 默认策略未显式配置', policy.configured, false);
    checkEqual('T03 审批人为管理者', policy.approver_actor_id, h1.actor_id);

    const external = await requestContact(h2Conn, created.actor_id);
    checkEqual('T03 外部用户申请其他 Agent 默认 pending', external.status, 'pending');
    await expectToolError(
      'T03 外部用户在确认前不能建立 direct',
      directRoom(h2Conn, created.actor_id),
      'FRIEND_REQUIRED',
    );
    await expectToolError(
      'T03 非管理者不能读取 Agent 接收策略',
      callTool(h2Conn.client, 'network_contact_policy_get', { actor_id: created.actor_id }),
      'PERMISSION_DENIED',
    );

    const managedRequest = await requestContact(h3Conn, created.actor_id);
    const managerIncoming = await listRequests(h1Conn, 'incoming', 'pending');
    const managerView = managerIncoming.items.find(
      (item) => item.contact_request_id === managedRequest.request?.contact_request_id,
    );
    checkEqual('T03 管理者在申请入口看到发给自有 Agent 的申请', managerView?.direction, 'incoming');
    checkEqual('T03 管理者可以处理自有 Agent 的申请', managerView?.can_respond, true);
    await expectToolError(
      'T03 非管理者不能代自有 Agent 接受申请',
      respondContact(h2Conn, managedRequest.request?.contact_request_id ?? '', 'accept'),
      'PERMISSION_DENIED',
    );
    const approved = await respondContact(
      h1Conn,
      managedRequest.request?.contact_request_id ?? '',
      'accept',
    );
    checkEqual('T03 管理者代自有 Agent 接受申请', approved.status, 'accepted');
    checkEqual('T03 管理者批准后关系 active', approved.relation?.status, 'active');
    checkEqual('T03 管理者批准的关系来源为 request', approved.relation?.source, 'request');
    checkEqual('T03 管理者批准后申请方看到 active', await relationOf(h3Conn, created.actor_id), 'active');
    const approvedRoom = await directRoom(h3Conn, created.actor_id);
    checkEqual('T03 管理者批准后可建立 direct', approvedRoom.room.kind, 'direct');

    await cancelContact(h2Conn, external.request?.contact_request_id ?? '');
    const configured = await callTool<PolicyView>(h1Conn.client, 'network_contact_policy_set', {
      request_id: newRequestId('policy'),
      actor_id: created.actor_id,
      policy: 'auto_accept',
    });
    checkEqual('T03 管理者可显式设置 auto_accept', configured.policy, 'auto_accept');
    checkEqual('T03 显式策略返回 configured=true', configured.configured, true);
    const autoAccepted = await requestContact(h2Conn, created.actor_id);
    checkEqual('T03 显式 auto_accept 后自动接受', autoAccepted.status, 'accepted');
    checkEqual('T03 显式 auto_accept 的关系来源为 request', autoAccepted.relation?.source, 'request');
    const externalRoom = await directRoom(h2Conn, created.actor_id);
    checkEqual('T03 自动接受后可建立 direct', externalRoom.room.kind, 'direct');

    const humanPolicy = await callTool<PolicyView>(h1Conn.client, 'network_contact_policy_get', {});
    checkEqual('T03 人类默认本人确认', humanPolicy.policy, 'self_approval');
    await expectToolError(
      'T03 人类不能使用 manager_approval',
      callTool(h1Conn.client, 'network_contact_policy_set', {
        request_id: newRequestId('policy'),
        policy: 'manager_approval',
      }),
      'INVALID_ARGUMENT',
    );
  } finally {
    if (agentConn) await agentConn.close();
    await h1Conn.close();
    await h2Conn.close();
    await h3Conn.close();
  }
}

/** T04：单侧收藏不是同意；结束关系后保留历史但禁止新消息。 */
async function runLegacyBookmarks(): Promise<void> {
  console.log('  · A03-T04 单侧收藏与历史保留');
  const h1Conn = await connectClient(newToken());
  const h2Conn = await connectClient(newToken());
  try {
    const h1 = await registerIdentity(h1Conn, { kind: 'human', name: 'A03 历史一' });
    const h2 = await registerIdentity(h2Conn, { kind: 'human', name: 'A03 历史二' });

    await callTool(h1Conn.client, 'network_contact_add', {
      request_id: newRequestId('contact'),
      actor_id: h2.actor_id,
    });
    checkEqual('T04 单侧收藏不是好友关系', await relationOf(h1Conn, h2.actor_id), 'none');
    await expectToolError(
      'T04 单侧收藏不能创建 direct',
      directRoom(h1Conn, h2.actor_id),
      'FRIEND_REQUIRED',
    );

    const requested = await requestContact(h1Conn, h2.actor_id);
    await respondContact(h2Conn, requested.request?.contact_request_id ?? '', 'accept');
    const room = await directRoom(h1Conn, h2.actor_id);
    const roomId = room.room.room_id;
    await sendMessage(h1Conn, roomId, '历史消息保留');

    const roomsBeforeRemove = await callTool<{ items: { room_id: string }[] }>(
      h1Conn.client,
      'network_rooms_list',
      { limit: 100 },
    );
    check(
      'T04 删除前 rooms_list 包含旧单聊',
      roomsBeforeRemove.items.some((item) => item.room_id === roomId),
      roomsBeforeRemove.items,
    );

    const removed = await callTool<{ removed: true }>(h1Conn.client, 'network_contact_remove', {
      request_id: newRequestId('contact_remove'),
      actor_id: h2.actor_id,
    });
    checkEqual('T04 删除好友返回 removed', removed.removed, true);
    checkEqual('T04 删除后发起方不再有收藏', await relationOf(h1Conn, h2.actor_id), null);
    checkEqual('T04 对方联系人列表也不再返回已删除好友', await relationOf(h2Conn, h1.actor_id), null);

    const roomsAfterRemove = await callTool<{ items: { room_id: string }[] }>(
      h1Conn.client,
      'network_rooms_list',
      { limit: 100 },
    );
    check(
      'T04 删除后发起方 rooms_list 默认排除旧单聊',
      !roomsAfterRemove.items.some((item) => item.room_id === roomId),
      roomsAfterRemove.items,
    );
    const peerRoomsAfterRemove = await callTool<{ items: { room_id: string }[] }>(
      h2Conn.client,
      'network_rooms_list',
      { limit: 100 },
    );
    check(
      'T04 删除后对方 rooms_list 也默认排除旧单聊',
      !peerRoomsAfterRemove.items.some((item) => item.room_id === roomId),
      peerRoomsAfterRemove.items,
    );

    const historyOne = await callTool<{ items: { preview: string }[] }>(
      h1Conn.client,
      'network_history_list',
      { room_id: roomId, limit: 20 },
    );
    const historyTwo = await callTool<{ items: { preview: string }[] }>(
      h2Conn.client,
      'network_history_list',
      { room_id: roomId, limit: 20 },
    );
    check(
      'T04 删除关系后双方仍能读取旧单聊历史',
      historyOne.items.some((item) => item.preview === '历史消息保留') &&
        historyTwo.items.some((item) => item.preview === '历史消息保留'),
      { historyOne, historyTwo },
    );
    await expectToolError(
      'T04 删除关系后发起方不能发新消息',
      sendMessage(h1Conn, roomId, '不应发送'),
      'FRIEND_REQUIRED',
    );
    await expectToolError(
      'T04 删除关系后对方也不能发新消息',
      sendMessage(h2Conn, roomId, '不应发送'),
      'FRIEND_REQUIRED',
    );
    const stillRoom = await callTool<RoomDetail>(h2Conn.client, 'network_room_get', { room_id: roomId });
    checkEqual('T04 旧房间成员仍然保留', stillRoom.members.length, 2);
    const stillRoomOne = await callTool<RoomDetail>(h1Conn.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual('T04 删除后发起方仍可显式读取旧房间', stillRoomOne.room.room_id, roomId);

    const again = await requestContact(h2Conn, h1.actor_id);
    await respondContact(h1Conn, again.request?.contact_request_id ?? '', 'accept');
    const resumed = await sendMessage(h2Conn, roomId, '重新成为好友');
    check('T04 重新接受后可继续发送', resumed.message.message_id.startsWith('msg_'), resumed.message);
    const roomsAfterResume = await callTool<{ items: { room_id: string }[] }>(
      h1Conn.client,
      'network_rooms_list',
      { limit: 100 },
    );
    check(
      'T04 重新成为好友后旧单聊回到默认列表',
      roomsAfterResume.items.some((item) => item.room_id === roomId),
      roomsAfterResume.items,
    );
    const peerRoomsAfterResume = await callTool<{ items: { room_id: string }[] }>(
      h2Conn.client,
      'network_rooms_list',
      { limit: 100 },
    );
    check(
      'T04 重新成为好友后对方列表也恢复旧单聊',
      peerRoomsAfterResume.items.some((item) => item.room_id === roomId),
      peerRoomsAfterResume.items,
    );
    checkEqual(
      'T04 重新成为好友后对方联系人恢复 active',
      await relationOf(h2Conn, h1.actor_id),
      'active',
    );
  } finally {
    await h1Conn.close();
    await h2Conn.close();
  }
}

/** T05：早返回结果也持久化；同一 request_id 在外部状态变化后仍返回首次结果。 */
async function runIdempotencyEdges(): Promise<void> {
  console.log('  · A03-T05 幂等结果持久化边界');
  const aConn = await connectClient(newToken());
  const bConn = await connectClient(newToken());
  const cConn = await connectClient(newToken());
  const dConn = await connectClient(newToken());
  try {
    const a = await registerIdentity(aConn, { kind: 'human', name: 'A03 幂等一' });
    const b = await registerIdentity(bConn, { kind: 'human', name: 'A03 幂等二' });
    const c = await registerIdentity(cConn, { kind: 'human', name: 'A03 幂等三' });
    const d = await registerIdentity(dConn, { kind: 'human', name: 'A03 幂等四' });
    await befriend(aConn, a.actor_id, bConn, b.actor_id);

    const friendRequestId = newRequestId('idem_friend');
    const friendFirst = await requestContact(aConn, b.actor_id, { requestId: friendRequestId });
    checkEqual('T05 已是好友时返回 accepted', friendFirst.status, 'accepted');
    checkEqual('T05 已是好友时标记 already_friends', friendFirst.already_friends, true);
    checkEqual('T05 已是好友时没有申请对象', friendFirst.request, null);

    await callTool(aConn.client, 'network_contact_remove', {
      request_id: newRequestId('idem_remove'),
      actor_id: b.actor_id,
    });
    checkEqual('T05 解除好友后关系结束', await relationOf(aConn, b.actor_id), null);
    const friendReplay = await requestContact(aConn, b.actor_id, {
      requestId: friendRequestId,
    });
    checkEqual('T05 解除好友后同一 request_id 仍返回 accepted', friendReplay.status, 'accepted');
    checkEqual(
      'T05 解除好友后重放仍返回首次 already_friends',
      friendReplay.already_friends,
      true,
    );
    checkEqual('T05 解除好友后重放不新建申请', friendReplay.request, null);
    const afterUnfriend = await listRequests(aConn, 'outgoing', 'pending');
    check(
      'T05 解除好友后重放不产生 pending 申请',
      !afterUnfriend.items.some((item) => item.to_actor.actor_id === b.actor_id),
      afterUnfriend.items,
    );

    const original = await requestContact(cConn, d.actor_id, { message: 'T05 原始申请' });
    const existingRequestId = newRequestId('idem_existing');
    const existingFirst = await requestContact(cConn, d.actor_id, {
      message: 'T05 早返回',
      requestId: existingRequestId,
    });
    checkEqual(
      'T05 已有 pending 时返回同一申请',
      existingFirst.request?.contact_request_id,
      original.request?.contact_request_id,
    );
    await cancelContact(cConn, original.request?.contact_request_id ?? '');
    const existingReplay = await requestContact(cConn, d.actor_id, {
      message: 'T05 早返回',
      requestId: existingRequestId,
    });
    checkEqual(
      'T05 申请撤销后同一 request_id 仍返回首次申请',
      existingReplay.request?.contact_request_id,
      original.request?.contact_request_id,
    );
    checkEqual('T05 申请撤销后重放仍返回 pending 快照', existingReplay.status, 'pending');
    const afterCancel = await listRequests(cConn, 'outgoing', 'pending');
    check(
      'T05 撤销后重放不新建 pending 申请',
      !afterCancel.items.some((item) => item.to_actor.actor_id === d.actor_id),
      afterCancel.items,
    );

    const concurrentRequestId = newRequestId('idem_concurrent');
    const [left, right] = await Promise.all([
      requestContact(aConn, b.actor_id, { requestId: concurrentRequestId }),
      requestContact(aConn, b.actor_id, { requestId: concurrentRequestId }),
    ]);
    checkEqual(
      'T05 并发同 request_id 都返回 pending',
      `${left.status}/${right.status}`,
      'pending/pending',
    );
    check(
      'T05 并发同 request_id 收敛到同一申请',
      Boolean(left.request?.contact_request_id) &&
        left.request?.contact_request_id === right.request?.contact_request_id,
      {
        left: left.request?.contact_request_id,
        right: right.request?.contact_request_id,
      },
    );
    const concurrentList = await listRequests(aConn, 'outgoing', 'pending');
    const matching = concurrentList.items.filter((item) => item.to_actor.actor_id === b.actor_id);
    checkEqual('T05 并发同 request_id 只创建一条 pending', matching.length, 1);
  } finally {
    await aConn.close();
    await bConn.close();
    await cConn.close();
    await dConn.close();
  }
}

/** T04b：删除好友隐藏 direct 会话，但不影响与好友关系无关的管理列表。 */
async function runUnfriendKeepsManagement(): Promise<void> {
  console.log('  · A03-T04b 删除好友与 Agent 管理列表');
  const managerConn = await connectClient(newToken());
  let agentConn: McpConnection | null = null;
  try {
    const manager = await registerIdentity(managerConn, {
      kind: 'human',
      name: 'A03 管理者',
    });
    const created = await callTool<{
      actor_id: string;
      agent_session_id: string;
      token: string;
    }>(managerConn.client, 'network_agent_create', {
      request_id: newRequestId('agent_create'),
      name: 'A03 被管理 Agent',
    });
    agentConn = await connectClient(created.token);
    const room = await directRoom(managerConn, created.actor_id);

    await callTool(agentConn.client, 'network_contact_remove', {
      request_id: newRequestId('agent_unfriend'),
      actor_id: manager.actor_id,
    });
    checkEqual(
      'T04b 管理者联系人列表不再返回已删除 Agent',
      await relationOf(managerConn, created.actor_id),
      null,
    );
    const roomsAfterRemove = await callTool<{ items: { room_id: string }[] }>(
      managerConn.client,
      'network_rooms_list',
      { limit: 100 },
    );
    check(
      'T04b 管理者 rooms_list 默认排除旧单聊',
      !roomsAfterRemove.items.some((item) => item.room_id === room.room.room_id),
      roomsAfterRemove.items,
    );
    const managed = await callTool<{ items: { actor_id: string }[] }>(
      managerConn.client,
      'network_agents_managed_list',
      { limit: 100 },
    );
    check(
      'T04b 删除好友不影响管理列表',
      managed.items.some((item) => item.actor_id === created.actor_id),
      managed.items,
    );
    const explicit = await callTool<RoomDetail>(managerConn.client, 'network_room_get', {
      room_id: room.room.room_id,
    });
    checkEqual('T04b 显式历史入口仍可读取旧单聊', explicit.room.room_id, room.room.room_id);
  } finally {
    if (agentConn) await agentConn.close();
    await managerConn.close();
  }
}

export async function runContactRelationAcceptance(): Promise<void> {
  console.log('· 好友申请与双向联系人关系');
  await runBilateralConsent();
  await runConcurrencyAndExpiry();
  await runAgentPolicies();
  await runLegacyBookmarks();
  await runUnfriendKeepsManagement();
  await runIdempotencyEdges();
}

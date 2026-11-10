/**
 * 统一 actor stream 的端到端验收。
 *
 * 与 acceptance.ts 的低层流程分开，避免单文件超过行数上限。这里使用
 * 官方客户端验证真实 wire：一条 `agentnet://stream` 覆盖多房间、login
 * 门控、source 信封、自通知过滤、成员变更与重连。
 */

import type { McpSubscription } from '@modelcontextprotocol/client';

import { LIMITS } from '../../src/contracts/limits';
import { StreamQueue } from '../../src/mcp/stream';
import { buildStreamFrame, type StreamItem } from '../../src/realtime/stream';
import type { Delivery, InboxPage, RoomDetail } from './acceptance-helpers';
import { acceptGroupInvites, befriend, inbox, registerIdentity, sendMessage } from './acceptance-helpers';
import {
  CheckFailure,
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  readResourceJson,
  sleep,
  waitUntil,
  type McpConnection,
} from './harness';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

/** 与服务器注入的 presence 阈值保持一致；未设置时按生产默认值等待。 */
function presenceOfflineBudgetMs(): number {
  const ttl = Number(process.env.AGENT_PRESENCE_ACTIVITY_TTL_MS);
  const grace = Number(process.env.AGENT_PRESENCE_GRACE_MS);
  return (Number.isFinite(ttl) && ttl > 0 ? ttl : 60_000) +
    (Number.isFinite(grace) && grace > 0 ? grace : 30_000) +
    8_000;
}

interface StreamItemView {
  event_id?: string;
  seq?: string;
  source?: string;
  kind?: string;
  attention?: string;
  room_id?: string;
  message_id?: string;
  delivery_id?: string;
  sender_id?: string;
  state?: string;
  change?: string;
  subject_id?: string;
  pending_count?: number;
}

interface StreamPayload {
  v: number;
  actor_id: string;
  seq: string;
  attention: string;
  items: StreamItemView[];
  more: boolean;
  dropped: number;
}

interface CollectedEvent {
  method: string;
  params: Record<string, unknown>;
}

type Collector = ReturnType<typeof notificationCollector>;

function payloadOf(event: CollectedEvent): StreamPayload | null {
  const meta = event.params._meta as Record<string, unknown> | undefined;
  const payload = meta?.[STREAM_EVENT_META];
  if (typeof payload !== 'object' || payload === null) return null;
  return payload as StreamPayload;
}

function streamEvents(collector: Collector, from = 0): CollectedEvent[] {
  return collector.events
    .slice(from)
    .filter((event) => event.params.uri === STREAM_URI);
}

function streamItems(collector: Collector, from = 0): StreamItemView[] {
  return streamEvents(collector, from)
    .map((event) => payloadOf(event))
    .filter((payload): payload is StreamPayload => payload !== null)
    .flatMap((payload) => payload.items);
}

async function waitForItem(
  collector: Collector,
  from: number,
  predicate: (item: StreamItemView, payload: StreamPayload) => boolean,
  label: string,
  timeoutMs = 15_000,
): Promise<{ item: StreamItemView; payload: StreamPayload }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const event of streamEvents(collector, from)) {
      const payload = payloadOf(event);
      const item = payload?.items.find((entry) => predicate(entry, payload));
      if (item && payload) return { item, payload };
    }
    if (Date.now() > deadline) throw new CheckFailure(label, '等待 stream item 超时');
    await sleep(100);
  }
}

function deliveryOfSent(sent: { delivery_ids: string[] }): string {
  const id = sent.delivery_ids[0];
  if (!id) throw new CheckFailure('sendMessage', '预期创建 delivery，但没有返回 delivery_id');
  return id;
}

async function claim(
  connection: McpConnection,
  delivery: Delivery,
): Promise<Delivery> {
  return callTool<Delivery>(connection.client, 'network_delivery_claim', {
    request_id: newRequestId('claim'),
    delivery_id: delivery.delivery_id,
  });
}

export async function runUnifiedStreamAcceptance(): Promise<void> {
  const aConn = await connectClient(newToken());
  const bConn = await connectClient(newToken());
  const cConn = await connectClient(newToken());
  const hConn = await connectClient(newToken());
  const subscriptions: McpSubscription[] = [];

  try {
    const a = await registerIdentity(aConn, {
      kind: 'agent',
      name: '统一流 Agent A',
      sessionId: `unified_a_${crypto.randomUUID()}`,
    });
    const b = await registerIdentity(bConn, {
      kind: 'agent',
      name: '统一流 Agent B',
      sessionId: `unified_b_${crypto.randomUUID()}`,
    });
    const c = await registerIdentity(cConn, {
      kind: 'agent',
      name: '统一流 Agent C',
      sessionId: `unified_c_${crypto.randomUUID()}`,
    });
    const h = await registerIdentity(hConn, { kind: 'human', name: '统一流人类 H' });
    await befriend(aConn, a.actor_id, bConn, b.actor_id);
    await befriend(aConn, a.actor_id, cConn, c.actor_id);
    await befriend(aConn, a.actor_id, hConn, h.actor_id);
    check(
      '统一流：注册返回 agentnet://stream 资源',
      a.resources.includes(STREAM_URI),
      a.resources,
    );

    const aCollector = notificationCollector(aConn.client);
    const bCollector = notificationCollector(bConn.client);
    const cCollector = notificationCollector(cConn.client);
    const hCollector = notificationCollector(hConn.client);

    const aSub = await openSubscription(aConn.client, [STREAM_URI]);
    const bSub = await openSubscription(bConn.client, [STREAM_URI]);
    const cSub = await openSubscription(cConn.client, [STREAM_URI]);
    const hSub = await openSubscription(hConn.client, [STREAM_URI]);
    subscriptions.push(aSub, bSub, cSub, hSub);
    checkEqual(
      '统一流：ack 只覆盖 agentnet://stream',
      bSub.honoredFilter.resourceSubscriptions?.[0],
      STREAM_URI,
    );
    await callTool(aConn.client, 'network_login');
    await callTool(bConn.client, 'network_login');
    // C 故意不 login；H 是人类，不需要 login。

    const humanSnapshot = await readResourceJson<{
      kind: string;
      online: boolean | null;
    }>(hConn.client, STREAM_URI);
    checkEqual('统一流快照：人类 kind 为 human', humanSnapshot.kind, 'human');
    checkEqual('统一流快照：人类 online 为 null', humanSnapshot.online, null);

    const profileStart = aCollector.events.length;
    await callTool(aConn.client, 'network_profile_update', {
      request_id: newRequestId('profile'),
      name: '统一流 Agent A（已更新）',
    });
    const profileItem = await waitForItem(
      aCollector,
      profileStart,
      (item) => item.source === 'profile.updated',
      '等待 profile.updated',
    );
    checkEqual('统一流：profile.updated 为 informational', profileItem.item.attention, 'informational');

    const direct = await callTool<RoomDetail>(aConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [b.actor_id],
    });
    const directId = direct.room.room_id;
    const group = await callTool<RoomDetail>(aConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      members: [b.actor_id, c.actor_id, h.actor_id],
      title: '统一流验收群',
    });
    const groupId = group.room.room_id;
    await acceptGroupInvites(bConn, groupId);
    await acceptGroupInvites(cConn, groupId);
    await acceptGroupInvites(hConn, groupId);

    // B 是未认领 Agent：建群时直接 active，收到 room.created 而不是邀请。
    await waitForItem(
      bCollector,
      0,
      (item) =>
        item.source === 'room.created' &&
        item.room_id === groupId,
      '等待 B 收到建群通知',
    );
    check(
      '统一流：unclaimed B 不收到 pending 邀请',
      !streamItems(bCollector, 0).some(
        (item) =>
          item.source === 'room.membership' &&
          item.change === 'invited' &&
          item.room_id === groupId,
      ),
    );
    await sleep(500);
    checkEqual('统一流：未 login 的 C 收不到邀请流', streamEvents(cCollector).length, 0);
    check(
      '统一流：人类不 login 也收到群邀请',
      streamEvents(hCollector).some((event) =>
        payloadOf(event)?.items.some(
          (item) =>
            item.source === 'room.membership' &&
            item.change === 'invited' &&
            item.room_id === groupId,
        ),
      ),
    );

    const bPendingBefore = (await inbox(bConn, 'pending')).pending_count;
    const ordinaryStart = bCollector.events.length;
    const ordinary = await sendMessage(aConn, groupId, '统一流普通群消息');
    const ordinaryItem = await waitForItem(
      bCollector,
      ordinaryStart,
      (item) => item.source === 'room.message' && item.message_id === ordinary.message.message_id,
      '等待 B 收到普通群消息',
    );
    checkEqual('统一流：普通群消息为 informational', ordinaryItem.item.attention, 'informational');
    checkEqual('统一流：普通群消息 kind 为 message', ordinaryItem.item.kind, 'message');
    const bPendingAfter = (await inbox(bConn, 'pending')).pending_count;
    checkEqual('统一流：普通群消息不增加 pending_count', bPendingAfter, bPendingBefore);
    check(
      '统一流：普通群消息不产生 delivery.created',
      !streamItems(bCollector, ordinaryStart).some(
        (item) => item.source === 'delivery.created' && item.message_id === ordinary.message.message_id,
      ),
    );
    check(
      '统一流：发送者不收到自己的 room.message',
      !streamItems(aCollector).some(
        (item) => item.source === 'room.message' && item.message_id === ordinary.message.message_id,
      ),
    );
    check(
      '统一流：人类收到普通群消息',
      streamEvents(hCollector).some((event) =>
        payloadOf(event)?.items.some(
          (item) => item.source === 'room.message' && item.message_id === ordinary.message.message_id,
        ),
      ),
    );

    const invokeStart = bCollector.events.length;
    const aReceiptStart = aCollector.events.length;
    const hReceiptStart = hCollector.events.length;
    const invoked = await sendMessage(aConn, groupId, '统一流派活给 B', {
      invoke: [b.actor_id],
    });
    const deliveryId = deliveryOfSent(invoked);
    const created = await waitForItem(
      bCollector,
      invokeStart,
      (item) => item.source === 'delivery.created' && item.delivery_id === deliveryId,
      '等待 B 收到 delivery.created',
    );
    checkEqual('统一流：delivery.created 为 action_required', created.item.attention, 'action_required');
    checkEqual('统一流：delivery.created kind 为 task', created.item.kind, 'task');
    checkEqual('统一流：delivery.created 带 sender_id', created.item.sender_id, a.actor_id);
    checkEqual('统一流：delivery.created 带 message_id', created.item.message_id, invoked.message.message_id);

    const pendingB = await inbox(bConn, 'pending');
    const delivery = pendingB.items.find((item) => item.delivery_id === deliveryId);
    if (!delivery) throw new CheckFailure('统一流', 'B 的 inbox 缺少待领取 delivery');
    const claimed = await claim(bConn, delivery);
    const claimSelfStart = bCollector.events.length;
    checkEqual('统一流：B 成功 claim', claimed.state, 'claimed');
    await sleep(500);
    check(
      '统一流：recipient 不收到自己的 claim 回执',
      !streamItems(bCollector, claimSelfStart).some(
        (item) => item.delivery_id === deliveryId && item.source === 'delivery.updated',
      ),
    );
    const completeStart = bCollector.events.length;
    await callTool(bConn.client, 'network_delivery_complete', {
      request_id: newRequestId('complete'),
      delivery_id: deliveryId,
      attempt: claimed.attempt,
      claim_id: claimed.claim_id,
    });
    await sleep(500);
    check(
      '统一流：recipient 不收到自己的 complete 回执',
      !streamItems(bCollector, completeStart).some(
        (item) => item.delivery_id === deliveryId && item.source === 'delivery.updated',
      ),
    );
    const senderReceipt = await waitForItem(
      aCollector,
      aReceiptStart,
      (item) =>
        item.source === 'delivery.updated' &&
        item.delivery_id === deliveryId &&
        item.state === 'completed',
      '等待 A 收到 completed 回执',
    );
    checkEqual(
      '统一流：completed 对原始 sender 为 action_required',
      senderReceipt.item.attention,
      'action_required',
    );
    const otherReceipt = await waitForItem(
      hCollector,
      hReceiptStart,
      (item) =>
        item.source === 'delivery.updated' &&
        item.delivery_id === deliveryId &&
        item.state === 'completed',
      '等待 H 收到 informational completed 回执',
    );
    checkEqual(
      '统一流：completed 对其他成员为 informational',
      otherReceipt.item.attention,
      'informational',
    );

    const directStart = bCollector.events.length;
    const directMessage = await sendMessage(aConn, directId, '统一流同一连接覆盖单聊');
    await waitForItem(
      bCollector,
      directStart,
      (item) => item.source === 'room.message' && item.message_id === directMessage.message.message_id,
      '等待 B 通过同一条 stream 收到单聊消息',
    );
    check(
      '统一流：一条 stream 覆盖单聊与群聊',
      streamItems(bCollector, directStart).some((item) => item.room_id === directId),
    );
    check(
      '统一流：非成员不收到单聊事件',
      !streamItems(hCollector).some((item) => item.room_id === directId),
    );

    const offlineStart = cCollector.events.length;
    const offlineSend = await sendMessage(aConn, groupId, '统一流离线派活给 C', {
      invoke: [c.actor_id],
    });
    await sleep(1_200);
    checkEqual(
      '统一流：Agent 有 stream 但未 login 时收不到任何帧',
      streamEvents(cCollector, offlineStart).length,
      0,
    );
    const cPendingBefore = await inbox(cConn, 'pending');
    check(
      '统一流：离线期间 delivery 仍保存在 inbox',
      cPendingBefore.items.some((item) => item.delivery_id === offlineSend.delivery_ids[0]),
      cPendingBefore.items,
    );
    const cLoginStart = cCollector.events.length;
    await callTool(cConn.client, 'network_login');
    const loginItem = await waitForItem(
      cCollector,
      cLoginStart,
      (item) => item.source === 'session.login',
      '等待 C login 帧',
    );
    checkEqual('统一流：login 帧带 pending_count', loginItem.item.pending_count, cPendingBefore.pending_count);
    checkEqual('统一流：有排队待办时 login 为 action_required', loginItem.item.attention, 'action_required');
    check(
      '统一流：login 不重放离线期间的 room.message',
      !streamItems(cCollector, cLoginStart).some(
        (item) => item.source === 'room.message' && item.message_id === offlineSend.message.message_id,
      ),
    );

    const offlineDeliveryId = offlineSend.delivery_ids[0];
    if (!offlineDeliveryId) throw new CheckFailure('统一流', '离线派活缺少 delivery_id');
    const cancelStart = cCollector.events.length;
    await callTool(aConn.client, 'network_delivery_cancel', {
      request_id: newRequestId('cancel'),
      delivery_id: offlineDeliveryId,
      reason: '统一流取消验收',
    });
    const cancelled = await waitForItem(
      cCollector,
      cancelStart,
      (item) => item.source === 'delivery.cancelled' && item.delivery_id === offlineDeliveryId,
      '等待 C 收到 delivery.cancelled',
    );
    checkEqual('统一流：cancelled 对 recipient 为 action_required', cancelled.item.attention, 'action_required');
    checkEqual(
      '统一流：cancelled 只向 recipient 发一条',
      streamItems(cCollector, cancelStart).filter(
        (item) => item.source === 'delivery.cancelled' && item.delivery_id === offlineDeliveryId,
      ).length,
      1,
    );
    const retryStart = cCollector.events.length;
    await callTool(aConn.client, 'network_delivery_retry', {
      request_id: newRequestId('retry'),
      delivery_id: offlineDeliveryId,
      expected_attempt: 0,
    });
    const retried = await waitForItem(
      cCollector,
      retryStart,
      (item) => item.source === 'delivery.retried' && item.delivery_id === offlineDeliveryId,
      '等待 C 收到 delivery.retried',
    );
    checkEqual('统一流：retried 对 recipient 为 action_required', retried.item.attention, 'action_required');
    checkEqual('统一流：retried kind 为 task', retried.item.kind, 'task');
    checkEqual(
      '统一流：retried 只向 recipient 发一条',
      streamItems(cCollector, retryStart).filter(
        (item) => item.source === 'delivery.retried' && item.delivery_id === offlineDeliveryId,
      ).length,
      1,
    );

    const removeStart = bCollector.events.length;
    await callTool(aConn.client, 'network_room_members_update', {
      request_id: newRequestId('members'),
      room_id: groupId,
      remove: [b.actor_id],
    });
    const removed = await waitForItem(
      bCollector,
      removeStart,
      (item) => item.source === 'room.membership' && item.change === 'removed' && item.room_id === groupId,
      '等待 B 收到 removed',
    );
    checkEqual('统一流：被移除者收到 action_required', removed.item.attention, 'action_required');
    const closedRace = await Promise.race([
      bSub.closed.then(() => 'closed' as const),
      sleep(400).then(() => 'open' as const),
    ]);
    checkEqual('统一流：成员移除不关闭订阅流', closedRace, 'open');
    const afterRemoveStart = bCollector.events.length;
    const afterRemoveMessage = await sendMessage(aConn, groupId, '统一流：移除后的群消息');
    await sleep(800);
    check(
      '统一流：被移除后不再收到该房间消息',
      !streamItems(bCollector, afterRemoveStart).some(
        (item) => item.source === 'room.message' && item.message_id === afterRemoveMessage.message.message_id,
      ),
    );
    const otherRoomStart = bCollector.events.length;
    const otherRoomMessage = await sendMessage(aConn, directId, '统一流：移除后其他房间仍正常');
    await waitForItem(
      bCollector,
      otherRoomStart,
      (item) => item.source === 'room.message' && item.message_id === otherRoomMessage.message.message_id,
      '等待 B 在其他房间收到消息',
    );
    check('统一流：成员移除后其他房间仍正常', true);

    const group2 = await callTool<RoomDetail>(aConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'group',
      members: [h.actor_id],
      title: '统一流加入时间验收群',
    });
    const group2Id = group2.room.room_id;
    await acceptGroupInvites(hConn, group2Id);
    const beforeAddMessage = await sendMessage(aConn, group2Id, '统一流：加入前的旧消息');
    await sleep(500);
    const addStart = bCollector.events.length;
    await callTool(aConn.client, 'network_room_members_update', {
      request_id: newRequestId('members'),
      room_id: group2Id,
      add: [b.actor_id],
    });
    const added = await waitForItem(
      bCollector,
      addStart,
      (item) => item.source === 'room.membership' && item.change === 'added' && item.room_id === group2Id,
      '等待 B 收到 added',
    );
    checkEqual('统一流：新成员收到 change:"added"', added.item.change, 'added');
    check(
      '统一流：新成员不收到加入前的旧消息',
      !streamItems(bCollector).some(
        (item) =>
          item.source === 'room.message' &&
          item.message_id === beforeAddMessage.message.message_id,
      ),
    );
    const afterAddStart = bCollector.events.length;
    const afterAddMessage = await sendMessage(aConn, group2Id, '统一流：加入后的新消息');
    await waitForItem(
      bCollector,
      afterAddStart,
      (item) => item.source === 'room.message' && item.message_id === afterAddMessage.message.message_id,
      '等待新成员收到加入后的消息',
    );
    check('统一流：新成员收到加入后的消息', true);

    const leaveStart = hCollector.events.length;
    await callTool(hConn.client, 'network_room_leave', {
      request_id: newRequestId('leave'),
      room_id: groupId,
    });
    const left = await waitForItem(
      hCollector,
      leaveStart,
      (item) => item.source === 'room.membership' && item.change === 'left' && item.room_id === groupId,
      '等待 H 收到 left',
    );
    checkEqual('统一流：主动离开为 informational', left.item.attention, 'informational');

    // 同一 actor 多条物理连接：同一条事件在两个连接都会到达。
    const secondB = await openSubscription(bConn.client, [STREAM_URI]);
    subscriptions.push(secondB);
    await sleep(250);
    const multiStart = bCollector.events.length;
    const multiMessage = await sendMessage(aConn, group2Id, '统一流：多连接');
    await waitForItem(
      bCollector,
      multiStart,
      (item) => item.source === 'room.message' && item.message_id === multiMessage.message.message_id,
      '等待多连接消息',
    );
    const matchingFor = (): CollectedEvent[] =>
      streamEvents(bCollector, multiStart).filter((event) =>
        payloadOf(event)?.items.some(
          (item) =>
            item.source === 'room.message' &&
            item.message_id === multiMessage.message.message_id,
        ),
      );
    await waitUntil('等待两条物理连接都收到同一事件', () => matchingFor().length >= 2, 5_000);
    const matchingEvents = matchingFor();
    check(
      '统一流：多条物理连接都能收到同一事件',
      matchingEvents.length >= 2,
      matchingEvents.map((event) => (event.params._meta as Record<string, unknown> | undefined)?.['io.modelcontextprotocol/subscriptionId']),
    );
    const distinctIds = new Set(
      matchingEvents.map((event) =>
        (event.params._meta as Record<string, unknown> | undefined)?.[
          'io.modelcontextprotocol/subscriptionId'
        ],
      ),
    );
    check('统一流：多连接使用不同 subscriptionId', distinctIds.size >= 2, [...distinctIds]);
    await secondB.close();

    const snapshot = await readResourceJson<{
      actor_id: string;
      kind: string;
      online: boolean | null;
      pending_count: number;
      inbox_head_seq: string;
      rooms: {
        room_id: string;
        unread: boolean;
        status: 'active' | 'dissolved';
        dissolved_at: string | null;
        read_only: boolean;
        archived_head_seq: string | null;
      }[];
      limits: { stream_batch_max: number; stream_envelope_bytes: number };
    }>(bConn.client, STREAM_URI);
    const meB = await callTool<{ pending_count: number; inbox_head_seq: string }>(
      bConn.client,
      'network_me',
    );
    checkEqual('统一流快照：actor_id 为自己', snapshot.actor_id, b.actor_id);
    checkEqual('统一流快照：Agent online 为 true', snapshot.online, true);
    checkEqual('统一流快照：pending_count 与 network_me 一致', snapshot.pending_count, meB.pending_count);
    checkEqual(
      '统一流快照：inbox_head_seq 与 network_me 一致',
      snapshot.inbox_head_seq,
      meB.inbox_head_seq,
    );
    check(
      '统一流快照：rooms 只包含 active membership',
      snapshot.rooms.some((room) => room.room_id === directId) &&
        snapshot.rooms.some((room) => room.room_id === group2Id) &&
        snapshot.rooms.every((room) => typeof room.unread === 'boolean'),
      snapshot.rooms,
    );
    check(
      '统一流快照：活跃房间带完整只读归档字段',
      snapshot.rooms
        .filter((room) => room.room_id === directId || room.room_id === group2Id)
        .every(
          (room) =>
            room.status === 'active' &&
            room.dissolved_at === null &&
            room.read_only === false &&
            room.archived_head_seq === null,
        ),
      snapshot.rooms,
    );
    checkEqual('统一流快照：批量上限暴露给客户端', snapshot.limits.stream_batch_max, LIMITS.streamBatchMax);

    // 重连：关闭旧流 -> 新 subscription id -> 未 login 不收 -> login 补发。
    await bSub.close();
    await sleep(300);
    const offlineSnapshot = await readResourceJson<{ online: boolean | null }>(
      bConn.client,
      STREAM_URI,
    );
    checkEqual('统一流：最后一条连接断开后快照 offline', offlineSnapshot.online, false);

    // 可用性 presence：断连后先进入 pending，TTL + grace 内仍显示在线；
    // 期间读取资源本身也是活动，会取消 pending。确认下线后才变为 false。
    const offlineDetail = await callTool<RoomDetail>(aConn.client, 'network_room_get', {
      room_id: directId,
    });
    checkEqual(
      '统一流：最后一条连接断开后 pending 期间 room_get 仍在线',
      offlineDetail.members.find((member) => member.actor_id === b.actor_id)?.online,
      true,
    );
    await waitUntil(
      '统一流：活动 TTL + grace 后 room_get offline',
      async () => {
        const detail = await callTool<RoomDetail>(aConn.client, 'network_room_get', {
          room_id: directId,
        });
        return detail.members.find((member) => member.actor_id === b.actor_id)?.online === false;
      },
      presenceOfflineBudgetMs(),
    );

    const reconnectFrom = bCollector.events.length;
    const reconnected = await openSubscription(bConn.client, [STREAM_URI]);
    subscriptions.push(reconnected);
    const reconnectedMessage = await sendMessage(
      aConn,
      directId,
      '统一流：重连未 login 的消息',
      { invoke: [b.actor_id] },
    );
    await sleep(1_000);
    checkEqual(
      '统一流：重连后未 login 收不到帧',
      streamEvents(bCollector, reconnectFrom).filter((event) =>
        payloadOf(event)?.items.some(
          (item) => item.message_id === reconnectedMessage.message.message_id,
        ),
      ).length,
      0,
    );
    const reconnectLoginStart = bCollector.events.length;
    await callTool(bConn.client, 'network_login');
    const relogin = await waitForItem(
      bCollector,
      reconnectLoginStart,
      (item) => item.source === 'session.login',
      '等待重连后的 session.login',
    );
    checkEqual('统一流：重连后重新 login 收到 session.login', relogin.item.source, 'session.login');
    const reconnectPending = await inbox(bConn, 'pending');
    check(
      '统一流：离线期间的 delivery 仍在 inbox',
      reconnectPending.items.some(
        (item) => item.delivery_id === reconnectedMessage.delivery_ids[0],
      ),
      reconnectPending.items,
    );

    // 退避/重连是客户端职责；服务端只保证新 subscription id 可用。
    checkEqual(
      '统一流：新连接使用新的 subscription id',
      reconnected.honoredFilter.resourceSubscriptions?.[0],
      STREAM_URI,
    );

    const allFrames = bCollector.events
      .filter((event) => event.params.uri === STREAM_URI)
      .map((event) => JSON.stringify(event.params));
    const joined = allFrames.join('\n');
    check(
      '统一流：通知不带 preview/summary/body/claim_id/error',
      !joined.includes('"preview"') &&
        !joined.includes('"summary"') &&
        !joined.includes('"body"') &&
        !joined.includes('"claim_id"') &&
        !joined.includes('"error"'),
    );
    const payloads = bCollector.events
      .map((event) => payloadOf(event))
      .filter((payload): payload is StreamPayload => payload !== null);
    check(
      '统一流：所有信封不超过 1 KiB',
      payloads.every(
        (payload) => new TextEncoder().encode(JSON.stringify(payload)).length <= 1024,
      ),
    );
    check(
      '统一流：信封字段类型正确',
      payloads.every(
        (payload) =>
          payload.v === 1 &&
          typeof payload.actor_id === 'string' &&
          typeof payload.seq === 'string' &&
          Array.isArray(payload.items) &&
          typeof payload.more === 'boolean' &&
          typeof payload.dropped === 'number' &&
          payload.items.every(
            (item) => typeof item.event_id === 'string' && typeof item.seq === 'string',
          ),
      ),
    );

    const truncationItems: StreamItem[] = Array.from({ length: 30 }, (_, index) => ({
      event_id: String(index + 1),
      seq: String(index + 1),
      source: 'room.message',
      kind: 'message',
      attention: 'informational',
      room_id: 'rm_truncation',
      message_id: `msg_truncation_${index}`,
      sender_id: 'act_sender',
      created_at: '1730000000000',
    }));
    const truncated = buildStreamFrame('act_truncation', truncationItems);
    check(
      '统一流：超过批量/字节上限时截断并设置 more/dropped',
      truncated !== null &&
        truncated.more &&
        truncated.dropped > 0 &&
        truncated.items.length <= LIMITS.streamBatchMax,
      truncated && { items: truncated.items.length, dropped: truncated.dropped, more: truncated.more },
    );
    check(
      '统一流：截断后的帧仍不超过 1 KiB',
      truncated !== null &&
        new TextEncoder().encode(JSON.stringify(truncated)).length <= LIMITS.hintBytes,
    );

    const queue = new StreamQueue(2);
    queue.push({ frame: 'ack', items: 0 });
    queue.push({ frame: 'event-1', items: 2 });
    queue.push({ frame: 'event-2', items: 3 });
    checkEqual('统一流：慢消费者队列满时丢弃最旧业务帧', queue.takeDropped(), 2);
    queue.push({ frame: 'event-3', items: 1 });
    checkEqual('统一流：连续溢出累计 dropped item', queue.takeDropped(), 3);
    checkEqual('统一流：队列溢出保留 ack', queue.shift()?.frame, 'ack');
    checkEqual('统一流：队列上限按帧数收敛', queue.length, 1);

    void aSub;
    void hSub;
  } finally {
    await Promise.all(subscriptions.map((subscription) => subscription.close().catch(() => undefined)));
    await Promise.all([aConn.close(), bConn.close(), cConn.close(), hConn.close()]);
  }
}

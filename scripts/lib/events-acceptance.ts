/** 可复用的 MCP Events 端到端闭环：订阅 → 消息 → webhook → claim → complete。 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
  rawRpc,
} from './harness';
import {
  registerIdentity,
  sendMessage,
  type Delivery,
  type RoomDetail,
} from './acceptance-helpers';
import {
  verifyWebhookSignature,
  type TestReceiver,
} from './events-harness';

interface SubscribeResult {
  id: string;
  refreshBefore: string;
  cursor: string;
  truncated: boolean;
}

export async function runEventsAcceptance(input: {
  receiver: TestReceiver;
  secret: string;
}): Promise<void> {
  const tokenA = newToken();
  const tokenB = newToken();
  const agentA = await connectClient(tokenA);
  const agentB = await connectClient(tokenB);
  try {
    const a = await registerIdentity(agentA, {
      kind: 'agent',
      name: 'Events 验收 Agent A',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const b = await registerIdentity(agentB, {
      kind: 'agent',
      name: 'Events 验收 Agent B',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const room = await callTool<RoomDetail>(agentA.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [b.actor_id],
    });
    const roomId = room.room.room_id;
    const callbackUrl = input.receiver.url('/callback', `?acceptance=${crypto.randomUUID()}`);

    const subscribe = await rawRpc(
      'events/subscribe',
      {
        name: 'agentnet.message.created',
        arguments: { room_id: roomId, attention: 'action_required' },
        delivery: { mode: 'webhook', url: callbackUrl, secret: input.secret },
        cursor: null,
        ttlMs: 3_600_000,
      },
      { token: tokenB },
    );
    checkEqual('events/subscribe HTTP 200', subscribe.status, 200);
    const subscription = subscribe.body.result as SubscribeResult | undefined;
    check('events/subscribe 返回订阅 id', typeof subscription?.id === 'string', subscribe.body);
    check('events/subscribe 返回有限 refreshBefore', typeof subscription?.refreshBefore === 'string');

    const verification = await input.receiver.waitForRequest(
      (request) => request.isVerification && request.query.includes('acceptance='),
      '等待 MCP Events challenge',
    );
    check('challenge 请求签名合法', verifyWebhookSignature(input.secret, verification));
    checkEqual(
      'challenge 带 X-MCP-Subscription-Id',
      verification.subscriptionId,
      subscription!.id,
    );

    const sent = await sendMessage(agentA, roomId, 'events acceptance body', {
      invoke: [b.actor_id],
    });
    const event = await input.receiver.waitForEvent(
      (request) => request.subscriptionId === subscription!.id,
      '等待 MCP Events webhook',
    );
    checkEqual('事件带 application/json', event.headers.get('content-type'), 'application/json');
    checkEqual('事件 webhook-id 等于 eventId', event.headers.get('webhook-id'), event.eventId);
    check('事件签名合法', verifyWebhookSignature(input.secret, event));

    const occurrence = JSON.parse(event.body) as {
      eventId?: string;
      name?: string;
      timestamp?: string;
      cursor?: string;
      data?: Record<string, unknown>;
    };
    checkEqual('事件名正确', occurrence.name, 'agentnet.message.created');
    checkEqual('事件 payload room_id 正确', occurrence.data?.room_id, roomId);
    checkEqual('事件 payload message_id 正确', occurrence.data?.message_id, sent.message.message_id);
    checkEqual('事件 payload delivery_id 正确', occurrence.data?.delivery_id, sent.delivery_ids[0]);
    checkEqual('事件 payload attention 正确', occurrence.data?.attention, 'action_required');
    checkEqual('事件 cursor 是 event_seq', occurrence.cursor, occurrence.data?.event_seq);
    check('事件 payload 不含正文', !event.body.includes('events acceptance body'), event.body);

    const deliveryId = sent.delivery_ids[0]!;
    const claimed = await callTool<Delivery>(agentB.client, 'network_delivery_claim', {
      request_id: newRequestId('claim'),
      delivery_id: deliveryId,
    });
    checkEqual('webhook 触发的 delivery 可 claim', claimed.state, 'claimed');
    const completed = await callTool<{ delivery: Delivery }>(agentB.client, 'network_delivery_complete', {
      request_id: newRequestId('complete'),
      delivery_id: deliveryId,
      attempt: claimed.attempt,
      claim_id: claimed.claim_id,
      final_body: 'events acceptance done',
    });
    checkEqual('webhook 触发的 delivery 可 complete', completed.delivery.state, 'completed');

    const unsubscribed = await rawRpc(
      'events/unsubscribe',
      {
        name: 'agentnet.message.created',
        arguments: { room_id: roomId, attention: 'action_required' },
        delivery: { mode: 'webhook', url: callbackUrl },
      },
      { token: tokenB },
    );
    checkEqual('events/unsubscribe HTTP 200', unsubscribed.status, 200);
    check('events/unsubscribe 返回空结果', unsubscribed.body.error === undefined, unsubscribed.body);
  } finally {
    await agentA.close();
    await agentB.close();
  }
}

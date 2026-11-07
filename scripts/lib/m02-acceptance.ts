/**
 * M02 验收：发送幂等、并发收敛、通知丢失后的补读与撤权边界。
 *
 * 只使用公开 MCP 工具；T01 用“提交后忽略响应再重试”模拟响应丢失，
 * T02 用 100 个并发请求验证同一意图收敛，T03 在没有订阅的情况下用
 * sync/history 恢复全部消息，T04 验证移除成员后的发送与敏感读取。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  type McpConnection,
} from './harness';
import {
  acceptGroupInvitesWithToken,
  befriend,
  registerIdentity,
  sendMessage,
  type HistoryPage,
  type RoomDetail,
  type SendResult,
} from './acceptance-helpers';

interface SendStatusItem {
  client_message_id: string;
  found: boolean;
  message_id: string | null;
  room_id: string | null;
  created_seq: string | null;
  delivery_ids: string[];
  body_bytes: number | null;
  created_at: string | null;
}

interface SendStatusPage {
  items: SendStatusItem[];
}

interface SyncItem {
  seq: string;
  scope: string;
  type: string;
  ref_id: string | null;
  created_at: string;
}

interface SyncPage {
  scope: string;
  items: SyncItem[];
  next_cursor: string;
  has_more: boolean;
  head_seq: string;
  min_seq: string;
  reset_required: boolean;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

async function roomHead(connection: McpConnection, roomId: string): Promise<bigint> {
  const detail = await callTool<RoomDetail>(connection.client, 'network_room_get', {
    room_id: roomId,
  });
  return BigInt(detail.room.head_seq);
}

async function historyItems(
  connection: McpConnection,
  roomId: string,
  limit = 100,
): Promise<HistoryPage['items']> {
  const page = await callTool<HistoryPage>(connection.client, 'network_history_list', {
    room_id: roomId,
    limit,
  });
  return page.items;
}

function countMatching(items: { preview: string }[], marker: string): number {
  return items.filter((item) => item.preview.includes(marker)).length;
}

async function sendStatus(
  connection: McpConnection,
  clientMessageIds: string[],
): Promise<SendStatusPage> {
  return callTool<SendStatusPage>(connection.client, 'network_message_send_status', {
    client_message_ids: clientMessageIds,
  });
}

export async function runMessageReliabilityAcceptance(): Promise<void> {
  console.log('  · M02 发送幂等、可靠补读与撤权');
  const humanToken = newToken();
  const human = await connectClient(humanToken);
  const agentToken = newToken();
  const agent = await connectClient(agentToken);
  const otherToken = newToken();
  const other = await connectClient(otherToken);
  try {
    const owner = await registerIdentity(human, { kind: 'human', name: 'M02 人类' });
    const sender = await registerIdentity(agent, {
      kind: 'agent',
      name: 'M02 Agent',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const observer = await registerIdentity(other, {
      kind: 'agent',
      name: 'M02 旁观 Agent',
      sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    await befriend(human, owner.actor_id, agent, sender.actor_id);
    await befriend(human, owner.actor_id, other, observer.actor_id);

    const direct = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('m02_room'),
      kind: 'direct',
      members: [sender.actor_id],
    });
    const directId = direct.room.room_id;
    const group = await callTool<RoomDetail>(human.client, 'network_room_create', {
      request_id: newRequestId('m02_room'),
      kind: 'group',
      title: 'M02 可靠性验收群',
      members: [sender.actor_id, observer.actor_id],
    });
    const groupId = group.room.room_id;
    for (const token of [agentToken, otherToken]) {
      await acceptGroupInvitesWithToken(token, groupId);
    }

    // ---------------------------------------------------------------- T01
    const t01Marker = `M02-T01 提交后响应丢失 ${crypto.randomUUID()}`;
    const t01Request = newRequestId('m02_t01');
    const t01ClientMessage = `cm_${crypto.randomUUID()}`;
    const headBeforeT01 = await roomHead(human, directId);
    const first = await sendMessage(human, directId, t01Marker, {
      requestId: t01Request,
      clientMessageId: t01ClientMessage,
      invoke: [sender.actor_id],
    });
    checkEqual('T01 首次提交创建 1 条 delivery', first.delivery_ids.length, 1);
    const headAfterT01 = await roomHead(human, directId);
    // head_seq 使用全局事件序列，只保证推进到消息事件，不保证连续 +1。
    checkEqual('T01 房间顺序推进到消息序号', String(headAfterT01), first.message.created_seq);
    check('T01 首次提交推进房间顺序', headAfterT01 > headBeforeT01, {
      before: String(headBeforeT01),
      after: String(headAfterT01),
    });
    // 模拟“已提交但响应丢失”：客户端没拿到结果，用同一 request_id 重试。
    const sameRequestRetry = await sendMessage(human, directId, t01Marker, {
      requestId: t01Request,
      clientMessageId: t01ClientMessage,
      invoke: [sender.actor_id],
    });
    checkEqual('T01 同 request_id 重试返回同一消息', sameRequestRetry.message.message_id, first.message.message_id);
    checkEqual(
      'T01 同 request_id 重试返回同一 delivery 集',
      sameRequestRetry.delivery_ids.slice().sort().join(','),
      first.delivery_ids.slice().sort().join(','),
    );
    // request_id 也丢失时，持久化的 client_message_id 仍必须收敛到同一结果。
    const newRequestRetry = await sendMessage(human, directId, t01Marker, {
      requestId: newRequestId('m02_t01_retry'),
      clientMessageId: t01ClientMessage,
      invoke: [sender.actor_id],
    });
    checkEqual(
      'T01 仅凭 client_message_id 重试返回同一消息',
      newRequestRetry.message.message_id,
      first.message.message_id,
    );
    checkEqual(
      'T01 仅凭 client_message_id 重试不新增 delivery',
      newRequestRetry.delivery_ids.slice().sort().join(','),
      first.delivery_ids.slice().sort().join(','),
    );
    const statusPage = await sendStatus(human, [t01ClientMessage, `cm_${crypto.randomUUID()}`]);
    const foundStatus = statusPage.items.find((item) => item.client_message_id === t01ClientMessage);
    const missingStatus = statusPage.items.find((item) => item.client_message_id !== t01ClientMessage);
    check('T01 对账返回已提交消息', Boolean(foundStatus && foundStatus.found), foundStatus);
    checkEqual('T01 对账 message_id 与发送结果一致', foundStatus?.message_id, first.message.message_id);
    checkEqual('T01 对账 room_id 一致', foundStatus?.room_id, directId);
    checkEqual(
      'T01 对账 delivery_ids 与发送结果一致',
      foundStatus?.delivery_ids.slice().sort().join(','),
      first.delivery_ids.slice().sort().join(','),
    );
    checkEqual('T01 对账 body_bytes 与正文一致', foundStatus?.body_bytes, utf8Bytes(t01Marker));
    checkEqual('T01 对账的 created_seq 与消息一致', foundStatus?.created_seq, first.message.created_seq);
    check(
      'T01 未提交的 client_message_id 返回 found: false',
      Boolean(missingStatus) && missingStatus!.found === false &&
        missingStatus!.message_id === null && missingStatus!.room_id === null &&
        missingStatus!.delivery_ids.length === 0,
      missingStatus,
    );
    const t01History = await historyItems(human, directId);
    checkEqual('T01 历史中只有一条该消息', countMatching(t01History, t01Marker), 1);
    checkEqual(
      'T01 重试没有再次推进房间顺序',
      String(await roomHead(human, directId)),
      String(headAfterT01),
    );

    // ---------------------------------------------------------------- T02
    const t02Marker = `M02-T02 并发收敛 ${crypto.randomUUID()}`;
    const t02ClientMessage = `cm_${crypto.randomUUID()}`;
    const sharedRequest = newRequestId('m02_t02');
    const headBeforeT02 = await roomHead(human, directId);
    const concurrent = await Promise.allSettled(
      Array.from({ length: 100 }, (_unused, index) =>
        sendMessage(human, directId, t02Marker, {
          requestId: index % 2 === 0 ? sharedRequest : newRequestId('m02_t02_race'),
          clientMessageId: t02ClientMessage,
          invoke: [sender.actor_id],
        }),
      ),
    );
    const rejected = concurrent.filter((item) => item.status === 'rejected');
    check(
      'T02 100 个并发同意图发送全部成功',
      rejected.length === 0,
      rejected.slice(0, 3).map((item) => (item as PromiseRejectedResult).reason?.message),
    );
    const fulfilled = concurrent
      .filter((item): item is PromiseFulfilledResult<SendResult> => item.status === 'fulfilled')
      .map((item) => item.value);
    const messageIds = new Set(fulfilled.map((item) => item.message.message_id));
    const deliverySets = new Set(
      fulfilled.map((item) => item.delivery_ids.slice().sort().join(',')),
    );
    checkEqual('T02 并发结果收敛为一条消息', messageIds.size, 1);
    checkEqual('T02 并发结果收敛为一组 delivery', deliverySets.size, 1);
    checkEqual('T02 并发结果包含全部 100 个响应', fulfilled.length, 100);
    const t02History = await historyItems(human, directId);
    checkEqual('T02 历史中只有一条并发消息', countMatching(t02History, t02Marker), 1);
    const headAfterT02 = await roomHead(human, directId);
    checkEqual(
      'T02 并发结果推进到消息序号',
      String(headAfterT02),
      fulfilled[0]?.message.created_seq,
    );
    check('T02 并发只推进一次房间顺序', headAfterT02 > headBeforeT02, {
      before: String(headBeforeT02),
      after: String(headAfterT02),
    });
    const conflictBody = `${t02Marker} 不同正文`;
    const conflict = await expectToolError(
      'T02 同一 client_message_id 不同正文返回 IDEMPOTENCY_CONFLICT',
      sendMessage(human, directId, conflictBody, {
        requestId: newRequestId('m02_t02_conflict'),
        clientMessageId: t02ClientMessage,
        invoke: [sender.actor_id],
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    checkEqual(
      'T02 冲突返回既有 message_id',
      (conflict.body.details as { message_id?: string } | undefined)?.message_id,
      fulfilled[0]!.message.message_id,
    );
    const t02AfterConflict = await historyItems(human, directId);
    checkEqual('T02 冲突不写入新消息', countMatching(t02AfterConflict, '不同正文'), 0);
    checkEqual(
      'T02 冲突不推进房间顺序',
      String(await roomHead(human, directId)),
      String(headAfterT02),
    );

    // ---------------------------------------------------------------- T03
    // 故意不建立订阅：所有通知视为丢弃，只靠 sync/history 恢复。
    const syncBase = await callTool<SyncPage>(human.client, 'network_sync', {
      scope: `room:${groupId}`,
    });
    const sentIds: string[] = [];
    const sentBodies: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const marker = `M02-T03 补读 ${String(index).padStart(2, '0')} ${crypto.randomUUID()}`;
      const body = `${marker}\n第 ${index} 条`;
      const connection = index % 2 === 0 ? human : agent;
      const result = await sendMessage(connection, groupId, body);
      sentIds.push(result.message.message_id);
      sentBodies.push(marker);
    }
    const syncPages: SyncPage[] = [];
    let syncCursor = syncBase.next_cursor;
    for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
      const page = await callTool<SyncPage>(human.client, 'network_sync', {
        scope: `room:${groupId}`,
        cursor: syncCursor,
        limit: 5,
      });
      syncPages.push(page);
      if (!page.has_more) break;
      check('T03 分页游标必须前进', page.next_cursor !== syncCursor, page.next_cursor);
      syncCursor = page.next_cursor;
    }
    const syncEvents = syncPages
      .flatMap((page) => page.items)
      .filter((item) => item.type === 'message_created');
    checkEqual('T03 sync 恢复全部消息', syncEvents.length, sentIds.length);
    check(
      'T03 sync 消息顺序与发送一致',
      syncEvents.map((item) => item.ref_id).join(',') === sentIds.join(','),
      syncEvents.map((item) => item.ref_id),
    );
    let ascending = true;
    for (let index = 1; index < syncEvents.length; index += 1) {
      if (BigInt(syncEvents[index]!.seq) <= BigInt(syncEvents[index - 1]!.seq)) ascending = false;
    }
    check('T03 sync seq 严格递增', ascending, syncEvents.map((item) => item.seq));
    const replayed = await callTool<SyncPage>(human.client, 'network_sync', {
      scope: `room:${groupId}`,
      cursor: syncBase.next_cursor,
      limit: 50,
    });
    check(
      'T03 同一游标重复读取结果幂等',
      replayed.items
        .filter((item) => item.type === 'message_created')
        .map((item) => item.ref_id)
        .join(',') === sentIds.join(','),
      replayed.items.length,
    );
    // 重复/乱序通知的客户端收敛：反转后再按 message_id 去重、按 seq 排序。
    const merged = new Map<string, SyncItem>();
    for (const item of syncEvents.slice().reverse()) {
      if (item.ref_id && !merged.has(item.ref_id)) merged.set(item.ref_id, item);
    }
    const mergedIds = [...merged.values()]
      .sort((left, right) => (BigInt(left.seq) < BigInt(right.seq) ? -1 : 1))
      .map((item) => item.ref_id);
    check('T03 乱序/重复事件按 seq 收敛到同一顺序', mergedIds.join(',') === sentIds.join(','), mergedIds);
    const history = await historyItems(human, groupId, 100);
    const historyIds = history
      .map((item) => item.message_id)
      .filter((id) => sentIds.includes(id))
      .reverse();
    check('T03 history 补读消息集合一致', historyIds.length === sentIds.length, historyIds.length);
    check(
      'T03 history 与 sync 排序一致',
      historyIds.join(',') === sentIds.join(','),
      historyIds,
    );
    checkEqual(
      'T03 sync head 与房间 head 一致',
      syncPages[syncPages.length - 1]!.head_seq,
      String(await roomHead(human, groupId)),
    );
    check(
      'T03 sync 返回可用 min_seq 且不需要重置',
      BigInt(syncPages[0]!.min_seq) >= 0n && syncPages[0]!.reset_required === false,
      { min_seq: syncPages[0]!.min_seq, reset_required: syncPages[0]!.reset_required },
    );

    // ---------------------------------------------------------------- T04
    const t04Marker = `M02-T04 撤权前消息 ${crypto.randomUUID()}`;
    const t04Request = newRequestId('m02_t04');
    const t04ClientMessage = `cm_${crypto.randomUUID()}`;
    const t04First = await sendMessage(agent, groupId, t04Marker, {
      requestId: t04Request,
      clientMessageId: t04ClientMessage,
    });
    const senderStatus = await sendStatus(agent, [t04ClientMessage]);
    check('T04 撤权前发送者可对账', senderStatus.items[0]?.found === true, senderStatus.items[0]);
    await callTool(human.client, 'network_room_members_update', {
      request_id: newRequestId('m02_t04_remove'),
      room_id: groupId,
      remove: [sender.actor_id],
    });
    // 移除成员本身是房间事件；撤权后的发送/重放才必须保持 head 不变。
    const headAfterRemoval = await roomHead(human, groupId);
    await expectToolError(
      'T04 移除后新的发送被拒绝',
      sendMessage(agent, groupId, 'M02-T04 越权发送'),
      'NOT_MEMBER',
    );
    checkEqual(
      'T04 越权发送不推进房间顺序',
      String(await roomHead(human, groupId)),
      String(headAfterRemoval),
    );
    await expectToolError(
      'T04 移除后同一业务请求的重放被拒绝',
      sendMessage(agent, groupId, t04Marker, {
        requestId: t04Request,
        clientMessageId: t04ClientMessage,
      }),
      'NOT_MEMBER',
    );
    const t04History = await historyItems(human, groupId, 100);
    checkEqual('T04 撤权后历史仍只有一条原消息', countMatching(t04History, t04Marker), 1);
    const t04Message = t04History.find((item) => item.message_id === t04First.message.message_id);
    checkEqual('T04 失败重放没有生成第二条消息', Boolean(t04Message), true);
    await expectToolError(
      'T04 移除后禁止敏感正文读取',
      callTool(agent.client, 'network_message_read', { message_id: t04First.message.message_id }),
      'NOT_MEMBER',
    );
    await expectToolError(
      'T04 移除后禁止读取房间历史',
      callTool(agent.client, 'network_history_list', { room_id: groupId, limit: 10 }),
      'NOT_MEMBER',
    );
    const locatorStatus = await sendStatus(agent, [t04ClientMessage]);
    const locator = locatorStatus.items[0];
    check('T04 撤权后仍可对账定位信息', locator?.found === true, locator);
    checkEqual('T04 对账定位到原消息', locator?.message_id, t04First.message.message_id);
    check(
      'T04 对账不返回正文或 preview',
      Boolean(locator) &&
        !Object.prototype.hasOwnProperty.call(locator, 'preview') &&
        !Object.prototype.hasOwnProperty.call(locator, 'body'),
      locator,
    );
    // 未订阅的旁观者读取自己的私密资源仍按原授权工作（对照：不是全局失效）。
    const observerInbox = await callTool<{ items: unknown[] }>(other.client, 'network_inbox_list', {
      state: 'all',
    });
    check('T04 旁观者仍可读取自己的收件箱', Array.isArray(observerInbox.items), observerInbox.items.length);
  } finally {
    await Promise.all([human.close(), agent.close(), other.close()]);
  }
}

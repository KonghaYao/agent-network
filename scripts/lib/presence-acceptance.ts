/**
 * Agent 上下线时间线的端到端验收。
 *
 * 需要被测服务使用较短的 `AGENT_PRESENCE_GRACE_MS`（本地验收默认注入）；
 * 未设置时按生产 30s 宽限等待。所有断言只通过 MCP 工具读取 SQLite 结果。
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
  openRawListen,
  openSubscription,
  sleep,
  waitUntil,
  type McpConnection,
  type RawListen,
} from './harness';
import { befriend, registerIdentity, sendMessage, type Identity } from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_META = 'io.agent-network/event';

interface PresenceItem {
  kind: 'presence';
  presence_event_id: string;
  room_id: string;
  agent_id: string;
  transition: 'online' | 'offline';
  occurred_at: string;
  recorded_at: string;
  timeline_seq: string;
  time_basis: 'observed' | 'inferred';
}

interface TimelineMessage {
  kind: 'message';
  message_id: string;
  sender_id: string;
  created_seq: string;
  created_at: string;
  preview: string;
}

type TimelineItem = PresenceItem | TimelineMessage;

interface TimelinePage {
  view?: 'timeline';
  timeline_items?: TimelineItem[];
  timeline_next_cursor?: string | null;
  timeline_has_more?: boolean;
  timeline_snapshot?: string;
  timeline_resume_cursor?: string;
  items?: TimelineMessage[];
  next_cursor?: string | null;
  has_more?: boolean;
  snapshot?: string;
  head_seq?: string;
}

interface RoomGet {
  room: {
    room_id: string;
    head_seq: string;
    my_last_read_seq: string;
    last_message: { message_id: string; preview: string } | null;
  };
  members: { actor_id: string; kind: string; online: boolean | null; last_read_seq: string }[];
}

interface Me {
  pending_count: number;
  inbox_head_seq: string;
}

function graceMs(): number {
  const value = Number(process.env.AGENT_PRESENCE_GRACE_MS);
  return Number.isFinite(value) && value > 0 ? value : 30_000;
}

function activityTtlMs(): number {
  const value = Number(process.env.AGENT_PRESENCE_ACTIVITY_TTL_MS);
  return Number.isFinite(value) && value > 0 ? value : 60_000;
}

/** 可用性过期 + grace 的最坏等待；本地验收注入短 TTL。 */
function offlineBudgetMs(): number {
  return activityTtlMs() + graceMs() + 8_000;
}

async function timeline(
  connection: McpConnection,
  roomId: string,
  args: Record<string, unknown> = {},
): Promise<TimelinePage> {
  return callTool<TimelinePage>(connection.client, 'network_history_list', {
    room_id: roomId,
    view: 'timeline',
    ...args,
  });
}

function presenceItems(page: TimelinePage): PresenceItem[] {
  return (page.timeline_items ?? []).filter(
    (item): item is PresenceItem => item.kind === 'presence',
  );
}

function itemKey(item: TimelineItem): string {
  return item.kind === 'presence' ? `presence:${item.presence_event_id}` : `message:${item.message_id}`;
}

function itemOrder(item: TimelineItem): { at: number; commit: number } {
  return item.kind === 'presence'
    ? { at: Number(item.occurred_at), commit: Number(item.timeline_seq) }
    : { at: Number(item.created_at), commit: Number(item.created_seq) };
}

async function waitForPresence(
  connection: McpConnection,
  roomId: string,
  label: string,
  predicate: (items: PresenceItem[]) => boolean,
  timeoutMs = graceMs() + 8_000,
): Promise<PresenceItem[]> {
  let latest: PresenceItem[] = [];
  await waitUntil(
    label,
    async () => {
      latest = presenceItems(await timeline(connection, roomId, { limit: 100 }));
      return predicate(latest);
    },
    timeoutMs,
  );
  return latest;
}

async function agentOnline(
  human: McpConnection,
  roomId: string,
  agentId: string,
): Promise<boolean | null> {
  const detail = await callTool<RoomGet>(human.client, 'network_room_get', { room_id: roomId });
  return detail.members.find((member) => member.actor_id === agentId)?.online ?? null;
}

async function login(connection: McpConnection): Promise<void> {
  await callTool(connection.client, 'network_login', {});
}

function streamItemsOf(event: { params: Record<string, unknown> }): Record<string, unknown>[] {
  const meta = event.params._meta as Record<string, unknown> | undefined;
  const payload = meta?.[STREAM_META] as { items?: Record<string, unknown>[] } | undefined;
  return payload?.items ?? [];
}

interface AgentSession {
  connection: McpConnection;
  listen: RawListen;
  close(): Promise<void>;
}

/** 每个 Agent stream 使用独立 subscription id；同一 actor 不能复用 id。 */
async function openAgent(token: string): Promise<AgentSession> {
  const connection = await connectClient(token);
  const listen = await openRawListen(token, `sub_${crypto.randomUUID()}`, [STREAM_URI]);
  return {
    connection,
    listen,
    async close() {
      await listen.close().catch(() => undefined);
      await connection.close();
    },
  };
}

export async function runAgentPresenceAcceptance(): Promise<void> {
  console.log(`  Agent 上下线时间线（grace ${graceMs()}ms）`);
  const human = await connectClient(newToken());
  const otherHuman = await connectClient(newToken());
  let agentA: McpConnection | null = null;
  let agentB: McpConnection | null = null;
  const extra: AgentSession[] = [];
  try {
    const humanIdentity = await registerIdentity(human, { kind: 'human', name: 'Presence Human' });
    const otherHumanIdentity = await registerIdentity(otherHuman, {
      kind: 'human',
      name: 'Presence Human 2',
    });
    const a = await callTool<Identity & { token: string; agent_session_id: string }>(
      human.client,
      'network_agent_create',
      { request_id: newRequestId('presence_create'), name: 'Presence Agent A' },
    );
    const agentAToken = a.token;
    const b = await callTool<Identity & { token: string; agent_session_id: string }>(
      human.client,
      'network_agent_create',
      { request_id: newRequestId('presence_create'), name: 'Presence Agent B' },
    );
    const agentBToken = b.token;
    await befriend(human, humanIdentity.actor_id, otherHuman, otherHumanIdentity.actor_id);

    const createRoom = async (
      connection: McpConnection,
      kind: 'direct' | 'group',
      members: string[],
      title?: string,
    ): Promise<string> => {
      const detail = await callTool<{ room: { room_id: string } }>(
        connection.client,
        'network_room_create',
        {
          request_id: newRequestId('presence_room'),
          kind,
          members,
          ...(title ? { title } : {}),
        },
      );
      return detail.room.room_id;
    };

    // 与管理者的自有 Agent 建 direct 会同时建立双向关系，之后才能拉群。
    const direct = await createRoom(human, 'direct', [a.actor_id]);
    const directB = await createRoom(human, 'direct', [b.actor_id]);
    const group = await createRoom(human, 'group', [a.actor_id, b.actor_id], 'Presence Group');
    const humanPair = await createRoom(human, 'direct', [otherHumanIdentity.actor_id]);
    const beforeMessage = await sendMessage(human, direct, 'presence before login');

    const humanEvents = notificationCollector(human.client);
    await openSubscription(human.client, [STREAM_URI]);
    // Agent 连接建立时的首个认证请求同样算活动：房间先就绪，才能把上线写入
    // 对应 direct 时间线；这里不提前连接，避免上线发生在人类订阅之前。
    const aConn = await connectClient(a.token);
    agentA = aConn;
    const bConn = await connectClient(b.token);
    agentB = bConn;
    const agentASession = await openAgent(agentAToken);
    extra.push(agentASession);

    await login(agentASession.connection);
    const online = await waitForPresence(
      human,
      direct,
      '等待首次上线时间线',
      (items) => items.filter((item) => item.transition === 'online').length === 1,
    );
    const firstOnline = online.find((item) => item.transition === 'online') as PresenceItem;
    checkEqual('上线记录 transition', firstOnline.transition, 'online');
    checkEqual('上线记录 agent_id', firstOnline.agent_id, a.actor_id);
    checkEqual('上线记录 time_basis 为 observed', firstOnline.time_basis, 'observed');

    checkEqual('群聊不记录上下线', presenceItems(await timeline(human, group)).length, 0);
    checkEqual(
      'human↔human direct 不记录上下线',
      presenceItems(await timeline(human, humanPair)).length,
      0,
    );
    const agentHistory = await callTool<{ items: Record<string, unknown>[] }>(
      aConn.client,
      'network_history_list',
      { room_id: direct, limit: 100 },
    );
    check(
      'Agent 默认 history 不含 presence',
      agentHistory.items.every((item) => item.kind !== 'presence' && !('presence_event_id' in item)),
      agentHistory.items,
    );
    check(
      'Agent 默认 history 仍返回真实消息',
      agentHistory.items.some((item) => item.message_id === beforeMessage.message.message_id),
      agentHistory.items,
    );
    await expectToolError(
      'Agent 显式 timeline 被拒绝',
      callTool(aConn.client, 'network_history_list', {
        room_id: direct,
        view: 'timeline',
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      '非成员不能读取 timeline',
      timeline(bConn, direct),
      'NOT_MEMBER',
    );
    await expectToolError(
      'presence 不能按普通消息读正文',
      callTool(human.client, 'network_message_read', {
        message_id: firstOnline.presence_event_id,
      }),
      'NOT_FOUND',
    );

    const onlineNotification = await humanEvents.waitFor(
      (event) =>
        streamItemsOf(event).some(
          (item) => item.source === 'room.presence' && item.room_id === direct,
        ),
      '等待 human 收到上下线通知',
    );
    const notice = streamItemsOf(onlineNotification).find(
      (item) => item.source === 'room.presence' && item.room_id === direct,
    ) as Record<string, unknown>;
    checkEqual('上下线通知 source', notice.source, 'room.presence');
    checkEqual('上下线通知 kind', notice.kind, 'presence');
    checkEqual('上下线通知 attention', notice.attention, 'informational');
    checkEqual('上下线通知 transition', notice.transition, 'online');
    check(
      'Agent 不收到自己的上下线通知',
      !agentASession.listen.text().includes('room.presence'),
      agentASession.listen.text(),
    );

    const sync = await callTool<{ items: { type: string }[] }>(human.client, 'network_sync', {
      scope: `room:${direct}`,
      limit: 200,
    });
    check(
      'network_sync 在 SQL 层过滤 presence',
      sync.items.every((item) => item.type !== 'agent_presence_changed'),
      sync.items,
    );

    const roomBefore = await callTool<RoomGet>(human.client, 'network_room_get', { room_id: direct });
    await callTool(human.client, 'network_room_mark_read', {
      room_id: direct,
      through_seq: roomBefore.room.head_seq,
    });
    const roomRead = await callTool<RoomGet>(human.client, 'network_room_get', { room_id: direct });
    // 标记已读会推进账号事件水位，之后的在线变化仍不得推进该水位。
    const meRead = await callTool<Me>(human.client, 'network_me', {});
    const readState = {
      head: roomRead.room.head_seq,
      lastMessage: roomRead.room.last_message?.message_id ?? null,
      lastRead: roomRead.room.my_last_read_seq,
      pending: meRead.pending_count,
      inboxHead: meRead.inbox_head_seq,
    };

    // 重复 login、第二条连接、关闭非最后连接都不产生新行。
    await login(agentASession.connection);
    const second = await openAgent(agentAToken);
    extra.push(second);
    await login(second.connection);
    await sleep(200);
    checkEqual(
      '重复 login/第二连接不重复上线',
      presenceItems(await timeline(human, direct, { limit: 100 })).filter(
        (item) => item.transition === 'online',
      ).length,
      1,
    );
    await second.close();
    await sleep(Math.max(200, Math.floor(graceMs() / 2)));
    checkEqual(
      '关闭非最后连接不写离线',
      presenceItems(await timeline(human, direct, { limit: 100 })).filter(
        (item) => item.transition === 'offline',
      ).length,
      0,
    );
    checkEqual('关闭非最后连接后仍在线', await agentOnline(human, direct, a.actor_id), true);

    // 最后连接断开：活动窗口内仍算在线；TTL + grace 后才确认下线。
    const lastAgentActivity = Date.now();
    await agentASession.close();
    await sleep(300);
    checkEqual(
      '最后连接断开后 pending 期间仍显示在线',
      await agentOnline(human, direct, a.actor_id),
      true,
    );
    await sleep(Math.max(200, Math.floor(graceMs() / 2)));
    checkEqual(
      'grace 前不写下线',
      presenceItems(await timeline(human, direct, { limit: 100 })).filter(
        (item) => item.transition === 'offline',
      ).length,
      0,
    );

    // grace 内有效重连：不新增上线/下线，保留原上线记录。
    const reconnect = await openAgent(agentAToken);
    extra.push(reconnect);
    await login(reconnect.connection);
    await sleep(200);
    const resumed = await timeline(human, direct, { limit: 100 });
    checkEqual(
      'grace 内重连无新增上线',
      presenceItems(resumed).filter((item) => item.transition === 'online').length,
      1,
    );
    checkEqual(
      'grace 内重连无新增下线',
      presenceItems(resumed).filter((item) => item.transition === 'offline').length,
      0,
    );
    checkEqual(
      'grace 内重连保留原上线事件',
      presenceItems(resumed).find((item) => item.transition === 'online')?.presence_event_id,
      firstOnline.presence_event_id,
    );
    const resumeCursor = resumed.timeline_resume_cursor as string;

    // TTL + grace 到期：一条下线，时间为“最后活动 + TTL”或断连时刻的较大者。
    const closeAt = Date.now();
    await reconnect.close();
    const offlineItems = await waitForPresence(
      human,
      direct,
      '等待 TTL/grace 到期下线',
      (items) => items.filter((item) => item.transition === 'offline').length === 1,
      offlineBudgetMs(),
    );
    const firstOffline = offlineItems.find((item) => item.transition === 'offline') as PresenceItem;
    check(
      '下线 occurred_at 落在断连时刻与 最后活动+TTL 之间',
      Number(firstOffline.occurred_at) >= closeAt - 1_000 &&
        Number(firstOffline.occurred_at) <= closeAt + activityTtlMs() + 3_000,
      {
        occurred_at: firstOffline.occurred_at,
        closeAt,
        ttl: activityTtlMs(),
        lastAgentActivity,
      },
    );
    checkEqual('确认下线 time_basis 为 inferred', firstOffline.time_basis, 'inferred');

    const latePage = await timeline(human, direct, {
      direction: 'after',
      cursor: resumeCursor,
      limit: 100,
    });
    check(
      '迟到下线可通过 after 补读',
      (latePage.timeline_items ?? []).some(
        (item) => item.kind === 'presence' && item.presence_event_id === firstOffline.presence_event_id,
      ),
      latePage.timeline_items,
    );

    const roomAfter = await callTool<RoomGet>(human.client, 'network_room_get', { room_id: direct });
    const meAfter = await callTool<Me>(human.client, 'network_me', {});
    checkEqual('presence 不改变 head_seq', roomAfter.room.head_seq, readState.head);
    checkEqual(
      'presence 不改变 last_message',
      roomAfter.room.last_message?.message_id ?? null,
      readState.lastMessage,
    );
    checkEqual('presence 不改变 last_read_seq', roomAfter.room.my_last_read_seq, readState.lastRead);
    checkEqual('presence 不改变 pending_count', meAfter.pending_count, readState.pending);
    checkEqual('presence 不改变 inbox head', meAfter.inbox_head_seq, readState.inboxHead);

    // 离线后第一个请求（无 SSE）：先写新上线，再执行业务；room_get 同步在线。
    checkEqual('确认下线后 room_get 离线', await agentOnline(human, direct, a.actor_id), false);
    await callTool(aConn.client, 'network_me', {});
    await waitForPresence(
      human,
      direct,
      '离线后请求恢复上线',
      (items) => items.filter((item) => item.transition === 'online').length === 2,
      offlineBudgetMs(),
    );
    checkEqual('请求恢复上线后 room_get 在线', await agentOnline(human, direct, a.actor_id), true);
    const idleReply = await sendMessage(aConn, direct, 'presence after idle reply');
    const afterReconnect = presenceItems(await timeline(human, direct, { limit: 100 }));
    const latestOnline = afterReconnect
      .filter((item) => item.transition === 'online')
      .sort((left, right) => Number(left.timeline_seq) - Number(right.timeline_seq))
      .at(-1);
    const latestOffline = afterReconnect
      .filter((item) => item.transition === 'offline')
      .sort((left, right) => Number(left.timeline_seq) - Number(right.timeline_seq))
      .at(-1);
    check(
      '离线后首个请求先于回复产生新上线',
      Number(latestOnline?.timeline_seq) > Number(latestOffline?.timeline_seq) &&
        Number(latestOnline?.timeline_seq) < Number(idleReply.message.created_seq),
      {
        online: latestOnline?.timeline_seq,
        offline: latestOffline?.timeline_seq,
        reply: idleReply.message.created_seq,
      },
    );

    // 无 SSE、只靠轮询：TTL 内的重复请求保持在线；停止后按最后活动 + TTL 下线。
    for (let round = 0; round < 2; round += 1) {
      await sleep(Math.ceil(activityTtlMs() / 2));
      await callTool(aConn.client, 'network_me', {});
    }
    await sleep(Math.ceil(activityTtlMs() / 2));
    checkEqual(
      '无 SSE 轮询期间不产生下线',
      presenceItems(await timeline(human, direct, { limit: 100 })).filter(
        (item) => item.transition === 'offline',
      ).length,
      1,
    );
    checkEqual('无 SSE 轮询期间 room_get 在线', await agentOnline(human, direct, a.actor_id), true);
    const lastPollAt = Date.now();
    const polledOfflineItems = await waitForPresence(
      human,
      direct,
      '停止轮询后按活动 TTL 下线',
      (items) => items.filter((item) => item.transition === 'offline').length === 2,
      offlineBudgetMs(),
    );
    const polledOffline = polledOfflineItems
      .filter((item) => item.transition === 'offline')
      .sort((left, right) => Number(left.timeline_seq) - Number(right.timeline_seq))
      .at(-1) as PresenceItem;
    check(
      '停止轮询后的下线时间为最后活动 + TTL',
      Number(polledOffline.occurred_at) >= lastPollAt - 1_000 &&
        Number(polledOffline.occurred_at) <= lastPollAt + activityTtlMs() + 3_000,
      { occurred_at: polledOffline.occurred_at, lastPollAt, ttl: activityTtlMs() },
    );
    checkEqual('停止轮询下线 basis 为 inferred', polledOffline.time_basis, 'inferred');
    checkEqual('停止轮询后 room_get 离线', await agentOnline(human, direct, a.actor_id), false);

    // 分页：limit=1、同毫秒排序、snapshot 中途新增、cursor 混用。
    await sendMessage(human, direct, 'presence page 1');
    await sendMessage(human, direct, 'presence page 2');
    const full = await timeline(human, direct, { direction: 'before', limit: 100 });
    const fullItems = full.timeline_items ?? [];
    check('时间线同时包含消息与上下线', fullItems.some((item) => item.kind === 'message') && fullItems.some((item) => item.kind === 'presence'));
    for (let index = 1; index < fullItems.length; index += 1) {
      const previous = itemOrder(fullItems[index - 1] as TimelineItem);
      const current = itemOrder(fullItems[index] as TimelineItem);
      check(
        `时间线展示顺序稳定 #${index}`,
        previous.at > current.at || (previous.at === current.at && previous.commit > current.commit),
        { previous, current },
      );
    }

    const collected: TimelineItem[] = [];
    let olderCursor: string | null = null;
    for (let page = 0; page < 50; page += 1) {
      const current = await timeline(human, direct, {
        direction: 'before',
        limit: 1,
        ...(olderCursor ? { cursor: olderCursor } : {}),
      });
      collected.push(...(current.timeline_items ?? []));
      if (!current.timeline_has_more) break;
      olderCursor = current.timeline_next_cursor ?? null;
    }
    checkEqual('limit=1 逐页数量等于全量', collected.length, fullItems.length);
    checkEqual(
      'limit=1 逐页无重复',
      new Set(collected.map(itemKey)).size,
      collected.length,
    );

    const firstPage = await timeline(human, direct, { direction: 'before', limit: 1 });
    const snapshot = firstPage.timeline_snapshot as string;
    const snapshotResume = firstPage.timeline_resume_cursor as string;
    const snapshotNew = await sendMessage(human, direct, 'presence snapshot new');
    const olderIds = new Set<string>();
    let olderNext: string | null = firstPage.timeline_next_cursor ?? null;
    for (let page = 0; page < 50 && olderNext; page += 1) {
      const current = await timeline(human, direct, {
        direction: 'before',
        limit: 1,
        cursor: olderNext,
      });
      for (const item of current.timeline_items ?? []) olderIds.add(itemKey(item));
      olderNext = current.timeline_has_more ? current.timeline_next_cursor ?? null : null;
      checkEqual(`snapshot 固定在第 ${page + 1} 页`, current.timeline_snapshot, snapshot);
    }
    check(
      'snapshot 中途新增不进入旧页',
      !olderIds.has(`message:${snapshotNew.message.message_id}`),
      [...olderIds],
    );
    const afterSnapshot = await timeline(human, direct, {
      direction: 'after',
      cursor: snapshotResume,
      limit: 100,
    });
    check(
      'after 可补读 snapshot 后新增消息',
      (afterSnapshot.timeline_items ?? []).some(
        (item) => item.kind === 'message' && item.message_id === snapshotNew.message.message_id,
      ),
      afterSnapshot.timeline_items,
    );

    const messageCursorPage = await callTool<{ next_cursor: string | null }>(
      human.client,
      'network_history_list',
      { room_id: direct, direction: 'before', limit: 1 },
    );
    await expectToolError(
      'messages cursor 不能用于 timeline',
      timeline(human, direct, {
        cursor: messageCursorPage.next_cursor as string,
        limit: 1,
      }),
      'INVALID_ARGUMENT',
    );
    const timelineCursorPage = await timeline(human, direct, {
      direction: 'before',
      limit: 1,
    });
    await expectToolError(
      'timeline cursor 不能用于 messages',
      callTool(human.client, 'network_history_list', {
        room_id: direct,
        direction: 'before',
        limit: 1,
        cursor: timelineCursorPage.timeline_next_cursor as string,
      }),
      'INVALID_ARGUMENT',
    );

    // 无普通消息的房间仍能显示上下线；B 的 direct 只记录 human-agent。
    const bConnection = await openAgent(agentBToken);
    extra.push(bConnection);
    await login(bConnection.connection);
    await waitForPresence(
      human,
      directB,
      '无消息房间写入上线',
      (items) => items.some((item) => item.transition === 'online'),
    );
    const emptyTimeline = await timeline(human, directB, { limit: 100 });
    check(
      '无普通消息房间只有 presence',
      (emptyTimeline.timeline_items ?? []).every((item) => item.kind === 'presence'),
      emptyTimeline.timeline_items,
    );
  } finally {
    await Promise.all([
      human.close(),
      otherHuman.close(),
      agentA?.close(),
      agentB?.close(),
      ...extra.map((connection) => connection.close()),
    ]);
  }
}

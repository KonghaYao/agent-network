/**
 * 消息式 Task / Trace 的 MCP 层端到端验收（阶段 2）。
 *
 * 覆盖设计稿场景 1–11、13、14：任意发送者起点、两个 Agent 同时接取、
 * 参与者去重、引用来源与跨 Task 引用、交错任务、按起点聚合搜索、焦点定位、
 * 权限/撤回、取消标记与重试幂等。场景 12（长 Trace 的网页滚动/草稿）留给
 * 阶段 3 的浏览器验收；这里验证其依赖的分页游标契约。
 *
 * 只通过公开 MCP 工具调用；不读取服务端数据库。所有读取工具都检查重复调用
 * 结果一致，并在标记前后核对 head/已读位置不推进。
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
  acceptGroupInvites,
  befriend,
  inbox,
  readWholeMessage,
  registerIdentity,
  sendMessage,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

const RUN = crypto.randomUUID().replaceAll('-', '').slice(0, 10);

interface TaskParticipantView {
  actor_id: string;
  name: string;
  kind: 'agent';
  first_seq: string;
}

interface TaskSummaryView {
  root_message_id: string;
  room_id: string;
  preview: string;
  root_sender_id: string;
  root_sender_kind: 'human' | 'agent' | null;
  participants: TaskParticipantView[];
  participant_count: number;
  message_count: number;
  can_unmark: boolean;
}

interface TaskSummariesResult {
  items: TaskSummaryView[];
}

interface TaskTraceItemView {
  message_id: string;
  role: 'root' | 'member' | 'reference';
  recalled: boolean;
  preview: string;
  referenced_by: string | null;
}

interface TaskTraceResult {
  root_message_id: string;
  items: TaskTraceItemView[];
  next_cursor: string | null;
  prev_cursor: string | null;
  has_more_before: boolean;
  has_more_after: boolean;
  message_count: number;
  focus_message_id: string | null;
}

interface TaskSearchItemView {
  task: TaskSummaryView;
  hit_count: number;
  matches: { message_id: string; snippet: string; created_seq: string }[];
}

interface TaskSearchResult {
  items: TaskSearchItemView[];
  next_cursor: string | null;
  has_more: boolean;
  truncated: boolean;
}

interface MarkResult {
  room_id: string;
  message_id: string;
  task_root_id: string;
  marked: boolean;
}

interface UnmarkResult {
  room_id: string;
  message_id: string;
  task_root_id: null;
  marked: boolean;
}

interface SyncPage {
  items: { type: string }[];
  next_cursor: string;
  has_more: boolean;
}

async function mark(
  connection: McpConnection,
  roomId: string,
  messageId: string,
  requestId = newRequestId('mt_mark'),
): Promise<MarkResult> {
  return callTool<MarkResult>(connection.client, 'network_task_mark', {
    request_id: requestId,
    room_id: roomId,
    message_id: messageId,
  });
}

async function unmark(
  connection: McpConnection,
  roomId: string,
  messageId: string,
  requestId = newRequestId('mt_unmark'),
): Promise<UnmarkResult> {
  return callTool<UnmarkResult>(connection.client, 'network_task_unmark', {
    request_id: requestId,
    room_id: roomId,
    message_id: messageId,
  });
}

async function summaries(
  connection: McpConnection,
  roomId: string,
  roots: string[],
): Promise<TaskSummariesResult> {
  return callTool<TaskSummariesResult>(connection.client, 'network_task_summaries', {
    room_id: roomId,
    root_message_ids: roots,
  });
}

async function summaryOf(
  connection: McpConnection,
  roomId: string,
  rootId: string,
): Promise<TaskSummaryView | null> {
  const result = await summaries(connection, roomId, [rootId]);
  return result.items.find((item) => item.root_message_id === rootId) ?? null;
}

async function trace(
  connection: McpConnection,
  roomId: string,
  rootId: string,
  options: { cursor?: string; focus?: string; limit?: number } = {},
): Promise<TaskTraceResult> {
  return callTool<TaskTraceResult>(connection.client, 'network_task_trace', {
    room_id: roomId,
    root_message_id: rootId,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.focus ? { focus_message_id: options.focus } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

async function taskSearch(
  connection: McpConnection,
  roomId: string,
  query: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<TaskSearchResult> {
  return callTool<TaskSearchResult>(connection.client, 'network_task_search', {
    room_id: roomId,
    query,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

async function expectCode(label: string, promise: Promise<unknown>, code: string): Promise<void> {
  await expectToolError(label, promise, code);
}

async function syncAll(
  connection: McpConnection,
  roomId: string,
  cursor?: string,
): Promise<{ types: string[]; cursor: string }> {
  const types: string[] = [];
  let next = cursor;
  for (let page = 0; page < 10; page += 1) {
    const result = await callTool<SyncPage>(connection.client, 'network_sync', {
      scope: `room:${roomId}`,
      ...(next ? { cursor: next } : {}),
      limit: 200,
    });
    types.push(...result.items.map((item) => item.type));
    next = result.next_cursor;
    if (!result.has_more) break;
  }
  return { types, cursor: next ?? '' };
}

export async function runMessageTaskAcceptance(): Promise<void> {
  console.log('· 消息式 Task / Trace（阶段 2）');
  const hConn = await connectClient(newToken());
  const a1Conn = await connectClient(newToken());
  const a2Conn = await connectClient(newToken());
  const a3Conn = await connectClient(newToken());
  const a4Conn = await connectClient(newToken());

  try {
    const h = await registerIdentity(hConn, { kind: 'human', name: `MT 人类 ${RUN}` });
    const a1 = await registerIdentity(a1Conn, {
      kind: 'agent',
      name: `MT Agent 一 ${RUN}`,
      sessionId: `mt_a1_${crypto.randomUUID()}`,
    });
    const a2 = await registerIdentity(a2Conn, {
      kind: 'agent',
      name: `MT Agent 二 ${RUN}`,
      sessionId: `mt_a2_${crypto.randomUUID()}`,
    });
    const a3 = await registerIdentity(a3Conn, {
      kind: 'agent',
      name: `MT Agent 三 ${RUN}`,
      sessionId: `mt_a3_${crypto.randomUUID()}`,
    });
    const a4 = await registerIdentity(a4Conn, {
      kind: 'agent',
      name: `MT Agent 晚到 ${RUN}`,
      sessionId: `mt_a4_${crypto.randomUUID()}`,
    });
    for (const peer of [a1Conn, a2Conn, a3Conn, a4Conn]) {
      const identity = await callTool<Identity>(peer.client, 'network_me', {});
      await befriend(hConn, h.actor_id, peer, identity.actor_id);
    }
    const group = await callTool<RoomDetail>(hConn.client, 'network_room_create', {
      request_id: newRequestId('mt_room'),
      kind: 'group',
      title: `MT ${RUN}`,
      members: [a1.actor_id, a2.actor_id, a3.actor_id],
    });
    const roomId = group.room.room_id;
    for (const peer of [a1Conn, a2Conn, a3Conn]) {
      await acceptGroupInvites(peer, roomId);
    }
    check('消息式 Task 验收群建立', Boolean(roomId), roomId);

    const send = (
      connection: McpConnection,
      body: string,
      options: {
        replyTo?: string;
        taskRootId?: string;
        clientMessageId?: string;
        requestId?: string;
      } = {},
    ) => sendMessage(connection, roomId, body, { invoke: [], ...options });

    // 场景 1：人类请求，Agent 确认并标记；读工具不推进 head/已读。
    const root1 = await send(hConn, `S1 请修复聊天切换 ${RUN}`);
    const inboxBefore = await inbox(a1Conn);
    const roomBefore = await callTool<RoomDetail>(hConn.client, 'network_room_get', {
      room_id: roomId,
    });
    const mark1 = await mark(a1Conn, roomId, root1.message.message_id);
    checkEqual('S1 Agent 可标记人类消息', mark1.task_root_id, root1.message.message_id);
    const summary1 = await summaryOf(hConn, roomId, mark1.task_root_id);
    checkEqual('S1 标记后出现摘要', summary1?.root_message_id, root1.message.message_id);
    checkEqual('S1 起点发送者为人类', summary1?.root_sender_kind, 'human');
    checkEqual('S1 摘要初始消息数', summary1?.message_count, 1);
    // 先只做标记与读取，确认 head/已读不推进；随后发送回复才会推进 head。
    const roomAfterReads = await callTool<RoomDetail>(hConn.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual(
      'S1 标记与读工具不推进 head_seq',
      roomAfterReads.room.head_seq,
      roomBefore.room.head_seq,
    );
    checkEqual(
      'S1 读工具不推进已读位置',
      roomAfterReads.room.my_last_read_seq,
      roomBefore.room.my_last_read_seq,
    );
    const reply1 = await send(a1Conn, `S1 收到开始处理 ${RUN}`, {
      replyTo: root1.message.message_id,
    });
    checkEqual('S1 处理消息继承 Task 归属', reply1.message.task_root_id, root1.message.message_id);
    const summary1After = await summaryOf(hConn, roomId, root1.message.message_id);
    checkEqual('S1 确认回复进入集合', summary1After?.message_count, 2);
    checkEqual(
      'S1 参与者为确认处理的 Agent',
      summary1After?.participants.map((item) => item.actor_id).join(','),
      a1.actor_id,
    );
    const trace1 = await trace(hConn, roomId, root1.message.message_id);
    const trace1Replay = await trace(hConn, roomId, root1.message.message_id);
    check(
      'S1 Trace 含起点与处理消息且重复读取一致',
      trace1.items.length === 2 &&
        trace1.items[0]?.message_id === root1.message.message_id &&
        JSON.stringify(trace1) === JSON.stringify(trace1Replay),
      trace1,
    );
    const inboxAfter = await inbox(a1Conn);
    checkEqual('S1 标记不增加 pending_count', inboxAfter.pending_count, inboxBefore.pending_count);

    // 场景 2：Agent 消息本身可作起点。
    const root2 = await send(a2Conn, `S2 维护请求 ${RUN}`);
    await mark(hConn, roomId, root2.message.message_id);
    const summary2 = await summaryOf(hConn, roomId, root2.message.message_id);
    checkEqual('S2 Agent 消息可直接作为起点', summary2?.root_sender_kind, 'agent');
    checkEqual('S2 起点 Agent 自身计入参与者', summary2?.participants[0]?.actor_id, a2.actor_id);
    const reply2 = await send(a1Conn, `S2 接取维护 ${RUN}`, {
      replyTo: root2.message.message_id,
    });
    checkEqual('S2 第二条处理消息归属正确', reply2.message.task_root_id, root2.message.message_id);
    const summary2After = await summaryOf(hConn, roomId, root2.message.message_id);
    checkEqual('S2 参与者按首次参与排序', summary2After?.participants[0]?.actor_id, a2.actor_id);
    checkEqual('S2 参与者去重', summary2After?.participant_count, 2);

    // 场景 3：浏览/搜索不自动创建 Task。
    const chat3 = await send(a3Conn, `S3 只是闲聊 ${RUN}`);
    const unmarked = await summaryOf(hConn, roomId, chat3.message.message_id);
    checkEqual('S3 普通消息不会被自动标记', unmarked, null);
    const chatSearch = await taskSearch(hConn, roomId, `只是闲聊 ${RUN}`);
    checkEqual('S3 未标记消息不出现在 Task 搜索', chatSearch.items.length, 0);
    const plainSearch = await callTool<{ items: { message_id: string }[] }>(
      hConn.client,
      'network_message_search',
      { room_id: roomId, query: `只是闲聊 ${RUN}` },
    );
    check(
      'S3 普通消息搜索契约不变',
      plainSearch.items.some((item) => item.message_id === chat3.message.message_id),
      plainSearch,
    );

    // 场景 4/5：两个 Agent 同时接取同一句话，参与者去重、消息逐条计数。
    const root4 = await send(hConn, `S4 两人同时接取 ${RUN}`);
    const [mark4a, mark4b] = await Promise.all([
      mark(a1Conn, roomId, root4.message.message_id),
      mark(a2Conn, roomId, root4.message.message_id),
    ]);
    check(
      'S4 并发标记收敛到同一 Task',
      mark4a.task_root_id === root4.message.message_id &&
        mark4b.task_root_id === root4.message.message_id,
      { mark4a, mark4b },
    );
    const concurrentSummary = await summaries(hConn, roomId, [root4.message.message_id]);
    checkEqual('S4 只有一个起点与摘要', concurrentSummary.items.length, 1);
    await send(a1Conn, `S4 A1 处理 ${RUN}`, { replyTo: root4.message.message_id });
    await send(a2Conn, `S4 A2 处理 ${RUN}`, { replyTo: root4.message.message_id });
    await send(a1Conn, `S5 A1 第二次回复 ${RUN}`, { replyTo: root4.message.message_id });
    await send(a1Conn, `S5 A1 第三次回复 ${RUN}`, { replyTo: root4.message.message_id });
    const summary4 = await summaryOf(hConn, roomId, root4.message.message_id);
    checkEqual('S5 同一 Agent 只占一个头像', summary4?.participant_count, 2);
    checkEqual('S5 多次回复逐条计数', summary4?.message_count, 5);
    checkEqual(
      'S4 两个 Agent 的实际参与顺序',
      summary4?.participants.map((item) => item.actor_id).join(','),
      `${a1.actor_id},${a2.actor_id}`,
    );

    // 场景 6：只 @ 或引用旧消息不增加参与者，也不唤醒对方。
    const oldSource6 = await send(a3Conn, `S6 A3 的旧消息 ${RUN}`);
    const a3InboxBefore = await inbox(a3Conn);
    const mentionReply = await send(a1Conn, `S6 处理并 @${a3.name} ${RUN}`, {
      replyTo: oldSource6.message.message_id,
      taskRootId: root4.message.message_id,
    });
    checkEqual('S6 显式归属写入处理消息', mentionReply.message.task_root_id, root4.message.message_id);
    const a3InboxAfter = await inbox(a3Conn);
    checkEqual('S6 @ 不唤醒被提及 Agent', a3InboxAfter.pending_count, a3InboxBefore.pending_count);
    const summary6 = await summaryOf(hConn, roomId, root4.message.message_id);
    check(
      'S6 被引用的旧消息作者不成为参与者',
      !(summary6?.participants ?? []).some((item) => item.actor_id === a3.actor_id),
      summary6?.participants,
    );
    checkEqual('S6 引用来源计入消息数', summary6?.message_count, 7);
    const trace6 = await trace(hConn, roomId, root4.message.message_id);
    const oldSourceItem = trace6.items.find(
      (item) => item.message_id === oldSource6.message.message_id,
    );
    checkEqual('S6 旧消息以引用来源出现', oldSourceItem?.role, 'reference');

    // 场景 7：起点 1 + 处理 2 + 来源 2 = 5，重复引用不重复计数。
    const srcX = await send(a3Conn, `S7 来源一 REFHIT-${RUN}`);
    const srcY = await send(a3Conn, `S7 来源二 ${RUN}`);
    const root7 = await send(hConn, `S7 起点 ${RUN}`, {
      replyTo: srcX.message.message_id,
    });
    await mark(a1Conn, roomId, root7.message.message_id);
    const p7a = await send(a1Conn, `S7 处理一 SEARCH-${RUN}`, {
      replyTo: srcX.message.message_id,
      taskRootId: root7.message.message_id,
    });
    const p7b = await send(a1Conn, `S7 处理二 SEARCH-${RUN} HITONE-${RUN}`, {
      replyTo: srcY.message.message_id,
      taskRootId: root7.message.message_id,
    });
    const summary7 = await summaryOf(hConn, roomId, root7.message.message_id);
    checkEqual('S7 1 起点 + 2 处理 + 2 来源 = 5 消息', summary7?.message_count, 5);
    const trace7 = await trace(hConn, roomId, root7.message.message_id);
    checkEqual(
      'S7 同一来源重复引用只保留一条',
      trace7.items.filter((item) => item.role === 'reference').length,
      2,
    );
    checkEqual('S7 来源保持原消息引用关系', trace7.items.length, 5);

    // 场景 8：群里交错两项工作，各自归组，闲聊不收录。
    const rootA8 = await send(hConn, `S8 Task A 起点 ${RUN}`);
    const rootB8 = await send(hConn, `S8 Task B 起点 ${RUN}`);
    const chat8 = await send(hConn, `S8 两项工作之间的闲聊 ${RUN}`);
    await Promise.all([
      mark(a1Conn, roomId, rootA8.message.message_id),
      mark(a2Conn, roomId, rootB8.message.message_id),
    ]);
    await send(a1Conn, `S8 A 处理 ${RUN}`, { replyTo: rootA8.message.message_id });
    await send(hConn, `S8 再插一句闲聊 ${RUN}`);
    const bReply8 = await send(a2Conn, `S8 B 处理 ${RUN}`, {
      replyTo: rootB8.message.message_id,
    });
    const summaryA8 = await summaryOf(hConn, roomId, rootA8.message.message_id);
    const summaryB8 = await summaryOf(hConn, roomId, rootB8.message.message_id);
    checkEqual('S8 Task A 只含自身消息', summaryA8?.message_count, 2);
    checkEqual('S8 Task B 只含自身消息', summaryB8?.message_count, 2);
    checkEqual('S8 闲聊不归属任何 Task', chat8.message.task_root_id, null);

    // 场景 9：Task A 引用 Task B 的结果，不移动、不合并。
    const crossReply = await send(a1Conn, `S9 A 引用 B 的结果 ${RUN}`, {
      replyTo: bReply8.message.message_id,
      taskRootId: rootA8.message.message_id,
    });
    const summaryA9 = await summaryOf(hConn, roomId, rootA8.message.message_id);
    const summaryB9 = await summaryOf(hConn, roomId, rootB8.message.message_id);
    checkEqual('S9 A 收录跨 Task 引用', summaryA9?.message_count, 4);
    checkEqual('S9 B 保持原样', summaryB9?.message_count, 2);
    const traceA9 = await trace(hConn, roomId, rootA8.message.message_id);
    const traceB9 = await trace(hConn, roomId, rootB8.message.message_id);
    const crossItem = traceA9.items.find((item) => item.message_id === bReply8.message.message_id);
    checkEqual('S9 跨 Task 结果在 A 中为引用', crossItem?.role, 'reference');
    check(
      'S9 B 不包含 A 的引用消息',
      !traceB9.items.some((item) => item.message_id === crossReply.message.message_id),
      traceB9,
    );

    // 同一来源被两个 Task 引用时各自展示，不合并集合。
    const sharedSource = await send(a3Conn, `S9 共享来源 SHARED-${RUN}`);
    await send(a1Conn, `S9 A 引用共享来源 ${RUN}`, {
      replyTo: sharedSource.message.message_id,
      taskRootId: rootA8.message.message_id,
    });
    await send(a2Conn, `S9 B 引用共享来源 ${RUN}`, {
      replyTo: sharedSource.message.message_id,
      taskRootId: rootB8.message.message_id,
    });
    const sharedHits = await taskSearch(hConn, roomId, `SHARED-${RUN}`);
    checkEqual('S9 同一来源被两个 Task 引用时返回两条', sharedHits.items.length, 2);
    checkEqual(
      'S9 共享来源按起点分别展示',
      sharedHits.items.map((item) => item.task.root_message_id).sort().join(','),
      [rootA8.message.message_id, rootB8.message.message_id].sort().join(','),
    );
    const sharedPage1 = await taskSearch(hConn, roomId, `SHARED-${RUN}`, { limit: 1 });
    checkEqual('S9 Task 搜索首页一条', sharedPage1.items.length, 1);
    checkEqual('S9 Task 搜索有下一页', sharedPage1.has_more, true);
    check('S9 Task 搜索返回 next_cursor', typeof sharedPage1.next_cursor === 'string');
    const sharedPage2 = await taskSearch(hConn, roomId, `SHARED-${RUN}`, {
      cursor: sharedPage1.next_cursor ?? undefined,
      limit: 1,
    });
    checkEqual('S9 Task 搜索第二页一条', sharedPage2.items.length, 1);
    checkEqual('S9 Task 搜索分页结束', sharedPage2.has_more, false);
    checkEqual(
      'S9 Task 搜索分页不重复起点',
      new Set([
        sharedPage1.items[0]?.task.root_message_id,
        sharedPage2.items[0]?.task.root_message_id,
      ]).size,
      2,
    );

    // 场景 10/11：搜索只命中处理消息时返回对应摘要，多命中按起点去重。
    const hitOne = await taskSearch(hConn, roomId, `HITONE-${RUN}`);
    checkEqual('S10 只命中处理消息也返回 Task', hitOne.items.length, 1);
    checkEqual('S10 命中聚合到正确起点', hitOne.items[0]?.task.root_message_id, root7.message.message_id);
    checkEqual('S10 matches 定位命中消息', hitOne.items[0]?.matches[0]?.message_id, p7b.message.message_id);
    const multiHit = await taskSearch(hConn, roomId, `SEARCH-${RUN}`);
    checkEqual('S11 同一 Task 多命中只返回一个摘要', multiHit.items.length, 1);
    checkEqual('S11 hit_count 统计全部命中', multiHit.items[0]?.hit_count, 2);
    check('S11 matches 最多保留 3 条', (multiHit.items[0]?.matches.length ?? 0) <= 3);
    check(
      'S11 matches 包含两条命中处理消息',
      [p7a.message.message_id, p7b.message.message_id].every((id) =>
        (multiHit.items[0]?.matches ?? []).some((match) => match.message_id === id),
      ),
      multiHit.items[0]?.matches,
    );
    const refHits = await taskSearch(hConn, roomId, `REFHIT-${RUN}`);
    checkEqual('S11 引用来源可被搜索命中', refHits.items.length, 1);
    checkEqual('S11 来源命中聚合到引用它的 Task', refHits.items[0]?.task.root_message_id, root7.message.message_id);
    checkEqual('S11 来源命中定位原文', refHits.items[0]?.matches[0]?.message_id, srcX.message.message_id);

    // 长 Trace 的分页与焦点契约（场景 12 的服务端部分）。
    const tracePage1 = await trace(hConn, roomId, root7.message.message_id, { limit: 2 });
    checkEqual('Trace 首页两条', tracePage1.items.length, 2);
    checkEqual('Trace 首页没有更早页', tracePage1.has_more_before, false);
    checkEqual('Trace 首页有更晚页', tracePage1.has_more_after, true);
    check('Trace 首页返回 next_cursor', typeof tracePage1.next_cursor === 'string');
    const tracePage2 = await trace(hConn, roomId, root7.message.message_id, {
      cursor: tracePage1.next_cursor ?? undefined,
      limit: 2,
    });
    checkEqual('Trace 第二页有更早页', tracePage2.has_more_before, true);
    check('Trace 第二页返回 prev_cursor', typeof tracePage2.prev_cursor === 'string');
    const traceBack = await trace(hConn, roomId, root7.message.message_id, {
      cursor: tracePage2.prev_cursor ?? undefined,
      limit: 2,
    });
    checkEqual(
      'Trace 双向游标回到同一页',
      traceBack.items.map((item) => item.message_id).join(','),
      tracePage1.items.map((item) => item.message_id).join(','),
    );
    const focusTrace = await trace(hConn, roomId, root7.message.message_id, {
      focus: p7b.message.message_id,
      limit: 2,
    });
    checkEqual('Trace 回显 focus_message_id', focusTrace.focus_message_id, p7b.message.message_id);
    checkEqual('Trace 从命中消息开始', focusTrace.items[0]?.message_id, p7b.message.message_id);
    checkEqual('焦点页可继续向前翻页', focusTrace.has_more_before, true);
    await expectCode(
      'Trace 焦点不属于集合时拒绝',
      trace(hConn, roomId, root7.message.message_id, { focus: chat3.message.message_id }),
      'NOT_FOUND',
    );

    // 场景 13：权限边界与撤回。
    await expectCode(
      '非成员不能读取 Task 摘要',
      summaries(a4Conn, roomId, [root7.message.message_id]),
      'NOT_MEMBER',
    );
    await expectCode(
      '非成员不能标记消息',
      mark(a4Conn, roomId, root7.message.message_id),
      'NOT_MEMBER',
    );
    await callTool(hConn.client, 'network_room_members_update', {
      request_id: newRequestId('mt_add_late'),
      room_id: roomId,
      add: [a4.actor_id],
    });
    await acceptGroupInvites(a4Conn, roomId);
    const lateSummary = await summaries(a4Conn, roomId, [root7.message.message_id]);
    checkEqual('晚到成员看不到加入前的 Task', lateSummary.items.length, 0);
    await expectCode(
      '晚到成员读不到加入前的 Trace',
      trace(a4Conn, roomId, root7.message.message_id),
      'NOT_FOUND',
    );
    await expectCode(
      '晚到成员不能标记加入前消息',
      mark(a4Conn, roomId, chat3.message.message_id),
      'NOT_FOUND',
    );

    const recallSource = await send(hConn, `S13 撤回来源 RECALL-${RUN}`);
    await send(a1Conn, `S13 引用撤回来源 ${RUN}`, {
      replyTo: recallSource.message.message_id,
      taskRootId: root7.message.message_id,
    });
    const beforeRecall = await summaryOf(hConn, roomId, root7.message.message_id);
    await callTool(hConn.client, 'network_message_recall', {
      request_id: newRequestId('mt_recall'),
      message_id: recallSource.message.message_id,
    });
    const afterRecall = await summaryOf(hConn, roomId, root7.message.message_id);
    checkEqual('S13 撤回不改变集合计数', afterRecall?.message_count, beforeRecall?.message_count);
    const recallTrace = await trace(hConn, roomId, root7.message.message_id);
    const recalledItem = recallTrace.items.find(
      (item) => item.message_id === recallSource.message.message_id,
    );
    checkEqual('S13 撤回来源仍显示为引用', recalledItem?.role, 'reference');
    checkEqual('S13 撤回来源显示 tombstone', recalledItem?.recalled, true);
    checkEqual('S13 撤回预览为墓碑文本', recalledItem?.preview, '此消息已撤回');

    // 场景 14：取消标记、重复标记与请求重试幂等。
    const remarkId = newRequestId('mt_remark');
    const remark1 = await mark(a1Conn, roomId, root7.message.message_id, remarkId);
    const remark2 = await mark(a1Conn, roomId, root7.message.message_id, remarkId);
    check(
      'S14 重复标记不产生新结果',
      JSON.stringify(remark1) === JSON.stringify(remark2),
      { remark1, remark2 },
    );
    await expectCode(
      'S14 同 request_id 改目标冲突',
      mark(a1Conn, roomId, chat3.message.message_id, remarkId),
      'IDEMPOTENCY_CONFLICT',
    );
    const beforeUnmark = await summaryOf(hConn, roomId, root7.message.message_id);
    await unmark(hConn, roomId, root7.message.message_id);
    const afterUnmark = await summaryOf(hConn, roomId, root7.message.message_id);
    checkEqual('S14 取消标记后摘要省略', afterUnmark, null);
    await expectCode(
      'S14 取消标记后 Trace 不可用',
      trace(hConn, roomId, root7.message.message_id),
      'NOT_FOUND',
    );
    const preserved = await readWholeMessage(hConn, root7.message.message_id);
    check('S14 取消标记保留原消息', preserved.includes(`S7 起点 ${RUN}`), preserved.slice(0, 40));
    await mark(a1Conn, roomId, root7.message.message_id);
    const restored = await summaryOf(hConn, roomId, root7.message.message_id);
    checkEqual('S14 重新标记恢复原集合', restored?.message_count, beforeUnmark?.message_count);

    const clientMessageId = `cm_${RUN}_idem`;
    const idemSend = await send(a1Conn, `S14 发送幂等 ${RUN}`, {
      replyTo: root7.message.message_id,
      clientMessageId,
    });
    const idemReplay = await send(a1Conn, `S14 发送幂等 ${RUN}`, {
      replyTo: root7.message.message_id,
      clientMessageId,
      requestId: newRequestId('mt_idem_replay'),
    });
    checkEqual('S14 同 client_message_id 重放返回同一消息', idemReplay.message.message_id, idemSend.message.message_id);
    await expectCode(
      'S14 同 client_message_id 不同 Task 归属冲突',
      send(a1Conn, `S14 发送幂等 ${RUN}`, {
        replyTo: root7.message.message_id,
        clientMessageId,
        taskRootId: root4.message.message_id,
      }),
      'IDEMPOTENCY_CONFLICT',
    );

    // 事件契约：sync 过滤旧任务事件，保留新的 message_task_marked。
    const syncBase = await syncAll(hConn, roomId);
    check(
      'sync 基线不包含旧任务事件',
      syncBase.types.every(
        (type) => !type.startsWith('task_') && !type.startsWith('room_task_'),
      ),
      syncBase.types,
    );
    const syncRoot = await send(hConn, `S15 sync 新标记 ${RUN}`);
    const legacySource = await send(hConn, `S15 旧任务来源 ${RUN}`);
    await mark(a1Conn, roomId, syncRoot.message.message_id);
    await callTool(hConn.client, 'network_task_create', {
      request_id: newRequestId('mt_legacy_task'),
      room_id: roomId,
      title: `S15 legacy ${RUN}`,
      description: 'legacy task event should not enter sync',
      reviewer_actor_id: h.actor_id,
      source_message_id: legacySource.message.message_id,
    });
    const afterEvents = await syncAll(hConn, roomId, syncBase.cursor);
    check(
      'sync 保留新 message_task_marked',
      afterEvents.types.includes('message_task_marked'),
      afterEvents.types,
    );
    check(
      'sync 过滤旧 task_* / room_task_* 事件',
      afterEvents.types.every(
        (type) => !type.startsWith('task_') && !type.startsWith('room_task_'),
      ),
      afterEvents.types,
    );
  } finally {
    await Promise.all([
      hConn.close(),
      a1Conn.close(),
      a2Conn.close(),
      a3Conn.close(),
      a4Conn.close(),
    ]);
  }
}

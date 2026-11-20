/**
 * 跨会话全局搜索的 MCP 端到端验收。
 *
 * 只通过公开工具调用，覆盖 scope=all、房间名投影、非成员隔离、
 * from_join 边界、全局游标失效、游标跨 scope 与离线同义词召回。
 */

import { callTool, check, checkEqual, expectToolError, newRequestId } from './harness';
import { createActor, makeFriends, type ActorPair } from './group-history-helpers';
import { sendMessage } from './acceptance-helpers';

const RUN = crypto.randomUUID().replaceAll('-', '').slice(0, 10);

interface SearchItemView {
  message_id: string;
  room_id: string;
  room_kind: 'direct' | 'group';
  room_display_name: string;
  sender_name: string;
  created_at: number;
  created_seq: number;
  snippet: string;
  match_ranges?: Array<{ start: number; end: number }>;
}

interface SearchPageView {
  items: SearchItemView[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  scope: 'room' | 'all';
  mode: 'exact' | 'fuzzy';
  scan_limited?: boolean;
  scanned_count?: number;
  authorization:
    | { policy_revision: number; history_from_seq: string; member_generation: string }
    | { scope: 'all'; authorization_digest: string };
}

async function search(
  actor: ActorPair,
  input: {
    room_id?: string;
    scope?: 'room' | 'all';
    query: string;
    mode?: 'exact' | 'fuzzy';
    limit?: number;
    cursor?: string;
  },
): Promise<SearchPageView> {
  return callTool<SearchPageView>(actor.connection.client, 'network_message_search', input);
}

function sortedByNewest(items: SearchItemView[]): string[] {
  return [...items]
    .sort(
      (left, right) =>
        right.created_at - left.created_at ||
        (left.message_id < right.message_id ? 1 : left.message_id > right.message_id ? -1 : 0),
    )
    .map((item) => item.message_id);
}

export async function runMessageSearchGlobalAcceptance(): Promise<void> {
  const owner = await createActor('全局搜索 owner', 'human');
  const peer = await createActor('全局搜索 peer', 'human');
  const outsider = await createActor('全局搜索 outsider', 'human');
  try {
    await makeFriends(owner, peer);
    await makeFriends(owner, outsider);
    const direct = await callTool<{ room: { room_id: string } }>(
      owner.connection.client,
      'network_room_create',
      {
        request_id: newRequestId('global_search_direct'),
        kind: 'direct',
        members: [peer.actor.actor_id],
      },
    );
    const directRoom = direct.room.room_id;
    const groupTitle = `全局验收群 ${RUN}`;
    const group = await callTool<{ room: { room_id: string } }>(
      owner.connection.client,
      'network_room_create',
      {
        request_id: newRequestId('global_search_group'),
        kind: 'group',
        members: [peer.actor.actor_id],
        title: groupTitle,
      },
    );
    const groupRoom = group.room.room_id;

    const directMessage = await sendMessage(
      owner.connection,
      directRoom,
      `全局检索A${RUN} 正文`,
    );
    const groupMessage = await sendMessage(
      owner.connection,
      groupRoom,
      `全局检索B${RUN} 正文`,
    );

    const global = await search(owner, { scope: 'all', query: `全局检索` });
    check(
      '全局搜索跨房间返回两条命中',
      [directMessage.message.message_id, groupMessage.message.message_id].every((id) =>
        global.items.some((item) => item.message_id === id),
      ),
      global.items,
    );
    checkEqual('全局搜索输出 scope', global.scope, 'all');
    checkEqual('全局搜索输出 mode', global.mode, 'exact');
    checkEqual(
      '全局搜索输出 authorization 只有摘要',
      Object.keys(global.authorization).sort().join(','),
      'authorization_digest,scope',
    );
    const directItem = global.items.find(
      (item) => item.message_id === directMessage.message.message_id,
    );
    const groupItem = global.items.find(
      (item) => item.message_id === groupMessage.message.message_id,
    );
    checkEqual('全局结果 direct 场景', directItem?.room_kind, 'direct');
    checkEqual('全局结果 direct 展示名', directItem?.room_display_name, '全局搜索 peer');
    checkEqual('全局结果 group 场景', groupItem?.room_kind, 'group');
    checkEqual('全局结果 group 展示名', groupItem?.room_display_name, groupTitle);
    checkEqual(
      '全局结果按时间与 message_id 稳定倒序',
      global.items.map((item) => item.message_id).join(','),
      sortedByNewest(global.items).join(','),
    );

    const outsiderGlobal = await search(outsider, { scope: 'all', query: '全局检索' });
    checkEqual('非成员在全局搜索中看不到他人房间', outsiderGlobal.items.length, 0);

    await expectToolError(
      'scope=all 带 room_id 返回 INVALID_ARGUMENT',
      search(owner, { scope: 'all', room_id: directRoom, query: '全局检索' }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      'scope=room 缺 room_id 返回 INVALID_ARGUMENT',
      search(owner, { scope: 'room', query: '全局检索' }),
      'INVALID_ARGUMENT',
    );

    const roomPage = await search(owner, { room_id: directRoom, query: '全局检索' });
    checkEqual('房间搜索输出 scope', roomPage.scope, 'room');
    checkEqual(
      '房间搜索也返回展示名',
      roomPage.items[0]?.room_display_name,
      '全局搜索 peer',
    );

    // 全局分页：先取得完整排序，再逐页拼回。
    for (let index = 1; index <= 3; index += 1) {
      await sendMessage(owner.connection, groupRoom, `全局分页${RUN} 第 ${index} 条`);
    }
    const full = await search(owner, { scope: 'all', query: `全局分页${RUN}`, limit: 50 });
    const expected = full.items.map((item) => item.message_id);
    const collected: string[] = [];
    let cursor: string | null = null;
    let page = await search(owner, {
      scope: 'all',
      query: `全局分页${RUN}`,
      limit: 1,
    });
    collected.push(...page.items.map((item) => item.message_id));
    let guard = 0;
    while (page.next_cursor && guard < 20) {
      cursor = page.next_cursor;
      page = await search(owner, {
        scope: 'all',
        query: `全局分页${RUN}`,
        limit: 1,
        cursor,
      });
      collected.push(...page.items.map((item) => item.message_id));
      guard += 1;
    }
    checkEqual('全局搜索分页不重不漏且顺序稳定', collected.join(','), expected.join(','));

    const roomCursorPage = await search(owner, {
      room_id: groupRoom,
      query: `全局分页${RUN}`,
      limit: 1,
    });
    check('房间分页返回 room 游标', roomCursorPage.next_cursor !== null, roomCursorPage);
    await expectToolError(
      'room 游标不能用于全局搜索',
      search(owner, {
        scope: 'all',
        query: `全局分页${RUN}`,
        cursor: roomCursorPage.next_cursor!,
      }),
      'CURSOR_EXPIRED',
    );
    const globalCursorPage = await search(owner, {
      scope: 'all',
      query: `全局分页${RUN}`,
      limit: 1,
    });
    check('全局分页返回 global 游标', globalCursorPage.next_cursor !== null, globalCursorPage);
    await expectToolError(
      'global 游标不能用于房间搜索',
      search(owner, {
        room_id: groupRoom,
        query: `全局分页${RUN}`,
        cursor: globalCursorPage.next_cursor!,
      }),
      'INVALID_ARGUMENT',
    );

    // 策略 revision 变化使旧全局游标失效。
    const detail = await callTool<{ room: { policy_revision: number } }>(
      owner.connection.client,
      'network_room_get',
      { room_id: groupRoom },
    );
    await callTool(owner.connection.client, 'network_room_policy_set', {
      request_id: newRequestId('global_search_policy'),
      room_id: groupRoom,
      member_history_policy: 'from_join',
      expected_policy_revision: detail.room.policy_revision,
    });
    await expectToolError(
      '策略变化后旧全局游标返回 CURSOR_EXPIRED',
      search(owner, {
        scope: 'all',
        query: `全局分页${RUN}`,
        cursor: globalCursorPage.next_cursor!,
      }),
      'CURSOR_EXPIRED',
    );

    await runFromJoinAcceptance(owner, peer, outsider);
    await runSynonymAcceptance(owner, directRoom);
  } finally {
    await Promise.all([owner.connection.close(), peer.connection.close(), outsider.connection.close()]);
  }
}

async function runFromJoinAcceptance(
  owner: ActorPair,
  peer: ActorPair,
  filler: ActorPair,
): Promise<void> {
  const room = await callTool<{ room: { room_id: string; policy_revision: number } }>(
    owner.connection.client,
    'network_room_create',
    {
      request_id: newRequestId('global_search_from_join'),
      kind: 'group',
      members: [filler.actor.actor_id],
      title: `加入边界群 ${RUN}`,
    },
  );
  const roomId = room.room.room_id;
  const before = await sendMessage(owner.connection, roomId, `加入前标记${RUN}`);
  await callTool(owner.connection.client, 'network_room_members_update', {
    request_id: newRequestId('global_search_add_peer'),
    room_id: roomId,
    add: [peer.actor.actor_id],
  });
  const joined = await callTool<{ room: { policy_revision: number } }>(
    owner.connection.client,
    'network_room_get',
    { room_id: roomId },
  );
  await callTool(owner.connection.client, 'network_room_policy_set', {
    request_id: newRequestId('global_search_join_policy'),
    room_id: roomId,
    member_history_policy: 'from_join',
    expected_policy_revision: joined.room.policy_revision,
  });
  const after = await sendMessage(owner.connection, roomId, `加入后标记${RUN}`);

  const peerBefore = await search(peer, { scope: 'all', query: `加入前标记${RUN}` });
  checkEqual('from_join 前消息对成员全局不可见', peerBefore.items.length, 0);
  const peerAfter = await search(peer, { scope: 'all', query: `加入后标记${RUN}` });
  checkEqual(
    'from_join 后消息对成员全局可见',
    peerAfter.items.map((item) => item.message_id).join(','),
    after.message.message_id,
  );
  const ownerBefore = await search(owner, { scope: 'all', query: `加入前标记${RUN}` });
  checkEqual(
    'full 语义下 owner 仍能看到加入前消息',
    ownerBefore.items.map((item) => item.message_id).join(','),
    before.message.message_id,
  );
}

async function runSynonymAcceptance(owner: ActorPair, directRoom: string): Promise<void> {
  const message = await sendMessage(owner.connection, directRoom, `拖拽失效 记录${RUN}`);
  const exact = await search(owner, { scope: 'all', query: '拉不动' });
  check(
    'exact 不使用同义词扩展',
    !exact.items.some((item) => item.message_id === message.message.message_id),
    exact.items,
  );
  const fuzzy = await search(owner, { scope: 'all', query: '拉不动', mode: 'fuzzy' });
  const item = fuzzy.items.find(
    (result) => result.message_id === message.message.message_id,
  );
  check('fuzzy 通过同义词召回「拖拽失效」', Boolean(item), fuzzy.items);
  checkEqual('fuzzy 全局输出 mode', fuzzy.mode, 'fuzzy');
  check('fuzzy 全局返回 scanned_count', typeof fuzzy.scanned_count === 'number', fuzzy);
  checkEqual('fuzzy 全局 scan_limited=false', fuzzy.scan_limited, false);
  check(
    '同义词命中区间指向原文',
    (item?.match_ranges ?? [])
      .map((range) => item!.snippet.slice(range.start, range.end))
      .join('') === '拖拽失效',
    item,
  );
}

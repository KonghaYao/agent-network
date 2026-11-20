/**
 * Phase 4A：消息搜索 FTS5 的 MCP 端到端验收。
 *
 * 只通过公开工具调用，覆盖 >=3 字 CJK、1–2 字回退、ASCII 大小写、
 * 分页、非成员可见性、撤回后不可搜索与输出契约不变。
 */

import {
  callTool,
  check,
  checkEqual,
  expectToolError,
  newRequestId,
} from './harness';
import {
  createActor,
  makeFriends,
  type ActorPair,
} from './group-history-helpers';
import { sendMessage, type SendResult } from './acceptance-helpers';

const RUN = crypto.randomUUID().replaceAll('-', '').slice(0, 10);

interface SearchItemView {
  message_id: string;
  room_id: string;
  room_kind: 'direct' | 'group';
  room_display_name: string;
  sender_id: string;
  sender_name: string;
  sender_kind: string;
  body_bytes: number;
  preview: string;
  created_at: number;
  created_seq: number;
  reply_to: string | null;
  snippet: string;
  match_ranges?: Array<{ start: number; end: number }>;
}

interface SearchPageView {
  items: SearchItemView[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  scope?: 'room' | 'all';
  mode?: 'exact' | 'fuzzy';
  scan_limited?: boolean;
  scanned_count?: number;
  authorization:
    | {
        policy_revision: number;
        history_from_seq: string;
        member_generation: string;
      }
    | { scope: 'all'; authorization_digest: string };
}

interface HistoryPageView {
  items: Array<{ message_id: string; created_seq: string }>;
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  head_seq: string;
  anchor_window?: { message_id: string; has_older: boolean; has_newer: boolean };
  timeline_items?: Array<{ kind: string; message_id?: string }>;
  timeline_next_cursor?: string | null;
  timeline_has_more?: boolean;
}

async function search(
  actor: ActorPair,
  roomId: string,
  query: string,
  extra: { limit?: number; cursor?: string; mode?: 'exact' | 'fuzzy' } = {},
): Promise<SearchPageView> {
  return callTool<SearchPageView>(actor.connection.client, 'network_message_search', {
    room_id: roomId,
    query,
    ...extra,
  });
}

export async function runMessageSearchAcceptance(): Promise<void> {
  const owner = await createActor('搜索验收 owner', 'human');
  const peer = await createActor('搜索验收 peer', 'human');
  const outsider = await createActor('搜索验收 outsider', 'human');
  try {
    await makeFriends(owner, peer);
    const created = await callTool<{ room: { room_id: string } }>(
      owner.connection.client,
      'network_room_create',
      {
        request_id: newRequestId('search_room'),
        kind: 'direct',
        members: [peer.actor.actor_id],
      },
    );
    const roomId = created.room.room_id;

    const cjkBody = `项目 中文关键词${RUN} 会议记录`;
    const cjk = await sendMessage(owner.connection, roomId, cjkBody);
    const cjkHit = await search(owner, roomId, '中文关键词');
    check(
      'CJK >=3 字命中',
      cjkHit.items.some((item) => item.message_id === cjk.message.message_id),
      cjkHit,
    );
    check(
      'CJK snippet 含命中词',
      cjkHit.items.find((item) => item.message_id === cjk.message.message_id)?.snippet
        .includes('中文关键词') ?? false,
      cjkHit.items[0]?.snippet,
    );

    const shortHit = await search(owner, roomId, '中文');
    check(
      '1–2 字回退命中',
      shortHit.items.some((item) => item.message_id === cjk.message.message_id),
      shortHit,
    );

    const asciiBody = `ASCII Needle${RUN} 搜索`;
    const ascii = await sendMessage(owner.connection, roomId, asciiBody);
    const asciiHit = await search(owner, roomId, `needle${RUN}`);
    check(
      'ASCII 大小写不敏感',
      asciiHit.items.some((item) => item.message_id === ascii.message.message_id),
      asciiHit,
    );

    const pageMessages: SendResult[] = [];
    for (let index = 1; index <= 3; index += 1) {
      pageMessages.push(
        await sendMessage(owner.connection, roomId, `分页标记${RUN} 第 ${index} 条`),
      );
    }
    const pages: string[] = [];
    let cursor: string | undefined;
    let lastHasMore = true;
    for (let guard = 0; guard < 5; guard += 1) {
      const page = await search(owner, roomId, `分页标记${RUN}`, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(...page.items.map((item) => item.message_id));
      lastHasMore = page.has_more;
      cursor = page.next_cursor ?? undefined;
      if (!cursor) break;
    }
    checkEqual(
      '搜索分页按最新在前且不重复',
      pages.join(','),
      pageMessages
        .map((item) => item.message.message_id)
        .reverse()
        .join(','),
    );
    checkEqual('搜索最后一页 has_more=false', lastHasMore, false);

    const firstPage = await search(owner, roomId, `分页标记${RUN}`, { limit: 2 });
    checkEqual(
      '搜索输出契约字段',
      Object.keys(firstPage).sort().join(','),
      'authorization,has_more,items,mode,next_cursor,scan_limited,scope,snapshot',
    );
    checkEqual('缺省 mode 为 exact', firstPage.mode, 'exact');
    checkEqual('缺省 scope 为 room', firstPage.scope, 'room');
    checkEqual('exact scan_limited=false', firstPage.scan_limited, false);
    checkEqual(
      '搜索 authorization 快照字段',
      Object.keys(firstPage.authorization).sort().join(','),
      'history_from_seq,member_generation,policy_revision',
    );
    const firstItem = firstPage.items[0];
    checkEqual('搜索条目带 direct 展示名', firstItem?.room_display_name, '搜索验收 peer');
    checkEqual('搜索条目带 room_kind', firstItem?.room_kind, 'direct');
    check(
      '搜索条目字段与类型不变',
      Boolean(firstItem) &&
        typeof firstItem!.message_id === 'string' &&
        typeof firstItem!.sender_name === 'string' &&
        typeof firstItem!.created_seq === 'number' &&
        typeof firstItem!.snippet === 'string' &&
        typeof firstItem!.body_bytes === 'number',
      firstItem,
    );

    await expectToolError(
      '非成员搜索返回 NOT_MEMBER',
      search(outsider, roomId, '中文关键词'),
      'NOT_MEMBER',
    );

    const recalled = await sendMessage(owner.connection, roomId, `待撤回标记${RUN} 正文`);
    const beforeRecall = await search(owner, roomId, '待撤回标记');
    check(
      '撤回前可搜索',
      beforeRecall.items.some((item) => item.message_id === recalled.message.message_id),
      beforeRecall,
    );
    await callTool(owner.connection.client, 'network_message_recall', {
      request_id: newRequestId('search_recall'),
      message_id: recalled.message.message_id,
    });
    const afterRecall = await search(owner, roomId, '待撤回标记');
    checkEqual('撤回后不可搜索', afterRecall.items.length, 0);

    const empty = await search(owner, roomId, `不存在${RUN}`);
    checkEqual('无结果空态', empty.items.length, 0);
    checkEqual('无结果 next_cursor', empty.next_cursor, null);
    checkEqual('无结果 has_more', empty.has_more, false);

    await runFuzzyAcceptance(owner, outsider, roomId);
    await runBudgetAnchorAcceptance(owner, peer, outsider);
  } finally {
    await Promise.all([owner.connection.close(), peer.connection.close(), outsider.connection.close()]);
  }
}

async function runFuzzyAcceptance(
  owner: ActorPair,
  outsider: ActorPair,
  roomId: string,
): Promise<void> {
  const release = await sendMessage(owner.connection, roomId, `发布新版本 ${RUN}`);
  const query = `发版${RUN}`;
  const exactMiss = await search(owner, roomId, query);
  checkEqual('exact 不跨字匹配', exactMiss.items.length, 0);
  const fuzzyHit = await search(owner, roomId, query, { mode: 'fuzzy' });
  const releaseItem = fuzzyHit.items.find(
    (item) => item.message_id === release.message.message_id,
  );
  check('fuzzy 跨字命中', Boolean(releaseItem), fuzzyHit);
  checkEqual('fuzzy 输出 mode', fuzzyHit.mode, 'fuzzy');
  checkEqual('fuzzy 未达预算 scan_limited=false', fuzzyHit.scan_limited, false);
  check('fuzzy 返回 scanned_count', typeof fuzzyHit.scanned_count === 'number', fuzzyHit);
  check(
    'fuzzy match_ranges 指向 snippet 内原文',
    (releaseItem?.match_ranges ?? [])
      .map((range) => releaseItem!.snippet.slice(range.start, range.end))
      .join('') === query,
    releaseItem,
  );

  const hello = await sendMessage(owner.connection, roomId, `Hello，new WORLD! ${RUN}`);
  const caseAndSpace = await search(owner, roomId, `hello world ${RUN}`, { mode: 'fuzzy' });
  check(
    'fuzzy 折叠空白/标点与 ASCII 大小写',
    caseAndSpace.items.some((item) => item.message_id === hello.message.message_id),
    caseAndSpace,
  );

  const fullwidth = await sendMessage(owner.connection, roomId, `a---b c ${RUN}`);
  const folded = await search(owner, roomId, `Ａ，Ｂ　Ｃ${RUN}`, { mode: 'fuzzy' });
  check(
    'fuzzy 折叠全角 ASCII/全角空格/标点',
    folded.items.some((item) => item.message_id === fullwidth.message.message_id),
    folded,
  );

  const reverse = await sendMessage(owner.connection, roomId, `bar foo ${RUN}`);
  const reverseHit = await search(owner, roomId, `foo bar ${RUN}`, { mode: 'fuzzy' });
  check(
    'fuzzy 不是任意顺序 AND',
    !reverseHit.items.some((item) => item.message_id === reverse.message.message_id),
    reverseHit,
  );
  const unrelated = await search(owner, roomId, `完全无关${RUN}`, { mode: 'fuzzy' });
  checkEqual('fuzzy 不误报明显无关文本', unrelated.items.length, 0);

  const emoji = await sendMessage(owner.connection, roomId, `🙂--A${RUN}`);
  const emojiHit = await search(owner, roomId, `🙂a${RUN}`, { mode: 'fuzzy' });
  const emojiItem = emojiHit.items.find(
    (item) => item.message_id === emoji.message.message_id,
  );
  check('fuzzy emoji 命中', Boolean(emojiItem), emojiHit);
  check(
    'fuzzy emoji range 覆盖代理对',
    (emojiItem?.match_ranges ?? []).some(
      (range) => emojiItem!.snippet.slice(range.start, range.end) === '🙂',
    ),
    emojiItem,
  );

  const recalled = await sendMessage(owner.connection, roomId, `模糊撤回${RUN} 正文`);
  const beforeRecall = await search(owner, roomId, `模糊撤回${RUN}`, { mode: 'fuzzy' });
  check(
    'fuzzy 撤回前可搜索',
    beforeRecall.items.some((item) => item.message_id === recalled.message.message_id),
    beforeRecall,
  );
  await callTool(owner.connection.client, 'network_message_recall', {
    request_id: newRequestId('fuzzy_recall'),
    message_id: recalled.message.message_id,
  });
  const afterRecall = await search(owner, roomId, `模糊撤回${RUN}`, { mode: 'fuzzy' });
  checkEqual('fuzzy 撤回后不可搜索', afterRecall.items.length, 0);

  await expectToolError(
    '非成员 fuzzy 搜索返回 NOT_MEMBER',
    search(outsider, roomId, `发版${RUN}`, { mode: 'fuzzy' }),
    'NOT_MEMBER',
  );

  const pageMessages: SendResult[] = [];
  for (let index = 1; index <= 3; index += 1) {
    pageMessages.push(
      await sendMessage(owner.connection, roomId, `模糊分页${RUN} 第 ${index} 条`),
    );
  }
  const pages: string[] = [];
  let page = await search(owner, roomId, `模糊分页${RUN}`, { mode: 'fuzzy', limit: 1 });
  pages.push(...page.items.map((item) => item.message_id));
  let cursor = page.next_cursor;
  let guard = 0;
  while (cursor && guard < 200) {
    page = await search(owner, roomId, `模糊分页${RUN}`, {
      mode: 'fuzzy',
      limit: 1,
      cursor,
    });
    pages.push(...page.items.map((item) => item.message_id));
    cursor = page.next_cursor;
    guard += 1;
  }
  checkEqual(
    'fuzzy 分页不重不漏且按序号倒序',
    pages.join(','),
    pageMessages
      .map((item) => item.message.message_id)
      .reverse()
      .join(','),
  );

  const omitted = await search(owner, roomId, `分页标记${RUN}`, { limit: 2 });
  const explicit = await search(owner, roomId, `分页标记${RUN}`, {
    mode: 'exact',
    limit: 2,
  });
  checkEqual(
    '显式 exact 与缺省 mode 结果一致',
    omitted.items.map((item) => item.message_id).join(','),
    explicit.items.map((item) => item.message_id).join(','),
  );
}

async function runBudgetAnchorAcceptance(
  owner: ActorPair,
  peer: ActorPair,
  outsider: ActorPair,
): Promise<void> {
  const created = await callTool<{ room: { room_id: string } }>(
    owner.connection.client,
    'network_room_create',
    {
      request_id: newRequestId('search_budget_room'),
      kind: 'group',
      members: [peer.actor.actor_id],
      title: `搜索预算群 ${RUN}`,
    },
  );
  const roomId = created.room.room_id;
  const hit = await sendMessage(owner.connection, roomId, `预算命中${RUN}`);
  const fillers: SendResult[] = [];
  for (let index = 1; index <= 501; index += 1) {
    fillers.push(await sendMessage(owner.connection, roomId, `填充${RUN} ${index}`));
  }

  const first = await search(owner, roomId, `预算命中${RUN}`, { mode: 'fuzzy' });
  checkEqual('fuzzy 扫描预算首页为空', first.items.length, 0);
  checkEqual('fuzzy 扫描预算 scan_limited=true', first.scan_limited, true);
  checkEqual('fuzzy 扫描预算检查 500 条候选', first.scanned_count, 500);
  checkEqual('fuzzy 扫描预算 has_more=true', first.has_more, true);
  check('fuzzy 扫描预算返回继续游标', first.next_cursor !== null, first);
  const second = await search(owner, roomId, `预算命中${RUN}`, {
    mode: 'fuzzy',
    cursor: first.next_cursor!,
  });
  checkEqual(
    'fuzzy 空批继续后找到更旧命中',
    second.items.map((item) => item.message_id).join(','),
    hit.message.message_id,
  );
  checkEqual('fuzzy 找到命中后 has_more=false', second.has_more, false);

  const anchorMessage = fillers[249]!;
  const anchorId = anchorMessage.message.message_id;
  const anchorPage = await callTool<HistoryPageView>(
    owner.connection.client,
    'network_history_list',
    { room_id: roomId, anchor_message_id: anchorId, limit: 50 },
  );
  checkEqual('anchor 窗口总数等于 limit', anchorPage.items.length, 50);
  check(
    'anchor 窗口包含目标消息',
    anchorPage.items.some((item) => item.message_id === anchorId),
    anchorPage.items.map((item) => item.message_id),
  );
  check(
    'anchor 窗口按序号倒序',
    anchorPage.items.every(
      (item, index, items) =>
        index === 0 || Number(items[index - 1]!.created_seq) > Number(item.created_seq),
    ),
    anchorPage.items.map((item) => item.created_seq),
  );
  checkEqual(
    'anchor_window 标记两侧还有消息',
    JSON.stringify(anchorPage.anchor_window),
    JSON.stringify({ message_id: anchorId, has_older: true, has_newer: true }),
  );
  checkEqual('anchor has_more 只表示更早侧', anchorPage.has_more, true);
  check('anchor 返回更早侧游标', anchorPage.next_cursor !== null, anchorPage);

  const single = await callTool<HistoryPageView>(
    owner.connection.client,
    'network_history_list',
    { room_id: roomId, anchor_message_id: anchorId, limit: 1 },
  );
  checkEqual(
    'anchor limit=1 只返回锚点',
    single.items.map((item) => item.message_id).join(','),
    anchorId,
  );

  const older = await callTool<HistoryPageView>(
    owner.connection.client,
    'network_history_list',
    { room_id: roomId, cursor: anchorPage.next_cursor!, limit: 50 },
  );
  const windowIds = new Set(anchorPage.items.map((item) => item.message_id));
  check(
    'anchor 游标继续更早页且不重复',
    older.items.every((item) => !windowIds.has(item.message_id)),
    older.items.map((item) => item.message_id),
  );

  await expectToolError(
    'anchor 与 cursor 互斥',
    callTool(owner.connection.client, 'network_history_list', {
      room_id: roomId,
      anchor_message_id: anchorId,
      cursor: anchorPage.next_cursor!,
    }),
    'INVALID_ARGUMENT',
  );
  await expectToolError(
    'anchor 不允许 direction=after',
    callTool(owner.connection.client, 'network_history_list', {
      room_id: roomId,
      anchor_message_id: anchorId,
      direction: 'after',
    }),
    'INVALID_ARGUMENT',
  );
  await expectToolError(
    '非成员 anchor 返回 NOT_MEMBER',
    callTool(outsider.connection.client, 'network_history_list', {
      room_id: roomId,
      anchor_message_id: anchorId,
    }),
    'NOT_MEMBER',
  );

  const otherRoom = await callTool<{ room: { room_id: string } }>(
    owner.connection.client,
    'network_room_create',
    {
      request_id: newRequestId('search_anchor_other'),
      kind: 'group',
      members: [peer.actor.actor_id],
      title: `搜索锚点另一群 ${RUN}`,
    },
  );
  const otherMessage = await sendMessage(
    owner.connection,
    otherRoom.room.room_id,
    `其他房间锚点${RUN}`,
  );
  await expectToolError(
    '跨房间 anchor 返回 NOT_FOUND',
    callTool(owner.connection.client, 'network_history_list', {
      room_id: roomId,
      anchor_message_id: otherMessage.message.message_id,
    }),
    'NOT_FOUND',
  );

  const recalledAnchor = await sendMessage(owner.connection, roomId, `撤回锚点${RUN}`);
  await callTool(owner.connection.client, 'network_message_recall', {
    request_id: newRequestId('anchor_recall'),
    message_id: recalledAnchor.message.message_id,
  });
  await expectToolError(
    '撤回消息不能作为 anchor',
    callTool(owner.connection.client, 'network_history_list', {
      room_id: roomId,
      anchor_message_id: recalledAnchor.message.message_id,
    }),
    'NOT_FOUND',
  );

  const timelinePage = await callTool<HistoryPageView>(
    owner.connection.client,
    'network_history_list',
    { room_id: roomId, view: 'timeline', anchor_message_id: anchorId, limit: 50 },
  );
  const timelineIds = (timelinePage.timeline_items ?? [])
    .filter((item) => item.kind === 'message')
    .map((item) => item.message_id);
  checkEqual('timeline anchor 窗口总数等于 limit', timelineIds.length, 50);
  check('timeline anchor 包含目标消息', timelineIds.includes(anchorId), timelineIds);
  checkEqual(
    'timeline anchor_window 标记两侧还有消息',
    JSON.stringify(timelinePage.anchor_window),
    JSON.stringify({ message_id: anchorId, has_older: true, has_newer: true }),
  );
  checkEqual('timeline anchor has_more 只表示更早侧', timelinePage.timeline_has_more, true);
  check('timeline anchor 返回更早侧游标', timelinePage.timeline_next_cursor !== null, timelinePage);
}

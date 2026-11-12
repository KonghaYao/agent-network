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
  sender_id: string;
  sender_name: string;
  sender_kind: string;
  body_bytes: number;
  preview: string;
  created_at: number;
  created_seq: number;
  reply_to: string | null;
  snippet: string;
}

interface SearchPageView {
  items: SearchItemView[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  authorization: {
    policy_revision: number;
    history_from_seq: string;
    member_generation: string;
  };
}

async function search(
  actor: ActorPair,
  roomId: string,
  query: string,
  extra: { limit?: number; cursor?: string } = {},
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
    checkEqual('搜索输出契约字段', Object.keys(firstPage).sort().join(','), 'authorization,has_more,items,next_cursor,snapshot');
    checkEqual(
      '搜索 authorization 快照字段',
      Object.keys(firstPage.authorization).sort().join(','),
      'history_from_seq,member_generation,policy_revision',
    );
    const firstItem = firstPage.items[0];
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
  } finally {
    await Promise.all([owner.connection.close(), peer.connection.close(), outsider.connection.close()]);
  }
}

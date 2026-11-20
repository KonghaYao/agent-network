/**
 * 跨会话全局搜索与离线同义词的纯数据库验收。
 *
 * 用内存 SQLite 直接调用域层，覆盖授权 CTE、from_join/归档边界、
 * 跨房间排序、全局游标摘要、fuzzy 时间切片预算与房间名投影。
 */

import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { decodeCursor, encodeCursor, type CursorPayload } from '../../src/contracts/cursor';
import { LIMITS } from '../../src/contracts/limits';
import { normalizeFuzzyQuery } from '../../src/contracts/message-search-match';
import {
  FUZZY_CURSOR_VERSION,
  FUZZY_MATCHER_VERSION,
  MESSAGE_SEARCH_SYNONYM_VERSION,
  expandFuzzyQuery,
  findFuzzyMatchWithSynonyms,
  fuzzySearchTerms,
} from '../../src/contracts/message-search-synonyms';
import { messageSearch } from '../../src/domain/message-search';
import type { Principal } from '../../src/domain/principal';
import { getActor } from '../../src/storage/queries';
import { check, checkEqual } from './harness';

const MIGRATIONS = join(resolve(import.meta.dir, '../..'), 'migrations');
const NOW = 1_700_000_000_000;

interface SearchItemShape {
  message_id: string;
  room_id: string;
  room_kind: 'direct' | 'group';
  room_display_name: string;
  created_at: number;
  created_seq: number;
  snippet: string;
  match_ranges?: Array<{ start: number; end: number }>;
}

interface SearchPageShape {
  items: SearchItemShape[];
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

interface Fixture {
  sqlite: Database;
  db: D1Database;
  owner: Principal;
  peer: Principal;
  outsider: Principal;
}

function insertActor(sqlite: Database, actorId: string, name: string): void {
  sqlite
    .prepare(
      `INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata,
                           inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
       VALUES (?, 'human', NULL, ?, '{}', 0, 0, 0, ?, ?)`,
    )
    .run(actorId, name, NOW, NOW);
}

function insertRoom(
  sqlite: Database,
  input: {
    roomId: string;
    kind: 'direct' | 'group';
    ownerId: string;
    title?: string;
    headSeq: number;
    historyPolicy?: 'full' | 'from_join';
    policyRevision?: number;
    dissolvedAt?: number | null;
    archiveHeadSeq?: number | null;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO rooms (room_id, kind, owner_id, title, head_seq,
                          member_history_policy, policy_revision, dissolved_at,
                          archive_head_seq, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.roomId,
      input.kind,
      input.ownerId,
      input.title ?? '',
      input.headSeq,
      input.historyPolicy ?? 'full',
      input.policyRevision ?? 1,
      input.dissolvedAt ?? null,
      input.archiveHeadSeq ?? null,
      NOW,
      NOW,
    );
}

function insertMember(
  sqlite: Database,
  roomId: string,
  actorId: string,
  role: 'owner' | 'member',
  joinedSeq: number,
  generation = 1,
): void {
  sqlite
    .prepare(
      `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq,
                                 last_read_seq, joined_at, member_generation,
                                 role_revision, updated_at)
       VALUES (?, ?, ?, 'active', ?, 0, ?, ?, 1, ?)`,
    )
    .run(roomId, actorId, role, joinedSeq, NOW, generation, NOW);
}

function insertMessage(
  sqlite: Database,
  roomId: string,
  messageId: string,
  seq: number,
  body: string,
  createdAt: number,
  senderId = 'usr_owner',
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq,
                             body, body_bytes, preview, reply_to, root_id, hop,
                             root_invocations_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
    )
    .run(
      messageId,
      roomId,
      senderId,
      `client_${messageId}`,
      seq,
      body,
      Buffer.byteLength(body),
      body.slice(0, 40),
      createdAt,
    );
}

async function fixture(): Promise<Fixture> {
  const sqlite = new Database(':memory:');
  migrate(sqlite, MIGRATIONS);
  const db = createD1(sqlite);
  insertActor(sqlite, 'usr_owner', '全局 owner');
  insertActor(sqlite, 'usr_peer', '全局 peer');
  insertActor(sqlite, 'usr_outsider', '全局 outsider');

  // direct：owner/peer，展示名取 peer。
  insertRoom(sqlite, { roomId: 'rm_global_direct', kind: 'direct', ownerId: 'usr_owner', headSeq: 3 });
  insertMember(sqlite, 'rm_global_direct', 'usr_owner', 'owner', 0);
  insertMember(sqlite, 'rm_global_direct', 'usr_peer', 'member', 0);
  insertMessage(sqlite, 'rm_global_direct', 'msg_d1', 1, '全局标记 第一条', NOW + 100);

  // group：owner/peer，标题用于展示。
  insertRoom(sqlite, { roomId: 'rm_global_group', kind: 'group', ownerId: 'usr_owner', title: '全局群', headSeq: 1 });
  insertMember(sqlite, 'rm_global_group', 'usr_owner', 'owner', 0);
  insertMember(sqlite, 'rm_global_group', 'usr_peer', 'member', 0);
  insertMessage(sqlite, 'rm_global_group', 'msg_g1', 1, '全局标记 群消息', NOW + 200);

  // from_join：peer 的 joined_seq=2，之前消息不可见。
  insertRoom(sqlite, {
    roomId: 'rm_global_bounded',
    kind: 'group',
    ownerId: 'usr_owner',
    title: '边界群',
    headSeq: 2,
    historyPolicy: 'from_join',
  });
  insertMember(sqlite, 'rm_global_bounded', 'usr_owner', 'owner', 0);
  insertMember(sqlite, 'rm_global_bounded', 'usr_peer', 'member', 2);
  insertMessage(sqlite, 'rm_global_bounded', 'msg_b1', 1, '边界标记 加入前', NOW + 150);
  insertMessage(sqlite, 'rm_global_bounded', 'msg_b2', 2, '全局标记 加入后 边界标记', NOW + 300);

  // 归档群：archive_head_seq=2，seq=3 的消息必须不可见。
  insertRoom(sqlite, {
    roomId: 'rm_global_archive',
    kind: 'group',
    ownerId: 'usr_owner',
    title: '归档群',
    headSeq: 3,
    dissolvedAt: NOW + 10,
    archiveHeadSeq: 2,
  });
  insertMember(sqlite, 'rm_global_archive', 'usr_owner', 'owner', 0);
  insertMessage(sqlite, 'rm_global_archive', 'msg_a1', 1, '归档标记 一', NOW + 110);
  insertMessage(sqlite, 'rm_global_archive', 'msg_a2', 2, '归档标记 二', NOW + 210);
  insertMessage(sqlite, 'rm_global_archive', 'msg_a3', 3, '归档标记 三', NOW + 310);

  // 非成员 direct 房间：owner 不是成员，任何查询都不能看到。
  insertRoom(sqlite, { roomId: 'rm_global_foreign', kind: 'direct', ownerId: 'usr_peer', headSeq: 1 });
  insertMember(sqlite, 'rm_global_foreign', 'usr_peer', 'owner', 0);
  insertMember(sqlite, 'rm_global_foreign', 'usr_outsider', 'member', 0);
  insertMessage(
    sqlite,
    'rm_global_foreign',
    'msg_f1',
    1,
    '非成员标记 不可见',
    NOW + 400,
    'usr_peer',
  );

  // 空标题群：展示名回退。
  insertRoom(sqlite, { roomId: 'rm_global_untitled', kind: 'group', ownerId: 'usr_owner', headSeq: 1 });
  insertMember(sqlite, 'rm_global_untitled', 'usr_owner', 'owner', 0);
  insertMessage(sqlite, 'rm_global_untitled', 'msg_u1', 1, '空标题标记', NOW + 120);

  // 没有对端的 direct 房间：展示名回退为「单聊」。
  insertRoom(sqlite, { roomId: 'rm_global_lonely', kind: 'direct', ownerId: 'usr_owner', headSeq: 1 });
  insertMember(sqlite, 'rm_global_lonely', 'usr_owner', 'owner', 0);
  insertMessage(sqlite, 'rm_global_lonely', 'msg_l1', 1, '孤立单聊标记', NOW + 130);

  const principal = async (actor: string): Promise<Principal> => ({
    actor: await getActor(db, actor),
    credential: null,
    credentialHash: '',
  });
  return {
    sqlite,
    db,
    owner: await principal('usr_owner'),
    peer: await principal('usr_peer'),
    outsider: await principal('usr_outsider'),
  };
}

async function expectCode(label: string, action: () => Promise<unknown>, code: string) {
  try {
    await action();
  } catch (error) {
    checkEqual(label, (error as { code?: string }).code, code);
    return;
  }
  throw new Error(`${label}: 预期抛错但成功返回`);
}

function search(
  db: D1Database,
  principal: Principal,
  input: {
    room_id?: string;
    scope?: 'room' | 'all';
    query: string;
    mode?: 'exact' | 'fuzzy';
    limit?: number;
    cursor?: string;
  },
): Promise<SearchPageShape> {
  return messageSearch(db, principal, input as never) as Promise<SearchPageShape>;
}

async function exactGlobalChecks(): Promise<void> {
  const { sqlite, db, owner, peer, outsider } = await fixture();
  try {
    const page = await search(db, owner, { scope: 'all', query: '全局标记' });
    checkEqual(
      '全局 exact 按 created_at 倒序跨房间返回',
      page.items.map((item) => item.message_id).join(','),
      'msg_b2,msg_g1,msg_d1',
    );
    checkEqual('全局 exact scope', page.scope, 'all');
    checkEqual('全局 exact mode', page.mode, 'exact');
    checkEqual('全局授权摘要不含房间列表', Object.keys(page.authorization).sort().join(','), 'authorization_digest,scope');
    check(
      '全局结果带 direct/group 展示名',
      page.items.find((item) => item.message_id === 'msg_d1')?.room_display_name === '全局 peer' &&
        page.items.find((item) => item.message_id === 'msg_g1')?.room_display_name === '全局群',
      page.items,
    );
    checkEqual(
      '全局结果 room_kind',
      page.items.map((item) => item.room_kind).join(','),
      'group,group,direct',
    );

    const untitled = await search(db, owner, { scope: 'all', query: '空标题标记' });
    checkEqual('空标题群展示名回退', untitled.items[0]?.room_display_name, '群聊');
    const lonely = await search(db, owner, { scope: 'all', query: '孤立单聊标记' });
    checkEqual('无对端 direct 展示名回退', lonely.items[0]?.room_display_name, '单聊');

    const foreignForOwner = await search(db, owner, { scope: 'all', query: '非成员标记' });
    checkEqual('非成员房间不泄露给 owner', foreignForOwner.items.length, 0);
    const foreignForOutsider = await search(db, outsider, { scope: 'all', query: '非成员标记' });
    checkEqual(
      '非成员本人仍可搜索自己的房间',
      foreignForOutsider.items.map((item) => item.message_id).join(','),
      'msg_f1',
    );

    const beforeJoin = await search(db, peer, { scope: 'all', query: '加入前' });
    checkEqual('from_join 前消息不可见', beforeJoin.items.length, 0);
    const afterJoin = await search(db, peer, { scope: 'all', query: '加入后' });
    checkEqual(
      'from_join 后消息可见',
      afterJoin.items.map((item) => item.message_id).join(','),
      'msg_b2',
    );
    const ownerFull = await search(db, owner, { scope: 'all', query: '加入前' });
    checkEqual(
      'full 语义下同一消息对 owner 可见',
      ownerFull.items.map((item) => item.message_id).join(','),
      'msg_b1',
    );

    const archived = await search(db, owner, { scope: 'all', query: '归档标记' });
    checkEqual(
      '归档上界过滤 archive_head_seq 之后的消息',
      archived.items.map((item) => item.message_id).join(','),
      'msg_a2,msg_a1',
    );

    // 同一毫秒用 message_id DESC 稳定排序。
    insertMessage(sqlite, 'rm_global_direct', 'msg_same_a', 4, '同毫秒 alpha', NOW + 500);
    insertMessage(sqlite, 'rm_global_group', 'msg_same_b', 2, '同毫秒 beta', NOW + 500);
    const sameMs = await search(db, owner, { scope: 'all', query: '同毫秒' });
    checkEqual(
      '全局同毫秒按 message_id DESC 稳定排序',
      sameMs.items.map((item) => item.message_id).join(','),
      'msg_same_b,msg_same_a',
    );

    const first = await search(db, owner, { scope: 'all', query: '全局标记', limit: 1 });
    checkEqual('全局 exact 首页一条', first.items.length, 1);
    checkEqual('全局 exact has_more', first.has_more, true);
    check('全局 exact 返回游标', first.next_cursor !== null, first);
    check(
      '全局游标不超过长度上限',
      (first.next_cursor?.length ?? 0) <= LIMITS.messageSearchCursorMax,
      first.next_cursor,
    );
    const collected: string[] = [];
    let cursor: string | null = null;
    let current = first;
    let guard = 0;
    do {
      collected.push(...current.items.map((item) => item.message_id));
      cursor = current.next_cursor;
      if (!cursor) break;
      current = await search(db, owner, { scope: 'all', query: '全局标记', limit: 1, cursor });
      guard += 1;
    } while (guard < 10);
    checkEqual(
      '全局 exact 分页不重不漏且顺序稳定',
      collected.join(','),
      'msg_b2,msg_g1,msg_d1',
    );
    checkEqual('全局 exact 最后一页 has_more=false', current.has_more, false);

    await expectCode(
      'scope=all 带 room_id 返回 INVALID_ARGUMENT',
      () => search(db, owner, { scope: 'all', room_id: 'rm_global_direct', query: '全局标记' }),
      'INVALID_ARGUMENT',
    );
    await expectCode(
      'scope=room 缺 room_id 返回 INVALID_ARGUMENT',
      () => search(db, owner, { scope: 'room', query: '全局标记' }),
      'INVALID_ARGUMENT',
    );

    const roomPage = await search(db, owner, {
      room_id: 'rm_global_direct',
      query: '全局标记',
    });
    const roomCursorPage = await search(db, owner, {
      room_id: 'rm_global_bounded',
      query: '边界标记',
      limit: 1,
    });
    check('房间分页产生 room 游标', roomCursorPage.next_cursor !== null, roomCursorPage);
    checkEqual('房间结果新增 scope', roomPage.scope, 'room');
    checkEqual(
      '房间结果同一份查询带展示名',
      roomPage.items[0]?.room_display_name,
      '全局 peer',
    );
    await expectCode(
      '房间 exact 游标不能用于全局',
      () =>
        search(db, owner, {
          scope: 'all',
          query: '全局标记',
          cursor: roomCursorPage.next_cursor!,
        }),
      'CURSOR_EXPIRED',
    );
    const globalPage = await search(db, owner, { scope: 'all', query: '全局标记', limit: 1 });
    await expectCode(
      '全局游标不能用于房间',
      () =>
        search(db, owner, {
          room_id: 'rm_global_direct',
          query: '全局标记',
          cursor: globalPage.next_cursor!,
        }),
      'INVALID_ARGUMENT',
    );

    const oldExact = await search(db, owner, {
      room_id: 'rm_global_direct',
      query: '全局标记',
    });
    checkEqual('旧 room exact 调用仍工作', oldExact.items.length, 1);
  } finally {
    sqlite.close();
  }
}

async function cursorInvalidationChecks(): Promise<void> {
  const { sqlite, db, owner } = await fixture();
  try {
    const first = await search(db, owner, { scope: 'all', query: '全局标记', limit: 1 });
    const cursor = first.next_cursor!;
    await expectCode(
      'query 变化使全局游标失效',
      () => search(db, owner, { scope: 'all', query: '同毫秒', cursor }),
      'CURSOR_EXPIRED',
    );
    await expectCode(
      'mode 变化使全局游标失效',
      () => search(db, owner, { scope: 'all', query: '全局标记', mode: 'fuzzy', cursor }),
      'CURSOR_EXPIRED',
    );
    sqlite
      .prepare('UPDATE rooms SET policy_revision = policy_revision + 1 WHERE room_id = ?')
      .run('rm_global_group');
    await expectCode(
      'policy revision 变化使全局游标失效',
      () => search(db, owner, { scope: 'all', query: '全局标记', cursor }),
      'CURSOR_EXPIRED',
    );

    const second = await search(db, owner, { scope: 'all', query: '全局标记', limit: 1 });
    sqlite
      .prepare(
        'UPDATE room_members SET member_generation = member_generation + 1 WHERE room_id = ? AND actor_id = ?',
      )
      .run('rm_global_direct', 'usr_owner');
    await expectCode(
      '成员代次变化使全局游标失效',
      () => search(db, owner, { scope: 'all', query: '全局标记', cursor: second.next_cursor! }),
      'CURSOR_EXPIRED',
    );

    const third = await search(db, owner, { scope: 'all', query: '全局标记', limit: 1 });
    sqlite
      .prepare("UPDATE room_members SET status = 'left' WHERE room_id = ? AND actor_id = ?")
      .run('rm_global_group', 'usr_owner');
    await expectCode(
      '房间集合变化使全局游标失效',
      () => search(db, owner, { scope: 'all', query: '全局标记', cursor: third.next_cursor! }),
      'CURSOR_EXPIRED',
    );
  } finally {
    sqlite.close();
  }
}

async function fuzzyChecks(): Promise<void> {
  const { sqlite, db, owner } = await fixture();
  try {
    const exactMiss = await search(db, owner, { scope: 'all', query: '拉不动' });
    checkEqual('同义词只在 fuzzy 生效', exactMiss.items.length, 0);
    insertMessage(sqlite, 'rm_global_direct', 'msg_syn', 4, '拖拽失效 记录', NOW + 600);
    insertMessage(sqlite, 'rm_global_direct', 'msg_syn_both', 5, '拖拽失效 与 无法拖动', NOW + 610);
    insertMessage(sqlite, 'rm_global_group', 'msg_unrelated', 2, '完全无关的文本', NOW + 620);
    insertMessage(sqlite, 'rm_global_direct', 'msg_syn_spaced', 6, '拖 拽，失 效', NOW + 630);
    insertMessage(sqlite, 'rm_global_direct', 'msg_syn_reverse', 7, '拉不动 记录', NOW + 640);

    const fuzzy = await search(db, owner, { scope: 'all', query: '拉不动', mode: 'fuzzy' });
    checkEqual(
      '全局 fuzzy 同义扩展命中并去重',
      fuzzy.items.map((item) => item.message_id).join(','),
      'msg_syn_reverse,msg_syn_spaced,msg_syn_both,msg_syn',
    );
    const synonymItem = fuzzy.items.find((item) => item.message_id === 'msg_syn');
    check(
      '同义词命中区间指向原文',
      (synonymItem?.match_ranges ?? [])
        .map((range) => synonymItem!.snippet.slice(range.start, range.end))
        .join('') === '拖拽失效',
      synonymItem,
    );
    const spacedItem = fuzzy.items.find((item) => item.message_id === 'msg_syn_spaced');
    checkEqual(
      '同义词按归一化连续子串命中并映射原文区间',
      (spacedItem?.match_ranges ?? [])
        .map((range) => spacedItem!.snippet.slice(range.start, range.end))
        .join(''),
      '拖 拽，失 效',
    );
    const reverseItem = fuzzy.items.find((item) => item.message_id === 'msg_syn_reverse');
    check('同义词反向召回', Boolean(reverseItem), fuzzy.items);
    const unrelated = fuzzy;
    check(
      '同义词扩展不误报无关文本',
      !unrelated.items.some((item) => item.message_id === 'msg_unrelated'),
      unrelated.items,
    );

    insertMessage(
      sqlite,
      'rm_global_direct',
      'msg_syn_false_drag',
      8,
      '拖把拽到门口，失去效力',
      NOW + 650,
    );
    insertMessage(
      sqlite,
      'rm_global_direct',
      'msg_syn_false_release_a',
      9,
      '他发言后布置了作业',
      NOW + 660,
    );
    insertMessage(
      sqlite,
      'rm_global_direct',
      'msg_syn_false_release_b',
      10,
      '上面的线条很长',
      NOW + 670,
    );
    insertMessage(
      sqlite,
      'rm_global_direct',
      'msg_syn_false_error',
      11,
      '错过的误会',
      NOW + 680,
    );
    const drag = await search(db, owner, { scope: 'all', query: '拉不动', mode: 'fuzzy' });
    check(
      '同义词不跨段匹配「拖把拽到门口，失去效力」',
      !drag.items.some((item) => item.message_id === 'msg_syn_false_drag'),
      drag.items,
    );
    const release = await search(db, owner, { scope: 'all', query: '发版', mode: 'fuzzy' });
    check(
      '同义词不跨段匹配「他发言后布置了作业」',
      !release.items.some((item) => item.message_id === 'msg_syn_false_release_a'),
      release.items,
    );
    check(
      '同义词不跨段匹配「上面的线条很长」',
      !release.items.some((item) => item.message_id === 'msg_syn_false_release_b'),
      release.items,
    );
    const error = await search(db, owner, { scope: 'all', query: '报错', mode: 'fuzzy' });
    check(
      '同义词不跨段匹配「错过的误会」',
      !error.items.some((item) => item.message_id === 'msg_syn_false_error'),
      error.items,
    );

    const pages: string[] = [];
    let page = await search(db, owner, {
      scope: 'all',
      query: '全局标记',
      mode: 'fuzzy',
      limit: 1,
    });
    let cursor = page.next_cursor;
    check('全局 fuzzy 首页返回游标', cursor !== null, page);
    if (cursor) {
      const payload = decodeCursor(cursor, 'global:search') as unknown as {
        matcher_version?: string;
      } & CursorPayload;
      checkEqual(
        '全局 fuzzy 游标绑定同义词版本',
        payload.matcher_version,
        FUZZY_CURSOR_VERSION,
      );
      check(
        'fuzzy 游标版本包含词表版本',
        FUZZY_CURSOR_VERSION.includes(MESSAGE_SEARCH_SYNONYM_VERSION),
        FUZZY_CURSOR_VERSION,
      );
      const forged = encodeCursor({
        ...(payload as unknown as Record<string, unknown>),
        matcher_version: FUZZY_MATCHER_VERSION,
      } as unknown as CursorPayload);
      await expectCode(
        '缺少同义词版本的旧 fuzzy 游标失效',
        () =>
          search(db, owner, {
            scope: 'all',
            query: '全局标记',
            mode: 'fuzzy',
            limit: 1,
            cursor: forged,
          }),
        'CURSOR_EXPIRED',
      );
    }
    pages.push(...page.items.map((item) => item.message_id));
    let guard = 0;
    while (cursor && guard < 20) {
      page = await search(db, owner, {
        scope: 'all',
        query: '全局标记',
        mode: 'fuzzy',
        limit: 1,
        cursor,
      });
      pages.push(...page.items.map((item) => item.message_id));
      cursor = page.next_cursor;
      guard += 1;
    }
    checkEqual(
      '全局 fuzzy 分页不重不漏',
      pages.join(','),
      'msg_b2,msg_g1,msg_d1',
    );
    check('全局 fuzzy 结果带对象名', Boolean(page.items[0]?.room_display_name), page.items[0]);
  } finally {
    sqlite.close();
  }
}

async function fuzzyBudgetChecks(): Promise<void> {
  const { sqlite, db, owner } = await fixture();
  try {
    insertRoom(sqlite, {
      roomId: 'rm_global_busy',
      kind: 'group',
      ownerId: 'usr_owner',
      title: '全局预算群',
      headSeq: LIMITS.messageSearchFuzzyScanMax + 1,
    });
    insertMember(sqlite, 'rm_global_busy', 'usr_owner', 'owner', 0);
    insertMessage(
      sqlite,
      'rm_global_busy',
      'msg_budget_hit',
      1,
      '全局预算唯一命中',
      NOW - 1,
    );
    for (let index = 1; index <= LIMITS.messageSearchFuzzyScanMax; index += 1) {
      insertMessage(
        sqlite,
        'rm_global_busy',
        `msg_budget_fill_${index}`,
        index + 1,
        `全局填充 ${index}`,
        NOW + 10_000 + index,
      );
    }
    const first = await search(db, owner, {
      scope: 'all',
      query: '全局预算唯一命中',
      mode: 'fuzzy',
    });
    checkEqual('全局 fuzzy 首页受扫描预算限制', first.items.length, 0);
    checkEqual('全局 fuzzy 首页 scan_limited=true', first.scan_limited, true);
    checkEqual(
      '全局 fuzzy 首页检查候选数等于预算',
      first.scanned_count,
      LIMITS.messageSearchFuzzyScanMax,
    );
    checkEqual('全局 fuzzy 首页 has_more=true', first.has_more, true);
    check('全局 fuzzy 首页返回继续游标', first.next_cursor !== null, first);
    const second = await search(db, owner, {
      scope: 'all',
      query: '全局预算唯一命中',
      mode: 'fuzzy',
      cursor: first.next_cursor!,
    });
    checkEqual(
      '全局 fuzzy 继续页找到更早命中',
      second.items.map((item) => item.message_id).join(','),
      'msg_budget_hit',
    );
  } finally {
    sqlite.close();
  }
}

async function snapshotChecks(): Promise<void> {
  const seed = async () => {
    const state = await fixture();
    insertMessage(state.sqlite, 'rm_global_direct', 'msg_snap_old', 10, '快照标记 最旧', NOW + 100);
    insertMessage(state.sqlite, 'rm_global_direct', 'msg_snap_mid', 11, '快照标记 中间', NOW + 200);
    insertMessage(state.sqlite, 'rm_global_direct', 'msg_snap_new', 12, '快照标记 最新', NOW + 300);
    return state;
  };

  const exact = await seed();
  try {
    const first = await search(exact.db, exact.owner, {
      scope: 'all',
      query: '快照标记',
      limit: 1,
    });
    checkEqual(
      '快照 exact 首页为最新消息',
      first.items.map((item) => item.message_id).join(','),
      'msg_snap_new',
    );
    insertMessage(
      exact.sqlite,
      'rm_global_direct',
      'msg_snap_backfill',
      13,
      '快照标记 迟到',
      NOW + 299,
    );
    insertMessage(
      exact.sqlite,
      'rm_global_direct',
      'msg_snap_future',
      14,
      '快照标记 更新',
      NOW + 400,
    );
    const second = await search(exact.db, exact.owner, {
      scope: 'all',
      query: '快照标记',
      limit: 1,
      cursor: first.next_cursor!,
    });
    checkEqual(
      '快照 exact 第二页排除回填与更新消息',
      second.items.map((item) => item.message_id).join(','),
      'msg_snap_mid',
    );
    const third = await search(exact.db, exact.owner, {
      scope: 'all',
      query: '快照标记',
      limit: 5,
      cursor: second.next_cursor!,
    });
    checkEqual(
      '快照 exact 第三页继续返回快照内消息',
      third.items.map((item) => item.message_id).join(','),
      'msg_snap_old',
    );
    checkEqual('快照 exact 扫描完 has_more=false', third.has_more, false);
  } finally {
    exact.sqlite.close();
  }

  const fuzzy = await seed();
  try {
    const first = await search(fuzzy.db, fuzzy.owner, {
      scope: 'all',
      query: '快照标记',
      mode: 'fuzzy',
      limit: 1,
    });
    checkEqual(
      '快照 fuzzy 首页为最新消息',
      first.items.map((item) => item.message_id).join(','),
      'msg_snap_new',
    );
    insertMessage(
      fuzzy.sqlite,
      'rm_global_direct',
      'msg_snap_backfill',
      13,
      '快照标记 迟到',
      NOW + 299,
    );
    insertMessage(
      fuzzy.sqlite,
      'rm_global_direct',
      'msg_snap_future',
      14,
      '快照标记 更新',
      NOW + 400,
    );
    const second = await search(fuzzy.db, fuzzy.owner, {
      scope: 'all',
      query: '快照标记',
      mode: 'fuzzy',
      limit: 1,
      cursor: first.next_cursor!,
    });
    checkEqual(
      '快照 fuzzy 第二页排除回填与更新消息',
      second.items.map((item) => item.message_id).join(','),
      'msg_snap_mid',
    );
    const third = await search(fuzzy.db, fuzzy.owner, {
      scope: 'all',
      query: '快照标记',
      mode: 'fuzzy',
      limit: 5,
      cursor: second.next_cursor!,
    });
    checkEqual(
      '快照 fuzzy 第三页继续返回快照内消息',
      third.items.map((item) => item.message_id).join(','),
      'msg_snap_old',
    );
    checkEqual('快照 fuzzy 扫描完 has_more=false', third.has_more, false);
  } finally {
    fuzzy.sqlite.close();
  }
}

export async function runMessageSearchGlobalUnitChecks(): Promise<void> {
  await exactGlobalChecks();
  await cursorInvalidationChecks();
  await fuzzyChecks();
  await fuzzyBudgetChecks();
  await snapshotChecks();
  synonymUnitChecks();
}

function synonymUnitChecks(): void {
  const expansions = expandFuzzyQuery('拉不动');
  check('同义词扩展包含拖拽失效', expansions.includes('拖拽失效'), expansions);
  check(
    '同义词扩展不超过上限',
    expansions.length <= LIMITS.messageSearchSynonymExpansionMax,
    expansions,
  );
  check(
    '同义词词项至少两个码点',
    expansions.every((term) => Array.from(term).length >= LIMITS.messageSearchSynonymMinCodePoints),
    expansions,
  );
  checkEqual(
    '模糊匹配顺序原查询优先',
    fuzzySearchTerms('拉不动')[0],
    '拉不动',
  );
  checkEqual('未命中的查询不扩展', expandFuzzyQuery('完全不存在的查询').length, 0);
  checkEqual('单字查询不触发短词泛化', expandFuzzyQuery('慢').length, 0);
  checkEqual('同义词版本号可观测', MESSAGE_SEARCH_SYNONYM_VERSION, 'syn-v1');
  checkEqual(
    'fuzzy 游标版本并入同义词版本',
    FUZZY_CURSOR_VERSION,
    `${FUZZY_MATCHER_VERSION}:${MESSAGE_SEARCH_SYNONYM_VERSION}`,
  );

  const dragQuery = normalizeFuzzyQuery('拉不动');
  checkEqual(
    '同义词不跨段命中「拖把拽到门口，失去效力」',
    findFuzzyMatchWithSynonyms('拖把拽到门口，失去效力', dragQuery),
    null,
  );
  const dragged = findFuzzyMatchWithSynonyms('拖 拽，失 效', dragQuery);
  checkEqual(
    '同义词按归一化连续子串命中',
    dragged === null
      ? ''
      : '拖 拽，失 效'.slice(dragged.ranges[0]!.start, dragged.ranges[0]!.end),
    '拖 拽，失 效',
  );
  checkEqual(
    '同义词反向召回含「拉不动」的消息',
    findFuzzyMatchWithSynonyms('拉不动 记录', normalizeFuzzyQuery('拖拽失效'))?.term,
    '拉不动',
  );

  const releaseQuery = normalizeFuzzyQuery('发版');
  checkEqual(
    '同义词不跨段命中「他发言后布置了作业」',
    findFuzzyMatchWithSynonyms('他发言后布置了作业', releaseQuery),
    null,
  );
  checkEqual(
    '同义词不跨段命中「上面的线条很长」',
    findFuzzyMatchWithSynonyms('上面的线条很长', releaseQuery),
    null,
  );
  checkEqual(
    '同义词不跨段命中「错过的误会」',
    findFuzzyMatchWithSynonyms('错过的误会', normalizeFuzzyQuery('报错')),
    null,
  );
}

/**
 * Phase 4A：消息搜索 FTS5 trigram 单元验收。
 *
 * 不依赖外部服务：直接迁移内存库，经 D1 适配层调用域层搜索。
 * 覆盖迁移结构、回填/触发器同步、>=3 码点走 FTS、1–2 码点回退、
 * CJK/大小写/特殊字符、分页、历史可见性、撤回/删除，
 * 以及真实 SQL 的 EXPLAIN 计划。
 */

import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { decodeCursor } from '../../src/contracts/cursor';
import { LIMITS } from '../../src/contracts/limits';
import {
  buildSearchSnippet,
  findExactRanges,
  findFuzzyMatch,
  normalizeFuzzyQuery,
} from '../../src/contracts/message-search-match';
import { FUZZY_CURSOR_VERSION } from '../../src/contracts/message-search-synonyms';
import { messageSearch } from '../../src/domain/message-search';
import { messageSearchFtsPhrase } from '../../src/domain/message-search-fts';
import { historyList } from '../../src/domain/messages';
import type { Principal } from '../../src/domain/principal';
import { sha256Hex } from '../../src/storage/db';
import { getActor } from '../../src/storage/queries';
import { check, checkEqual } from './harness';

const MIGRATIONS = join(resolve(import.meta.dir, '../..'), 'migrations');
const NOW = 1_700_000_000_000;

interface Fixture {
  sqlite: Database;
  db: D1Database;
  owner: Principal;
  peer: Principal;
  outsider: Principal;
  directRoom: string;
  boundedRoom: string;
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

function insertDirectRoom(sqlite: Database, roomId: string): void {
  sqlite
    .prepare(
      `INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq,
                          events_min_seq, member_seq, last_message_id, created_at, updated_at)
       VALUES (?, 'direct', 'usr_owner', '', ?, 0, 0, 2, NULL, ?, ?)`,
    )
    .run(roomId, `${roomId}|usr_owner|usr_peer`, NOW, NOW);
  for (const actorId of ['usr_owner', 'usr_peer']) {
    sqlite
      .prepare(
        `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq,
                                   last_read_seq, joined_at, role_revision, updated_at)
         VALUES (?, ?, ?, 'active', 0, 0, ?, 1, ?)`,
      )
      .run(roomId, actorId, actorId === 'usr_owner' ? 'owner' : 'member', NOW, NOW);
  }
}

function insertMessage(
  sqlite: Database,
  roomId: string,
  messageId: string,
  seq: number,
  body: string,
): void {
  sqlite
    .prepare(
      `INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq,
                             body, body_bytes, preview, reply_to, root_id, hop,
                             root_invocations_used, created_at)
       VALUES (?, ?, 'usr_owner', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
    )
    .run(
      messageId,
      roomId,
      `client_${messageId}`,
      seq,
      body,
      Buffer.byteLength(body),
      body.slice(0, 40),
      NOW,
    );
}

async function fixture(): Promise<Fixture> {
  const sqlite = new Database(':memory:');
  migrate(sqlite, MIGRATIONS);
  const db = createD1(sqlite);

  insertActor(sqlite, 'usr_owner', '搜索 owner');
  insertActor(sqlite, 'usr_peer', '搜索 peer');
  insertActor(sqlite, 'usr_outsider', '搜索 outsider');

  const directRoom = 'rm_search_direct';
  insertDirectRoom(sqlite, directRoom);
  const bodies = [
    '季度 Alpha 启动会 记录',
    '分页关键词 第一条',
    '分页关键词 第二条',
    '分页关键词 第三条',
    '大小写 Needle 测试',
    '特殊符号 a*b (test) -dash NEAR',
    '待撤回 关键词撤回 正文',
    '大写 ÄBC 边界',
    '引号 "测试" 文本',
  ];
  bodies.forEach((body, index) => {
    insertMessage(sqlite, directRoom, `msg_${index + 1}`, index + 1, body);
  });
  sqlite
    .prepare('UPDATE rooms SET head_seq = ?, last_message_id = ? WHERE room_id = ?')
    .run(bodies.length, `msg_${bodies.length}`, directRoom);

  // from_join 群：owner 看全部，peer 只从 joined_seq=2 起可见。
  const boundedRoom = 'rm_search_bounded';
  sqlite
    .prepare(
      `INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq,
                          events_min_seq, member_seq, last_message_id, member_history_policy,
                          policy_revision, created_at, updated_at)
       VALUES (?, 'group', 'usr_owner', '边界群', NULL, 4, 0, 4, NULL, 'from_join', 1, ?, ?)`,
    )
    .run(boundedRoom, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq,
                                 last_read_seq, joined_at, role_revision, updated_at)
       VALUES (?, 'usr_owner', 'owner', 'active', 0, 0, ?, 1, ?)`,
    )
    .run(boundedRoom, NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq,
                                 last_read_seq, joined_at, role_revision, updated_at)
       VALUES (?, 'usr_peer', 'member', 'active', 2, 0, ?, 1, ?)`,
    )
    .run(boundedRoom, NOW, NOW);
  insertMessage(sqlite, boundedRoom, 'msg_bound_1', 1, '边界关键词 加入前');
  insertMessage(sqlite, boundedRoom, 'msg_bound_3', 3, '边界关键词 加入后一');
  insertMessage(sqlite, boundedRoom, 'msg_bound_4', 4, '边界关键词 加入后二');

  const principal = async (actorId: string): Promise<Principal> => ({
    actor: await getActor(db, actorId),
    credential: null,
    credentialHash: '',
  });
  return {
    sqlite,
    db,
    owner: await principal('usr_owner'),
    peer: await principal('usr_peer'),
    outsider: await principal('usr_outsider'),
    directRoom,
    boundedRoom,
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

function planOf(sqlite: Database, sql: string): string {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join('\n');
}

async function indexChecks(): Promise<void> {
  const { sqlite, db, owner, directRoom } = await fixture();
  try {
    checkEqual(
      '0047 建立 FTS 表',
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'message_search_fts'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
    checkEqual(
      '0047 建立三个同步触发器',
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('message_search_fts_ai', 'message_search_fts_ad', 'message_search_fts_au')",
          )
          .get() as { n: number }
      ).n,
      3,
    );
    checkEqual(
      '0047 回填现有消息',
      (sqlite.prepare('SELECT COUNT(*) AS n FROM message_search_fts').get() as { n: number }).n,
      12,
    );

    sqlite
      .prepare("UPDATE messages SET body = '索引更新 新词' WHERE message_id = 'msg_2'")
      .run();
    checkEqual(
      'update 触发器移除旧词',
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM message_search_fts WHERE message_search_fts MATCH '\"分页关键词\"'",
          )
          .get() as { n: number }
      ).n,
      2,
    );
    checkEqual(
      'update 触发器写入新词',
      (
        sqlite
          .prepare(
            "SELECT COUNT(*) AS n FROM message_search_fts WHERE message_search_fts MATCH '\"索引更新\"'",
          )
          .get() as { n: number }
      ).n,
      1,
    );
    sqlite.prepare("UPDATE messages SET body = '分页关键词 第一条' WHERE message_id = 'msg_2'").run();

    // 回滚开关关闭时仍使用旧路径，结果与 FTS 路径一致。
    const withFts = await messageSearch(db, owner, {
      room_id: directRoom,
      query: '启动会',
    });
    const withoutFts = await messageSearch(
      db,
      owner,
      { room_id: directRoom, query: '启动会' },
      { ftsEnabled: false },
    );
    checkEqual(
      '关闭 FTS 开关回退旧路径',
      JSON.stringify(withoutFts),
      JSON.stringify(withFts),
    );
    checkEqual('2 码点不生成 FTS 短语', messageSearchFtsPhrase('启动'), null);
    checkEqual('3 码点生成短语', messageSearchFtsPhrase('启动会'), '"启动会"');
    checkEqual('关闭时不生成短语', messageSearchFtsPhrase('启动会', false), null);
    checkEqual('短语转义双引号', messageSearchFtsPhrase('a"b'), '"a""b"');
  } finally {
    sqlite.close();
  }
}

async function searchChecks(): Promise<void> {
  const { sqlite, db, owner, peer, outsider, directRoom, boundedRoom } = await fixture();
  try {
    const search = (query: string, extra: { limit?: number; cursor?: string } = {}) =>
      messageSearch(db, owner, { room_id: directRoom, query, ...extra });

    const cjk = await search('启动会');
    checkEqual('3 字 CJK 命中', cjk.items.map((item) => item.message_id).join(','), 'msg_1');
    check('CJK snippet 含命中片段', cjk.items[0]?.snippet.includes('启动会'), cjk.items[0]?.snippet);

    const short = await search('启动');
    checkEqual('2 字 CJK 回退命中', short.items.map((item) => item.message_id).join(','), 'msg_1');

    const upper = await search('NEEDLE');
    checkEqual('ASCII 大小写不敏感', upper.items.map((item) => item.message_id).join(','), 'msg_5');

    const quoted = await search('"测试"');
    checkEqual('引号按字面短语命中', quoted.items.map((item) => item.message_id).join(','), 'msg_9');
    for (const query of ['a*b', '(test)', '-dash', 'NEAR']) {
      const result = await search(query);
      checkEqual(`FTS 特殊字符按字面处理 ${query}`, result.items.length, 1);
    }
    checkEqual('未知关键词空态', (await search('不存在词')).items.length, 0);

    // 旧路径对非 ASCII 大小写不折叠；FTS 多匹配时也必须由 instr 过滤回同一集合。
    checkEqual('Unicode 大小写保持旧语义', (await search('äbc')).items.length, 0);

    const pages: string[] = [];
    let cursor: string | undefined;
    let guard = 0;
    let lastHasMore = true;
    while (guard < 5) {
      const page = await search('分页关键词', { limit: 1, ...(cursor ? { cursor } : {}) });
      pages.push(...page.items.map((item) => item.message_id));
      lastHasMore = page.has_more;
      cursor = page.next_cursor ?? undefined;
      guard += 1;
      if (!cursor) break;
    }
    checkEqual('分页顺序与去重', pages.join(','), 'msg_4,msg_3,msg_2');
    checkEqual('最后一页 has_more=false', lastHasMore, false);

    for (const query of ['启动会', '启动', 'NEEDLE', '分页关键词', 'a*b', 'äbc', '不存在词']) {
      const fts = await search(query);
      const fallback = await messageSearch(
        db,
        owner,
        { room_id: directRoom, query },
        { ftsEnabled: false },
      );
      checkEqual(`FTS 与旧路径结果一致 ${query}`, JSON.stringify(fts), JSON.stringify(fallback));
    }

    const ownerBounded = await messageSearch(db, owner, {
      room_id: boundedRoom,
      query: '边界关',
    });
    const peerBounded = await messageSearch(db, peer, {
      room_id: boundedRoom,
      query: '边界关',
    });
    checkEqual(
      'owner 可见全部边界消息',
      ownerBounded.items.map((item) => item.message_id).join(','),
      'msg_bound_4,msg_bound_3,msg_bound_1',
    );
    checkEqual(
      'from_join 成员搜索不越界',
      peerBounded.items.map((item) => item.message_id).join(','),
      'msg_bound_4,msg_bound_3',
    );
    await expectCode(
      '非成员搜索被拒绝',
      () => messageSearch(db, outsider, { room_id: directRoom, query: '启动会' }),
      'NOT_MEMBER',
    );

    sqlite
      .prepare(
        "UPDATE messages SET body = '', body_bytes = 0, preview = '此消息已撤回' WHERE message_id = 'msg_7'",
      )
      .run();
    checkEqual('撤回后不可搜索', (await search('关键词撤')).items.length, 0);
    sqlite.prepare("DELETE FROM messages WHERE message_id = 'msg_6'").run();
    checkEqual('删除后不可搜索', (await search('a*b')).items.length, 0);
    checkEqual(
      '删除同步索引行数',
      (sqlite.prepare('SELECT COUNT(*) AS n FROM message_search_fts').get() as { n: number }).n,
      11,
    );

  } finally {
    sqlite.close();
  }
}

async function planChecks(): Promise<void> {
  const { sqlite, db, owner, directRoom } = await fixture();
  try {
    const statements: string[] = [];
    const recording = {
      prepare(sql: string) {
        statements.push(sql);
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
      exec: db.exec.bind(db),
    } as D1Database;

    await messageSearch(recording, owner, { room_id: directRoom, query: '启动会' });
    const ftsSql = statements.at(-1) ?? '';
    check('FTS 查询包含 trigram 索引', ftsSql.includes('message_search_fts MATCH'));
    const ftsPlan = planOf(sqlite, ftsSql);
    check('FTS 查询走虚拟表索引', ftsPlan.includes('SCAN message_search_fts VIRTUAL TABLE INDEX'), ftsPlan);
    check(
      'FTS 查询按房间序号索引排序',
      ftsPlan.includes('SEARCH m USING INDEX idx_messages_room_seq'),
      ftsPlan,
    );


    statements.length = 0;
    await messageSearch(recording, owner, { room_id: directRoom, query: '启动' });
    const instrSql = statements.at(-1) ?? '';
    check('1–2 字不引用 FTS 表', !instrSql.includes('message_search_fts'));
    check('1–2 字使用 instr 条件', instrSql.includes('instr(lower(m.body), lower(?))'));
    const instrPlan = planOf(sqlite, instrSql);
    check(
      '1–2 字走房间序号索引',
      instrPlan.includes('SEARCH m USING INDEX idx_messages_room_seq'),
      instrPlan,
    );

    // 10k 消息的大房间：验证唯一命中仍走 FTS，而不是扫描整间房。
    const bigRoom = 'rm_search_big';
    insertDirectRoom(sqlite, bigRoom);
    const insert = sqlite.prepare(
      `INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq,
                             body, body_bytes, preview, reply_to, root_id, hop,
                             root_invocations_used, created_at)
       VALUES (?, ?, 'usr_owner', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
    );
    const seed = sqlite.transaction(() => {
      for (let index = 1; index <= 10_000; index += 1) {
        const body =
          index === 9_999
            ? '大房间 独特检索词 命中'
            : `大房间 普通记录 ${index} lorem ipsum dolor sit amet`;
        insert.run(
          `msg_big_${index}`,
          bigRoom,
          `client_big_${index}`,
          index,
          body,
          Buffer.byteLength(body),
          body.slice(0, 40),
          NOW,
        );
      }
    });
    seed();
    sqlite.prepare('UPDATE rooms SET head_seq = ? WHERE room_id = ?').run(10_000, bigRoom);

    statements.length = 0;
    const started = performance.now();
    const big = await messageSearch(recording, owner, {
      room_id: bigRoom,
      query: '独特检索词',
      limit: LIMITS.messageSearchPageMax,
    });
    const elapsed = performance.now() - started;
    checkEqual('10k 房间 FTS 命中唯一消息', big.items.map((item) => item.message_id).join(','), 'msg_big_9999');
    const bigSql = statements.at(-1) ?? '';
    const bigPlan = planOf(sqlite, bigSql);
    check(
      '10k 房间 FTS 查询走索引',
      bigPlan.includes('SCAN message_search_fts VIRTUAL TABLE INDEX'),
      bigPlan,
    );
    check('10k 房间查询未全表扫描 messages', !bigPlan.includes('SCAN m '), bigPlan);
    console.log(`  · 10k 消息 FTS 查询耗时 ${elapsed.toFixed(2)}ms（含 D1 适配层）`);
  } finally {
    sqlite.close();
  }
}

interface SearchPage {
  items: Array<{
    message_id: string;
    created_seq: number;
    snippet: string;
    match_ranges?: Array<{ start: number; end: number }>;
  }>;
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  mode?: string;
  scan_limited?: boolean;
  scanned_count?: number;
  authorization: {
    policy_revision: number;
    history_from_seq: string;
    member_generation: string;
  };
}

interface HistoryPageShape {
  items: Array<{
    message_id: string;
    created_seq: string;
    sender_kind: string | null;
    mentions: unknown[];
    delivery_states: Record<string, number>;
  }>;
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  head_seq: string;
  anchor_window?: { message_id: string; has_older: boolean; has_newer: boolean };
  timeline_items?: Array<{ kind: string; message_id?: string; created_seq?: string }>;
  timeline_next_cursor?: string | null;
  timeline_has_more?: boolean;
  timeline_resume_cursor?: string;
}

async function fuzzyChecks(): Promise<void> {
  const { sqlite, db, owner, outsider, directRoom } = await fixture();
  try {
    const search = (query: string, extra: Record<string, unknown> = {}) =>
      messageSearch(db, owner, { room_id: directRoom, query, mode: 'fuzzy', ...extra }) as Promise<SearchPage>;
    const exact = (query: string, extra: Record<string, unknown> = {}) =>
      messageSearch(db, owner, { room_id: directRoom, query, ...extra }) as Promise<SearchPage>;

    // 追加语义样例消息；head 同步推进，保持快照覆盖。
    const addMessage = (messageId: string, seq: number, body: string) => {
      sqlite
        .prepare(
          `INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq,
                                 body, body_bytes, preview, reply_to, root_id, hop,
                                 root_invocations_used, created_at)
           VALUES (?, ?, 'usr_owner', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
        )
        .run(messageId, directRoom, `client_${messageId}`, seq, body, Buffer.byteLength(body), body.slice(0, 40), NOW);
    };
    addMessage('msg_fuzzy_foo', 10, 'xx fOO bar yy');
    addMessage('msg_fuzzy_release', 11, '发布新版本 记录');
    addMessage('msg_fuzzy_hello', 12, 'Hello，new WORLD!');
    addMessage('msg_fuzzy_full', 13, 'a---b c');
    addMessage('msg_emoji', 14, '🙂--A');
    addMessage('msg_fuzzy_recall', 15, '发版 待撤回');
    sqlite.prepare('UPDATE rooms SET head_seq = 15 WHERE room_id = ?').run(directRoom);

    // 语义样例：exact 保持连续原文，fuzzy 走保序子序列。
    const exactContinuous = await exact('Foo bar');
    checkEqual('exact 保持连续子串语义', exactContinuous.items.length, 1);
    checkEqual('exact 不做全角折叠', (await exact('ＡＢＣ')).items.length, 0);
    checkEqual('exact 不折叠非 ASCII 大小写', (await exact('äbc')).items.length, 0);
    checkEqual('exact 不跨字匹配（发本）', (await exact('发本')).items.length, 0);
    check(
      'fuzzy 支持跨字子序列（发本）',
      (await search('发本')).items.some((item) => item.message_id === 'msg_fuzzy_release'),
      await search('发本'),
    );

    const chinese = await search('发版');
    checkEqual(
      'fuzzy 中文跨字命中',
      chinese.items.map((item) => item.message_id).join(','),
      'msg_fuzzy_recall,msg_fuzzy_release',
    );
    checkEqual('fuzzy 输出 mode', chinese.mode, 'fuzzy');
    checkEqual('fuzzy scan_limited=false（全部扫描完）', chinese.scan_limited, false);
    checkEqual('fuzzy scanned_count 为已检查候选数', chinese.scanned_count, 15);
    check(
      'fuzzy match_ranges 指向 snippet 内的原文',
      (chinese.items[1]?.match_ranges ?? []).map((range) =>
        chinese.items[1]!.snippet.slice(range.start, range.end),
      ).join('') === '发版',
      chinese.items[1],
    );

    const caseAndSpace = await search('hello world');
    checkEqual('fuzzy 折叠空白/标点与 ASCII 大小写', caseAndSpace.items.length, 1);
    const fullwidth = await search('Ａ，Ｂ　Ｃ');
    checkEqual('fuzzy 折叠全角 ASCII/全角空格/标点', fullwidth.items.length, 1);

    checkEqual('fuzzy 不要求连续原句（foo bar）', (await search('foo bar')).items.length, 1);
    checkEqual('fuzzy 反序不命中', findFuzzyMatch('bar foo', normalizeFuzzyQuery('foo bar')), null);
    checkEqual('fuzzy 重复字符需要不同位置', findFuzzyMatch('a', normalizeFuzzyQuery('aa')), null);
    checkEqual('fuzzy 不误报明显无关文本', (await search('完全无关且不存在的查询词')).items.length, 0);

    // 纯函数片段边界：长上下文、分散链与 emoji 不越界、不拆代理对。
    const longBody = `${'前'.repeat(300)}发${'x'.repeat(500)}版${'后'.repeat(300)}`;
    const longPositions = findFuzzyMatch(longBody, normalizeFuzzyQuery('发版'))!;
    const longSnippet = buildSearchSnippet(longBody, longPositions, 240, 40);
    check(
      'fuzzy 片段不超过 240 码点',
      Array.from(longSnippet.snippet).length <= LIMITS.messageSearchSnippetChars,
      Array.from(longSnippet.snippet).length,
    );
    check(
      'fuzzy 分散链只高亮窗口内首段',
      longSnippet.match_ranges.every(
        (range) =>
          range.start >= 0 &&
          range.end <= longSnippet.snippet.length &&
          longSnippet.snippet.slice(range.start, range.end) === '发',
      ),
      longSnippet,
    );
    const emojiBody = `${'😀'.repeat(60)}发${'😀'.repeat(60)}版`;
    const emojiPositions = findFuzzyMatch(emojiBody, normalizeFuzzyQuery('发版'))!;
    const emojiSnippet = buildSearchSnippet(emojiBody, emojiPositions, 240, 40);
    check(
      'fuzzy 片段不拆代理对',
      emojiSnippet.match_ranges.every((range) => {
        const text = emojiSnippet.snippet.slice(range.start, range.end);
        return text === '发' || text === '版';
      }) && Array.from(emojiSnippet.snippet).every((char) => char !== '\uFFFD'),
      emojiSnippet.match_ranges,
    );
    checkEqual(
      'exact ranges 合并重叠连续命中',
      JSON.stringify(findExactRanges('aaaa', 'aa')),
      JSON.stringify([{ start: 0, end: 4 }]),
    );

    await expectCode(
      'fuzzy 归一化后为空返回 INVALID_ARGUMENT',
      () => search('!!!'),
      'INVALID_ARGUMENT',
    );
    await expectCode(
      'fuzzy 全角标点归一化后为空返回 INVALID_ARGUMENT',
      () => search('！！！？？'),
      'INVALID_ARGUMENT',
    );
    await expectCode(
      '非成员 fuzzy 搜索被拒绝',
      () => messageSearch(db, outsider, { room_id: directRoom, query: '发版', mode: 'fuzzy' }),
      'NOT_MEMBER',
    );

    const emoji = await search('🙂a');
    checkEqual('fuzzy emoji 命中', emoji.items.map((item) => item.message_id).join(','), 'msg_emoji');
    const emojiRanges = emoji.items[0]?.match_ranges ?? [];
    checkEqual(
      'fuzzy emoji range 覆盖完整代理对',
      emojiRanges.map((range) => emoji.items[0]!.snippet.slice(range.start, range.end)).join('|'),
      '🙂|A',
    );

    // 撤回消息不再产生正文命中。
    sqlite
      .prepare(
        "UPDATE messages SET body = '', body_bytes = 0, preview = '此消息已撤回' WHERE message_id = 'msg_fuzzy_recall'",
      )
      .run();
    checkEqual(
      '撤回后 fuzzy 不可搜索',
      (await search('发版')).items.map((item) => item.message_id).join(','),
      'msg_fuzzy_release',
    );

    // exact cursor 的 scope 保持旧格式（哈希与 lower 语义不变）。
    const query = '分页关键词';
    const exactFirst = await exact(query, { limit: 1 });
    check('exact 返回游标', exactFirst.next_cursor !== null, exactFirst);
    const exactScope = `room:${directRoom}:search:g${exactFirst.authorization.member_generation}:p${exactFirst.authorization.policy_revision}:q${await sha256Hex(query.toLowerCase())}`;
    checkEqual(
      'exact cursor scope 保持旧格式',
      decodeCursor(exactFirst.next_cursor!, exactScope).scope,
      exactScope,
    );
    const legacyCursor = exactFirst.next_cursor!;
    const legacyPage = await exact(query, { limit: 5, cursor: legacyCursor });
    check(
      '旧 exact 游标继续可用且只返回更早消息',
      legacyPage.items.every((item) => item.created_seq < Number(JSON.parse(Buffer.from(legacyCursor, 'base64url').toString('utf8')).seq)),
      legacyPage.items,
    );

    // fuzzy cursor 只推进到最后实际检查的候选，并带独立算法版本。
    addMessage('msg_fuzzy_page_1', 16, '发版 一');
    addMessage('msg_fuzzy_page_2', 17, '填充 二');
    addMessage('msg_fuzzy_page_3', 18, '发 布 版');
    sqlite.prepare('UPDATE rooms SET head_seq = 18 WHERE room_id = ?').run(directRoom);

    const fuzzyCursor = (await search('发版', { limit: 1 })).next_cursor;
    check('fuzzy 首页返回继续游标', fuzzyCursor !== null, fuzzyCursor);
    if (fuzzyCursor) {
      const fuzzyScope = `room:${directRoom}:search:g${exactFirst.authorization.member_generation}:p${exactFirst.authorization.policy_revision}:${FUZZY_CURSOR_VERSION}:q${await sha256Hex(normalizeFuzzyQuery('发版'))}`;
      checkEqual(
        'fuzzy cursor scope 带算法版本与归一 query hash',
        decodeCursor(fuzzyCursor, fuzzyScope).scope,
        fuzzyScope,
      );
      await expectCode(
        'exact cursor 不能用于 fuzzy',
        () =>
          messageSearch(db, owner, {
            room_id: directRoom,
            query: '发版',
            mode: 'fuzzy',
            cursor: legacyCursor,
          }),
        'CURSOR_EXPIRED',
      );
      await expectCode(
        'fuzzy cursor 不能用于 exact',
        () =>
          messageSearch(db, owner, {
            room_id: directRoom,
            query: '发版',
            cursor: fuzzyCursor,
          }),
        'CURSOR_EXPIRED',
      );
    }
    // 未命中的空批仍可继续；结果只为命中消息。
    const fuzzyPages: string[] = [];
    let fuzzyNext: string | null = null;
    let fuzzyPage = await search('发版', { limit: 1 });
    fuzzyPages.push(...fuzzyPage.items.map((item) => item.message_id));
    fuzzyNext = fuzzyPage.next_cursor;
    let guard = 0;
    while (fuzzyNext && guard < 10) {
      fuzzyPage = await search('发版', { limit: 1, cursor: fuzzyNext });
      fuzzyPages.push(...fuzzyPage.items.map((item) => item.message_id));
      fuzzyNext = fuzzyPage.next_cursor;
      guard += 1;
    }
    checkEqual(
      'fuzzy 分页不重不漏且按序号倒序',
      fuzzyPages.join(','),
      'msg_fuzzy_page_3,msg_fuzzy_page_1,msg_fuzzy_release',
    );
    checkEqual(
      'fuzzy 分页结果与单页结果一致',
      fuzzyPages.join(','),
      (await search('发版')).items.map((item) => item.message_id).join(','),
    );
    check('fuzzy 分页遍历后无继续游标', fuzzyNext === null, fuzzyNext);
  } finally {
    sqlite.close();
  }
}

async function fuzzyBudgetChecks(): Promise<void> {
  const { sqlite, db, owner } = await fixture();
  try {
    const roomId = 'rm_fuzzy_budget';
    insertDirectRoom(sqlite, roomId);
    insertMessage(sqlite, roomId, 'msg_budget_hit', 1, '预算 发版 命中');
    for (let index = 2; index <= 502; index += 1) {
      insertMessage(sqlite, roomId, `msg_budget_${index}`, index, `填充 消息 ${index}`);
    }
    sqlite.prepare('UPDATE rooms SET head_seq = 502 WHERE room_id = ?').run(roomId);

    const first = (await messageSearch(db, owner, {
      room_id: roomId,
      query: '发版',
      mode: 'fuzzy',
      limit: 25,
    })) as SearchPage;
    checkEqual('fuzzy 扫描预算首页空结果', first.items.length, 0);
    checkEqual('fuzzy 扫描预算首页 scan_limited', first.scan_limited, true);
    checkEqual(
      'fuzzy 扫描预算首页检查 500 条候选',
      first.scanned_count,
      LIMITS.messageSearchFuzzyScanMax,
    );
    checkEqual('fuzzy 扫描预算首页 has_more', first.has_more, true);
    check('fuzzy 扫描预算首页返回继续游标', first.next_cursor !== null, first);
    const second = (await messageSearch(db, owner, {
      room_id: roomId,
      query: '发版',
      mode: 'fuzzy',
      limit: 25,
      cursor: first.next_cursor!,
    })) as SearchPage;
    checkEqual(
      'fuzzy 空批继续后找到更旧命中',
      second.items.map((item) => item.message_id).join(','),
      'msg_budget_hit',
    );
    checkEqual('fuzzy 找到命中后 scan_limited=false', second.scan_limited, false);
    checkEqual('fuzzy 找到命中后 has_more=false', second.has_more, false);
    checkEqual('fuzzy 第二页只检查剩余候选', second.scanned_count, 2);

    // 正文字节预算：9 条 250KiB 正文，一页最多处理 8 条。
    const bytesRoom = 'rm_fuzzy_bytes';
    insertDirectRoom(sqlite, bytesRoom);
    const huge = 'x'.repeat(250 * 1024);
    insertMessage(sqlite, bytesRoom, 'msg_bytes_hit', 1, '发版 字节命中');
    for (let index = 2; index <= 10; index += 1) {
      insertMessage(sqlite, bytesRoom, `msg_bytes_${index}`, index, huge);
    }
    sqlite.prepare('UPDATE rooms SET head_seq = 10 WHERE room_id = ?').run(bytesRoom);
    const bytesFirst = (await messageSearch(db, owner, {
      room_id: bytesRoom,
      query: '发版',
      mode: 'fuzzy',
    })) as SearchPage;
    checkEqual('fuzzy 字节预算首页无命中', bytesFirst.items.length, 0);
    checkEqual('fuzzy 字节预算 scan_limited', bytesFirst.scan_limited, true);
    checkEqual('fuzzy 字节预算最多检查 8 条大正文', bytesFirst.scanned_count, 8);
    const bytesSecond = (await messageSearch(db, owner, {
      room_id: bytesRoom,
      query: '发版',
      mode: 'fuzzy',
      cursor: bytesFirst.next_cursor!,
    })) as SearchPage;
    checkEqual(
      'fuzzy 字节预算续页命中',
      bytesSecond.items.map((item) => item.message_id).join(','),
      'msg_bytes_hit',
    );
    checkEqual('fuzzy 字节预算续页检查 2 条', bytesSecond.scanned_count, 2);

    // exact 不受 fuzzy 预算影响，仍返回连续匹配并标记 has_more。
    const exact = (await messageSearch(db, owner, {
      room_id: bytesRoom,
      query: 'xxx',
      limit: 2,
    })) as SearchPage;
    checkEqual('exact 在超大正文房间仍返回两页结果', exact.items.length, 2);
    checkEqual('exact has_more 表示还有匹配', exact.has_more, true);
    checkEqual('exact scan_limited=false', exact.scan_limited, false);
    checkEqual('exact 不返回 scanned_count', exact.scanned_count, undefined);
  } finally {
    sqlite.close();
  }
}

async function anchorChecks(): Promise<void> {
  const { sqlite, db, owner, peer, outsider, boundedRoom } = await fixture();
  try {
    const roomId = 'rm_anchor';
    insertDirectRoom(sqlite, roomId);
    for (let index = 1; index <= 150; index += 1) {
      insertMessage(sqlite, roomId, `msg_anchor_${index}`, index, `锚点消息 ${index}`);
    }
    sqlite.prepare('UPDATE rooms SET head_seq = 150 WHERE room_id = ?').run(roomId);
    const otherRoom = 'rm_anchor_other';
    insertDirectRoom(sqlite, otherRoom);
    insertMessage(sqlite, otherRoom, 'msg_other_1', 1, '其他房间');
    sqlite.prepare('UPDATE rooms SET head_seq = 1 WHERE room_id = ?').run(otherRoom);

    const page = (await historyList(db, owner, {
      room_id: roomId,
      anchor_message_id: 'msg_anchor_75',
      limit: 50,
    })) as HistoryPageShape;
    const seqs = page.items.map((item) => Number(item.created_seq));
    checkEqual('anchor 窗口总数等于 limit', page.items.length, 50);
    check('anchor 窗口包含目标消息', seqs.includes(75), seqs);
    check('anchor 窗口按序号倒序', seqs.every((seq, index) => index === 0 || seqs[index - 1]! > seq), seqs);
    checkEqual('anchor 窗口两侧都有更多', JSON.stringify(page.anchor_window), JSON.stringify({
      message_id: 'msg_anchor_75',
      has_older: true,
      has_newer: true,
    }));
    checkEqual('anchor has_more 只表示更早侧', page.has_more, true);
    check('anchor next_cursor 指向窗口最旧项', page.next_cursor !== null, page);

    const single = (await historyList(db, owner, {
      room_id: roomId,
      anchor_message_id: 'msg_anchor_75',
      limit: 1,
    })) as HistoryPageShape;
    checkEqual('limit=1 只返回锚点', single.items.map((item) => item.message_id).join(','), 'msg_anchor_75');
    checkEqual('limit=1 still reports both sides', JSON.stringify(single.anchor_window), JSON.stringify({
      message_id: 'msg_anchor_75',
      has_older: true,
      has_newer: true,
    }));

    const full = (await historyList(db, owner, {
      room_id: roomId,
      anchor_message_id: 'msg_anchor_75',
      limit: 100,
    })) as HistoryPageShape;
    checkEqual('anchor limit 为总窗口上限', full.items.length, 100);
    checkEqual('anchor 窗口上限内不重复', new Set(full.items.map((item) => item.message_id)).size, 100);

    const oldest = (await historyList(db, owner, {
      room_id: roomId,
      anchor_message_id: 'msg_anchor_1',
      limit: 50,
    })) as HistoryPageShape;
    checkEqual('最旧锚点 has_older=false', oldest.anchor_window?.has_older, false);
    checkEqual('最旧锚点 has_more=false', oldest.has_more, false);
    checkEqual('最旧锚点 next_cursor=null', oldest.next_cursor, null);
    checkEqual('最旧锚点 has_newer=true', oldest.anchor_window?.has_newer, true);

    const newest = (await historyList(db, owner, {
      room_id: roomId,
      anchor_message_id: 'msg_anchor_150',
      limit: 50,
    })) as HistoryPageShape;
    checkEqual('最新锚点 has_newer=false', newest.anchor_window?.has_newer, false);
    checkEqual('最新锚点 has_older=true', newest.anchor_window?.has_older, true);

    const olderPage = (await historyList(db, owner, {
      room_id: roomId,
      cursor: page.next_cursor!,
      limit: 50,
    })) as HistoryPageShape;
    const windowSeqs = new Set(seqs);
    check(
      'anchor 游标继续更早页且不重复',
      olderPage.items.every((item) => !windowSeqs.has(Number(item.created_seq))),
      olderPage.items.map((item) => item.created_seq),
    );
    check(
      'anchor 更早页序号继续下降',
      olderPage.items.every((item, index, items) => index === 0 || Number(items[index - 1]!.created_seq) > Number(item.created_seq)),
      olderPage.items,
    );

    await expectCode(
      '跨房间 anchor 返回 NOT_FOUND',
      () => historyList(db, owner, { room_id: roomId, anchor_message_id: 'msg_other_1' }),
      'NOT_FOUND',
    );
    await expectCode(
      '不存在 anchor 返回 NOT_FOUND',
      () => historyList(db, owner, { room_id: roomId, anchor_message_id: 'msg_missing' }),
      'NOT_FOUND',
    );
    sqlite
      .prepare("UPDATE messages SET body='', body_bytes=0, preview='已撤回' WHERE message_id='msg_anchor_10'")
      .run();
    await expectCode(
      '撤回消息不能作为 anchor',
      () => historyList(db, owner, { room_id: roomId, anchor_message_id: 'msg_anchor_10' }),
      'NOT_FOUND',
    );
    await expectCode(
      'anchor 与 cursor 互斥',
      () =>
        historyList(db, owner, {
          room_id: roomId,
          anchor_message_id: 'msg_anchor_75',
          cursor: page.next_cursor!,
        }),
      'INVALID_ARGUMENT',
    );
    await expectCode(
      'anchor 不允许 direction=after',
      () =>
        historyList(db, owner, {
          room_id: roomId,
          anchor_message_id: 'msg_anchor_75',
          direction: 'after',
        }),
      'INVALID_ARGUMENT',
    );
    await expectCode(
      '非成员 anchor 搜索被拒绝',
      () => historyList(db, outsider, { room_id: roomId, anchor_message_id: 'msg_anchor_75' }),
      'NOT_MEMBER',
    );
    await expectCode(
      'from_join 之前的 anchor 返回 NOT_FOUND',
      () =>
        historyList(db, peer, {
          room_id: boundedRoom,
          anchor_message_id: 'msg_bound_1',
        }),
      'NOT_FOUND',
    );
    const boundedAnchor = (await historyList(db, peer, {
      room_id: boundedRoom,
      anchor_message_id: 'msg_bound_3',
      limit: 3,
    })) as HistoryPageShape;
    check(
      'from_join 之后的 anchor 可见',
      boundedAnchor.items.some((item) => item.message_id === 'msg_bound_3'),
      boundedAnchor.items,
    );

    const timeline = (await historyList(db, owner, {
      room_id: roomId,
      view: 'timeline',
      anchor_message_id: 'msg_anchor_75',
      limit: 50,
    })) as HistoryPageShape;
    const timelineIds = (timeline.timeline_items ?? []).map((item) => item.message_id);
    checkEqual('timeline anchor 窗口总数等于 limit', timelineIds.length, 50);
    check('timeline anchor 包含目标消息', timelineIds.includes('msg_anchor_75'), timelineIds);
    check(
      'timeline anchor 按展示 key 倒序',
      (timeline.timeline_items ?? []).every((item, index, items) => {
        if (index === 0) return true;
        const previous = Number(items[index - 1]!.created_seq ?? 0);
        const current = Number(item.created_seq ?? 0);
        return previous > current;
      }),
      timeline.timeline_items,
    );
    checkEqual('timeline anchor_window 两侧更多', JSON.stringify(timeline.anchor_window), JSON.stringify({
      message_id: 'msg_anchor_75',
      has_older: true,
      has_newer: true,
    }));
    checkEqual('timeline has_more 只表示更早侧', timeline.timeline_has_more, true);
    check('timeline next_cursor 指向窗口最旧项', timeline.timeline_next_cursor !== null, timeline);
    check('timeline resume cursor 仍存在', (timeline.timeline_resume_cursor ?? '').length > 0, timeline);

    await expectCode(
      'timeline anchor 与 after 互斥',
      () =>
        historyList(db, owner, {
          room_id: roomId,
          view: 'timeline',
          anchor_message_id: 'msg_anchor_75',
          direction: 'after',
        }),
      'INVALID_ARGUMENT',
    );
    await expectCode(
      '非成员 timeline anchor 被拒绝',
      () =>
        historyList(db, outsider, {
          room_id: roomId,
          view: 'timeline',
          anchor_message_id: 'msg_anchor_75',
        }),
      'NOT_MEMBER',
    );
  } finally {
    sqlite.close();
  }
}

export async function runMessageSearchFtsUnitChecks(): Promise<void> {
  await indexChecks();
  await searchChecks();
  await planChecks();
  await fuzzyChecks();
  await fuzzyBudgetChecks();
  await anchorChecks();
}

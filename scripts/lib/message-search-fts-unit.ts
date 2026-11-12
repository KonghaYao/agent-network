/**
 * Phase 4A：消息搜索 FTS5 trigram 单元验收。
 *
 * 不依赖外部服务：直接迁移内存库，经 D1 适配层调用域层搜索。
 * 覆盖迁移结构、回填/触发器同步、>=3 码点走 FTS、1–2 码点回退、
 * CJK/大小写/特殊字符、分页、历史可见性、撤回/删除、Task 搜索，
 * 以及真实 SQL 的 EXPLAIN 计划。
 */

import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { LIMITS } from '../../src/contracts/limits';
import { messageSearch } from '../../src/domain/message-search';
import { messageSearchFtsPhrase } from '../../src/domain/message-search-fts';
import { messageTaskSearch } from '../../src/domain/message-task-search';
import type { Principal } from '../../src/domain/principal';
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

    sqlite
      .prepare(
        "UPDATE messages SET task_root_id = message_id, task_marked_by = 'usr_owner', task_marked_at = ? WHERE message_id = 'msg_1'",
      )
      .run(NOW);
    const taskHit = await messageTaskSearch(db, owner, {
      room_id: directRoom,
      query: '启动会',
    });
    checkEqual('Task 搜索 >=3 字命中根消息', taskHit.items[0]?.task.root_message_id, 'msg_1');
    checkEqual('Task 搜索仅返回命中根', taskHit.items.length, 1);
    const taskShort = await messageTaskSearch(db, owner, {
      room_id: directRoom,
      query: '启动',
    });
    checkEqual(
      'Task 搜索 2 字回退结果一致',
      taskShort.items.map((item) => item.task.root_message_id).join(','),
      taskHit.items.map((item) => item.task.root_message_id).join(','),
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
    await messageTaskSearch(recording, owner, { room_id: directRoom, query: '启动会' });
    const taskSql = statements.find((sql) => sql.includes('matched AS')) ?? '';
    check('Task 搜索包含 FTS 子查询', taskSql.includes('message_search_fts MATCH'));
    const taskPlan = planOf(sqlite, taskSql);
    check(
      'Task 搜索走虚拟表索引',
      taskPlan.includes('SCAN message_search_fts VIRTUAL TABLE INDEX'),
      taskPlan,
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

export async function runMessageSearchFtsUnitChecks(): Promise<void> {
  await indexChecks();
  await searchChecks();
  await planChecks();
}

/**
 * Phase 4A 基准：10k 消息房间的 FTS5 trigram 与旧 instr 路径。
 *
 * 运行：`bun scripts/benchmark-message-search-fts.ts`
 * 输出 EXPLAIN QUERY PLAN、平均/P95 延迟与索引体积，不连接外部服务。
 */

import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { messageSearch } from '../src/domain/message-search';
import type { Principal } from '../src/domain/principal';
import { getActor } from '../src/storage/queries';

const MIGRATIONS = join(resolve(import.meta.dir, '..'), 'migrations');
const NOW = Date.now();
const ROUNDS = 20;

function explain(sqlite: Database, sql: string): string {
  return (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
    .map((row) => row.detail)
    .join('\n');
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

async function main(): Promise<void> {
  const sqlite = new Database(':memory:');
  migrate(sqlite, MIGRATIONS);
  const db = createD1(sqlite);
  sqlite
    .prepare(
      `INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata,
                           inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
       VALUES ('usr_bench', 'human', NULL, 'bench', '{}', 0, 0, 0, ?, ?)`,
    )
    .run(NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq,
                          events_min_seq, member_seq, last_message_id, created_at, updated_at)
       VALUES ('rm_bench', 'direct', 'usr_bench', '', 'bench-pair', 0, 0, 1, NULL, ?, ?)`,
    )
    .run(NOW, NOW);
  sqlite
    .prepare(
      `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq,
                                 last_read_seq, joined_at, role_revision, updated_at)
       VALUES ('rm_bench', 'usr_bench', 'owner', 'active', 0, 0, ?, 1, ?)`,
    )
    .run(NOW, NOW);

  const insert = sqlite.prepare(
    `INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq,
                           body, body_bytes, preview, reply_to, root_id, hop,
                           root_invocations_used, created_at)
     VALUES (?, 'rm_bench', 'usr_bench', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
  );
  const seed = sqlite.transaction(() => {
    for (let index = 1; index <= 10_000; index += 1) {
      const body =
        index === 9_999
          ? '大房间 独特检索词 命中，hello world 记录'
          : `大房间 普通记录 ${index} lorem ipsum dolor sit amet consectetur`;
      insert.run(
        `msg_${index}`,
        `client_${index}`,
        index,
        body,
        Buffer.byteLength(body),
        body.slice(0, 60),
        NOW,
      );
    }
  });
  seed();
  sqlite.prepare("UPDATE rooms SET head_seq = 10000 WHERE room_id = 'rm_bench'").run();
  const principal: Principal = {
    actor: await getActor(db, 'usr_bench'),
    credential: null,
    credentialHash: '',
  };

  const statements: string[] = [];
  const recording = {
    prepare(sql: string) {
      statements.push(sql);
      return db.prepare(sql);
    },
    batch: db.batch.bind(db),
    exec: db.exec.bind(db),
  } as D1Database;
  await messageSearch(recording, principal, { room_id: 'rm_bench', query: '独特检索词' });
  const ftsSql = statements.at(-1) ?? '';
  statements.length = 0;
  await messageSearch(recording, principal, { room_id: 'rm_bench', query: '独特' });
  const instrSql = statements.at(-1) ?? '';

  console.log('== EXPLAIN QUERY PLAN: 3 字 CJK（FTS5）==');
  console.log(explain(sqlite, ftsSql));
  console.log('\n== EXPLAIN QUERY PLAN: 2 字 CJK（instr 回退）==');
  console.log(explain(sqlite, instrSql));

  const measure = async (query: string, ftsEnabled: boolean): Promise<number[]> => {
    const samples: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const started = performance.now();
      await messageSearch(
        db,
        principal,
        { room_id: 'rm_bench', query, limit: 25 },
        { ftsEnabled },
      );
      samples.push(performance.now() - started);
    }
    return samples;
  };
  const report = async (label: string, query: string) => {
    const fts = await measure(query, true);
    const instr = await measure(query, false);
    const average = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    console.log(
      `${label}: 开启 avg ${average(fts).toFixed(3)}ms p95 ${percentile(fts, 0.95).toFixed(3)}ms | ` +
        `关闭(instr) avg ${average(instr).toFixed(3)}ms p95 ${percentile(instr, 0.95).toFixed(3)}ms`,
    );
  };

  console.log('\n== 10k 消息房间延迟（含 D1 适配与游标哈希）==');
  await report('唯一 5 字 CJK', '独特检索词');
  await report('唯一英文短语', 'hello world');
  await report('高频英文短语', 'lorem ipsum');
  await report('2 字 CJK 回退', '独特');

  const ftsBytes = (
    sqlite
      .prepare(
        "SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name LIKE 'message_search_fts%'",
      )
      .get() as { bytes: number }
  ).bytes;
  const messageBytes = (
    sqlite.prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name = 'messages'").get() as {
      bytes: number;
    }
  ).bytes;
  const pageCount = (sqlite.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  const pageSize = (sqlite.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
  const totalBytes = pageCount * pageSize;
  const baseBytes = totalBytes - ftsBytes;
  console.log(
    `\n索引体积: messages ${(messageBytes / 1024 / 1024).toFixed(2)} MiB, ` +
      `message_search_fts ${(ftsBytes / 1024 / 1024).toFixed(2)} MiB ` +
      `(${((ftsBytes / messageBytes) * 100).toFixed(1)}% of messages)`,
  );
  console.log(
    `数据库体积: 无 FTS 基线 ${(baseBytes / 1024 / 1024).toFixed(2)} MiB → ` +
      `${(totalBytes / 1024 / 1024).toFixed(2)} MiB (+${((ftsBytes / baseBytes) * 100).toFixed(1)}%)`,
  );
  sqlite.close();
}

await main();

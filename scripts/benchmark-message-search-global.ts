/**
 * 跨会话全局搜索基准：多房间、每房数千条消息。
 *
 * 运行：`bun scripts/benchmark-message-search-global.ts`
 * 规模可用 `BENCH_ROOMS` / `BENCH_PER_ROOM` / `BENCH_ROUNDS` 覆盖，
 * 默认 4 × 3000。只使用内存 SQLite 与真实域层，输出 global exact/fuzzy 的
 * P50/P95/P99、扫描候选数、游标长度，不打印消息正文或凭据。
 */

import { Database } from 'bun:sqlite';
import { join, resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { LIMITS } from '../src/contracts/limits';
import { messageSearch } from '../src/domain/message-search';
import type { Principal } from '../src/domain/principal';
import { getActor } from '../src/storage/queries';

const MIGRATIONS = join(resolve(import.meta.dir, '..'), 'migrations');
const NOW = Date.now();
const positiveInt = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};
const ROOMS = positiveInt(process.env.BENCH_ROOMS, 4);
const PER_ROOM = positiveInt(process.env.BENCH_PER_ROOM, 3_000);
const ROUNDS = positiveInt(process.env.BENCH_ROUNDS, 15);

interface SearchPage {
  items: Array<{ message_id: string }>;
  next_cursor: string | null;
  has_more: boolean;
  scanned_count?: number;
  scan_limited?: boolean;
}

function percentile(values: number[], ratio: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function latency(values: number[]): string {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return `avg ${average.toFixed(2)}ms p50 ${percentile(values, 0.5).toFixed(2)}ms ` +
    `p95 ${percentile(values, 0.95).toFixed(2)}ms p99 ${percentile(values, 0.99).toFixed(2)}ms`;
}

async function main(): Promise<void> {
  const sqlite = new Database(':memory:');
  migrate(sqlite, MIGRATIONS);
  const db = createD1(sqlite);
  sqlite
    .prepare(
      `INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata,
                           inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
       VALUES ('usr_bench', 'human', NULL, 'global bench', '{}', 0, 0, 0, ?, ?)`,
    )
    .run(NOW, NOW);

  const insertRoom = sqlite.prepare(
    `INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key, head_seq,
                        events_min_seq, member_seq, last_message_id, created_at, updated_at)
     VALUES (?, 'direct', 'usr_bench', '', ?, 0, 0, 1, NULL, ?, ?)`,
  );
  const insertMember = sqlite.prepare(
    `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq,
                               last_read_seq, joined_at, role_revision, updated_at)
     VALUES (?, 'usr_bench', 'owner', 'active', 0, 0, ?, 1, ?)`,
  );
  const insertMessage = sqlite.prepare(
    `INSERT INTO messages (message_id, room_id, sender_id, client_message_id, created_seq,
                           body, body_bytes, preview, reply_to, root_id, hop,
                           root_invocations_used, created_at)
     VALUES (?, ?, 'usr_bench', ?, ?, ?, ?, ?, NULL, NULL, 0, 0, ?)`,
  );

  const seed = sqlite.transaction(() => {
    for (let roomIndex = 0; roomIndex < ROOMS; roomIndex += 1) {
      const roomId = `rm_bench_global_${roomIndex}`;
      insertRoom.run(roomId, `bench-pair-${roomIndex}`, NOW, NOW);
      insertMember.run(roomId, NOW, NOW);
      for (let seq = 1; seq <= PER_ROOM; seq += 1) {
        let body = `普通记录 ${roomIndex}-${seq} lorem ipsum dolor sit amet`;
        if (seq % 100 === 0) body = `高频 共同词 ${roomIndex}-${seq}`;
        if (roomIndex === 1 && seq === PER_ROOM) body = '拖拽失效 记录 同义词';
        if (roomIndex === 2 && seq === PER_ROOM) body = '跨房唯一检索词 命中';
        const createdAt = NOW - ((PER_ROOM - seq) * ROOMS + (ROOMS - 1 - roomIndex));
        insertMessage.run(
          `msg_g_${roomIndex}_${seq}`,
          roomId,
          `client_g_${roomIndex}_${seq}`,
          seq,
          body,
          Buffer.byteLength(body),
          body.slice(0, 60),
          createdAt,
        );
      }
      sqlite.prepare('UPDATE rooms SET head_seq = ? WHERE room_id = ?').run(PER_ROOM, roomId);
    }
  });
  seed();

  const principal: Principal = {
    actor: await getActor(db, 'usr_bench'),
    credential: null,
    credentialHash: '',
  };

  const measure = async (
    input: { query: string; mode?: 'exact' | 'fuzzy'; limit?: number; cursor?: string },
    options: { ftsEnabled?: boolean } = {},
  ): Promise<{ samples: number[]; page: SearchPage }> => {
    const samples: number[] = [];
    let page: SearchPage = { items: [], next_cursor: null, has_more: false };
    for (let round = 0; round < ROUNDS; round += 1) {
      const started = performance.now();
      page = (await messageSearch(db, principal, { scope: 'all', ...input }, options)) as SearchPage;
      samples.push(performance.now() - started);
    }
    return { samples, page };
  };

  console.log(`== 全局搜索基准（${ROOMS} 房间 × ${PER_ROOM} 条 = ${ROOMS * PER_ROOM} 条）==`);
  console.log('\n== exact ==');
  const unique = await measure({ query: '跨房唯一检索词' });
  console.log(
    `唯一 7 字 CJK（FTS）: ${latency(unique.samples)}, items ${unique.page.items.length}, ` +
      `cursor ${unique.page.next_cursor?.length ?? 0} B`,
  );
  const frequent = await measure({ query: '共同词' });
  console.log(`高频 3 字 CJK（FTS 多命中）: ${latency(frequent.samples)}, items ${frequent.page.items.length}`);
  const instr = await measure({ query: '高频' });
  console.log(`2 字 CJK（instr 回退）: ${latency(instr.samples)}, items ${instr.page.items.length}`);
  const noFts = await measure({ query: '跨房唯一检索词' }, { ftsEnabled: false });
  console.log(`唯一 7 字 CJK（关闭 FTS）: ${latency(noFts.samples)}, items ${noFts.page.items.length}`);

  console.log('\n== fuzzy（全局时间切片，500 候选 / 2 MiB 预算）==');
  const sparse = await measure({ query: '跨房索词', mode: 'fuzzy' });
  console.log(
    `稀疏命中: ${latency(sparse.samples)}, items ${sparse.page.items.length}, ` +
      `scanned ${sparse.page.scanned_count ?? 0}, scan_limited ${String(sparse.page.scan_limited)}`,
  );
  const dense = await measure({ query: '普通记录', mode: 'fuzzy', limit: 25 });
  console.log(
    `密集命中: ${latency(dense.samples)}, items ${dense.page.items.length}, ` +
      `scanned ${dense.page.scanned_count ?? 0}, scan_limited ${String(dense.page.scan_limited)}`,
  );
  const synonym = await measure({ query: '拉不动', mode: 'fuzzy' });
  console.log(
    `同义词命中（拉不动 → 拖拽失效）: ${latency(synonym.samples)}, items ${synonym.page.items.length}, ` +
      `scanned ${synonym.page.scanned_count ?? 0}, scan_limited ${String(synonym.page.scan_limited)}`,
  );
  const exhausted = await measure({ query: '完全不存在的模糊词', mode: 'fuzzy' });
  console.log(
    `无命中扫描预算: ${latency(exhausted.samples)}, items ${exhausted.page.items.length}, ` +
      `scanned ${exhausted.page.scanned_count ?? 0}, scan_limited ${String(exhausted.page.scan_limited)}, ` +
      `cursor ${exhausted.page.next_cursor?.length ?? 0} B`,
  );

  const first = await measure({ query: '共同词', limit: 1 });
  let cursor = first.page.next_cursor;
  let pages = 0;
  const started = performance.now();
  while (cursor && pages < 10) {
    const page = (await messageSearch(db, principal, {
      scope: 'all',
      query: '共同词',
      limit: 1,
      cursor,
    })) as SearchPage;
    cursor = page.next_cursor;
    pages += 1;
  }
  console.log(
    `exact 连续翻 ${pages} 页: ${(performance.now() - started).toFixed(2)}ms 总计` +
      `${pages > 0 ? `，平均 ${((performance.now() - started) / pages).toFixed(2)}ms/页` : ''}`,
  );
  console.log(
    `游标上限 ${LIMITS.messageSearchCursorMax} B；本基准 exact 游标 ` +
      `${first.page.next_cursor?.length ?? 0} B`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

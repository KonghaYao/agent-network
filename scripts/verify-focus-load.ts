/**
 * Task Focus 单人 10 万事件负载验收（确定性秘书）。
 *
 * 不调用真实模型：由测试脚本扮演秘书，验证 Watch 扫描、候选、单活跃作业、
 * 提交、卡片计数与归档不复活。事件分布按计划 4.5 节：
 * 99,200 无关 + 600 重复 + 150 指向 5 张现有卡 + 40 归档补报 + 10 独立委托。
 * 期望：新增 10 张、5 张现有卡有更新、归档复活 0 张。
 *
 * 运行：bun scripts/verify-focus-load.ts
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import type { Principal } from '../src/domain/principal';
import { focusEnable } from '../src/domain/focus/bindings';
import { focusCommit } from '../src/focus/secretary';
import type { FocusCommitInput } from '../src/contracts/focus';
import { ensureJobs } from '../src/focus/jobs';
import { scanFocusEvents } from '../src/focus/watch';
import { getActor } from '../src/storage/queries';
import { nowMs } from '../src/storage/db';
import type { Env } from '../src/env';
import { check, checkEqual, checksPassed } from './lib/harness';

const MIGRATIONS = join(import.meta.dir, '../migrations');
const OWNER = 'usr_load_owner';
const SENDER = 'usr_load_sender';
const ROOM = 'rm_load_room';
const TOTAL = 100_000;
const AT = nowMs();

let db: Database;
let d1: D1Database;

function principalFor(actor: string): Principal {
  const row = db.prepare('SELECT * FROM actors WHERE actor_id = ?').get(actor) as any;
  if (!row) throw new Error(`missing actor ${actor}`);
  return { credentialHash: `hash_${actor}`, actor: row, credential: null };
}

function baseEnv(): Env {
  return { DB: d1 } as unknown as Env;
}

function seed(): void {
  db.exec(`
    INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
    VALUES ('${OWNER}', 'human', NULL, 'Load Owner', '{}', 0, 0, 0, ${AT}, ${AT}),
           ('${SENDER}', 'human', NULL, 'Load Sender', '{}', 0, 0, 0, ${AT}, ${AT});
    INSERT INTO rooms (room_id, kind, owner_id, title, head_seq, events_min_seq, member_seq, created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${OWNER}', 'Load Room', 0, 0, 0, ${AT}, ${AT});
    INSERT INTO room_members (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
    VALUES ('${ROOM}', '${OWNER}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT}),
           ('${ROOM}', '${SENDER}', 'member', 'active', 0, 0, ${AT}, 1, ${AT});
  `);

  const insertMessage = db.prepare(
    `INSERT INTO messages
       (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
        preview, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertEvent = db.prepare(
    `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
     VALUES ('room', ?, 'message_created', ?, ?, ?, ?)`,
  );
  const kinds = [
    ...Array.from({ length: 10 }, (_, i) => `NEW-${i}`),
    ...Array.from({ length: 150 }, (_, i) => `UPDATE-${i % 5}`),
    ...Array.from({ length: 40 }, (_, i) => `ARCHIVED-${i % 40}`),
    ...Array.from({ length: 600 }, (_, i) => `DUP-${i}`),
    ...Array.from({ length: TOTAL - 800 }, (_, i) => `NOISE-${i}`),
  ];
  db.transaction(() => {
    for (let i = 0; i < kinds.length; i += 1) {
      const messageId = `msg_load_${i}`;
      const body = kinds[i] as string;
      const seq = i + 1;
      insertMessage.run(
        messageId,
        ROOM,
        SENDER,
        `cm_load_${i}`,
        seq,
        body,
        Buffer.byteLength(body),
        body,
        AT + seq,
      );
      insertEvent.run(
        ROOM,
        messageId,
        JSON.stringify({ room_id: ROOM, message_id: messageId, sender_id: SENDER }),
        `load:${messageId}`,
        AT + seq,
      );
    }
  })();
}

async function run(): Promise<void> {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  d1 = createD1(db);
  seed();

  const owner = principalFor(OWNER);
  const enabled = await focusEnable(d1, owner, { request_id: 'load_enable' });
  const secretary = enabled.secretary_actor_id as string;
  db.prepare(
    `UPDATE focus_bindings
        SET status = 'active', session_id = 'sess_load', root_session_id = 'root_load',
            event_from_seq = 0, updated_at = ?
      WHERE owner_actor_id = ?`,
  ).run(AT, OWNER);

  // 5 张现有卡 + 40 张归档卡，都指向同一条普通消息。
  db.prepare(
    `INSERT INTO messages
       (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
        preview, created_at)
     VALUES ('msg_seed', '${ROOM}', '${SENDER}', 'cm_seed', 0, 'seed', 4, 'seed', ?)`,
  ).run(AT);
  const insertItem = db.prepare(
    `INSERT INTO focus_items
       (item_id, owner_actor_id, secretary_actor_id, title, column_key, next_step,
        waiting_on, due_at, due_text, summary, version, archived_at, archived_by,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, 'tracking', '', NULL, NULL, NULL, '', 1, ?, ?, ?, ?)`,
  );
  const insertEvidence = db.prepare(
    `INSERT INTO focus_evidence
       (evidence_id, item_id, owner_actor_id, source_kind, source_key, room_id, message_id,
        delivery_id, source_revision, purpose, occurred_at, created_at)
     VALUES (?, ?, ?, 'message', 'message:msg_seed', ?, 'msg_seed', NULL, 1, 'source', ?, ?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < 5; i += 1) {
      const itemId = `fit_seed_${i}`;
      insertItem.run(itemId, OWNER, secretary, `Seed card ${i}`, null, null, AT, AT);
      insertEvidence.run(`fev_seed_${i}`, itemId, OWNER, ROOM, AT, AT);
    }
    for (let i = 0; i < 40; i += 1) {
      const itemId = `fit_arch_${i}`;
      insertItem.run(itemId, OWNER, secretary, `Archived card ${i}`, AT, OWNER, AT, AT);
      insertEvidence.run(`fev_arch_${i}`, itemId, OWNER, ROOM, AT, AT);
    }
  })();

  console.log('  · Watch 扫描 100,000 事件');
  let scans = 0;
  for (;;) {
    const before = db.prepare('SELECT event_seq FROM focus_scan_state WHERE id = 1').get() as {
      event_seq: number;
    };
    const result = await scanFocusEvents(baseEnv());
    scans += 1;
    if (result.cursor <= before.event_seq || !result.more) break;
    if (scans % 5 === 0) console.log(`    scan ${scans} cursor=${result.cursor}`);
  }
  const candidateCount = (db.prepare('SELECT COUNT(*) AS n FROM focus_candidates').get() as { n: number }).n;
  checkEqual('候选数等于 100,000', candidateCount, TOTAL);

  console.log('  · 逐作业提交（确定性秘书）');
  const updated = new Set<number>();
  let newCards = 0;
  let archivedAttempts = 0;
  let archivedBarrier = false;
  let jobs = 0;
  for (;;) {
    let jobRow = db
      .prepare(
        `SELECT job_id FROM focus_jobs
          WHERE status IN ('queued','submitted','running','waiting')
          ORDER BY created_at, job_id LIMIT 1`,
      )
      .get() as { job_id: string } | undefined;
    if (!jobRow) {
      const created = await ensureJobs(baseEnv(), { dispatch: false });
      if (created.created.length === 0) break;
      jobRow = { job_id: created.created[0] as string };
    }
    const jobId = jobRow.job_id;
    db.prepare(
      `UPDATE focus_jobs SET status = 'running', lease_until = ?, updated_at = ? WHERE job_id = ?`,
    ).run(nowMs() + 600_000, nowMs(), jobId);
    const job = db.prepare('SELECT * FROM focus_jobs WHERE job_id = ?').get(jobId) as {
      attempt_ref: string;
      job_id: string;
    };
    const candidates = db
      .prepare(
        `SELECT c.candidate_id, c.message_id, m.body
           FROM focus_candidates c JOIN messages m ON m.message_id = c.message_id
          WHERE c.job_id = ? AND c.state = 'assigned'
          ORDER BY c.event_seq`,
      )
      .all(jobId) as { candidate_id: string; message_id: string; body: string }[];

    const decisions: FocusCommitInput['decisions'] = [];
    let archivedUpdate: FocusCommitInput['decisions'][number] | null = null;
    for (const candidate of candidates) {
      const body = candidate.body;
      if (body.startsWith('NEW-') && newCards < 10) {
        newCards += 1;
        decisions.push({
          type: 'create',
          title: `Load task ${newCards}`,
          column_key: 'needs_me',
          next_step: 'handle load item',
          evidence: [{ candidate_id: candidate.candidate_id, purpose: 'request' }],
        });
        continue;
      }
      const update = /^UPDATE-([0-4])$/u.exec(body);
      if (update && !updated.has(Number(update[1]))) {
        updated.add(Number(update[1]));
        decisions.push({
          type: 'update',
          item_id: `fit_seed_${update[1]}`,
          expected_version: 1,
          changes: { summary: 'load update' },
          evidence: [{ candidate_id: candidate.candidate_id, purpose: 'progress' }],
        });
        continue;
      }
      if (body.startsWith('ARCHIVED-') && archivedAttempts === 0) {
        archivedAttempts += 1;
        archivedUpdate = {
          type: 'update',
          item_id: 'fit_arch_0',
          expected_version: 1,
          changes: { summary: 'should not revive' },
          evidence: [{ candidate_id: candidate.candidate_id, purpose: 'progress' }],
        };
        decisions.push(archivedUpdate);
        continue;
      }
      decisions.push({
        type: 'ignore',
        candidate_ids: [candidate.candidate_id],
        reason: 'load noise',
      });
    }

    if (archivedUpdate) {
      try {
        await focusCommit(d1, {
          attempt_ref: job.attempt_ref,
          decision_id: `load_arch_probe_${job.job_id}`,
          complete: false,
          decisions: [archivedUpdate],
        });
        archivedBarrier = false;
      } catch {
        archivedBarrier = true;
      }
      decisions.length = 0;
      for (const candidate of candidates) {
        decisions.push({
          type: 'ignore',
          candidate_ids: [candidate.candidate_id],
          reason: 'load noise',
        });
      }
      db.prepare('UPDATE focus_jobs SET lease_until = ?, updated_at = ? WHERE job_id = ?').run(
        nowMs() + 600_000,
        nowMs(),
        jobId,
      );
    }

    await focusCommit(d1, {
      attempt_ref: job.attempt_ref,
      decision_id: `load_job_${job.job_id}`,
      complete: true,
      decisions,
    });
    jobs += 1;
    if (jobs % 200 === 0) console.log(`    jobs ${jobs}`);
  }

  const totalItems = (db.prepare('SELECT COUNT(*) AS n FROM focus_items').get() as { n: number }).n;
  const newItems = (
    db.prepare("SELECT COUNT(*) AS n FROM focus_items WHERE title LIKE 'Load task %'").get() as {
      n: number;
    }
  ).n;
  const updatedCards = (
    db.prepare(
      'SELECT COUNT(*) AS n FROM focus_items WHERE item_id LIKE ? AND version > 1',
    ).get('fit_seed_%') as { n: number }
  ).n;
  const archivedChanged = (
    db.prepare(
      'SELECT COUNT(*) AS n FROM focus_items WHERE item_id LIKE ? AND (version <> 1 OR archived_at IS NULL)',
    ).get('fit_arch_%') as { n: number }
  ).n;
  const openCandidates = (
    db.prepare("SELECT COUNT(*) AS n FROM focus_candidates WHERE state = 'assigned'").get() as {
      n: number;
    }
  ).n;

  checkEqual('新增独立卡为 10', newItems, 10);
  checkEqual('5 张现有卡发生更新', updatedCards, 5);
  checkEqual('归档卡无复活', archivedChanged, 0);
  checkEqual('归档更新被拒绝', archivedBarrier, true);
  checkEqual('总卡数 5+40+10', totalItems, 55);
  checkEqual('无遗留 assigned 候选', openCandidates, 0);
  check('作业数大于 1,000', jobs > 1_000);
  console.log(`  扫描 ${scans} 轮，作业 ${jobs} 个，候选 ${candidateCount}`);
  console.log(`10 万事件负载验收通过：${checksPassed()} 项检查`);
}

await run().catch((error) => {
  console.error('Focus 负载验收失败:', error);
  process.exit(1);
});

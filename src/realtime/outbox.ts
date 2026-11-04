import { LIMITS } from '../contracts/limits';
import { backoffMs, nowMs } from '../storage/db';
import type { Env } from '../env';
import { fanoutStreamItems, type OutboxStreamRow } from './stream';

type OutboxDueRow = OutboxStreamRow;

export interface DrainResult {
  claimed: number;
  published: number;
  failed: number;
  oldestPendingAgeMs: number | null;
  streamActors: number;
  streamFrames: number;
  streamItems: number;
  streamDropped: number;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

/**
 * 发布 SQLite outbox 中的变更提示。
 *
 * - 30 秒租约竞争待发布行；topic 只作为内部写分区键，不再发布到 hub。
 * - 每条事件由 `fanoutStreamItems` 映射为统一 stream item 并按 actor 扇出。
 * - 成员变化不再以专用提示关闭订阅；客户端按 `room.membership` 自行收敛。
 * - 失败按指数退避加 jitter 重排，记录保留，不静默丢弃。
 */
export async function drainOutbox(env: Env, limit = LIMITS.outboxBatchMax): Promise<DrainResult> {
  const db = env.DB;
  const now = nowMs();

  await db
    .prepare(
      "UPDATE outbox SET status = 'pending', lease_token = NULL, lease_until = NULL WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until < ?",
    )
    .bind(now)
    .run();

  const due = await db
    .prepare(
      `SELECT o.outbox_id, o.topic, o.event_seq, o.attempts, o.created_at,
              e.scope_kind, e.scope_id, e.event_type, e.ref_id, e.metadata
         FROM outbox o JOIN events e ON e.event_seq = o.event_seq
        WHERE o.status = 'pending' AND o.next_attempt_at <= ?
        ORDER BY o.next_attempt_at ASC, o.event_seq ASC, o.outbox_id ASC
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<OutboxDueRow>();

  const leaseToken = crypto.randomUUID();
  const leaseUntil = now + LIMITS.outboxLeaseMs;
  const claimed: OutboxDueRow[] = [];
  for (const row of due.results) {
    const result = await db
      .prepare(
        "UPDATE outbox SET status = 'processing', lease_token = ?, lease_until = ? WHERE outbox_id = ? AND status = 'pending'",
      )
      .bind(leaseToken, leaseUntil, row.outbox_id)
      .run();
    if ((result.meta.changes ?? 0) > 0) claimed.push(row);
  }

  // 统一 actor stream：按事件映射后 fan-out。outbox 的 topic 仅是内部
  // 写分区键，cutover 后不再作为可订阅 URI 或 hub topic 发布。
  let streamStats = {
    streamActors: 0,
    streamFrames: 0,
    streamItems: 0,
    streamDropped: 0,
  };
  try {
    streamStats = await fanoutStreamItems(db, env, claimed);
  } catch (error) {
    // stream 是提示通道；构造/发布失败不能阻塞 outbox 完成，客户端仍可
    // 通过快照与 network_sync 补齐。
    console.error('agent-network stream fan-out failed', error);
  }

  let published = 0;
  let failed = 0;
  for (const batch of chunks(claimed, 50)) {
    try {
      const placeholders = batch.map(() => '?').join(',');
      await db
        .prepare(
          `UPDATE outbox
              SET status = 'completed', completed_at = ?, attempts = attempts + 1,
                  lease_token = NULL, lease_until = NULL
            WHERE outbox_id IN (${placeholders}) AND lease_token = ?`,
        )
        .bind(now, ...batch.map((row) => row.outbox_id), leaseToken)
        .run();
      published += batch.length;
    } catch (error) {
      console.error('agent-network outbox completion failed', error);
      failed += batch.length;
      for (const row of batch) {
        await db
          .prepare(
            `UPDATE outbox
                SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?,
                    lease_token = NULL, lease_until = NULL
              WHERE outbox_id = ? AND lease_token = ?`,
          )
          .bind(now + backoffMs(row.attempts), row.outbox_id, leaseToken)
          .run();
      }
    }
  }

  const oldest = await db
    .prepare("SELECT MIN(created_at) AS oldest FROM outbox WHERE status IN ('pending', 'processing')")
    .first<{ oldest: number | null }>();

  return {
    claimed: claimed.length,
    published,
    failed,
    oldestPendingAgeMs:
      oldest?.oldest === null || oldest?.oldest === undefined ? null : now - oldest.oldest,
    ...streamStats,
  };
}

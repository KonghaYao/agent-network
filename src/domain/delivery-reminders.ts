import { DELIVERY_REMINDER_EVENT } from '../contracts/events';
import { LIMITS } from '../contracts/limits';
import { newId, nowMs } from '../storage/db';
import { inboxHeadStatementIfEvent, inboxTopic } from '../storage/events';
import { isEventKeyConflict } from '../storage/transactions/runner';

export interface DeliveryReminderCandidate {
  delivery_id: string;
  recipient_id: string;
  message_id: string;
  room_id: string;
  attempt: number;
  claim_id: string;
  progress_at: number;
  last_reminded_at: number | null;
}

export interface DeliveryReminderScanResult {
  /** 本轮命中到期条件的投递数。 */
  scanned: number;
  /** 实际写入提醒事件与 outbox 的数量。 */
  reminded: number;
  /** 并发扫描已抢先写入同一窗口，本轮无需重复提醒。 */
  skipped: number;
  /** 单条写入失败数；下一轮会重新评估。 */
  failed: number;
}

function eventKeyOf(candidate: DeliveryReminderCandidate): string {
  // 同一 claim 的同一提醒窗口使用稳定 key；并发/重入扫描收敛到一条事件。
  const anchor = candidate.last_reminded_at ?? candidate.progress_at;
  return `delivery_reminder:${candidate.delivery_id}:${candidate.attempt}:${candidate.claim_id}:${anchor}`;
}

/**
 * 扫描 claimed 且 progress_at 超过阈值没有更新的投递，向 recipient 写提醒。
 *
 * - 提醒不是新待办：不创建 delivery、不改变 pending_count、不推进房间 head、
 *   不写 room scope 事件，只写 inbox 事件与 `inbox:{actor}` outbox。
 * - `last_reminded_at` 持久化去重，进程重启后同一窗口不会重复提醒。
 * - UPDATE + INSERT event + INSERT outbox + inbox head 使用同一个 db.batch，
 *   任一步失败全部回滚。事件与 outbox 都以本次扫描的 `last_reminded_at = now`
 *   为条件，只有真正赢得该提醒窗口的扫描才会写入；不同毫秒的并发扫描不会把
 *   outbox 挂到别的扫描留下的事件上，同毫秒并发仍由 event_key 唯一约束收敛。
 * - 不更新 `deliveries.updated_at`，避免掩盖发送方页面的“处理中未更新”提示。
 */
export async function remindStaleDeliveries(
  db: D1Database,
  now = nowMs(),
): Promise<DeliveryReminderScanResult> {
  const threshold = now - LIMITS.deliveryReminderMs;
  const candidates = await db
    .prepare(
      `SELECT delivery_id, recipient_id, message_id, room_id, attempt, claim_id,
              progress_at, last_reminded_at
         FROM deliveries
        WHERE state = 'claimed'
          AND progress_at IS NOT NULL
          AND progress_at <= ?
          AND (last_reminded_at IS NULL OR last_reminded_at <= ?)
        ORDER BY progress_at ASC, delivery_id ASC
        LIMIT ?`,
    )
    .bind(threshold, threshold, LIMITS.deliveryReminderBatchMax)
    .all<DeliveryReminderCandidate>();

  const result: DeliveryReminderScanResult = {
    scanned: candidates.results.length,
    reminded: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates.results) {
    const eventKey = eventKeyOf(candidate);
    const metadata = JSON.stringify({
      delivery_id: candidate.delivery_id,
      attempt: candidate.attempt,
      claim_id: candidate.claim_id,
      room_id: candidate.room_id,
      message_id: candidate.message_id,
      progress_at: candidate.progress_at,
    });

    try {
      const statements = await db.batch([
        db
          .prepare(
            `UPDATE deliveries
                SET last_reminded_at = ?
              WHERE delivery_id = ? AND state = 'claimed' AND attempt = ?
                AND claim_id = ? AND progress_at = ?
                AND (last_reminded_at IS NULL OR last_reminded_at <= ?)`,
          )
          .bind(
            now,
            candidate.delivery_id,
            candidate.attempt,
            candidate.claim_id,
            candidate.progress_at,
            threshold,
          ),
        db
          .prepare(
            `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
             SELECT 'inbox', ?, ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM deliveries
                 WHERE delivery_id = ? AND state = 'claimed' AND attempt = ?
                   AND claim_id = ? AND progress_at = ? AND last_reminded_at = ?
              )`,
          )
          .bind(
            candidate.recipient_id,
            DELIVERY_REMINDER_EVENT,
            candidate.delivery_id,
            metadata,
            eventKey,
            now,
            candidate.delivery_id,
            candidate.attempt,
            candidate.claim_id,
            candidate.progress_at,
            now,
          ),
        db
          .prepare(
            `INSERT INTO outbox (outbox_id, topic, event_seq, status, attempts, next_attempt_at, created_at)
             SELECT ?, ?, e.event_seq, 'pending', 0, ?, ?
               FROM events e
              WHERE e.event_key = ?
                AND EXISTS (
                  SELECT 1 FROM deliveries
                   WHERE delivery_id = ? AND state = 'claimed' AND attempt = ?
                     AND claim_id = ? AND progress_at = ? AND last_reminded_at = ?
                )`,
          )
          .bind(
            newId('obx'),
            inboxTopic(candidate.recipient_id),
            now,
            now,
            eventKey,
            candidate.delivery_id,
            candidate.attempt,
            candidate.claim_id,
            candidate.progress_at,
            now,
          ),
        inboxHeadStatementIfEvent(db, candidate.recipient_id, eventKey, now, 0),
      ]);

      if ((statements[1]?.meta.changes ?? 0) > 0) result.reminded += 1;
      else result.skipped += 1;
    } catch (error) {
      if (isEventKeyConflict(error)) {
        result.skipped += 1;
        continue;
      }
      result.failed += 1;
      // 不记录 SQL bind、token 或消息正文；下一轮继续扫描。
      console.error('agent-network delivery reminder write failed');
    }
  }

  return result;
}

import { DELIVERY_REMINDER_EVENT } from '../contracts/events';
import { LIMITS } from '../contracts/limits';
import { newId, nowMs, truncateUtf8 } from '../storage/db';
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
  message_preview: string | null;
  sender_id: string | null;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
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

const DISPLAY_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu;
const DISPLAY_JSON_UNSAFE = /["\\]/gu;

/**
 * 提醒只携带可直接展示的短摘要：折叠控制字符/换行，替换会放大 JSON 的
 * 引号与反斜杠，再按 UTF-8 字节截断。完整正文永远不进入提醒。
 */
function displayText(raw: string | null, maxBytes: number): string {
  if (!raw) return '';
  const cleaned = raw
    .replace(DISPLAY_CONTROL, ' ')
    .replace(DISPLAY_JSON_UNSAFE, "'")
    .replace(/\s+/gu, ' ')
    .trim();
  return truncateUtf8(cleaned, maxBytes).trim();
}

/** 无摘要时的退化文案；与带摘要文案一样可直接展示。 */
const REMINDER_TEXT_FALLBACK = '投递尚未完成，请汇报进度';

/**
 * 扫描 claimed 且 progress_at 超过阈值没有更新的投递，向 recipient 写提醒。
 *
 * - 提醒不是新待办：不创建 delivery、不改变 pending_count、不推进房间 head、
 *   不写 room scope 事件，只写 inbox 事件与 `inbox:{actor}` outbox。
 * - 事件同时携带消息短摘要、发送者展示名、未完成时长与可直接展示的文案；
 *   摘要按字节截断，永远不会包含完整正文。
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
      `SELECT d.delivery_id, d.recipient_id, d.message_id, d.room_id, d.attempt, d.claim_id,
              d.progress_at, d.last_reminded_at,
              m.preview AS message_preview,
              m.sender_id AS sender_id,
              a.name AS sender_name,
              a.kind AS sender_kind
         FROM deliveries d
         LEFT JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.state = 'claimed'
          AND d.progress_at IS NOT NULL
          AND d.progress_at <= ?
          AND (d.last_reminded_at IS NULL OR d.last_reminded_at <= ?)
        ORDER BY d.progress_at ASC, d.delivery_id ASC
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
    const preview = displayText(
      candidate.message_preview,
      LIMITS.deliveryReminderPreviewBytes,
    );
    const senderName = displayText(
      candidate.sender_name,
      LIMITS.deliveryReminderSenderNameBytes,
    );
    const metadata = JSON.stringify({
      delivery_id: candidate.delivery_id,
      attempt: candidate.attempt,
      claim_id: candidate.claim_id,
      room_id: candidate.room_id,
      message_id: candidate.message_id,
      progress_at: candidate.progress_at,
      preview,
      sender_id: candidate.sender_id,
      sender_name: senderName === '' ? null : senderName,
      sender_kind: candidate.sender_kind,
      age_ms: now - candidate.progress_at,
      text: preview ? `「${preview}」尚未完成，请汇报进度` : REMINDER_TEXT_FALLBACK,
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

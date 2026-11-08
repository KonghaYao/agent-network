import { LIMITS } from '../contracts/limits';
import { newId, nowMs } from '../storage/db';
import { inboxHeadStatementIfEvent, inboxTopic } from '../storage/events';
import { isEventKeyConflict } from '../storage/transactions/runner';

/**
 * D08 任务催办。
 *
 * 规则与 delivery 提醒保持一致：
 * - 任务进行中或受阻，当前 active assignment 的负责人超过 3 分钟没有 progress
 *   更新；完成/提交/取消后停止；
 * - 首次提醒后按同一周期重复，直到负责人上报进度、任务完成/提交/取消；
 * - 人类负责人同样适用，但服务端不要求持续心跳，也不会因超时自动判定失败；
 * - 同一 assignment 仍有 pending/claimed 的 `task_offer` delivery 时跳过：
 *   delivery 提醒已经覆盖同一人同一窗口，避免两条提醒；
 * - 提醒只写当前责任者的 inbox 事件与 `inbox:{actor}` outbox，不创建 task/
 *   assignment/delivery、不增加 pending_count、不推进 rooms.head_seq。
 *
 * `task_reminders` 持久化每个窗口，event_key 由 task_id + assignment_version +
 * 窗口锚点构成；进程重启或并发扫描不会重复提醒。
 */

export interface TaskReminderCandidate {
  task_id: string;
  room_id: string;
  owner_actor_id: string;
  due_at: number | null;
  blocked_reason: string | null;
  assignment_id: string;
  assignment_version: number;
  progress_at: number;
  last_reminded_at: number | null;
}

export interface TaskReminderScanResult {
  /** 本轮命中到期条件的任务数。 */
  scanned: number;
  /** 实际写入提醒事件与 outbox 的数量。 */
  reminded: number;
  /** 并发扫描已抢先写入同一窗口，本轮无需重复提醒。 */
  skipped: number;
  /** 单条写入失败数；下一轮会重新评估。 */
  failed: number;
}

export function taskReminderEventKey(
  taskId: string,
  assignmentVersion: number,
  anchorAt: number,
): string {
  return `task_reminder:${taskId}:${assignmentVersion}:${anchorAt}`;
}

const CANDIDATE_SQL = `
  WITH candidate AS (
    SELECT t.task_id, t.room_id, t.owner_actor_id, t.due_at, t.blocked_reason,
           a.assignment_id, a.assignment_version,
           COALESCE(t.last_progress_at, a.last_progress_at, a.accepted_at, a.created_at)
             AS progress_at,
           (SELECT MAX(r.created_at) FROM task_reminders r
             WHERE r.task_id = t.task_id AND r.assignment_id = a.assignment_id)
             AS last_reminded_at
      FROM tasks t
      JOIN task_assignments a ON a.assignment_id = t.current_assignment_id
     WHERE t.status IN ('in_progress', 'blocked')
       AND t.owner_actor_id IS NOT NULL
       AND a.status = 'active'
       AND a.owner_actor_id = t.owner_actor_id
       AND NOT EXISTS (
         SELECT 1
           FROM task_deliveries td
           JOIN deliveries d ON d.delivery_id = td.delivery_id
          WHERE td.assignment_id = a.assignment_id
            AND td.kind = 'task_offer'
            AND d.state IN ('pending', 'claimed')
       )
  )
  SELECT task_id, room_id, owner_actor_id, due_at, blocked_reason,
         assignment_id, assignment_version, progress_at, last_reminded_at
    FROM candidate
   WHERE progress_at <= ?
     AND (last_reminded_at IS NULL OR last_reminded_at <= ?)
   ORDER BY progress_at ASC, task_id ASC
   LIMIT ?
`;

function reminderInsertStatement(
  db: D1Database,
  candidate: TaskReminderCandidate,
  reminderId: string,
  anchorAt: number,
  eventKey: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_reminders
         (reminder_id, task_id, assignment_id, assignment_version, owner_actor_id,
          anchor_at, event_key, created_at)
       SELECT ?, t.task_id, a.assignment_id, a.assignment_version, t.owner_actor_id,
              ?, ?, ?
         FROM tasks t
         JOIN task_assignments a ON a.assignment_id = t.current_assignment_id
        WHERE t.task_id = ?
          AND t.status IN ('in_progress', 'blocked')
          AND t.owner_actor_id = a.owner_actor_id
          AND a.assignment_id = ?
          AND a.assignment_version = ?
          AND a.status = 'active'
          AND COALESCE(t.last_progress_at, a.last_progress_at, a.accepted_at, a.created_at) = ?
          AND NOT EXISTS (
            SELECT 1
              FROM task_deliveries td
              JOIN deliveries d ON d.delivery_id = td.delivery_id
             WHERE td.assignment_id = a.assignment_id
               AND td.kind = 'task_offer'
               AND d.state IN ('pending', 'claimed')
          )`,
    )
    .bind(
      reminderId,
      anchorAt,
      eventKey,
      now,
      candidate.task_id,
      candidate.assignment_id,
      candidate.assignment_version,
      candidate.progress_at,
    );
}

function reminderEventStatement(
  db: D1Database,
  candidate: TaskReminderCandidate,
  reminderId: string,
  anchorAt: number,
  eventKey: string,
  now: number,
): D1PreparedStatement {
  const metadata = JSON.stringify({
    task_id: candidate.task_id,
    room_id: candidate.room_id,
    owner_actor_id: candidate.owner_actor_id,
    assignment_id: candidate.assignment_id,
    assignment_version: candidate.assignment_version,
    progress_at: candidate.progress_at,
    anchor_at: anchorAt,
    due_at: candidate.due_at,
    blocked_reason: candidate.blocked_reason,
    overdue: candidate.due_at !== null && candidate.due_at < now,
  });
  return db
    .prepare(
      `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
       SELECT 'inbox', r.owner_actor_id, 'task_reminder', r.task_id, ?, ?, ?
         FROM task_reminders r
        WHERE r.reminder_id = ? AND r.event_key = ?`,
    )
    .bind(metadata, eventKey, now, reminderId, eventKey);
}

function reminderOutboxStatement(
  db: D1Database,
  candidate: TaskReminderCandidate,
  eventKey: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (outbox_id, topic, event_seq, status, attempts, next_attempt_at, created_at)
       SELECT ?, ?, e.event_seq, 'pending', 0, ?, ?
         FROM events e
        WHERE e.event_key = ?`,
    )
    .bind(newId('obx'), inboxTopic(candidate.owner_actor_id), now, now, eventKey);
}

export async function remindStaleTasks(
  db: D1Database,
  now = nowMs(),
): Promise<TaskReminderScanResult> {
  const threshold = now - LIMITS.taskReminderMs;
  const candidates = await db
    .prepare(CANDIDATE_SQL)
    .bind(threshold, threshold, LIMITS.taskReminderBatchMax)
    .all<TaskReminderCandidate>();

  const result: TaskReminderScanResult = {
    scanned: candidates.results.length,
    reminded: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates.results) {
    const anchorAt = candidate.last_reminded_at ?? candidate.progress_at;
    const eventKey = taskReminderEventKey(
      candidate.task_id,
      candidate.assignment_version,
      anchorAt,
    );
    const reminderId = newId('trm');
    try {
      const statements = await db.batch([
        reminderInsertStatement(db, candidate, reminderId, anchorAt, eventKey, now),
        reminderEventStatement(db, candidate, reminderId, anchorAt, eventKey, now),
        reminderOutboxStatement(db, candidate, eventKey, now),
        inboxHeadStatementIfEvent(db, candidate.owner_actor_id, eventKey, now, 0),
      ]);
      if ((statements[0]?.meta.changes ?? 0) > 0) result.reminded += 1;
      else result.skipped += 1;
    } catch (error) {
      if (isEventKeyConflict(error)) {
        result.skipped += 1;
        continue;
      }
      result.failed += 1;
      // 不记录 SQL bind、token 或任务正文；下一轮继续扫描。
      console.error('agent-network task reminder write failed');
    }
  }

  return result;
}

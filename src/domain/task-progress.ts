/**
 * 任务进度读取与视图。
 *
 * `tasks.status` / `tasks.revision` 是业务权威；`task_progress` 只追加审计，
 * 不保存第二份当前状态。普通进度更新不创建聊天消息、delivery 或 inbox 待办，
 * 网页与 MCP 都只读取这里的权威结果。
 */

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import { TASK_STATUS_LABELS, type TaskStatus } from '../contracts/task-status';
import { newId, utf8Bytes } from '../storage/db';
import type { TaskProgressRow } from '../storage/rows';

export interface TaskProgressView {
  progress_id: string;
  revision: number;
  prior_status: TaskStatus;
  prior_status_label: string;
  status: TaskStatus;
  status_label: string;
  percent: number | null;
  note: string;
  blocked_reason: string | null;
  actor_id: string;
  actor_name: string;
  created_at: string;
}

const PROGRESS_NOTE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

/** 进度说明允许换行与制表，但拒绝 NUL/其他不可见控制字符。 */
export function normalizeProgressNote(
  value: string | undefined,
  label = '进度说明',
): string {
  if (value === undefined) return '';
  const normalized = value.replace(/\r\n?/gu, '\n').trim();
  if (!normalized) return '';
  if (PROGRESS_NOTE_CONTROL.test(normalized)) {
    throw new BusinessError('INVALID_ARGUMENT', `${label}不能包含 NUL 或其他不可见控制字符`);
  }
  const bytes = utf8Bytes(normalized);
  if (bytes > LIMITS.taskProgressNoteBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', `${label}超过 ${LIMITS.taskProgressNoteBytes} 字节`, {
      bytes,
      max: LIMITS.taskProgressNoteBytes,
    });
  }
  return normalized;
}

export function normalizeBlockReason(value: string): string {
  const normalized = normalizeProgressNote(value, '阻塞原因');
  if (!normalized) throw new BusinessError('INVALID_ARGUMENT', '阻塞原因不能为空');
  if (utf8Bytes(normalized) > LIMITS.taskBlockReasonBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', `阻塞原因超过 ${LIMITS.taskBlockReasonBytes} 字节`, {
      max: LIMITS.taskBlockReasonBytes,
    });
  }
  return normalized;
}

export function normalizeProgressPercent(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw new BusinessError('INVALID_ARGUMENT', '进度百分比必须是 0–100 的整数');
  }
  return value;
}

export function progressView(
  row: TaskProgressRow,
  names: Map<string, string>,
): TaskProgressView {
  return {
    progress_id: row.progress_id,
    revision: row.task_revision,
    prior_status: row.prior_status,
    prior_status_label: TASK_STATUS_LABELS[row.prior_status],
    status: row.status,
    status_label: TASK_STATUS_LABELS[row.status],
    percent: row.percent,
    note: row.note,
    blocked_reason: row.blocked_reason,
    actor_id: row.actor_id,
    actor_name: names.get(row.actor_id) ?? '',
    created_at: String(row.created_at),
  };
}

export function progressActorIds(rows: TaskProgressRow[]): string[] {
  return Array.from(new Set(rows.map((row) => row.actor_id)));
}

/**
 * 每个任务取最新一条进度。
 *
 * 列表一次查询所有 task_id，避免按任务 N+1；结果仅用于展示，历史继续由
 * `task_progress` 保存。
 */
export async function latestProgressRows(
  db: D1Database,
  taskIds: string[],
): Promise<Map<string, TaskProgressRow>> {
  const unique = Array.from(new Set(taskIds.filter((id) => id.length > 0)));
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => '?').join(', ');
  const result = await db
    .prepare(
      `SELECT * FROM (
         SELECT p.*,
                ROW_NUMBER() OVER (
                  PARTITION BY p.task_id
                  ORDER BY p.task_revision DESC
                ) AS row_number
           FROM task_progress p
          WHERE p.task_id IN (${placeholders})
       ) WHERE row_number = 1`,
    )
    .bind(...unique)
    .all<TaskProgressRow>();
  return new Map(result.results.map((row) => [row.task_id, row]));
}

/** 任务详情使用的最近进度，按 revision 倒序；权威历史不删除。 */
export async function progressHistoryRows(
  db: D1Database,
  taskId: string,
  limit = LIMITS.taskProgressHistoryMax,
): Promise<TaskProgressRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM task_progress
        WHERE task_id = ?
        ORDER BY task_revision DESC
        LIMIT ?`,
    )
    .bind(taskId, limit)
    .all<TaskProgressRow>();
  return rows.results;
}

export interface NewTaskProgressInput {
  taskId: string;
  revision: number;
  assignmentId: string | null;
  assignmentVersion: number | null;
  actorId: string;
  priorStatus: TaskStatus;
  status: TaskStatus;
  percent: number | null;
  note: string;
  blockedReason: string | null;
  at: number;
  /** 调用方已生成 ID 时复用，保证写入前返回的视图与实际行一致。 */
  progressId?: string;
}

export function progressStatement(
  db: D1Database,
  input: NewTaskProgressInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO task_progress
         (progress_id, task_id, task_revision, assignment_id, assignment_version,
          actor_id, prior_status, status, percent, note, blocked_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.progressId ?? newId('prg'),
      input.taskId,
      input.revision,
      input.assignmentId,
      input.assignmentVersion,
      input.actorId,
      input.priorStatus,
      input.status,
      input.percent,
      input.note,
      input.blockedReason,
      input.at,
    );
}

/**
 * MF03：Memory 后端作业租约、恢复与连续确认水位。
 *
 * 三条边界：
 * - 外部 Hindsight 调用不在业务事务内；本地意图先提交，失败只影响作业状态；
 * - 租约过期只表示可以“对账”，不把未知远端作业当成失败或成功；
 * - 来源/删除命令与 recall 逻辑分队列；慢检索不阻塞删除，来源生效与派生
 *   就绪分开记录。
 */
import { LIMITS } from '../contracts/limits';
import { newId, nowMs } from '../storage/db';
import type { D1Like } from '../storage/queries';
import type { MemoryJobRow, MemoryRetainIntentRow } from './rows';

export const MEMORY_JOB_PRIORITY = {
  remove: 0,
  source_apply: 1,
  retain: 2,
  rebuild: 3,
  ensure_space: 4,
  recall: 5,
} as const;

export type MemoryJobOperationType = MemoryJobRow['operation_type'];

export const MEMORY_CURSOR_KINDS = {
  sourceApplied: 'source_applied_confirmed',
  derivedReady: 'derived_ready_confirmed',
  recallWatermark: 'recall_watermark',
  catchupScan: 'catchup_scan',
  reconciled: 'reconciled',
  /** MF09 Langfuse 拉取水位；按 binding 追加稳定后缀。 */
  langfuseImport: 'langfuse_import',
} as const;

export interface ClaimedMemoryJob {
  job: MemoryJobRow;
  lease_id: string;
}

function operationPlaceholders(types: readonly MemoryJobOperationType[]): string {
  return types.map(() => '?').join(', ');
}

/**
 * 领取到期作业。
 *
 * `phase=barrier` 只领取删除；`phase=write` 领取来源/提炼/重建；`phase=recall`
 * 单独领取召回。调用方按 barrier → write → recall 顺序调度，保证删除优先。
 */
export async function claimDueMemoryJobs(
  db: D1Like,
  options: {
    phase: 'barrier' | 'write' | 'recall';
    now?: number;
    limit?: number;
    leaseMs?: number;
  },
): Promise<ClaimedMemoryJob[]> {
  const at = options.now ?? nowMs();
  const leaseMs = options.leaseMs ?? LIMITS.memoryJobLeaseMs;
  const limit = Math.max(1, options.limit ?? LIMITS.memoryJobBatchLimit);
  const types: MemoryJobOperationType[] =
    options.phase === 'barrier'
      ? ['remove']
      : options.phase === 'recall'
        ? ['recall']
        : ['source_apply', 'retain', 'rebuild', 'ensure_space'];
  const rows = await db
    .prepare(
      `SELECT * FROM memory_jobs
        WHERE status = 'pending'
          AND next_attempt_at <= ?
          AND operation_type IN (${operationPlaceholders(types)})
        ORDER BY CASE operation_type
                   WHEN 'remove' THEN 0
                   WHEN 'source_apply' THEN 1
                   WHEN 'retain' THEN 2
                   WHEN 'rebuild' THEN 3
                   WHEN 'ensure_space' THEN 4
                   ELSE 5
                 END,
                 next_attempt_at,
                 created_at
        LIMIT ?`,
    )
    .bind(at, ...types, limit)
    .all<MemoryJobRow>();

  const claimed: ClaimedMemoryJob[] = [];
  for (const row of rows.results) {
    const leaseId = newId('mlease');
    const result = await db
      .prepare(
        `UPDATE memory_jobs
            SET status = 'leased', lease_id = ?, lease_until = ?, attempt = attempt + 1,
                updated_at = ?
          WHERE job_id = ? AND status = 'pending' AND next_attempt_at <= ?`,
      )
      .bind(leaseId, at + leaseMs, at, row.job_id, at)
      .run();
    if (result.meta.changes !== 1) continue;
    claimed.push({
      lease_id: leaseId,
      job: {
        ...row,
        status: 'leased',
        lease_id: leaseId,
        lease_until: at + leaseMs,
        attempt: row.attempt + 1,
        updated_at: at,
      },
    });
  }
  return claimed;
}

/**
 * 启动恢复：只恢复 Memory 自己的作业，不发明第二套业务恢复策略。
 *
 * - 还没有远端 JobRef、stage 仍在 accepted 的过期租约：安全回到 pending；
 * - 已拿到 JobRef 或阶段已推进：标 unknown，等待对账，不自动重跑。
 */
export async function recoverMemoryJobs(
  db: D1Like,
  options: { now?: number } = {},
): Promise<{ requeued: number; unknown: number }> {
  const at = options.now ?? nowMs();
  const expired = await db
    .prepare(
      "SELECT * FROM memory_jobs WHERE status = 'leased' AND lease_until IS NOT NULL AND lease_until < ?",
    )
    .bind(at)
    .all<MemoryJobRow>();
  let requeued = 0;
  let unknown = 0;
  for (const job of expired.results) {
    if (job.provider_job_id === null && job.stage === 'accepted') {
      const result = await db
        .prepare(
          `UPDATE memory_jobs
              SET status = 'pending', lease_id = NULL, lease_until = NULL,
                  next_attempt_at = ?, updated_at = ?
            WHERE job_id = ? AND status = 'leased' AND lease_id = ?`,
        )
        .bind(at, at, job.job_id, job.lease_id)
        .run();
      if (result.meta.changes === 1) requeued += 1;
    } else {
      const result = await db
        .prepare(
          `UPDATE memory_jobs
              SET status = 'unknown', unknown_since = ?, lease_id = NULL,
                  lease_until = NULL, updated_at = ?
            WHERE job_id = ? AND status = 'leased' AND lease_id = ?`,
        )
        .bind(at, at, job.job_id, job.lease_id)
        .run();
      if (result.meta.changes === 1) unknown += 1;
    }
  }
  return { requeued, unknown };
}

export type MemoryJobRemoteStatus = 'completed' | 'failed' | 'unknown' | 'unsupported';

/**
 * 对账 unknown 作业。
 *
 * 查询结果来自原 BackendRef；调用方必须保留 backend_binding_epoch，不能用
 * 旧 JobRef 查新库。unknown 不自动重跑，只有明确 completed/failed 才推进。
 */
export async function reconcileUnknownMemoryJobs(
  db: D1Like,
  options: {
    now?: number;
    limit?: number;
    queryStatus: (job: MemoryJobRow) => Promise<MemoryJobRemoteStatus>;
  },
): Promise<{ completed: number; requeued: number; stillUnknown: number; unsupported: number }> {
  const at = options.now ?? nowMs();
  const rows = await db
    .prepare(
      "SELECT * FROM memory_jobs WHERE status = 'unknown' ORDER BY unknown_since, created_at LIMIT ?",
    )
    .bind(Math.max(1, options.limit ?? LIMITS.memoryJobBatchLimit))
    .all<MemoryJobRow>();
  let completed = 0;
  let requeued = 0;
  let stillUnknown = 0;
  let unsupported = 0;
  for (const job of rows.results) {
    const status = await options.queryStatus(job);
    if (status === 'completed') {
      await completeMemoryJob(db, {
        jobId: job.job_id,
        stage: 'derived_ready',
        now: at,
      });
      completed += 1;
    } else if (status === 'failed') {
      // 明确失败的远端作业可以安全重试；operation_key 保证不重复写入。
      await failMemoryJob(db, {
        jobId: job.job_id,
        failure: 'unavailable',
        message: 'reconciled remote failure',
        now: at,
      });
      requeued += 1;
    } else if (status === 'unsupported') {
      await db
        .prepare(
          `UPDATE memory_jobs
              SET status = 'failed', last_error = 'remote_status_unsupported', updated_at = ?
            WHERE job_id = ? AND status = 'unknown'`,
        )
        .bind(at, job.job_id)
        .run();
      unsupported += 1;
    } else {
      stillUnknown += 1;
    }
  }
  const touchedSpaceIds = new Set(rows.results.map((job) => job.space_id));
  for (const spaceId of touchedSpaceIds) {
    if (!spaceId) continue;
    await advanceMemoryCursor(db, {
      scopeKind: 'space',
      scopeId: spaceId,
      cursorKind: MEMORY_CURSOR_KINDS.reconciled,
      value: at,
      now: at,
    });
  }
  return { completed, requeued, stillUnknown, unsupported };
}

export async function setMemoryJobProviderRef(
  db: D1Like,
  options: {
    jobId: string;
    leaseId: string;
    providerJobId: string;
    stage: MemoryJobRow['stage'];
    now?: number;
  },
): Promise<boolean> {
  const at = options.now ?? nowMs();
  const result = await db
    .prepare(
      `UPDATE memory_jobs
          SET provider_job_id = ?, stage = ?, updated_at = ?
        WHERE job_id = ? AND status = 'leased' AND lease_id = ?`,
    )
    .bind(options.providerJobId, options.stage, at, options.jobId, options.leaseId)
    .run();
  return result.meta.changes === 1;
}

export async function completeMemoryJob(
  db: D1Like,
  options: { jobId: string; leaseId?: string; stage: MemoryJobRow['stage']; now?: number },
): Promise<boolean> {
  const at = options.now ?? nowMs();
  const result = await db
    .prepare(
      `UPDATE memory_jobs
          SET status = 'completed', stage = ?, lease_id = NULL, lease_until = NULL,
              updated_at = ?, completed_at = ?
        WHERE job_id = ?
          AND status IN ('leased', 'pending', 'unknown')
          AND (? IS NULL OR lease_id = ?)`,
    )
    .bind(
      options.stage,
      at,
      at,
      options.jobId,
      options.leaseId ?? null,
      options.leaseId ?? null,
    )
    .run();
  if (result.meta.changes === 1) {
    const row = await db
      .prepare('SELECT * FROM memory_jobs WHERE job_id = ?')
      .bind(options.jobId)
      .first<MemoryJobRow>();
    if (row) {
      await updateRetainIntentForJob(db, {
        jobId: options.jobId,
        status: 'retained',
        now: at,
      });
    }
  }
  return result.meta.changes === 1;
}

export type MemoryJobFailure = 'unavailable' | 'unsupported' | 'timeout' | 'invalid_request' | 'fenced' | 'unknown';

export function memoryJobBackoffMs(attempt: number): number {
  const base = Math.min(
    LIMITS.memoryJobBackoffMaxMs,
    LIMITS.memoryJobBackoffBaseMs * 2 ** Math.max(0, attempt - 1),
  );
  return Math.max(LIMITS.memoryJobBackoffBaseMs, Math.round(base));
}

/** 失败分类：可重试的后端故障回到 pending；能力/请求错误显式 failed，不假装成功。 */
export async function failMemoryJob(
  db: D1Like,
  options: {
    jobId: string;
    leaseId?: string;
    failure: MemoryJobFailure;
    message?: string;
    now?: number;
  },
): Promise<MemoryJobRow['status']> {
  const at = options.now ?? nowMs();
  const job = await db
    .prepare('SELECT * FROM memory_jobs WHERE job_id = ?')
    .bind(options.jobId)
    .first<MemoryJobRow>();
  if (!job) return 'failed';
  const retryable =
    options.failure === 'unavailable' ||
    options.failure === 'timeout' ||
    options.failure === 'fenced';
  const exhausted = job.attempt >= LIMITS.memoryJobMaxAttempts;
  // 未知不是可重试失败：远端可能已执行，必须等对账，不能自动重跑。
  const status: MemoryJobRow['status'] =
    options.failure === 'unknown' ? 'unknown' : retryable && !exhausted ? 'pending' : 'failed';
  const nextAttemptAt =
    status === 'pending'
      ? at + memoryJobBackoffMs(job.attempt)
      : at + LIMITS.memoryJobBackoffMaxMs;
  await db
    .prepare(
      `UPDATE memory_jobs
          SET status = ?, lease_id = NULL, lease_until = NULL,
              next_attempt_at = ?, last_error = ?, updated_at = ?,
              unknown_since = CASE WHEN ? = 'unknown' THEN COALESCE(unknown_since, ?) ELSE unknown_since END
        WHERE job_id = ? AND (? IS NULL OR lease_id = ?)`,
    )
    .bind(
      status,
      nextAttemptAt,
      options.message ?? options.failure,
      at,
      status,
      at,
      options.jobId,
      options.leaseId ?? null,
      options.leaseId ?? null,
    )
    .run();
  if (status === 'failed' || status === 'unknown') {
    await updateRetainIntentForJob(db, {
      jobId: options.jobId,
      status: status === 'unknown' ? 'unknown' : 'failed',
      now: at,
    });
  }
  return status;
}

export async function loadRetainIntentForJob(
  db: D1Like,
  job: Pick<MemoryJobRow, 'retain_intent_id'>,
): Promise<MemoryRetainIntentRow | null> {
  if (!job.retain_intent_id) return null;
  return db
    .prepare('SELECT * FROM memory_retain_intents WHERE retain_id = ?')
    .bind(job.retain_intent_id)
    .first<MemoryRetainIntentRow>();
}

async function updateRetainIntentForJob(
  db: D1Like,
  options: { jobId: string; status: 'retained' | 'failed' | 'unknown' | 'skipped'; now: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_retain_intents
          SET status = ?, updated_at = ?
        WHERE job_id = ? AND status IN ('pending', 'leased', 'unknown', 'failed')`,
    )
    .bind(options.status, options.now, options.jobId)
    .run();
}

/** 连续确认前缀；不以最大完成序号代替。 */
export async function confirmedGovernancePrefix(
  db: D1Like,
  spaceId: string,
): Promise<{ prefix: number; first_unconfirmed: number | null }> {
  const rows = await db
    .prepare(
      `SELECT command_seq, status FROM memory_governance_commands
        WHERE space_id = ? ORDER BY command_seq`,
    )
    .bind(spaceId)
    .all<{ command_seq: number; status: string }>();
  let prefix = 0;
  let firstUnconfirmed: number | null = null;
  for (const row of rows.results) {
    if (row.status !== 'applied') {
      firstUnconfirmed = row.command_seq;
      break;
    }
    prefix = row.command_seq;
  }
  const cursor = await db
    .prepare(
      `SELECT value FROM memory_cursors
        WHERE scope_kind = 'space' AND scope_id = ? AND cursor_kind = ?`,
    )
    .bind(spaceId, MEMORY_CURSOR_KINDS.sourceApplied)
    .first<{ value: number }>();
  const stored = cursor?.value ?? 0;
  if (prefix > stored) {
    await db
      .prepare(
        `INSERT INTO memory_cursors (scope_kind, scope_id, cursor_kind, value, updated_at)
         VALUES ('space', ?, ?, ?, ?)
         ON CONFLICT(scope_kind, scope_id, cursor_kind)
         DO UPDATE SET value = MAX(memory_cursors.value, excluded.value),
                       updated_at = excluded.updated_at`,
      )
      .bind(spaceId, MEMORY_CURSOR_KINDS.sourceApplied, prefix, nowMs())
      .run();
  }
  return { prefix: Math.max(prefix, stored), first_unconfirmed: firstUnconfirmed };
}

/** 单调推进游标；用于来源/派生/召回各自独立的水位。 */
export async function advanceMemoryCursor(
  db: D1Like,
  options: {
    scopeKind: 'space' | 'agent' | 'room' | 'recall';
    scopeId: string;
    cursorKind: string;
    value: number;
    now?: number;
  },
): Promise<void> {
  const at = options.now ?? nowMs();
  await db
    .prepare(
      `INSERT INTO memory_cursors (scope_kind, scope_id, cursor_kind, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(scope_kind, scope_id, cursor_kind)
       DO UPDATE SET value = MAX(memory_cursors.value, excluded.value),
                     updated_at = excluded.updated_at`,
    )
    .bind(options.scopeKind, options.scopeId, options.cursorKind, options.value, at)
    .run();
}

export async function readMemoryCursor(
  db: D1Like,
  options: { scopeKind: 'space' | 'agent' | 'room' | 'recall'; scopeId: string; cursorKind: string },
): Promise<number | null> {
  const row = await db
    .prepare(
      'SELECT value FROM memory_cursors WHERE scope_kind = ? AND scope_id = ? AND cursor_kind = ?',
    )
    .bind(options.scopeKind, options.scopeId, options.cursorKind)
    .first<{ value: number }>();
  return row?.value ?? null;
}

/** 未知作业保持可见；调用方不能把它当成失败后自动重跑。 */
export async function countUnknownMemoryJobs(db: D1Like): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM memory_jobs WHERE status = 'unknown'")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

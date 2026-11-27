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
  /** 回填：已完整提交的窗口上界（毫秒，整点对齐）。 */
  backfillWindowTo: 'backfill_window_to',
  /** 回填：已检查到的最大 messages.rowid；恢复时回看安全行数。 */
  backfillScanRowid: 'backfill_scan_rowid',
  /** 空间首次 catch-up：已扫描到的最大 messages.rowid（scope=space）。 */
  spaceCatchupRowid: 'space_catchup_rowid',
  /** 空间首次 catch-up：1 表示该空间已完成初始补历史。 */
  spaceCatchupDone: 'space_catchup_done',
  /** provisioning sweep：已处理的最大 actors.rowid；扫完一轮后复位。 */
  provisionActorRowid: 'actor_rowid',
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

export type MemoryJobRemoteStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown'
  | 'unsupported';

/** 远端失败作业的显式重试结果；不与本地状态混淆。 */
export type MemoryJobRemoteRetry =
  | 'accepted'
  | 'rejected'
  | 'not_found'
  | 'unavailable'
  | 'unsupported';

interface MemoryJobJsonRecord {
  [key: string]: unknown;
}

function isJsonRecord(value: unknown): value is MemoryJobJsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 只合并观测字段；不把 provider 响应正文或凭据写回结果。 */
function mergeResultJson(
  existing: string | null,
  patch: Record<string, unknown> | undefined,
): string | null {
  if (!patch) return existing;
  let base: MemoryJobJsonRecord = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing) as unknown;
      if (isJsonRecord(parsed)) base = parsed;
    } catch {
      // 旧结果不合法时保留可诊断的分类字段，不复制原文。
      base = { previous_result: 'unparseable' };
    }
  }
  return JSON.stringify({ ...base, ...patch });
}

function resultNumber(existing: string | null, key: string): number {
  if (!existing) return 0;
  try {
    const parsed = JSON.parse(existing) as unknown;
    if (!isJsonRecord(parsed)) return 0;
    const value = parsed[key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** 对账状态写回之后发出的观测事件；不参与状态裁决。 */
export interface MemoryJobReconcileEvent {
  transition: 'remote_completed' | 'remote_failed' | 'remote_retry_requested';
  job: MemoryJobRow;
  remote_state: string | null;
  retry_outcome: MemoryJobRemoteRetry | null;
}

/**
 * 对账 unknown 作业。
 *
 * 查询结果来自原 BackendRef；调用方必须保留 backend_binding_epoch，不能用
 * 旧 JobRef 查新库。unknown 不立刻重跑：pending/processing 继续等待；远端
 * failed/cancelled 若适配器提供显式 retry，则先重新入队远端作业，再按既有
 * 本地退避策略回到 pending；持续 unknown 且对账轮次用尽后才重新提交同一
 * operation_id，不把“接受过”当作完成。
 *
 * 事件只在状态写回后发出；回调异常被吞掉，不能让已完成的写回变成 unknown。
 */
export async function reconcileUnknownMemoryJobs(
  db: D1Like,
  options: {
    now?: number;
    limit?: number;
    queryStatus: (job: MemoryJobRow) => Promise<MemoryJobRemoteStatus>;
    retryRemote?: (job: MemoryJobRow) => Promise<MemoryJobRemoteRetry>;
    onEvent?: (event: MemoryJobReconcileEvent) => void;
    /** 状态写回未生效等内部失败；只传分类信息，不含正文/凭据。 */
    onError?: (error: unknown, job: MemoryJobRow) => void;
  },
): Promise<{
  completed: number;
  requeued: number;
  retried: number;
  retryRejected: number;
  stillUnknown: number;
  unsupported: number;
  failed: number;
}> {
  const at = options.now ?? nowMs();
  const rows = await db
    .prepare(
      "SELECT * FROM memory_jobs WHERE status = 'unknown' ORDER BY unknown_since, created_at LIMIT ?",
    )
    .bind(Math.max(1, options.limit ?? LIMITS.memoryJobBatchLimit))
    .all<MemoryJobRow>();
  let completed = 0;
  let requeued = 0;
  let retried = 0;
  let retryRejected = 0;
  let stillUnknown = 0;
  let unsupported = 0;
  let failed = 0;
  const notify = (
    transition: MemoryJobReconcileEvent['transition'],
    current: MemoryJobRow,
    remoteState: string | null,
    retryOutcome: MemoryJobRemoteRetry | null = null,
  ): void => {
    try {
      options.onEvent?.({
        transition,
        job: current,
        remote_state: remoteState,
        retry_outcome: retryOutcome,
      });
    } catch {
      // 状态已写回；观测回调失败不能改变本次对账结果。
    }
  };
  const reportFailure = (current: MemoryJobRow, classification: string): void => {
    try {
      options.onError?.(new Error(classification), current);
    } catch {
      // 观测回调失败不能改变本次对账结果。
    }
  };
  for (const job of rows.results) {
    const status = await options.queryStatus(job);
    const attempts = resultNumber(job.result_json, 'reconcile_attempts') + 1;
    const observed = {
      reconcile_attempts: attempts,
      last_checked_at: at,
      provider_job_id: job.provider_job_id,
    };
    if (status === 'completed') {
      const written = await completeMemoryJob(db, {
        jobId: job.job_id,
        // 远端 completed 只证明写入处理器完成/源可读；observation/consolidation
        // 是否就绪由后续证据决定，不把对账结果升级成 derived_ready。
        stage: 'source_applied',
        now: at,
        resultPatch: {
          ...observed,
          status: 'completed',
          provider_state: 'completed',
          remote_state: 'completed',
          source_applied: true,
          derived_ready: false,
          remote_confirmed_at: at,
        },
      });
      if (!written) {
        // 写回未生效时作业仍是 unknown；不能计数或发出完成事件。
        reportFailure(job, 'memory_job_complete_writeback_rejected');
        stillUnknown += 1;
        continue;
      }
      completed += 1;
      notify('remote_completed', job, 'completed');
    } else if (status === 'failed' || status === 'cancelled') {
      const failurePatch = {
        ...observed,
        provider_state: status,
        remote_state: status,
        remote_failure_at: at,
      };
      // attempt 已到上限时不再请求远端 retry：远端即使重新入队，本地也无法再
      // 领取执行，会留下“accepted 但永远 failed”的分裂状态。
      const retryExhausted = job.attempt >= LIMITS.memoryJobMaxAttempts;
      if (retryExhausted) {
        const outcome = await failMemoryJob(db, {
          jobId: job.job_id,
          failure: 'unavailable',
          message: 'remote_failure_attempts_exhausted',
          now: at,
          resultPatch: { ...failurePatch, retry_outcome: 'attempts_exhausted' },
        });
        if (outcome === 'failed') failed += 1;
        else if (outcome === 'pending') requeued += 1;
        notify('remote_failed', job, status);
      } else if (options.retryRemote) {
        const retry = await options.retryRemote(job);
        if (retry === 'accepted') {
          // 远端已重新入队；本地回到 pending 走既有退避与幂等提交。
          const outcome = await failMemoryJob(db, {
            jobId: job.job_id,
            failure: 'unavailable',
            message: 'remote_retry_requested',
            now: at,
            resultPatch: {
              ...failurePatch,
              retry_requested_at: at,
              retry_outcome: 'accepted',
            },
          });
          notify('remote_failed', job, status, 'accepted');
          if (outcome === 'pending') {
            retried += 1;
            notify('remote_retry_requested', job, status, 'accepted');
          } else {
            // 防御性处理：远端已接受但没有回到 pending 时不报告 retry 成功。
            failed += 1;
          }
        } else {
          // 无法确认已重新入队时保留 unknown，继续可见、可再次对账。
          await mergeMemoryJobResult(db, {
            jobId: job.job_id,
            patch: { ...failurePatch, retry_outcome: retry },
            now: at,
          });
          retryRejected += 1;
          stillUnknown += 1;
          notify('remote_failed', job, status, retry);
        }
      } else {
        // 没有显式 retry 的适配器沿用原策略：明确失败可安全重试，
        // operation_key 保证不重复写入。
        const outcome = await failMemoryJob(db, {
          jobId: job.job_id,
          failure: 'unavailable',
          message: 'reconciled remote failure',
          now: at,
          resultPatch: { ...failurePatch, retry_outcome: 'unsupported' },
        });
        if (outcome === 'pending') requeued += 1;
        else if (outcome === 'failed') failed += 1;
        notify('remote_failed', job, status, 'unsupported');
      }
    } else if (status === 'unsupported') {
      await failMemoryJob(db, {
        jobId: job.job_id,
        failure: 'unsupported',
        message: 'remote_status_unsupported',
        now: at,
        resultPatch: {
          ...observed,
          provider_state: 'unsupported',
          remote_state: 'unsupported',
        },
      });
      unsupported += 1;
    } else {
      // pending/processing 继续等待，不重复提交；真正查不到作业（unknown）
      // 且已用完对账轮次时，按既有 attempt/backoff 重新提交同一 operation_id：
      // 幂等键与稳定 document_id 保证不会产生第二份逻辑表示。
      const remoteStillRunning = status === 'pending' || status === 'processing';
      if (!remoteStillRunning && attempts >= LIMITS.memoryJobMaxAttempts) {
        const outcome = await failMemoryJob(db, {
          jobId: job.job_id,
          failure: 'unavailable',
          message: 'remote_operation_unknown_requeued',
          now: at,
          resultPatch: {
            ...observed,
            provider_state: status,
            remote_state: status,
            retry_requested_at: at,
            retry_outcome: 'unknown_requeued',
          },
        });
        if (outcome === 'pending') requeued += 1;
        else failed += 1;
      } else {
        await mergeMemoryJobResult(db, {
          jobId: job.job_id,
          patch: { ...observed, provider_state: status, remote_state: status },
          now: at,
        });
        stillUnknown += 1;
      }
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
  return { completed, requeued, retried, retryRejected, stillUnknown, unsupported, failed };
}

/** 只更新结果观测字段，不改变作业状态；用于 pending/processing 轮询。 */
export async function mergeMemoryJobResult(
  db: D1Like,
  options: { jobId: string; patch: Record<string, unknown>; now?: number },
): Promise<void> {
  const at = options.now ?? nowMs();
  const row = await db
    .prepare('SELECT result_json FROM memory_jobs WHERE job_id = ?')
    .bind(options.jobId)
    .first<{ result_json: string | null }>();
  if (!row) return;
  await db
    .prepare(
      "UPDATE memory_jobs SET result_json = ?, updated_at = ? WHERE job_id = ? AND status = 'unknown'",
    )
    .bind(mergeResultJson(row.result_json, options.patch), at, options.jobId)
    .run();
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
  options: {
    jobId: string;
    leaseId?: string;
    stage: MemoryJobRow['stage'];
    /** 与状态变更同一条 UPDATE 写入的观测字段；不包含正文/凭据。 */
    resultPatch?: Record<string, unknown>;
    now?: number;
  },
): Promise<boolean> {
  const at = options.now ?? nowMs();
  const current = await db
    .prepare('SELECT * FROM memory_jobs WHERE job_id = ?')
    .bind(options.jobId)
    .first<MemoryJobRow>();
  if (!current) return false;
  const result = await db
    .prepare(
      `UPDATE memory_jobs
          SET status = 'completed', stage = ?, lease_id = NULL, lease_until = NULL,
              result_json = ?, updated_at = ?, completed_at = ?
        WHERE job_id = ?
          AND status IN ('leased', 'pending', 'unknown')
          AND (? IS NULL OR lease_id = ?)`,
    )
    .bind(
      options.stage,
      mergeResultJson(current.result_json, options.resultPatch),
      at,
      at,
      options.jobId,
      options.leaseId ?? null,
      options.leaseId ?? null,
    )
    .run();
  if (result.meta.changes === 1) {
    await updateRetainIntentForJob(db, {
      jobId: options.jobId,
      status: 'retained',
      now: at,
    });
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
    /** 与状态变更同一条 UPDATE 写入的观测字段；不包含正文/凭据。 */
    resultPatch?: Record<string, unknown>;
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
              next_attempt_at = ?, last_error = ?, result_json = ?, updated_at = ?,
              unknown_since = CASE WHEN ? = 'unknown' THEN COALESCE(unknown_since, ?) ELSE unknown_since END
        WHERE job_id = ? AND (? IS NULL OR lease_id = ?)`,
    )
    .bind(
      status,
      nextAttemptAt,
      options.message ?? options.failure,
      mergeResultJson(job.result_json, options.resultPatch),
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

/**
 * 历史遗留的“已完成但无远端确认”retain 作业数。
 *
 * 新链路在 result_json 写 remote_confirmed_at；没有该字段的 completed 行
 * 只可能来自旧版本或人工改库，必须可见而不是继续伪装成确认完成。
 */
export async function countUnconfirmedCompletedMemoryJobs(db: D1Like): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM memory_jobs
        WHERE operation_type = 'retain'
          AND status = 'completed'
          AND (result_json IS NULL OR result_json NOT LIKE '%"remote_confirmed_at"%')`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

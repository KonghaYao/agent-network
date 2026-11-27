/**
 * Task Focus 秘书作业：组批、派发与恢复。
 *
 * 作业按 owner 串行：每人同时至多一个活跃作业；同一批候选只进入一条
 * `agent.session.input.message`。远端调用使用作业预先落库的不可变
 * `attempt_ref` / `submission_key`，暂停、代次变化或租约过期都会拒绝旧尝试。
 * 所有失败只记录固定分类，不写 token、请求头或聊天正文。
 */

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import { newId, nowMs, randomToken } from '../storage/db';
import { guardSql } from '../storage/guards';
import type { Env } from '../env';
import type { FocusBindingRow, FocusCandidateRow, FocusJobRow } from '../domain/focus/types';
import {
  createFocusSwarmClient,
  FocusSwarmError,
  type FocusObservation,
  type FocusSwarmClient,
} from './swarm-client';

const ACTIVE_JOB_STATUSES = ['queued', 'submitted', 'running', 'waiting'] as const;
const ACTIVE_JOB_SQL = ACTIVE_JOB_STATUSES.map((status) => `'${status}'`).join(', ');
const ACTIVE_BINDING_STATUS = 'active';

const clients = new WeakMap<Env, FocusSwarmClient>();
const inFlight = new WeakMap<Env, Set<string>>();

export function focusSwarmClient(env: Env): FocusSwarmClient | null {
  if (!env.FOCUS) return null;
  let client = clients.get(env);
  if (!client) {
    client = createFocusSwarmClient(env.FOCUS);
    clients.set(env, client);
  }
  return client;
}

function markInFlight(env: Env, jobId: string): boolean {
  let set = inFlight.get(env);
  if (!set) {
    set = new Set();
    inFlight.set(env, set);
  }
  if (set.has(jobId)) return false;
  set.add(jobId);
  return true;
}

function clearInFlight(env: Env, jobId: string): void {
  inFlight.get(env)?.delete(jobId);
}

async function loadJob(db: D1Database, jobId: string): Promise<FocusJobRow | null> {
  return db
    .prepare('SELECT * FROM focus_jobs WHERE job_id = ?')
    .bind(jobId)
    .first<FocusJobRow>();
}

async function loadBinding(
  db: D1Database,
  owner: string,
): Promise<FocusBindingRow | null> {
  return db
    .prepare('SELECT * FROM focus_bindings WHERE owner_actor_id = ?')
    .bind(owner)
    .first<FocusBindingRow>();
}

async function releaseCandidates(db: D1Database, jobId: string, at: number): Promise<void> {
  await db
    .prepare(
      `UPDATE focus_candidates
          SET state = 'pending', job_id = NULL, updated_at = ?
        WHERE job_id = ? AND state = 'assigned'`,
    )
    .bind(at, jobId)
    .run();
}

async function failJob(
  db: D1Database,
  jobId: string,
  category: string,
  release: boolean,
  at: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE focus_jobs
          SET status = 'failed', last_error = ?, lease_until = NULL, updated_at = ?
        WHERE job_id = ? AND status IN ('queued', ${ACTIVE_JOB_SQL})`,
    )
    .bind(category, at, jobId)
    .run();
  if (release) await releaseCandidates(db, jobId, at);
}

async function cancelJob(db: D1Database, jobId: string, release: boolean, at: number) {
  await db
    .prepare(
      `UPDATE focus_jobs
          SET status = 'cancelled', lease_until = NULL, updated_at = ?
        WHERE job_id = ? AND status IN ('queued', ${ACTIVE_JOB_SQL})`,
    )
    .bind(at, jobId)
    .run();
  if (release) await releaseCandidates(db, jobId, at);
}

function isUniqueConflict(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return (
    text.includes('UNIQUE constraint failed: focus_jobs.owner_actor_id') ||
    text.includes('idx_focus_jobs_one_active') ||
    text.includes('focus_jobs.attempt_ref') ||
    text.includes('focus_jobs.submission_key')
  );
}

function isStaleAttempt(error: unknown): boolean {
  return error instanceof BusinessError && error.code === 'STALE_ATTEMPT';
}

export interface EnsureJobsOptions {
  /** 测试与恢复路径可先落库不派发；默认派发。 */
  dispatch?: boolean;
}

/**
 * 为每个 active 且没有活跃作业的 binding 组一批候选。
 *
 * 候选状态改为 assigned 与作业插入在同一 batch；并发下由部分唯一索引与
 * 候选归属闸门收敛，不会把同一候选分给两个作业。
 */
export async function ensureJobs(
  env: Env,
  options: EnsureJobsOptions = {},
): Promise<{ created: string[] }> {
  const db = env.DB;
  const created: string[] = [];
  const bindings = await db
    .prepare(`SELECT * FROM focus_bindings WHERE status = ?`)
    .bind(ACTIVE_BINDING_STATUS)
    .all<FocusBindingRow>();

  for (const binding of bindings.results) {
    const active = await db
      .prepare(
        `SELECT 1 AS present FROM focus_jobs
          WHERE owner_actor_id = ? AND status IN (${ACTIVE_JOB_SQL}) LIMIT 1`,
      )
      .bind(binding.owner_actor_id)
      .first<{ present: number }>();
    if (active) continue;

    const candidates = await db
      .prepare(
        `SELECT * FROM focus_candidates
          WHERE owner_actor_id = ? AND state = 'pending' AND job_id IS NULL
          ORDER BY event_seq, candidate_id
          LIMIT ?`,
      )
      .bind(binding.owner_actor_id, LIMITS.focusJobCandidatesMax)
      .all<FocusCandidateRow>();
    if (candidates.results.length === 0) continue;

    const jobId = newId('fjob');
    const attemptRef = newId('fat');
    const submissionKey = randomToken(24);
    const at = nowMs();
    const seqs = candidates.results.map((row) => row.event_seq);
    const eventFrom = Math.min(...seqs);
    const eventTo = Math.max(...seqs);
    const ids = candidates.results.map((row) => row.candidate_id);
    const placeholders = ids.map(() => '?').join(',');

    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO focus_jobs
               (job_id, owner_actor_id, secretary_actor_id, attempt_ref, submission_key,
                status, generation, event_from_seq, event_to_seq, turn_id, input_id,
                lease_until, attempt_count, last_error, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, NULL, NULL, NULL, 0, NULL, ?, ?)`,
          )
          .bind(
            jobId,
            binding.owner_actor_id,
            binding.secretary_actor_id,
            attemptRef,
            submissionKey,
            binding.generation,
            eventFrom,
            eventTo,
            at,
            at,
          ),
        db
          .prepare(
            `UPDATE focus_candidates
                SET job_id = ?, state = 'assigned', updated_at = ?
              WHERE candidate_id IN (${placeholders})
                AND owner_actor_id = ? AND state = 'pending' AND job_id IS NULL`,
          )
          .bind(jobId, at, ...ids, binding.owner_actor_id),
        // 候选被并发作业拿走时整批回滚；绑定暂停/代次变化同样拒绝。
        db
          .prepare(
            guardSql(
              'focusStaleAttempt',
              `(SELECT COUNT(*) FROM focus_candidates WHERE job_id = ? AND owner_actor_id = ? AND state = 'assigned') <> ?`,
            ),
          )
          .bind(jobId, binding.owner_actor_id, ids.length),
        db
          .prepare(
            guardSql(
              'focusStaleAttempt',
              `NOT EXISTS (SELECT 1 FROM focus_bindings WHERE owner_actor_id = ? AND status = 'active' AND generation = ?)`,
            ),
          )
          .bind(binding.owner_actor_id, binding.generation),
      ]);
      created.push(jobId);
    } catch (error) {
      if (isUniqueConflict(error) || isStaleAttempt(error)) continue;
      throw error;
    }
  }

  if (options.dispatch !== false) {
    for (const jobId of created) scheduleDispatch(env, jobId);
  }
  return { created };
}

/** 后台派发：失败只记固定分类，绝不让未处理的 rejection 逃逸。 */
function scheduleDispatch(env: Env, jobId: string): void {
  void dispatchFocusJob(env, jobId).catch(() => {
    console.error('agent-network focus dispatch failed: schedule');
  });
}

interface ObservationEvent {
  type: string | null;
  turnId: string | null;
  lastItemSeq: number | null;
}

function readObservationEvent(value: unknown): ObservationEvent {
  const record =
    value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const type = typeof record?.type === 'string' ? record.type : null;
  const turnIdSource = record?.turn_id ?? record?.turnId ?? record?.id;
  const turnId = typeof turnIdSource === 'string' ? turnIdSource : null;
  const seqSource = record?.seq ?? record?.item_seq ?? record?.last_item_seq;
  const lastItemSeq =
    typeof seqSource === 'number' && Number.isFinite(seqSource) ? seqSource : null;
  return { type, turnId, lastItemSeq };
}

/** 观察流只做 best-effort 对账；任何失败都不影响已提交的派发。 */
async function consumeObservation(
  env: Env,
  jobId: string,
  observation: FocusObservation,
): Promise<void> {
  const db = env.DB;
  try {
    for await (const raw of observation.events) {
      const event = readObservationEvent(raw);
      if (!event.type) continue;
      const at = nowMs();
      if (event.type === 'turn.completed' || event.type === 'agent.session.idle') {
        await db
          .prepare(
            `UPDATE focus_jobs
                SET status = CASE WHEN status = 'submitted' THEN 'waiting' ELSE status END,
                    turn_id = COALESCE(?, turn_id), updated_at = ?
              WHERE job_id = ? AND status IN ('submitted', 'running')`,
          )
          .bind(event.turnId, at, jobId)
          .run();
      } else if (event.type === 'turn.failed' || event.type === 'agent.session.failed') {
        await failJob(db, jobId, 'focus_turn_failed', true, at);
      }
    }
  } catch {
    // SSE 断开、心跳或代理错误：保留作业，交给租约恢复。
  } finally {
    observation.close();
  }
}

/**
 * 派发一个 queued 作业。
 *
 * 先 observe 再 submitInput；202 后写入 input_id 与租约。远端失败只写
 * 固定分类：会话缺失/暂时不可用进入 waiting，契约或鉴权错误直接 failed。
 */
export async function dispatchFocusJob(
  env: Env,
  jobId: string,
  clientOverride?: FocusSwarmClient,
): Promise<void> {
  const client = clientOverride ?? focusSwarmClient(env);
  if (!client) return;
  if (!markInFlight(env, jobId)) return;
  const db = env.DB;
  try {
    const job = await loadJob(db, jobId);
    if (!job || job.status !== 'queued') return;
    const binding = await loadBinding(db, job.owner_actor_id);
    const at = nowMs();
    if (
      !binding ||
      binding.status !== 'active' ||
      binding.generation !== job.generation ||
      binding.secretary_actor_id !== job.secretary_actor_id
    ) {
      // 恢复后的新代次可以重新组批；暂停期间的候选由 focusDisable 释放。
      await cancelJob(db, jobId, binding?.status === 'active', at);
      return;
    }

    let handle;
    try {
      handle = await client.ensureSession({
        sessionId: binding.session_id,
        rootSessionId: binding.root_session_id,
        provisioningKey: binding.provisioning_key,
      });
    } catch (error) {
      const category =
        error instanceof FocusSwarmError ? error.category : 'focus_swarm_unavailable';
      if (category === 'focus_session_missing' || category === 'focus_swarm_unavailable') {
        await db
          .prepare(
            `UPDATE focus_jobs
                SET status = 'waiting', last_error = ?, lease_until = NULL, updated_at = ?
              WHERE job_id = ? AND status = 'queued'`,
          )
          .bind(category, at, jobId)
          .run();
      } else {
        await failJob(db, jobId, category, true, at);
      }
      return;
    }

    const bound = await db
      .prepare(
        `UPDATE focus_bindings
            SET status = 'active', session_id = ?, root_session_id = ?, updated_at = ?
          WHERE owner_actor_id = ? AND secretary_actor_id = ? AND generation = ?
            AND status = 'active'`,
      )
      .bind(
        handle.sessionId,
        handle.rootSessionId,
        at,
        job.owner_actor_id,
        job.secretary_actor_id,
        job.generation,
      )
      .run();
    if ((bound.meta.changes ?? 0) === 0) {
      await cancelJob(db, jobId, false, at);
      return;
    }

    let observation: FocusObservation | null = null;
    try {
      observation = await client.observe(handle.sessionId);
    } catch {
      // 先订阅是首选路径；订阅失败不能阻止本次输入，后续用租约恢复对账。
      observation = null;
    }

    const candidateCount = await db
      .prepare(
        `SELECT COUNT(*) AS n FROM focus_candidates WHERE job_id = ? AND state = 'assigned'`,
      )
      .bind(jobId)
      .first<{ n: number }>();
    const text = [
      `job_id: ${job.job_id}`,
      `attempt_ref: ${job.attempt_ref}`,
      `候选 ${candidateCount?.n ?? 0} 条，事件区间 ${job.event_from_seq}-${job.event_to_seq}。`,
      '只使用本次 job_get 返回的 candidate_id；旧作业 candidate_id 已失效。',
      '请读取本次候选，核对来源后通过 network_focus_commit 提交个人看板决定。',
    ].join('\n');

    let receipt;
    try {
      receipt = await client.submitInput(handle.sessionId, text, job.submission_key);
    } catch (error) {
      observation?.close();
      const category =
        error instanceof FocusSwarmError ? error.category : 'focus_swarm_unavailable';
      if (category === 'focus_session_missing' || category === 'focus_swarm_unavailable') {
        await db
          .prepare(
            `UPDATE focus_jobs
                SET status = 'waiting', last_error = ?, lease_until = NULL, updated_at = ?
              WHERE job_id = ? AND status = 'queued'`,
          )
          .bind(category, at, jobId)
          .run();
      } else {
        await failJob(db, jobId, category, true, at);
      }
      return;
    }

    if (!receipt.accepted) {
      // 202 但未受理（例如队列拒绝）：保留候选等待下一次恢复重派。
      observation?.close();
      await db
        .prepare(
          `UPDATE focus_jobs
              SET status = 'waiting', last_error = 'focus_input_rejected',
                  lease_until = NULL, updated_at = ?
            WHERE job_id = ? AND status = 'queued'`,
        )
        .bind(at, jobId)
        .run();
      return;
    }

    const submitted = await db
      .prepare(
        `UPDATE focus_jobs
            SET status = 'submitted', input_id = ?, lease_until = ?, last_error = NULL,
                updated_at = ?
          WHERE job_id = ? AND status = 'queued'`,
      )
      .bind(receipt.inputId, nowMs() + LIMITS.focusJobLeaseMs, at, jobId)
      .run();
    if ((submitted.meta.changes ?? 0) === 0) {
      observation?.close();
      return;
    }
    if (observation) void consumeObservation(env, jobId, observation);
  } finally {
    clearInFlight(env, jobId);
  }
}

export interface RecoverJobsOptions {
  /** 进程启动：把遗留租约视为已过期，但 queued 作业不轮换尝试。 */
  startup?: boolean;
}

export interface RecoverJobsResult {
  dispatched: number;
  retried: number;
  failed: number;
  cancelled: number;
}

/**
 * 恢复过期租约与进程重启遗留的作业。
 *
 * attempt_count 未达上限时轮换 attempt_ref/submission_key 并重新派发；
 * 超限置 failed 并把候选释放回 pending。暂停、归档或代次变化直接取消。
 */
export async function recoverFocusJobs(
  env: Env,
  options: RecoverJobsOptions = {},
): Promise<RecoverJobsResult> {
  const db = env.DB;
  const result: RecoverJobsResult = { dispatched: 0, retried: 0, failed: 0, cancelled: 0 };
  if (!focusSwarmClient(env)) return result;

  const now = nowMs();
  const jobs = await db
    .prepare(
      `SELECT * FROM focus_jobs
        WHERE status IN ('queued', ${ACTIVE_JOB_SQL})
        ORDER BY created_at, job_id`,
    )
    .all<FocusJobRow>();

  for (const job of jobs.results) {
    const binding = await loadBinding(db, job.owner_actor_id);
    if (
      !binding ||
      binding.status !== 'active' ||
      binding.generation !== job.generation ||
      binding.secretary_actor_id !== job.secretary_actor_id
    ) {
      await cancelJob(db, job.job_id, false, now);
      result.cancelled += 1;
      continue;
    }

    if (job.status === 'queued') {
      scheduleDispatch(env, job.job_id);
      result.dispatched += 1;
      continue;
    }

    const leaseExpired = job.lease_until === null || job.lease_until < now;
    if (!leaseExpired && !options.startup) continue;
    if (job.status === 'waiting' && !leaseExpired) continue;

    if (job.attempt_count + 1 >= LIMITS.focusJobAttemptMax) {
      const failed = await db
        .prepare(
          `UPDATE focus_jobs
              SET status = 'failed', last_error = 'focus_attempts_exhausted',
                  lease_until = NULL, updated_at = ?
            WHERE job_id = ? AND status = ? AND attempt_ref = ?`,
        )
        .bind(now, job.job_id, job.status, job.attempt_ref)
        .run();
      if ((failed.meta.changes ?? 0) > 0) {
        await releaseCandidates(db, job.job_id, now);
        result.failed += 1;
      }
      continue;
    }

    const attemptRef = newId('fat');
    const submissionKey = randomToken(24);
    const rotated = await db
      .prepare(
        `UPDATE focus_jobs
            SET attempt_ref = ?, submission_key = ?, attempt_count = attempt_count + 1,
                status = 'queued', turn_id = NULL, input_id = NULL, lease_until = NULL,
                last_error = NULL, updated_at = ?
          WHERE job_id = ? AND status = ? AND attempt_ref = ?`,
      )
      .bind(attemptRef, submissionKey, now, job.job_id, job.status, job.attempt_ref)
      .run();
    if ((rotated.meta.changes ?? 0) === 0) continue;
    result.retried += 1;
    scheduleDispatch(env, job.job_id);
  }
  return result;
}

/**
 * 首次开通或恢复绑定：用已存 provisioning_key 幂等开通 Swarm 会话。
 *
 * 失败时不产生第二个秘书：transient 保持 provisioning，契约/鉴权错误置
 * failed；错误只记录固定分类。
 */
export async function provisionFocusBinding(env: Env, owner: string): Promise<void> {
  const client = focusSwarmClient(env);
  if (!client) return;
  const db = env.DB;
  const binding = await loadBinding(db, owner);
  if (!binding) return;
  if (binding.status !== 'provisioning' && binding.status !== 'active') return;
  if (binding.session_id && binding.root_session_id) return;

  const at = nowMs();
  try {
    const handle = await client.ensureSession({
      sessionId: binding.session_id,
      rootSessionId: binding.root_session_id,
      provisioningKey: binding.provisioning_key,
    });
    await db
      .prepare(
        `UPDATE focus_bindings
            SET status = 'active', session_id = ?, root_session_id = ?, updated_at = ?
          WHERE owner_actor_id = ? AND generation = ? AND status IN ('provisioning', 'active')`,
      )
      .bind(handle.sessionId, handle.rootSessionId, at, owner, binding.generation)
      .run();
  } catch (error) {
    const category =
      error instanceof FocusSwarmError ? error.category : 'focus_swarm_unavailable';
    if (
      category === 'focus_swarm_rejected' ||
      category === 'focus_swarm_unauthorized' ||
      category === 'focus_swarm_contract'
    ) {
      await db
        .prepare(
          `UPDATE focus_bindings SET status = 'failed', updated_at = ?
            WHERE owner_actor_id = ? AND generation = ? AND status = 'provisioning'`,
        )
        .bind(at, owner, binding.generation)
        .run();
    }
  }
}

export interface FocusCancelTarget {
  jobId: string;
  sessionId: string;
  generation: number;
}

/** 暂停前读取活跃作业与固定会话；暂停提交后用同一目标取消当前 turn。 */
export async function focusCancelTarget(
  db: D1Database,
  owner: string,
): Promise<FocusCancelTarget | null> {
  const row = await db
    .prepare(
      `SELECT j.job_id, b.session_id, b.generation
         FROM focus_jobs j JOIN focus_bindings b ON b.owner_actor_id = j.owner_actor_id
        WHERE j.owner_actor_id = ? AND b.session_id IS NOT NULL
          AND j.status IN (${ACTIVE_JOB_SQL})
        ORDER BY j.created_at DESC LIMIT 1`,
    )
    .bind(owner)
    .first<{ job_id: string; session_id: string; generation: number }>();
  if (!row) return null;
  return { jobId: row.job_id, sessionId: row.session_id, generation: row.generation };
}

/** 暂停后的异步取消；旧 turn 的后续写入由代次与租约拒绝。 */
export async function cancelFocusTurn(
  env: Env,
  target: FocusCancelTarget | null,
  clientOverride?: FocusSwarmClient,
): Promise<void> {
  if (!target) return;
  const client = clientOverride ?? focusSwarmClient(env);
  if (!client) return;
  try {
    await client.cancelActive(
      target.sessionId,
      `focus_cancel:${target.jobId}:g${target.generation + 1}`,
    );
  } catch {
    // 取消失败不恢复旧作业；代次已提升，旧尝试无法写卡。
  }
}

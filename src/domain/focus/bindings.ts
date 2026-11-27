/**
 * Task Focus 秘书绑定：状态、开启与暂停。
 *
 * 每位 Human 只能有一名秘书与一个绑定行。首次开启在同一事务里创建秘书
 * actor、绑定与幂等结果；并发开启或唯一键冲突重读同一行，不产生第二个
 * 秘书。本阶段不调用远端 Swarm，`runtime_ready` 恒为 false。
 */

import { BusinessError } from '../../contracts/errors';
import type {
  FocusDisableResult,
  FocusEnableResult,
  FocusStatusResult,
} from '../../contracts/focus';
import { newId, nowMs, randomToken, sha256Hex, stableStringify } from '../../storage/db';
import { guardSql } from '../../storage/guards';
import {
  operationsStatement,
  runIdempotent,
} from '../../storage/transactions/runner';
import type { Principal } from '../principal';
import { focusVisibleCounts } from './evidence';
import { focusOwner } from './helpers';
import { focusUpdatedStatements } from './notify';
import type { FocusBindingRow } from './types';

export const FOCUS_SECRETARY_NAME = '任务秘书';

const ACTIVE_JOB_STATUSES = "'queued', 'submitted', 'running', 'waiting'";

export async function getFocusBinding(
  db: D1Database,
  owner: string,
): Promise<FocusBindingRow | null> {
  return db
    .prepare('SELECT * FROM focus_bindings WHERE owner_actor_id = ?')
    .bind(owner)
    .first<FocusBindingRow>();
}

async function currentEventSeq(db: D1Database): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(MAX(event_seq), 0) AS seq FROM events')
    .first<{ seq: number }>();
  return row?.seq ?? 0;
}

async function statusOf(db: D1Database, owner: string): Promise<FocusStatusResult> {
  const binding = await getFocusBinding(db, owner);
  const counts = await focusVisibleCounts(db, owner);
  if (!binding) {
    return {
      enabled: false,
      status: 'disabled',
      counts,
      secretary_actor_id: null,
      runtime_ready: false,
    };
  }
  return {
    enabled: binding.status === 'provisioning' || binding.status === 'active',
    status: binding.status,
    counts,
    secretary_actor_id: binding.secretary_actor_id,
    // 只有远端会话与根会话都已登记时才认为运行时可用；本阶段不会置为 true。
    runtime_ready:
      binding.status === 'active' &&
      binding.session_id !== null &&
      binding.root_session_id !== null,
  };
}

/** 只写幂等结果；用于「已满足、无需变更」的重放。 */
async function persistResult(
  db: D1Database,
  owner: string,
  requestId: string,
  payloadHash: string,
  result: unknown,
  at: number,
): Promise<unknown> {
  return runIdempotent(db, {
    actorId: owner,
    requestId,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, owner, requestId, payloadHash, resultJson, at),
    ],
  });
}

function isFocusBindingConflict(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.includes('UNIQUE constraint failed: focus_bindings.');
}

function isStaleAttempt(error: unknown): boolean {
  return error instanceof BusinessError && error.code === 'STALE_ATTEMPT';
}

export async function focusStatus(
  db: D1Database,
  principal: Principal,
): Promise<FocusStatusResult> {
  const owner = focusOwner(principal);
  return statusOf(db, owner);
}

/**
 * 开启任务秘书。
 *
 * - 无绑定时创建秘书 actor 与绑定（status=provisioning、generation=1）。
 * - 已有 provisioning/active 绑定直接返回当前状态。
 * - 已 paused / failed 时 generation+1、回到 provisioning、重置水位。
 */
export async function focusEnable(
  db: D1Database,
  principal: Principal,
  input: { request_id: string },
): Promise<FocusEnableResult> {
  const owner = focusOwner(principal);
  const payloadHash = await sha256Hex(stableStringify(input));
  const at = nowMs();
  const existing = await getFocusBinding(db, owner);

  if (existing && (existing.status === 'provisioning' || existing.status === 'active')) {
    const result: FocusEnableResult = { ...(await statusOf(db, owner)), idempotent: true };
    // 同 request_id 重放必须返回首次调用的结果（idempotent=false）。
    return (await persistResult(
      db,
      owner,
      input.request_id,
      payloadHash,
      result,
      at,
    )) as FocusEnableResult;
  }

  const counts = await focusVisibleCounts(db, owner);

  if (existing) {
    const nextGeneration = existing.generation + 1;
    const watermark = await currentEventSeq(db);
    const result: FocusEnableResult = {
      enabled: true,
      status: 'provisioning',
      counts,
      secretary_actor_id: existing.secretary_actor_id,
      runtime_ready: false,
      idempotent: false,
    };
    try {
      await runIdempotent(db, {
        actorId: owner,
        requestId: input.request_id,
        payloadHash,
        result,
        build: (resultJson) => [
          operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
          db
            .prepare(
              `UPDATE focus_bindings
                  SET status = 'provisioning', generation = ?, event_from_seq = ?,
                      paused_at = NULL, updated_at = ?
                WHERE owner_actor_id = ? AND status IN ('paused', 'failed') AND generation = ?`,
            )
            .bind(nextGeneration, watermark, at, owner, existing.generation),
          // 代次未推进说明并发启停已先提交；整批回滚，由调用方重读。
          db
            .prepare(
              guardSql(
                'focusStaleAttempt',
                "NOT EXISTS (SELECT 1 FROM focus_bindings WHERE owner_actor_id = ? AND status = 'provisioning' AND generation = ?)",
              ),
            )
            .bind(owner, nextGeneration),
          ...focusUpdatedStatements(db, {
            ownerActorId: owner,
            change: 'resumed',
            generation: nextGeneration,
            eventKey: `focus_updated:${owner}:g${nextGeneration}:resumed`,
            at,
          }),
        ],
      });
      return result;
    } catch (error) {
      if (!isStaleAttempt(error)) throw error;
      const current: FocusEnableResult = { ...(await statusOf(db, owner)), idempotent: true };
      return (await persistResult(
        db,
        owner,
        input.request_id,
        payloadHash,
        current,
        nowMs(),
      )) as FocusEnableResult;
    }
  }

  const secretary = newId('agt');
  const result: FocusEnableResult = {
    enabled: true,
    status: 'provisioning',
    counts,
    secretary_actor_id: secretary,
    runtime_ready: false,
    idempotent: false,
  };
  const watermark = await currentEventSeq(db);
  return (await runIdempotent(db, {
    actorId: owner,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          `INSERT INTO actors
             (actor_id, kind, agent_session_id, name, metadata,
              inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
           VALUES (?, 'agent', NULL, ?, '{}', 0, 0, 0, ?, ?)`,
        )
        .bind(secretary, FOCUS_SECRETARY_NAME, at, at),
      db
        .prepare(
          `INSERT INTO focus_bindings
             (owner_actor_id, secretary_actor_id, provisioning_key, session_id,
              root_session_id, status, generation, event_from_seq, enabled_at,
              paused_at, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, 'provisioning', 1, ?, ?, NULL, ?, ?)`,
        )
        .bind(owner, secretary, randomToken(24), watermark, at, at, at),
      ...focusUpdatedStatements(db, {
        ownerActorId: owner,
        change: 'enabled',
        generation: 1,
        eventKey: `focus_updated:${owner}:g1:enabled`,
        at,
      }),
    ],
    onUniqueConflict: async (error) => {
      if (!isFocusBindingConflict(error)) return undefined;
      const raced = await getFocusBinding(db, owner);
      if (!raced) return undefined;
      const racedResult: FocusEnableResult = {
        ...(await statusOf(db, owner)),
        idempotent: true,
      };
      await persistResult(db, owner, input.request_id, payloadHash, racedResult, nowMs());
      return racedResult;
    },
  })) as FocusEnableResult;
}

/**
 * 暂停任务秘书。
 *
 * 幂等：已暂停或从未开启时只返回当前状态。暂停会提升代次并取消该 owner
 * 的活跃作业；卡与归档记录都保留。写 `focus_updated`，不写 inbox。
 */
export async function focusDisable(
  db: D1Database,
  principal: Principal,
  input: { request_id: string },
): Promise<FocusDisableResult> {
  const owner = focusOwner(principal);
  const payloadHash = await sha256Hex(stableStringify(input));
  const at = nowMs();
  const existing = await getFocusBinding(db, owner);

  if (!existing || existing.status === 'paused') {
    const result: FocusDisableResult = { ...(await statusOf(db, owner)), idempotent: true };
    return (await persistResult(
      db,
      owner,
      input.request_id,
      payloadHash,
      result,
      at,
    )) as FocusDisableResult;
  }

  const counts = await focusVisibleCounts(db, owner);
  const nextGeneration = existing.generation + 1;
  const result: FocusDisableResult = {
    enabled: false,
    status: 'paused',
    counts,
    secretary_actor_id: existing.secretary_actor_id,
    runtime_ready: false,
    idempotent: false,
  };
  try {
    await runIdempotent(db, {
      actorId: owner,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
        db
          .prepare(
            `UPDATE focus_bindings
                SET status = 'paused', generation = ?, paused_at = ?, updated_at = ?
              WHERE owner_actor_id = ? AND generation = ? AND status <> 'paused'`,
          )
          .bind(nextGeneration, at, at, owner, existing.generation),
        db
          .prepare(
            guardSql(
              'focusStaleAttempt',
              "NOT EXISTS (SELECT 1 FROM focus_bindings WHERE owner_actor_id = ? AND status = 'paused' AND generation = ?)",
            ),
          )
          .bind(owner, nextGeneration),
        db
          .prepare(
            `UPDATE focus_candidates
                SET state = 'pending', job_id = NULL, updated_at = ?
              WHERE owner_actor_id = ?
                AND job_id IN (
                  SELECT job_id FROM focus_jobs
                   WHERE owner_actor_id = ? AND status IN (${ACTIVE_JOB_STATUSES})
                )`,
          )
          .bind(at, owner, owner),
        db
          .prepare(
            `UPDATE focus_jobs SET status = 'cancelled', updated_at = ?
              WHERE owner_actor_id = ? AND status IN (${ACTIVE_JOB_STATUSES})`,
          )
          .bind(at, owner),
        ...focusUpdatedStatements(db, {
          ownerActorId: owner,
          change: 'paused',
          generation: nextGeneration,
          eventKey: `focus_updated:${owner}:g${nextGeneration}:paused`,
          at,
        }),
      ],
    });
    return result;
  } catch (error) {
    if (!isStaleAttempt(error)) throw error;
    const current: FocusDisableResult = { ...(await statusOf(db, owner)), idempotent: true };
    return (await persistResult(
      db,
      owner,
      input.request_id,
      payloadHash,
      current,
      nowMs(),
    )) as FocusDisableResult;
  }
}

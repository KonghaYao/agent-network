/**
 * Phase A：为存量 Agent 幂等补齐唯一的 active Memory space。
 *
 * 三条边界：
 * 1. 只建空间，不做 ownership transfer；已有 active space 原样返回，owner
 *    是否匹配留给 memory 工具路径的 `requireCurrentMemorySpace`。
 * 2. 不写 operations/events/outbox，也不排队 ensure_space；幂等由
 *    `WHERE NOT EXISTS` + `idx_memory_spaces_active` /
 *    `idx_memory_space_transitions_epoch` 保证。
 * 3. login/message/sweep 的失败只记录计数与分类，不影响业务结果。
 */
import { LIMITS } from '../contracts/limits';
import { getActiveManagement } from '../domain/agent-access';
import { nowMs, sha256Hex } from '../storage/db';
import {
  getActiveMemorySpace,
  getActor,
  getMemoryInstance,
  type D1Like,
} from '../storage/queries';
import type { MemorySpaceRow } from './rows';
import { resolveCurrentOwner } from './access';
import {
  advanceMemoryCursor,
  MEMORY_CURSOR_KINDS,
  readMemoryCursor,
} from './jobs';
import { memoryEnsureInstanceStatement } from './statements';

const PROVISION_SCOPE_ID = 'memory-provision';
const PROVISION_CURSOR_KIND = MEMORY_CURSOR_KINDS.provisionActorRowid;

export type MemoryProvisionSkipReason =
  | 'missing'
  | 'not_agent'
  | 'disabled'
  | 'archived'
  | 'no_instance';

export type MemoryProvisionConflictReason =
  | 'concurrent'
  | 'instance_mismatch'
  | 'ownership_changed';

export type MemorySpaceProvisionResult =
  | { status: 'created'; space: MemorySpaceRow }
  | { status: 'existing'; space: MemorySpaceRow }
  | { status: 'skipped'; reason: MemoryProvisionSkipReason }
  | { status: 'conflict'; reason: MemoryProvisionConflictReason }
  | { status: 'error'; reason: 'unavailable' };

export interface EnsureAgentSpaceOptions {
  agentId: string;
  instanceId: string | null | undefined;
  now?: number;
}

export interface MemoryProvisionSweepResult {
  scanned: number;
  created: number;
  existing: number;
  conflicts: number;
  skipped: number;
  errors: number;
  batches: number;
  cursor_reset: boolean;
  failure_reasons: Record<string, number>;
  duration_ms: number;
}

export interface MemoryProvisionStatus {
  running: boolean;
  last_run_at: number | null;
  last_run: MemoryProvisionSweepResult | null;
}

export interface MemoryProvisionerOptions {
  db: D1Like;
  instanceId: string;
  batchSize?: number;
  now?: () => number;
  log?: (detail: Record<string, unknown>) => void;
}

interface ProvisionEnv {
  DB: D1Like;
  MEMORY?: { instanceId?: string | null } | null;
  MEMORY_PROVISION?: boolean;
}

/** 记忆未启用或显式回滚时，login/message 入口保持 no-op。 */
export function memoryProvisionEnabled(env: {
  MEMORY?: { instanceId?: string | null } | null;
  MEMORY_PROVISION?: boolean;
}): boolean {
  return env.MEMORY_PROVISION !== false && typeof env.MEMORY?.instanceId === 'string';
}

function isUniqueConflict(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    text.includes('UNIQUE constraint failed') ||
    text.includes('idx_memory_spaces_active') ||
    text.includes('idx_memory_space_transitions_epoch')
  );
}

function classifyActive(
  space: MemorySpaceRow,
  instanceId: string,
  status: 'created' | 'existing',
): MemorySpaceProvisionResult {
  if (space.instance_id !== instanceId) {
    return { status: 'conflict', reason: 'instance_mismatch' };
  }
  return { status, space };
}

async function loadActiveQuietly(
  db: D1Like,
  agentId: string,
): Promise<MemorySpaceRow | null> {
  try {
    return await getActiveMemorySpace(db, agentId);
  } catch {
    return null;
  }
}

/**
 * 幂等补齐一个 Agent 的 active space。
 *
 * 已存在 active space 时只读一行并返回 existing；不会检查/转移 owner。
 * 并发落败方在 batch 失败后 re-read，避免把唯一索引冲突当成业务失败。
 */
export async function ensureAgentSpace(
  db: D1Like,
  options: EnsureAgentSpaceOptions,
): Promise<MemorySpaceProvisionResult> {
  const instanceId = options.instanceId?.trim();
  if (!instanceId) return { status: 'skipped', reason: 'no_instance' };
  const at = options.now ?? nowMs();

  let actor;
  try {
    actor = await getActor(db, options.agentId);
  } catch {
    return { status: 'error', reason: 'unavailable' };
  }
  if (!actor) return { status: 'skipped', reason: 'missing' };
  if (actor.kind !== 'agent') return { status: 'skipped', reason: 'not_agent' };
  if (actor.disabled_at !== null) return { status: 'skipped', reason: 'disabled' };
  if (actor.archived_at !== null) return { status: 'skipped', reason: 'archived' };

  const active = await loadActiveQuietly(db, options.agentId);
  if (active) return classifyActive(active, instanceId, 'existing');

  try {
    const instance = await getMemoryInstance(db);
    if (instance && instance.instance_id !== instanceId) {
      return { status: 'conflict', reason: 'instance_mismatch' };
    }

    const management = await getActiveManagement(db, options.agentId);
    const owner = resolveCurrentOwner(options.agentId, management);

    // 最近一个 space（含 inactive）的 excluded 是用户明确退出采集的选择，
    // 新空间必须继承；`none` 可能只是旧空间关闭，不能据此关闭新空间。
    const latest = await db
      .prepare(
        `SELECT capture FROM memory_spaces
          WHERE agent_actor_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .bind(options.agentId)
      .first<{ capture: string }>();
    const capture: 'pending' | 'excluded' =
      latest?.capture === 'excluded' ? 'excluded' : 'pending';

    // epoch 必须看该 Agent 的所有 space；只看 active 会与历史 transition 冲突。
    const epochRow = await db
      .prepare(
        'SELECT MAX(ownership_epoch) AS epoch FROM memory_spaces WHERE agent_actor_id = ?',
      )
      .bind(options.agentId)
      .first<{ epoch: number | null }>();
    const nextEpoch = (epochRow?.epoch ?? 0) + 1;

    const digest = (
      await sha256Hex(
        [instanceId, options.agentId, owner.owner_actor_id, String(nextEpoch)].join('|'),
      )
    ).slice(0, 32);
    const spaceId = `msp_pv_${digest}`;
    const transitionId = `mtr_pv_${digest}`;

    const results = await db.batch([
      memoryEnsureInstanceStatement(db, { instanceId, now: at }),
      db
        .prepare(
          `INSERT INTO memory_spaces
             (space_id, instance_id, agent_actor_id, owner_actor_id, ownership_kind,
              ownership_epoch, backend_binding_epoch, management_binding_id, capture, active,
              created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM memory_spaces WHERE agent_actor_id = ? AND active = 1
            )`,
        )
        .bind(
          spaceId,
          instanceId,
          options.agentId,
          owner.owner_actor_id,
          owner.ownership_kind,
          nextEpoch,
          owner.management_binding_id,
          capture,
          at,
          at,
          options.agentId,
        ),
      db
        .prepare(
          `INSERT INTO memory_space_transitions
             (transition_id, space_id, previous_space_id, agent_actor_id, kind,
              previous_owner_actor_id, next_owner_actor_id, previous_ownership_epoch,
              next_ownership_epoch, closed_host_binding_ids, created_at)
           SELECT ?, ?, NULL, ?, 'initial_enable', NULL, ?, 0, ?, '[]', ?
            WHERE NOT EXISTS (
              SELECT 1 FROM memory_space_transitions
               WHERE agent_actor_id = ? AND next_ownership_epoch = ?
            )
              AND EXISTS (SELECT 1 FROM memory_spaces WHERE space_id = ?)`,
        )
        .bind(
          transitionId,
          spaceId,
          options.agentId,
          owner.owner_actor_id,
          nextEpoch,
          at,
          options.agentId,
          nextEpoch,
          spaceId,
        ),
    ]);

    const stored = await getActiveMemorySpace(db, options.agentId);
    if (!stored) return { status: 'error', reason: 'unavailable' };
    const created = (results[1]?.meta.changes ?? 0) > 0;
    return classifyActive(stored, instanceId, created ? 'created' : 'existing');
  } catch (error) {
    // 并发唯一冲突或批次中某条语句失败：以已提交的 active space 为准。
    const stored = await loadActiveQuietly(db, options.agentId);
    if (stored) return classifyActive(stored, instanceId, 'existing');
    if (isUniqueConflict(error)) return { status: 'conflict', reason: 'concurrent' };
    return { status: 'error', reason: 'unavailable' };
  }
}

function recordFailure(
  failureReasons: Record<string, number>,
  result: MemorySpaceProvisionResult,
): void {
  if (result.status === 'skipped') {
    const key = `skipped_${result.reason}`;
    failureReasons[key] = (failureReasons[key] ?? 0) + 1;
  } else if (result.status === 'conflict') {
    const key = `conflict_${result.reason}`;
    failureReasons[key] = (failureReasons[key] ?? 0) + 1;
  } else if (result.status === 'error') {
    const key = `error_${result.reason}`;
    failureReasons[key] = (failureReasons[key] ?? 0) + 1;
  }
}

function actionLogDetail(
  source: 'login' | 'message',
  result: MemorySpaceProvisionResult,
  durationMs: number,
): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    event: 'agent_network.memory_provision',
    source,
    created: result.status === 'created' ? 1 : 0,
    existing: result.status === 'existing' ? 1 : 0,
    conflicts: result.status === 'conflict' ? 1 : 0,
    errors: result.status === 'error' ? 1 : 0,
    duration_ms: durationMs,
  };
  if (result.status === 'conflict' || result.status === 'error' || result.status === 'skipped') {
    detail.reason = result.reason;
  }
  return detail;
}

function logAction(
  source: 'login' | 'message',
  result: MemorySpaceProvisionResult,
  durationMs: number,
): void {
  if (result.status === 'created') {
    console.info(JSON.stringify(actionLogDetail(source, result, durationMs)));
  } else if (result.status === 'conflict' || result.status === 'error') {
    console.warn(JSON.stringify(actionLogDetail(source, result, durationMs)));
  }
}

/** login 钩子：失败只记录，不改变上线结果。 */
export async function provisionAgentOnLogin(
  env: ProvisionEnv,
  agentId: string,
): Promise<void> {
  if (!memoryProvisionEnabled(env)) return;
  const started = nowMs();
  try {
    const result = await ensureAgentSpace(env.DB, {
      agentId,
      instanceId: env.MEMORY?.instanceId,
      now: started,
    });
    logAction('login', result, nowMs() - started);
  } catch {
    console.warn(
      JSON.stringify({
        event: 'agent_network.memory_provision',
        source: 'login',
        created: 0,
        errors: 1,
        reason: 'exception',
        duration_ms: nowMs() - started,
      }),
    );
  }
}

const MESSAGE_PROVISIONED = new Set<string>();

/**
 * 消息提交后的 fire-and-forget 兜底：不等待、不改变发送结果。
 * 进程内只对同一 actor 触发一次；失败会移出集合，下一条消息可重试。
 */
export function provisionAgentAfterMessage(env: ProvisionEnv, agentId: string): void {
  if (!memoryProvisionEnabled(env) || MESSAGE_PROVISIONED.has(agentId)) return;
  MESSAGE_PROVISIONED.add(agentId);
  const started = nowMs();
  void ensureAgentSpace(env.DB, {
    agentId,
    instanceId: env.MEMORY?.instanceId,
    now: started,
  })
    .then((result) => {
      logAction('message', result, nowMs() - started);
      if (result.status === 'conflict' || result.status === 'error') {
        MESSAGE_PROVISIONED.delete(agentId);
      }
    })
    .catch(() => {
      MESSAGE_PROVISIONED.delete(agentId);
    });
}

/** 定时补偿：启动一次 + 每 6h；单轮只处理一批，单轮不重入。 */
export class MemoryProvisioner {
  readonly #db: D1Like;
  readonly #instanceId: string;
  readonly #batchSize: number;
  readonly #now: () => number;
  readonly #log: (detail: Record<string, unknown>) => void;

  #inFlight: Promise<MemoryProvisionSweepResult> | null = null;
  #lastRunAt: number | null = null;
  #lastRun: MemoryProvisionSweepResult | null = null;

  constructor(options: MemoryProvisionerOptions) {
    this.#db = options.db;
    this.#instanceId = options.instanceId;
    this.#batchSize = Math.max(1, options.batchSize ?? LIMITS.memoryProvisionSweepBatch);
    this.#now = options.now ?? nowMs;
    this.#log = options.log ?? ((detail) => console.info(JSON.stringify(detail)));
  }

  status(): MemoryProvisionStatus {
    return {
      running: this.#inFlight !== null,
      last_run_at: this.#lastRunAt,
      last_run: this.#lastRun,
    };
  }

  async runOnce(): Promise<MemoryProvisionSweepResult> {
    if (this.#inFlight) return this.#inFlight;
    const run = this.#sweep().finally(() => {
      if (this.#inFlight === run) this.#inFlight = null;
    });
    this.#inFlight = run;
    return run;
  }

  async #sweep(): Promise<MemoryProvisionSweepResult> {
    const started = this.#now();
    const cursor =
      (await readMemoryCursor(this.#db, {
        scopeKind: 'agent',
        scopeId: PROVISION_SCOPE_ID,
        cursorKind: PROVISION_CURSOR_KIND,
      })) ?? 0;

    const rows = await this.#db
      .prepare(
        `SELECT a.rowid AS actor_rowid, a.actor_id
           FROM actors a
          WHERE a.kind = 'agent'
            AND a.disabled_at IS NULL
            AND a.archived_at IS NULL
            AND a.rowid > ?
            AND NOT EXISTS (
              SELECT 1 FROM memory_spaces s
               WHERE s.agent_actor_id = a.actor_id AND s.active = 1
            )
          ORDER BY a.rowid
          LIMIT ?`,
      )
      .bind(cursor, this.#batchSize)
      .all<{ actor_rowid: number; actor_id: string }>();

    const failureReasons: Record<string, number> = {};
    let created = 0;
    let existing = 0;
    let conflicts = 0;
    let skipped = 0;
    let errors = 0;
    let lastRowid = cursor;

    for (const row of rows.results) {
      lastRowid = row.actor_rowid;
      const result = await ensureAgentSpace(this.#db, {
        agentId: row.actor_id,
        instanceId: this.#instanceId,
        now: this.#now(),
      });
      switch (result.status) {
        case 'created':
          created += 1;
          break;
        case 'existing':
          existing += 1;
          break;
        case 'conflict':
          conflicts += 1;
          recordFailure(failureReasons, result);
          break;
        case 'skipped':
          skipped += 1;
          recordFailure(failureReasons, result);
          break;
        case 'error':
          errors += 1;
          recordFailure(failureReasons, result);
          break;
      }
    }

    if (rows.results.length > 0) {
      await advanceMemoryCursor(this.#db, {
        scopeKind: 'agent',
        scopeId: PROVISION_SCOPE_ID,
        cursorKind: PROVISION_CURSOR_KIND,
        value: lastRowid,
        now: this.#now(),
      });
    }
    // 扫到队尾（或本轮无候选）后复位，下一轮从头覆盖新增/失败 Agent；
    // 已建空间的 Agent 由 NOT EXISTS 过滤，复位不会重复写。
    const cursorReset = rows.results.length < this.#batchSize;
    if (cursorReset) {
      await this.#db
        .prepare(
          `UPDATE memory_cursors
              SET value = 0, updated_at = ?
            WHERE scope_kind = 'agent' AND scope_id = ? AND cursor_kind = ?`,
        )
        .bind(this.#now(), PROVISION_SCOPE_ID, PROVISION_CURSOR_KIND)
        .run();
    }

    const result: MemoryProvisionSweepResult = {
      scanned: rows.results.length,
      created,
      existing,
      conflicts,
      skipped,
      errors,
      batches: rows.results.length > 0 ? 1 : 0,
      cursor_reset: cursorReset,
      failure_reasons: failureReasons,
      duration_ms: this.#now() - started,
    };
    this.#lastRunAt = this.#now();
    this.#lastRun = result;
    this.#log({
      event: 'agent_network.memory_provision',
      source: 'sweep',
      ...result,
    });
    return result;
  }
}

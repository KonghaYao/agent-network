/**
 * MF03：Memory 运行时生命周期。
 *
 * 运行时只领取 Memory 自己的持久作业；外部适配器调用永远在业务事务之外。
 * 进程在“本地提交后、外部响应前后”退出时：
 * - 意图列仍在 memory_jobs/memory_retain_intents，重启可恢复；
 * - 已拿到远端 JobRef 的租约标 unknown，只对账不重跑；
 * - 业务消息与 Memory 意图同批提交，SQLite 失败时一起回滚。
 */
import { LIMITS } from '../contracts/limits';
import { nowMs, sha256Hex } from '../storage/db';
import {
  getMemoryRecallRequest,
  getMemoryReceipt,
  getMemoryRepresentation,
  getMemorySourceRevision,
  getMemorySpaceById,
  listMemoryRepresentationDependencies,
  type D1Like,
} from '../storage/queries';
import type {
  MemoryJobRow,
  MemoryRepresentationRow,
  MemoryRetainIntentRow,
  MemorySpaceRow,
} from './rows';
import {
  MEMORY_POLICY_VERSION,
  type MemoryExposureEvidenceKind,
  type MemoryOriginKind,
  type MemoryRepresentation,
  type MemorySpaceRef,
} from './contracts';
import { ensureMemoryInstance } from './access';
import {
  claimDueMemoryJobs,
  completeMemoryJob,
  failMemoryJob,
  loadRetainIntentForJob,
  reconcileUnknownMemoryJobs,
  recoverMemoryJobs,
  setMemoryJobProviderRef,
} from './jobs';
import type {
  EnsureSpaceRequest,
  JobStatusResult,
  MemoryAdapter,
  MemoryAdapterCapabilities,
  MemoryAdapterJobRef,
  MemoryAdapterRemoveTarget,
  MemoryAdapterSearchPlan,
  RemoveRequest,
  RetainRequest,
  SearchRequest,
  SearchResult,
} from './adapters/types';

export interface MemoryRuntimeOptions {
  adapter: MemoryAdapter;
  /** 未配置时使用 memory_instances 的稳定行；首次启动生成。 */
  instanceId?: string | null;
  capture?: boolean;
  workerId?: string;
  leaseMs?: number;
  batchLimit?: number;
  now?: () => number;
  onError?: (error: unknown, job?: MemoryJobRow) => void;
}

export interface MemoryRuntimeTickResult {
  claimed: number;
  completed: number;
  requeued: number;
  unknown: number;
  failed: number;
  cancelled: number;
  suppressed: number;
}

const EMPTY_TICK: MemoryRuntimeTickResult = {
  claimed: 0,
  completed: 0,
  requeued: 0,
  unknown: 0,
  failed: 0,
  cancelled: 0,
  suppressed: 0,
};

function representationFromRow(row: MemoryRepresentationRow): MemoryRepresentation {
  const base = {
    representation_id: row.representation_id,
    text_bytes: row.text_bytes,
    text_sha256: row.text_sha256,
    verbatim: row.verbatim === 1,
  };
  switch (row.kind) {
    case 'raw_full':
    case 'raw_fragment':
    case 'preview': {
      if (row.source_id === null || row.source_revision === null || row.range_start === null || row.range_end === null) {
        throw new Error('raw representation missing source/range');
      }
      return {
        ...base,
        kind: row.kind,
        source_id: row.source_id,
        source_revision: row.source_revision,
        range: { start: row.range_start, end: row.range_end },
        depends_on: [],
      };
    }
    case 'summary':
      if (row.summary_id === null || row.summary_revision === null) {
        throw new Error('summary representation missing id/revision');
      }
      return {
        ...base,
        kind: 'summary',
        summary_id: row.summary_id,
        revision: row.summary_revision,
        depends_on: [],
        partition_proof:
          row.partition_id && row.partition_generation !== null && row.partition_policy_revision !== null
            ? {
                partition_id: row.partition_id,
                generation: row.partition_generation,
                policy_revision: row.partition_policy_revision,
                source_ids: [],
              }
            : null,
      };
    case 'memory_context':
      if (row.source_context_id === null) throw new Error('context representation missing context id');
      return {
        ...base,
        kind: 'memory_context',
        source_context_id: row.source_context_id,
        depends_on: [],
      };
    case 'authored':
      if (row.source_id === null || row.source_revision === null || row.producer_kind === null) {
        throw new Error('authored representation missing source/producer');
      }
      return {
        ...base,
        kind: 'authored',
        source_id: row.source_id,
        source_revision: row.source_revision,
        producer_kind: row.producer_kind,
        lineage: row.lineage ?? 'lineage_unknown',
        depends_on: [],
      };
  }
}

function spaceRef(row: MemorySpaceRow): MemorySpaceRef {
  return {
    space_id: row.space_id,
    ownership_epoch: row.ownership_epoch,
    backend_binding_epoch: row.backend_binding_epoch,
  };
}

function toJobRef(job: MemoryJobRow): MemoryAdapterJobRef | null {
  if (!job.provider_job_id) return null;
  return {
    backend_binding_epoch: job.backend_binding_epoch,
    provider_job_id: job.provider_job_id,
  };
}

export class MemoryRuntime {
  readonly #db: D1Like;
  readonly #options: MemoryRuntimeOptions;
  readonly #workerId: string;
  #instanceId: string | null = null;
  #started = false;
  #stopped = false;
  #inFlight: Promise<void> | null = null;
  #running = false;
  #capture: boolean;
  /** 本进程已确认的后端分区；键含 space/ownership/backend epoch。 */
  readonly #ensuredSpaces = new Set<string>();

  constructor(db: D1Like, options: MemoryRuntimeOptions) {
    this.#db = db;
    this.#options = options;
    this.#workerId = options.workerId ?? `memory-worker-${crypto.randomUUID().slice(0, 8)}`;
    this.#capture = options.capture ?? true;
  }

  get instanceId(): string | null {
    return this.#instanceId;
  }

  get captureEnabled(): boolean {
    return this.#capture;
  }

  get workerId(): string {
    return this.#workerId;
  }

  setCapture(enabled: boolean): void {
    this.#capture = enabled;
  }

  async start(): Promise<void> {
    if (this.#started) return;
    this.#instanceId = await ensureMemoryInstance(this.#db, {
      configuredId: this.#options.instanceId ?? null,
      now: this.now(),
      captureDefault: this.#capture ? 'enabled' : 'disabled',
    });
    await recoverMemoryJobs(this.#db, { now: this.now() });
    this.#started = true;
    this.#stopped = false;
    this.#ensuredSpaces.clear();
  }

  /**
   * 停止领取新作业；先中止在途适配器请求，再等待本轮收尾。
   *
   * 中止只让当前远端调用返回 cancelled/unavailable，作业按本地状态回到
   * pending/unknown；已提交的 Memory 意图与租约不会被删除。
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    const cancellable = this.#options.adapter as MemoryAdapter & { cancelAll?: () => void };
    if (typeof cancellable.cancelAll === 'function') {
      try {
        cancellable.cancelAll();
      } catch (error) {
        this.report(error);
      }
    }
    await this.#inFlight?.catch(() => undefined);
    this.#started = false;
  }

  private now(): number {
    return this.#options.now?.() ?? nowMs();
  }

  private report(error: unknown, job?: MemoryJobRow): void {
    this.#options.onError?.(error, job);
  }

  /** 业务提交后的低延迟唤醒；可靠性来自已提交的持久意图。 */
  onBusinessCommitted(): void {
    if (!this.#started || this.#stopped) return;
    void this.tick().catch((error) => this.report(error));
  }

  /**
   * 能力目录；只供服务层判断支持范围，不向 MCP/UI 转发 provider 路由。
   */
  capabilities(): MemoryAdapterCapabilities {
    return this.#options.adapter.capabilities();
  }

  /**
   * 显式召回直接查询引擎。
   *
   * 该路径不写经历、不产生 retain、不代替后台来源作业；调用方必须已用
   * 当前身份解析 space。适配器错误由调用方映射为 unavailable/unsupported。
   */
  async searchNow(
    space: SearchRequest['space'],
    plan: MemoryAdapterSearchPlan,
  ): Promise<SearchResult> {
    const key = `${space.space_id}:${space.ownership_epoch}:${space.backend_binding_epoch}`;
    if (!this.#ensuredSpaces.has(key)) {
      // ensureSpace 是加速/惰性建分区；读路径仍交给 search 决定可用性，
      // 个别只读适配器可能不实现 ensureSpace 但有可检索分区。
      const ensured = await this.#options.adapter.ensureSpace({
        space,
        operation_key: `ensure-space:${key}`,
        payload_sha256: await sha256Hex(`ensure-space|${key}`),
        deadline_at: null,
      });
      if (ensured.status === 'ready') this.#ensuredSpaces.add(key);
    }
    return this.#options.adapter.search({ space, plan });
  }

  private async updateJobResult(jobId: string, result: unknown): Promise<void> {
    await this.#db
      .prepare('UPDATE memory_jobs SET result_json = ?, updated_at = ? WHERE job_id = ?')
      .bind(JSON.stringify(result), this.now(), jobId)
      .run();
  }

  async tick(): Promise<MemoryRuntimeTickResult> {
    if (!this.#started || this.#stopped) return { ...EMPTY_TICK };
    if (this.#running) return { ...EMPTY_TICK };
    this.#running = true;
    const result: MemoryRuntimeTickResult = { ...EMPTY_TICK };
    this.#inFlight = (async () => {
      try {
        for (const phase of ['barrier', 'write', 'recall'] as const) {
          if (this.#stopped) break;
          const jobs = await claimDueMemoryJobs(this.#db, {
            phase,
            now: this.now(),
            limit: this.#options.batchLimit ?? LIMITS.memoryJobBatchLimit,
            leaseMs: this.#options.leaseMs ?? LIMITS.memoryJobLeaseMs,
          });
          result.claimed += jobs.length;
          for (const claimed of jobs) {
            if (this.#stopped) {
              // 已领取但尚未执行的作业立即放回 pending，避免优雅关闭后等待
              // 整个租约过期；已开始的适配器调用由 stop() 中止并走正常收尾。
              await this.releaseClaimedJob(claimed.job, claimed.lease_id);
              continue;
            }
            const outcome = await this.executeJob(claimed.job, claimed.lease_id);
            result[outcome] += 1;
          }
        }
      } finally {
        this.#running = false;
      }
    })();
    try {
      await this.#inFlight;
    } catch (error) {
      this.report(error);
    } finally {
      this.#inFlight = null;
    }
    return result;
  }

  private async executeJob(
    job: MemoryJobRow,
    leaseId: string,
  ): Promise<'completed' | 'requeued' | 'unknown' | 'failed' | 'cancelled' | 'suppressed'> {
    try {
      const space = await getMemorySpaceById(this.#db, job.space_id);
      const ownershipChanged =
        !space ||
        space.ownership_epoch !== job.ownership_epoch ||
        space.agent_actor_id !== job.agent_actor_id;
      // 删除/遗忘是屏障，不随活动空间关闭而取消；其他旧空间写入必须停。
      if (ownershipChanged || (space.active !== 1 && job.operation_type !== 'remove')) {
        await this.cancelJob(job, leaseId, 'space_ownership_changed');
        return 'cancelled';
      }

      if (
        !this.#capture &&
        (job.operation_type === 'retain' || job.operation_type === 'source_apply')
      ) {
        await this.suppressWriteJob(job, leaseId);
        return 'suppressed';
      }

      switch (job.operation_type) {
        case 'ensure_space':
          return await this.executeEnsureSpace(job, leaseId, space);
        case 'retain':
          return await this.executeRetain(job, leaseId, space);
        case 'remove':
          return await this.executeRemove(job, leaseId, space);
        case 'recall':
          return await this.executeRecall(job, leaseId, space);
        case 'source_apply':
          await failMemoryJob(this.#db, {
            jobId: job.job_id,
            leaseId,
            failure: 'unsupported',
            message: 'source_apply is wired by the source adapter (MF05)',
            now: this.now(),
          });
          return 'failed';
        case 'rebuild':
          await failMemoryJob(this.#db, {
            jobId: job.job_id,
            leaseId,
            failure: 'unsupported',
            message: 'rebuild requires an immutable backend revision',
            now: this.now(),
          });
          return 'failed';
      }
    } catch (error) {
      this.report(error, job);
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'unavailable',
        message: error instanceof Error ? error.message.slice(0, 512) : 'memory_job_failed',
        now: this.now(),
      }).catch((failure) => this.report(failure, job));
      return 'requeued';
    }
  }

  private async releaseClaimedJob(job: MemoryJobRow, leaseId: string): Promise<void> {
    const at = this.now();
    await this.#db
      .prepare(
        `UPDATE memory_jobs
            SET status = 'pending', lease_id = NULL, lease_until = NULL,
                next_attempt_at = ?, updated_at = ?
          WHERE job_id = ? AND status = 'leased' AND lease_id = ?`,
      )
      .bind(at, at, job.job_id, leaseId)
      .run();
  }

  private async cancelJob(job: MemoryJobRow, leaseId: string, reason: string): Promise<void> {
    const at = this.now();
    await this.#db
      .prepare(
        `UPDATE memory_jobs
            SET status = 'cancelled', lease_id = NULL, lease_until = NULL,
                last_error = ?, updated_at = ?
          WHERE job_id = ? AND status = 'leased' AND lease_id = ?`,
      )
      .bind(reason, at, job.job_id, leaseId)
      .run();
    await this.#db
      .prepare(
        `UPDATE memory_retain_intents
            SET status = 'suppressed', updated_at = ?
          WHERE job_id = ? AND status IN ('pending', 'leased')`,
      )
      .bind(at, job.job_id)
      .run();
  }

  private async suppressWriteJob(job: MemoryJobRow, leaseId: string): Promise<void> {
    const at = this.now();
    await this.#db
      .prepare(
        `UPDATE memory_jobs
            SET status = 'cancelled', lease_id = NULL, lease_until = NULL,
                last_error = 'capture_disabled', updated_at = ?
          WHERE job_id = ? AND status = 'leased' AND lease_id = ?`,
      )
      .bind(at, job.job_id, leaseId)
      .run();
    await this.#db
      .prepare(
        `UPDATE memory_retain_intents
            SET status = 'suppressed', updated_at = ?
          WHERE job_id = ? AND status IN ('pending', 'leased')`,
      )
      .bind(at, job.job_id)
      .run();
  }

  #spaceCacheKey(space: MemorySpaceRow): string {
    return `${space.space_id}:${space.ownership_epoch}:${space.backend_binding_epoch}`;
  }

  /**
   * 懒确保后端分区。
   *
   * 空间创建与外部后端创建是两件事：本地空间可能先于后端存在。写/删/召回
   * 作业在第一次访问某代次时先 ensureSpace；失败只让当前作业重排，不写业务
   * 数据，也不把未确认的分区当成已存在。
   */
  private async ensureBackendSpace(space: MemorySpaceRow): Promise<boolean> {
    const key = this.#spaceCacheKey(space);
    if (this.#ensuredSpaces.has(key)) return true;
    const result = await this.#options.adapter.ensureSpace({
      space: spaceRef(space),
      operation_key: `ensure-space:${key}`,
      payload_sha256: await sha256Hex(`ensure-space|${key}`),
      deadline_at: null,
    });
    if (result.status === 'ready') {
      this.#ensuredSpaces.add(key);
      return true;
    }
    return false;
  }

  private async executeEnsureSpace(
    job: MemoryJobRow,
    leaseId: string,
    space: MemorySpaceRow,
  ): Promise<'completed' | 'requeued' | 'unknown' | 'failed'> {
    const request: EnsureSpaceRequest = {
      space: spaceRef(space),
      operation_key: job.operation_key,
      payload_sha256: job.payload_sha256,
      deadline_at: null,
    };
    const result = await this.#options.adapter.ensureSpace(request);
    await this.updateJobResult(job.job_id, result);
    if (result.status === 'ready') {
      this.#ensuredSpaces.add(this.#spaceCacheKey(space));
      await completeMemoryJob(this.#db, { jobId: job.job_id, leaseId, stage: 'source_applied', now: this.now() });
      return 'completed';
    }
    if (result.status === 'pending' && result.job_ref) {
      await setMemoryJobProviderRef(this.#db, {
        jobId: job.job_id,
        leaseId,
        providerJobId: result.job_ref.provider_job_id,
        stage: 'accepted',
        now: this.now(),
      });
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'unknown',
        message: 'ensure_space_pending',
        now: this.now(),
      });
      return 'unknown';
    }
    if (result.status === 'unavailable') {
      await failMemoryJob(this.#db, { jobId: job.job_id, leaseId, failure: 'unavailable', now: this.now() });
      return 'requeued';
    }
    await failMemoryJob(this.#db, {
      jobId: job.job_id,
      leaseId,
      failure: result.status === 'unsupported' ? 'unsupported' : 'unknown',
      message: result.reason ?? result.status,
      now: this.now(),
    });
    return result.status === 'unsupported' ? 'failed' : 'unknown';
  }

  private async executeRetain(
    job: MemoryJobRow,
    leaseId: string,
    space: MemorySpaceRow,
  ): Promise<'completed' | 'requeued' | 'unknown' | 'failed'> {
    if (!(await this.ensureBackendSpace(space))) {
      throw new Error('memory_backend_space_unavailable');
    }
    const intent = await loadRetainIntentForJob(this.#db, job);
    if (!intent) {
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'invalid_request',
        message: 'retain intent missing',
        now: this.now(),
      });
      return 'failed';
    }
    const request = await this.buildRetainRequest(space, intent, job);
    const result = await this.#options.adapter.retain(request);
    await this.updateJobResult(job.job_id, result);
    if (result.status === 'accepted' || result.status === 'pending') {
      if (result.job_ref) {
        await setMemoryJobProviderRef(this.#db, {
          jobId: job.job_id,
          leaseId,
          providerJobId: result.job_ref.provider_job_id,
          stage: result.source_applied ? 'source_applied' : 'accepted',
          now: this.now(),
        });
      }
      if (result.source_applied && result.derived_ready) {
        await completeMemoryJob(this.#db, { jobId: job.job_id, leaseId, stage: 'derived_ready', now: this.now() });
        return 'completed';
      }
      if (result.job_ref) {
        await failMemoryJob(this.#db, {
          jobId: job.job_id,
          leaseId,
          failure: 'unknown',
          message: 'retain_pending_remote_job',
          now: this.now(),
        });
        return 'unknown';
      }
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'unavailable',
        message: 'retain_pending',
        now: this.now(),
      });
      return 'requeued';
    }
    if (result.status === 'unavailable') {
      await failMemoryJob(this.#db, { jobId: job.job_id, leaseId, failure: 'unavailable', now: this.now() });
      return 'requeued';
    }
    await failMemoryJob(this.#db, {
      jobId: job.job_id,
      leaseId,
      failure: 'unsupported',
      message: result.reason ?? 'retain_unsupported',
      now: this.now(),
    });
    return 'failed';
  }

  private async buildRetainRequest(
    space: MemorySpaceRow,
    intent: MemoryRetainIntentRow,
    job: MemoryJobRow,
  ): Promise<RetainRequest> {
    const representationRow = await getMemoryRepresentation(
      this.#db,
      intent.representation_id,
    );
    if (!representationRow) throw new Error('retain representation missing');
    const actualHash = await sha256Hex(representationRow.text);
    if (actualHash !== representationRow.text_sha256) {
      throw new Error('retain representation hash mismatch');
    }
    const representation = representationFromRow(representationRow);
    const dependencyRows = await listMemoryRepresentationDependencies(
      this.#db,
      intent.representation_id,
    );
    const representationWithDependencies: MemoryRepresentation = {
      ...representation,
      depends_on: dependencyRows.map((row) => ({
        source_id: row.source_id,
        source_revision: row.source_revision,
        representation_id: row.depends_on_representation_id,
        range:
          row.range_start !== null && row.range_end !== null
            ? { start: row.range_start, end: row.range_end }
            : null,
      })),
    } as MemoryRepresentation;
    let source: { source_id: string; source_revision: number } | null = null;
    if (intent.source_id && intent.source_revision !== null) {
      const sourceRow = await getMemorySourceRevision(
        this.#db,
        intent.source_id,
        intent.source_revision,
      );
      if (!sourceRow) throw new Error('retain source missing');
      source = { source_id: sourceRow.source_id, source_revision: sourceRow.revision };
    }
    let eligibility: RetainRequest['items'][number]['eligibility'];
    if (intent.origin_kind === 'experienced') {
      const receipt = intent.receipt_id
        ? await getMemoryReceipt(this.#db, intent.receipt_id)
        : null;
      if (!receipt || !receipt.evidence) throw new Error('experienced retain missing receipt');
      eligibility = {
        kind: 'experienced',
        evidence: receipt.evidence as MemoryExposureEvidenceKind,
        receipt_id: receipt.receipt_id,
        proof_id: receipt.proof_id,
      };
    } else if (intent.origin_kind === 'authored') {
      eligibility = {
        kind: 'authored',
        producer_kind: representationRow.producer_kind ?? 'agent_text',
        experience_id: intent.experience_id ?? intent.retain_id,
      };
    } else {
      eligibility = {
        kind: 'curated',
        curated_id: intent.curated_id ?? intent.experience_id ?? intent.retain_id,
        revision: intent.curated_revision ?? 1,
      };
    }
    return {
      space: spaceRef(space),
      operation_key: intent.operation_key,
      payload_sha256: intent.payload_sha256,
      items: [
        {
          origin_kind: intent.origin_kind as MemoryOriginKind,
          representation: { representation: representationWithDependencies, text: representationRow.text },
          source,
          eligibility,
        },
      ],
      policy_version: MEMORY_POLICY_VERSION,
      deadline_at: null,
    };
  }

  private async executeRemove(
    job: MemoryJobRow,
    leaseId: string,
    space: MemorySpaceRow,
  ): Promise<'completed' | 'requeued' | 'unknown' | 'failed'> {
    if (!(await this.ensureBackendSpace(space))) {
      throw new Error('memory_backend_space_unavailable');
    }
    const targets = this.parseRemoveTargets(job);
    if (targets === null) {
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'unsupported',
        message: 'unsupported_granularity',
        now: this.now(),
      });
      return 'failed';
    }
    const request: RemoveRequest = {
      space: spaceRef(space),
      operation_key: job.operation_key,
      payload_sha256: job.payload_sha256,
      targets,
      policy_version: MEMORY_POLICY_VERSION,
      deadline_at: null,
    };
    const result = await this.#options.adapter.remove(request);
    await this.updateJobResult(job.job_id, result);
    if (result.purge === 'purged') {
      await completeMemoryJob(this.#db, { jobId: job.job_id, leaseId, stage: 'derived_ready', now: this.now() });
      return 'completed';
    }
    if (result.status === 'accepted' && result.job_ref) {
      await setMemoryJobProviderRef(this.#db, {
        jobId: job.job_id,
        leaseId,
        providerJobId: result.job_ref.provider_job_id,
        stage: 'accepted',
        now: this.now(),
      });
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'unknown',
        message: 'remove_pending_purge',
        now: this.now(),
      });
      return 'unknown';
    }
    if (result.status === 'unavailable') {
      await failMemoryJob(this.#db, { jobId: job.job_id, leaseId, failure: 'unavailable', now: this.now() });
      return 'requeued';
    }
    await failMemoryJob(this.#db, {
      jobId: job.job_id,
      leaseId,
      failure: 'unsupported',
      message: result.purge,
      now: this.now(),
    });
    return 'failed';
  }

  private parseRemoveTargets(job: MemoryJobRow): readonly MemoryAdapterRemoveTarget[] | null {
    if (!job.target_json) return null;
    try {
      const parsed = JSON.parse(job.target_json) as unknown;
      return Array.isArray(parsed) ? (parsed as MemoryAdapterRemoveTarget[]) : null;
    } catch {
      return null;
    }
  }

  private async executeRecall(
    job: MemoryJobRow,
    leaseId: string,
    space: MemorySpaceRow,
  ): Promise<'completed' | 'requeued' | 'unknown' | 'failed'> {
    if (!(await this.ensureBackendSpace(space))) {
      throw new Error('memory_backend_space_unavailable');
    }
    if (!job.recall_id) {
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'invalid_request',
        message: 'recall id missing',
        now: this.now(),
      });
      return 'failed';
    }
    const recall = await getMemoryRecallRequest(this.#db, job.recall_id);
    if (!recall) {
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'invalid_request',
        message: 'recall request missing',
        now: this.now(),
      });
      return 'failed';
    }
    const plan = recall.plan_json ? (JSON.parse(recall.plan_json) as SearchRequest['plan']) : null;
    if (!plan) {
      await failMemoryJob(this.#db, {
        jobId: job.job_id,
        leaseId,
        failure: 'invalid_request',
        message: 'recall plan missing',
        now: this.now(),
      });
      return 'failed';
    }
    const result = await this.#options.adapter.search({
      space: spaceRef(space),
      plan,
    });
    await this.updateJobResult(job.job_id, result);
    await this.#db
      .prepare(
        `UPDATE memory_recall_requests
            SET status = ?, result_json = ?, updated_at = ?
          WHERE recall_id = ?`,
      )
      .bind(
        result.status === 'ready' || result.status === 'empty' || result.status === 'pending' || result.status === 'unsupported'
          ? result.status
          : 'unavailable',
        JSON.stringify(result),
        this.now(),
        job.recall_id,
      )
      .run();
    if (result.status === 'ready' || result.status === 'empty') {
      await completeMemoryJob(this.#db, { jobId: job.job_id, leaseId, stage: 'derived_ready', now: this.now() });
      return 'completed';
    }
    if (result.status === 'pending') {
      await failMemoryJob(this.#db, { jobId: job.job_id, leaseId, failure: 'unavailable', now: this.now() });
      return 'requeued';
    }
    await failMemoryJob(this.#db, {
      jobId: job.job_id,
      leaseId,
      failure: result.status === 'unsupported' ? 'unsupported' : 'unavailable',
      message: result.reason ?? result.status,
      now: this.now(),
    });
    return result.status === 'unsupported' ? 'failed' : 'requeued';
  }

  /** 对账 unknown；只在明确 completed/failed 时推进。 */
  async reconcile(): Promise<{ completed: number; requeued: number; stillUnknown: number; unsupported: number }> {
    return reconcileUnknownMemoryJobs(this.#db, {
      now: this.now(),
      limit: this.#options.batchLimit ?? LIMITS.memoryJobBatchLimit,
      queryStatus: async (job) => {
        const ref = toJobRef(job);
        const space = await getMemorySpaceById(this.#db, job.space_id);
        if (!ref || !space || space.backend_binding_epoch !== job.backend_binding_epoch) {
          return 'unsupported';
        }
        try {
          const status: JobStatusResult = await this.#options.adapter.jobStatus({
            space: spaceRef(space),
            job_ref: ref,
          });
          if (status.state === 'completed') return 'completed';
          if (status.state === 'failed' || status.state === 'cancelled') {
            return status.retryable ? 'failed' : 'unsupported';
          }
          return 'unknown';
        } catch (error) {
          this.report(error, job);
          return 'unknown';
        }
      },
    });
  }

  async health(): Promise<{
    instance_id: string | null;
    capture: boolean;
    pending: number;
    leased: number;
    unknown: number;
    failed: number;
    retain_pending: number;
  }> {
    const counts = await this.#db
      .prepare('SELECT status, COUNT(*) AS n FROM memory_jobs GROUP BY status')
      .all<{ status: string; n: number }>();
    const byStatus = new Map(counts.results.map((row) => [row.status, row.n]));
    const retain = await this.#db
      .prepare("SELECT COUNT(*) AS n FROM memory_retain_intents WHERE status IN ('pending','leased')")
      .first<{ n: number }>();
    return {
      instance_id: this.#instanceId,
      capture: this.#capture,
      pending: byStatus.get('pending') ?? 0,
      leased: byStatus.get('leased') ?? 0,
      unknown: byStatus.get('unknown') ?? 0,
      failed: byStatus.get('failed') ?? 0,
      retain_pending: retain?.n ?? 0,
    };
  }
}

export type MemoryRuntimeState = Pick<MemoryRuntimeTickResult, 'claimed' | 'completed'>;

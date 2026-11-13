/**
 * MF04 Hindsight HTTP 适配器。
 *
 * 端点形状按 Hindsight HTTP API 1.2.1（`GET /openapi.json`）实现：
 * - PUT    /v1/default/banks/{bank}
 * - POST   /v1/default/banks/{bank}/memories
 * - POST   /v1/default/banks/{bank}/memories/recall
 * - GET    /v1/default/banks/{bank}/memories/list
 * - GET    /v1/default/banks/{bank}/documents
 * - DELETE /v1/default/banks/{bank}/documents/{document}
 * - GET    /v1/default/banks/{bank}/operations/{operation}
 *
 * 真实部署已用唯一测试 bank 验收保留/召回/列表/删除与清理；默认仍使用 stub。
 * 所有配置由服务端注入，base URL 在加载时归一化（去掉尾随 `/`），凭据只通过
 * Authorization 头发送，不进入 URL、结果、capabilities、错误文本或日志。
 */
import type { MemoryBackendRef, MemoryPurgeState } from '../contracts';
import {
  type EnsureSpaceRequest,
  type EnsureSpaceResult,
  type JobStatusRequest,
  type JobStatusResult,
  type MemoryAdapter,
  type MemoryAdapterCapabilities,
  type MemoryAdapterFailureReason,
  type MemoryAdapterJobRef,
  type MemoryAdapterJobState,
  type MemoryAdapterProcessorStage,
  type RemoveRequest,
  type RemoveResult,
  type RetainRequest,
  type RetainResult,
  type SearchRequest,
  type SearchResult,
} from './types';
import {
  resolveHindsightConfig,
  type HindsightAdapterConfig,
  type ResolvedHindsightConfig,
} from './hindsight-config';
import { HindsightTransport } from './hindsight-transport';
import {
  bankIdFor,
  isRecord,
  nonEmptyString,
  operationIdFor,
  validEpoch,
  validSpaceRef,
} from './hindsight-tags';
import { prepareRetainItems, validRetainEnvelope } from './hindsight-retain';
import {
  searchList,
  searchRecall,
  unsupportedSearchFilter,
  type SearchFilterPlan,
} from './hindsight-search';
import { prepareRemove, removeDocuments } from './hindsight-remove';

export {
  loadHindsightConfigFromEnv,
  type HindsightAdapterConfig,
  type HindsightConfigLoadResult,
} from './hindsight-config';

export class HindsightMemoryAdapter implements MemoryAdapter {
  readonly #config: ResolvedHindsightConfig | null;
  readonly #transport: HindsightTransport | null;
  readonly #configurationError: string | null;

  /**
   * null 表示配置缺失：所有操作 fail closed，返回 unavailable/unknown，绝不发请求。
   * 非法 URL/数值会抛错（错误文本不含凭据），由启动方决定是否停用 MemoryRuntime。
   */
  constructor(config: HindsightAdapterConfig | null) {
    const resolved = resolveHindsightConfig(config);
    this.#config = resolved;
    this.#transport = resolved ? new HindsightTransport(resolved) : null;
    this.#configurationError = resolved ? null : 'configuration_missing';
  }

  get configured(): boolean {
    return this.#config !== null;
  }

  get configurationError(): string | null {
    return this.#configurationError;
  }

  /** 进程关闭/取消时中止进行中的请求；已提交的远端作业由 jobStatus 对账。 */
  cancelAll(): void {
    this.#transport?.cancelAll();
  }

  capabilities(): MemoryAdapterCapabilities {
    return {
      provider: 'hindsight',
      // recall 是单次 top-K（无 offset）；query 为空时走 memories/list 分页。
      pagination: true,
      // origin/source 通过服务端标签真硬过滤。
      hard_filters: ['origin_kind', 'source_id'],
      // recall 的 temporal_window 只影响排序；list 的 start_date/end_date 是硬过滤，
      // 但语义召回（有 query）无法硬时间过滤，因此不能声明 hard_filter。
      time_window: 'ranking_hint_only',
      // Hindsight 提取 fact，正文可能被改写；不能声称逐字来源完整。
      source_completeness: 'partial',
      // 每个 space + backend epoch 使用独立 bank。
      partition_isolation: 'provider_partition',
      // 后端存在 POST .../reflect；MF04 核心六操作不调用，扩展接入时再声明消费方。
      reflect: true,
      native_export: false,
      // 表示/修订使用不可变 document_id；重试 same payload 幂等。
      immutable_revisions: true,
      remove_granularity: 'exact_representation',
      // backend_binding_epoch 参与 bank 路由；同代次内没有条件写 fencing。
      write_fence: 'partition_generation',
    };
  }

  async ensureSpace(request: EnsureSpaceRequest): Promise<EnsureSpaceResult> {
    const transport = this.#transport;
    if (!transport) return this.disabledEnsureSpace();
    if (!validSpaceRef(request.space) || !nonEmptyString(request.operation_key)) {
      return { status: 'unavailable', backend_ref: null, job_ref: null, reason: 'invalid_request' };
    }
    const bankId = await bankIdFor(transport.config.bankPrefix, request.space);
    const outcome = await transport.request(
      'PUT',
      `/v1/default/banks/${encodeURIComponent(bankId)}`,
      { body: {}, deadlineAt: request.deadline_at, retry: true },
    );
    if (outcome.kind === 'ok') {
      const backendRef: MemoryBackendRef = {
        space: request.space,
        provider_id: bankId,
        provider_revision: String(request.space.backend_binding_epoch),
      };
      return { status: 'ready', backend_ref: backendRef, job_ref: null, reason: null };
    }
    return {
      status:
        outcome.kind === 'http' && (outcome.status === 400 || outcome.status === 422)
          ? 'unsupported'
          : 'unavailable',
      backend_ref: null,
      job_ref: null,
      reason: transport.reasonFor(outcome, 'unavailable'),
    };
  }

  async retain(request: RetainRequest): Promise<RetainResult> {
    const transport = this.#transport;
    if (!transport) return this.disabledRetain();
    if (
      !validRetainEnvelope({
        space: request.space,
        operation_key: request.operation_key,
        payload_sha256: request.payload_sha256,
        items: request.items,
      })
    ) {
      return this.retainFailure('unsupported', 'invalid_request');
    }
    const prepared = await prepareRetainItems(request.space, request.items);
    if ('error' in prepared) return this.retainFailure('unsupported', 'invalid_request');
    const bankId = await bankIdFor(transport.config.bankPrefix, request.space);
    const operationId = await operationIdFor(request.space, request.operation_key);
    const outcome = await transport.request(
      'POST',
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories`,
      {
        body: {
          async: true,
          operation_id: operationId,
          items: prepared.items,
        },
        deadlineAt: request.deadline_at,
        retry: true,
      },
    );
    if (outcome.kind === 'ok') {
      if (!isRecord(outcome.body) || outcome.body.success === false) {
        return this.retainFailure('unavailable', 'unknown');
      }
      const remoteJobId = this.operationIdFromBody(outcome.body);
      if (!remoteJobId) return this.retainFailure('unavailable', 'unknown');
      const jobRef: MemoryAdapterJobRef = {
        backend_binding_epoch: request.space.backend_binding_epoch,
        provider_job_id: remoteJobId,
      };
      return {
        status: 'accepted',
        job_ref: jobRef,
        source_applied: false,
        derived_ready: false,
        reason: null,
      };
    }
    if (outcome.kind === 'http') {
      if (outcome.status === 409) return this.retainFailure('unsupported', 'fenced');
      if (outcome.status === 400 || outcome.status === 422) {
        return this.retainFailure('unsupported', 'invalid_request');
      }
    }
    return this.retainFailure(
      'unavailable',
      transport.reasonFor(outcome, 'unavailable'),
    );
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const transport = this.#transport;
    if (!transport) return this.disabledSearch();
    if (!validSpaceRef(request.space) || !request.plan) {
      return this.searchFailure('unsupported', 'invalid_request');
    }
    const plan = request.plan;
    if (unsupportedSearchFilter(plan)) {
      return {
        ...this.searchFailure('unsupported', 'unsupported'),
        exclusions: [{ reason: 'unsupported_filter', count: 1 }],
      };
    }
    const filters: SearchFilterPlan = {
      originKinds: plan.hard_filters.origin_kinds ?? [],
      sourceIds: plan.hard_filters.source_ids ?? [],
    };
    const bankId = await bankIdFor(transport.config.bankPrefix, request.space);
    const query = plan.query?.trim() ?? '';
    if (query.length > 0) {
      return await searchRecall(
        transport,
        bankId,
        request.space,
        plan,
        filters,
        () => this.now(),
      );
    }
    return await searchList(
      transport,
      bankId,
      request.space,
      plan,
      filters,
      () => this.now(),
    );
  }

  async remove(request: RemoveRequest): Promise<RemoveResult> {
    const transport = this.#transport;
    if (!transport) return this.disabledRemove();
    const prepared = await prepareRemove(request);
    if ('error' in prepared) {
      return {
        status: 'unsupported_granularity',
        purge: 'unsupported_granularity',
        job_ref: null,
        reason: prepared.error,
      };
    }
    const bankId = await bankIdFor(transport.config.bankPrefix, request.space);
    return await removeDocuments(transport, bankId, prepared.tagSets, request.deadline_at);
  }

  async jobStatus(request: JobStatusRequest): Promise<JobStatusResult> {
    const transport = this.#transport;
    if (!transport) return this.disabledJobStatus();
    if (
      !validSpaceRef(request.space) ||
      !isRecord(request.job_ref) ||
      !nonEmptyString(request.job_ref.provider_job_id) ||
      !validEpoch(request.job_ref.backend_binding_epoch)
    ) {
      return this.jobStatusFailure('unsupported');
    }
    if (request.job_ref.backend_binding_epoch !== request.space.backend_binding_epoch) {
      // JobRef 永远绑定原后端；切代次后不能查新 bank。
      return this.jobStatusFailure('unsupported');
    }
    const bankId = await bankIdFor(transport.config.bankPrefix, request.space);
    const outcome = await transport.request(
      'GET',
      `/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(request.job_ref.provider_job_id)}`,
      { deadlineAt: null, retry: true },
    );
    if (outcome.kind === 'ok') {
      if (!isRecord(outcome.body) || !nonEmptyString(outcome.body.status)) {
        return this.jobStatusFailure('unknown');
      }
      switch (outcome.body.status) {
        case 'pending':
          return this.jobState('pending', 'unknown', true, null);
        case 'processing':
          return this.jobState('running', 'unknown', true, null);
        case 'completed':
          // handler 完成；observation/consolidation 就绪仍是独立阶段。
          return this.jobState('completed', 'source_readable', false, null);
        case 'failed':
          return this.jobState('failed', 'unknown', true, null);
        case 'cancelled':
          return this.jobState('cancelled', 'unknown', true, null);
        case 'not_found':
          // 真实 API 对未知 operation 返回 200 + not_found；等价于无法确认。
          return this.jobStatusFailure('unknown');
        default:
          return this.jobStatusFailure('unknown');
      }
    }
    if (outcome.kind === 'http') {
      if (outcome.status === 404) return this.jobStatusFailure('unknown');
      if (outcome.status === 400 || outcome.status === 422) {
        return this.jobStatusFailure('unsupported');
      }
    }
    return this.jobStatusFailure(transport.reasonFor(outcome, 'unknown'));
  }

  private operationIdFromBody(body: Record<string, unknown>): string | null {
    if (nonEmptyString(body.operation_id)) return body.operation_id;
    const ids = body.operation_ids;
    if (Array.isArray(ids) && nonEmptyString(ids[0])) return ids[0];
    return null;
  }

  private now(): number {
    return this.#config?.now() ?? Date.now();
  }

  private retainFailure(
    status: 'unavailable' | 'unsupported',
    reason: MemoryAdapterFailureReason,
  ): RetainResult {
    return {
      status,
      job_ref: null,
      source_applied: false,
      derived_ready: false,
      reason,
    };
  }

  private searchFailure(
    status: 'unavailable' | 'unsupported',
    reason: MemoryAdapterFailureReason,
  ): SearchResult {
    return {
      status,
      coverage: 'unknown',
      freshness: { as_of: this.now(), backend_revision: null },
      evidence_complete: false,
      hits: [],
      exclusions: [],
      reason,
    };
  }

  private jobState(
    state: MemoryAdapterJobState,
    stage: MemoryAdapterProcessorStage,
    retryable: boolean,
    reason: MemoryAdapterFailureReason | null,
  ): JobStatusResult {
    return { state, stage, purge: null, retryable, reason };
  }

  private jobStatusFailure(reason: MemoryAdapterFailureReason): JobStatusResult {
    return this.jobState('unknown', 'unknown', true, reason);
  }

  private disabledEnsureSpace(): EnsureSpaceResult {
    return { status: 'unavailable', backend_ref: null, job_ref: null, reason: 'unavailable' };
  }

  private disabledRetain(): RetainResult {
    return this.retainFailure('unavailable', 'unavailable');
  }

  private disabledSearch(): SearchResult {
    return this.searchFailure('unavailable', 'unavailable');
  }

  private disabledRemove(): RemoveResult {
    return {
      status: 'unavailable',
      purge: 'unknown' satisfies MemoryPurgeState,
      job_ref: null,
      reason: 'unavailable',
    };
  }

  private disabledJobStatus(): JobStatusResult {
    return this.jobStatusFailure('unavailable');
  }
}

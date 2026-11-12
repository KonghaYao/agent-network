/**
 * MF03 运行时占位适配器。
 *
 * 不接真实 Hindsight（MF04 后续）；所有操作明确返回 unsupported/unavailable，
 * 绝不伪报 retain 成功。业务继续积累持久意图，运行时只记录可恢复状态。
 */
import type {
  EnsureSpaceRequest,
  EnsureSpaceResult,
  JobStatusRequest,
  JobStatusResult,
  MemoryAdapter,
  MemoryAdapterCapabilities,
  RemoveRequest,
  RemoveResult,
  RetainRequest,
  RetainResult,
  SearchRequest,
  SearchResult,
} from './types';

export class StubMemoryAdapter implements MemoryAdapter {
  capabilities(): MemoryAdapterCapabilities {
    return {
      provider: 'stub',
      pagination: false,
      hard_filters: [],
      time_window: 'unsupported',
      source_completeness: 'unknown',
      partition_isolation: 'none',
      reflect: false,
      native_export: false,
      immutable_revisions: false,
      remove_granularity: 'space',
      write_fence: 'none',
    };
  }

  async ensureSpace(_request: EnsureSpaceRequest): Promise<EnsureSpaceResult> {
    return { status: 'unsupported', backend_ref: null, job_ref: null, reason: 'unsupported' };
  }

  async retain(_request: RetainRequest): Promise<RetainResult> {
    return {
      status: 'unsupported',
      job_ref: null,
      source_applied: false,
      derived_ready: false,
      reason: 'unsupported',
    };
  }

  async search(_request: SearchRequest): Promise<SearchResult> {
    return {
      status: 'unsupported',
      coverage: 'unknown',
      freshness: { as_of: Date.now(), backend_revision: null },
      evidence_complete: false,
      hits: [],
      exclusions: [],
      reason: 'unsupported',
    };
  }

  async remove(_request: RemoveRequest): Promise<RemoveResult> {
    return {
      status: 'unsupported_granularity',
      purge: 'unknown',
      job_ref: null,
      reason: 'unsupported',
    };
  }

  async jobStatus(_request: JobStatusRequest): Promise<JobStatusResult> {
    return {
      state: 'unknown',
      stage: 'unknown',
      purge: null,
      retryable: false,
      reason: 'unsupported',
    };
  }
}

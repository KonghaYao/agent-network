/**
 * MF03 验收用可控适配器：记录 retain/jobStatus 调用，不连接真实后端。
 */
import type { MemoryAdapter, RetainRequest, RetainResult } from '../../src/memory/adapters/types';

export class RecordingAdapter implements MemoryAdapter {
  retainCalls = 0;
  jobStatusCalls = 0;
  retainResult: RetainResult = {
    status: 'accepted',
    job_ref: null,
    source_applied: true,
    derived_ready: true,
    reason: null,
  };
  remoteState: 'completed' | 'failed' | 'unknown' = 'completed';

  constructor(private readonly asOf = 1_700_000_000_000) {}

  capabilities() {
    return {
      provider: 'recording',
      pagination: true,
      hard_filters: ['origin_kind', 'source_kind', 'source_id', 'room_scope', 'time_range'] as const,
      time_window: 'hard_filter' as const,
      source_completeness: 'exact' as const,
      partition_isolation: 'provider_partition' as const,
      reflect: true,
      native_export: false,
      immutable_revisions: true,
      remove_granularity: 'source_revision' as const,
      write_fence: 'provider_revision' as const,
    };
  }
  async ensureSpace() {
    return { status: 'ready' as const, backend_ref: null, job_ref: null, reason: null };
  }
  async retain(_request: RetainRequest): Promise<RetainResult> {
    this.retainCalls += 1;
    return this.retainResult;
  }
  async search() {
    return {
      status: 'empty' as const,
      coverage: 'bounded' as const,
      freshness: { as_of: this.asOf, backend_revision: null },
      evidence_complete: false,
      hits: [],
      exclusions: [],
      reason: null,
    };
  }
  async remove() {
    return { status: 'accepted' as const, purge: 'purged' as const, job_ref: null, reason: null };
  }
  async jobStatus() {
    this.jobStatusCalls += 1;
    return {
      state: this.remoteState,
      stage: this.remoteState === 'completed' ? ('observation_ready' as const) : ('unknown' as const),
      purge: null,
      retryable: this.remoteState === 'failed',
      reason: null,
    };
  }
}

/**
 * MemoryAdapter 最小能力面（MF01）。
 *
 * 核心操作固定为六项：capabilities / ensureSpace / retain / search / remove /
 * jobStatus。业务权限、空间归属、群消费范围、补读选择和披露策略全部留在
 * MemoryService；Adapter 只接收服务端构造的 space 绑定、准确表示和检索计划。
 *
 * 三个不可下放的约束：
 * - retain 只接受带准确文本与 hash 的表示；Adapter 不得凭 source_id 补抓未
 *   交付全文。
 * - 所有请求携带服务端签发的 space/ownership/backend epoch；provider ID 与
 *   返回 score 都不是授权或真实性证明。
 * - JobRef 永远绑定提交时的后端代次；切换引擎后不能用旧 JobRef 查新库。
 */
import type {
  MemoryAvailability,
  MemoryBackendRef,
  MemoryByteRange,
  MemoryCoverage,
  MemoryExactRepresentation,
  MemoryExposureEvidenceKind,
  MemoryFreshness,
  MemoryOriginKind,
  MemoryProducerKind,
  MemoryPurgeState,
  MemoryRepresentation,
  MemorySha256,
  MemorySourceKind,
  MemorySourceRef,
  MemorySpaceRef,
} from '../contracts';

export type MemoryAdapterOperation =
  | 'capabilities'
  | 'ensureSpace'
  | 'retain'
  | 'search'
  | 'remove'
  | 'jobStatus';

/** 能力目录只描述引擎能做什么，不描述当前用户能否读取。 */
export type MemoryAdapterHardFilter =
  | 'origin_kind'
  | 'source_kind'
  | 'source_id'
  | 'room_scope'
  | 'time_range';

export interface MemoryAdapterCapabilities {
  /** 后端实现名；不向 MCP/UI 暴露路由或密钥。 */
  provider: string;
  pagination: boolean;
  /** 真正可执行的硬过滤；未列出的过滤必须返回 unsupported，不能降级。 */
  hard_filters: readonly MemoryAdapterHardFilter[];
  /** 时间窗口是硬过滤还是仅排序提示；后者不能冒充时间过滤。 */
  time_window: 'hard_filter' | 'ranking_hint_only' | 'unsupported';
  source_completeness: 'exact' | 'partial' | 'unknown';
  partition_isolation: 'provider_partition' | 'unverified' | 'none';
  reflect: boolean;
  native_export: boolean;
  /** 是否支持不可变修订目标；弱后端需依赖分区代次隔离。 */
  immutable_revisions: boolean;
  remove_granularity: 'exact_representation' | 'source_revision' | 'partition' | 'space';
  /** 实际写入 fencing 能力；幂等键不能替代它。 */
  write_fence: 'provider_revision' | 'partition_generation' | 'none';
}

export type MemoryAdapterFailureReason =
  | 'unavailable'
  | 'unsupported'
  | 'timeout'
  | 'invalid_request'
  | 'fenced'
  | 'unknown';

/** 后端作业引用；必须与原 space 的 backend_binding_epoch 一起使用。 */
export interface MemoryAdapterJobRef {
  backend_binding_epoch: number;
  provider_job_id: string;
}

export interface EnsureSpaceRequest {
  space: MemorySpaceRef;
  operation_key: string;
  payload_sha256: MemorySha256;
  deadline_at: number | null;
}

export interface EnsureSpaceResult {
  status: MemoryAvailability;
  backend_ref: MemoryBackendRef | null;
  job_ref: MemoryAdapterJobRef | null;
  reason: MemoryAdapterFailureReason | null;
}

/**
 * retain 资格由服务端裁决后传入；Adapter 不再判断 ownership、room membership
 * 或 disclosure。`representation.text` 必须与 `text_sha256`/`text_bytes` 一致。
 */
export type MemoryAdapterRetainEligibility =
  | {
      kind: 'experienced';
      evidence: MemoryExposureEvidenceKind;
      receipt_id: string;
      proof_id: string;
    }
  | { kind: 'authored'; producer_kind: MemoryProducerKind; experience_id: string }
  | { kind: 'curated'; curated_id: string; revision: number };

export interface MemoryAdapterRetainItem {
  origin_kind: MemoryOriginKind;
  representation: MemoryExactRepresentation;
  /** 仅用于依赖核对与治理；不能据此扩大抓取范围。 */
  source: MemorySourceRef | null;
  eligibility: MemoryAdapterRetainEligibility;
}

export interface RetainRequest {
  space: MemorySpaceRef;
  operation_key: string;
  payload_sha256: MemorySha256;
  items: readonly MemoryAdapterRetainItem[];
  policy_version: number;
  deadline_at: number | null;
}

export interface RetainResult {
  status: 'accepted' | 'pending' | 'unavailable' | 'unsupported';
  job_ref: MemoryAdapterJobRef | null;
  /** 写入处理器已完成；不等于来源可读或观察就绪。 */
  source_applied: boolean;
  /** 派生 observation/consolidation 已就绪；必须独立于写入完成。 */
  derived_ready: boolean;
  reason: MemoryAdapterFailureReason | null;
}

export interface MemoryAdapterHardFilters {
  origin_kinds?: readonly MemoryOriginKind[];
  source_kinds?: readonly MemorySourceKind[];
  source_ids?: readonly string[];
  room_ids?: readonly string[];
  time_field?: 'created_at' | 'submitted_at';
  time_from?: number;
  time_to?: number;
  timezone?: string;
}

/** 服务端构造的检索计划；Adapter 不得自行扩大候选、来源或披露范围。 */
export interface MemoryAdapterSearchPlan {
  query: string | null;
  hard_filters: MemoryAdapterHardFilters;
  ranking_hints: {
    recency_bias?: number;
    relevance_bias?: number;
  };
  candidate_limit: number;
  output_bytes: number;
  deadline_at: number | null;
  policy_version: number;
}

export interface SearchRequest {
  space: MemorySpaceRef;
  plan: MemoryAdapterSearchPlan;
}

export interface MemoryAdapterSearchHit {
  /** 后端对象定位；不是授权凭据，也不能跨 space/epoch 复用。 */
  backend_ref: MemoryBackendRef;
  representation: MemoryRepresentation;
  source: MemorySourceRef | null;
  origin_kind: MemoryOriginKind;
  evidence: MemoryExposureEvidenceKind | null;
  /** 后端 score 只用于排序，不代表真实性、可信度或已核验。 */
  score: number | null;
}

export type MemoryAdapterSearchExclusionReason =
  | 'hard_filter'
  | 'budget'
  | 'unsupported_filter'
  | 'permission_partition'
  | 'source_incomplete';

export interface MemoryAdapterSearchExclusion {
  reason: MemoryAdapterSearchExclusionReason;
  count: number;
}

export interface SearchResult {
  status: 'ready' | 'empty' | 'pending' | 'unavailable' | 'unsupported';
  coverage: MemoryCoverage;
  freshness: MemoryFreshness;
  evidence_complete: boolean;
  hits: readonly MemoryAdapterSearchHit[];
  exclusions: readonly MemoryAdapterSearchExclusion[];
  reason: MemoryAdapterFailureReason | null;
}

/** 精确删除目标；无法解析到可重放目标时返回 unsupported_granularity。 */
export type MemoryAdapterRemoveTarget =
  | {
      kind: 'representation';
      source: MemorySourceRef;
      representation_id: string;
      range: MemoryByteRange | null;
    }
  | { kind: 'source_revision'; source: MemorySourceRef }
  | { kind: 'curated'; curated_id: string; revision: number }
  | { kind: 'partition'; partition_id: string; generation: number };

export interface RemoveRequest {
  space: MemorySpaceRef;
  operation_key: string;
  payload_sha256: MemorySha256;
  targets: readonly MemoryAdapterRemoveTarget[];
  policy_version: number;
  deadline_at: number | null;
}

export interface RemoveResult {
  status: 'accepted' | 'unavailable' | 'unsupported_granularity';
  /** 无法确认全部声明副本清除时保持 purge_pending/unknown。 */
  purge: MemoryPurgeState;
  job_ref: MemoryAdapterJobRef | null;
  reason: MemoryAdapterFailureReason | null;
}

export interface JobStatusRequest {
  space: MemorySpaceRef;
  /** 必须来自原 retain/remove/ensureSpace 结果，不能跨后端代次改写。 */
  job_ref: MemoryAdapterJobRef;
}

export type MemoryAdapterJobState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';

/** 写入处理器完成、源可读、观察就绪是三个不同阶段。 */
export type MemoryAdapterProcessorStage =
  | 'write_handler_completed'
  | 'source_readable'
  | 'observation_ready'
  | 'unknown';

export interface JobStatusResult {
  state: MemoryAdapterJobState;
  stage: MemoryAdapterProcessorStage;
  purge: MemoryPurgeState | null;
  retryable: boolean;
  reason: MemoryAdapterFailureReason | null;
}

/**
 * 核心六操作。inspect/native reflect/native export 属于可选扩展，不进入本
 * interface；依赖它们的业务必须显式检查 capabilities，不能假设可用。
 */
export interface MemoryAdapter {
  capabilities(): MemoryAdapterCapabilities;
  ensureSpace(request: EnsureSpaceRequest): Promise<EnsureSpaceResult>;
  retain(request: RetainRequest): Promise<RetainResult>;
  search(request: SearchRequest): Promise<SearchResult>;
  remove(request: RemoveRequest): Promise<RemoveResult>;
  jobStatus(request: JobStatusRequest): Promise<JobStatusResult>;
}

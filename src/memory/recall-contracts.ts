/**
 * Memory 召回、Context、宿主等级与治理契约（MF01）。
 *
 * 这里冻结 lookup 与 auto 的差异：lookup 结果永不携带注入许可；auto 必须
 * 绑定准确宿主 run/输入，且只允许 related/task。宿主等级由服务端签发，
 * 客户端声明只能协商能力，不能自报 verified/trusted。
 */
import {
  MEMORY_PAYLOAD_AUTHORITY,
  type MemoryAvailability,
  type MemoryByteRange,
  type MemoryContextId,
  type MemoryCoverage,
  type MemoryCuratedId,
  type MemoryErrorCode,
  type MemoryExperienceId,
  type MemoryHostBindingId,
  type MemoryOperationId,
  type MemoryOperationStage,
  type MemoryOriginKind,
  type MemoryPurgeState,
  type MemoryRecallBudget,
  type MemoryRecallId,
  type MemoryRecallStatus,
  type MemoryRepresentation,
  type MemoryRepresentationId,
  type MemorySha256,
  type MemorySourceId,
  type MemorySourceKind,
  type MemorySourceRef,
  type MemorySpaceRef,
  type MemoryTargetScope,
  type MemoryUtf8Bytes,
} from './contracts-core';
import { evidenceRank, type MemoryContextTarget, type MemoryExposureEvidenceKind, type MemoryMessageRef, type MemoryMinimumEvidence, type MemoryTaskRef } from './experience-contracts';

// ---------------------------------------------------------------------------
// 召回请求与结果
// ---------------------------------------------------------------------------

export const MEMORY_RECALL_MODES = ['bootstrap', 'related', 'task', 'lookup', 'reflect'] as const;

export type MemoryRecallMode = (typeof MEMORY_RECALL_MODES)[number];

/**
 * 召回目标只定位当前消息/任务候选，不代表已领取或已绑定输入。
 *
 * 服务端可在业务提交后按最终 recipient 预热；claim 后才用 MemoryContextTarget
 * 绑定真实 run/input。host 字段在自动派发时由服务端补齐，预热可为 null。
 */
export type MemoryRecallTarget =
  | {
      kind: 'message';
      space: MemorySpaceRef;
      target_scope: MemoryTargetScope;
      host_binding_id: MemoryHostBindingId | null;
      host_generation: number | null;
      session_incarnation: string | null;
      message: MemoryMessageRef;
      delivery_id: string | null;
      attempt: number | null;
    }
  | {
      kind: 'task';
      space: MemorySpaceRef;
      target_scope: MemoryTargetScope;
      host_binding_id: MemoryHostBindingId | null;
      host_generation: number | null;
      session_incarnation: string | null;
      task: MemoryTaskRef;
    };

export type MemoryRecallIntent =
  | { mode: 'bootstrap'; host_binding_id: MemoryHostBindingId; host_generation: number; session_incarnation: string }
  | { mode: 'related'; message: MemoryMessageRef; query?: string }
  | { mode: 'task'; task: MemoryTaskRef; query?: string }
  | { mode: 'lookup'; query: string }
  | { mode: 'reflect'; query: string };

/**
 * 自动派发只允许 related/task，并且必须带准确 target。
 *
 * lookup 是显式查询，不能借 auto 获得注入资格；bootstrap/reflect 也一样。
 */
export type MemoryAutoRecallIntent = Extract<MemoryRecallIntent, { mode: 'related' | 'task' }>;

export type MemoryAutoRecallDispatch =
  | {
      kind: 'auto';
      intent: Extract<MemoryRecallIntent, { mode: 'related' }>;
      target: Extract<MemoryRecallTarget, { kind: 'message' }>;
    }
  | {
      kind: 'auto';
      intent: Extract<MemoryRecallIntent, { mode: 'task' }>;
      target: Extract<MemoryRecallTarget, { kind: 'task' }>;
    };

export type MemoryRecallDispatch =
  | { kind: 'explicit'; intent: MemoryRecallIntent }
  | MemoryAutoRecallDispatch;

export type MemoryTimeField = 'created_at' | 'submitted_at';

/**
 * 硬过滤必须由引擎真正执行；不支持的硬过滤返回 unsupported，不能降级成
 * ranking hint。时间排序提示不等于时间窗口过滤。
 */
export interface MemoryRecallHardFilters {
  origin_kinds?: readonly MemoryOriginKind[];
  minimum_evidence?: MemoryMinimumEvidence;
  origin_room_ids?: readonly string[];
  source_kinds?: readonly MemorySourceKind[];
  time_field?: MemoryTimeField;
  time_from?: number;
  time_to?: number;
  timezone?: string;
}

/** 排序偏好；后端 score 不是真实性或可信度。 */
export interface MemoryRankingHints {
  recency_bias?: number;
  relevance_bias?: number;
  preferred_source_kinds?: readonly MemorySourceKind[];
}

export interface MemoryRecallRequest {
  recall_id: MemoryRecallId;
  space: MemorySpaceRef;
  agent_actor_id: string;
  dispatch: MemoryRecallDispatch;
  hard_filters: MemoryRecallHardFilters;
  ranking_hints: MemoryRankingHints;
  budget: MemoryRecallBudget;
  policy_version: number;
  status: MemoryRecallStatus;
  created_at: number;
  updated_at: number;
}

export type MemoryExclusionReason =
  | 'permission'
  | 'source_not_active'
  | 'forgotten'
  | 'evidence_below_minimum'
  | 'budget'
  | 'unsupported_hard_filter'
  | 'target_scope';

export interface MemoryRecallExclusion {
  reason: MemoryExclusionReason;
  source_id: MemorySourceId | null;
  detail: string | null;
}

export interface MemoryRecallItem {
  origin_kind: MemoryOriginKind;
  representation: MemoryRepresentation;
  evidence: MemoryExposureEvidenceKind | null;
  source: MemorySourceRef | null;
  score: number | null;
  trust: typeof MEMORY_PAYLOAD_AUTHORITY;
}

export interface MemoryFreshness {
  as_of: number;
  backend_revision: string | null;
}

export interface MemoryRecallBudgetUsage {
  candidates: number;
  packaged_bytes: number;
  truncated: boolean;
}

export interface MemoryRecallResult {
  recall_id: MemoryRecallId;
  status: MemoryRecallStatus;
  coverage: MemoryCoverage;
  freshness: MemoryFreshness;
  evidence_complete: boolean;
  items: readonly MemoryRecallItem[];
  context: MemoryLookupContext | null;
  exclusions: readonly MemoryRecallExclusion[];
  budget_used: MemoryRecallBudgetUsage;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export type MemoryContextKind = 'lookup' | 'bound';

/** Context 的当前有效性；与历史 receipt 分开保存。 */
export type MemoryContextValidity = 'active' | 'expired' | 'revoked' | 'superseded' | 'excluded';

export type MemoryContextEvidenceKind =
  | MemoryExposureEvidenceKind
  | 'authored_record'
  | 'curated_record';

export interface MemoryContextEvidenceItem {
  origin_kind: MemoryOriginKind;
  evidence: MemoryContextEvidenceKind;
  source: MemorySourceRef | null;
  representation_id: MemoryRepresentationId;
}

export interface MemoryContextEvidence {
  coverage: MemoryCoverage;
  evidence_complete: boolean;
  minimum_evidence: MemoryMinimumEvidence | null;
  items: readonly MemoryContextEvidenceItem[];
}

/** Context 正文不可变；版本/hash 变化视为新包，不静默原地改写。 */
export interface MemoryContextBody {
  version: number;
  sha256: MemorySha256;
  bytes: MemoryUtf8Bytes;
  authority: typeof MEMORY_PAYLOAD_AUTHORITY;
}

interface MemoryContextBase {
  context_id: MemoryContextId;
  space: MemorySpaceRef;
  agent_actor_id: string;
  body: MemoryContextBody;
  evidence: MemoryContextEvidence;
  validity: MemoryContextValidity;
  created_at: number;
  expires_at: number;
}

export interface MemoryInjectionState {
  eligible: boolean;
  admit_required: true;
  reason: 'active' | 'expired' | 'revoked' | 'superseded' | 'excluded';
}

/** lookup 结果可返回给授权调用者，但不携带注入许可。 */
export interface MemoryLookupContext extends MemoryContextBase {
  kind: 'lookup';
  target: null;
  target_scope: MemoryTargetScope;
  injection: { eligible: false; admit_required: true; reason: 'lookup_only' };
}

/** 只有绑定合格目标且当前有效的包才能走消费授权。 */
export interface MemoryBoundContext extends MemoryContextBase {
  kind: 'bound';
  target: MemoryContextTarget;
  target_scope: MemoryTargetScope;
  injection: MemoryInjectionState;
}

export type MemoryContext = MemoryLookupContext | MemoryBoundContext;

export function isInjectionEligible(
  context: MemoryContext,
): context is MemoryBoundContext & {
  injection: { eligible: true; admit_required: true; reason: 'active' };
} {
  return context.kind === 'bound' && context.validity === 'active' && context.injection.eligible;
}

// ---------------------------------------------------------------------------
// 宿主等级
// ---------------------------------------------------------------------------

export const MEMORY_HOST_LEVELS = ['tool_only', 'adapted_host', 'controlled_gateway'] as const;

export type MemoryHostIntegrationLevel = (typeof MEMORY_HOST_LEVELS)[number];

export const MEMORY_HOST_CAPABILITIES = [
  'explicit_lookup',
  'run_binding',
  'async_supplement',
  'final_manifest_report',
  'submission_evidence',
  'gateway_observation',
  'history_isolation',
] as const;

export type MemoryHostCapability = (typeof MEMORY_HOST_CAPABILITIES)[number];

/**
 * 等级由服务端按注册/部署配置签发；`declared_capabilities` 只是申请，
 * 永远不能提高等级。tool-only 只能显式查询，不能宣称自动注入完成。
 */
export const MEMORY_HOST_LEVEL_CAPABILITIES: Readonly<
  Record<MemoryHostIntegrationLevel, readonly MemoryHostCapability[]>
> = {
  tool_only: ['explicit_lookup'],
  adapted_host: [
    'explicit_lookup',
    'run_binding',
    'async_supplement',
    'final_manifest_report',
    'submission_evidence',
    'history_isolation',
  ],
  controlled_gateway: [
    'explicit_lookup',
    'run_binding',
    'async_supplement',
    'final_manifest_report',
    'submission_evidence',
    'gateway_observation',
    'history_isolation',
  ],
};

export interface MemoryHostBinding {
  binding_id: MemoryHostBindingId;
  /** 服务端签发的连接代次；旧代次/旧会话不能继续接收自动上下文。 */
  generation: number;
  credential_id: string;
  agent_actor_id: string;
  space: MemorySpaceRef;
  level: MemoryHostIntegrationLevel;
  /** 客户端声明只用于能力协商；不得作为信任或证据依据。 */
  declared_capabilities: readonly MemoryHostCapability[];
  session_incarnation: string | null;
  lease_expires_at: number;
  created_at: number;
  closed_at: number | null;
}

export interface MemoryHostBindRequest {
  session_incarnation?: string;
  declared_capabilities: readonly MemoryHostCapability[];
  lease_ms?: number;
}

export function hostCapabilities(
  level: MemoryHostIntegrationLevel,
): readonly MemoryHostCapability[] {
  return MEMORY_HOST_LEVEL_CAPABILITIES[level];
}

export function hostSupports(
  level: MemoryHostIntegrationLevel,
  capability: MemoryHostCapability,
): boolean {
  return MEMORY_HOST_LEVEL_CAPABILITIES[level].includes(capability);
}

/** 该等级最多能自报的提交证据；tool-only 没有提交证据。 */
export function maxReportableEvidence(
  level: MemoryHostIntegrationLevel,
): MemoryExposureEvidenceKind | null {
  if (level === 'tool_only') return null;
  return level === 'adapted_host' ? 'host_reported_submitted' : 'gateway_observed_submitted';
}

/** 宿主只能报告其等级允许的证据；伪造 trusted/verified 字段不会提升等级。 */
export function hostMayReportEvidence(
  level: MemoryHostIntegrationLevel,
  evidence: MemoryExposureEvidenceKind,
): boolean {
  const max = maxReportableEvidence(level);
  return max !== null && evidenceRank(evidence) <= evidenceRank(max);
}

// ---------------------------------------------------------------------------
// 治理
// ---------------------------------------------------------------------------

export type MemoryGovernanceAction = 'put' | 'correct' | 'forget';

/** 遗忘必须解析到可重放的来源/片段目标，否则 unsupported_granularity。 */
export type MemoryForgetTarget =
  | { kind: 'source'; source: MemorySourceRef }
  | {
      kind: 'representation';
      source: MemorySourceRef;
      representation_id: MemoryRepresentationId;
      range: MemoryByteRange | null;
    }
  | { kind: 'curated'; curated_id: MemoryCuratedId; revision: number }
  | { kind: 'experience'; experience_id: MemoryExperienceId };

export interface MemoryOperationStatus {
  operation_id: MemoryOperationId;
  action: MemoryGovernanceAction | 'ensure_space' | 'retain' | 'recall' | 'remove';
  stage: MemoryOperationStage;
  availability: MemoryAvailability;
  purge: MemoryPurgeState | null;
  retryable: boolean;
  error: MemoryErrorCode | null;
}

export interface MemoryGovernanceResult {
  request_id: string;
  operation_id: MemoryOperationId | null;
  status: MemoryAvailability;
  purge: MemoryPurgeState | null;
}


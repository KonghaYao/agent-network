/**
 * Memory 经历、输入清单与提交证据契约（MF01）。
 *
 * 本模块冻结“准确消费才接纳”的核心语义：SourceSelection/PreparedInput 只是
 * 可供输入；最终 SubmittedInputManifest 与分级 ExposureReceipt 才产生经历和
 * retain 资格。派发、claim、预热永远不在此列。
 */
import type {
  MemoryAccessVersions,
  MemoryByteRange,
  MemoryCaptureState,
  MemoryContextId,
  MemoryCuratedId,
  MemoryExperienceId,
  MemoryHostBindingId,
  MemoryManifestId,
  MemoryOriginKind,
  MemoryOriginScope,
  MemoryOwnershipEpoch,
  MemoryProducerKind,
  MemoryProofId,
  MemoryRecallBudget,
  MemoryRecallId,
  MemoryReceiptId,
  MemoryRepresentation,
  MemoryRepresentationId,
  MemoryRepresentationKind,
  MemorySelectionId,
  MemorySha256,
  MemorySourceId,
  MemorySourceState,
  MemorySpaceId,
  MemorySpaceRef,
  MemoryTargetScope,
} from './contracts-core';

// ---------------------------------------------------------------------------
// 经历、来源类别与提交证据
// ---------------------------------------------------------------------------

/** 输入经历的稀疏身份键；不同修订、表示、片段位置和证据等级不能误并。 */
export interface MemoryExperienceKey {
  space_id: MemorySpaceId;
  ownership_epoch: MemoryOwnershipEpoch;
  agent_actor_id: string;
  origin_room_id: string;
  origin_member_generation: number;
  source_id: MemorySourceId | null;
  source_revision: number | null;
  representation_id: MemoryRepresentationId;
  representation_kind: MemoryRepresentationKind;
  range: MemoryByteRange | null;
  text_sha256: MemorySha256;
}

export type MemoryExperienceEvidence =
  | { kind: 'input_exposure'; evidence: MemoryExposureEvidenceKind; proof_id: MemoryProofId }
  | { kind: 'authored'; producer_kind: MemoryProducerKind }
  | { kind: 'curated'; curated_id: MemoryCuratedId; revision: number };

/**
 * 已接纳的个人经历。
 *
 * 它只记录该 Agent 实际获得的准确表示；历史覆盖、当前 Context 与长期
 * 可召回性分别判断，不能互相推断。
 */
export interface MemoryExperienceEntry {
  experience_id: MemoryExperienceId;
  key: MemoryExperienceKey;
  space: MemorySpaceRef;
  origin_scope: MemoryOriginScope;
  origin_kind: MemoryOriginKind;
  producer_kind: MemoryProducerKind | null;
  representation: MemoryRepresentation;
  evidence: MemoryExperienceEvidence;
  /** experienced 必须有输入回执；authored/curated 不伪造 input_exposure。 */
  receipt_id: MemoryReceiptId | null;
  capture: MemoryCaptureState;
  available: boolean;
  created_at: number;
}

export const MEMORY_EXPOSURE_EVIDENCE_KINDS = [
  'host_reported_submitted',
  'gateway_observed_submitted',
] as const;

/** 只有这两类证据能接纳 experienced 输入；其他状态只是过程事实。 */
export type MemoryExposureEvidenceKind = (typeof MEMORY_EXPOSURE_EVIDENCE_KINDS)[number];

/**
 * 记忆包交付证据与源输入提交证据分开：交付只证明宿主拿到包，
 * 不能推出原群消息已被消费。
 */
export const MEMORY_CONTEXT_DELIVERY_EVIDENCE_KINDS = [
  'served',
  'host_reported_delivered',
  'gateway_observed_delivered',
] as const;

export type MemoryContextDeliveryEvidenceKind =
  (typeof MEMORY_CONTEXT_DELIVERY_EVIDENCE_KINDS)[number];

export type MemoryMinimumEvidence = MemoryExposureEvidenceKind;

/**
 * 提交状态。prepared/served/unknown 都不是提交证据：
 * - prepared/served：已准备或已返回给客户端；
 * - unknown：崩溃/超时后无法确认最终内容是否提交；
 * - 其余两项才可能满足 minimum_evidence。
 */
export type MemorySubmissionState =
  | 'prepared'
  | 'served'
  | 'unknown'
  | MemoryExposureEvidenceKind;

const EVIDENCE_RANK: Readonly<Record<MemorySubmissionState, number>> = {
  prepared: 0,
  served: 0,
  unknown: 0,
  host_reported_submitted: 1,
  gateway_observed_submitted: 2,
};

export function isSubmittedEvidence(
  state: MemorySubmissionState,
): state is MemoryExposureEvidenceKind {
  return (MEMORY_EXPOSURE_EVIDENCE_KINDS as readonly string[]).includes(state);
}

/** 供宿主等级判定使用；0 表示不是提交证据。 */
export function evidenceRank(state: MemorySubmissionState): number {
  return EVIDENCE_RANK[state];
}

/** 证据等级只升不降；未知/已准备永远不满足提交要求。 */
export function meetsMinimumEvidence(
  actual: MemorySubmissionState,
  minimum: MemoryMinimumEvidence,
): boolean {
  if (!isSubmittedEvidence(actual)) return false;
  return EVIDENCE_RANK[actual] >= EVIDENCE_RANK[minimum];
}

/** 同一 invocation 只能绑定一个 manifest hash；proof 可独立追加。 */
export interface MemoryInvocationIdentity {
  host_binding_id: MemoryHostBindingId;
  host_generation: number;
  session_incarnation: string;
  run_id: string;
  input_id: string;
  input_revision: number;
  invocation_id: string;
}

export interface MemoryMessageRef {
  room_id: string;
  message_id: string;
  created_seq: number;
}

export interface MemoryTaskRef {
  task_id: string;
  assignment_id: string;
  assignment_version: number | null;
}

export interface MemoryMessageDeliveryRef {
  message_id: string;
  delivery_id: string;
  attempt: number;
  claim_id: string;
}

export interface MemoryTaskAssignmentRef {
  task_id: string;
  assignment_id: string;
  assignment_version: number;
}

interface MemoryContextTargetBase {
  agent_actor_id: string;
  space: MemorySpaceRef;
  host_binding_id: MemoryHostBindingId;
  host_generation: number;
  session_incarnation: string;
  run_id: string;
  input_id: string;
  input_revision: number;
  target_scope: MemoryTargetScope;
  versions: MemoryAccessVersions;
}

/** 自动注入目标必须准确绑定宿主 run 与输入；消息/任务各自追加业务定位。 */
export type MemoryContextTarget =
  | (MemoryContextTargetBase & { kind: 'message'; message: MemoryMessageDeliveryRef })
  | (MemoryContextTargetBase & { kind: 'task'; task: MemoryTaskAssignmentRef });

/**
 * 可供输入的来源选择。
 *
 * `consumption: 'not_consumed'` 是类型级事实：选择本身不是消费证明，
 * 只有最终 manifest + receipt 才能产生经历。
 */
export interface MemorySourceSelection {
  selection_id: MemorySelectionId;
  representation: MemoryRepresentation;
  origin_scope: MemoryOriginScope;
  target_scope: MemoryTargetScope;
  versions: MemoryAccessVersions;
  issued_at: number;
  expires_at: number | null;
  consumption: 'not_consumed';
}

/** 宿主准备包；允许被裁剪/替换，不能据此写经历。 */
export interface MemoryPreparedInput {
  prepared_input_id: string;
  target: MemoryContextTarget;
  selections: readonly MemorySourceSelection[];
  snapshot_upper_bound: number;
  budget: MemoryRecallBudget;
  created_at: number;
  expires_at: number | null;
  retain_eligible: false;
}

/** 派发/唤醒只产生预热资格，不产生个人 retain。 */
export interface MemoryDispatchWarmup {
  agent_actor_id: string;
  message_id: string | null;
  task_id: string | null;
  recall_id: MemoryRecallId | null;
  warmup_only: true;
  retain_eligible: false;
  created_at: number;
}

export interface MemoryManifestItem {
  selection_id: MemorySelectionId | null;
  representation: MemoryRepresentation;
  origin_scope: MemoryOriginScope;
}

/**
 * 宿主最终裁剪、压缩、模板拼装后的不可变输入清单。
 *
 * prepared 清单、原始模板和被截断的工具输出都不能冒充它；被删除的段落
 * 不登记为输入。服务端用 selection 来源与实际提交表示核对。
 */
export interface MemorySubmittedInputManifest {
  manifest_id: MemoryManifestId;
  manifest_sha256: MemorySha256;
  payload_sha256: MemorySha256;
  invocation: MemoryInvocationIdentity;
  target: MemoryContextTarget;
  items: readonly MemoryManifestItem[];
  created_at: number;
}

/**
 * 输入提交回执。
 *
 * evidence 由服务端按 HostBinding 等级派生，客户端不能自报；proof_id 是
 * 幂等/追加证明键，不是“已验证”布尔值。
 */
export interface MemoryExposureReceipt {
  receipt_id: MemoryReceiptId;
  kind: 'input_exposure';
  manifest_id: MemoryManifestId;
  manifest_sha256: MemorySha256;
  payload_sha256: MemorySha256;
  invocation: MemoryInvocationIdentity;
  space: MemorySpaceRef;
  agent_actor_id: string;
  origin_scopes: readonly MemoryOriginScope[];
  target_scope: MemoryTargetScope;
  evidence: MemoryExposureEvidenceKind;
  proof_id: MemoryProofId;
  submitted_at: number;
  idempotency_key: string;
}

/** 记忆包交付回执；只证明交付，不证明原群消息已被消费。 */
export interface MemoryContextDeliveryReceipt {
  receipt_id: MemoryReceiptId;
  kind: 'context_delivery';
  context_id: MemoryContextId;
  context_sha256: MemorySha256;
  invocation: MemoryInvocationIdentity;
  space: MemorySpaceRef;
  agent_actor_id: string;
  evidence: MemoryContextDeliveryEvidenceKind;
  proof_id: MemoryProofId;
  delivered_at: number;
  idempotency_key: string;
}

export type MemoryReceipt = MemoryExposureReceipt | MemoryContextDeliveryReceipt;

/** 迟到/冲突回执只补最小历史，不能复活正文或产生新 owner 经历。 */
export interface MemoryReceiptDisposition {
  receipt_id: MemoryReceiptId;
  disposition: 'applied' | 'history_only' | 'rejected';
  reason:
    | 'duplicate'
    | 'conflict'
    | 'context_expired'
    | 'ownership_changed'
    | 'source_excluded'
    | 'permission_revoked'
    | 'agent_disabled'
    | null;
}

/**
 * 经历接纳裁决。
 *
 * experienced 必须有达到 minimum_evidence 的提交证据；authored 必须有
 * producer_kind；curated 使用独立的人工保存策略。任何一类都不接受裸
 * through_seq、UI 已读、claim 或 API 返回。
 */
export type MemoryAdmissionReason =
  | 'agent_disabled'
  | 'ownership_changed'
  | 'source_not_active'
  | 'not_submitted'
  | 'submission_unknown'
  | 'evidence_below_minimum'
  | 'producer_kind_required'
  | 'submitted_evidence'
  | 'authored_record'
  | 'curated_record';

export interface MemoryExperienceAdmission {
  admitted: boolean;
  retain_allowed: boolean;
  evidence: MemoryExposureEvidenceKind | null;
  reason: MemoryAdmissionReason;
}

export interface MemoryExperienceAdmissionInput {
  origin_kind: MemoryOriginKind;
  submission_state: MemorySubmissionState;
  minimum_evidence: MemoryMinimumEvidence;
  source_state?: MemorySourceState;
  ownership_current: boolean;
  agent_enabled: boolean;
  producer_kind?: MemoryProducerKind | null;
}

const DENIED = {
  admitted: false,
  retain_allowed: false,
  evidence: null,
} as const;

export function decideExperienceAdmission(
  input: MemoryExperienceAdmissionInput,
): MemoryExperienceAdmission {
  if (!input.agent_enabled) return { ...DENIED, reason: 'agent_disabled' };
  if (!input.ownership_current) return { ...DENIED, reason: 'ownership_changed' };
  if (input.origin_kind !== 'curated' && input.source_state !== 'active') {
    return { ...DENIED, reason: 'source_not_active' };
  }

  if (input.origin_kind === 'experienced') {
    if (input.submission_state === 'prepared' || input.submission_state === 'served') {
      return { ...DENIED, reason: 'not_submitted' };
    }
    if (input.submission_state === 'unknown') {
      return { ...DENIED, reason: 'submission_unknown' };
    }
    if (!meetsMinimumEvidence(input.submission_state, input.minimum_evidence)) {
      return { ...DENIED, reason: 'evidence_below_minimum' };
    }
    return {
      admitted: true,
      retain_allowed: true,
      evidence: input.submission_state,
      reason: 'submitted_evidence',
    };
  }

  if (input.origin_kind === 'authored') {
    if (!input.producer_kind) return { ...DENIED, reason: 'producer_kind_required' };
    return {
      admitted: true,
      retain_allowed: true,
      evidence: null,
      reason: 'authored_record',
    };
  }

  return {
    admitted: true,
    retain_allowed: true,
    evidence: null,
    reason: 'curated_record',
  };
}

/** reachability: retain 只接受已接纳的准确表示及对应资格。 */
export interface MemoryRetainIntent {
  intent_id: string;
  space: MemorySpaceRef;
  agent_actor_id: string;
  origin_kind: MemoryOriginKind;
  /** experienced 绑定输入回执；authored/curated 为 null。 */
  receipt_id: MemoryReceiptId | null;
  proof_id: MemoryProofId;
  experiences: readonly MemoryExperienceKey[];
  created_at: number;
}


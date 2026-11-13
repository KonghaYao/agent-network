/**
 * WeBots v3 Memory 公共契约（MF01）：核心身份、来源与证据策略。
 *
 * 本模块只冻结跨层对象、状态与判定，不包含存储、工具或运行时。对外入口为
 * `contracts.ts`；本文件按仓库 1000 行模块上限拆出核心部分。
 * 设计依据：`.peri/plans/v3-memory/MEMORY-CONTRACT.md` 与 `CONSUMPTION.md`。
 *
 * 三条不可交换的边界：
 * 1. 派发、claim、预热、查询返回只产生可用输入（RecallRequest/PreparedInput），
 *    绝不直接授予个人 retain 资格。
 * 2. 只有合格的 SubmittedInputManifest + ExposureReceipt 才能在同一事务里
 *    接纳准确经历与获准的 retain 意图；receipt 不等于模型已经理解或采用。
 * 3. 每个 Agent 的经历按 space/ownership/agent/origin room/member generation
 *    独立；公共消息只保留共同业务身份，不因一个 Agent 的消费而成为另一个
 *    Agent 的经历。
 */
import type { BusinessErrorCode } from '../contracts/errors';

/** Memory 领域契约版本；协议版本仍由 client-contract 维护。 */
export const MEMORY_CONTRACT_VERSION = '2026-11-09.1';

/** 召回与证据策略版本；策略收紧后旧结果必须按新版本重新过滤。 */
export const MEMORY_POLICY_VERSION = 1;

/** 记忆包是参考数据，不是系统指令、工具授权或已核验事实。 */
export const MEMORY_PAYLOAD_AUTHORITY = 'reference_data' as const;

// ---------------------------------------------------------------------------
// 稳定标识与代次
// ---------------------------------------------------------------------------

/** 所有 Memory 标识都是服务端签发的不可猜测字符串，不使用名称或 token 充当主键。 */
export type MemorySpaceId = string;
export type MemorySourceId = string;
export type MemoryRepresentationId = string;
export type MemorySelectionId = string;
export type MemoryManifestId = string;
export type MemoryRecallId = string;
export type MemoryContextId = string;
export type MemoryExperienceId = string;
export type MemoryReceiptId = string;
export type MemoryProofId = string;
export type MemoryHostBindingId = string;
export type MemoryOperationId = string;
export type MemoryCuratedId = string;

/**
 * 归属代次：只在认领、管理转让等记忆归属变化时递增。
 *
 * `agent_managements.binding_id` 可能在转让时原地保留；判断归属必须用
 * ownership_epoch，不能只看 binding_id 是否变化。
 */
export type MemoryOwnershipEpoch = number;

/** 后端绑定代次：切换引擎、重建隔离分区或迁移投影时递增。 */
export type MemoryBackendEpoch = number;

/** SHA-256 小写十六进制摘要。 */
export type MemorySha256 = string;

/** UTF-8 字节数。 */
export type MemoryUtf8Bytes = number;

// ---------------------------------------------------------------------------
// 状态与错误
// ---------------------------------------------------------------------------

/**
 * 能力/数据面状态。`disabled` 是部署关闭 Memory，`unsupported` 是宿主或
 * 引擎明确不支持该能力；两者都不能伪报为 ready 或空结果。
 */
export type MemoryAvailability = 'ready' | 'pending' | 'unavailable' | 'unsupported' | 'disabled';

/**
 * 召回请求状态。`empty` 仅表示本次有界查询没有合格候选，不表示库内不存在；
 * `skipped_no_boundary` 表示迟到补充未赶上原运行边界，不产生新投递或模型调用。
 */
export type MemoryRecallStatus =
  | 'pending'
  | 'ready'
  | 'empty'
  | 'unavailable'
  | 'unsupported'
  | 'disabled'
  | 'skipped_no_boundary';

/** 结果覆盖范围；`bounded` 不能升级为 `exhaustive`。 */
export type MemoryCoverage = 'bounded' | 'exhaustive' | 'unknown';

/** 遗忘/清除状态；无法确认全部声明副本时不显示 purged。 */
export type MemoryPurgeState = 'purged' | 'purge_pending' | 'unknown' | 'unsupported_granularity';

/** 后端作业阶段；来源生效与派生就绪必须分开。 */
export type MemoryOperationStage = 'accepted' | 'source_applied' | 'derived_ready' | 'unknown';

/**
 * Memory 新增业务错误码。
 *
 * 列表本身是权威枚举，并通过 `satisfies BusinessErrorCode` 与集中错误表对齐。
 * pending/unavailable/unsupported 等正常状态使用 MemoryAvailability，不抛异常。
 */
export const MEMORY_ERROR_CODES = [
  'MEMORY_DISABLED',
  'MEMORY_UNAVAILABLE',
  'MEMORY_NOT_READY',
  'MEMORY_UNSUPPORTED',
  'MEMORY_UNSUPPORTED_GRANULARITY',
  'MEMORY_TARGET_INVALID',
  'MEMORY_EVIDENCE_INSUFFICIENT',
] as const satisfies readonly BusinessErrorCode[];

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

// ---------------------------------------------------------------------------
// 空间与归属
// ---------------------------------------------------------------------------

/** managed：由当前管理者拥有；self_owned：未认领 Agent 使用自身所有者空间。 */
export type MemoryOwnershipKind = 'managed' | 'self_owned';

/** 提炼/采集状态；与“当前会话是否仍持有正文”是独立事实。 */
export type MemoryCaptureState = 'none' | 'pending' | 'extracted' | 'excluded';

/** 服务端签发的空间绑定；所有读取、写入与作业都携带它，客户端不能自报。 */
export interface MemorySpaceRef {
  space_id: MemorySpaceId;
  ownership_epoch: MemoryOwnershipEpoch;
  backend_binding_epoch: MemoryBackendEpoch;
}

export interface MemorySpace extends MemorySpaceRef {
  /** 部署内稳定 instance_id；不得每次启动随机变化。 */
  instance_id: string;
  agent_actor_id: string;
  /**
   * 创建/首次启用时按当前有效管理关系决定；未认领 Agent 为自身。
   * 不取历史创建者，也不因普通权限修订改变。
   */
  owner_actor_id: string;
  ownership_kind: MemoryOwnershipKind;
  capture: MemoryCaptureState;
  created_at: number;
  updated_at: number;
}

/** 归属变化类型；两者都必须切 ownership_epoch 并关闭旧活动绑定。 */
export type MemoryOwnershipTransitionKind = 'initial_claim' | 'management_transfer';

/**
 * 归属变更记录。
 *
 * 旧 space 保留其原权属与已有治理记录，但不再是活动绑定；新 owner 不会
 * 自动获得旧私有历史，只获得原 owner 明确转授且当前仍可披露的资料。
 */
export interface MemoryOwnershipTransition {
  transition_id: MemoryOperationId;
  kind: MemoryOwnershipTransitionKind;
  agent_actor_id: string;
  previous_space_id: MemorySpaceId | null;
  next_space_id: MemorySpaceId;
  previous_owner_actor_id: string | null;
  next_owner_actor_id: string;
  previous_ownership_epoch: MemoryOwnershipEpoch;
  next_ownership_epoch: MemoryOwnershipEpoch;
  closed_host_binding_ids: readonly MemoryHostBindingId[];
  created_at: number;
}

// ---------------------------------------------------------------------------
// 来源范围与披露
// ---------------------------------------------------------------------------

/**
 * 来源范围：该条内容被 Agent 读取时所属房间与成员/策略代次。
 *
 * direct 与每个群各自是一个 origin scope；多个 origin scope 不能合并成
 * Agent 全局经历游标。跨群读取只推进来源房间的经历。
 */
export interface MemoryOriginScope {
  room_id: string;
  member_generation: number;
  policy_revision: number;
  joined_seq: number;
  joined_at: number;
  archive_head_seq: number | null;
}

/** 目的范围：本次运行面向的读者。`agent_private` 只进入该 Agent 自身上下文。 */
export type MemoryDisclosureAudience = 'agent_private' | 'room';

/**
 * 披露范围与来源范围分开编码。`room` 受众必须同时给出当前成员代次和策略
 * 版本；任一缺失都按无效目标处理，不能退化成“同群即可”。宿主切换受众时
 * 必须使用干净的 Context 分支，不能沿用旧摘要、工具结果或隐藏模型状态。
 */
export interface MemoryTargetScope {
  audience: MemoryDisclosureAudience;
  room_id: string | null;
  member_generation: number | null;
  member_seq: number | null;
  policy_revision: number | null;
}

export type MemoryDisclosureReason =
  | 'agent_private'
  | 'same_origin_room'
  | 'explicit_cross_room_grant'
  | 'different_room'
  | 'membership_stale'
  | 'policy_changed'
  | 'invalid_target';

export interface MemoryDisclosureDecision {
  allowed: boolean;
  reason: MemoryDisclosureReason;
}

/**
 * 服务端核实的跨房披露授权；不是客户端可自报的布尔值。
 *
 * 只允许从 `from_room_id` 的来源披露到 `to_room_id` 的目的地，且仍须通过
 * 当前成员资格与策略重验。
 */
export interface MemoryCrossRoomGrant {
  grant_id: string;
  from_room_id: string;
  to_room_id: string;
}

/**
 * 默认披露裁决（保守基线）。
 *
 * - 私聊来源可以进入该 Agent 自己的 private 上下文；
 * - 群来源只能进入同一房间、同一成员代次、同一策略版本的 room 上下文；
 * - 其他情况一律拒绝；跨房只有显式 grant 才放行。
 *
 * 该函数不替代 MemoryService 的当前权限检查，只冻结“默认不跨房”的策略。
 */
export function canDiscloseOrigin(
  origin: Pick<MemoryOriginScope, 'room_id' | 'member_generation' | 'policy_revision'>,
  target: MemoryTargetScope,
  grant: MemoryCrossRoomGrant | null = null,
): MemoryDisclosureDecision {
  if (target.audience === 'agent_private') {
    return { allowed: true, reason: 'agent_private' };
  }
  if (target.room_id === null || target.member_generation === null || target.policy_revision === null) {
    return { allowed: false, reason: 'invalid_target' };
  }
  if (target.room_id !== origin.room_id) {
    const granted =
      grant !== null && grant.from_room_id === origin.room_id && grant.to_room_id === target.room_id;
    return granted
      ? { allowed: true, reason: 'explicit_cross_room_grant' }
      : { allowed: false, reason: 'different_room' };
  }
  if (target.member_generation !== origin.member_generation) {
    return { allowed: false, reason: 'membership_stale' };
  }
  if (target.policy_revision !== origin.policy_revision) {
    return { allowed: false, reason: 'policy_changed' };
  }
  return { allowed: true, reason: 'same_origin_room' };
}

// ---------------------------------------------------------------------------
// 访问信封
// ---------------------------------------------------------------------------

/** 一次裁决的目的；调用方只提供引用，服务端生成信封。 */
export type MemoryAccessPurpose =
  | 'recall'
  | 'context_delivery'
  | 'input_prepare'
  | 'input_exposure'
  | 'governance'
  | 'inspect';

/** 单个房间的当前授权版本。 */
export interface MemoryRoomAccessVersion {
  room_id: string;
  member_generation: number;
  member_seq: number;
  policy_revision: number;
  joined_seq: number;
  joined_at: number;
  archive_head_seq: number | null;
}

/**
 * 每次查询都要重新核对的当前版本集合。
 *
 * ownership_epoch 与 management_binding_id 分开：binding_id 未变也可能已经
 * 发生归属变更；普通权限修订只改 permission_version。
 */
export interface MemoryAccessVersions {
  actor_disabled_at: number | null;
  credential_revoked_at: number | null;
  management_binding_id: string;
  management_permission_version: number;
  rooms: readonly MemoryRoomAccessVersion[];
}

/**
 * 服务端生成的访问信封；客户端不能用自报 tenant/space/provider 扩大范围。
 *
 * 管理权限与内容可见性分开：manage_agent 只决定管理设置，不自动给予读取
 * Agent 或第三方私聊正文的权利。
 */
export interface MemoryAccessEnvelope {
  credential_id: string;
  space: MemorySpaceRef;
  agent_actor_id: string;
  purpose: MemoryAccessPurpose;
  target_scope: MemoryTargetScope;
  origin_scopes: readonly MemoryOriginScope[];
  versions: MemoryAccessVersions;
}

/**
 * 召回/准备预算；候选上限与最终完整记忆包预算分开，最终包按实际模型输入
 * 重新核算。`deadline_at` 是绝对毫秒时间，null 表示由服务端策略决定。
 */
export interface MemoryRecallBudget {
  candidate_limit: number;
  output_bytes: number;
  deadline_at: number | null;
}

// ---------------------------------------------------------------------------
// 来源、表示与稀疏范围
// ---------------------------------------------------------------------------

export const MEMORY_SOURCE_KINDS = [
  'message',
  'task_offer',
  'task_detail',
  'task_attachment',
  'task_submission',
  'task_review',
  'task_handoff',
  'file',
  'manual',
] as const;

export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

/** active 可新读；superseded 只保留历史；retracted 是来源排除，不可重新导入。 */
export type MemorySourceState = 'active' | 'superseded' | 'retracted';

/** 三类来源严格分开；experienced 需要输入提交证据，authored/curated 不需要。 */
export const MEMORY_ORIGIN_KINDS = ['experienced', 'authored', 'curated'] as const;

export type MemoryOriginKind = (typeof MEMORY_ORIGIN_KINDS)[number];

export const MEMORY_PRODUCER_KINDS = ['agent_text', 'server_template', 'mixed'] as const;

/**
 * 发布主体类别。sender_id 只证明发布主体；服务端模板和自动 @ 改写的正文
 * 不能冒充全部由模型生成。
 */
export type MemoryProducerKind = (typeof MEMORY_PRODUCER_KINDS)[number];

/** authored 是否能关联到本次运行；不能关联时禁止扩大的“已验证事实”语义。 */
export type MemoryAuthoredLineage = 'run_bound' | 'lineage_unknown';

/** 业务权威引用；Memory 不复制原业务对象，只保存稳定定位。 */
export type MemorySourceBusinessRef =
  | { kind: 'message'; message_id: string; created_seq: number }
  | { kind: 'task'; task_id: string; revision: number }
  | { kind: 'task_submission'; task_id: string; submission_id: string; version: number }
  | { kind: 'task_review'; task_id: string; review_id: string; submission_id: string; version: number }
  | { kind: 'handoff'; pack_id: string; item_id: string }
  | { kind: 'file'; file_id: string; sha256: MemorySha256 }
  | { kind: 'manual'; entry_id: string };

export interface MemorySourceRef {
  source_id: MemorySourceId;
  source_revision: number;
}

/**
 * 共享来源修订。
 *
 * 当前 messages 没有通用 content_revision；Memory 自己维护来源修订：首次
 * 可用内容为一版，明确撤回/纠正产生新控制修订。digest 只用于核对，不按
 * messages.updated_at 猜版本。Source 只保存共同权威身份；个人库只接收
 * SourceSelection/SubmittedInputManifest 中的准确表示，不能凭 message_id
 * 回抓未交付全文。
 */
export interface MemorySource extends MemorySourceRef {
  source_kind: MemorySourceKind;
  business_ref: MemorySourceBusinessRef;
  origin_scope: MemoryOriginScope;
  author_actor_id: string | null;
  state: MemorySourceState;
  content_sha256: MemorySha256 | null;
  content_bytes: MemoryUtf8Bytes | null;
  superseded_by: MemorySourceRef | null;
  retracted_at: number | null;
  created_at: number;
}

export const MEMORY_REPRESENTATION_KINDS = [
  'raw_full',
  'raw_fragment',
  'preview',
  'summary',
  'memory_context',
  'authored',
] as const;

export type MemoryRepresentationKind = (typeof MEMORY_REPRESENTATION_KINDS)[number];

/** 半开 UTF-8 字节范围 [start, end)；端点必须落在合法码点边界。 */
export interface MemoryByteRange {
  start: number;
  end: number;
}

/** 一个表示依赖的上游来源/表示；治理与授权沿依赖传播。 */
export interface MemorySourceDependency {
  source_id: MemorySourceId;
  source_revision: number;
  representation_id: MemoryRepresentationId | null;
  range: MemoryByteRange | null;
}

/**
 * 隔离分区证明：同一分区内的输入共享读取/披露政策。
 *
 * 这是“无法逐项证明时的保守替代”，不能把后端自报的 room 标签当作证明；
 * 分区代次失效时整区停读并重建。
 */
export interface MemoryPartitionProof {
  partition_id: string;
  generation: number;
  policy_revision: number;
  source_ids: readonly MemorySourceId[];
}

interface MemoryRepresentationBase {
  representation_id: MemoryRepresentationId;
  text_bytes: MemoryUtf8Bytes;
  text_sha256: MemorySha256;
  /** 是否为原文的准确字节；search snippet、翻译、压缩摘要均为 false。 */
  verbatim: boolean;
}

/**
 * 原文完整/片段/预览；只有 raw_* 能推进原文消费范围。
 *
 * preview 即使可核实为原文前缀，也只登记实际前缀；若要形成原文覆盖，
 * SourceResolver 必须另行签发 raw_fragment，不能把 preview 当全文。
 */
export interface MemoryRawRepresentation extends MemoryRepresentationBase {
  kind: 'raw_full' | 'raw_fragment' | 'preview';
  source_id: MemorySourceId;
  source_revision: number;
  range: MemoryByteRange;
  depends_on: readonly MemorySourceDependency[];
}

/** 摘要拥有自己的 ID/revision/hash 与依赖；不推进任何来源的原文范围。 */
export interface MemorySummaryRepresentation extends MemoryRepresentationBase {
  kind: 'summary';
  summary_id: string;
  revision: number;
  depends_on: readonly MemorySourceDependency[];
  partition_proof: MemoryPartitionProof | null;
}

/** 之前交付的 Memory Context 再次回流时，只登记实际表示及其依赖。 */
export interface MemoryContextRepresentation extends MemoryRepresentationBase {
  kind: 'memory_context';
  source_context_id: MemoryContextId;
  depends_on: readonly MemorySourceDependency[];
}

/** 自身发布记录；producer_kind 区分模型文本、服务端模板和混合内容。 */
export interface MemoryAuthoredRepresentation extends MemoryRepresentationBase {
  kind: 'authored';
  source_id: MemorySourceId;
  source_revision: number;
  producer_kind: MemoryProducerKind;
  /**
   * 能关联本次运行时继承实际依赖；不能关联时为 lineage_unknown，
   * 不得自动成为可扩大披露的已验证事实。
   */
  lineage: MemoryAuthoredLineage;
  depends_on: readonly MemorySourceDependency[];
}

export type MemoryRepresentation =
  | MemoryRawRepresentation
  | MemorySummaryRepresentation
  | MemoryContextRepresentation
  | MemoryAuthoredRepresentation;

/** 交给 Adapter 的准确字节；text 必须与 representation.text_sha256 一致。 */
export interface MemoryExactRepresentation {
  representation: MemoryRepresentation;
  text: string;
}

/** 只有 raw_* 表示能作为原文消费证明；preview/summary/context 都不行。 */
export function countsAsRawCoverage(kind: MemoryRepresentationKind): boolean {
  return kind === 'raw_full' || kind === 'raw_fragment';
}

export function isValidByteRange(range: MemoryByteRange, textBytes: MemoryUtf8Bytes): boolean {
  return (
    Number.isInteger(range.start) &&
    Number.isInteger(range.end) &&
    range.start >= 0 &&
    range.end > range.start &&
    range.end <= textBytes
  );
}

/** 合并重叠/相邻片段，用于判断历史累计覆盖；不改变原始证据。 */
export function mergeByteRanges(ranges: readonly MemoryByteRange[]): MemoryByteRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .map((range) => ({ start: range.start, end: range.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: MemoryByteRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

/**
 * 是否在同一源修订上覆盖完整 [0, text_bytes)。
 *
 * 空正文不产生 raw_full 证明；缺块、预览、不同修订或超界都不能拼成完整。
 */
export function isFullRawCoverage(
  ranges: readonly MemoryByteRange[],
  textBytes: MemoryUtf8Bytes,
): boolean {
  if (!Number.isInteger(textBytes) || textBytes <= 0) return false;
  const merged = mergeByteRanges(ranges);
  const only = merged[0];
  return merged.length === 1 && only !== undefined && only.start === 0 && only.end === textBytes;
}

// ---------------------------------------------------------------------------
// 人工记忆与可重建投影
// ---------------------------------------------------------------------------

/** 人工明确保存的记忆；不冒充 Agent 曾读过原文。 */
export interface MemoryCuratedMemory {
  curated_id: MemoryCuratedId;
  space: MemorySpaceRef;
  revision: number;
  origin: 'manual' | 'imported_external_knowledge';
  title: string;
  content: string;
  content_sha256: MemorySha256;
  content_bytes: MemoryUtf8Bytes;
  created_by_actor_id: string;
  created_at: number;
  updated_at: number;
  state: 'active' | 'superseded' | 'excluded';
}

/**
 * 引擎投影引用。
 *
 * provider_id/provider_revision 只用于定位后端对象，不是授权凭据；换库后
 * 允许 ID、自然语言和排序变化，不能承诺投影稳定。
 */
export interface MemoryBackendRef {
  space: MemorySpaceRef;
  provider_id: string;
  provider_revision: string;
}

export interface MemoryProjectionRecord {
  projection_id: string;
  space: MemorySpaceRef;
  origin_kind: MemoryOriginKind;
  source: MemorySourceRef | null;
  representation_id: MemoryRepresentationId | null;
  curated_id: MemoryCuratedId | null;
  backend_ref: MemoryBackendRef;
  /** 投影永远可重建；业务事实不依赖投影 ID。 */
  rebuildable: true;
  created_at: number;
  updated_at: number;
}


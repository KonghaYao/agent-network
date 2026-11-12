/**
 * MF11 冻结的 HostBridge 证据协议（供 MF07 实现直接使用）。
 *
 * 这里只定义宿主与服务端之间的输入清单/提交报告/网关观测消息与判定，
 * 不包含 MCP 工具或存储实现。三条不可交换点：
 * 1. 宿主只能报告“实际提交了什么”这一事实；证据等级由服务端按已签发
 *    HostBinding 的 trust_level 派生，客户端传 trusted/verified/evidence 一律拒绝。
 * 2. 提交报告绑定准确的 invocation + manifest hash + payload hash；同一
 *    invocation 只能绑定一个 manifest，冲突必须显式失败。
 * 3. 网关观测是独立 proof，可追加到已有经历，但不能改写原 receipt 或
 *    重新制造个人事实。
 */
import { BusinessError } from '../contracts/errors';
import type {
  MemoryByteRange,
  MemoryHostBindingId,
  MemoryManifestId,
  MemorySha256,
  MemoryTargetScope,
} from './contracts-core';
import type {
  MemoryContextTarget,
  MemoryExposureEvidenceKind,
  MemoryInvocationIdentity,
} from './experience-contracts';
import {
  hostSupports,
  type MemoryHostCapability,
  type MemoryHostIntegrationLevel,
} from './recall-contracts';

/** 协议版本随字段变化递增；MF07 与宿主必须精确匹配。 */
export const MEMORY_HOST_PROTOCOL_VERSION = '2026-11-11.1';

/**
 * 客户端输入中禁止出现的信任声明字段。
 *
 * 允许宿主声明“我能做什么”（capabilities），不允许声明“服务端已经信任我”
 * 或“这次提交已达某证据等级”。服务端会忽略能力声明以外的任何自报等级。
 */
export const MEMORY_FORBIDDEN_TRUST_CLAIM_KEYS = [
  'trusted',
  'trusted_gateway',
  'verified',
  'verified_by',
  'trust_level',
  'evidence',
  'evidence_level',
  'proof_level',
  'gateway_observed',
  'gateway_verified',
  'attested',
  'submitted_verified',
] as const;

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

/**
 * 拒绝客户端自报信任等级或证据等级。
 *
 * 只检查协议输入对象，不用于服务端输出。嵌套对象也会检查，避免把
 * `{ metadata: { trusted: true } }` 当成可忽略的备注。
 */
export function assertNoClientTrustClaims(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoClientTrustClaims(item, `${path}[${index}]`));
    return;
  }
  const forbidden = new Set<string>(MEMORY_FORBIDDEN_TRUST_CLAIM_KEYS);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(normalizeKey(key))) {
      throw new BusinessError('INVALID_ARGUMENT', '客户端不能自报 verified/trusted 或证据等级', {
        reason: 'client_claim_not_accepted',
        field: `${path}.${key}`,
      });
    }
    assertNoClientTrustClaims(child, `${path}.${key}`);
  }
}

export function assertHostProtocolVersion(value: string): void {
  if (value !== MEMORY_HOST_PROTOCOL_VERSION) {
    throw new BusinessError('MEMORY_UNSUPPORTED', 'HostBridge 协议版本不受支持', {
      reason: 'protocol_version_unsupported',
      expected: MEMORY_HOST_PROTOCOL_VERSION,
      actual: value,
    });
  }
}

/**
 * 宿主报告“已提交”时服务端可接受的最大证据。
 *
 * 即使绑定等级是 controlled_gateway，单纯 host report 仍只是
 * `host_reported_submitted`；只有网关实际观测才追加 gateway proof。
 */
export function deriveHostSubmissionEvidence(
  level: MemoryHostIntegrationLevel,
  capabilities: readonly MemoryHostCapability[],
): MemoryExposureEvidenceKind | null {
  if (!hostSupports(level, 'final_manifest_report')) return null;
  if (!hostSupports(level, 'submission_evidence')) return null;
  if (!capabilities.includes('final_manifest_report')) return null;
  if (!capabilities.includes('submission_evidence')) return null;
  return 'host_reported_submitted';
}

/** 网关观测独立于宿主自报；必须由受控网关绑定提供。 */
export function deriveGatewayObservationEvidence(
  level: MemoryHostIntegrationLevel,
  capabilities: readonly MemoryHostCapability[],
): MemoryExposureEvidenceKind | null {
  if (level !== 'controlled_gateway') return null;
  if (!hostSupports(level, 'gateway_observation')) return null;
  if (!capabilities.includes('gateway_observation')) return null;
  return 'gateway_observed_submitted';
}

// ---------------------------------------------------------------------------
// 宿主 -> 服务端消息（只有事实，没有信任布尔值）
// ---------------------------------------------------------------------------

export interface MemoryHostManifestItemReport {
  selection_id: string;
  representation_id: string;
  text_sha256: MemorySha256;
  /**
   * 该准确表示在最终 payload 中的 UTF-8 半开字节范围。
   * 提供时服务端按范围逐字节核对；省略时至少要求 payload 中包含完整文本。
   */
  payload_range?: MemoryByteRange;
}

/** 宿主最终裁剪/压缩/模板拼装后提交的清单。 */
export interface MemoryHostFinalManifestReport {
  protocol_version: typeof MEMORY_HOST_PROTOCOL_VERSION;
  host_binding_id: MemoryHostBindingId;
  host_generation: number;
  invocation: MemoryInvocationIdentity;
  target: MemoryContextTarget;
  /** 实际最终 payload（可能包含模板、非记忆内容）；服务端自行计算 hash。 */
  payload: string;
  /** 宿主声称的 payload hash，仅用于对账，不替代服务端计算。 */
  payload_sha256: MemorySha256;
  items: readonly MemoryHostManifestItemReport[];
}

/** 宿主报告“该清单已随本次请求提交”；不包含 evidence/trusted 字段。 */
export interface MemoryHostExposureReport {
  protocol_version: typeof MEMORY_HOST_PROTOCOL_VERSION;
  host_binding_id: MemoryHostBindingId;
  host_generation: number;
  manifest_id: MemoryManifestId;
  manifest_sha256: MemorySha256;
  payload_sha256: MemorySha256;
  /** 宿主侧幂等键；同一键不同内容必须冲突。 */
  request_id: string;
  submitted_at: number;
}

/** 服务端确认；evidence 由服务端派生，宿主不能自行填写。 */
export interface MemoryHostExposureAck {
  request_id: string;
  manifest_id: MemoryManifestId;
  disposition: 'applied' | 'history_only' | 'rejected' | 'duplicate' | 'upgraded';
  evidence: MemoryExposureEvidenceKind | null;
  experience_ids: readonly string[];
  retain_ids: readonly string[];
  reason: string | null;
}

/**
 * 受控网关观测到的最终 outbound payload。
 *
 * 该消息只能由服务端配置的网关路径产生；普通 Agent 不能调用它。
 * `observed_payload_sha256` 必须与持久请求记录一致。
 */
export interface MemoryGatewayObservationReport {
  protocol_version: typeof MEMORY_HOST_PROTOCOL_VERSION;
  host_binding_id: MemoryHostBindingId;
  host_generation: number;
  invocation_id: string;
  manifest_id: MemoryManifestId;
  manifest_sha256: MemorySha256;
  observed_payload_sha256: MemorySha256;
  observed_at: number;
}

/** 宿主断线/关闭绑定；之后不能继续签发或确认输入。 */
export interface MemoryHostCloseReport {
  protocol_version: typeof MEMORY_HOST_PROTOCOL_VERSION;
  host_binding_id: MemoryHostBindingId;
  host_generation: number;
  reason: 'session_end' | 'run_end' | 'lease_expired' | 'client_closed';
}

/** 目标受众切换必须重建绑定和干净上下文分支，不能沿用旧 payload。 */
export function targetScopeChanged(
  previous: MemoryTargetScope,
  next: MemoryTargetScope,
): boolean {
  return (
    previous.audience !== next.audience ||
    previous.room_id !== next.room_id ||
    previous.member_generation !== next.member_generation ||
    previous.member_seq !== next.member_seq ||
    previous.policy_revision !== next.policy_revision
  );
}

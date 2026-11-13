/**
 * MF07：宿主绑定、输入准备、最终清单与提交证据。
 *
 * 三条不可交换点：
 * 1. 信任等级只由部署配置决定；客户端的 capabilities 只协商能力，不能自报
 *    verified/trusted 或把 tool-only 提升为网关。
 * 2. 准备包（PreparedInput）与最终提交清单（SubmittedInputManifest）分开；
 *    prepared 永远 `retain_eligible: false`，只有合格 receipt 才产生经历与
 *    retain 意图。
 * 3. 宿主排队只是宿主事实，不是服务端提交证据；断线/租约过期后旧 run 不能
 *    继续接收补充，返回 skipped_no_boundary，不重放模型调用。
 */
import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  getActiveMemoryHostBindingBySession,
  getLatestActiveMemoryHostBinding,
  getLatestMemoryReceiptForManifest,
  getMemoryHostBinding,
  getMemoryManifest,
  getMemorySelection,
  hasMemoryGatewayProof,
  hasMemoryReceiptForManifest,
  type D1Like,
} from '../storage/queries';
import {
  assertHostProtocolVersion,
  assertNoClientTrustClaims,
  deriveGatewayObservationEvidence,
  MEMORY_HOST_PROTOCOL_VERSION,
  type MemoryGatewayObservationReport,
  type MemoryHostExposureAck,
  type MemoryHostExposureReport,
  type MemoryHostFinalManifestReport,
} from './host-protocol';
import {
  bindingCapabilities,
  integrationLevel,
  requireHostBinding,
  type MemoryManifestBuildResult,
} from './input-manifest';
import {
  hostCapabilities,
  hostSupports,
  type MemoryExposureEvidenceKind,
  type MemoryHostCapability,
  type MemoryHostIntegrationLevel,
  type MemoryContextTarget,
  type MemoryOriginScope,
  type MemoryPreparedInput,
  type MemoryRecallBudget,
  type MemoryRepresentation,
  type MemorySpaceRef,
  type MemorySourceSelection,
  type MemorySubmissionState,
  type MemoryTargetScope,
} from './contracts';
import { authorizeRepresentationRead, requireCurrentMemorySpace } from './access';
import {
  submitGatewayObservation,
  submitHostExposureReport,
  submitHostManifestReport,
} from './host-exposure';
import { loadRepresentationExact } from './experience-source';
import { getSource } from './store';
import { bindMemoryHost } from './store-objects';
import type { MemoryHostBindingRow } from './rows';
import {
  assertDeliveryAttemptUnchanged,
  resolveMessageContextTarget,
  taskTargetUnsupported,
} from './target';

// ---------------------------------------------------------------------------
// 部署策略（服务端配置，不是客户端输入）
// ---------------------------------------------------------------------------

export interface MemoryHostPolicy {
  trust_level: MemoryHostIntegrationLevel;
  /** 可进一步收缩该等级允许的能力；不能超过等级上限。 */
  allowed_capabilities?: readonly MemoryHostCapability[];
}

export const DEFAULT_MEMORY_HOST_POLICY: MemoryHostPolicy = { trust_level: 'tool_only' };

export function memoryHostPolicyFromEnv(value: string | undefined): MemoryHostPolicy {
  const level = value?.trim().toLowerCase();
  if (!level || level === 'tool_only' || level === 'api_tool_only') {
    return DEFAULT_MEMORY_HOST_POLICY;
  }
  if (level === 'adapted_host') return { trust_level: 'adapted_host' };
  if (level === 'controlled_gateway') return { trust_level: 'controlled_gateway' };
  return DEFAULT_MEMORY_HOST_POLICY;
}

function grantedCapabilities(
  policy: MemoryHostPolicy,
  declared: readonly MemoryHostCapability[],
): MemoryHostCapability[] {
  const levelCaps = hostCapabilities(policy.trust_level);
  const allowed = new Set(policy.allowed_capabilities ?? levelCaps);
  return levelCaps.filter((capability) => allowed.has(capability) && declared.includes(capability));
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------

export interface MemoryHostBindingView {
  protocol_version: string;
  binding_id: string;
  generation: number;
  agent_actor_id: string;
  space: MemorySpaceRef;
  level: MemoryHostIntegrationLevel;
  declared_capabilities: readonly MemoryHostCapability[];
  granted_capabilities: readonly MemoryHostCapability[];
  session_incarnation: string;
  lease_expires_at: number;
  created_at: number;
  reused: boolean;
}

export interface MemoryPreparedInputItem {
  selection_id: string;
  representation: MemoryRepresentation;
  origin_scope: MemoryOriginScope;
  target_scope: MemoryTargetScope;
  text: string;
  text_sha256: string;
  text_bytes: number;
  expires_at: number | null;
}

export interface MemoryPreparedInputView extends Omit<MemoryPreparedInput, 'selections'> {
  status: 'prepared';
  selections: readonly MemorySourceSelection[];
  items: readonly MemoryPreparedInputItem[];
  /** 与宿主实际最终 payload 对账前，绝不能作为已消费。 */
  retain_eligible: false;
}

export interface MemoryPreparedSkipped {
  status: 'skipped_no_boundary';
  prepared: null;
  retain_eligible: false;
  reason: string;
}

export type MemoryPrepareResult = MemoryPreparedInputView | MemoryPreparedSkipped;

export interface MemoryManifestView {
  status: 'prepared';
  manifest: MemoryManifestBuildResult['manifest'];
  evidence: MemoryExposureEvidenceKind;
  retain_eligible: false;
  created: boolean;
}

export interface MemoryInputStateView {
  manifest_id: string;
  status: MemorySubmissionState | 'host_queued';
  submitted_evidence: MemoryExposureEvidenceKind | null;
  retain_eligible: boolean;
  retain_ids: readonly string[];
  receipt_disposition: 'applied' | 'history_only' | 'rejected' | null;
  receipt_reason: string | null;
  manifest_sha256: string;
  payload_sha256: string;
  created_at: number;
}

export interface MemoryHostBridgeOptions {
  db: D1Like;
  instanceId: string;
  agentId: string;
  /** 当前已鉴权凭据；HostBinding 不能跨凭据复用。 */
  credentialId: string;
  space: MemorySpaceRef;
  policy?: MemoryHostPolicy;
  now?: () => number;
}

interface QueuedManifest {
  binding_id: string;
  generation: number;
  queued_at: number;
}

/**
 * 单个宿主会话/运行边界的服务端桥。
 *
 * 该对象可以跨请求复用；进程重启后 queued 只是宿主声明状态丢失，已持久化的
 * manifest/receipt/proof 不受影响。队列本身从不作为提交证据。
 */
export class MemoryHostBridge {
  readonly #db: D1Like;
  readonly #options: MemoryHostBridgeOptions;
  readonly #policy: MemoryHostPolicy;
  readonly #queued = new Map<string, QueuedManifest>();

  constructor(options: MemoryHostBridgeOptions) {
    this.#options = options;
    this.#db = options.db;
    this.#policy = options.policy ?? DEFAULT_MEMORY_HOST_POLICY;
  }

  private now(): number {
    return this.#options.now?.() ?? nowMs();
  }

  private policyLevel(): MemoryHostIntegrationLevel {
    return this.#policy.trust_level;
  }

  /** 服务端签发绑定；同 session/能力重复调用复用同一活动代次。 */
  async bind(input: {
    request_id: string;
    session_incarnation?: string;
    declared_capabilities?: readonly MemoryHostCapability[];
    lease_ms?: number;
  }): Promise<MemoryHostBindingView> {
    const at = this.now();
    const explicitSession = input.session_incarnation !== undefined;
    const sessionIncarnation = input.session_incarnation ?? `session:${input.request_id}`;
    const declared = [...new Set(input.declared_capabilities ?? [])];
    const granted = grantedCapabilities(this.#policy, declared);
    const context = await requireCurrentMemorySpace(this.#db, {
      agentId: this.#options.agentId,
      instanceId: this.#options.instanceId,
      expected: this.#options.space,
      at,
    });
    const existing = await getActiveMemoryHostBindingBySession(
      this.#db,
      context.space.space_id,
      sessionIncarnation,
    );
    // 显式 session 的重复 bind 视为新的运行代次：旧 generation 立即失效，
    // 避免宿主 run 重启后旧 run 仍能接收迟到补充。只有省略 session 时用
    // request_id 派生的稳定会话做幂等重放。
    if (existing && !explicitSession) {
      const storedCaps = bindingCapabilities(existing);
      const same =
        existing.trust_level === (this.policyLevel() === 'tool_only' ? 'api_tool_only' : this.policyLevel()) &&
        storedCaps.length === granted.length &&
        storedCaps.every((capability) => granted.includes(capability)) &&
        (existing.lease_until === null || existing.lease_until >= at);
      if (same) {
        return {
          protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
          binding_id: existing.binding_id,
          generation: existing.generation,
          agent_actor_id: existing.agent_actor_id,
          space: {
            space_id: existing.space_id,
            ownership_epoch: existing.ownership_epoch,
            backend_binding_epoch: context.space.backend_binding_epoch,
          },
          level: integrationLevel(existing),
          declared_capabilities: declared,
          granted_capabilities: storedCaps,
          session_incarnation: existing.session_incarnation,
          lease_expires_at: existing.lease_until ?? at + LIMITS.memoryHostLeaseMs,
          created_at: existing.created_at,
          reused: true,
        };
      }
    }
    const leaseUntil = at + Math.max(1_000, input.lease_ms ?? LIMITS.memoryHostLeaseMs);
    const level = this.policyLevel();
    const created = await bindMemoryHost(this.#db, {
      instanceId: this.#options.instanceId,
      agentId: this.#options.agentId,
      space: context.space,
      credentialId: this.#options.credentialId,
      sessionIncarnation,
      declaredCapabilities: granted,
      trustLevel: level === 'tool_only' ? 'api_tool_only' : level,
      leaseUntil,
      now: at,
    });
    return {
      protocol_version: MEMORY_HOST_PROTOCOL_VERSION,
      binding_id: created.binding_id,
      generation: created.generation,
      agent_actor_id: this.#options.agentId,
      space: context.space,
      level: this.policyLevel(),
      declared_capabilities: declared,
      granted_capabilities: granted,
      session_incarnation: sessionIncarnation,
      lease_expires_at: leaseUntil,
      created_at: at,
      reused: false,
    };
  }

  /** 当前活动绑定；用于工具层解析 generation。 */
  async activeBinding(): Promise<MemoryHostBindingRow | null> {
    return getLatestActiveMemoryHostBinding(
      this.#db,
      this.#options.space.space_id,
      this.#options.agentId,
    );
  }

  private async requireBridgeBinding(input: {
    bindingId: string;
    generation: number;
    at: number;
  }): Promise<MemoryHostBindingRow> {
    const context = await requireCurrentMemorySpace(this.#db, {
      agentId: this.#options.agentId,
      instanceId: this.#options.instanceId,
      expected: this.#options.space,
      at: input.at,
    });
    return requireHostBinding(this.#db, {
      bindingId: input.bindingId,
      generation: input.generation,
      space: context.space,
      agentId: this.#options.agentId,
      at: input.at,
    });
  }

  private async resolveTarget(input: {
    target: import('./schema-contracts').MemoryContextTargetInput;
    bindingId: string;
    generation: number;
    at: number;
  }): Promise<MemoryContextTarget> {
    if (input.target.kind === 'task') taskTargetUnsupported();
    const binding = await this.requireBridgeBinding({
      bindingId: input.bindingId,
      generation: input.generation,
      at: input.at,
    });
    const level = integrationLevel(binding);
    if (!hostSupports(level, 'run_binding') || !bindingCapabilities(binding).includes('run_binding')) {
      throw new BusinessError('MEMORY_UNSUPPORTED', '当前宿主等级或声明不能绑定运行输入', {
        reason: 'run_binding_unsupported',
        level,
      });
    }
    return resolveMessageContextTarget(this.#db, {
      instanceId: this.#options.instanceId,
      agentId: this.#options.agentId,
      space: this.#options.space,
      hostBindingId: binding.binding_id,
      hostGeneration: binding.generation,
      sessionIncarnation: binding.session_incarnation,
      runId: input.target.run_id,
      inputId: input.target.input_id,
      inputRevision: input.target.input_revision,
      message: input.target.message!,
      now: input.at,
    });
  }

  /**
   * 精确输入准备。
   *
   * 只接受服务端之前签发的 selection；不接受客户端正文、来源 ID 或受众。
   * 返回的 `items[].text` 是宿主可以实际提交的准确表示，不是消费证明。
   */
  async prepareInput(input: {
    request_id: string;
    target: import('./schema-contracts').MemoryContextTargetInput;
    selection_ids: readonly string[];
    budget: MemoryRecallBudget;
  }): Promise<MemoryPrepareResult> {
    const at = this.now();
    let target: MemoryContextTarget;
    try {
      target = await this.resolveTarget({
        target: input.target,
        bindingId: input.target.host_binding_id,
        generation: input.target.host_generation,
        at,
      });
    } catch (error) {
      if (
        error instanceof BusinessError &&
        (error.code === 'MEMORY_TARGET_INVALID' || error.code === 'PERMISSION_DENIED') &&
        (error.details?.reason === 'host_binding_missing' ||
          error.details?.reason === 'host_binding_inactive' ||
          error.details?.reason === 'host_binding_lease_expired' ||
          error.details?.reason === 'host_binding_stale')
      ) {
        return {
          status: 'skipped_no_boundary',
          prepared: null,
          retain_eligible: false,
          reason: String(error.details?.reason ?? 'host_binding_unavailable'),
        };
      }
      throw error;
    }
    const items: MemoryPreparedInputItem[] = [];
    const selections: MemorySourceSelection[] = [];
    let snapshotUpperBound = 0;
    let expiresAt: number | null = null;
    for (const selectionId of input.selection_ids) {
      const row = await getMemorySelection(this.#db, selectionId);
      if (!row) {
        throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 不存在', {
          reason: 'selection_missing',
          selection_id: selectionId,
        });
      }
      if (
        row.space_id !== this.#options.space.space_id ||
        row.ownership_epoch !== this.#options.space.ownership_epoch ||
        row.agent_actor_id !== this.#options.agentId ||
        row.state !== 'available'
      ) {
        throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 已失效', {
          reason: 'selection_stale',
          selection_id: selectionId,
        });
      }
      if (row.expires_at !== null && row.expires_at < at) {
        throw new BusinessError('REQUEST_EXPIRED', 'selection 已过期，需要重新准备输入', {
          selection_id: selectionId,
        });
      }
      let selectionTarget: MemoryTargetScope;
      let originScope: MemoryOriginScope;
      let versions: MemorySourceSelection['versions'];
      try {
        selectionTarget = JSON.parse(row.target_scope_json) as MemoryTargetScope;
        originScope = JSON.parse(row.origin_scope_json) as MemoryOriginScope;
        versions = JSON.parse(row.versions_json) as MemorySourceSelection['versions'];
      } catch {
        throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 元数据损坏', {
          reason: 'selection_corrupt',
          selection_id: selectionId,
        });
      }
      if (!sameTargetScope(selectionTarget, target.target_scope)) {
        throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 受众与运行目标不一致', {
          reason: 'selection_target_mismatch',
          selection_id: selectionId,
        });
      }
      const exact = await loadRepresentationExact(this.#db, row.representation_id);
      if (!exact) {
        throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'selection 表示缺失', {
          reason: 'representation_missing',
          selection_id: selectionId,
        });
      }
      if (exact.representation.kind === 'authored') {
        throw new BusinessError('MEMORY_TARGET_INVALID', 'authored 不能作为输入 selection', {
          reason: 'authored_not_input',
          selection_id: selectionId,
        });
      }
      const decision = await authorizeRepresentationRead(this.#db, {
        space: this.#options.space,
        representationId: exact.representation.representation_id,
        agentId: this.#options.agentId,
        target_scope: target.target_scope,
        at,
      });
      if (!decision.allowed) {
        throw new BusinessError('PERMISSION_DENIED', 'selection 当前无权披露到目标受众', {
          reason: decision.reason,
          selection_id: selectionId,
        });
      }
      if (
        exact.representation.kind === 'raw_full' ||
        exact.representation.kind === 'raw_fragment' ||
        exact.representation.kind === 'preview'
      ) {
        const source = await getSource(
          this.#db,
          exact.representation.source_id,
          exact.representation.source_revision,
        );
        if (source?.origin_seq) snapshotUpperBound = Math.max(snapshotUpperBound, source.origin_seq);
      }
      selections.push({
        selection_id: row.selection_id,
        representation: exact.representation,
        origin_scope: originScope,
        target_scope: selectionTarget,
        versions,
        issued_at: row.issued_at,
        expires_at: row.expires_at,
        consumption: 'not_consumed',
      });
      items.push({
        selection_id: row.selection_id,
        representation: exact.representation,
        origin_scope: originScope,
        target_scope: selectionTarget,
        text: exact.text,
        text_sha256: exact.representation.text_sha256,
        text_bytes: exact.representation.text_bytes,
        expires_at: row.expires_at,
      });
      expiresAt =
        expiresAt === null
          ? row.expires_at
          : row.expires_at === null
            ? expiresAt
            : Math.min(expiresAt, row.expires_at);
    }
    const preparedId = `mpi_${(
      await sha256Hex(
        stableStringify({
          target: {
            agent: target.agent_actor_id,
            space: target.space,
            host: target.host_binding_id,
            generation: target.host_generation,
            session: target.session_incarnation,
            run: target.run_id,
            input: target.input_id,
            revision: target.input_revision,
            scope: target.target_scope,
          },
          selections: input.selection_ids,
        }),
      )
    ).slice(0, 32)}`;
    return {
      prepared_input_id: preparedId,
      status: 'prepared',
      target,
      selections,
      items,
      snapshot_upper_bound: snapshotUpperBound,
      budget: input.budget,
      created_at: at,
      expires_at: expiresAt,
      retain_eligible: false,
    };
  }

  /** 服务端重建最终清单；prepared 不能直接当 submitted。 */
  async submitManifest(report: MemoryHostFinalManifestReport): Promise<MemoryManifestView> {
    assertHostProtocolVersion(report.protocol_version);
    assertNoClientTrustClaims(report);
    if (report.target.kind === 'message') {
      await assertDeliveryAttemptUnchanged(this.#db, this.#options.agentId, report.target.message);
    }
    const result = await submitHostManifestReport(this.#db, {
      instanceId: this.#options.instanceId,
      agentId: this.#options.agentId,
      space: this.#options.space,
      report,
      now: this.now(),
    });
    return {
      status: 'prepared',
      manifest: result.manifest,
      evidence: result.evidence,
      retain_eligible: false,
      created: result.created,
    };
  }

  /**
   * 宿主报告“已排队/已交给运行时”。
   *
   * 这是宿主本地事实，不是服务端提交证据；不写 receipt、不产生经历与 retain。
   * 进程重启后该状态丢失，不能作为已提交依据。
   */
  async markHostQueued(manifestId: string): Promise<MemoryInputStateView> {
    const at = this.now();
    const manifest = await getMemoryManifest(this.#db, manifestId);
    if (!manifest) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 不存在', {
        reason: 'manifest_missing',
      });
    }
    if (
      manifest.space_id !== this.#options.space.space_id ||
      manifest.ownership_epoch !== this.#options.space.ownership_epoch ||
      manifest.agent_actor_id !== this.#options.agentId ||
      !manifest.host_binding_id ||
      manifest.host_generation === null
    ) {
      throw new BusinessError('PERMISSION_DENIED', 'manifest 不属于当前宿主空间');
    }
    await this.requireBridgeBinding({
      bindingId: manifest.host_binding_id,
      generation: manifest.host_generation,
      at,
    });
    const receipt = await hasMemoryReceiptForManifest(this.#db, manifest.manifest_id);
    if (receipt) return this.inputState(manifest.manifest_id);
    this.#queued.set(manifest.manifest_id, {
      binding_id: manifest.host_binding_id,
      generation: manifest.host_generation,
      queued_at: at,
    });
    return {
      manifest_id: manifest.manifest_id,
      status: 'host_queued',
      submitted_evidence: null,
      retain_eligible: false,
      retain_ids: [],
      receipt_disposition: null,
      receipt_reason: null,
      manifest_sha256: manifest.manifest_sha256,
      payload_sha256: manifest.payload_sha256,
      created_at: manifest.created_at,
    };
  }

  /**
   * 接收宿主最终提交报告。
   *
   * evidence 由服务端按已签发绑定派生；迟到/失效绑定的报告只返回 rejected，
   * 不写新 owner 经历、不复活正文。
   */
  async submitExposure(report: MemoryHostExposureReport): Promise<MemoryHostExposureAck> {
    assertHostProtocolVersion(report.protocol_version);
    assertNoClientTrustClaims(report);
    const manifest = await getMemoryManifest(this.#db, report.manifest_id);
    if (!manifest) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 不存在', {
        reason: 'manifest_missing',
      });
    }
    if (
      manifest.space_id !== this.#options.space.space_id ||
      manifest.ownership_epoch !== this.#options.space.ownership_epoch ||
      manifest.agent_actor_id !== this.#options.agentId
    ) {
      throw new BusinessError('PERMISSION_DENIED', 'manifest 不属于当前 Agent 空间');
    }
    if (
      report.manifest_sha256 !== manifest.manifest_sha256 ||
      report.payload_sha256 !== manifest.payload_sha256
    ) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '提交报告的 hash 与 manifest 不一致', {
        reason: 'payload_hash_mismatch',
        manifest_id: report.manifest_id,
      });
    }
    try {
      const target = JSON.parse(manifest.target_json) as MemoryContextTarget;
      if (target.kind === 'message') {
        await assertDeliveryAttemptUnchanged(this.#db, this.#options.agentId, target.message);
      }
    } catch (error) {
      if (error instanceof BusinessError && error.details?.reason === 'delivery_claim_stale') throw error;
      throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 目标损坏', {
        reason: 'manifest_target_corrupt',
      });
    }
    try {
      const ack = await submitHostExposureReport(this.#db, {
        instanceId: this.#options.instanceId,
        agentId: this.#options.agentId,
        space: this.#options.space,
        report,
        now: this.now(),
      });
      this.#queued.delete(report.manifest_id);
      return ack;
    } catch (error) {
      if (
        error instanceof BusinessError &&
        (error.code === 'MEMORY_TARGET_INVALID' ||
          error.code === 'ACTOR_DISABLED' ||
          error.code === 'PERMISSION_DENIED')
      ) {
        const reason = String(error.details?.reason ?? error.code);
        if (
          reason === 'ownership_changed' ||
          reason === 'space_epoch_stale' ||
          reason === 'agent_disabled' ||
          reason === 'host_binding_inactive' ||
          reason === 'host_binding_lease_expired' ||
          reason === 'host_binding_stale'
        ) {
          this.#queued.delete(report.manifest_id);
          return {
            request_id: report.request_id,
            manifest_id: report.manifest_id,
            disposition: 'rejected',
            evidence: null,
            experience_ids: [],
            retain_ids: [],
            reason,
          };
        }
      }
      throw error;
    }
  }

  /** 受控网关观测；普通 Agent 与 adapted host 都不能调用。 */
  async recordGatewayObservation(
    report: MemoryGatewayObservationReport,
  ): Promise<{ appended: boolean; proof_id: string; reason: string | null }> {
    assertHostProtocolVersion(report.protocol_version);
    assertNoClientTrustClaims(report);
    if (this.policyLevel() !== 'controlled_gateway') {
      throw new BusinessError('PERMISSION_DENIED', '只有受控网关可以记录出站观测', {
        reason: 'gateway_observation_requires_controlled_gateway',
      });
    }
    const binding = await this.requireBridgeBinding({
      bindingId: report.host_binding_id,
      generation: report.host_generation,
      at: this.now(),
    });
    const evidence = deriveGatewayObservationEvidence(
      integrationLevel(binding),
      bindingCapabilities(binding),
    );
    if (!evidence) {
      throw new BusinessError('PERMISSION_DENIED', '当前绑定不允许网关观测证据', {
        reason: 'gateway_observation_unsupported',
      });
    }
    return submitGatewayObservation(this.#db, {
      instanceId: this.#options.instanceId,
      agentId: this.#options.agentId,
      space: this.#options.space,
      report,
      now: this.now(),
    });
  }

  /** 读取清单/回执/网关证据，明确区分 prepared、queued、submitted、observed。 */
  async inputState(manifestId: string): Promise<MemoryInputStateView> {
    const manifest = await getMemoryManifest(this.#db, manifestId);
    if (!manifest) {
      throw new BusinessError('NOT_FOUND', 'manifest 不存在', { manifest_id: manifestId });
    }
    if (
      manifest.space_id !== this.#options.space.space_id ||
      manifest.ownership_epoch !== this.#options.space.ownership_epoch ||
      manifest.agent_actor_id !== this.#options.agentId
    ) {
      throw new BusinessError('PERMISSION_DENIED', 'manifest 不属于当前空间');
    }
    const receipt = await getLatestMemoryReceiptForManifest(this.#db, manifestId);
    const gateway = await hasMemoryGatewayProof(this.#db, manifestId);
    const retain = receipt
      ? await this.#db
          .prepare(
            'SELECT retain_id FROM memory_retain_intents WHERE receipt_id = ? ORDER BY created_at',
          )
          .bind(receipt.receipt_id)
          .all<{ retain_id: string }>()
      : { results: [] as { retain_id: string }[] };
    const queued = this.#queued.get(manifestId);
    const submittedEvidence =
      gateway
        ? 'gateway_observed_submitted'
        : receipt?.evidence === 'host_reported_submitted'
          ? 'host_reported_submitted'
          : null;
    const status: MemoryInputStateView['status'] = submittedEvidence
      ? submittedEvidence
      : queued
        ? 'host_queued'
        : 'prepared';
    return {
      manifest_id: manifest.manifest_id,
      status,
      submitted_evidence: submittedEvidence,
      retain_eligible: submittedEvidence !== null && (retain.results.length > 0),
      retain_ids: retain.results.map((row) => row.retain_id),
      receipt_disposition: receipt?.disposition ?? null,
      receipt_reason: receipt?.reason ?? null,
      manifest_sha256: manifest.manifest_sha256,
      payload_sha256: manifest.payload_sha256,
      created_at: manifest.created_at,
    };
  }

  /** 关闭当前绑定；其他会话/代次不受影响。 */
  async close(input?: {
    binding_id?: string;
    host_generation?: number;
    reason?: 'session_end' | 'run_end' | 'lease_expired' | 'client_closed';
  }): Promise<{ closed: boolean; binding_id: string; generation: number; reason: string }> {
    const at = this.now();
    const row = input?.binding_id
      ? await getMemoryHostBinding(this.#db, input.binding_id)
      : await this.activeBinding();
    if (!row || row.agent_actor_id !== this.#options.agentId) {
      throw new BusinessError('NOT_FOUND', 'HostBinding 不存在', {
        reason: 'host_binding_missing',
      });
    }
    if (row.space_id !== this.#options.space.space_id || row.ownership_epoch !== this.#options.space.ownership_epoch) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'HostBinding 不属于当前空间', {
        reason: 'host_binding_stale',
      });
    }
    if (input?.host_generation !== undefined && input.host_generation !== row.generation) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'HostBinding 代次不匹配', {
        reason: 'host_binding_stale',
      });
    }
    if (row.state !== 'active') {
      return {
        closed: false,
        binding_id: row.binding_id,
        generation: row.generation,
        reason: row.state,
      };
    }
    const result = await this.#db
      .prepare(
        `UPDATE memory_host_bindings
            SET state = 'closed', closed_at = ?, updated_at = ?
          WHERE binding_id = ? AND state = 'active'`,
      )
      .bind(at, at, row.binding_id)
      .run();
    for (const [manifestId, queued] of this.#queued) {
      if (queued.binding_id === row.binding_id) this.#queued.delete(manifestId);
    }
    return {
      closed: result.meta.changes === 1,
      binding_id: row.binding_id,
      generation: row.generation,
      reason: input?.reason ?? 'client_closed',
    };
  }
}

function sameTargetScope(left: MemoryTargetScope, right: MemoryTargetScope): boolean {
  return (
    left.audience === right.audience &&
    left.room_id === right.room_id &&
    left.member_generation === right.member_generation &&
    left.member_seq === right.member_seq &&
    left.policy_revision === right.policy_revision
  );
}


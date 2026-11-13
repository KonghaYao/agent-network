/**
 * MF11：宿主提交证据、经历接纳与受控网关观测。
 *
 * 从 input-manifest.ts 拆出以保持 1000 行上限。所有 evidence 都由服务端按
 * HostBinding 等级派生；本模块不接受客户端自报 verified/trusted。
 */
import { BusinessError } from '../contracts/errors';
import { newId, nowMs, sha256Hex } from '../storage/db';
import {
  getMemoryExperienceByDedupe,
  getMemoryManifest,
  getMemoryReceiptByInvocation,
  type D1Like,
} from '../storage/queries';
import {
  experienceDedupeKey,
  loadRepresentationExact,
} from './experience';
import {
  assertNoClientTrustClaims,
  assertHostProtocolVersion,
  deriveGatewayObservationEvidence,
  deriveHostSubmissionEvidence,
  MEMORY_HOST_PROTOCOL_VERSION,
  type MemoryGatewayObservationReport,
  type MemoryHostExposureAck,
  type MemoryHostExposureReport,
  type MemoryHostFinalManifestReport,
} from './host-protocol';
import {
  bindingCapabilities,
  buildSubmittedInputManifest,
  integrationLevel,
  loadManifestItems,
  parseJson,
  requireHostBinding,
  type MemoryManifestBuildResult,
} from './input-manifest';
import { admitExposureReceipt, runMemoryBatch, type MemoryAdmissionExperience } from './store';
import { requireCurrentMemorySpace } from './access';
import type {
  MemoryByteRange,
  MemoryContextTarget,
  MemoryExactRepresentation,
  MemoryExposureEvidenceKind,
  MemoryExposureReceipt,
  MemoryInvocationIdentity,
  MemoryOriginScope,
  MemoryRepresentation,
  MemorySpaceRef,
} from './contracts';

// ---------------------------------------------------------------------------
// 提交证据与经历接纳
// ---------------------------------------------------------------------------

export interface MemoryRecordExposureInput {
  instanceId: string;
  agentId: string;
  space: MemorySpaceRef;
  hostBindingId: string;
  hostGeneration: number;
  manifestId: string;
  requestId: string;
  submittedAt?: number;
  minimumEvidence?: 'host_reported_submitted' | 'gateway_observed_submitted';
  /** 服务端核实的跨房 grant；MF07 不向客户端转发自报授权。 */
  crossRoomGrant?: import('./contracts').MemoryCrossRoomGrant | null;
  now?: number;
}

function uniqueOriginScopes(scopes: readonly MemoryOriginScope[]): MemoryOriginScope[] {
  const seen = new Set<string>();
  const unique: MemoryOriginScope[] = [];
  for (const scope of scopes) {
    const key = `${scope.room_id}|${scope.member_generation}|${scope.policy_revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(scope);
  }
  return unique;
}

function representationSource(representation: MemoryRepresentation): {
  source_id: string | null;
  source_revision: number | null;
  range: MemoryByteRange | null;
} {
  if (
    representation.kind === 'raw_full' ||
    representation.kind === 'raw_fragment' ||
    representation.kind === 'preview'
  ) {
    return {
      source_id: representation.source_id,
      source_revision: representation.source_revision,
      range: representation.range,
    };
  }
  if (representation.kind === 'authored') {
    return {
      source_id: representation.source_id,
      source_revision: representation.source_revision,
      range: null,
    };
  }
  return { source_id: null, source_revision: null, range: null };
}

async function appendExperienceProofs(
  db: D1Like,
  input: {
    experienceIds: readonly string[];
    proofId: string;
    receiptId: string;
    evidence: MemoryExposureEvidenceKind;
    invocationId: string;
    manifestId: string;
    now: number;
  },
): Promise<void> {
  if (input.experienceIds.length === 0) return;
  const statements = input.experienceIds.map((experienceId) =>
    db
      .prepare(
        `INSERT INTO memory_experience_proofs
           (experience_id, proof_id, receipt_id, evidence, invocation_id, manifest_id, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM memory_experiences WHERE experience_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM memory_experience_proofs
               WHERE experience_id = ? AND proof_id = ?
            )`,
      )
      .bind(
        experienceId,
        input.proofId,
        input.receiptId,
        input.evidence,
        input.invocationId,
        input.manifestId,
        input.now,
        experienceId,
        experienceId,
        input.proofId,
      ),
  );
  await runMemoryBatch(db, statements);
}

/**
 * 记录最终输入提交并原子接纳经历。
 *
 * evidence 由绑定等级派生；调用方不传 evidence。已有的同 invocation 回执
 * 只对账，不重复制造经历；manifest hash/payload hash 不一致直接冲突。
 */
export async function recordHostInputExposure(
  db: D1Like,
  input: MemoryRecordExposureInput,
): Promise<MemoryHostExposureAck> {
  assertNoClientTrustClaims(input);
  const at = input.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: input.agentId,
    instanceId: input.instanceId,
    expected: input.space,
    at,
  });
  const binding = await requireHostBinding(db, {
    bindingId: input.hostBindingId,
    generation: input.hostGeneration,
    space: context.space,
    agentId: input.agentId,
    at,
  });
  const evidence = deriveHostSubmissionEvidence(
    integrationLevel(binding),
    bindingCapabilities(binding),
  );
  if (!evidence) {
    throw new BusinessError('PERMISSION_DENIED', '当前宿主等级不能报告输入提交', {
      reason: 'submission_evidence_unsupported',
    });
  }
  const manifestRow = await getMemoryManifest(db, input.manifestId);
  if (!manifestRow) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 不存在', {
      reason: 'manifest_missing',
    });
  }
  if (
    manifestRow.space_id !== context.space.space_id ||
    manifestRow.ownership_epoch !== context.space.ownership_epoch ||
    manifestRow.agent_actor_id !== input.agentId ||
    manifestRow.host_binding_id !== input.hostBindingId ||
    manifestRow.host_generation !== input.hostGeneration
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 与宿主/空间不匹配', {
      reason: 'manifest_scope_mismatch',
    });
  }
  const invocation: MemoryInvocationIdentity = {
    host_binding_id: manifestRow.host_binding_id ?? '',
    host_generation: manifestRow.host_generation ?? 0,
    session_incarnation: manifestRow.session_incarnation ?? '',
    run_id: manifestRow.run_id ?? '',
    input_id: manifestRow.input_id ?? '',
    input_revision: manifestRow.input_revision ?? 0,
    invocation_id: manifestRow.invocation_id ?? '',
  };
  const target = parseJson<MemoryContextTarget>(manifestRow.target_json);
  if (!target) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 目标损坏', {
      reason: 'manifest_target_corrupt',
    });
  }
  const existingInvocation = await getMemoryReceiptByInvocation(db, {
    kind: 'input_exposure',
    spaceId: context.space.space_id,
    ownershipEpoch: context.space.ownership_epoch,
    agentId: input.agentId,
    hostBindingId: input.hostBindingId,
    invocationId: invocation.invocation_id,
  });
  if (existingInvocation) {
    if (
      existingInvocation.manifest_sha256 !== manifestRow.manifest_sha256 ||
      existingInvocation.payload_sha256 !== manifestRow.payload_sha256
    ) {
      throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一 invocation 已绑定其他输入清单', {
        reason: 'invocation_manifest_conflict',
        receipt_id: existingInvocation.receipt_id,
      });
    }
    return {
      request_id: input.requestId,
      manifest_id: existingInvocation.manifest_id ?? input.manifestId,
      disposition: existingInvocation.disposition,
      evidence,
      experience_ids: [],
      retain_ids: [],
      reason: existingInvocation.reason,
    };
  }

  const itemRows = await loadManifestItems(db, input.manifestId);
  if (itemRows.length === 0) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 没有条目', {
      reason: 'manifest_empty',
    });
  }
  const exacts: MemoryExactRepresentation[] = [];
  const experiences: MemoryAdmissionExperience[] = [];
  const originScopes: MemoryOriginScope[] = [];
  const retain: NonNullable<Parameters<typeof admitExposureReceipt>[1]['retain']>[number][] = [];
  for (const item of itemRows) {
    const exact = await loadRepresentationExact(db, item.representation_id);
    if (!exact) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'manifest 条目表示缺失', {
        reason: 'representation_missing',
        representation_id: item.representation_id,
      });
    }
    if (exact.representation.kind === 'authored') {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'authored 不能作为输入经历', {
        reason: 'authored_not_input',
      });
    }
    const originScope = parseJson<MemoryOriginScope>(item.origin_scope_json);
    if (!originScope) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 条目来源范围损坏', {
        reason: 'origin_scope_corrupt',
      });
    }
    originScopes.push(originScope);
    exacts.push(exact);
    const source = representationSource(exact.representation);
    const experienceId = newId('mexp');
    experiences.push({
      experienceId,
      dedupeKey: experienceDedupeKey({
        spaceId: context.space.space_id,
        ownershipEpoch: context.space.ownership_epoch,
        agentId: input.agentId,
        originRoomId: originScope.room_id,
        memberGeneration: originScope.member_generation,
        originKind: 'experienced',
        representation: exact.representation,
      }),
      key: {
        space_id: context.space.space_id,
        ownership_epoch: context.space.ownership_epoch,
        agent_actor_id: input.agentId,
        origin_room_id: originScope.room_id,
        origin_member_generation: originScope.member_generation,
        source_id: source.source_id,
        source_revision: source.source_revision,
        representation_id: exact.representation.representation_id,
        representation_kind: exact.representation.kind,
        range: source.range,
        text_sha256: exact.representation.text_sha256,
      },
      originKind: 'experienced',
      producerKind: null,
      originRoomId: originScope.room_id,
      capture: 'pending',
    });
    retain.push({
      retainId: newId('mrt'),
      experienceId,
      representationId: exact.representation.representation_id,
      sourceId: source.source_id,
      sourceRevision: source.source_revision,
      originKind: 'experienced',
      evidence,
    });
  }
  const idempotencyKey = `input_exposure:${input.hostBindingId}:${input.requestId}`;
  const receiptKeySha = await sha256Hex(`receipt|${idempotencyKey}`);
  const proofId = `mpf_${await sha256Hex(`input_exposure|${idempotencyKey}|${manifestRow.manifest_sha256}|${evidence}`)}`;
  const receipt: MemoryExposureReceipt = {
    receipt_id: `mrc_${receiptKeySha.slice(0, 32)}`,
    kind: 'input_exposure',
    manifest_id: input.manifestId,
    manifest_sha256: manifestRow.manifest_sha256,
    payload_sha256: manifestRow.payload_sha256,
    invocation,
    space: context.space,
    agent_actor_id: input.agentId,
    origin_scopes: uniqueOriginScopes(originScopes),
    target_scope: target.target_scope,
    evidence,
    proof_id: proofId,
    submitted_at: input.submittedAt ?? at,
    idempotency_key: idempotencyKey,
  };
  try {
    const admission = await admitExposureReceipt(db, {
      instanceId: input.instanceId,
      agentId: input.agentId,
      space: context.space,
      receipt,
      representations: exacts,
      experiences,
      retain,
      minimumEvidence: input.minimumEvidence ?? 'host_reported_submitted',
      crossRoomGrant: input.crossRoomGrant ?? null,
      now: at,
    });
    if (admission.disposition.disposition === 'applied') {
      await appendExperienceProofs(db, {
        experienceIds: admission.experience_ids,
        proofId,
        receiptId: admission.receipt_id,
        evidence,
        invocationId: invocation.invocation_id,
        manifestId: input.manifestId,
        now: at,
      });
    }
    return {
      request_id: input.requestId,
      manifest_id: input.manifestId,
      disposition:
        admission.disposition.disposition === 'applied'
          ? 'applied'
          : admission.disposition.disposition,
      evidence,
      experience_ids: admission.experience_ids,
      retain_ids: admission.retain_ids,
      reason: admission.disposition.reason,
    };
  } catch (error) {
    if (error instanceof BusinessError && error.code === 'IDEMPOTENCY_CONFLICT') {
      const existing = await db
        .prepare(
          `SELECT * FROM memory_receipts WHERE idempotency_key = ? OR (
             kind = 'input_exposure' AND space_id = ? AND ownership_epoch = ?
             AND agent_actor_id = ? AND host_binding_id = ? AND invocation_id = ?
           ) ORDER BY created_at ASC LIMIT 1`,
        )
        .bind(
          idempotencyKey,
          context.space.space_id,
          context.space.ownership_epoch,
          input.agentId,
          input.hostBindingId,
          invocation.invocation_id,
        )
        .first<{ receipt_id: string; manifest_sha256: string | null; payload_sha256: string | null; disposition: string; reason: string | null }>();
      if (
        existing &&
        existing.manifest_sha256 === manifestRow.manifest_sha256 &&
        existing.payload_sha256 === manifestRow.payload_sha256
      ) {
        return {
          request_id: input.requestId,
          manifest_id: input.manifestId,
          disposition: 'duplicate',
          evidence,
          experience_ids: [],
          retain_ids: [],
          reason: existing.reason,
        };
      }
    }
    throw error;
  }
}

/**
 * 追加受控网关观测证明。
 *
 * 不创建新 receipt、不重复经历；只给已接纳的准确经历追加 proof。未先记录
 * host report 的调用返回 `not_recorded`，由 MF07 决定是否先走提交报告。
 */
export async function appendGatewayObservationProof(
  db: D1Like,
  input: {
    instanceId: string;
    agentId: string;
    space: MemorySpaceRef;
    hostBindingId: string;
    hostGeneration: number;
    manifestId: string;
    observedPayloadSha256: string;
    observedAt?: number;
    now?: number;
  },
): Promise<{ appended: boolean; proof_id: string; reason: string | null }> {
  assertNoClientTrustClaims(input);
  const at = input.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: input.agentId,
    instanceId: input.instanceId,
    expected: input.space,
    at,
  });
  const binding = await requireHostBinding(db, {
    bindingId: input.hostBindingId,
    generation: input.hostGeneration,
    space: context.space,
    agentId: input.agentId,
    at,
  });
  const evidence = deriveGatewayObservationEvidence(
    integrationLevel(binding),
    bindingCapabilities(binding),
  );
  if (!evidence) {
    throw new BusinessError('PERMISSION_DENIED', '当前绑定不是受控网关，不能追加观测证明', {
      reason: 'gateway_observation_unsupported',
    });
  }
  const manifestRow = await getMemoryManifest(db, input.manifestId);
  if (
    !manifestRow ||
    manifestRow.space_id !== context.space.space_id ||
    manifestRow.ownership_epoch !== context.space.ownership_epoch ||
    manifestRow.agent_actor_id !== input.agentId ||
    manifestRow.host_binding_id !== input.hostBindingId ||
    manifestRow.payload_sha256 !== input.observedPayloadSha256
  ) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '网关观测与 manifest 不匹配', {
      reason: 'observed_payload_mismatch',
    });
  }
  const itemRows = await loadManifestItems(db, input.manifestId);
  const experienceIds: string[] = [];
  for (const item of itemRows) {
    const exact = await loadRepresentationExact(db, item.representation_id);
    if (!exact) continue;
    const originScope = parseJson<MemoryOriginScope>(item.origin_scope_json);
    if (!originScope) continue;
    const dedupeKey = experienceDedupeKey({
      spaceId: context.space.space_id,
      ownershipEpoch: context.space.ownership_epoch,
      agentId: input.agentId,
      originRoomId: originScope.room_id,
      memberGeneration: originScope.member_generation,
      originKind: 'experienced',
      representation: exact.representation,
    });
    const row = await getMemoryExperienceByDedupe(db, dedupeKey);
    if (row) experienceIds.push(row.experience_id);
  }
  if (experienceIds.length === 0) {
    return { appended: false, proof_id: '', reason: 'not_recorded' };
  }
  const proofId = `mpf_${await sha256Hex(
    `gateway|${input.hostBindingId}|${input.manifestId}|${input.observedPayloadSha256}`,
  )}`;
  const receipt = await getMemoryReceiptByInvocation(db, {
    kind: 'input_exposure',
    spaceId: context.space.space_id,
    ownershipEpoch: context.space.ownership_epoch,
    agentId: input.agentId,
    hostBindingId: input.hostBindingId,
    invocationId: manifestRow.invocation_id ?? '',
  });
  await appendExperienceProofs(db, {
    experienceIds,
    proofId,
    receiptId: receipt?.receipt_id ?? '',
    evidence,
    invocationId: manifestRow.invocation_id ?? '',
    manifestId: input.manifestId,
    now: at,
  });
  return { appended: true, proof_id: proofId, reason: null };
}

// ---------------------------------------------------------------------------
// HostBridge 协议入口（MF07 可直接调用）
// ---------------------------------------------------------------------------

export async function submitHostManifestReport(
  db: D1Like,
  input: {
    instanceId: string;
    agentId: string;
    space: MemorySpaceRef;
    report: MemoryHostFinalManifestReport;
    now?: number;
  },
): Promise<MemoryManifestBuildResult> {
  assertHostProtocolVersion(input.report.protocol_version);
  assertNoClientTrustClaims(input.report);
  return buildSubmittedInputManifest(db, {
    instanceId: input.instanceId,
    agentId: input.agentId,
    space: input.space,
    hostBindingId: input.report.host_binding_id,
    hostGeneration: input.report.host_generation,
    invocation: input.report.invocation,
    target: input.report.target,
    payload: input.report.payload,
    claimedPayloadSha256: input.report.payload_sha256,
    items: input.report.items,
    now: input.now,
  });
}

export async function submitHostExposureReport(
  db: D1Like,
  input: {
    instanceId: string;
    agentId: string;
    space: MemorySpaceRef;
    report: MemoryHostExposureReport;
    now?: number;
  },
): Promise<MemoryHostExposureAck> {
  assertHostProtocolVersion(input.report.protocol_version);
  assertNoClientTrustClaims(input.report);
  return recordHostInputExposure(db, {
    instanceId: input.instanceId,
    agentId: input.agentId,
    space: input.space,
    hostBindingId: input.report.host_binding_id,
    hostGeneration: input.report.host_generation,
    manifestId: input.report.manifest_id,
    requestId: input.report.request_id,
    submittedAt: input.report.submitted_at,
    now: input.now,
  });
}

export async function submitGatewayObservation(
  db: D1Like,
  input: {
    instanceId: string;
    agentId: string;
    space: MemorySpaceRef;
    report: MemoryGatewayObservationReport;
    now?: number;
  },
): Promise<{ appended: boolean; proof_id: string; reason: string | null }> {
  assertHostProtocolVersion(input.report.protocol_version);
  assertNoClientTrustClaims(input.report);
  return appendGatewayObservationProof(db, {
    instanceId: input.instanceId,
    agentId: input.agentId,
    space: input.space,
    hostBindingId: input.report.host_binding_id,
    hostGeneration: input.report.host_generation,
    manifestId: input.report.manifest_id,
    observedPayloadSha256: input.report.observed_payload_sha256,
    observedAt: input.report.observed_at,
    now: input.now,
  });
}

export { MEMORY_HOST_PROTOCOL_VERSION };

/**
 * MF11：最终 SubmittedInputManifest 与宿主提交证据。
 *
 * 职责：
 * - 服务端按准确表示与实际 payload 重建/核对 manifest hash；
 * - 同一 invocation 只能绑定一个 manifest，manifest items 只读；
 * - 提交报告只提供事实，evidence 由 HostBinding 等级派生；
 * - 合格 receipt、经历与 retain 意图复用 MF03 的同事务接纳。
 *
 * 本模块不实现 MCP/UI；MF07 直接调用 submitHostManifestReport /
 * submitHostExposureReport 即可，无需重复定义消息结构。
 */
import { BusinessError } from '../contracts/errors';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  getMemoryHostBinding,
  getMemoryManifest,
  getMemoryManifestByInvocation,
  getMemorySelection,
  listMemoryManifestItems,
  type D1Like,
} from '../storage/queries';
import {
  decodeUtf8Range,
  loadRepresentationExact,
  type MemoryExperienceStoreOptions,
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
  type MemoryHostManifestItemReport,
} from './host-protocol';
import { MEMORY_HOST_CAPABILITIES, type MemoryHostCapability } from './recall-contracts';
import { runMemoryBatch, admitExposureReceipt, type MemoryAdmissionExperience } from './store';
import { requireCurrentMemorySpace } from './access';
import type {
  MemoryByteRange,
  MemoryContextTarget,
  MemoryExactRepresentation,
  MemoryExposureEvidenceKind,
  MemoryExposureReceipt,
  MemoryInvocationIdentity,
  MemoryManifestId,
  MemoryManifestItem,
  MemoryOriginScope,
  MemoryRepresentation,
  MemorySpaceRef,
  MemorySubmittedInputManifest,
  MemoryTargetScope,
} from './contracts';
import type { MemoryHostBindingRow, MemoryManifestRow } from './rows';

const MAX_MANIFEST_ITEMS = 512;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

interface MemoryManifestItemRow {
  manifest_id: string;
  item_index: number;
  selection_id: string | null;
  representation_id: string;
  origin_scope_json: string;
  text_sha256: string;
}

interface MemorySelectionRow {
  selection_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  representation_id: string;
  origin_scope_json: string;
  target_scope_json: string;
  state: 'available' | 'expired';
  issued_at: number;
  expires_at: number | null;
}

export function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
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

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function integrationLevel(
  row: MemoryHostBindingRow,
): 'tool_only' | 'adapted_host' | 'controlled_gateway' {
  return row.trust_level === 'api_tool_only' ? 'tool_only' : row.trust_level;
}

export function bindingCapabilities(row: MemoryHostBindingRow): readonly MemoryHostCapability[] {
  const parsed = parseJson<unknown>(row.declared_capabilities_json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is MemoryHostCapability =>
    typeof item === 'string' && (MEMORY_HOST_CAPABILITIES as readonly string[]).includes(item),
  );
}

export async function requireHostBinding(
  db: D1Like,
  input: {
    bindingId: string;
    generation: number;
    space: MemorySpaceRef;
    agentId: string;
    at: number;
  },
): Promise<MemoryHostBindingRow> {
  const row = await getMemoryHostBinding(db, input.bindingId);
  if (!row) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'HostBinding 不存在', {
      reason: 'host_binding_missing',
    });
  }
  if (row.state !== 'active') {
    throw new BusinessError('PERMISSION_DENIED', 'HostBinding 已关闭或过期', {
      reason: 'host_binding_inactive',
      state: row.state,
    });
  }
  if (row.lease_until !== null && row.lease_until < input.at) {
    throw new BusinessError('PERMISSION_DENIED', 'HostBinding 租约已过期', {
      reason: 'host_binding_lease_expired',
    });
  }
  if (
    row.space_id !== input.space.space_id ||
    row.ownership_epoch !== input.space.ownership_epoch ||
    row.agent_actor_id !== input.agentId ||
    row.generation !== input.generation
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'HostBinding 代次或空间不匹配', {
      reason: 'host_binding_stale',
    });
  }
  return row;
}

function assertTargetMatches(
  input: {
    agentId: string;
    space: MemorySpaceRef;
    hostBindingId: string;
    hostGeneration: number;
    invocation: MemoryInvocationIdentity;
  },
  target: MemoryContextTarget,
): void {
  if (target.agent_actor_id !== input.agentId) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 目标 Agent 不匹配', {
      reason: 'target_agent_mismatch',
    });
  }
  if (
    target.space.space_id !== input.space.space_id ||
    target.space.ownership_epoch !== input.space.ownership_epoch ||
    target.space.backend_binding_epoch !== input.space.backend_binding_epoch
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest 目标空间不匹配', {
      reason: 'target_space_mismatch',
    });
  }
  if (
    target.host_binding_id !== input.hostBindingId ||
    target.host_generation !== input.hostGeneration ||
    target.run_id !== input.invocation.run_id ||
    target.input_id !== input.invocation.input_id ||
    target.input_revision !== input.invocation.input_revision ||
    target.session_incarnation !== input.invocation.session_incarnation ||
    input.invocation.host_binding_id !== input.hostBindingId ||
    input.invocation.host_generation !== input.hostGeneration
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'manifest invocation 与目标不匹配', {
      reason: 'invocation_mismatch',
    });
  }
}

/**
 * 规范化 manifest hash 的输入。
 *
 * 只包含服务端已核实的准确身份与 hash；客户端模板、时间戳或自报字段不参与，
 * 避免同一清单因无关字段产生不同 hash。
 */
function canonicalManifest(input: {
  invocation: MemoryInvocationIdentity;
  target: MemoryContextTarget;
  items: readonly {
    selection_id: string | null;
    representation_id: string;
    representation: MemoryRepresentation;
    origin_scope: MemoryOriginScope;
    text_sha256: string;
  }[];
}): string {
  return stableStringify({
    version: 'mf11.manifest.v1',
    invocation: input.invocation,
    target: {
      kind: input.target.kind,
      agent_actor_id: input.target.agent_actor_id,
      space: input.target.space,
      host_binding_id: input.target.host_binding_id,
      host_generation: input.target.host_generation,
      session_incarnation: input.target.session_incarnation,
      run_id: input.target.run_id,
      input_id: input.target.input_id,
      input_revision: input.target.input_revision,
      target_scope: input.target.target_scope,
      // 访问版本每次查询都会变化；最终清单只绑定目标身份/受众，当前权限在
      // admission 时重新核对，避免无关权限修订把同一 invocation 误判为冲突。
    },
    items: input.items.map((item) => ({
      selection_id: item.selection_id,
      representation_id: item.representation_id,
      kind: item.representation.kind,
      source_id:
        item.representation.kind === 'summary' || item.representation.kind === 'memory_context'
          ? null
          : item.representation.source_id,
      source_revision:
        item.representation.kind === 'summary' || item.representation.kind === 'memory_context'
          ? null
          : item.representation.source_revision,
      range:
        item.representation.kind === 'raw_full' ||
        item.representation.kind === 'raw_fragment' ||
        item.representation.kind === 'preview'
          ? item.representation.range
          : null,
      text_sha256: item.text_sha256,
      origin_scope: item.origin_scope,
    })),
  });
}

export interface MemoryManifestBuildInput {
  instanceId: string;
  agentId: string;
  space: MemorySpaceRef;
  hostBindingId: string;
  hostGeneration: number;
  invocation: MemoryInvocationIdentity;
  target: MemoryContextTarget;
  payload: string;
  claimedPayloadSha256?: string | null;
  items: readonly MemoryHostManifestItemReport[];
  now?: number;
}

export interface MemoryManifestBuildResult {
  manifest: MemorySubmittedInputManifest;
  evidence: MemoryExposureEvidenceKind;
  created: boolean;
}

/**
 * 服务端重建最终清单。
 *
 * `payload` 是宿主实际最终请求；selection 与实际表示必须一致，宿主不能把
 * prepared 清单直接当 submitted。相同 invocation 重复提交相同内容返回原
 * manifest；不同内容返回 IDEMPOTENCY_CONFLICT。
 */
export async function buildSubmittedInputManifest(
  db: D1Like,
  input: MemoryManifestBuildInput,
): Promise<MemoryManifestBuildResult> {
  assertNoClientTrustClaims(input);
  const at = input.now ?? nowMs();
  if (input.items.length === 0) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '最终清单至少需要一个准确表示', {
      reason: 'manifest_empty',
    });
  }
  if (input.items.length > MAX_MANIFEST_ITEMS) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', '最终清单条目过多', {
      limit: MAX_MANIFEST_ITEMS,
    });
  }
  const payloadBytes = utf8Bytes(input.payload);
  if (payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', '最终 payload 超过 Memory 预算', {
      limit: MAX_PAYLOAD_BYTES,
      actual: payloadBytes,
    });
  }
  const actualPayloadSha = await sha256Hex(input.payload);
  if (input.claimedPayloadSha256 && input.claimedPayloadSha256 !== actualPayloadSha) {
    throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'payload hash 与实际上传内容不一致', {
      reason: 'payload_hash_mismatch',
    });
  }
  assertTargetMatches(
    {
      agentId: input.agentId,
      space: input.space,
      hostBindingId: input.hostBindingId,
      hostGeneration: input.hostGeneration,
      invocation: input.invocation,
    },
    input.target,
  );
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
    throw new BusinessError('PERMISSION_DENIED', '当前宿主等级不能报告最终清单', {
      reason: 'final_manifest_report_unsupported',
    });
  }

  const seenSelections = new Set<string>();
  const canonicalItems: Array<{
    selection_id: string | null;
    representation_id: string;
    representation: MemoryRepresentation;
    origin_scope: MemoryOriginScope;
    text_sha256: string;
  }> = [];
  const exacts: MemoryExactRepresentation[] = [];
  for (const item of input.items) {
    if (seenSelections.has(item.selection_id)) {
      throw new BusinessError('MEMORY_TARGET_INVALID', '同一 selection 在清单中重复出现', {
        reason: 'duplicate_selection',
        selection_id: item.selection_id,
      });
    }
    seenSelections.add(item.selection_id);
    const selection = await getMemorySelection(db, item.selection_id);
    if (!selection) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 不存在', {
        reason: 'selection_missing',
        selection_id: item.selection_id,
      });
    }
    if (
      selection.space_id !== context.space.space_id ||
      selection.ownership_epoch !== context.space.ownership_epoch ||
      selection.agent_actor_id !== input.agentId ||
      selection.state !== 'available'
    ) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 空间或状态已失效', {
        reason: 'selection_stale',
        selection_id: item.selection_id,
      });
    }
    if (selection.expires_at !== null && selection.expires_at < at) {
      throw new BusinessError('REQUEST_EXPIRED', 'selection 已过期，需要重新准备输入', {
        selection_id: item.selection_id,
      });
    }
    const selectionTarget = parseJson<MemoryTargetScope>(selection.target_scope_json);
    if (!selectionTarget || !sameTargetScope(selectionTarget, input.target.target_scope)) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 目标受众与最终清单不一致', {
        reason: 'selection_target_mismatch',
        selection_id: item.selection_id,
      });
    }
    if (selection.representation_id !== item.representation_id) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 绑定的表示与清单不一致', {
        reason: 'selection_representation_mismatch',
        selection_id: item.selection_id,
      });
    }
    const exact = await loadRepresentationExact(db, item.representation_id);
    if (!exact || exact.representation.text_sha256 !== item.text_sha256) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '清单项与准确表示不一致', {
        reason: 'representation_mismatch',
        representation_id: item.representation_id,
      });
    }
    if (exact.representation.kind === 'authored') {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'authored 走独立发布记录，不能进入输入清单', {
        reason: 'authored_not_input',
        representation_id: item.representation_id,
      });
    }
    if (item.payload_range) {
      const slice = decodeUtf8Range(input.payload, item.payload_range);
      if (slice === null || slice !== exact.text) {
        throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', 'payload 指定范围不是该准确表示', {
          reason: 'payload_range_mismatch',
          representation_id: item.representation_id,
        });
      }
    } else if (!input.payload.includes(exact.text)) {
      throw new BusinessError('MEMORY_EVIDENCE_INSUFFICIENT', '最终 payload 不包含该准确表示', {
        reason: 'payload_missing_representation',
        representation_id: item.representation_id,
      });
    }
    const originScope = parseJson<MemoryOriginScope>(selection.origin_scope_json);
    if (!originScope) {
      throw new BusinessError('MEMORY_TARGET_INVALID', 'selection 来源范围损坏', {
        reason: 'origin_scope_corrupt',
        selection_id: item.selection_id,
      });
    }
    canonicalItems.push({
      selection_id: item.selection_id,
      representation_id: item.representation_id,
      representation: exact.representation,
      origin_scope: originScope,
      text_sha256: item.text_sha256,
    });
    exacts.push(exact);
  }

  const manifestSha = await sha256Hex(
    canonicalManifest({
      invocation: input.invocation,
      target: input.target,
      items: canonicalItems,
    }),
  );
  const existing = await getMemoryManifestByInvocation(db, {
    spaceId: context.space.space_id,
    ownershipEpoch: context.space.ownership_epoch,
    agentId: input.agentId,
    hostBindingId: input.hostBindingId,
    invocationId: input.invocation.invocation_id,
  });
  if (existing) {
    if (existing.manifest_sha256 !== manifestSha || existing.payload_sha256 !== actualPayloadSha) {
      throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一 invocation 已绑定其他输入清单', {
        reason: 'invocation_manifest_conflict',
        manifest_id: existing.manifest_id,
      });
    }
    const items = await loadManifestItems(db, existing.manifest_id);
    if (items.length !== canonicalItems.length) {
      throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一 manifest hash 的条目集合不一致', {
        manifest_id: existing.manifest_id,
      });
    }
    return {
      manifest: storedManifest(existing, canonicalItems),
      evidence,
      created: false,
    };
  }

  const manifestId = newId('mmf');
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO memory_manifests
           (manifest_id, space_id, ownership_epoch, agent_actor_id, host_binding_id,
            host_generation, session_incarnation, run_id, input_id, input_revision,
            invocation_id, manifest_sha256, payload_sha256, target_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        manifestId,
        context.space.space_id,
        context.space.ownership_epoch,
        input.agentId,
        input.hostBindingId,
        input.hostGeneration,
        input.invocation.session_incarnation,
        input.invocation.run_id,
        input.invocation.input_id,
        input.invocation.input_revision,
        input.invocation.invocation_id,
        manifestSha,
        actualPayloadSha,
        JSON.stringify(input.target),
        at,
      ),
  ];
  canonicalItems.forEach((item, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_manifest_items
             (manifest_id, item_index, selection_id, representation_id,
              origin_scope_json, text_sha256)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          manifestId,
          index,
          item.selection_id,
          item.representation_id,
          JSON.stringify(item.origin_scope),
          item.text_sha256,
        ),
    );
  });
  try {
    await runMemoryBatch(db, statements);
  } catch (error) {
    // 并发同 invocation 写入由唯一索引兜底；只对账同一内容，不覆盖其他清单。
    const raced = await getMemoryManifestByInvocation(db, {
      spaceId: context.space.space_id,
      ownershipEpoch: context.space.ownership_epoch,
      agentId: input.agentId,
      hostBindingId: input.hostBindingId,
      invocationId: input.invocation.invocation_id,
    });
    if (raced && raced.manifest_sha256 === manifestSha && raced.payload_sha256 === actualPayloadSha) {
      return {
        manifest: storedManifest(raced, canonicalItems),
        evidence,
        created: false,
      };
    }
    throw error;
  }
  const stored = await getMemoryManifest(db, manifestId);
  if (!stored) {
    throw new BusinessError('MEMORY_UNAVAILABLE', 'manifest 写入后无法读取');
  }
  return {
    manifest: storedManifest(stored, canonicalItems),
    evidence,
    created: true,
  };
}

function storedManifest(
  row: MemoryManifestRow,
  items: readonly {
    selection_id: string | null;
    representation_id: string;
    representation: MemoryRepresentation;
    origin_scope: MemoryOriginScope;
    text_sha256: string;
  }[],
): MemorySubmittedInputManifest {
  const target = parseJson<MemoryContextTarget>(row.target_json);
  if (!target) {
    throw new BusinessError('MEMORY_UNAVAILABLE', 'manifest 目标损坏', {
      manifest_id: row.manifest_id,
    });
  }
  const manifestItems: MemoryManifestItem[] = items.map((item) => ({
    selection_id: item.selection_id,
    representation: item.representation,
    origin_scope: item.origin_scope,
  }));
  return {
    manifest_id: row.manifest_id,
    manifest_sha256: row.manifest_sha256,
    payload_sha256: row.payload_sha256,
    invocation: {
      host_binding_id: row.host_binding_id ?? '',
      host_generation: row.host_generation ?? 0,
      session_incarnation: row.session_incarnation ?? '',
      run_id: row.run_id ?? '',
      input_id: row.input_id ?? '',
      input_revision: row.input_revision ?? 0,
      invocation_id: row.invocation_id ?? '',
    },
    target,
    items: manifestItems,
    created_at: row.created_at,
  };
}

export async function loadManifestItems(
  db: D1Like,
  manifestId: string,
): Promise<readonly MemoryManifestItemRow[]> {
  const rows = await listMemoryManifestItems(db, manifestId);
  return rows;
}

export async function loadSubmittedInputManifest(
  db: D1Like,
  options: {
    agentId: string;
    space: MemorySpaceRef;
    manifestId: string;
  },
): Promise<MemorySubmittedInputManifest | null> {
  const row = await getMemoryManifest(db, options.manifestId);
  if (!row) return null;
  if (
    row.space_id !== options.space.space_id ||
    row.ownership_epoch !== options.space.ownership_epoch ||
    row.agent_actor_id !== options.agentId
  ) {
    return null;
  }
  const items = await loadManifestItems(db, options.manifestId);
  const canonicalItems = [];
  for (const item of items) {
    const exact = await loadRepresentationExact(db, item.representation_id);
    if (!exact) return null;
    const originScope = parseJson<MemoryOriginScope>(item.origin_scope_json);
    if (!originScope) return null;
    canonicalItems.push({
      selection_id: item.selection_id,
      representation_id: item.representation_id,
      representation: exact.representation,
      origin_scope: originScope,
      text_sha256: item.text_sha256,
    });
  }
  return storedManifest(row, canonicalItems);
}


/**
 * Adapter 入参校验（MF01 契约，MF10 两个适配器共用）。
 *
 * 这些规则只判断服务端构造的请求是否自洽，不判断授权、归属或披露；两个适配
 * 器必须对同一输入给出同一“接受/拒绝”结论，避免弱适配器放宽精确表示要求。
 */
import {
  isValidByteRange,
  MEMORY_EXPOSURE_EVIDENCE_KINDS,
  MEMORY_ORIGIN_KINDS,
  MEMORY_PRODUCER_KINDS,
  MEMORY_REPRESENTATION_KINDS,
  type MemoryExposureEvidenceKind,
  type MemoryOriginKind,
  type MemoryRepresentation,
  type MemoryRepresentationKind,
  type MemorySourceDependency,
  type MemorySourceRef,
  type MemorySpaceRef,
} from '../contracts';
import type { MemoryAdapterRetainItem } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function validEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validSourceRef(value: unknown): value is MemorySourceRef {
  return (
    isRecord(value) &&
    nonEmptyString(value.source_id) &&
    typeof value.source_revision === 'number' &&
    Number.isSafeInteger(value.source_revision) &&
    value.source_revision >= 1
  );
}

export function validSpaceRef(value: unknown): value is MemorySpaceRef {
  return (
    isRecord(value) &&
    nonEmptyString(value.space_id) &&
    validEpoch(value.ownership_epoch) &&
    validEpoch(value.backend_binding_epoch)
  );
}

export function isHex64(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value);
}

export function isOriginKind(value: unknown): value is MemoryOriginKind {
  return typeof value === 'string' && (MEMORY_ORIGIN_KINDS as readonly string[]).includes(value);
}

export function isRepresentationKind(value: unknown): value is MemoryRepresentationKind {
  return (
    typeof value === 'string' &&
    (MEMORY_REPRESENTATION_KINDS as readonly string[]).includes(value)
  );
}

export function isEvidenceKind(value: unknown): value is MemoryExposureEvidenceKind {
  return (
    typeof value === 'string' &&
    (MEMORY_EXPOSURE_EVIDENCE_KINDS as readonly string[]).includes(value)
  );
}

export function isProducerKind(value: unknown): boolean {
  return typeof value === 'string' && (MEMORY_PRODUCER_KINDS as readonly string[]).includes(value);
}

export const RAW_REPRESENTATION_KINDS = new Set<MemoryRepresentationKind>([
  'raw_full',
  'raw_fragment',
  'preview',
]);

export function validRetainEnvelope(input: {
  space: unknown;
  operation_key: unknown;
  payload_sha256: unknown;
  items: unknown;
}): boolean {
  return (
    validSpaceRef(input.space) &&
    nonEmptyString(input.operation_key) &&
    isHex64(input.payload_sha256) &&
    Array.isArray(input.items) &&
    input.items.length > 0
  );
}

/** 表示自身字段必须自洽；准确性由文本 hash/字节数另行核对。 */
export function validRepresentationShape(representation: MemoryRepresentation): boolean {
  switch (representation.kind) {
    case 'raw_full':
    case 'raw_fragment':
    case 'preview':
      return (
        nonEmptyString(representation.source_id) &&
        Number.isSafeInteger(representation.source_revision) &&
        representation.source_revision >= 1 &&
        isValidByteRange(representation.range, representation.text_bytes)
      );
    case 'summary':
      return (
        nonEmptyString(representation.summary_id) &&
        Number.isSafeInteger(representation.revision) &&
        representation.revision >= 1
      );
    case 'memory_context':
      return nonEmptyString(representation.source_context_id);
    case 'authored':
      return (
        nonEmptyString(representation.source_id) &&
        Number.isSafeInteger(representation.source_revision) &&
        representation.source_revision >= 1 &&
        isProducerKind(representation.producer_kind) &&
        (representation.lineage === 'run_bound' ||
          representation.lineage === 'lineage_unknown')
      );
  }
}

/** 资格类别与 origin_kind 必须一致；prepare/claim 等准备状态不能冒充证据。 */
export function validEligibility(item: MemoryAdapterRetainItem): boolean {
  const eligibility = item.eligibility;
  if (!eligibility || typeof eligibility !== 'object') return false;
  switch (eligibility.kind) {
    case 'experienced':
      return (
        item.origin_kind === 'experienced' &&
        isEvidenceKind(eligibility.evidence) &&
        nonEmptyString(eligibility.receipt_id) &&
        nonEmptyString(eligibility.proof_id)
      );
    case 'authored':
      return (
        item.origin_kind === 'authored' &&
        isProducerKind(eligibility.producer_kind) &&
        nonEmptyString(eligibility.experience_id)
      );
    case 'curated':
      return (
        item.origin_kind === 'curated' &&
        nonEmptyString(eligibility.curated_id) &&
        Number.isSafeInteger(eligibility.revision) &&
        eligibility.revision >= 1
      );
    default:
      return false;
  }
}

export function validDependency(value: unknown): value is MemorySourceDependency {
  if (!isRecord(value) || !validSourceRef(value)) return false;
  const representationId = value.representation_id;
  if (representationId !== null && !nonEmptyString(representationId)) return false;
  const range = value.range;
  if (range !== null) {
    if (!isRecord(range)) return false;
    if (
      typeof range.start !== 'number' ||
      typeof range.end !== 'number' ||
      !isValidByteRange({ start: range.start, end: range.end }, Number.MAX_SAFE_INTEGER)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 校验一项 retain 的静态形状，并返回可持久化的主来源；null 表示请求非法。
 *
 * 文本 hash/字节数由调用方用同步或异步 hash 再核对；本函数不访问后端。
 * `source: null` 表示该项没有可声明的来源（例如无依赖的人工摘要）。
 */
export function validateRetainItem(
  item: MemoryAdapterRetainItem,
): { source: MemorySourceRef | null } | null {
  if (!item || !isRecord(item)) return null;
  const representation = item.representation?.representation;
  const text = item.representation?.text;
  if (!representation || typeof text !== 'string' || text.length === 0) return null;
  if (!isRepresentationKind(representation.kind)) return null;
  if (!nonEmptyString(representation.representation_id)) return null;
  if (!validRepresentationShape(representation)) return null;
  if (!isOriginKind(item.origin_kind)) return null;
  if (!validEligibility(item)) return null;
  if (item.source !== null && !validSourceRef(item.source)) return null;
  if (!Array.isArray(representation.depends_on) || !representation.depends_on.every(validDependency)) {
    return null;
  }

  const rawSource: MemorySourceRef | null =
    'source_id' in representation && typeof representation.source_id === 'string'
      ? {
          source_id: representation.source_id,
          source_revision:
            'source_revision' in representation &&
            typeof representation.source_revision === 'number'
              ? representation.source_revision
              : 0,
        }
      : null;
  if (item.source && rawSource) {
    if (
      item.source.source_id !== rawSource.source_id ||
      item.source.source_revision !== rawSource.source_revision
    ) {
      return null;
    }
  }
  return {
    source: item.source ?? rawSource ?? representation.depends_on[0] ?? null,
  };
}

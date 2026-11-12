/**
 * retain 请求构造：只接受已接纳的准确表示与资格，绝不按 source_id 扩抓原文。
 */
import { sha256Hex, utf8Bytes } from '../../storage/db';
import {
  isValidByteRange,
  type MemoryRepresentation,
  type MemorySourceDependency,
  type MemorySourceRef,
  type MemorySpaceRef,
} from '../contracts';
import type { MemoryAdapterRetainItem } from './types';
import {
  ORIGIN_TAG,
  RAW_KINDS,
  anchorTag,
  curatedRevisionTag,
  curatedTag,
  dependencyTags,
  documentIdFor,
  isEvidenceKind,
  isHex64,
  isOriginKind,
  isProducerKind,
  isRecord,
  isRepresentationKind,
  nonEmptyString,
  partitionTag,
  sourceRevisionTag,
  sourceTag,
  validSourceRef,
  validSpaceRef,
} from './hindsight-tags';

export type PrepareRetainResult = { items: Record<string, unknown>[] } | { error: true };

export async function prepareRetainItems(
  space: MemorySpaceRef,
  items: readonly MemoryAdapterRetainItem[],
): Promise<PrepareRetainResult> {
  const prepared: Record<string, unknown>[] = [];
  for (const item of items) {
    const built = await buildRetainItem(space, item);
    if (!built) return { error: true };
    prepared.push(built);
  }
  return { items: prepared };
}

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

async function buildRetainItem(
  space: MemorySpaceRef,
  item: MemoryAdapterRetainItem,
): Promise<Record<string, unknown> | null> {
  if (!item || !isRecord(item)) return null;
  const representation = item.representation?.representation;
  const text = item.representation?.text;
  if (!representation || typeof text !== 'string' || text.length === 0) return null;
  if (!isRepresentationKind(representation.kind)) return null;
  if (!nonEmptyString(representation.representation_id)) return null;
  if (representation.text_bytes !== utf8Bytes(text)) return null;
  if (representation.text_sha256 !== (await sha256Hex(text))) return null;
  if (!isOriginKind(item.origin_kind)) return null;
  if (!validRepresentationShape(representation)) return null;
  if (!validEligibility(item)) return null;
  if (item.source !== null && !validSourceRef(item.source)) return null;

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
  const dependencies = Array.isArray(representation.depends_on)
    ? representation.depends_on
    : [];
  if (!dependencies.every(validDependency)) return null;

  const primarySource: MemorySourceRef | null =
    item.source ?? rawSource ?? dependencies[0] ?? null;

  const tags = new Set<string>();
  tags.add(`${ORIGIN_TAG}${item.origin_kind}`);
  tags.add(await anchorTag(representation.representation_id));
  if (primarySource) {
    tags.add(await sourceTag(primarySource.source_id));
    tags.add(await sourceRevisionTag(primarySource.source_id, primarySource.source_revision));
  }
  for (const tag of await dependencyTags(dependencies)) tags.add(tag);
  if (item.eligibility.kind === 'curated') {
    tags.add(await curatedTag(item.eligibility.curated_id));
    tags.add(await curatedRevisionTag(item.eligibility.curated_id, item.eligibility.revision));
  }
  if (representation.kind === 'summary' && representation.partition_proof) {
    tags.add(
      await partitionTag(
        representation.partition_proof.partition_id,
        representation.partition_proof.generation,
      ),
    );
  }

  const metadata: Record<string, string> = {
    agentnet_origin_kind: item.origin_kind,
    agentnet_representation_id: representation.representation_id,
    agentnet_representation_kind: representation.kind,
    agentnet_text_sha256: representation.text_sha256,
    agentnet_eligibility_kind: item.eligibility.kind,
  };
  if (primarySource) {
    metadata.agentnet_source_id = primarySource.source_id;
    metadata.agentnet_source_revision = String(primarySource.source_revision);
  }
  if (dependencies.length > 0) {
    metadata.agentnet_dependencies = JSON.stringify(
      dependencies.map((dependency) => [dependency.source_id, dependency.source_revision]),
    );
  }
  if (item.eligibility.kind === 'experienced') {
    metadata.agentnet_evidence_kind = item.eligibility.evidence;
  }
  if (item.eligibility.kind === 'curated') {
    metadata.agentnet_curated_id = item.eligibility.curated_id;
    metadata.agentnet_curated_revision = String(item.eligibility.revision);
  }
  if ('range' in representation && representation.range) {
    metadata.agentnet_range_start = String(representation.range.start);
    metadata.agentnet_range_end = String(representation.range.end);
  }
  if (representation.kind === 'summary' && representation.partition_proof) {
    metadata.agentnet_partition_id = representation.partition_proof.partition_id;
    metadata.agentnet_partition_generation = String(
      representation.partition_proof.generation,
    );
  }

  // observation scope 只允许同 origin + source revision 或同表示内汇总。
  const scope: string[] = [`${ORIGIN_TAG}${item.origin_kind}`];
  if (RAW_KINDS.has(representation.kind) && primarySource) {
    scope.push(await sourceTag(primarySource.source_id));
    scope.push(await sourceRevisionTag(primarySource.source_id, primarySource.source_revision));
  } else if (item.eligibility.kind === 'curated') {
    scope.push(await curatedTag(item.eligibility.curated_id));
  } else if (representation.kind === 'summary' && representation.partition_proof) {
    scope.push(
      await partitionTag(
        representation.partition_proof.partition_id,
        representation.partition_proof.generation,
      ),
    );
  } else {
    scope.push(await anchorTag(representation.representation_id));
  }

  const documentKey =
    item.eligibility.kind === 'curated'
      ? `curated:${item.eligibility.curated_id}:${item.eligibility.revision}`
      : `representation:${primarySource?.source_id ?? 'none'}:${primarySource?.source_revision ?? 0}:${representation.representation_id}:${'range' in representation && representation.range ? `${representation.range.start}-${representation.range.end}` : '-'}`;
  const documentId = await documentIdFor(space, documentKey);

  return {
    content: text,
    context: `agentnet ${item.origin_kind} ${representation.kind}`,
    document_id: documentId,
    update_mode: 'replace',
    tags: [...tags],
    metadata,
    observation_scopes: [scope],
  };
}

function validRepresentationShape(representation: MemoryRepresentation): boolean {
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

function validEligibility(item: MemoryAdapterRetainItem): boolean {
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

function validDependency(value: unknown): value is MemorySourceDependency {
  if (!isRecord(value) || !validSourceRef(value)) return false;
  const representationId = value.representation_id;
  if (representationId !== null && !nonEmptyString(representationId)) return false;
  const range = value.range;
  if (range !== null) {
    if (!isRecord(range)) return false;
    if (
      typeof range.start !== 'number' ||
      typeof range.end !== 'number' ||
      !isValidByteRange(
        { start: range.start, end: range.end },
        Number.MAX_SAFE_INTEGER,
      )
    ) {
      return false;
    }
  }
  return true;
}

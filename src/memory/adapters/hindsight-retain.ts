/**
 * retain 请求构造：只接受已接纳的准确表示与资格，绝不按 source_id 扩抓原文。
 */
import { sha256Hex, utf8Bytes } from '../../storage/db';
import type {
  MemorySourceRef,
  MemorySpaceRef,
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
  partitionTag,
  sourceRevisionTag,
  sourceTag,
} from './hindsight-tags';
import { validateRetainItem, validRetainEnvelope } from './validation';

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

export { validRetainEnvelope };

async function buildRetainItem(
  space: MemorySpaceRef,
  item: MemoryAdapterRetainItem,
): Promise<Record<string, unknown> | null> {
  const validated = validateRetainItem(item);
  if (!validated) return null;
  const representation = item.representation.representation;
  const text = item.representation.text;
  if (representation.text_bytes !== utf8Bytes(text)) return null;
  if (representation.text_sha256 !== (await sha256Hex(text))) return null;

  const primarySource: MemorySourceRef | null = validated.source;
  const dependencies = representation.depends_on;

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

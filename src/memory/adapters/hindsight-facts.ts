/**
 * Hindsight fact -> Memory Source/Projection 映射。
 *
 * Hindsight 的 recall/list 返回的是抽取后的 fact，不保证是原表示。只有返回
 * 文本 hash 与 retain 时保存的准确 hash 一致时才映射为 raw（verbatim）；否则
 * 一律标为 summary，不能假装来源完整。
 */
import { sha256Hex, utf8Bytes } from '../../storage/db';
import type {
  MemoryBackendRef,
  MemoryRepresentation,
  MemorySourceRef,
  MemorySpaceRef,
} from '../contracts';
import type { MemoryAdapterSearchHit } from './types';
import {
  RAW_KINDS,
  isEvidenceKind,
  isOriginKind,
  isRecord,
  isRepresentationKind,
  metadataValue,
  nonEmptyString,
  parseDependencies,
  stringArray,
} from './hindsight-tags';

export type MapFactResult =
  | { hit: MemoryAdapterSearchHit }
  | { reason: 'source_incomplete' };

export async function mapFact(fact: unknown, space: MemorySpaceRef): Promise<MapFactResult> {
  if (!isRecord(fact) || !nonEmptyString(fact.id) || !nonEmptyString(fact.text)) {
    return { reason: 'source_incomplete' };
  }
  const text = fact.text;
  const metadata = isRecord(fact.metadata) ? fact.metadata : null;
  const tags = stringArray(fact.tags);
  const originValue =
    metadataValue(metadata, 'agentnet_origin_kind') ??
    tags
      .find((tag) => tag.startsWith('agentnet:o:'))
      ?.slice('agentnet:o:'.length) ??
    null;
  if (!isOriginKind(originValue)) return { reason: 'source_incomplete' };

  const dependencies = parseDependencies(metadataValue(metadata, 'agentnet_dependencies'));
  const primarySourceId = metadataValue(metadata, 'agentnet_source_id');
  const primaryRevision = Number(metadataValue(metadata, 'agentnet_source_revision'));
  const source: MemorySourceRef | null =
    primarySourceId && Number.isSafeInteger(primaryRevision) && primaryRevision >= 1
      ? { source_id: primarySourceId, source_revision: primaryRevision }
      : dependencies[0] ?? null;
  const evidenceValue = metadataValue(metadata, 'agentnet_evidence_kind');
  const evidence = isEvidenceKind(evidenceValue) ? evidenceValue : null;
  const representationKind = metadataValue(metadata, 'agentnet_representation_kind');
  const textSha256 = await sha256Hex(text);
  const exactHash = metadataValue(metadata, 'agentnet_text_sha256');
  const rangeStart = Number(metadataValue(metadata, 'agentnet_range_start'));
  const rangeEnd = Number(metadataValue(metadata, 'agentnet_range_end'));
  const range =
    Number.isSafeInteger(rangeStart) && Number.isSafeInteger(rangeEnd) && rangeEnd > rangeStart
      ? { start: rangeStart, end: rangeEnd }
      : null;

  let representation: MemoryRepresentation;
  if (
    isRepresentationKind(representationKind) &&
    RAW_KINDS.has(representationKind) &&
    source !== null &&
    range !== null &&
    exactHash === textSha256
  ) {
    representation = {
      representation_id: fact.id,
      kind: representationKind as 'raw_full' | 'raw_fragment' | 'preview',
      text_bytes: utf8Bytes(text),
      text_sha256: textSha256,
      verbatim: true,
      source_id: source.source_id,
      source_revision: source.source_revision,
      range,
      depends_on: dependencies,
    };
  } else {
    representation = {
      representation_id: fact.id,
      kind: 'summary',
      text_bytes: utf8Bytes(text),
      text_sha256: textSha256,
      verbatim: false,
      summary_id: fact.id,
      revision: 1,
      depends_on: dependencies,
      partition_proof: null,
    };
  }

  const documentId = nonEmptyString(fact.document_id) ? fact.document_id : null;
  const chunkId = nonEmptyString(fact.chunk_id) ? fact.chunk_id : null;
  const backendRef: MemoryBackendRef = {
    space,
    provider_id: fact.id,
    provider_revision: documentId ?? chunkId ?? 'hindsight',
  };
  return {
    hit: {
      backend_ref: backendRef,
      representation,
      source,
      origin_kind: originValue,
      evidence,
      score: scoreOf(fact.scores),
    },
  };
}

function scoreOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  if (typeof value.final === 'number' && Number.isFinite(value.final)) return value.final;
  if (typeof value.reranker === 'number' && Number.isFinite(value.reranker)) {
    return value.reranker;
  }
  return null;
}

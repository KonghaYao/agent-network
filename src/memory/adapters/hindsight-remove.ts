/**
 * remove：把 source revision / representation / curated 目标解析为文档标签集，
 * 删除后重新列出确认消失。DELETE 2xx 本身不是清除证据。
 */
import { isValidByteRange, type MemoryByteRange } from '../contracts';
import type { MemoryAdapterFailureReason, RemoveRequest, RemoveResult } from './types';
import {
  anchorTag,
  curatedRevisionTag,
  curatedTag,
  dependencyRevisionTag,
  dependencyTag,
  isHex64,
  isRecord,
  nonEmptyString,
  sourceRevisionTag,
  sourceTag,
  validSourceRef,
  validSpaceRef,
} from './hindsight-tags';
import type { HindsightTransport, HttpOutcome } from './hindsight-transport';

const MAX_LIST_PAGES = 1000;

export type PrepareRemoveResult =
  | { tagSets: string[][] }
  | { error: 'unsupported' | 'invalid_request' };

export async function prepareRemove(request: RemoveRequest): Promise<PrepareRemoveResult> {
  if (
    !validSpaceRef(request.space) ||
    !nonEmptyString(request.operation_key) ||
    !isHex64(request.payload_sha256) ||
    !Array.isArray(request.targets) ||
    request.targets.length === 0
  ) {
    return { error: 'invalid_request' };
  }
  const tagSets: string[][] = [];
  for (const target of request.targets) {
    if (!isRecord(target)) return { error: 'unsupported' };
    switch (target.kind) {
      case 'representation': {
        if (!validSourceRef(target.source) || !nonEmptyString(target.representation_id)) {
          return { error: 'invalid_request' };
        }
        if (
          target.range !== null &&
          !isValidByteRange(target.range as MemoryByteRange, Number.MAX_SAFE_INTEGER)
        ) {
          return { error: 'invalid_request' };
        }
        tagSets.push([
          await sourceTag(target.source.source_id),
          await sourceRevisionTag(target.source.source_id, target.source.source_revision),
          await anchorTag(target.representation_id),
        ]);
        break;
      }
      case 'source_revision': {
        if (!validSourceRef(target.source)) return { error: 'invalid_request' };
        tagSets.push([
          await sourceTag(target.source.source_id),
          await sourceRevisionTag(target.source.source_id, target.source.source_revision),
        ]);
        tagSets.push([
          await dependencyTag(target.source.source_id),
          await dependencyRevisionTag(target.source.source_id, target.source.source_revision),
        ]);
        break;
      }
      case 'curated': {
        const curatedId = target.curated_id;
        const revision = target.revision;
        if (
          !nonEmptyString(curatedId) ||
          typeof revision !== 'number' ||
          !Number.isSafeInteger(revision) ||
          revision < 1
        ) {
          return { error: 'invalid_request' };
        }
        tagSets.push([
          await curatedTag(curatedId),
          await curatedRevisionTag(curatedId, revision),
        ]);
        break;
      }
      case 'partition':
        // 当前路由以 space + binding epoch 为分区，不接受无法证明范围的外部 partition id。
        return { error: 'unsupported' };
      default:
        return { error: 'unsupported' };
    }
  }
  const deduped = new Map<string, string[]>();
  for (const tags of tagSets) {
    if (tags.length === 0) return { error: 'invalid_request' };
    deduped.set(tags.join('\u0000'), tags);
  }
  return { tagSets: [...deduped.values()] };
}

export async function removeDocuments(
  transport: HindsightTransport,
  bankId: string,
  tagSets: readonly string[][],
  deadlineAt: number | null,
): Promise<RemoveResult> {
  const listed = await listDocumentIdsForTagSets(transport, bankId, tagSets, deadlineAt);
  if (!listed.ok) {
    if (listed.outcome.kind === 'http' && listed.outcome.status === 404) {
      return { status: 'accepted', purge: 'purged', job_ref: null, reason: null };
    }
    return {
      status: 'unavailable',
      purge: 'unknown',
      job_ref: null,
      reason: transport.reasonFor(listed.outcome, 'unknown'),
    };
  }

  let deleted = 0;
  let deleteFailed = false;
  let lastFailure: MemoryAdapterFailureReason = 'unknown';
  for (const documentId of listed.ids) {
    const outcome = await transport.request(
      'DELETE',
      `/v1/default/banks/${encodeURIComponent(bankId)}/documents/${encodeURIComponent(documentId)}`,
      { deadlineAt, retry: true },
    );
    if (outcome.kind === 'ok' || (outcome.kind === 'http' && outcome.status === 404)) {
      deleted += 1;
      continue;
    }
    deleteFailed = true;
    lastFailure = transport.reasonFor(outcome, 'unknown');
    break;
  }

  const verified = await listDocumentIdsForTagSets(transport, bankId, tagSets, deadlineAt);
  if (!verified.ok) {
    return {
      status: 'unavailable',
      purge: deleted > 0 ? 'purge_pending' : 'unknown',
      job_ref: null,
      reason: transport.reasonFor(verified.outcome, lastFailure),
    };
  }
  if (verified.ids.length > 0) {
    return {
      status: 'unavailable',
      purge: 'purge_pending',
      job_ref: null,
      reason: deleteFailed ? lastFailure : 'unknown',
    };
  }
  if (deleteFailed) {
    return {
      status: 'unavailable',
      purge: deleted > 0 ? 'purge_pending' : 'unknown',
      job_ref: null,
      reason: lastFailure,
    };
  }
  return { status: 'accepted', purge: 'purged', job_ref: null, reason: null };
}

async function listDocumentIdsForTagSets(
  transport: HindsightTransport,
  bankId: string,
  tagSets: readonly string[][],
  deadlineAt: number | null,
): Promise<{ ok: true; ids: string[] } | { ok: false; outcome: HttpOutcome }> {
  const ids = new Set<string>();
  for (const tags of tagSets) {
    const listed = await listDocumentIds(transport, bankId, tags, deadlineAt);
    if (!listed.ok) return listed;
    for (const id of listed.ids) ids.add(id);
  }
  return { ok: true, ids: [...ids] };
}

async function listDocumentIds(
  transport: HindsightTransport,
  bankId: string,
  tags: readonly string[],
  deadlineAt: number | null,
): Promise<{ ok: true; ids: string[] } | { ok: false; outcome: HttpOutcome }> {
  const pageSize = transport.config.listPageSize;
  const ids: string[] = [];
  let offset = 0;
  let total: number | null = null;
  let totalIsEstimate = false;
  let effectivePageSize = pageSize;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const params = new URLSearchParams();
    for (const tag of tags) params.append('tags', tag);
    params.set('tags_match', 'all_strict');
    params.set('limit', String(pageSize));
    params.set('offset', String(offset));
    const outcome = await transport.request(
      'GET',
      `/v1/default/banks/${encodeURIComponent(bankId)}/documents?${params.toString()}`,
      { deadlineAt, retry: true },
    );
    if (outcome.kind === 'http' && outcome.status === 404) {
      // bank 不存在等价于没有可清除文档；仍需其它目标确认。
      return { ok: true, ids };
    }
    if (outcome.kind !== 'ok' || !isRecord(outcome.body) || !Array.isArray(outcome.body.items)) {
      return { ok: false, outcome };
    }
    const items = outcome.body.items;
    for (const item of items) {
      if (isRecord(item) && nonEmptyString(item.id)) ids.push(item.id);
    }
    offset += items.length;
    if (typeof outcome.body.total === 'number' && Number.isSafeInteger(outcome.body.total)) {
      total = outcome.body.total;
    }
    if (
      typeof outcome.body.limit === 'number' &&
      Number.isSafeInteger(outcome.body.limit) &&
      outcome.body.limit > 0
    ) {
      effectivePageSize = outcome.body.limit;
    }
    // 真实 API 的 documents.total 可能是估算值；估算时不能据此提前结束分页。
    if (outcome.body.total_is_estimate === true) totalIsEstimate = true;
    if (items.length === 0) return { ok: true, ids };
    if (!totalIsEstimate && total !== null && offset >= total) return { ok: true, ids };
    if ((totalIsEstimate || total === null) && items.length < effectivePageSize) {
      return { ok: true, ids };
    }
  }
  return { ok: false, outcome: { kind: 'parse' } };
}

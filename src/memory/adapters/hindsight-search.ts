/**
 * search 映射：有 query 时走 recall（单次 top-K）；无 query 时走 memories/list
 * 分页并本地校验硬过滤。Hindsight 的时间窗口只排序，因此任何时间过滤都返回
 * unsupported，不静默降级。
 */
import type { MemoryOriginKind, MemorySpaceRef } from '../contracts';
import type {
  MemoryAdapterFailureReason,
  MemoryAdapterSearchExclusion,
  MemoryAdapterSearchHit,
  MemoryAdapterSearchPlan,
  SearchResult,
} from './types';
import { mapFact } from './hindsight-facts';
import { isOriginKind, isRecord, nonEmptyString, sourceTag } from './hindsight-tags';
import type { HindsightTransport } from './hindsight-transport';

export interface SearchFilterPlan {
  originKinds: readonly MemoryOriginKind[];
  sourceIds: readonly string[];
}

const MAX_LIST_PAGES = 1000;
const MAX_RECALL_TOKENS = 8192;

export function unsupportedSearchFilter(plan: MemoryAdapterSearchPlan): boolean {
  const filters = plan.hard_filters;
  if (!filters) return true;
  if ((filters.source_kinds?.length ?? 0) > 0) return true;
  if ((filters.room_ids?.length ?? 0) > 0) return true;
  if (
    filters.time_field !== undefined ||
    filters.time_from !== undefined ||
    filters.time_to !== undefined ||
    filters.timezone !== undefined
  ) {
    // Hindsight temporal_window 只影响排序，不能冒充硬时间过滤。
    return true;
  }
  if ((filters.origin_kinds ?? []).some((kind) => !isOriginKind(kind))) return true;
  if ((filters.source_ids ?? []).some((id) => !nonEmptyString(id))) return true;
  if (!Number.isSafeInteger(plan.candidate_limit) || plan.candidate_limit < 1) return true;
  if (!Number.isSafeInteger(plan.output_bytes) || plan.output_bytes < 1) return true;
  return false;
}

export async function searchRecall(
  transport: HindsightTransport,
  bankId: string,
  space: MemorySpaceRef,
  plan: MemoryAdapterSearchPlan,
  filters: SearchFilterPlan,
  now: () => number,
): Promise<SearchResult> {
  const tagGroups: unknown[] = [];
  if (filters.originKinds.length > 0) {
    tagGroups.push(tagGroup(filters.originKinds.map((kind) => `agentnet:o:${kind}`)));
  }
  if (filters.sourceIds.length > 0) {
    tagGroups.push(
      tagGroup(await Promise.all(filters.sourceIds.map((id) => sourceTag(id)))),
    );
  }
  const body: Record<string, unknown> = {
    query: plan.query,
    max_tokens: Math.max(1, Math.min(MAX_RECALL_TOKENS, Math.ceil(plan.output_bytes / 4))),
  };
  if (tagGroups.length > 0) body.tag_groups = tagGroups;
  const outcome = await transport.request(
    'POST',
    `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`,
    { body, deadlineAt: plan.deadline_at, retry: true },
  );
  if (outcome.kind !== 'ok') {
    if (outcome.kind === 'http' && (outcome.status === 400 || outcome.status === 422)) {
      return searchFailure('unsupported', 'invalid_request', now);
    }
    if (outcome.kind === 'http' && outcome.status === 404) {
      return searchFailure('unavailable', 'unavailable', now);
    }
    return searchFailure('unavailable', transport.reasonFor(outcome, 'unavailable'), now);
  }
  if (!isRecord(outcome.body) || !Array.isArray(outcome.body.results)) {
    return searchFailure('unavailable', 'unknown', now);
  }

  const hits: MemoryAdapterSearchHit[] = [];
  let acceptedBytes = 0;
  let accepted = 0;
  let incomplete = 0;
  let budgetDropped = 0;
  let closed = false;
  for (const fact of outcome.body.results) {
    const mapped = await mapFact(fact, space);
    if ('reason' in mapped) {
      incomplete += 1;
      continue;
    }
    if (closed) {
      budgetDropped += 1;
      continue;
    }
    const hitBytes = mapped.hit.representation.text_bytes;
    if (accepted >= plan.candidate_limit || acceptedBytes + hitBytes > plan.output_bytes) {
      closed = true;
      budgetDropped += 1;
      continue;
    }
    hits.push(mapped.hit);
    accepted += 1;
    acceptedBytes += hitBytes;
  }
  const exclusions: MemoryAdapterSearchExclusion[] = [];
  if (budgetDropped > 0) exclusions.push({ reason: 'budget', count: budgetDropped });
  if (incomplete > 0) exclusions.push({ reason: 'source_incomplete', count: incomplete });
  return {
    status: hits.length > 0 ? 'ready' : 'empty',
    coverage: 'bounded',
    freshness: { as_of: now(), backend_revision: null },
    evidence_complete:
      hits.length > 0 &&
      hits.every((hit) => hit.source !== null && hit.representation.verbatim),
    hits,
    exclusions,
    reason: null,
  };
}

export async function searchList(
  transport: HindsightTransport,
  bankId: string,
  space: MemorySpaceRef,
  plan: MemoryAdapterSearchPlan,
  filters: SearchFilterPlan,
  now: () => number,
): Promise<SearchResult> {
  const pageSize = transport.config.listPageSize;
  const hits: MemoryAdapterSearchHit[] = [];
  let acceptedBytes = 0;
  let offset = 0;
  let total: number | null = null;
  let scanned = 0;
  let incomplete = 0;
  let filtered = 0;
  let budgetDropped = 0;
  let closed = false;
  let complete = false;
  const originFilter = new Set(filters.originKinds);
  const sourceFilter = new Set(filters.sourceIds);

  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(offset),
    });
    const outcome = await transport.request(
      'GET',
      `/v1/default/banks/${encodeURIComponent(bankId)}/memories/list?${params.toString()}`,
      { deadlineAt: plan.deadline_at, retry: true },
    );
    if (outcome.kind !== 'ok' || !isRecord(outcome.body) || !Array.isArray(outcome.body.items)) {
      if (outcome.kind === 'http' && outcome.status === 404) {
        return searchFailure('unavailable', 'unavailable', now);
      }
      if (outcome.kind === 'http' && (outcome.status === 400 || outcome.status === 422)) {
        return searchFailure('unsupported', 'invalid_request', now);
      }
      return searchFailure('unavailable', transport.reasonFor(outcome, 'unavailable'), now);
    }
    const items = outcome.body.items;
    if (typeof outcome.body.total === 'number' && Number.isSafeInteger(outcome.body.total)) {
      total = outcome.body.total;
    }
    for (const item of items) {
      scanned += 1;
      const mapped = await mapFact(item, space);
      if ('reason' in mapped) {
        incomplete += 1;
        continue;
      }
      if (originFilter.size > 0 && !originFilter.has(mapped.hit.origin_kind)) {
        filtered += 1;
        continue;
      }
      if (
        sourceFilter.size > 0 &&
        (mapped.hit.source === null || !sourceFilter.has(mapped.hit.source.source_id))
      ) {
        filtered += 1;
        continue;
      }
      if (closed) {
        budgetDropped += 1;
        continue;
      }
      const hitBytes = mapped.hit.representation.text_bytes;
      if (acceptedBytes + hitBytes > plan.output_bytes || hits.length >= plan.candidate_limit) {
        closed = true;
        budgetDropped += 1;
        continue;
      }
      hits.push(mapped.hit);
      acceptedBytes += hitBytes;
    }
    offset += items.length;
    if (closed) break;
    if (items.length === 0) {
      complete = true;
      break;
    }
    if (total !== null && offset >= total) {
      complete = true;
      break;
    }
    if (total === null && items.length < pageSize) {
      complete = true;
      break;
    }
  }

  if (!complete && budgetDropped === 0 && scanned > 0) {
    budgetDropped = Math.max(1, (total ?? scanned + 1) - scanned);
  }
  const exclusions: MemoryAdapterSearchExclusion[] = [];
  if (filtered > 0) exclusions.push({ reason: 'hard_filter', count: filtered });
  if (budgetDropped > 0) exclusions.push({ reason: 'budget', count: budgetDropped });
  if (incomplete > 0) exclusions.push({ reason: 'source_incomplete', count: incomplete });
  return {
    status: hits.length > 0 ? 'ready' : 'empty',
    coverage: complete ? 'exhaustive' : 'bounded',
    freshness: { as_of: now(), backend_revision: null },
    evidence_complete:
      hits.length > 0 &&
      hits.every((hit) => hit.source !== null && hit.representation.verbatim),
    hits,
    exclusions,
    reason: null,
  };
}

function tagGroup(tags: string[]): unknown {
  if (tags.length === 1) return { tags, match: 'all_strict' };
  return { or: tags.map((tag) => ({ tags: [tag], match: 'all_strict' })) };
}

function searchFailure(
  status: 'unavailable' | 'unsupported',
  reason: MemoryAdapterFailureReason,
  now: () => number,
): SearchResult {
  return {
    status,
    coverage: 'unknown',
    freshness: { as_of: now(), backend_revision: null },
    evidence_complete: false,
    hits: [],
    exclusions: [],
    reason,
  };
}

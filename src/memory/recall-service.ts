/**
 * MF06：显式召回与 lookup Context。
 *
 * 召回只返回当前 Agent 可读的候选，不产生个人经历、retain 资格或旁路注入权。
 * auto 召回必须绑定 HostBinding 与准确目标，但仍只是预热；没有 claim 后
 * 生成的 bound Context 就不能注入。客户端不能用查询结果自报“已消费”。
 */
import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import type { D1Like } from '../storage/queries';
import type { MemoryRuntime } from './runtime';
import type {
  MemoryAdapterCapabilities,
  MemoryAdapterSearchPlan,
  SearchResult,
} from './adapters/types';
import {
  MEMORY_POLICY_VERSION,
  type MemoryRecallBudget,
  type MemoryRecallInput,
  type MemoryRecallItem,
  type MemoryRecallResult,
  type MemoryRecallStatus,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from './contracts';
import {
  authorizeRepresentationRead,
  requireCurrentMemorySpace,
} from './access';
import { createLookupMemoryContext, resolveContextOriginScope } from './context';
import { loadRepresentationExact } from './experience-source';
import { getMessage } from '../storage/queries';
import { requireHostBinding, integrationLevel, bindingCapabilities } from './input-manifest';
import { hostSupports } from './contracts';
import { assertRecallMessageVisible, taskTargetUnsupported } from './target';

export interface MemoryRecallServiceOptions {
  instanceId: string;
  agentId: string;
  space: MemorySpaceRef;
  input: MemoryRecallInput;
  now?: number;
}

export interface MemoryRecallServiceResult {
  recall: MemoryRecallResult;
  context_ref: string | null;
  injection: {
    eligible: false;
    admit_required: true;
    reason: 'lookup_only' | 'auto_pending_claim' | 'not_ready';
  };
}

const PRIVATE_SCOPE: MemoryTargetScope = {
  audience: 'agent_private',
  room_id: null,
  member_generation: null,
  member_seq: null,
  policy_revision: null,
};

function evidenceRank(evidence: string | null): number {
  if (evidence === 'gateway_observed_submitted') return 2;
  if (evidence === 'host_reported_submitted') return 1;
  return 0;
}

function requiredFilters(input: MemoryRecallInput): {
  origin_kind?: boolean;
  source_kind?: boolean;
  room_scope?: boolean;
  time_range?: boolean;
} {
  const filters = input.hard_filters ?? {};
  return {
    origin_kind: Array.isArray(filters.origin_kinds) && filters.origin_kinds.length > 0,
    source_kind: Array.isArray(filters.source_kinds) && filters.source_kinds.length > 0,
    room_scope: Array.isArray(filters.origin_room_ids) && filters.origin_room_ids.length > 0,
    time_range: filters.time_from !== undefined || filters.time_to !== undefined,
  };
}

export function unsupportedHardFilters(
  capabilities: MemoryAdapterCapabilities,
  input: MemoryRecallInput,
): string[] {
  const required = requiredFilters(input);
  const supported = new Set(capabilities.hard_filters);
  const missing: string[] = [];
  if (required.origin_kind && !supported.has('origin_kind')) missing.push('origin_kind');
  if (required.source_kind && !supported.has('source_kind')) missing.push('source_kind');
  if (required.room_scope && !supported.has('room_scope')) missing.push('room_scope');
  if (required.time_range) {
    if (capabilities.time_window !== 'hard_filter' || !supported.has('time_range')) {
      missing.push('time_range');
    }
  }
  return missing;
}

function buildSearchPlan(input: MemoryRecallInput, query: string | null): MemoryAdapterSearchPlan {
  const filters = input.hard_filters ?? {};
  return {
    query,
    hard_filters: {
      ...(filters.origin_kinds ? { origin_kinds: filters.origin_kinds } : {}),
      ...(filters.source_kinds ? { source_kinds: filters.source_kinds } : {}),
      ...(filters.origin_room_ids ? { room_ids: filters.origin_room_ids } : {}),
      ...(filters.time_field ? { time_field: filters.time_field } : {}),
      ...(filters.time_from !== undefined ? { time_from: filters.time_from } : {}),
      ...(filters.time_to !== undefined ? { time_to: filters.time_to } : {}),
      ...(filters.timezone ? { timezone: filters.timezone } : {}),
    },
    ranking_hints: {
      ...(input.ranking_hints?.recency_bias !== undefined
        ? { recency_bias: input.ranking_hints.recency_bias }
        : {}),
      ...(input.ranking_hints?.relevance_bias !== undefined
        ? { relevance_bias: input.ranking_hints.relevance_bias }
        : {}),
    },
    candidate_limit: input.budget.candidate_limit,
    output_bytes: input.budget.output_bytes,
    deadline_at: input.budget.deadline_at ?? null,
    policy_version: MEMORY_POLICY_VERSION,
  };
}

function emptyResult(
  recallId: string,
  status: MemoryRecallStatus,
): MemoryRecallResult {
  return {
    recall_id: recallId,
    status,
    coverage: 'unknown',
    freshness: { as_of: Date.now(), backend_revision: null },
    evidence_complete: false,
    items: [],
    context: null,
    exclusions: [],
    budget_used: { candidates: 0, packaged_bytes: 0, truncated: false },
  };
}

function recallCanonicalInput(input: MemoryRecallInput): string {
  return stableStringify({
    request_id: input.request_id,
    mode: input.mode,
    dispatch: input.dispatch,
    query: input.query ?? null,
    host: input.host ?? null,
    message: input.message ?? null,
    task: input.task ?? null,
    hard_filters: input.hard_filters ?? {},
    ranking_hints: input.ranking_hints ?? {},
    budget: input.budget,
  });
}

async function resolveQuery(
  db: D1Like,
  agentId: string,
  input: MemoryRecallInput,
): Promise<{ query: string | null; targetJson: string }> {
  if (input.mode === 'lookup' || input.mode === 'reflect') {
    if (!input.query) {
      throw new BusinessError('MEMORY_UNSUPPORTED', '该召回模式需要 query', {
        reason: 'query_required',
      });
    }
    return { query: input.query, targetJson: JSON.stringify({ kind: 'query' }) };
  }
  if (input.mode === 'bootstrap') {
    return { query: null, targetJson: JSON.stringify({ kind: 'bootstrap' }) };
  }
  if (input.mode === 'related') {
    if (!input.message) {
      throw new BusinessError('MEMORY_UNSUPPORTED', 'related 召回需要 message 定位', {
        reason: 'message_required',
      });
    }
    await assertRecallMessageVisible(db, agentId, input.message);
    let query = input.query ?? null;
    if (!query) {
      const message = await getMessage(db, input.message.message_id);
      query = message ? message.body.slice(0, 512) : null;
    }
    return {
      query,
      targetJson: JSON.stringify({ kind: 'message', message: input.message }),
    };
  }
  taskTargetUnsupported();
}

async function assertAutoHost(
  db: D1Like,
  options: MemoryRecallServiceOptions,
  input: MemoryRecallInput,
): Promise<{ level: string }> {
  if (!input.host) {
    throw new BusinessError('MEMORY_TARGET_INVALID', 'auto 召回必须绑定宿主代次', {
      reason: 'host_binding_required',
    });
  }
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at: options.now,
  });
  const binding = await requireHostBinding(db, {
    bindingId: input.host.host_binding_id,
    generation: input.host.host_generation,
    space: context.space,
    agentId: options.agentId,
    at: options.now ?? nowMs(),
  });
  const level = integrationLevel(binding);
  if (!hostSupports(level, 'run_binding') || !bindingCapabilities(binding).includes('run_binding')) {
    throw new BusinessError('MEMORY_UNSUPPORTED', '当前宿主等级或声明不能绑定运行目标', {
      reason: 'run_binding_unsupported',
      level,
    });
  }
  return { level };
}

async function persistRecall(
  db: D1Like,
  options: MemoryRecallServiceOptions,
  canonical: string,
  targetJson: string,
  plan: MemoryAdapterSearchPlan | null,
): Promise<{ recallId: string; existing: { status: string; result_json: string | null } | null }> {
  const at = options.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  const existing = await db
    .prepare(
      `SELECT recall_id, status, result_json FROM memory_recall_requests
        WHERE space_id = ? AND request_key = ?`,
    )
    .bind(context.space.space_id, options.input.request_id)
    .first<{ recall_id: string; status: string; result_json: string | null }>();
  if (existing) {
    const storedHash = await sha256Hex(canonical);
    const row = await db
      .prepare(
        `SELECT target_json FROM memory_recall_requests WHERE recall_id = ?`,
      )
      .bind(existing.recall_id)
      .first<{ target_json: string | null }>();
    let storedTarget: { input_sha256?: string } | null = null;
    try {
      storedTarget = row?.target_json ? (JSON.parse(row.target_json) as { input_sha256?: string }) : null;
    } catch {
      storedTarget = null;
    }
    if (storedTarget?.input_sha256 && storedTarget.input_sha256 !== storedHash) {
      throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一召回 request_id 绑定了不同输入', {
        recall_id: existing.recall_id,
      });
    }
    return { recallId: existing.recall_id, existing };
  }
  const recallId = newId('mrc');
  const inputSha = await sha256Hex(canonical);
  const target = JSON.parse(targetJson) as Record<string, unknown>;
  const envelope = JSON.stringify({ ...target, input_sha256: inputSha });
  await db
    .prepare(
      `INSERT INTO memory_recall_requests
         (recall_id, space_id, ownership_epoch, agent_actor_id, request_key, mode,
          dispatch, status, target_json, plan_json, budget_json, warmup_only,
          created_at, updated_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 0, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM memory_recall_requests WHERE space_id = ? AND request_key = ?
        )`,
    )
    .bind(
      recallId,
      context.space.space_id,
      context.space.ownership_epoch,
      options.agentId,
      options.input.request_id,
      options.input.mode,
      options.input.dispatch,
      envelope,
      plan ? JSON.stringify(plan) : null,
      JSON.stringify(options.input.budget),
      at,
      at,
      at + LIMITS.memoryPreparedTtlMs,
      context.space.space_id,
      options.input.request_id,
    )
    .run();
  const stored = await db
    .prepare(
      'SELECT recall_id FROM memory_recall_requests WHERE space_id = ? AND request_key = ?',
    )
    .bind(context.space.space_id, options.input.request_id)
    .first<{ recall_id: string }>();
  return { recallId: stored?.recall_id ?? recallId, existing: null };
}

async function updateRecallResult(
  db: D1Like,
  recallId: string,
  result: MemoryRecallResult,
  contextId: string | null,
): Promise<void> {
  await db
    .prepare(
      `UPDATE memory_recall_requests
          SET status = ?, result_json = ?, updated_at = ?
        WHERE recall_id = ?`,
    )
    .bind(
      result.status,
      JSON.stringify({ result, context_id: contextId }),
      nowMs(),
      recallId,
    )
    .run();
}

async function buildBootstrapResult(
  db: D1Like,
  options: MemoryRecallServiceOptions,
  recallId: string,
): Promise<MemoryRecallResult> {
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at: options.now,
  });
  const rows = await db
    .prepare(
      `SELECT experience_id, origin_room_id, origin_member_generation, representation_id,
              evidence, created_at
         FROM memory_experiences
        WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
          AND available = 1 AND origin_kind = 'experienced'
        ORDER BY created_at DESC LIMIT ?`,
    )
    .bind(
      context.space.space_id,
      context.space.ownership_epoch,
      options.agentId,
      options.input.budget.candidate_limit,
    )
    .all<{
      experience_id: string;
      origin_room_id: string | null;
      origin_member_generation: number;
      representation_id: string;
      evidence: string | null;
      created_at: number;
    }>();
  const items: MemoryRecallItem[] = [];
  const contextItems: Array<{
    exact: { representation: import('./contracts').MemoryRepresentation; text: string };
    origin_scope: import('./contracts').MemoryOriginScope;
    evidence: 'host_reported_submitted' | 'gateway_observed_submitted';
  }> = [];
  for (const row of rows.results) {
    const evidence =
      row.evidence === 'gateway_observed_submitted'
        ? 'gateway_observed_submitted'
        : row.evidence === 'host_reported_submitted'
          ? 'host_reported_submitted'
          : null;
    if (!evidence) continue;
    const exact = await loadRepresentationExact(db, row.representation_id);
    if (!exact) continue;
    const decision = await authorizeRepresentationRead(db, {
      space: context.space,
      representationId: row.representation_id,
      agentId: options.agentId,
      target_scope: PRIVATE_SCOPE,
      at: options.now ?? nowMs(),
    });
    if (!decision.allowed) continue;
    const origin = await resolveContextOriginScope(db, exact.representation);
    if (!origin) continue;
    items.push({
      origin_kind: 'experienced',
      representation: exact.representation,
      evidence,
      source:
        exact.representation.kind === 'raw_full' ||
        exact.representation.kind === 'raw_fragment' ||
        exact.representation.kind === 'preview'
          ? {
              source_id: exact.representation.source_id,
              source_revision: exact.representation.source_revision,
            }
          : null,
      score: null,
      trust: 'reference_data',
    });
    contextItems.push({ exact, origin_scope: origin, evidence });
  }
  const created =
    contextItems.length > 0
      ? await createLookupMemoryContext(db, {
          instanceId: options.instanceId,
          agentId: options.agentId,
          space: options.space,
          recallId,
          targetScope: PRIVATE_SCOPE,
          items: contextItems,
          coverage: 'bounded',
          evidenceComplete: false,
          now: options.now,
        })
      : null;
  return {
    recall_id: recallId,
    status: items.length === 0 ? 'empty' : 'ready',
    coverage: 'bounded',
    freshness: { as_of: options.now ?? nowMs(), backend_revision: null },
    evidence_complete: false,
    items,
    context: created ? (created.context as MemoryRecallResult['context']) : null,
    exclusions: [],
    budget_used: {
      candidates: rows.results.length,
      packaged_bytes: contextItems.reduce(
        (sum, item) => sum + new TextEncoder().encode(item.exact.text).length,
        0,
      ),
      truncated: rows.results.length >= options.input.budget.candidate_limit,
    },
  };
}

/**
 * 执行一次召回。显式 lookup/reflect/related 同步返回；auto 只做预热。
 *
 * 任何错误都不会写经历或 retain；适配器不可用时诚实返回 unavailable /
 * unsupported，不伪造空库或“已记住”。
 */
export async function recallMemory(
  db: D1Like,
  runtime: MemoryRuntime | null,
  options: MemoryRecallServiceOptions,
): Promise<MemoryRecallServiceResult> {
  const at = options.now ?? nowMs();
  const input = options.input;
  if (input.dispatch === 'auto') {
    await assertAutoHost(db, options, input);
  } else if (input.host) {
    // bootstrap/显式请求如果携带 host，也必须对应仍活动的绑定；不能让旧代次
    // 通过显式查询获得“看起来可注入”的上下文。
    await requireCurrentMemorySpace(db, {
      agentId: options.agentId,
      instanceId: options.instanceId,
      expected: options.space,
      at: options.now,
    });
    await requireHostBinding(db, {
      bindingId: input.host.host_binding_id,
      generation: input.host.host_generation,
      space: options.space,
      agentId: options.agentId,
      at: options.now ?? nowMs(),
    });
  }
  const { query, targetJson } = await resolveQuery(db, options.agentId, input);
  if (input.mode === 'task') taskTargetUnsupported();

  const canonical = recallCanonicalInput(input);
  let capabilities: MemoryAdapterCapabilities | null = null;
  if (runtime) capabilities = runtime.capabilities();
  const plan = buildSearchPlan(input, query);

  const persisted = await persistRecall(db, options, canonical, targetJson, plan);
  if (persisted.existing) {
    const stored = persisted.existing;
    if (stored.result_json) {
      try {
        const parsed = JSON.parse(stored.result_json) as {
          result: MemoryRecallResult;
          context_id?: string | null;
        };
        return {
          recall: { ...parsed.result, recall_id: persisted.recallId },
          context_ref: parsed.context_id ?? null,
          injection: {
            eligible: false,
            admit_required: true,
            reason:
              stored.status === 'ready' || stored.status === 'empty'
                ? parsed.result.context
                  ? 'lookup_only'
                  : 'not_ready'
                : 'not_ready',
          },
        };
      } catch {
        // 结果损坏时重新计算；不返回半解析正文。
      }
    }
    if (stored.status === 'disabled' || stored.status === 'unsupported' || stored.status === 'unavailable') {
      return {
        recall: emptyResult(persisted.recallId, stored.status as MemoryRecallStatus),
        context_ref: null,
        injection: { eligible: false, admit_required: true, reason: 'not_ready' },
      };
    }
  }

  if (!runtime || !capabilities) {
    const result = emptyResult(persisted.recallId, 'disabled');
    await updateRecallResult(db, persisted.recallId, result, null);
    return {
      recall: result,
      context_ref: null,
      injection: { eligible: false, admit_required: true, reason: 'not_ready' },
    };
  }

  if (input.mode === 'bootstrap') {
    const result = await buildBootstrapResult(db, options, persisted.recallId);
    await updateRecallResult(
      db,
      persisted.recallId,
      result,
      result.context?.context_id ?? null,
    );
    return {
      recall: result,
      context_ref: result.context?.context_id ?? null,
      injection: { eligible: false, admit_required: true, reason: 'lookup_only' },
    };
  }

  if (input.mode === 'reflect' && !capabilities.reflect) {
    const result = emptyResult(persisted.recallId, 'unsupported');
    await updateRecallResult(db, persisted.recallId, result, null);
    return {
      recall: result,
      context_ref: null,
      injection: { eligible: false, admit_required: true, reason: 'not_ready' },
    };
  }

  const missingFilters = unsupportedHardFilters(capabilities, input);
  if (missingFilters.length > 0) {
    const result: MemoryRecallResult = {
      ...emptyResult(persisted.recallId, 'unsupported'),
      exclusions: missingFilters.map((filter) => ({
        reason: 'unsupported_hard_filter' as const,
        source_id: null,
        detail: filter,
      })),
    };
    await updateRecallResult(db, persisted.recallId, result, null);
    return {
      recall: result,
      context_ref: null,
      injection: { eligible: false, admit_required: true, reason: 'not_ready' },
    };
  }

  let search: SearchResult;
  try {
    search = await runtime.searchNow(
      {
        space_id: options.space.space_id,
        ownership_epoch: options.space.ownership_epoch,
        backend_binding_epoch: options.space.backend_binding_epoch,
      },
      plan,
    );
  } catch (error) {
    const result = emptyResult(persisted.recallId, 'unavailable');
    await updateRecallResult(db, persisted.recallId, result, null);
    if (error instanceof BusinessError) throw error;
    return {
      recall: result,
      context_ref: null,
      injection: { eligible: false, admit_required: true, reason: 'not_ready' },
    };
  }

  const minimum = input.hard_filters?.minimum_evidence ?? null;
  const exclusions: MemoryRecallResult['exclusions'][number][] = search.exclusions.map((exclusion) => ({
    reason:
      exclusion.reason === 'budget'
        ? 'budget'
        : exclusion.reason === 'permission_partition'
          ? 'permission'
          : exclusion.reason === 'source_incomplete'
            ? 'source_not_active'
            : exclusion.reason === 'unsupported_filter'
              ? 'unsupported_hard_filter'
              : 'source_not_active',
    source_id: null,
    detail: exclusion.reason,
  }));
  const items: MemoryRecallItem[] = [];
  const contextItems: Array<{
    exact: { representation: import('./contracts').MemoryRepresentation; text: string };
    origin_scope: import('./contracts').MemoryOriginScope;
    evidence: 'host_reported_submitted' | 'gateway_observed_submitted';
  }> = [];
  let packagedBytes = 0;
  let truncated = false;
  const context = await requireCurrentMemorySpace(db, {
    agentId: options.agentId,
    instanceId: options.instanceId,
    expected: options.space,
    at,
  });
  for (const hit of search.hits) {
    if (minimum && evidenceRank(hit.evidence) < evidenceRank(minimum)) {
      exclusions.push({ reason: 'evidence_below_minimum', source_id: hit.source?.source_id ?? null, detail: null });
      continue;
    }
    if (!hit.evidence) {
      exclusions.push({ reason: 'evidence_below_minimum', source_id: hit.source?.source_id ?? null, detail: 'evidence_missing' });
      continue;
    }
    const exact = await loadRepresentationExact(db, hit.representation.representation_id);
    if (!exact) {
      exclusions.push({
        reason: 'source_not_active',
        source_id: hit.source?.source_id ?? null,
        detail: 'representation_missing',
      });
      continue;
    }
    const bytes = exact.representation.text_bytes;
    if (packagedBytes + bytes > input.budget.output_bytes) {
      exclusions.push({
        reason: 'budget',
        source_id: hit.source?.source_id ?? null,
        detail: 'output_bytes_exceeded',
      });
      truncated = true;
      continue;
    }
    const decision = await authorizeRepresentationRead(db, {
      space: context.space,
      representationId: hit.representation.representation_id,
      agentId: options.agentId,
      target_scope: PRIVATE_SCOPE,
      at,
    });
    if (!decision.allowed) {
      exclusions.push({
        reason: 'permission',
        source_id: hit.source?.source_id ?? null,
        detail: decision.reason,
      });
      continue;
    }
    const origin = await resolveContextOriginScope(
      db,
      exact.representation,
      hit.source ? { source_id: hit.source.source_id, source_revision: hit.source.source_revision } : null,
    );
    if (!origin) {
      exclusions.push({
        reason: 'source_not_active',
        source_id: hit.source?.source_id ?? null,
        detail: 'origin_scope_missing',
      });
      continue;
    }
    packagedBytes += bytes;
    items.push({
      origin_kind: hit.origin_kind,
      representation: exact.representation,
      evidence: hit.evidence,
      source: hit.source,
      score: hit.score,
      trust: 'reference_data',
    });
    contextItems.push({ exact, origin_scope: origin, evidence: hit.evidence });
  }

  const status: MemoryRecallStatus =
    search.status === 'ready' || search.status === 'empty'
      ? items.length === 0
        ? 'empty'
        : search.status
      : search.status;
  const lookupContext =
    input.dispatch === 'explicit' && contextItems.length > 0
      ? await createLookupMemoryContext(db, {
          instanceId: options.instanceId,
          agentId: options.agentId,
          space: options.space,
          recallId: persisted.recallId,
          targetScope: PRIVATE_SCOPE,
          items: contextItems,
          coverage: search.coverage,
          evidenceComplete: search.evidence_complete,
          now: at,
        })
      : null;
  const result: MemoryRecallResult = {
    recall_id: persisted.recallId,
    status,
    coverage: search.coverage,
    freshness: search.freshness,
    evidence_complete: search.evidence_complete,
    items,
    context: lookupContext ? (lookupContext.context as MemoryRecallResult['context']) : null,
    exclusions,
    budget_used: {
      candidates: search.hits.length,
      packaged_bytes: packagedBytes,
      truncated,
    },
  };
  await updateRecallResult(db, persisted.recallId, result, lookupContext?.context_id ?? null);
  return {
    recall: result,
    context_ref: lookupContext?.context_id ?? null,
    injection: {
      eligible: false,
      admit_required: true,
      reason:
        input.dispatch === 'auto'
          ? 'auto_pending_claim'
          : lookupContext
            ? 'lookup_only'
            : 'not_ready',
    },
  };
}


/**
 * MF10 集成验收共享的适配器请求构造、作业快照与故障注入工具。
 *
 * 从 verify-memory-integration.ts 抽出，保持断言与调用方式不变。
 */
import { HindsightMemoryAdapter } from '../../src/memory/adapters/hindsight';
import type {
  MemoryAdapterRemoveTarget,
  MemoryAdapterRetainItem,
  MemoryAdapterSearchPlan,
  RemoveRequest,
  RetainRequest,
} from '../../src/memory/adapters/types';
import type { MemorySpaceRef } from '../../src/memory/contracts';
import { MEMORY_INTEGRATION_AT } from './memory-admission-fixture';
import type { FakeHindsight } from './memory-hindsight-fake';
import { createMemoryEnv, rawRepresentation } from './memory-unit';

export const AT = MEMORY_INTEGRATION_AT;
export const HASH = 'a'.repeat(64);

export function memorySpace(id: string): MemorySpaceRef {
  return { space_id: id, ownership_epoch: 1, backend_binding_epoch: 1 };
}

export function item(
  representation: Awaited<ReturnType<typeof rawRepresentation>>,
  text: string,
  source: { source_id: string; source_revision: number } | null,
  originKind: 'experienced' | 'authored' | 'curated',
  eligibility: MemoryAdapterRetainItem['eligibility'],
): MemoryAdapterRetainItem {
  return {
    origin_kind: originKind,
    representation: { representation: representation.representation, text },
    source,
    eligibility,
  };
}

export function experiencedEligibility(): MemoryAdapterRetainItem['eligibility'] {
  return {
    kind: 'experienced',
    evidence: 'host_reported_submitted',
    receipt_id: 'mrc_contract',
    proof_id: 'mpf_contract',
  };
}

export function retainRequest(
  space: MemorySpaceRef,
  items: MemoryAdapterRetainItem[],
  operationKey: string,
  payloadHash = HASH,
): RetainRequest {
  return {
    space,
    operation_key: operationKey,
    payload_sha256: payloadHash,
    items,
    policy_version: 1,
    deadline_at: null,
  };
}

export function searchPlan(
  overrides: Partial<MemoryAdapterSearchPlan> = {},
): MemoryAdapterSearchPlan {
  return {
    query: null,
    hard_filters: {},
    ranking_hints: {},
    candidate_limit: 10,
    output_bytes: 64 * 1024,
    deadline_at: null,
    policy_version: 1,
    ...overrides,
  };
}

export function removeRequest(
  space: MemorySpaceRef,
  targets: readonly MemoryAdapterRemoveTarget[],
  operationKey: string,
): RemoveRequest {
  return {
    space,
    operation_key: operationKey,
    payload_sha256: HASH,
    targets,
    policy_version: 1,
    deadline_at: null,
  };
}

export async function jobStatusOf(
  env: { d1: D1Database },
  operation = 'retain',
): Promise<{ status: string; stage: string; provider_job_id: string | null }> {
  const row = await env.d1
    .prepare(
      `SELECT status, stage, provider_job_id FROM memory_jobs
        WHERE operation_type = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(operation)
    .first<{ status: string; stage: string; provider_job_id: string | null }>();
  if (!row) throw new Error(`memory job ${operation} missing`);
  return row;
}

export interface JobSnapshot {
  status: string;
  stage: string;
  provider_job_id: string | null;
  result_json: string | null;
  attempt: number;
  last_error: string | null;
}

export async function jobSnapshotOf(
  env: { d1: D1Database },
  operation = 'retain',
): Promise<JobSnapshot> {
  const row = await env.d1
    .prepare(
      `SELECT status, stage, provider_job_id, result_json, attempt, last_error
         FROM memory_jobs WHERE operation_type = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(operation)
    .first<JobSnapshot>();
  if (!row) throw new Error(`memory job ${operation} missing`);
  return row;
}

export async function count(
  env: ReturnType<typeof createMemoryEnv>,
  table: string,
): Promise<number> {
  const row = await env.d1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 让完成写回返回 changes=0，模拟并发/租约丢失导致的写回未生效。 */
export function failCompleteWriteback(db: D1Database): D1Database {
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === 'bind') {
          return (...args: unknown[]) =>
            wrapStatement(
              (target.bind as (...values: unknown[]) => D1PreparedStatement).apply(target, args),
            );
        }
        if (property === 'run') {
          return async () => ({ success: true, meta: { changes: 0 }, results: [] });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query);
          return /UPDATE\s+memory_jobs\s+SET\s+status\s*=\s*'completed'/i.test(query)
            ? wrapStatement(statement)
            : statement;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}

export async function firstSpaceId(dbPath: string): Promise<string> {
  const env = createMemoryEnv(dbPath);
  const row = await env.d1
    .prepare('SELECT space_id FROM memory_spaces ORDER BY created_at, space_id LIMIT 1')
    .first<{ space_id: string }>();
  env.db.close();
  if (!row) throw new Error('memory space missing');
  return row.space_id;
}

export async function firstInstanceId(dbPath: string): Promise<string> {
  const env = createMemoryEnv(dbPath);
  const row = await env.d1
    .prepare('SELECT instance_id FROM memory_instances ORDER BY created_at, instance_id LIMIT 1')
    .first<{ instance_id: string }>();
  env.db.close();
  if (!row) throw new Error('memory instance missing');
  return row.instance_id;
}

export function hindsightAdapter(
  fake: FakeHindsight,
  overrides: Partial<ConstructorParameters<typeof HindsightMemoryAdapter>[0]> = {},
): HindsightMemoryAdapter {
  return new HindsightMemoryAdapter({
    baseUrl: fake.baseUrl,
    apiKey: fake.token,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryBaseMs: 1,
    sleepImpl: async () => undefined,
    ...(overrides as Record<string, unknown>),
  });
}

/** 远端明确拒绝重新入队；用于断言 rejected 事件的 retry_outcome。 */
export class RejectingRetryAdapter extends HindsightMemoryAdapter {
  override async retryJob(): Promise<{ accepted: boolean; reason: 'not_retryable' }> {
    return { accepted: false, reason: 'not_retryable' };
  }
}

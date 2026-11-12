/**
 * MF10 第二适配器：本地 SQLite 记忆后端。
 *
 * 与 Hindsight 的语义差异是刻意的，不是改名的 mock：
 * - Hindsight 抽取 fact、正文可能被改写，因此 source_completeness=partial、
 *   time_window=unsupported；本后端逐字保存准确表示，时间范围是真硬过滤。
 * - Hindsight retain 是异步作业；本后端在同一事务内完成写入与派生标记，
 *   `source_applied`/`derived_ready` 同步为真。
 * - Hindsight 由后端做 bank 路由；本后端用 space 派生不可猜测的 partition_key，
 *   每个 partition 独立文件内隔离，删除时清空正文并保留最小审计键。
 * - 本后端不实现 reflect/native export，能力目录如实声明 false。
 *
 * 它仍然只实现六操作 `capabilities/ensureSpace/retain/search/remove/jobStatus`；
 * 授权、归属、披露与消费范围全部留在 MemoryService。
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { sha256Hex, utf8Bytes } from '../../storage/db';
import type {
  MemoryBackendRef,
  MemoryOriginKind,
  MemoryPurgeState,
  MemoryRepresentation,
  MemorySourceRef,
  MemorySpaceRef,
} from '../contracts';
import type {
  EnsureSpaceRequest,
  EnsureSpaceResult,
  JobStatusRequest,
  JobStatusResult,
  MemoryAdapter,
  MemoryAdapterCapabilities,
  MemoryAdapterHardFilters,
  MemoryAdapterJobRef,
  MemoryAdapterRemoveTarget,
  MemoryAdapterSearchHit,
  MemoryAdapterSearchPlan,
  MemoryAdapterSearchExclusion,
  RemoveRequest,
  RemoveResult,
  RetainRequest,
  RetainResult,
  SearchRequest,
  SearchResult,
} from './types';
import {
  isOriginKind,
  nonEmptyString,
  validateRetainItem,
  validRetainEnvelope,
  validSourceRef,
  validSpaceRef,
} from './validation';

export interface LocalMemoryAdapterOptions {
  /** 适配器自己的 SQLite 文件；`:memory:` 只用于测试。 */
  path: string;
  now?: () => number;
  /** 单个 partition 的候选扫描上限；防止测试/滥用把整库拉入内存。 */
  maxCandidates?: number;
}

interface PartitionRow {
  partition_key: string;
  space_id: string;
  ownership_epoch: number;
  backend_binding_epoch: number;
  generation: number;
  created_at: number;
}

interface OperationRow {
  operation_id: string;
  partition_key: string;
  operation_key: string;
  payload_sha256: string;
  kind: string;
  status: string;
  result_json: string;
  attempts: number;
  created_at: number;
  updated_at: number;
}

interface RecordRow {
  record_id: string;
  partition_key: string;
  operation_id: string;
  record_key: string;
  record_revision: number;
  representation_id: string;
  representation_json: string;
  representation_kind: string;
  text: string;
  text_sha256: string;
  text_bytes: number;
  source_id: string | null;
  source_revision: number | null;
  curated_id: string | null;
  curated_revision: number | null;
  origin_kind: MemoryOriginKind;
  evidence: string | null;
  range_start: number | null;
  range_end: number | null;
  current_row: number;
  created_at: number;
  submitted_at: number;
  removed_at: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS local_memory_partitions (
  partition_key TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  ownership_epoch INTEGER NOT NULL,
  backend_binding_epoch INTEGER NOT NULL,
  generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (space_id, ownership_epoch, backend_binding_epoch)
);
CREATE TABLE IF NOT EXISTS local_memory_operations (
  operation_id TEXT PRIMARY KEY,
  partition_key TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (partition_key, operation_key)
);
CREATE TABLE IF NOT EXISTS local_memory_records (
  record_id TEXT PRIMARY KEY,
  partition_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  record_key TEXT NOT NULL,
  record_revision INTEGER NOT NULL,
  representation_id TEXT NOT NULL,
  representation_json TEXT NOT NULL,
  representation_kind TEXT NOT NULL,
  text TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  text_bytes INTEGER NOT NULL,
  source_id TEXT,
  source_revision INTEGER,
  curated_id TEXT,
  curated_revision INTEGER,
  origin_kind TEXT NOT NULL,
  evidence TEXT,
  range_start INTEGER,
  range_end INTEGER,
  current_row INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  removed_at INTEGER,
  UNIQUE (partition_key, record_key, record_revision)
);
CREATE INDEX IF NOT EXISTS local_memory_records_partition
  ON local_memory_records (partition_key, current_row, removed_at);
CREATE INDEX IF NOT EXISTS local_memory_records_source
  ON local_memory_records (partition_key, source_id, source_revision);
CREATE TABLE IF NOT EXISTS local_memory_tombstones (
  partition_key TEXT NOT NULL,
  record_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (partition_key, record_key)
);
`;

function failureReasonForTarget(target: MemoryAdapterRemoveTarget): boolean {
  if (target.kind === 'representation') {
    return validSourceRef(target.source) && nonEmptyString(target.representation_id);
  }
  if (target.kind === 'source_revision') return validSourceRef(target.source);
  if (target.kind === 'curated') {
    return (
      nonEmptyString(target.curated_id) &&
      Number.isSafeInteger(target.revision) &&
      target.revision >= 1
    );
  }
  return false;
}

export class LocalMemoryAdapter implements MemoryAdapter {
  readonly #db: Database;
  readonly #now: () => number;
  readonly #maxCandidates: number;

  constructor(options: LocalMemoryAdapterOptions) {
    if (!options.path) throw new Error('local memory adapter path is required');
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.#db = new Database(options.path, { create: true });
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.#db.exec(SCHEMA);
    this.#now = options.now ?? Date.now;
    this.#maxCandidates = Math.max(1, options.maxCandidates ?? 1_000);
  }

  close(): void {
    this.#db.close();
  }

  capabilities(): MemoryAdapterCapabilities {
    return {
      provider: 'local-sqlite',
      // 该后端没有游标列表 API；检索在单次请求内按 candidate/output 预算返回。
      pagination: false,
      // source_kind/room_id 不在 retain 契约中，不能假装能硬过滤。
      hard_filters: ['origin_kind', 'source_id', 'time_range'],
      time_window: 'hard_filter',
      source_completeness: 'exact',
      partition_isolation: 'provider_partition',
      reflect: false,
      native_export: false,
      immutable_revisions: true,
      remove_granularity: 'exact_representation',
      write_fence: 'provider_revision',
    };
  }

  /** 测试/诊断用：只返回计数，不返回正文或凭据。 */
  inspect(space: MemorySpaceRef): {
    partition: { generation: number; valid: boolean };
    records: { visible: number; removed: number; revisions: number };
    operations: { total: number; write_attempts: number };
  } {
    const partition = this.#requirePartition(space);
    const key = partition?.partition_key ?? '';
    const records = this.#db
      .prepare(
        `SELECT
           SUM(CASE WHEN current_row = 1 AND removed_at IS NULL THEN 1 ELSE 0 END) AS visible,
           SUM(CASE WHEN removed_at IS NOT NULL THEN 1 ELSE 0 END) AS removed,
           COUNT(*) AS revisions
         FROM local_memory_records WHERE partition_key = ?`,
      )
      .get(key) as { visible: number | null; removed: number | null; revisions: number };
    const operations = this.#db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN kind IN ('retain', 'remove') THEN attempts ELSE 0 END), 0) AS attempts
           FROM local_memory_operations WHERE partition_key = ?`,
      )
      .get(key) as { total: number; attempts: number };
    return {
      partition: { generation: partition?.generation ?? 0, valid: partition !== null },
      records: {
        visible: Number(records.visible ?? 0),
        removed: Number(records.removed ?? 0),
        revisions: Number(records.revisions ?? 0),
      },
      operations: { total: operations.total, write_attempts: operations.attempts },
    };
  }

  async ensureSpace(request: EnsureSpaceRequest): Promise<EnsureSpaceResult> {
    if (!validSpaceRef(request.space) || !nonEmptyString(request.operation_key)) {
      return { status: 'unavailable', backend_ref: null, job_ref: null, reason: 'invalid_request' };
    }
    const key = await this.#partitionKey(request.space);
    const existingOperation = this.#findOperation(key, request.operation_key);
    if (existingOperation) {
      if (existingOperation.payload_sha256 !== request.payload_sha256) {
        return { status: 'unsupported', backend_ref: null, job_ref: null, reason: 'fenced' };
      }
      this.#touchOperation(existingOperation);
      const partition = this.#requirePartition(request.space);
      return partition
        ? { status: 'ready', backend_ref: this.#backendRef(request.space, partition), job_ref: null, reason: null }
        : { status: 'unavailable', backend_ref: null, job_ref: null, reason: 'unavailable' };
    }
    const at = this.#now();
    this.#db
      .prepare(
        `INSERT INTO local_memory_partitions
           (partition_key, space_id, ownership_epoch, backend_binding_epoch, generation, created_at)
         VALUES (?, ?, ?, ?, 1, ?)
         ON CONFLICT (space_id, ownership_epoch, backend_binding_epoch) DO NOTHING`,
      )
      .run(key, request.space.space_id, request.space.ownership_epoch, request.space.backend_binding_epoch, at);
    const partition = this.#requirePartition(request.space);
    if (!partition) {
      return { status: 'unavailable', backend_ref: null, job_ref: null, reason: 'unavailable' };
    }
    const result: EnsureSpaceResult = {
      status: 'ready',
      backend_ref: this.#backendRef(request.space, partition),
      job_ref: null,
      reason: null,
    };
    this.#recordOperation(key, request.operation_key, request.payload_sha256, 'ensure_space', result, at);
    return result;
  }

  async retain(request: RetainRequest): Promise<RetainResult> {
    if (
      !validRetainEnvelope({
        space: request.space,
        operation_key: request.operation_key,
        payload_sha256: request.payload_sha256,
        items: request.items,
      })
    ) {
      return this.#retainFailure('unsupported', 'invalid_request');
    }
    const partition = this.#requirePartition(request.space);
    if (!partition) return this.#retainFailure('unavailable', 'unavailable');

    const replay = this.#findOperation(partition.partition_key, request.operation_key);
    if (replay) {
      if (replay.payload_sha256 !== request.payload_sha256) {
        return this.#retainFailure('unsupported', 'fenced');
      }
      this.#touchOperation(replay);
      return JSON.parse(replay.result_json) as RetainResult;
    }

    const prepared: Array<{
      item: RetainRequest['items'][number];
      representation: MemoryRepresentation;
      text: string;
      source: MemorySourceRef | null;
      recordKey: string;
    }> = [];
    for (const item of request.items) {
      const validated = validateRetainItem(item);
      if (!validated) return this.#retainFailure('unsupported', 'invalid_request');
      const representation = item.representation.representation;
      const text = item.representation.text;
      if (representation.text_bytes !== utf8Bytes(text)) {
        return this.#retainFailure('unsupported', 'invalid_request');
      }
      if (representation.text_sha256 !== (await sha256Hex(text))) {
        return this.#retainFailure('unsupported', 'invalid_request');
      }
      prepared.push({
        item,
        representation,
        text,
        source: validated.source,
        recordKey: this.#recordKey(item, validated.source),
      });
    }

    const at = this.#now();
    const operationId = await this.#operationId(partition.partition_key, request.operation_key);
    const write = this.#db.transaction(() => {
      for (const entry of prepared) {
        const tombstoned = this.#db
          .prepare('SELECT 1 AS n FROM local_memory_tombstones WHERE partition_key = ? AND record_key = ?')
          .get(partition.partition_key, entry.recordKey) as { n: number } | null;
        // 已清除的准确目标不能被后来的重试复活；operation 仍记录 accepted 以便幂等。
        if (tombstoned) continue;
        const previous = this.#db
          .prepare(
            `SELECT * FROM local_memory_records
              WHERE partition_key = ? AND record_key = ? AND current_row = 1`,
          )
          .get(partition.partition_key, entry.recordKey) as RecordRow | null;
        if (
          previous &&
          previous.text_sha256 === entry.representation.text_sha256 &&
          previous.representation_json === JSON.stringify(entry.representation)
        ) {
          continue;
        }
        if (previous) {
          this.#db
            .prepare('UPDATE local_memory_records SET current_row = 0 WHERE record_id = ?')
            .run(previous.record_id);
        }
        const revision = Number(
          (
            this.#db
              .prepare(
                'SELECT COALESCE(MAX(record_revision), 0) AS revision FROM local_memory_records WHERE partition_key = ? AND record_key = ?',
              )
              .get(partition.partition_key, entry.recordKey) as { revision: number }
          ).revision,
        ) + 1;
        const range = 'range' in entry.representation ? entry.representation.range : null;
        this.#db
          .prepare(
            `INSERT INTO local_memory_records
               (record_id, partition_key, operation_id, record_key, record_revision,
                representation_id, representation_json, representation_kind, text,
                text_sha256, text_bytes, source_id, source_revision, curated_id,
                curated_revision, origin_kind, evidence, range_start, range_end,
                current_row, created_at, submitted_at, removed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          )
          .run(
            `lmr_${crypto.randomUUID().replaceAll('-', '')}`,
            partition.partition_key,
            operationId,
            entry.recordKey,
            revision,
            entry.representation.representation_id,
            JSON.stringify(entry.representation),
            entry.representation.kind,
            entry.text,
            entry.representation.text_sha256,
            entry.representation.text_bytes,
            entry.source?.source_id ?? null,
            entry.source?.source_revision ?? null,
            entry.item.eligibility.kind === 'curated' ? entry.item.eligibility.curated_id : null,
            entry.item.eligibility.kind === 'curated' ? entry.item.eligibility.revision : null,
            entry.item.origin_kind,
            entry.item.eligibility.kind === 'experienced' ? entry.item.eligibility.evidence : null,
            range?.start ?? null,
            range?.end ?? null,
            at,
            at,
          );
      }
    });
    write();

    const result: RetainResult = {
      status: 'accepted',
      job_ref: {
        backend_binding_epoch: request.space.backend_binding_epoch,
        provider_job_id: operationId,
      },
      // 逐字写入在同一事务内完成；没有异步抽取阶段。
      source_applied: true,
      derived_ready: true,
      reason: null,
    };
    this.#recordOperation(
      partition.partition_key,
      request.operation_key,
      request.payload_sha256,
      'retain',
      result,
      at,
      operationId,
    );
    return result;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    if (!validSpaceRef(request.space) || !request.plan) {
      return this.#searchFailure('unsupported', 'invalid_request');
    }
    const plan = request.plan;
    if (!this.#supportedPlan(plan)) return this.#searchFailure('unsupported', 'unsupported');
    const partition = this.#requirePartition(request.space);
    if (!partition) return this.#searchFailure('unavailable', 'unavailable');

    const filters = plan.hard_filters ?? {};
    const where: string[] = [
      'partition_key = ?',
      'current_row = 1',
      'removed_at IS NULL',
    ];
    const params: Array<string | number> = [partition.partition_key];
    if ((filters.origin_kinds?.length ?? 0) > 0) {
      where.push(`origin_kind IN (${filters.origin_kinds!.map(() => '?').join(', ')})`);
      params.push(...filters.origin_kinds!);
    }
    if ((filters.source_ids?.length ?? 0) > 0) {
      where.push(`source_id IN (${filters.source_ids!.map(() => '?').join(', ')})`);
      params.push(...filters.source_ids!);
    }
    const timeField = filters.time_field === 'submitted_at' ? 'submitted_at' : 'created_at';
    if (filters.time_from !== undefined) {
      where.push(`${timeField} >= ?`);
      params.push(filters.time_from);
    }
    if (filters.time_to !== undefined) {
      where.push(`${timeField} <= ?`);
      params.push(filters.time_to);
    }
    const limit = Math.min(
      this.#maxCandidates,
      Math.max(1, plan.candidate_limit),
    );
    const rows = this.#db
      .prepare(
        `SELECT * FROM local_memory_records
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(...params, limit) as RecordRow[];

    const terms = (plan.query ?? '')
      .toLowerCase()
      .split(/\s+/u)
      .filter((term) => term.length > 0);
    const matched: Array<{ row: RecordRow; score: number | null }> = [];
    for (const row of rows) {
      if (terms.length === 0) {
        matched.push({ row, score: null });
        continue;
      }
      const haystack = row.text.toLowerCase();
      let score = 0;
      let all = true;
      for (const term of terms) {
        let count = 0;
        let index = haystack.indexOf(term);
        while (index >= 0 && count < 64) {
          count += 1;
          index = haystack.indexOf(term, index + term.length);
        }
        if (count === 0) {
          all = false;
          break;
        }
        score += count;
      }
      if (all) matched.push({ row, score });
    }
    matched.sort((a, b) => {
      const scoreA = a.score ?? 0;
      const scoreB = b.score ?? 0;
      if (scoreA !== scoreB) return scoreB - scoreA;
      return b.row.created_at - a.row.created_at;
    });

    const hits: MemoryAdapterSearchHit[] = [];
    let acceptedBytes = 0;
    let budgetDropped = 0;
    for (const entry of matched) {
      if (hits.length >= plan.candidate_limit) {
        budgetDropped += 1;
        continue;
      }
      const bytes = entry.row.text_bytes;
      if (acceptedBytes + bytes > plan.output_bytes) {
        // 超预算条目整体跳过，不截断正文或否定条件。
        budgetDropped += 1;
        continue;
      }
      let representation: MemoryRepresentation;
      try {
        representation = JSON.parse(entry.row.representation_json) as MemoryRepresentation;
      } catch {
        continue;
      }
      hits.push({
        backend_ref: {
          space: request.space,
          provider_id: entry.row.record_id,
          provider_revision: String(entry.row.record_revision),
        },
        representation,
        source:
          entry.row.source_id !== null && entry.row.source_revision !== null
            ? { source_id: entry.row.source_id, source_revision: entry.row.source_revision }
            : null,
        origin_kind: entry.row.origin_kind,
        evidence:
          entry.row.evidence === null
            ? null
            : (entry.row.evidence as MemoryAdapterSearchHit['evidence']),
        score: entry.score,
      });
      acceptedBytes += bytes;
    }
    const exclusions: MemoryAdapterSearchExclusion[] = [];
    if (budgetDropped > 0) exclusions.push({ reason: 'budget', count: budgetDropped });
    return {
      status: hits.length > 0 ? 'ready' : 'empty',
      coverage: 'bounded',
      freshness: { as_of: this.#now(), backend_revision: String(partition.generation) },
      // 本后端保存准确字节；命中的表示就是保留时的表示。
      evidence_complete: true,
      hits,
      exclusions,
      reason: null,
    };
  }

  async remove(request: RemoveRequest): Promise<RemoveResult> {
    if (
      !validSpaceRef(request.space) ||
      !nonEmptyString(request.operation_key) ||
      !/^[0-9a-f]{64}$/iu.test(request.payload_sha256) ||
      !Array.isArray(request.targets) ||
      request.targets.length === 0
    ) {
      return { status: 'unsupported_granularity', purge: 'unknown', job_ref: null, reason: 'invalid_request' };
    }
    const partition = this.#requirePartition(request.space);
    if (!partition) {
      return { status: 'unavailable', purge: 'unknown', job_ref: null, reason: 'unavailable' };
    }
    const replay = this.#findOperation(partition.partition_key, request.operation_key);
    if (replay) {
      if (replay.payload_sha256 !== request.payload_sha256) {
        return { status: 'unsupported_granularity', purge: 'unknown', job_ref: null, reason: 'fenced' };
      }
      this.#touchOperation(replay);
      return JSON.parse(replay.result_json) as RemoveResult;
    }
    if (!request.targets.every(failureReasonForTarget)) {
      return { status: 'unsupported_granularity', purge: 'unsupported_granularity', job_ref: null, reason: 'unsupported' };
    }

    const at = this.#now();
    const operationId = await this.#operationId(partition.partition_key, request.operation_key);
    const apply = this.#db.transaction(() => {
      for (const target of request.targets) {
        const matches = this.#targetRows(partition.partition_key, target);
        for (const row of matches) {
          this.#db
            .prepare(
              `UPDATE local_memory_records
                  SET current_row = 0, removed_at = ?, text = ''
                WHERE record_id = ? AND removed_at IS NULL`,
            )
            .run(at, row.record_id);
          this.#db
            .prepare(
              `INSERT INTO local_memory_tombstones (partition_key, record_key, reason, created_at)
               VALUES (?, ?, 'remove', ?)
               ON CONFLICT (partition_key, record_key) DO NOTHING`,
            )
            .run(partition.partition_key, row.record_key, at);
        }
      }
    });
    apply();

    // 只有再次枚举确认没有可见行时才报告 purged；不把 SQL 影响行数当清除证据。
    let remaining = 0;
    for (const target of request.targets) {
      remaining += this.#targetRows(partition.partition_key, target).filter(
        (row) => row.removed_at === null,
      ).length;
    }
    const purge: MemoryPurgeState = remaining === 0 ? 'purged' : 'purge_pending';
    const result: RemoveResult = {
      status: 'accepted',
      purge,
      job_ref: {
        backend_binding_epoch: request.space.backend_binding_epoch,
        provider_job_id: operationId,
      },
      reason: null,
    };
    this.#recordOperation(
      partition.partition_key,
      request.operation_key,
      request.payload_sha256,
      'remove',
      result,
      at,
      operationId,
    );
    return result;
  }

  async jobStatus(request: JobStatusRequest): Promise<JobStatusResult> {
    if (!validSpaceRef(request.space) || !request.job_ref) {
      return this.#jobFailure('invalid_request');
    }
    if (request.job_ref.backend_binding_epoch !== request.space.backend_binding_epoch) {
      return this.#jobFailure('unknown');
    }
    const partition = this.#requirePartition(request.space);
    if (!partition) return this.#jobFailure('unknown');
    const operation = this.#db
      .prepare('SELECT * FROM local_memory_operations WHERE operation_id = ?')
      .get(request.job_ref.provider_job_id) as OperationRow | null;
    if (!operation || operation.partition_key !== partition.partition_key) {
      return this.#jobFailure('unknown');
    }
    const result = JSON.parse(operation.result_json) as RetainResult | RemoveResult;
    if (operation.kind === 'remove') {
      const purge = (result as RemoveResult).purge ?? 'unknown';
      return {
        state: 'completed',
        stage: 'write_handler_completed',
        purge,
        retryable: false,
        reason: null,
      };
    }
    return {
      state: 'completed',
      stage: 'observation_ready',
      purge: null,
      retryable: false,
      reason: null,
    };
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #partitionKey(space: MemorySpaceRef): Promise<string> {
    return sha256Hex(
      `local-memory|${space.space_id}|${space.ownership_epoch}|${space.backend_binding_epoch}`,
    );
  }

  #operationId(partitionKey: string, operationKey: string): Promise<string> {
    return sha256Hex(`local-op|${partitionKey}|${operationKey}`).then(
      (hash) => `lmo_${hash.slice(0, 40)}`,
    );
  }

  #backendRef(space: MemorySpaceRef, partition: PartitionRow): MemoryBackendRef {
    return {
      space,
      provider_id: partition.partition_key,
      provider_revision: String(partition.generation),
    };
  }

  /** 用唯一索引同步查找；partition_key 是 space/epoch 的稳定派生。 */
  #requirePartition(space: MemorySpaceRef): PartitionRow | null {
    return (
      (this.#db
        .prepare(
          `SELECT * FROM local_memory_partitions
            WHERE space_id = ? AND ownership_epoch = ? AND backend_binding_epoch = ?`,
        )
        .get(space.space_id, space.ownership_epoch, space.backend_binding_epoch) as PartitionRow | null) ??
      null
    );
  }

  #findOperation(partitionKey: string, operationKey: string): OperationRow | null {
    return (
      (this.#db
        .prepare(
          'SELECT * FROM local_memory_operations WHERE partition_key = ? AND operation_key = ?',
        )
        .get(partitionKey, operationKey) as OperationRow | null) ?? null
    );
  }

  #touchOperation(operation: OperationRow): void {
    this.#db
      .prepare('UPDATE local_memory_operations SET attempts = attempts + 1, updated_at = ? WHERE operation_id = ?')
      .run(this.#now(), operation.operation_id);
  }

  #recordOperation(
    partitionKey: string,
    operationKey: string,
    payloadSha256: string,
    kind: string,
    result: unknown,
    at: number,
    operationId = '',
  ): void {
    const id = operationId || `lmo_${crypto.randomUUID().replaceAll('-', '')}`;
    this.#db
      .prepare(
        `INSERT INTO local_memory_operations
           (operation_id, partition_key, operation_key, payload_sha256, kind, status,
            result_json, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'completed', ?, 1, ?, ?)
         ON CONFLICT (partition_key, operation_key) DO UPDATE
           SET attempts = attempts + 1, updated_at = excluded.updated_at`,
      )
      .run(id, partitionKey, operationKey, payloadSha256, kind, JSON.stringify(result), at, at);
  }

  #recordKey(
    item: RetainRequest['items'][number],
    source: MemorySourceRef | null,
  ): string {
    const representation = item.representation.representation;
    if (item.eligibility.kind === 'curated') {
      return `curated:${item.eligibility.curated_id}:${item.eligibility.revision}`;
    }
    const range =
      'range' in representation && representation.range
        ? `${representation.range.start}-${representation.range.end}`
        : '-';
    return [
      'representation',
      source?.source_id ?? 'none',
      source?.source_revision ?? 0,
      representation.representation_id,
      range,
    ].join(':');
  }

  #targetRows(partitionKey: string, target: MemoryAdapterRemoveTarget): RecordRow[] {
    if (target.kind === 'representation') {
      const where = ['partition_key = ?', 'representation_id = ?'];
      const params: Array<string | number> = [partitionKey, target.representation_id];
      if (target.range) {
        where.push('range_start = ?', 'range_end = ?');
        params.push(target.range.start, target.range.end);
      }
      return this.#db
        .prepare(`SELECT * FROM local_memory_records WHERE ${where.join(' AND ')}`)
        .all(...params) as RecordRow[];
    }
    if (target.kind === 'source_revision') {
      return this.#db
        .prepare(
          'SELECT * FROM local_memory_records WHERE partition_key = ? AND source_id = ? AND source_revision = ?',
        )
        .all(partitionKey, target.source.source_id, target.source.source_revision) as RecordRow[];
    }
    if (target.kind === 'partition') {
      // partition 级删除不在本适配器的精确清除能力内；调用方已拒绝。
      return [];
    }
    return this.#db
      .prepare(
        'SELECT * FROM local_memory_records WHERE partition_key = ? AND curated_id = ? AND curated_revision = ?',
      )
      .all(partitionKey, target.curated_id, target.revision) as RecordRow[];
  }

  #supportedPlan(plan: MemoryAdapterSearchPlan): boolean {
    const filters: MemoryAdapterHardFilters = plan.hard_filters ?? {};
    if ((filters.source_kinds?.length ?? 0) > 0) return false;
    if ((filters.room_ids?.length ?? 0) > 0) return false;
    if (
      filters.timezone !== undefined &&
      filters.timezone !== '' &&
      filters.timezone.toUpperCase() !== 'UTC'
    ) {
      return false;
    }
    if ((filters.origin_kinds ?? []).some((kind) => !isOriginKind(kind))) return false;
    if ((filters.source_ids ?? []).some((id) => !nonEmptyString(id))) return false;
    if (
      filters.time_field !== undefined &&
      filters.time_field !== 'created_at' &&
      filters.time_field !== 'submitted_at'
    ) {
      return false;
    }
    if (
      filters.time_from !== undefined &&
      (!Number.isSafeInteger(filters.time_from) || filters.time_from < 0)
    ) {
      return false;
    }
    if (
      filters.time_to !== undefined &&
      (!Number.isSafeInteger(filters.time_to) || filters.time_to < 0)
    ) {
      return false;
    }
    if (
      filters.time_from !== undefined &&
      filters.time_to !== undefined &&
      filters.time_from > filters.time_to
    ) {
      return false;
    }
    if (!Number.isSafeInteger(plan.candidate_limit) || plan.candidate_limit < 1) return false;
    if (!Number.isSafeInteger(plan.output_bytes) || plan.output_bytes < 1) return false;
    return true;
  }

  #retainFailure(status: RetainResult['status'], reason: RetainResult['reason']): RetainResult {
    return {
      status,
      job_ref: null,
      source_applied: false,
      derived_ready: false,
      reason,
    };
  }

  #searchFailure(status: SearchResult['status'], reason: SearchResult['reason']): SearchResult {
    return {
      status,
      coverage: 'unknown',
      freshness: { as_of: this.#now(), backend_revision: null },
      evidence_complete: false,
      hits: [],
      exclusions: reason === 'unsupported' ? [{ reason: 'unsupported_filter', count: 1 }] : [],
      reason,
    };
  }

  #jobFailure(reason: JobStatusResult['reason']): JobStatusResult {
    return {
      state: 'unknown',
      stage: 'unknown',
      purge: null,
      retryable: false,
      reason,
    };
  }
}

export function createLocalMemoryAdapter(options: LocalMemoryAdapterOptions): LocalMemoryAdapter {
  return new LocalMemoryAdapter(options);
}

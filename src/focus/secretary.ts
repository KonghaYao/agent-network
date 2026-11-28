/**
 * 四个秘书工具的领域实现。
 *
 * 授权只来自固定服务身份与 `attempt_ref`：owner 由作业推导，工具不接受
 * owner 参数。每次读取都按 owner 当前权限重算来源可读性；提交在单个
 * 幂等事务中写卡、证据、修订、候选状态与作业状态，重放返回同一回执。
 */

import { BusinessError } from '../contracts/errors';
import type {
  FocusColumn,
  FocusCommitInput,
  FocusCommitItem,
  FocusCommitReceipt,
  FocusCreateDecision,
  FocusDispositionDecision,
  FocusEvidenceReadItem,
  FocusEvidenceReadResult,
  FocusFindItem,
  FocusItemsFindResult,
  FocusJobCandidateView,
  FocusJobGetResult,
  FocusUpdateDecision,
} from '../contracts/focus';
import { LIMITS } from '../contracts/limits';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import { guardSql } from '../storage/guards';
import {
  operationsStatement,
  resolveReplay,
  runIdempotent,
} from '../storage/transactions/runner';
import { focusVisibleCounts, resolveEvidenceReads } from '../domain/focus/evidence';
import { focusUpdatedStatements } from '../domain/focus/notify';
import type {
  FocusBindingRow,
  FocusCandidateRow,
  FocusEvidenceRow,
  FocusItemRow,
  FocusJobRow,
} from '../domain/focus/types';
import { FOCUS_SERVICE_ACTOR_ID } from './service';

/** 秘书只能操作已派发的作业；queued 尚未获得远端会话与租约。 */
const SECRETARY_JOB_STATUSES = ['submitted', 'running', 'waiting'] as const;
const SECRETARY_JOB_SQL = SECRETARY_JOB_STATUSES.map((status) => `'${status}'`).join(', ');

const MAX_IN_IDS = 90;

interface JobContext {
  job: FocusJobRow;
  binding: FocusBindingRow;
  ownerName: string;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += MAX_IN_IDS) {
    result.push(items.slice(index, index + MAX_IN_IDS));
  }
  return result;
}

function dueAtMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new BusinessError('INVALID_ARGUMENT', 'due_at 必须是毫秒时间或 ISO 8601 时间');
  }
  return parsed;
}

/**
 * 按 attempt_ref 读取作业并校验授权。
 *
 * 作业存在、秘书与绑定一致、启用代次一致、状态活跃且租约未过期；任何
 * 一项不符都返回 STALE_ATTEMPT，不暴露作业是否曾经存在。
 */
async function requireJobContext(
  db: D1Database,
  attemptRef: string,
  options: { renewLease: boolean },
): Promise<JobContext> {
  const row = await db
    .prepare(
      `SELECT j.*, b.provisioning_key, b.session_id, b.root_session_id,
              b.status AS binding_status, b.generation AS binding_generation,
              b.event_from_seq AS binding_event_from_seq, b.enabled_at AS binding_enabled_at,
              b.paused_at AS binding_paused_at, b.created_at AS binding_created_at,
              b.updated_at AS binding_updated_at, b.owner_actor_id AS binding_owner,
              a.name AS owner_name
         FROM focus_jobs j
         JOIN focus_bindings b ON b.owner_actor_id = j.owner_actor_id
         LEFT JOIN actors a ON a.actor_id = j.owner_actor_id
        WHERE j.attempt_ref = ?`,
    )
    .bind(attemptRef)
    .first<
      FocusJobRow & {
        binding_status: FocusBindingRow['status'];
        binding_generation: number;
        binding_owner: string;
        provisioning_key: string;
        session_id: string | null;
        root_session_id: string | null;
        binding_event_from_seq: number;
        binding_enabled_at: number;
        binding_paused_at: number | null;
        binding_created_at: number;
        binding_updated_at: number;
        owner_name: string | null;
      }
    >();
  if (!row) throw new BusinessError('STALE_ATTEMPT', '作业尝试已失效');
  const job: FocusJobRow = {
    job_id: row.job_id,
    owner_actor_id: row.owner_actor_id,
    secretary_actor_id: row.secretary_actor_id,
    attempt_ref: row.attempt_ref,
    submission_key: row.submission_key,
    status: row.status,
    generation: row.generation,
    event_from_seq: row.event_from_seq,
    event_to_seq: row.event_to_seq,
    turn_id: row.turn_id,
    input_id: row.input_id,
    lease_until: row.lease_until,
    attempt_count: row.attempt_count,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  const binding: FocusBindingRow = {
    owner_actor_id: row.binding_owner,
    secretary_actor_id: row.secretary_actor_id,
    provisioning_key: row.provisioning_key,
    session_id: row.session_id,
    root_session_id: row.root_session_id,
    status: row.binding_status,
    generation: row.binding_generation,
    event_from_seq: row.binding_event_from_seq,
    enabled_at: row.binding_enabled_at,
    paused_at: row.binding_paused_at,
    created_at: row.binding_created_at,
    updated_at: row.binding_updated_at,
  };
  if (
    binding.status !== 'active' ||
    binding.generation !== job.generation ||
    binding.secretary_actor_id !== job.secretary_actor_id
  ) {
    throw new BusinessError('STALE_ATTEMPT', '作业尝试已失效');
  }
  if (!(SECRETARY_JOB_STATUSES as readonly string[]).includes(job.status)) {
    throw new BusinessError('STALE_ATTEMPT', '作业尝试已失效');
  }
  const now = nowMs();
  if (job.lease_until === null || job.lease_until <= now) {
    throw new BusinessError('STALE_ATTEMPT', '作业租约已过期');
  }
  if (options.renewLease) {
    const renewed = await db
      .prepare(
        `UPDATE focus_jobs SET lease_until = ?, updated_at = ?
          WHERE job_id = ? AND attempt_ref = ? AND status = ?
            AND lease_until IS NOT NULL AND lease_until > ?`,
      )
      .bind(
        now + LIMITS.focusJobLeaseMs,
        now,
        job.job_id,
        job.attempt_ref,
        job.status,
        now,
      )
      .run();
    if ((renewed.meta.changes ?? 0) === 0) {
      throw new BusinessError('STALE_ATTEMPT', '作业租约已过期');
    }
    job.lease_until = now + LIMITS.focusJobLeaseMs;
  }
  return { job, binding, ownerName: row.owner_name ?? '' };
}

async function assignedCandidates(
  db: D1Database,
  jobId: string,
  candidateIds?: string[],
): Promise<FocusCandidateRow[]> {
  if (candidateIds && candidateIds.length === 0) return [];
  const filters = ["job_id = ?", "state = 'assigned'"];
  const binds: string[] = [jobId];
  if (candidateIds) {
    filters.push(`candidate_id IN (${placeholders(candidateIds.length)})`);
    binds.push(...candidateIds);
  }
  const rows = await db
    .prepare(
      `SELECT * FROM focus_candidates
        WHERE ${filters.join(' AND ')}
        ORDER BY event_seq, candidate_id`,
    )
    .bind(...binds)
    .all<FocusCandidateRow>();
  return rows.results;
}

/** 候选 → 可读性重算所需的证据引用；正文与定位只在可读时返回。 */
function candidateEvidenceRow(
  owner: string,
  candidate: FocusCandidateRow,
): FocusEvidenceRow {
  return {
    evidence_id: candidate.candidate_id,
    item_id: 'focus_job_candidate',
    owner_actor_id: owner,
    source_kind: candidate.source_kind,
    source_key: candidate.source_key,
    room_id: candidate.room_id,
    message_id: candidate.message_id,
    delivery_id: candidate.delivery_id,
    source_revision: candidate.event_seq,
    purpose: 'candidate',
    occurred_at: 0,
    created_at: 0,
  };
}

export async function focusJobGet(
  db: D1Database,
  attemptRef: string,
): Promise<FocusJobGetResult> {
  const { job, ownerName } = await requireJobContext(db, attemptRef, { renewLease: true });
  const candidates = await assignedCandidates(db, job.job_id);
  const counts = await focusVisibleCounts(db, job.owner_actor_id);
  const views: FocusJobCandidateView[] = candidates.map((candidate) => ({
    candidate_id: candidate.candidate_id,
    source_kind: candidate.source_kind,
    room_id: candidate.room_id,
    message_id: candidate.message_id,
    delivery_id: candidate.delivery_id,
    reason: candidate.reason,
    event_seq: candidate.event_seq,
  }));
  return {
    job_id: job.job_id,
    attempt_ref: job.attempt_ref,
    owner_name: ownerName,
    generation: job.generation,
    event_from_seq: job.event_from_seq,
    event_to_seq: job.event_to_seq,
    status: job.status,
    candidates: views,
    counts,
  };
}

export async function focusEvidenceRead(
  db: D1Database,
  attemptRef: string,
  sourceIds: string[],
  limit?: number,
): Promise<FocusEvidenceReadResult> {
  const { job } = await requireJobContext(db, attemptRef, { renewLease: true });
  const wanted = [...new Set(sourceIds)].slice(0, limit ?? LIMITS.focusSecretaryEvidenceMax);
  const candidates = await assignedCandidates(db, job.job_id, wanted);
  if (candidates.length !== wanted.length) {
    throw new BusinessError('PERMISSION_DENIED', '来源不属于当前作业的候选范围');
  }
  const byId = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const reads = await resolveEvidenceReads(
    db,
    job.owner_actor_id,
    candidates.map((candidate) => candidateEvidenceRow(job.owner_actor_id, candidate)),
  );

  const items: FocusEvidenceReadItem[] = wanted.map((candidateId) => {
    const candidate = byId.get(candidateId) as FocusCandidateRow;
    const read = reads.get(candidateId);
    if (!read || read.readable !== true) {
      return {
        candidate_id: candidateId,
        source_kind: candidate.source_kind,
        readable: false,
        reason: 'source_unavailable',
      };
    }
    return {
      candidate_id: candidateId,
      source_kind: candidate.source_kind,
      readable: true,
      ...(read.roomId ? { room_id: read.roomId } : {}),
      ...(read.roomName !== undefined ? { room_name: read.roomName } : {}),
      ...(read.roomKind ? { room_kind: read.roomKind } : {}),
      ...(read.messageId ? { message_id: read.messageId } : {}),
      ...(read.senderId ? { sender_id: read.senderId } : {}),
      ...(read.senderName !== undefined ? { sender_name: read.senderName } : {}),
      ...(read.senderKind ? { sender_kind: read.senderKind } : {}),
      ...(read.createdAt !== undefined ? { created_at: String(read.createdAt) } : {}),
      ...(read.excerpt !== undefined ? { excerpt: read.excerpt } : {}),
      ...(read.deliveryId ? { delivery_id: read.deliveryId } : {}),
      ...(read.deliveryState ? { delivery_state: read.deliveryState } : {}),
      ...(read.deliveryAttempt !== undefined
        ? { delivery_attempt: read.deliveryAttempt }
        : {}),
    };
  });
  return { items };
}

export async function focusItemsFind(
  db: D1Database,
  attemptRef: string,
  input: { query?: string; sources?: string[] },
): Promise<FocusItemsFindResult> {
  const { job } = await requireJobContext(db, attemptRef, { renewLease: true });
  const owner = job.owner_actor_id;

  const sourceKeys = new Set<string>();
  if (input.sources && input.sources.length > 0) {
    const assigned = await assignedCandidates(db, job.job_id);
    const byCandidate = new Map(assigned.map((row) => [row.candidate_id, row]));
    const bySource = new Map(assigned.map((row) => [row.source_key, row]));
    for (const source of input.sources) {
      const candidate = source.startsWith('fcand_')
        ? byCandidate.get(source)
        : bySource.get(source);
      if (!candidate) {
        throw new BusinessError('PERMISSION_DENIED', '来源不属于当前作业的候选范围');
      }
      sourceKeys.add(candidate.source_key);
    }
  }

  const filters = ['owner_actor_id = ?'];
  const binds: Array<string | number> = [owner];
  if (input.query) {
    const pattern = `%${input.query.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
    filters.push(
      "(title LIKE ? ESCAPE '\\' OR next_step LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')",
    );
    binds.push(pattern, pattern, pattern);
  }
  if (sourceKeys.size > 0) {
    const keys = [...sourceKeys];
    filters.push(
      `EXISTS (SELECT 1 FROM focus_evidence fe
                WHERE fe.item_id = focus_items.item_id AND fe.owner_actor_id = ?
                  AND fe.source_key IN (${placeholders(keys.length)}))`,
    );
    binds.push(owner, ...keys);
  }
  const rows = await db
    .prepare(
      `SELECT * FROM focus_items WHERE ${filters.join(' AND ')}
        ORDER BY updated_at DESC, item_id DESC LIMIT ?`,
    )
    .bind(...binds, 60)
    .all<FocusItemRow>();

  const evidence = new Map<string, FocusEvidenceRow[]>();
  for (const ids of chunks(rows.results.map((row) => row.item_id))) {
    const found = await db
      .prepare(
        `SELECT * FROM focus_evidence
          WHERE owner_actor_id = ? AND item_id IN (${placeholders(ids.length)})`,
      )
      .bind(owner, ...ids)
      .all<FocusEvidenceRow>();
    for (const row of found.results) {
      const list = evidence.get(row.item_id) ?? [];
      list.push(row);
      evidence.set(row.item_id, list);
    }
  }
  const visible = new Set<string>();
  const restricted = new Set<string>();
  for (const [itemId, list] of evidence) {
    const reads = await resolveEvidenceReads(db, owner, list);
    for (const row of list) {
      if (reads.get(row.evidence_id)?.readable === true) visible.add(itemId);
      else restricted.add(itemId);
    }
  }
  const items: FocusFindItem[] = rows.results
    .filter((row) => visible.has(row.item_id))
    .slice(0, LIMITS.focusSecretaryFindMax)
    .map((row) => ({
      item_id: row.item_id,
      // 任一来源失权时遮蔽依赖证据的标题与下一步，避免借查重泄露私群内容。
      title: restricted.has(row.item_id) ? '' : row.title,
      column_key: row.column_key as FocusColumn,
      version: row.version,
      archived: row.archived_at !== null,
      next_step: restricted.has(row.item_id) ? '' : row.next_step,
    }));
  return { items };
}

interface EvidenceRef {
  candidate: FocusCandidateRow;
  purpose: string;
  occurredAt: number;
}

async function resolveEvidenceRefs(
  db: D1Database,
  job: FocusJobRow,
  refs: Array<{ candidate_id: string; purpose?: string }>,
): Promise<Map<string, EvidenceRef>> {
  const ids = [...new Set(refs.map((ref) => ref.candidate_id))];
  const candidates = await assignedCandidates(db, job.job_id, ids);
  if (candidates.length !== ids.length) {
    throw new BusinessError('PERMISSION_DENIED', '证据来源不属于当前作业的候选范围');
  }
  const reads = await resolveEvidenceReads(
    db,
    job.owner_actor_id,
    candidates.map((candidate) => candidateEvidenceRow(job.owner_actor_id, candidate)),
  );
  for (const candidate of candidates) {
    if (reads.get(candidate.candidate_id)?.readable !== true) {
      throw new BusinessError('PERMISSION_DENIED', '证据来源当前不可读');
    }
  }
  const occurred = new Map<number, number>();
  for (const seqs of chunks(candidates.map((candidate) => candidate.event_seq))) {
    const rows = await db
      .prepare(
        `SELECT event_seq, created_at FROM events WHERE event_seq IN (${placeholders(seqs.length)})`,
      )
      .bind(...seqs)
      .all<{ event_seq: number; created_at: number }>();
    for (const row of rows.results) occurred.set(row.event_seq, row.created_at);
  }
  const purposes = new Map(refs.map((ref) => [ref.candidate_id, ref.purpose ?? 'source']));
  const result = new Map<string, EvidenceRef>();
  for (const candidate of candidates) {
    result.set(candidate.candidate_id, {
      candidate,
      purpose: purposes.get(candidate.candidate_id) ?? 'source',
      occurredAt: occurred.get(candidate.event_seq) ?? 0,
    });
  }
  return result;
}

function evidenceInsert(
  db: D1Database,
  owner: string,
  itemId: string,
  evidence: EvidenceRef,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO focus_evidence
         (evidence_id, item_id, owner_actor_id, source_kind, source_key, room_id,
          message_id, delivery_id, source_revision, purpose, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, source_key, purpose) DO NOTHING`,
    )
    .bind(
      newId('fev'),
      itemId,
      owner,
      evidence.candidate.source_kind,
      evidence.candidate.source_key,
      evidence.candidate.room_id,
      evidence.candidate.message_id,
      evidence.candidate.delivery_id,
      evidence.candidate.event_seq,
      evidence.purpose,
      evidence.occurredAt,
      at,
    );
}

function revisionInsert(
  db: D1Database,
  decisionId: string,
  itemId: string,
  version: number,
  changes: Record<string, unknown>,
  reason: string,
  evidence: EvidenceRef[],
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO focus_revisions
         (revision_id, item_id, version, decision_id, changes_json, reason, evidence_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('frev'),
      itemId,
      version,
      decisionId,
      JSON.stringify(changes),
      reason,
      JSON.stringify(
        evidence.map((entry) => ({
          source_key: entry.candidate.source_key,
          purpose: entry.purpose,
          candidate_id: entry.candidate.candidate_id,
        })),
      ),
      at,
    );
}

function consumeCandidates(
  db: D1Database,
  jobId: string,
  candidateIds: string[],
  decision: string,
  at: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE focus_candidates
            SET state = 'consumed', decision = ?, updated_at = ?
          WHERE job_id = ? AND candidate_id IN (${placeholders(candidateIds.length)})
            AND state = 'assigned'`,
      )
      .bind(decision, at, jobId, ...candidateIds),
    // 并发提交或候选被其它决定占用时整批回滚；成功后本决定独占这些候选。
    db
      .prepare(
        guardSql(
          'focusStaleAttempt',
          `EXISTS (SELECT 1 FROM focus_candidates
                    WHERE job_id = ? AND candidate_id IN (${placeholders(candidateIds.length)})
                      AND (state <> 'consumed' OR decision IS NOT ?))`,
        ),
      )
      .bind(jobId, ...candidateIds, decision),
  ];
}

function skipCandidates(
  db: D1Database,
  jobId: string,
  candidateIds: string[],
  decision: string,
  at: number,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `UPDATE focus_candidates
            SET state = 'skipped', decision = ?, updated_at = ?
          WHERE job_id = ? AND candidate_id IN (${placeholders(candidateIds.length)})
            AND state = 'assigned'`,
      )
      .bind(decision, at, jobId, ...candidateIds),
    db
      .prepare(
        guardSql(
          'focusStaleAttempt',
          `EXISTS (SELECT 1 FROM focus_candidates
                    WHERE job_id = ? AND candidate_id IN (${placeholders(candidateIds.length)})
                      AND (state <> 'skipped' OR decision IS NOT ?))`,
        ),
      )
      .bind(jobId, ...candidateIds, decision),
  ];
}

export async function focusCommit(
  db: D1Database,
  input: FocusCommitInput,
): Promise<FocusCommitReceipt> {
  // attempt_ref 不参与业务哈希：新尝试重放同一个决定应返回同一回执。
  const payloadHash = await sha256Hex(
    stableStringify({
      decision_id: input.decision_id,
      complete: input.complete,
      decisions: input.decisions,
    }),
  );
  const replay = await resolveReplay(
    db,
    FOCUS_SERVICE_ACTOR_ID,
    input.decision_id,
    payloadHash,
  );
  if (replay.found) return replay.result as FocusCommitReceipt;

  const { job } = await requireJobContext(db, input.attempt_ref, { renewLease: true });
  const owner = job.owner_actor_id;
  const assigned = await assignedCandidates(db, job.job_id);
  const assignedIds = new Set(assigned.map((candidate) => candidate.candidate_id));

  const evidenceRefs: Array<{ candidate_id: string; purpose?: string }> = [];
  const disposition: FocusDispositionDecision[] = [];
  const updates: FocusUpdateDecision[] = [];
  const creates: FocusCreateDecision[] = [];
  const touchedItems = new Set<string>();
  // 一个候选只能归属一个决定；候选同时被忽略或分给两张卡会整批拒绝。
  const evidenceOwners = new Map<string, string>();
  const dispositionOwners = new Map<string, string>();

  for (const [index, decision] of input.decisions.entries()) {
    const decisionKey = `${index}:${decision.type}`;
    if (decision.type === 'create') {
      creates.push(decision);
      for (const ref of decision.evidence) {
        if (!assignedIds.has(ref.candidate_id)) {
          throw new BusinessError('PERMISSION_DENIED', '证据来源不属于当前作业的候选范围');
        }
        const ownerKey = evidenceOwners.get(ref.candidate_id);
        if (ownerKey !== undefined && ownerKey !== decisionKey) {
          throw new BusinessError('INVALID_ARGUMENT', '同一候选不能用于多个决定');
        }
        evidenceOwners.set(ref.candidate_id, decisionKey);
        evidenceRefs.push(ref);
      }
    } else if (decision.type === 'update') {
      if (touchedItems.has(decision.item_id)) {
        throw new BusinessError('INVALID_ARGUMENT', '同一提交不能重复更新同一张卡');
      }
      touchedItems.add(decision.item_id);
      updates.push(decision);
      for (const ref of decision.evidence ?? []) {
        if (!assignedIds.has(ref.candidate_id)) {
          throw new BusinessError('PERMISSION_DENIED', '证据来源不属于当前作业的候选范围');
        }
        const ownerKey = evidenceOwners.get(ref.candidate_id);
        if (ownerKey !== undefined && ownerKey !== decisionKey) {
          throw new BusinessError('INVALID_ARGUMENT', '同一候选不能用于多个决定');
        }
        evidenceOwners.set(ref.candidate_id, decisionKey);
        evidenceRefs.push(ref);
      }
    } else {
      for (const candidateId of decision.candidate_ids) {
        if (!assignedIds.has(candidateId)) {
          throw new BusinessError('PERMISSION_DENIED', '候选不属于当前作业');
        }
        if (evidenceOwners.has(candidateId)) {
          throw new BusinessError('INVALID_ARGUMENT', '同一候选不能同时作为证据与忽略项');
        }
        const ownerKey = dispositionOwners.get(candidateId);
        if (ownerKey !== undefined && ownerKey !== decisionKey) {
          throw new BusinessError('INVALID_ARGUMENT', '同一候选不能用于多个决定');
        }
        dispositionOwners.set(candidateId, decisionKey);
      }
      disposition.push(decision);
    }
  }

  // 版本与归档屏障在任何写入与取证前整批校验：归档优先于证据失权。
  const itemRows = new Map<string, FocusItemRow>();
  if (updates.length > 0) {
    const ids = updates.map((update) => update.item_id);
    for (const part of chunks(ids)) {
      const rows = await db
        .prepare(
          `SELECT * FROM focus_items
            WHERE owner_actor_id = ? AND item_id IN (${placeholders(part.length)})`,
        )
        .bind(owner, ...part)
        .all<FocusItemRow>();
      for (const row of rows.results) itemRows.set(row.item_id, row);
    }
    for (const update of updates) {
      const row = itemRows.get(update.item_id);
      if (!row) throw new BusinessError('NOT_FOUND', '事项不存在或当前不可见');
      if (row.archived_at !== null) {
        throw new BusinessError('CONFLICT', '事项已归档，不能再更新', {
          reason: 'focus_archived',
        });
      }
      if (row.version !== update.expected_version) {
        throw new BusinessError('CONFLICT', '事项版本已变化，请刷新后重试', {
          expected_version: update.expected_version,
          actual_version: row.version,
        });
      }
    }
  }

  const evidence = await resolveEvidenceRefs(db, job, evidenceRefs);

  const coveredIds = new Set<string>();
  for (const ref of evidenceRefs) coveredIds.add(ref.candidate_id);
  for (const decision of disposition) {
    for (const candidateId of decision.candidate_ids) coveredIds.add(candidateId);
  }
  if (input.complete) {
    const uncovered = assigned.filter((candidate) => !coveredIds.has(candidate.candidate_id));
    if (uncovered.length > 0) {
      throw new BusinessError(
        'INVALID_ARGUMENT',
        'complete=true 时必须覆盖全部候选：使用 evidence 或 ignore/pending',
        { uncovered: uncovered.length },
      );
    }
  }

  const at = nowMs();
  const statements: D1PreparedStatement[] = [];
  const receiptItems: FocusCommitItem[] = [];
  const ignored: string[] = [];
  const pending: string[] = [];

  for (const decision of creates) {
    if (decision.evidence.length === 0) {
      throw new BusinessError('INVALID_ARGUMENT', '新建事项必须至少提供一条可读证据');
    }
    const itemId = `fit_${crypto.randomUUID()}`;
    const dueAt = dueAtMs(decision.due_at);
    statements.push(
      db
        .prepare(
          `INSERT INTO focus_items
             (item_id, owner_actor_id, secretary_actor_id, title, column_key, next_step,
              waiting_on, due_at, due_text, summary, version, archived_at, archived_by,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)`,
        )
        .bind(
          itemId,
          owner,
          job.secretary_actor_id,
          decision.title,
          decision.column_key,
          decision.next_step ?? '',
          decision.waiting_on ?? null,
          dueAt,
          decision.due_text ?? null,
          decision.summary ?? '',
          at,
          at,
        ),
    );
    for (const ref of decision.evidence) {
      const entry = evidence.get(ref.candidate_id);
      if (!entry) throw new BusinessError('PERMISSION_DENIED', '证据来源当前不可读');
      statements.push(evidenceInsert(db, owner, itemId, entry, at));
    }
    statements.push(
      revisionInsert(
        db,
        input.decision_id,
        itemId,
        1,
        {
          title: decision.title,
          column_key: decision.column_key,
          next_step: decision.next_step ?? '',
          waiting_on: decision.waiting_on ?? null,
          due_at: dueAt,
          due_text: decision.due_text ?? null,
          summary: decision.summary ?? '',
        },
        '',
        decision.evidence
          .map((ref) => evidence.get(ref.candidate_id))
          .filter((entry): entry is EvidenceRef => entry !== undefined),
        at,
      ),
      ...consumeCandidates(
        db,
        job.job_id,
        decision.evidence.map((ref) => ref.candidate_id),
        `create:${itemId}`,
        at,
      ),
      ...focusUpdatedStatements(db, {
        ownerActorId: owner,
        change: 'created',
        itemId,
        version: 1,
        eventKey: `focus_updated:${itemId}:1`,
        at,
      }),
    );
    receiptItems.push({
      item_id: itemId,
      version: 1,
      column_key: decision.column_key,
      archived: false,
    });
  }

  for (const decision of updates) {
    const current = itemRows.get(decision.item_id) as FocusItemRow;
    const version = current.version + 1;
    const changes = decision.changes ?? {};
    const next = {
      title: changes.title ?? current.title,
      column_key: changes.column_key ?? current.column_key,
      next_step: changes.next_step ?? current.next_step,
      waiting_on:
        'waiting_on' in changes ? (changes.waiting_on ?? null) : current.waiting_on,
      due_at: 'due_at' in changes ? dueAtMs(changes.due_at) : current.due_at,
      due_text: 'due_text' in changes ? (changes.due_text ?? null) : current.due_text,
      summary: changes.summary ?? current.summary,
    };
    statements.push(
      db
        .prepare(
          `UPDATE focus_items
              SET title = ?, column_key = ?, next_step = ?, waiting_on = ?, due_at = ?,
                  due_text = ?, summary = ?, version = ?, updated_at = ?
            WHERE item_id = ? AND owner_actor_id = ? AND version = ? AND archived_at IS NULL`,
        )
        .bind(
          next.title,
          next.column_key,
          next.next_step,
          next.waiting_on,
          next.due_at,
          next.due_text,
          next.summary,
          version,
          at,
          decision.item_id,
          owner,
          decision.expected_version,
        ),
      db
        .prepare(
          guardSql(
            'focusStaleAttempt',
            'NOT EXISTS (SELECT 1 FROM focus_items WHERE item_id = ? AND owner_actor_id = ? AND version = ?)',
          ),
        )
        .bind(decision.item_id, owner, version),
      // 归档与提交并发时整批拒绝（错误码保持 CONFLICT）。
      db
        .prepare(
          guardSql(
            'focusArchiveConflict',
            'EXISTS (SELECT 1 FROM focus_items WHERE item_id = ? AND owner_actor_id = ? AND archived_at IS NOT NULL)',
          ),
        )
        .bind(decision.item_id, owner),
    );
    for (const ref of decision.evidence ?? []) {
      const entry = evidence.get(ref.candidate_id);
      if (!entry) throw new BusinessError('PERMISSION_DENIED', '证据来源当前不可读');
      statements.push(evidenceInsert(db, owner, decision.item_id, entry, at));
    }
    statements.push(
      revisionInsert(
        db,
        input.decision_id,
        decision.item_id,
        version,
        { ...changes, due_at: next.due_at },
        '',
        (decision.evidence ?? [])
          .map((ref) => evidence.get(ref.candidate_id))
          .filter((entry): entry is EvidenceRef => entry !== undefined),
        at,
      ),
    );
    if ((decision.evidence ?? []).length > 0) {
      statements.push(
        ...consumeCandidates(
          db,
          job.job_id,
          (decision.evidence ?? []).map((ref) => ref.candidate_id),
          `update:${decision.item_id}`,
          at,
        ),
      );
    }
    statements.push(
      ...focusUpdatedStatements(db, {
        ownerActorId: owner,
        change: 'updated',
        itemId: decision.item_id,
        version,
        eventKey: `focus_updated:${decision.item_id}:${version}`,
        at,
      }),
    );
    receiptItems.push({
      item_id: decision.item_id,
      version,
      column_key: next.column_key as FocusColumn,
      archived: false,
    });
  }

  for (const decision of disposition) {
    statements.push(
      ...skipCandidates(
        db,
        job.job_id,
        decision.candidate_ids,
        decision.type,
        at,
      ),
    );
    if (decision.type === 'ignore') ignored.push(...decision.candidate_ids);
    else pending.push(...decision.candidate_ids);
  }

  const nextJobStatus = input.complete ? 'completed' : 'running';
  if (input.complete) {
    // 覆盖检查在批次内重做一次，防止并发提交后仍有 assigned 候选。
    statements.push(
      db
        .prepare(
          guardSql(
            'focusStaleAttempt',
            `EXISTS (SELECT 1 FROM focus_candidates WHERE job_id = ? AND state = 'assigned')`,
          ),
        )
        .bind(job.job_id),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE focus_jobs
            SET status = ?, lease_until = ?, last_error = NULL, updated_at = ?
          WHERE job_id = ? AND attempt_ref = ? AND status = ?
            AND lease_until > ?`,
      )
      .bind(
        nextJobStatus,
        input.complete ? null : at + LIMITS.focusJobLeaseMs,
        at,
        job.job_id,
        job.attempt_ref,
        job.status,
        at,
      ),
  );
  statements.push(
    db
      .prepare(
        guardSql(
          'focusStaleAttempt',
          `NOT EXISTS (SELECT 1 FROM focus_jobs WHERE job_id = ? AND attempt_ref = ?
             AND status = ?)`,
        ),
      )
      .bind(job.job_id, job.attempt_ref, nextJobStatus),
  );
  statements.push(
    db
      .prepare(
        guardSql(
          'focusStaleAttempt',
          `NOT EXISTS (SELECT 1 FROM focus_bindings b JOIN focus_jobs j ON j.owner_actor_id = b.owner_actor_id
             WHERE j.job_id = ? AND b.status = 'active' AND b.generation = j.generation
               AND b.secretary_actor_id = j.secretary_actor_id)`,
        ),
      )
      .bind(job.job_id),
  );

  const receipt: FocusCommitReceipt = {
    decision_id: input.decision_id,
    job_id: job.job_id,
    complete: input.complete,
    job_status: nextJobStatus,
    items: receiptItems,
    ignored,
    pending,
    covered: coveredIds.size,
  };

  return (await runIdempotent(db, {
    actorId: FOCUS_SERVICE_ACTOR_ID,
    requestId: input.decision_id,
    payloadHash,
    result: receipt,
    build: (resultJson) => [
      operationsStatement(db, FOCUS_SERVICE_ACTOR_ID, input.decision_id, payloadHash, resultJson, at),
      ...statements,
    ],
  })) as FocusCommitReceipt;
}

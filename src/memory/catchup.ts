/**
 * MF11：按任务/召唤补读（catch-up）。
 *
 * 补读固定本轮 H，只选择当前任务必要历史与预算内背景；scan cursor 只记录
 * 候选扫描位置，selected 也不等于已消费。未读集合不会自动变成待办、事件、
 * 未读数或 delivery。真正的个人经历仍要等 SubmittedInputManifest + receipt。
 */
import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { LIMITS } from '../contracts/limits';
import { getMember, getRoom } from '../storage/queries';
import { newId, nowMs, sha256Hex, stableStringify } from '../storage/db';
import type { D1Like } from '../storage/queries';
import {
  isValidByteRange,
  type MemoryCatchupBudget,
  type MemoryCatchupPage,
  type MemoryCatchupPlan,
  type MemoryCatchupPlanItem,
  type MemoryCatchupSnapshot,
  type MemoryCatchupStatus,
  type MemorySourceSelection,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from './contracts';
import {
  authorizeSourceRead,
  requireCurrentMemorySpace,
  roomAccessVersion,
} from './access';
import { getSource, runMemoryBatch, sourceMutationStatements } from './store';
import { loadRepresentationExact } from './experience';
import { memoryRepresentationInsertStatements } from './representation-statements';
import { historyBoundary, visibleMessage } from '../domain/room-history';
import type { MemoryRepresentationRow, MemorySourceRow } from './rows';

export interface MemoryCatchupStoreOptions {
  instanceId: string;
  now?: number;
}

interface MemoryCatchupPlanRow {
  plan_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  room_id: string;
  member_generation: number;
  upper_bound: number;
  query: string;
  status: MemoryCatchupStatus;
  budget_json: string;
  scan_cursor_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  request_key: string | null;
  request_sha256: string | null;
  policy_revision: number;
  member_seq: number;
  joined_seq: number;
  snapshot_sha256: string | null;
}

interface MemoryCatchupItemRow {
  plan_id: string;
  item_index: number;
  message_id: string;
  created_seq: number;
  selection_state: 'selected' | 'not_selected' | 'missing';
  reason: string | null;
}

interface MemoryMessageRow {
  message_id: string;
  room_id: string;
  sender_id: string;
  created_seq: number;
  body: string;
  body_bytes: number;
  created_at: number;
  reply_to: string | null;
}

export interface MemoryPlanCatchupInput {
  instanceId: string;
  agentId: string;
  space: MemorySpaceRef;
  roomId: string;
  query: string;
  requiredMessageIds?: readonly string[];
  currentMessageId?: string | null;
  budget: MemoryCatchupBudget;
  /** 同一请求 key 只能对应同一轮固定快照；不同预算/问题必须换 key。 */
  requestKey: string;
  now?: number;
}

const MAX_CATCHUP_SCAN = 500;
const MAX_CATCHUP_SELECTED = 50;

function clampBudget(budget: MemoryCatchupBudget): MemoryCatchupBudget {
  return {
    candidate_limit: Math.max(1, Math.min(budget.candidate_limit, MAX_CATCHUP_SCAN)),
    selected_limit: Math.max(1, Math.min(budget.selected_limit, MAX_CATCHUP_SELECTED)),
    output_bytes: Math.max(0, Math.min(budget.output_bytes, 4 * 1024 * 1024)),
  };
}

function parseBudget(json: string): MemoryCatchupBudget {
  try {
    const value = JSON.parse(json) as Partial<MemoryCatchupBudget>;
    return clampBudget({
      candidate_limit: Number(value.candidate_limit ?? 50),
      selected_limit: Number(value.selected_limit ?? 10),
      output_bytes: Number(value.output_bytes ?? 64 * 1024),
    });
  } catch {
    return { candidate_limit: 50, selected_limit: 10, output_bytes: 64 * 1024 };
  }
}

function parseScanCursor(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function planRowToPlan(
  row: MemoryCatchupPlanRow,
  space: MemorySpaceRef,
  items: readonly MemoryCatchupPlanItem[],
): MemoryCatchupPlan {
  return {
    plan_id: row.plan_id,
    space,
    agent_actor_id: row.agent_actor_id,
    room_id: row.room_id,
    snapshot: {
      upper_bound: row.upper_bound,
      member_generation: row.member_generation,
      policy_revision: row.policy_revision,
      member_seq: row.member_seq,
      joined_seq: row.joined_seq,
    },
    query: row.query,
    status: row.status,
    budget: parseBudget(row.budget_json),
    items,
    scan_cursor: row.scan_cursor_json,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

async function itemsForPlan(
  db: D1Like,
  planId: string,
): Promise<readonly MemoryCatchupPlanItem[]> {
  const rows = await db
    .prepare('SELECT * FROM memory_catchup_items WHERE plan_id = ? ORDER BY item_index')
    .bind(planId)
    .all<MemoryCatchupItemRow>();
  return rows.results.map((row) => ({
    message_id: row.message_id,
    created_seq: row.created_seq,
    selection_state: row.selection_state,
    reason: row.reason,
  }));
}

async function loadPlanRow(
  db: D1Like,
  planId: string,
): Promise<MemoryCatchupPlanRow | null> {
  return db
    .prepare('SELECT * FROM memory_catchup_plans WHERE plan_id = ?')
    .bind(planId)
    .first<MemoryCatchupPlanRow>();
}

function snapshotMatches(
  row: MemoryCatchupPlanRow,
  current: { member_generation: number; policy_revision: number; member_seq: number },
): boolean {
  return (
    row.member_generation === current.member_generation &&
    row.policy_revision === current.policy_revision &&
    row.member_seq === current.member_seq
  );
}

function scanScope(planId: string): string {
  return `memory:catchup-scan:${planId}`;
}

/**
 * 生成固定快照的补读计划。
 *
 * 同一个 requestKey 重复调用返回原计划；预算/问题/成员代次变化后复用同一
 * key 会冲突，调用方必须显式新建一轮。
 */
export async function planCatchup(
  db: D1Like,
  input: MemoryPlanCatchupInput,
): Promise<MemoryCatchupPlan> {
  const at = input.now ?? nowMs();
  const budget = clampBudget(input.budget);
  const required = [
    ...(input.currentMessageId ? [input.currentMessageId] : []),
    ...(input.requiredMessageIds ?? []),
  ].filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);
  const context = await requireCurrentMemorySpace(db, {
    agentId: input.agentId,
    instanceId: input.instanceId,
    expected: input.space,
    roomIds: [input.roomId],
    at,
  });
  const room = await getRoom(db, input.roomId);
  const member = await getMember(db, input.roomId, input.agentId);
  if (!room || !member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  const scoped = await roomAccessVersion(db, input.roomId, input.agentId);
  if (!scoped) {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  const boundary = historyBoundary(room, member);
  const upperBound = boundary.toSeq === null ? room.head_seq : Math.min(room.head_seq, boundary.toSeq);
  const snapshot: MemoryCatchupSnapshot = {
    upper_bound: upperBound,
    member_generation: scoped.member_generation,
    policy_revision: scoped.policy_revision,
    member_seq: scoped.member_seq,
    joined_seq: scoped.joined_seq,
  };
  const requestSha = await sha256Hex(
    stableStringify({
      room_id: input.roomId,
      query: input.query,
      required,
      budget,
      snapshot,
    }),
  );
  const existing = await db
    .prepare(
      `SELECT * FROM memory_catchup_plans
        WHERE space_id = ? AND agent_actor_id = ? AND request_key = ?`,
    )
    .bind(context.space.space_id, input.agentId, input.requestKey)
    .first<MemoryCatchupPlanRow>();
  if (existing) {
    if (existing.request_sha256 !== requestSha) {
      throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一补读请求 key 绑定了不同问题/预算/快照', {
        plan_id: existing.plan_id,
      });
    }
    return planRowToPlan(existing, context.space, await itemsForPlan(db, existing.plan_id));
  }

  const planned = new Set<string>();
  const items: Array<MemoryCatchupPlanItem & { item_index: number }> = [];
  let missingRequired = false;
  let budgetExceeded = false;
  let selectedCount = 0;
  let selectedBytes = 0;

  for (const messageId of required) {
    planned.add(messageId);
    const message = await db
      .prepare('SELECT * FROM messages WHERE room_id = ? AND message_id = ?')
      .bind(input.roomId, messageId)
      .first<MemoryMessageRow>();
    if (
      !message ||
      !visibleMessage(message, boundary) ||
      message.created_seq > upperBound
    ) {
      missingRequired = true;
      items.push({
        item_index: items.length,
        message_id: messageId,
        created_seq: message?.created_seq ?? 0,
        selection_state: 'missing',
        reason: 'missing_required',
      });
      continue;
    }
    if (selectedCount >= budget.selected_limit || selectedBytes + message.body_bytes > budget.output_bytes) {
      budgetExceeded = true;
    }
    selectedCount += 1;
    selectedBytes += message.body_bytes;
    items.push({
      item_index: items.length,
      message_id: message.message_id,
      created_seq: message.created_seq,
      selection_state: 'selected',
      reason: messageId === input.currentMessageId ? 'current_input' : 'required',
    });
  }

  const candidates = await db
    .prepare(
      `SELECT * FROM messages
        WHERE room_id = ? AND created_seq >= ? AND created_seq <= ?
        ORDER BY created_seq DESC
        LIMIT ?`,
    )
    .bind(input.roomId, boundary.fromSeq, upperBound, budget.candidate_limit + 1)
    .all<MemoryMessageRow>();
  const candidatePage = candidates.results.slice(0, budget.candidate_limit);
  const scanTruncated = candidates.results.length > budget.candidate_limit;
  for (const message of candidatePage) {
    if (planned.has(message.message_id)) continue;
    planned.add(message.message_id);
    if (!visibleMessage(message, boundary)) continue;
    const fits =
      selectedCount < budget.selected_limit &&
      selectedBytes + message.body_bytes <= budget.output_bytes;
    if (fits) {
      selectedCount += 1;
      selectedBytes += message.body_bytes;
      items.push({
        item_index: items.length,
        message_id: message.message_id,
        created_seq: message.created_seq,
        selection_state: 'selected',
        reason: 'recent_context',
      });
    } else {
      budgetExceeded = true;
      items.push({
        item_index: items.length,
        message_id: message.message_id,
        created_seq: message.created_seq,
        selection_state: 'not_selected',
        reason: 'budget',
      });
    }
  }

  const lastScanned = candidatePage.at(-1);
  let scanCursor: string | null = null;
  if (scanTruncated && lastScanned) {
    scanCursor = JSON.stringify({
      v: 1,
      upper_bound: upperBound,
      member_generation: scoped.member_generation,
      policy_revision: scoped.policy_revision,
      before_seq: lastScanned.created_seq - 1,
      reason: 'scan_limit',
    });
  }
  const status: MemoryCatchupStatus = missingRequired
    ? 'missing_required'
    : budgetExceeded || scanCursor !== null
      ? 'partial'
      : 'ready';
  const planId = newId('mcp');
  const expiresAt = at + LIMITS.memoryCatchupTtlMs;
  const snapshotSha = await sha256Hex(stableStringify(snapshot));
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO memory_catchup_plans
           (plan_id, space_id, ownership_epoch, agent_actor_id, room_id,
            member_generation, upper_bound, query, status, budget_json,
            scan_cursor_json, created_at, updated_at, expires_at, request_key,
            request_sha256, policy_revision, member_seq, joined_seq, snapshot_sha256)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_catchup_plans
             WHERE space_id = ? AND agent_actor_id = ? AND request_key = ?
          )`,
      )
      .bind(
        planId,
        context.space.space_id,
        context.space.ownership_epoch,
        input.agentId,
        input.roomId,
        scoped.member_generation,
        upperBound,
        input.query,
        status,
        JSON.stringify(budget),
        scanCursor,
        at,
        at,
        expiresAt,
        input.requestKey,
        requestSha,
        scoped.policy_revision,
        scoped.member_seq,
        scoped.joined_seq,
        snapshotSha,
        context.space.space_id,
        input.agentId,
        input.requestKey,
      ),
  ];
  for (const item of items) {
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_catchup_items
             (plan_id, item_index, message_id, created_seq, selection_state, reason)
           SELECT ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM memory_catchup_items WHERE plan_id = ? AND item_index = ?
            )`,
        )
        .bind(
          planId,
          item.item_index,
          item.message_id,
          item.created_seq,
          item.selection_state,
          item.reason,
          planId,
          item.item_index,
        ),
    );
  }
  try {
    await runMemoryBatch(db, statements);
  } catch (error) {
    // 并发同 requestKey 由唯一索引兜底；只有完全相同的请求才复用。
    const raced = await db
      .prepare(
        `SELECT * FROM memory_catchup_plans
          WHERE space_id = ? AND agent_actor_id = ? AND request_key = ?`,
      )
      .bind(context.space.space_id, input.agentId, input.requestKey)
      .first<MemoryCatchupPlanRow>();
    if (!raced || raced.request_sha256 !== requestSha) throw error;
    return planRowToPlan(raced, context.space, await itemsForPlan(db, raced.plan_id));
  }
  const stored = await db
    .prepare(
      `SELECT * FROM memory_catchup_plans
        WHERE space_id = ? AND agent_actor_id = ? AND request_key = ?`,
    )
    .bind(context.space.space_id, input.agentId, input.requestKey)
    .first<MemoryCatchupPlanRow>();
  if (!stored) {
    throw new BusinessError('MEMORY_UNAVAILABLE', '补读计划写入后无法读取');
  }
  if (stored.request_sha256 !== requestSha) {
    throw new BusinessError('IDEMPOTENCY_CONFLICT', '同一补读请求 key 绑定了不同内容', {
      plan_id: stored.plan_id,
    });
  }
  return planRowToPlan(stored, context.space, await itemsForPlan(db, stored.plan_id));
}

export interface MemoryCatchupPageInput {
  instanceId: string;
  planId: string;
  agentId: string;
  space: MemorySpaceRef;
  limit?: number;
  cursor?: string | null;
  now?: number;
}

/**
 * 计划项分页。
 *
 * 新消息不会进入旧计划；成员代次/策略/受众变化时返回 expired 且不返回条目，
 * 避免用旧快照泄露当前无权内容。
 */
export async function getCatchupPage(
  db: D1Like,
  input: MemoryCatchupPageInput,
): Promise<MemoryCatchupPage> {
  const at = input.now ?? nowMs();
  await requireCurrentMemorySpace(db, {
    agentId: input.agentId,
    instanceId: input.instanceId,
    expected: input.space,
    at,
  });
  const row = await loadPlanRow(db, input.planId);
  if (!row) {
    throw new BusinessError('NOT_FOUND', '补读计划不存在');
  }
  if (
    row.space_id !== input.space.space_id ||
    row.ownership_epoch !== input.space.ownership_epoch ||
    row.agent_actor_id !== input.agentId
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '补读计划不属于当前空间', {
      reason: 'plan_scope_mismatch',
    });
  }
  const current = await roomAccessVersion(db, row.room_id, input.agentId);
  const snapshot: MemoryCatchupSnapshot = {
    upper_bound: row.upper_bound,
    member_generation: row.member_generation,
    policy_revision: row.policy_revision,
    member_seq: row.member_seq,
    joined_seq: row.joined_seq,
  };
  if (
    !current ||
    !snapshotMatches(row, current) ||
    (row.expires_at !== null && row.expires_at < at)
  ) {
    return {
      plan_id: row.plan_id,
      status: 'expired',
      snapshot,
      items: [],
      next_cursor: null,
      has_more: false,
    };
  }
  const scope = `memory:catchup:${row.plan_id}`;
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const all = await itemsForPlan(db, row.plan_id);
  const start = cursor?.seq ?? 0;
  const pageItems = all.slice(start, start + limit);
  const hasMore = start + limit < all.length;
  return {
    plan_id: row.plan_id,
    status: row.status,
    snapshot,
    items: pageItems,
    next_cursor: hasMore
      ? encodeCursor({
          v: 1,
          scope,
          dir: 'after',
          seq: start + pageItems.length,
          snapshot: row.upper_bound,
        })
      : null,
    has_more: hasMore,
  };
}

export interface MemoryCatchupPrepared {
  plan_id: string;
  selections: readonly MemorySourceSelection[];
  missing: readonly { message_id: string; reason: string }[];
}

async function ensureMessageSource(
  db: D1Like,
  input: {
    instanceId: string;
    message: MemoryMessageRow;
    roomId: string;
    member: { member_generation: number; joined_seq: number; joined_at: number };
    boundary: ReturnType<typeof historyBoundary>;
    archiveHeadSeq: number | null;
    now: number;
  },
): Promise<MemorySourceRow> {
  const sourceKey = `message:${input.message.message_id}`;
  const existing = await db
    .prepare(
      `SELECT * FROM memory_sources
        WHERE instance_id = ? AND source_key = ? AND state = 'active' LIMIT 1`,
    )
    .bind(input.instanceId, sourceKey)
    .first<MemorySourceRow>();
  if (existing) return existing;
  const sourceId = newId('msrc');
  const contentSha = input.message.body.length > 0 ? await sha256Hex(input.message.body) : null;
  try {
    await runMemoryBatch(
      db,
      sourceMutationStatements(db, {
        instanceId: input.instanceId,
        sourceId,
        sourceKey,
        sourceKind: 'message',
        businessRefKind: 'message',
        businessRefJson: JSON.stringify({
          message_id: input.message.message_id,
          created_seq: input.message.created_seq,
        }),
        originRoomId: input.roomId,
        originMemberGeneration: input.member.member_generation,
        originPolicyRevision: input.boundary.policyRevision,
        originJoinedSeq: input.member.joined_seq,
        originJoinedAt: input.member.joined_at,
        originArchiveHeadSeq: input.archiveHeadSeq,
        originSeq: input.message.created_seq,
        originCreatedAt: input.message.created_at,
        authorActorId: input.message.sender_id,
        revision: 1,
        contentText: input.message.body,
        contentSha256: contentSha,
        contentBytes: input.message.body_bytes,
        now: input.now,
      }),
    );
  } catch {
    const raced = await db
      .prepare(
        `SELECT * FROM memory_sources
          WHERE instance_id = ? AND source_key = ? AND state = 'active' LIMIT 1`,
      )
      .bind(input.instanceId, sourceKey)
      .first<MemorySourceRow>();
    if (!raced) throw new BusinessError('MEMORY_UNAVAILABLE', '补读来源登记失败');
    return raced;
  }
  const stored = await getSource(db, sourceId, 1);
  if (!stored) throw new BusinessError('MEMORY_UNAVAILABLE', '补读来源登记后无法读取');
  return stored;
}

/**
 * 消费计划中的 selected 项，生成 SourceSelection。
 *
 * 仍不接纳经历；selection 只是下一步 prepare/manifest 的候选。重复调用使用
 * 稳定 selection ID 并复用/续期，不重复制造选择。
 */
export async function prepareCatchupSelections(
  db: D1Like,
  input: MemoryCatchupStoreOptions & {
    planId: string;
    agentId: string;
    space: MemorySpaceRef;
    targetScope: MemoryTargetScope;
    messageIds?: readonly string[];
  },
): Promise<MemoryCatchupPrepared> {
  const at = input.now ?? nowMs();
  const context = await requireCurrentMemorySpace(db, {
    agentId: input.agentId,
    instanceId: input.instanceId,
    expected: input.space,
    at,
  });
  const row = await loadPlanRow(db, input.planId);
  if (!row) throw new BusinessError('NOT_FOUND', '补读计划不存在');
  if (
    row.space_id !== context.space.space_id ||
    row.ownership_epoch !== context.space.ownership_epoch ||
    row.agent_actor_id !== input.agentId
  ) {
    throw new BusinessError('MEMORY_TARGET_INVALID', '补读计划不属于当前空间', {
      reason: 'plan_scope_mismatch',
    });
  }
  if (row.expires_at !== null && row.expires_at < at) {
    throw new BusinessError('REQUEST_EXPIRED', '补读计划已过期');
  }
  const current = await roomAccessVersion(db, row.room_id, input.agentId);
  if (!current || !snapshotMatches(row, current)) {
    throw new BusinessError('MEMBERSHIP_STALE', '成员代次或策略已变化，补读计划失效');
  }
  const room = await getRoom(db, row.room_id);
  const member = await getMember(db, row.room_id, input.agentId);
  if (!room || !member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  const boundary = historyBoundary(room, member);
  const requested = input.messageIds
    ? new Set(input.messageIds)
    : null;
  const all = await itemsForPlan(db, row.plan_id);
  const selections: MemorySourceSelection[] = [];
  const missing: Array<{ message_id: string; reason: string }> = [];
  for (const item of all) {
    if (item.selection_state !== 'selected') continue;
    if (requested && !requested.has(item.message_id)) continue;
    const message = await db
      .prepare('SELECT * FROM messages WHERE room_id = ? AND message_id = ?')
      .bind(row.room_id, item.message_id)
      .first<MemoryMessageRow>();
    if (!message || !visibleMessage(message, boundary)) {
      missing.push({ message_id: item.message_id, reason: 'not_visible' });
      continue;
    }
    if (message.body_bytes <= 0) {
      missing.push({ message_id: item.message_id, reason: 'empty_body' });
      continue;
    }
    const source = await ensureMessageSource(db, {
      instanceId: input.instanceId,
      message,
      roomId: row.room_id,
      member,
      boundary,
      archiveHeadSeq: boundary.toSeq,
      now: at,
    });
    const sourceDecision = await authorizeSourceRead(db, {
      space: context.space,
      source,
      agentId: input.agentId,
      target_scope: input.targetScope,
      at,
    });
    if (!sourceDecision.allowed) {
      missing.push({ message_id: item.message_id, reason: sourceDecision.reason });
      continue;
    }
    const textSha = await sha256Hex(message.body);
    const representationId = `mrp_c${(await sha256Hex(
      `catchup|${row.plan_id}|${message.message_id}|${source.source_id}|${source.revision}|${textSha}`,
    )).slice(0, 32)}`;
    let representationRow = await db
      .prepare('SELECT * FROM memory_representations WHERE representation_id = ?')
      .bind(representationId)
      .first<MemoryRepresentationRow>();
    if (!representationRow) {
      const exact = {
        representation: {
          representation_id: representationId,
          kind: 'raw_full' as const,
          source_id: source.source_id,
          source_revision: source.revision,
          range: { start: 0, end: message.body_bytes },
          depends_on: [],
          text_bytes: message.body_bytes,
          text_sha256: textSha,
          verbatim: true,
        },
        text: message.body,
      };
      if (!isValidByteRange(exact.representation.range, message.body_bytes)) {
        missing.push({ message_id: item.message_id, reason: 'invalid_range' });
        continue;
      }
      await runMemoryBatch(
        db,
        memoryRepresentationInsertStatements(db, {
          instanceId: input.instanceId,
          exact,
          dependencies: [],
          now: at,
        }),
      );
      representationRow = await db
        .prepare('SELECT * FROM memory_representations WHERE representation_id = ?')
        .bind(representationId)
        .first<MemoryRepresentationRow>();
      if (!representationRow) {
        missing.push({ message_id: item.message_id, reason: 'representation_missing' });
        continue;
      }
    }
    const exactStored = await loadRepresentationExact(db, representationId);
    if (!exactStored) {
      missing.push({ message_id: item.message_id, reason: 'representation_missing' });
      continue;
    }
    const selectionId = `msel_c${(await sha256Hex(
      `catchup|${row.plan_id}|${message.message_id}|${representationId}`,
    )).slice(0, 32)}`;
    const originScope = {
      room_id: source.origin_room_id ?? row.room_id,
      member_generation: source.origin_member_generation,
      policy_revision: source.origin_policy_revision,
      joined_seq: source.origin_joined_seq,
      joined_at: source.origin_joined_at,
      archive_head_seq: source.origin_archive_head_seq,
    };
    const versions = await requireCurrentMemorySpace(db, {
      agentId: input.agentId,
      instanceId: input.instanceId,
      expected: context.space,
      roomIds: [row.room_id],
      at,
    });
    const expiresAt = at + LIMITS.memoryPreparedTtlMs;
    await runMemoryBatch(db, [
      db
        .prepare(
          `INSERT INTO memory_selections
             (selection_id, space_id, ownership_epoch, agent_actor_id, recall_id,
              representation_id, origin_scope_json, target_scope_json, versions_json,
              consumption, state, issued_at, expires_at)
           SELECT ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'not_consumed', 'available', ?, ?
            WHERE NOT EXISTS (SELECT 1 FROM memory_selections WHERE selection_id = ?)`,
        )
        .bind(
          selectionId,
          context.space.space_id,
          context.space.ownership_epoch,
          input.agentId,
          representationId,
          JSON.stringify(originScope),
          JSON.stringify(input.targetScope),
          JSON.stringify(versions.versions),
          at,
          expiresAt,
          selectionId,
        ),
      db
        .prepare(
          `UPDATE memory_selections
              SET state = 'available', issued_at = ?, expires_at = ?
            WHERE selection_id = ? AND state = 'expired'`,
        )
        .bind(at, expiresAt, selectionId),
    ]);
    selections.push({
      selection_id: selectionId,
      representation: exactStored.representation,
      origin_scope: originScope,
      target_scope: input.targetScope,
      versions: versions.versions,
      issued_at: at,
      expires_at: expiresAt,
      consumption: 'not_consumed',
    });
  }
  return { plan_id: row.plan_id, selections, missing };
}

/** 计划扫描恢复只读取固定 H 内更早候选；不回填计划外新消息。 */
export async function currentCatchupScan(row: {
  scan_cursor_json: string | null;
}): Promise<{ before_seq: number; upper_bound: number } | null> {
  const cursor = parseScanCursor(row.scan_cursor_json);
  if (!cursor) return null;
  const before = Number(cursor.before_seq);
  const upper = Number(cursor.upper_bound);
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(upper)) return null;
  return { before_seq: before, upper_bound: upper };
}

export { scanScope, parseScanCursor };

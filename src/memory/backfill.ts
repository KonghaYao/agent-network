/**
 * 记忆定时回填。
 *
 * 以消息为主扫描最近窗口，再按房间 active Agent 成员 × active space 扇出；
 * 权限只交给 `authorizeSourceRead`。回填写入 representation/receipt/retain 意图
 * 与稀疏 experience，不直接调用 Hindsight，也不推进原文覆盖。
 *
 * 幂等：每个 (message, 待处理 space 集合) 一个 `runIdempotent` 批，批内所有
 * 条件插入都以 NOT EXISTS 收敛；窗口水位只在整窗无错误提交后推进。
 *
 * 重放：已有 receipt/intent 但缺 experience 的旧数据，在同一窗口被重新扫描时
 * 使用独立 `exp:` 批次补齐 experience，不重复回执/意图/作业。
 */
import { LIMITS } from '../contracts/limits';
import { sha256Hex, stableStringify, utf8Bytes } from '../storage/db';
import {
  operationsStatement,
  runIdempotent,
} from '../storage/transactions/runner';
import { authorizeSourceRead, sourceOriginScope } from './access';
import {
  BACKFILL_ACTOR_ID,
  backfillExperienceStatement,
  backfillIntentExperienceRepairStatement,
  backfillOperationKey,
  backfillReceiptIdempotencyKey,
  backfillReceiptStatement,
  backfillSourceKey,
  findBackfillExperienceId,
  findBackfillIntentExperienceId,
  findReusableRepresentationId,
  loadBackfillMessageSource,
} from './backfill-statements';
import {
  countBackfillCandidates,
  listBackfillFanout,
  planBackfillReplayWindows,
  planBackfillWindows,
  readBackfillRoom,
  readInstanceCaptureDefault,
  readMessageBody,
  readRoomMember,
  scanMessagePage,
  type BackfillFanoutRow,
  type BackfillWindow,
  type MessageScanRow,
} from './backfill-window';
import {
  MEMORY_POLICY_VERSION,
  type MemoryExactRepresentation,
  type MemorySpaceRef,
  type MemoryTargetScope,
} from './contracts';
import { advanceMemoryCursor, MEMORY_CURSOR_KINDS, readMemoryCursor } from './jobs';
import { experienceDedupeKey } from './experience-source';
import { memoryRepresentationInsertStatements } from './representation-statements';
import type { MemorySourceRow } from './rows';
import {
  memoryRetainIntentStatements,
  memorySourceMutationStatements,
} from './statements';

/** 内部游标命名空间，不是 actor 身份；它不参与鉴权。 */
const BACKFILL_SCOPE_ID = 'memory-backfill';

const PRIVATE_TARGET: MemoryTargetScope = {
  audience: 'agent_private',
  room_id: null,
  member_generation: null,
  member_seq: null,
  policy_revision: null,
};

export interface MemoryBackfillOptions {
  db: D1Database;
  instanceId: string;
  /** 与 MEMORY_CAPTURE 同源；关闭时不制造无主意图。 */
  capture?: () => boolean;
  now?: () => number;
  windowMs?: number;
  maxCatchupWindows?: number;
  /** 一次性重放起点（毫秒）；设置后按窗口从水位向前推进，而不是只补最近 N 个窗口。 */
  replayFrom?: number;
  /** 一次性重放上界（毫秒）；默认 `now`，始终不超过 `now`。 */
  replayUntil?: number;
  pageSize?: number;
  scanSafetyRows?: number;
  log?: (message: string, detail: Record<string, unknown>) => void;
}

export interface MemoryBackfillCreated {
  representations: number;
  receipts: number;
  intents: number;
  jobs: number;
  experiences: number;
}

export interface MemoryBackfillSkips {
  empty_body: number;
  out_of_window: number;
  source_inactive: number;
  source_missing: number;
  no_agent: number;
  no_space: number;
  capture_off: number;
  denied: number;
  already: number;
}

export interface MemoryBackfillRun {
  skipped: boolean;
  windows: number;
  caught_up: boolean;
  skipped_windows: number;
  scanned: number;
  pairs: number;
  created: MemoryBackfillCreated;
  skips: MemoryBackfillSkips;
  errors: number;
  pending_backlog: number;
  duration_ms: number;
}

export interface MemoryBackfillStatus {
  running: boolean;
  last_run_at: number | null;
  last_run: MemoryBackfillRun | null;
}

function emptyCreated(): MemoryBackfillCreated {
  return { representations: 0, receipts: 0, intents: 0, jobs: 0, experiences: 0 };
}

function emptySkips(): MemoryBackfillSkips {
  return {
    empty_body: 0,
    out_of_window: 0,
    source_inactive: 0,
    source_missing: 0,
    no_agent: 0,
    no_space: 0,
    capture_off: 0,
    denied: 0,
    already: 0,
  };
}

function skippedRun(): MemoryBackfillRun {
  return {
    skipped: true,
    windows: 0,
    caught_up: false,
    skipped_windows: 0,
    scanned: 0,
    pairs: 0,
    created: emptyCreated(),
    skips: emptySkips(),
    errors: 0,
    pending_backlog: 0,
    duration_ms: 0,
  };
}

interface WindowResult {
  scanned: number;
  pairs: number;
  created: MemoryBackfillCreated;
  skips: MemoryBackfillSkips;
  errors: number;
}

interface BackfillExperiencePlan {
  member: BackfillFanoutRow;
  dedupeKey: string;
  experienceId: string;
  needsExperience: boolean;
  /** 已有意图指向的 experience 与实际 experience 不一致（并发插入/旧数据）。 */
  repairIntent: boolean;
}

export class MemoryBackfill {
  readonly #db: D1Database;
  readonly #instanceId: string;
  readonly #capture: () => boolean;
  readonly #now: () => number;
  readonly #windowMs: number;
  readonly #maxCatchupWindows: number;
  readonly #replayFrom: number | null;
  readonly #replayUntil: number | null;
  readonly #pageSize: number;
  readonly #scanSafetyRows: number;
  readonly #log: NonNullable<MemoryBackfillOptions['log']>;

  #running = false;
  #lastRunAt: number | null = null;
  #lastRun: MemoryBackfillRun | null = null;

  constructor(options: MemoryBackfillOptions) {
    this.#db = options.db;
    this.#instanceId = options.instanceId;
    this.#capture = options.capture ?? (() => true);
    this.#now = options.now ?? (() => Date.now());
    this.#windowMs = Math.max(1, options.windowMs ?? LIMITS.memoryBackfillWindowMs);
    this.#maxCatchupWindows = Math.max(
      1,
      options.maxCatchupWindows ?? LIMITS.memoryBackfillMaxCatchupWindows,
    );
    this.#replayFrom = options.replayFrom ?? null;
    this.#replayUntil = options.replayUntil ?? null;
    this.#pageSize = Math.max(1, options.pageSize ?? LIMITS.memoryBackfillPageSize);
    this.#scanSafetyRows = Math.max(
      0,
      options.scanSafetyRows ?? LIMITS.memoryBackfillScanSafetyRows,
    );
    this.#log =
      options.log ??
      ((message, detail) => {
        console.log(message, JSON.stringify(detail));
      });
  }

  status(): MemoryBackfillStatus {
    return { running: this.#running, last_run_at: this.#lastRunAt, last_run: this.#lastRun };
  }

  /** 单轮不重入；上一轮未结束时返回 skipped，不排队堆积。 */
  async runOnce(): Promise<MemoryBackfillRun> {
    if (this.#running) {
      this.#log('memory-backfill skip', { reason: 'already_running' });
      return skippedRun();
    }
    this.#running = true;
    try {
      const run = await this.#execute();
      this.#lastRun = run;
      this.#lastRunAt = this.#now();
      this.#log('memory-backfill run', {
        windows: run.windows,
        caught_up: run.caught_up,
        skipped_windows: run.skipped_windows,
        scanned: run.scanned,
        pairs: run.pairs,
        created: run.created,
        skips: run.skips,
        errors: run.errors,
        pending_backlog: run.pending_backlog,
        duration_ms: run.duration_ms,
      });
      return run;
    } finally {
      this.#running = false;
    }
  }

  async #execute(): Promise<MemoryBackfillRun> {
    const started = Date.now();
    const skips = emptySkips();
    const created = emptyCreated();
    let scanned = 0;
    let pairs = 0;
    let errors = 0;
    let windowsRun = 0;
    let skippedWindows = 0;
    let caughtUp = false;

    if (!this.#capture()) {
      skips.capture_off += 1;
      return this.#result({
        windowsRun,
        caughtUp,
        skippedWindows,
        scanned,
        pairs,
        created,
        skips,
        errors,
      });
    }
    const captureDefault = await readInstanceCaptureDefault(this.#db, this.#instanceId);
    if (captureDefault !== 'enabled') {
      skips.capture_off += 1;
      return this.#result({
        windowsRun,
        caughtUp,
        skippedWindows,
        scanned,
        pairs,
        created,
        skips,
        errors,
      });
    }

    const now = this.#now();
    const watermark = await readMemoryCursor(this.#db, {
      scopeKind: 'agent',
      scopeId: BACKFILL_SCOPE_ID,
      cursorKind: MEMORY_CURSOR_KINDS.backfillWindowTo,
    });
    const plan =
      this.#replayFrom === null
        ? planBackfillWindows({
            watermark,
            now,
            windowMs: this.#windowMs,
            maxCatchupWindows: this.#maxCatchupWindows,
          })
        : planBackfillReplayWindows({
            watermark,
            from: this.#replayFrom,
            until: Math.min(this.#replayUntil ?? now, now),
            windowMs: this.#windowMs,
            maxWindows: this.#maxCatchupWindows,
          });
    skippedWindows = plan.skippedWindows;
    if (plan.skippedWindows > 0) {
      this.#log('memory-backfill skipped_windows', {
        skipped_windows: plan.skippedWindows,
        max_catchup_windows: this.#maxCatchupWindows,
      });
    }

    let currentTo = watermark;
    for (const window of plan.windows) {
      const result = await this.#processWindow(window, skips);
      windowsRun += 1;
      scanned += result.scanned;
      pairs += result.pairs;
      created.representations += result.created.representations;
      created.receipts += result.created.receipts;
      created.intents += result.created.intents;
      created.jobs += result.created.jobs;
      created.experiences += result.created.experiences;
      errors += result.errors;
      this.#log('memory-backfill window', {
        from: window.from,
        to: window.to,
        scanned: result.scanned,
        pairs: result.pairs,
        created: result.created,
        skips: result.skips,
        errors: result.errors,
      });
      if (result.errors > 0) break;
      await advanceMemoryCursor(this.#db, {
        scopeKind: 'agent',
        scopeId: BACKFILL_SCOPE_ID,
        cursorKind: MEMORY_CURSOR_KINDS.backfillWindowTo,
        value: window.to,
        now,
      });
      currentTo = window.to;
    }
    caughtUp =
      errors === 0 &&
      plan.windows.length > 0 &&
      currentTo !== null &&
      currentTo >= plan.currentTo;
    if (plan.windows.length === 0) caughtUp = errors === 0;

    const pendingBacklog = await this.#pendingBacklog();
    return this.#result({
      windowsRun,
      caughtUp,
      skippedWindows,
      scanned,
      pairs,
      created,
      skips,
      errors,
      pendingBacklog,
      durationMs: Date.now() - started,
    });
  }

  #result(input: {
    windowsRun: number;
    caughtUp: boolean;
    skippedWindows: number;
    scanned: number;
    pairs: number;
    created: MemoryBackfillCreated;
    skips: MemoryBackfillSkips;
    errors: number;
    pendingBacklog?: number;
    durationMs?: number;
  }): MemoryBackfillRun {
    return {
      skipped: false,
      windows: input.windowsRun,
      caught_up: input.caughtUp,
      skipped_windows: input.skippedWindows,
      scanned: input.scanned,
      pairs: input.pairs,
      created: input.created,
      skips: input.skips,
      errors: input.errors,
      pending_backlog: input.pendingBacklog ?? 0,
      duration_ms: input.durationMs ?? 0,
    };
  }

  async #pendingBacklog(): Promise<number> {
    const row = await this.#db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_jobs WHERE status IN ('pending', 'leased', 'unknown')",
      )
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async #processWindow(window: BackfillWindow, skips: MemoryBackfillSkips): Promise<WindowResult> {
    const result: WindowResult = {
      scanned: 0,
      pairs: 0,
      created: emptyCreated(),
      skips: emptySkips(),
      errors: 0,
    };
    // 每窗口独立计数，避免把累积值重复写进窗口日志。
    const windowSkips = result.skips;
    const stored = await readMemoryCursor(this.#db, {
      scopeKind: 'agent',
      scopeId: BACKFILL_SCOPE_ID,
      cursorKind: MEMORY_CURSOR_KINDS.backfillScanRowid,
    });
    let after = Math.max(0, (stored ?? 0) - this.#scanSafetyRows);
    let checkpoint = after;
    let beyond = 0;
    let stop = false;

    while (!stop) {
      const rows = await scanMessagePage(this.#db, { afterRowid: after, limit: this.#pageSize });
      if (rows.length === 0) break;
      for (const row of rows) {
        after = row.rowid;
        if (row.created_at >= window.to) {
          beyond += 1;
          if (beyond > this.#scanSafetyRows) {
            stop = true;
            break;
          }
          continue;
        }
        beyond = 0;
        checkpoint = row.rowid;
        if (row.created_at < window.from) {
          windowSkips.out_of_window += 1;
          continue;
        }
        result.scanned += 1;
        try {
          const message = await this.#processMessage(row, window, windowSkips);
          result.pairs += message.pairs;
          result.created.representations += message.representations;
          result.created.receipts += message.receipts;
          result.created.intents += message.intents;
          result.created.jobs += message.jobs;
          result.created.experiences += message.experiences;
        } catch (error) {
          result.errors += 1;
          this.#log('memory-backfill message failed', {
            message_id: row.message_id,
            room_id: row.room_id,
            error: classifyError(error),
          });
          stop = true;
          break;
        }
      }
      if (checkpoint > (stored ?? 0)) {
        await advanceMemoryCursor(this.#db, {
          scopeKind: 'agent',
          scopeId: BACKFILL_SCOPE_ID,
          cursorKind: MEMORY_CURSOR_KINDS.backfillScanRowid,
          value: checkpoint,
          now: this.#now(),
        });
      }
      if (rows.length < this.#pageSize) break;
    }
    for (const key of Object.keys(windowSkips) as (keyof MemoryBackfillSkips)[]) {
      skips[key] += windowSkips[key];
    }
    return result;
  }

  async #processMessage(
    row: MessageScanRow,
    window: BackfillWindow,
    skips: MemoryBackfillSkips,
  ): Promise<{
    pairs: number;
    representations: number;
    receipts: number;
    intents: number;
    jobs: number;
    experiences: number;
  }> {
    const empty = {
      pairs: 0,
      representations: 0,
      receipts: 0,
      intents: 0,
      jobs: 0,
      experiences: 0,
    };
    if (row.body_bytes <= 0) {
      skips.empty_body += 1;
      return empty;
    }
    const body = await readMessageBody(this.#db, row.message_id);
    if (!body || body.length === 0) {
      skips.empty_body += 1;
      return empty;
    }
    const room = await readBackfillRoom(this.#db, row.room_id);
    if (!room) {
      skips.source_missing += 1;
      return empty;
    }
    const fanout = await listBackfillFanout(this.#db, {
      roomId: room.room_id,
      instanceId: this.#instanceId,
    });
    if (fanout.length === 0) {
      const candidates = await countBackfillCandidates(this.#db, {
        roomId: room.room_id,
        instanceId: this.#instanceId,
      });
      if (candidates.agents === 0) skips.no_agent += 1;
      else skips.no_space += 1;
      return empty;
    }

    const existing = await loadBackfillMessageSource(this.#db, {
      instanceId: this.#instanceId,
      messageId: row.message_id,
    });
    if (existing && existing.state !== 'active') {
      skips.source_inactive += 1;
      return empty;
    }

    const textBytes = utf8Bytes(body);
    if (textBytes === 0) {
      skips.empty_body += 1;
      return empty;
    }
    const digest = await sha256Hex(body);
    const candidateMember =
      (await readRoomMember(this.#db, room.room_id, row.sender_id)) ?? fanout[0] ?? null;
    if (!candidateMember) {
      skips.source_missing += 1;
      return empty;
    }
    const source =
      existing ??
      (await this.#prospectiveSource({
        row,
        room,
        member: candidateMember,
        digest,
        textBytes,
        body,
      }));
    const origin = sourceOriginScope(source);
    if (!origin) {
      skips.source_missing += 1;
      return empty;
    }

    const authorized: BackfillFanoutRow[] = [];
    for (const member of fanout) {
      const space: MemorySpaceRef = {
        space_id: member.space_id,
        ownership_epoch: member.ownership_epoch,
        backend_binding_epoch: member.backend_binding_epoch,
      };
      const decision = await authorizeSourceRead(this.#db, {
        space,
        source,
        agentId: member.actor_id,
        target_scope: PRIVATE_TARGET,
        at: this.#now(),
      });
      if (decision.allowed) authorized.push(member);
      else skips.denied += 1;
    }
    if (authorized.length === 0) return empty;

    const now = this.#now();
    const reusable = await findReusableRepresentationId(this.#db, {
      sourceId: source.source_id,
      sourceRevision: source.revision,
      textSha256: digest,
    });
    const representationId =
      reusable ??
      `mrp_bf_${(await sha256Hex(`backfill-representation|${source.source_key}|${source.revision}|${digest}`)).slice(0, 32)}`;
    const exact: MemoryExactRepresentation = {
      representation: {
        representation_id: representationId,
        kind: 'raw_full',
        text_bytes: textBytes,
        text_sha256: digest,
        verbatim: true,
        source_id: source.source_id,
        source_revision: source.revision,
        range: { start: 0, end: textBytes },
        depends_on: [],
      },
      text: body,
    };

    const plans: BackfillExperiencePlan[] = [];
    const pending: BackfillFanoutRow[] = [];
    for (const member of authorized) {
      const dedupeKey = experienceDedupeKey({
        spaceId: member.space_id,
        ownershipEpoch: member.ownership_epoch,
        agentId: member.actor_id,
        originRoomId: origin.room_id,
        memberGeneration: member.member_generation,
        originKind: 'experienced',
        representation: exact.representation,
      });
      const existingExperienceId = await findBackfillExperienceId(this.#db, dedupeKey);
      const experienceId =
        existingExperienceId ??
        `mexp_bf_${(await sha256Hex(`backfill-experience|${dedupeKey}`)).slice(0, 24)}`;
      const operationKey = backfillOperationKey(member.space_id, row.message_id);
      const existingIntent = await findBackfillIntentExperienceId(this.#db, {
        spaceId: member.space_id,
        operationKey,
      });
      plans.push({
        member,
        dedupeKey,
        experienceId,
        needsExperience: existingExperienceId === null,
        repairIntent:
          existingExperienceId !== null &&
          existingIntent !== null &&
          existingIntent.experience_id !== existingExperienceId,
      });
      if (existingIntent !== null) {
        skips.already += 1;
      } else {
        pending.push(member);
      }
    }
    const pendingSpaces = new Set(pending.map((member) => member.space_id));
    const targets = plans.filter(
      (plan) =>
        plan.needsExperience || plan.repairIntent || pendingSpaces.has(plan.member.space_id),
    );
    if (targets.length === 0) return empty;

    const pairKeys = targets.map((plan) => [
      plan.member.space_id,
      plan.member.ownership_epoch,
      plan.member.backend_binding_epoch,
    ]);
    // 请求键同时覆盖 experience 计划：同一批目标空间但补齐内容不同（例如旧
    // experience 被移除、或意图指针需要修复）时不会命中旧 operations 行。
    const planKeys = targets.map((plan) => [
      plan.member.space_id,
      plan.member.ownership_epoch,
      plan.member.backend_binding_epoch,
      plan.needsExperience
        ? ['experience', plan.dedupeKey, plan.experienceId]
        : plan.repairIntent
          ? ['repair', plan.dedupeKey, plan.experienceId]
          : null,
    ]);
    // 已有回执/意图的旧数据重放时，pending 为空但 experience 缺失；独立阶段
    // 前缀避免与旧批次命中同一 operations 行而跳过补齐。
    const phase = pending.length > 0 ? 'apply' : 'exp';
    const spaceSetHash = (await sha256Hex(stableStringify(planKeys))).slice(0, 12);
    const requestId = `memory-backfill:${phase}:${window.from}:${row.message_id}:${spaceSetHash}`;
    const experiencePlans = plans.filter((plan) => plan.needsExperience);
    const payloadHash = await sha256Hex(
      stableStringify({
        v: 2,
        phase,
        from: window.from,
        to: window.to,
        message_id: row.message_id,
        body_sha256: digest,
        pairs: pairKeys,
        experiences: experiencePlans.map((plan) => [
          plan.member.space_id,
          plan.member.ownership_epoch,
          plan.dedupeKey,
          plan.experienceId,
        ]),
        repairs: plans
          .filter((plan) => plan.repairIntent)
          .map((plan) => [plan.member.space_id, plan.dedupeKey, plan.experienceId]),
      }),
    );
    const result = {
      message_id: row.message_id,
      pairs: pending.length,
      experiences: experiencePlans.length,
    };

    const statements: D1PreparedStatement[] = [];
    if (!existing) {
      statements.push(
        ...memorySourceMutationStatements(this.#db, {
          instanceId: this.#instanceId,
          sourceId: source.source_id,
          sourceKey: source.source_key,
          sourceKind: 'message',
          businessRefKind: 'message',
          businessRefJson: source.business_ref_json,
          originRoomId: source.origin_room_id,
          originMemberGeneration: source.origin_member_generation,
          originPolicyRevision: source.origin_policy_revision,
          originJoinedSeq: source.origin_joined_seq,
          originJoinedAt: source.origin_joined_at,
          originArchiveHeadSeq: source.origin_archive_head_seq,
          originSeq: source.origin_seq,
          originCreatedAt: source.origin_created_at,
          authorActorId: source.author_actor_id,
          revision: 1,
          contentText: body,
          contentSha256: digest,
          contentBytes: textBytes,
          now,
        }),
      );
    }
    statements.push(
      ...memoryRepresentationInsertStatements(this.#db, {
        instanceId: this.#instanceId,
        exact,
        dependencies: [],
        now,
      }),
    );
    const targetScopeJson = JSON.stringify(PRIVATE_TARGET);
    const originScopesJson = JSON.stringify([origin]);

    // 回执必须先于 experience：后者用幂等键解析 receipt_id，同批内可见。
    for (const member of pending) {
      const operationKey = backfillOperationKey(member.space_id, row.message_id);
      const receiptId = `mrc_bf_${(await sha256Hex(`backfill-receipt|${member.space_id}|${row.message_id}`)).slice(0, 24)}`;
      const proofId = `mpf_${(await sha256Hex(`backfill-proof|${member.space_id}|${row.message_id}|${source.revision}`)).slice(0, 24)}`;
      statements.push(
        backfillReceiptStatement(this.#db, {
          receiptId,
          proofId,
          spaceId: member.space_id,
          ownershipEpoch: member.ownership_epoch,
          agentActorId: member.actor_id,
          messageId: row.message_id,
          operationKey,
          targetScopeJson,
          originScopesJson,
          now,
        }),
      );
    }

    for (const plan of experiencePlans) {
      statements.push(
        backfillExperienceStatement(this.#db, {
          experienceId: plan.experienceId,
          dedupeKey: plan.dedupeKey,
          spaceId: plan.member.space_id,
          ownershipEpoch: plan.member.ownership_epoch,
          agentActorId: plan.member.actor_id,
          originRoomId: origin.room_id,
          originMemberGeneration: plan.member.member_generation,
          sourceId: source.source_id,
          sourceRevision: source.revision,
          representationId,
          rangeStart: 0,
          rangeEnd: textBytes,
          textSha256: digest,
          receiptIdempotencyKey: backfillReceiptIdempotencyKey(
            plan.member.space_id,
            row.message_id,
          ),
          now,
        }),
      );
    }

    const planBySpace = new Map(plans.map((plan) => [plan.member.space_id, plan]));
    for (const member of pending) {
      const operationKey = backfillOperationKey(member.space_id, row.message_id);
      const receiptId = `mrc_bf_${(await sha256Hex(`backfill-receipt|${member.space_id}|${row.message_id}`)).slice(0, 24)}`;
      const retainId = `mrt_bf_${(await sha256Hex(`backfill-retain|${operationKey}`)).slice(0, 24)}`;
      const jobId = `mjb_bf_${(await sha256Hex(`backfill-job|${operationKey}`)).slice(0, 24)}`;
      const intentPayload = await sha256Hex(
        stableStringify({
          operation_key: operationKey,
          representation_id: representationId,
          message_id: row.message_id,
          space_id: member.space_id,
        }),
      );
      statements.push(
        ...memoryRetainIntentStatements(this.#db, {
          retainId,
          jobId,
          spaceId: member.space_id,
          ownershipEpoch: member.ownership_epoch,
          agentActorId: member.actor_id,
          originKind: 'experienced',
          experienceId: planBySpace.get(member.space_id)?.experienceId ?? null,
          representationId,
          sourceId: source.source_id,
          sourceRevision: source.revision,
          receiptId,
          evidence: null,
          policyVersion: MEMORY_POLICY_VERSION,
          operationKey,
          payloadSha256: intentPayload,
          backendBindingEpoch: member.backend_binding_epoch,
          now,
        }),
      );
    }

    // 同批最后按 dedupe key 校正意图指针：如果并发路径抢先插入同义
    // experience，回填的 NOT EXISTS 插入会跳过，这里把意图指到实际 ID。
    for (const plan of targets) {
      statements.push(
        backfillIntentExperienceRepairStatement(this.#db, {
          spaceId: plan.member.space_id,
          operationKey: backfillOperationKey(plan.member.space_id, row.message_id),
          dedupeKey: plan.dedupeKey,
          now,
        }),
      );
    }

    await runIdempotent(this.#db, {
      actorId: BACKFILL_ACTOR_ID,
      requestId,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(
          this.#db,
          BACKFILL_ACTOR_ID,
          requestId,
          payloadHash,
          resultJson,
          now,
        ),
        ...statements,
      ],
    });

    return {
      pairs: pending.length,
      representations: reusable ? 0 : 1,
      receipts: pending.length,
      intents: pending.length,
      jobs: pending.length,
      experiences: experiencePlans.length,
    };
  }

  async #prospectiveSource(input: {
    row: MessageScanRow;
    room: {
      room_id: string;
      policy_revision: number;
      archive_head_seq: number | null;
    };
    member: {
      member_generation: number;
      joined_seq: number;
      joined_at: number;
    };
    digest: string;
    textBytes: number;
    body: string;
  }): Promise<MemorySourceRow> {
    const now = this.#now();
    const sourceId = `msrc_bf_${(await sha256Hex(`backfill-source|${this.#instanceId}|${input.row.message_id}`)).slice(0, 24)}`;
    return {
      source_id: sourceId,
      instance_id: this.#instanceId,
      source_key: backfillSourceKey(input.row.message_id),
      source_kind: 'message',
      business_ref_kind: 'message',
      business_ref_json: JSON.stringify({
        message_id: input.row.message_id,
        created_seq: input.row.created_seq,
      }),
      origin_room_id: input.room.room_id,
      origin_member_generation: input.member.member_generation,
      origin_policy_revision: input.room.policy_revision,
      origin_joined_seq: input.member.joined_seq,
      origin_joined_at: input.member.joined_at,
      origin_archive_head_seq: input.room.archive_head_seq,
      origin_seq: input.row.created_seq,
      origin_created_at: input.row.created_at,
      author_actor_id: input.row.sender_id,
      state: 'active',
      revision: 1,
      content_text: input.body,
      content_sha256: input.digest,
      content_bytes: input.textBytes,
      superseded_by_source_id: null,
      superseded_by_revision: null,
      retracted_at: null,
      created_at: now,
      updated_at: now,
    };
  }
}

function classifyError(error: unknown): string {
  if (error instanceof Error) {
    const text = error.message;
    if (text.includes('UNIQUE') || text.includes('FOREIGN KEY')) return 'constraint';
    if (text.includes('SQLITE')) return 'sqlite';
    return error.name;
  }
  return 'unknown';
}

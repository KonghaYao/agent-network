import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  ContactBlockInput,
  ContactBlocksListInput,
  ContactReportInput,
  ContactReportsListInput,
  ContactUnblockInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, sortedPairKey, stableStringify, utf8Bytes } from '../storage/db';
import {
  eventStatementIfAbsent,
  inboxHeadStatementIfEvent,
  inboxTopic,
  outboxStatementIfAbsent,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor } from '../storage/queries';
import type {
  ActorRow,
  ContactBlockRow,
  ContactReportRow,
  ContactRequestRow,
} from '../storage/rows';
import {
  operationsStatement,
  resolveReplay,
  runIdempotent,
} from '../storage/transactions/runner';
import {
  actorView,
  endRelationStatements,
  type ContactActorView,
} from './contact-relations';
import { actorId, type Principal } from './principal';

/**
 * 拉黑、解除拉黑与举报的最小实现。
 *
 * 拉黑与好友关系是两套状态：拉黑会结束当前好友关系并取消同 pair 的
 * pending 申请，但不会移除共同群成员、不会删除历史，也不会删掉单侧收藏。
 * 解除拉黑只释放拉黑行，不恢复关系；重新建联必须重新申请。
 *
 * 拉黑与举报都只写持久事件（拉黑）或只落举报行（举报），不产生
 * delivery、不增加 `pending_count`，也不会唤醒 Agent 执行任务。
 */

export interface ContactBlockView {
  block_id: string;
  blocker_actor_id: string;
  blocked_actor: ContactActorView;
  reason: string;
  mute_mentions: boolean;
  created_at: string;
  active: boolean;
  released_at: string | null;
  released_by: string | null;
}

export interface ContactBlockPage {
  items: ContactBlockView[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface ContactBlockResult {
  block: ContactBlockView;
  already_blocked: boolean;
}

export interface ContactUnblockResult {
  block: ContactBlockView | null;
  released: boolean;
}

export interface ContactReportView {
  report_id: string;
  reporter_actor_id: string;
  target_actor: ContactActorView;
  category: 'harassment' | 'spam' | 'fraud' | 'other';
  note: string;
  room_id: string | null;
  message_id: string | null;
  status: 'received';
  created_at: string;
  updated_at: string;
}

export interface ContactReportPage {
  items: ContactReportView[];
  next_cursor: string | null;
  has_more: boolean;
}

export function blockView(row: ContactBlockRow, blocked: ActorRow): ContactBlockView {
  return {
    block_id: row.block_id,
    blocker_actor_id: row.blocker_actor_id,
    blocked_actor: actorView(blocked),
    reason: row.reason,
    mute_mentions: row.mute_mentions === 1,
    created_at: String(row.created_at),
    active: row.released_at === null,
    released_at: row.released_at === null ? null : String(row.released_at),
    released_by: row.released_by,
  };
}

export function reportView(row: ContactReportRow, target: ActorRow): ContactReportView {
  return {
    report_id: row.report_id,
    reporter_actor_id: row.reporter_actor_id,
    target_actor: actorView(target),
    category: row.category,
    note: row.note,
    room_id: row.room_id,
    message_id: row.message_id,
    status: row.status,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function getActiveBlock(
  db: D1Database,
  blocker: string,
  blocked: string,
): Promise<ContactBlockRow | null> {
  return db
    .prepare(
      `SELECT * FROM contact_blocks
        WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL`,
    )
    .bind(blocker, blocked)
    .first<ContactBlockRow>();
}

/** 任一方向的 active 拉黑；用于私聊、申请与邀请的服务端裁决。 */
export async function findActiveBlockBetween(
  db: D1Database,
  actorA: string,
  actorB: string,
): Promise<ContactBlockRow | null> {
  return db
    .prepare(
      `SELECT * FROM contact_blocks
        WHERE released_at IS NULL
          AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
            OR (blocker_actor_id = ? AND blocked_actor_id = ?))
        LIMIT 1`,
    )
    .bind(actorA, actorB, actorB, actorA)
    .first<ContactBlockRow>();
}

export async function isBlockedBetween(
  db: D1Database,
  actorA: string,
  actorB: string,
): Promise<boolean> {
  return (await findActiveBlockBetween(db, actorA, actorB)) !== null;
}

/** 同一事务内的双向拉黑闸门；必须在其他关系/成员校验之前执行。 */
export function contactBlockGuardStatement(
  db: D1Database,
  actorA: string,
  actorB: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'blocked',
        `EXISTS (
           SELECT 1 FROM contact_blocks
            WHERE released_at IS NULL
              AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
                OR (blocker_actor_id = ? AND blocked_actor_id = ?))
         )`,
      ),
    )
    .bind(actorA, actorB, actorB, actorA);
}

/** direct 房间内任一成员拉黑另一成员时拒绝新消息；历史不受影响。 */
export function directBlockGuardStatement(
  db: D1Database,
  roomId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'blocked',
        `EXISTS (SELECT 1 FROM rooms r WHERE r.room_id = ? AND r.kind = 'direct')
         AND EXISTS (
           SELECT 1
             FROM rooms r
             JOIN contact_blocks b ON b.released_at IS NULL
            WHERE r.room_id = ? AND r.kind = 'direct'
              AND b.blocker_actor_id IN (
                SELECT actor_id FROM room_members
                 WHERE room_id = r.room_id AND status = 'active'
              )
              AND b.blocked_actor_id IN (
                SELECT actor_id FROM room_members
                 WHERE room_id = r.room_id AND status = 'active'
              )
         )`,
      ),
    )
    .bind(roomId, roomId);
}

/**
 * 申请发送者窗口限额；命中返回 RATE_LIMITED。
 *
 * 只统计非自动接受的申请：管理者向自有 Agent 建联是关系管理，不占用
 * 陌生申请额度，也不会因为批量创建 Agent 反过来阻塞后续真实申请。
 */
export function contactRequestRateGuardStatement(
  db: D1Database,
  owner: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'rateLimited',
        `(SELECT COUNT(*) FROM contact_requests
           WHERE from_actor_id = ? AND auto_accepted = 0 AND created_at > ?) >= ?`,
      ),
    )
    .bind(owner, at - LIMITS.contactRequestWindowMs, LIMITS.contactRequestWindowMax);
}

/** 解除拉黑后的同 pair 再申请冷却。 */
export function contactUnblockCooldownGuardStatement(
  db: D1Database,
  actorA: string,
  actorB: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'rateLimited',
        `EXISTS (
           SELECT 1 FROM contact_blocks
            WHERE released_at IS NOT NULL
              AND released_at > ?
              AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
                OR (blocker_actor_id = ? AND blocked_actor_id = ?))
         )`,
      ),
    )
    .bind(
      at - LIMITS.contactUnblockCooldownMs,
      actorA,
      actorB,
      actorB,
      actorA,
    );
}

/** 举报窗口限额；避免举报通道被当作写放大入口。 */
export function contactReportRateGuardStatement(
  db: D1Database,
  reporter: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'rateLimited',
        `(SELECT COUNT(*) FROM contact_reports
           WHERE reporter_actor_id = ? AND created_at > ?) >= ?`,
      ),
    )
    .bind(reporter, at - LIMITS.contactReportWindowMs, LIMITS.contactReportWindowMax);
}

/** 群成员邀请/添加窗口限额；只统计显式成员添加审计。 */
export function roomInviteRateGuardStatement(
  db: D1Database,
  inviter: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'rateLimited',
        `(SELECT COUNT(*) FROM room_management_audit
           WHERE changed_by = ? AND action = 'member_added' AND created_at > ?) >= ?`,
      ),
    )
    .bind(inviter, at - LIMITS.roomInviteWindowMs, LIMITS.roomInviteWindowMax);
}

/**
 * 拉黑时取消被拉黑者已经发给拉黑者的 pending/claimed 投递。
 *
 * 拉黑不是群成员变更：只取消“从被拉黑者到拉黑者”的个人工作投递，
 * 不删除消息、不改变群历史或成员资格，也不向被拉黑者写提示。
 */
export function cancelBlockedDeliveriesStatements(
  db: D1Database,
  blocker: string,
  blocked: string,
  at: number,
): D1PreparedStatement[] {
  return [
    // 先按当前 pending 数扣减，再取消，保持 pending_count 与状态一致。
    db
      .prepare(
        `UPDATE actors
            SET pending_count = pending_count - (
                  SELECT COUNT(*)
                    FROM deliveries d JOIN messages m ON m.message_id = d.message_id
                   WHERE d.recipient_id = ? AND m.sender_id = ? AND d.state = 'pending'
                ),
                updated_at = ?
          WHERE actor_id = ?`,
      )
      .bind(blocker, blocked, at, blocker),
    db
      .prepare(
        `UPDATE deliveries
            SET state = 'cancelled', error = 'blocked', updated_at = ?
          WHERE recipient_id = ?
            AND state IN ('pending', 'claimed')
            AND message_id IN (SELECT message_id FROM messages WHERE sender_id = ?)`,
      )
      .bind(at, blocker, blocked),
  ];
}

/**
 * 定向 @ 静默：返回在当前群里拉黑了发送者且保留静默设置的目标。
 *
 * 只影响是否创建 delivery，不改变群消息可见性、成员身份或正文。
 */
export async function mutedMentionTargets(
  db: D1Database,
  sender: string,
  targets: string[],
): Promise<Set<string>> {
  if (targets.length === 0) return new Set();
  const placeholders = targets.map(() => '?').join(', ');
  const rows = await db
    .prepare(
      `SELECT blocker_actor_id FROM contact_blocks
        WHERE released_at IS NULL
          AND mute_mentions = 1
          AND blocked_actor_id = ?
          AND blocker_actor_id IN (${placeholders})`,
    )
    .bind(sender, ...targets)
    .all<{ blocker_actor_id: string }>();
  return new Set(rows.results.map((row) => row.blocker_actor_id));
}

/** 拉黑时取消同 pair 的 pending 申请；不向被拉黑者发送申请取消提示。 */
async function pendingCancellationStatements(
  db: D1Database,
  pairKey: string,
  blocker: string,
  blockedActorId: string,
  at: number,
): Promise<D1PreparedStatement[]> {
  const pending = await db
    .prepare("SELECT * FROM contact_requests WHERE pair_key = ? AND status = 'pending'")
    .bind(pairKey)
    .all<ContactRequestRow>();
  const statements: D1PreparedStatement[] = [];
  for (const row of pending.results) {
    const eventKey = `contact_request_cancelled:${row.contact_request_id}`;
    statements.push(
      db
        .prepare(
          `UPDATE contact_requests
              SET status = 'cancelled', updated_at = ?, responded_at = ?, responded_by = ?
            WHERE contact_request_id = ? AND status = 'pending'`,
        )
        .bind(at, at, blocker, row.contact_request_id),
    );
    // 被拉黑者的申请只静默取消，不写 inbox 事件或 outbox，避免拉黑本身
    // 变成一条可观察的个人提醒。
    if (row.from_actor_id === blockedActorId) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO events
             (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
           SELECT 'inbox', ?, 'contact_request_cancelled', ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM contact_requests
               WHERE contact_request_id = ? AND status = 'cancelled'
                 AND responded_by = ? AND responded_at = ?
            )
           ON CONFLICT(event_key) DO NOTHING`,
        )
        .bind(
          row.from_actor_id,
          row.contact_request_id,
          JSON.stringify({
            pair_key: pairKey,
            from_actor_id: row.from_actor_id,
            to_actor_id: row.to_actor_id,
            cancelled_by: blocker,
          }),
          eventKey,
          at,
          row.contact_request_id,
          blocker,
          at,
        ),
      inboxHeadStatementIfEvent(db, row.from_actor_id, eventKey, at, 0),
    );
    const requester = await getActor(db, row.from_actor_id);
    if (requester?.kind === 'human') {
      statements.push(
        outboxStatementIfAbsent(db, { topic: inboxTopic(requester.actor_id), eventKey }, at),
      );
    }
  }
  return statements;
}

async function resolveBlockTarget(db: D1Database, targetId: string, owner: string): Promise<ActorRow> {
  if (targetId === owner) {
    throw new BusinessError('INVALID_ARGUMENT', '不能拉黑自己');
  }
  const target = await getActor(db, targetId);
  if (!target) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  return target;
}

export async function contactBlock(
  db: D1Database,
  principal: Principal,
  input: ContactBlockInput,
): Promise<ContactBlockResult> {
  const owner = actorId(principal);
  const caller = principal.actor ?? (await getActor(db, owner));
  if (!caller) throw new BusinessError('NOT_FOUND', 'actor 不存在');
  const target = await resolveBlockTarget(db, input.actor_id, owner);
  const reason = input.reason ?? '';
  if (utf8Bytes(reason) > LIMITS.contactBlockReasonBytes) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      `拉黑原因不能超过 ${LIMITS.contactBlockReasonBytes} 字节`,
    );
  }
  const muteMentions = input.mute_mentions === undefined ? true : input.mute_mentions;
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, owner, input.request_id, payloadHash);
  if (replay.found) return replay.result as ContactBlockResult;

  const existing = await getActiveBlock(db, owner, target.actor_id);
  const pairKey = sortedPairKey(owner, target.actor_id);
  const blockId = existing?.block_id ?? newId('blk');
  const created = existing === null;
  const row: ContactBlockRow = {
    block_id: blockId,
    blocker_actor_id: owner,
    blocked_actor_id: target.actor_id,
    reason: existing?.reason ?? reason,
    mute_mentions: existing?.mute_mentions ?? (muteMentions ? 1 : 0),
    created_at: existing?.created_at ?? at,
    released_at: null,
    released_by: null,
  };
  const result: ContactBlockResult = {
    block: blockView(row, target),
    already_blocked: !created,
  };

  const notificationKey = `contact_blocked:${blockId}`;
  const pendingStatements = created
    ? await pendingCancellationStatements(db, pairKey, owner, target.actor_id, at)
    : [];
  const stored = await runIdempotent(db, {
    actorId: owner,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => {
      const statements: D1PreparedStatement[] = [
        operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
      ];
      if (created) {
        statements.push(
          db
            .prepare(
              `INSERT INTO contact_blocks
                 (block_id, blocker_actor_id, blocked_actor_id, reason, mute_mentions,
                  created_at, released_at, released_by)
               VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
               ON CONFLICT(blocker_actor_id, blocked_actor_id) WHERE released_at IS NULL
               DO NOTHING`,
            )
            .bind(blockId, owner, target.actor_id, reason, muteMentions ? 1 : 0, at),
          // 拉黑结束关系，但不向被拉黑者发送关系结束提示；提示只在删除好友时发送。
          ...endRelationStatements(db, owner, target, input.request_id, at, {
            notifyTarget: false,
          }),
          ...pendingStatements,
          ...cancelBlockedDeliveriesStatements(db, owner, target.actor_id, at),
          ...blockNotificationStatements(db, caller, target, row, blockId, notificationKey, at),
        );
      }
      return statements;
    },
  });
  return stored as ContactBlockResult;
}

function blockNotificationStatements(
  db: D1Database,
  caller: ActorRow,
  target: ActorRow,
  row: ContactBlockRow,
  blockId: string,
  eventKey: string,
  at: number,
): D1PreparedStatement[] {
  const statements = [
    db
      .prepare(
        `INSERT INTO events
           (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
         SELECT 'inbox', ?, 'contact_blocked', ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM contact_blocks WHERE block_id = ?)
         ON CONFLICT(event_key) DO NOTHING`,
      )
      .bind(
        caller.actor_id,
        row.block_id,
        JSON.stringify({
          blocked_actor_id: target.actor_id,
          reason_bytes: utf8Bytes(row.reason),
          mute_mentions: row.mute_mentions === 1,
        }),
        eventKey,
        at,
        blockId,
      ),
    inboxHeadStatementIfEvent(db, caller.actor_id, eventKey, at, 0),
  ];
  if (caller.kind === 'human') {
    statements.push(
      outboxStatementIfAbsent(db, { topic: inboxTopic(caller.actor_id), eventKey }, at),
    );
  }
  return statements;
}

export async function contactUnblock(
  db: D1Database,
  principal: Principal,
  input: ContactUnblockInput,
): Promise<ContactUnblockResult> {
  const owner = actorId(principal);
  const caller = principal.actor ?? (await getActor(db, owner));
  if (!caller) throw new BusinessError('NOT_FOUND', 'actor 不存在');
  const target = await getActor(db, input.actor_id);
  if (!target) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  if (target.actor_id === owner) {
    throw new BusinessError('INVALID_ARGUMENT', '不能解除对自己的拉黑');
  }
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, owner, input.request_id, payloadHash);
  if (replay.found) return replay.result as ContactUnblockResult;

  const existing = await getActiveBlock(db, owner, target.actor_id);
  const result: ContactUnblockResult = existing
    ? {
        block: {
          ...blockView(existing, target),
          active: false,
          released_at: String(at),
          released_by: owner,
        },
        released: true,
      }
    : { block: null, released: false };

  if (!existing) {
    const stored = await runIdempotent(db, {
      actorId: owner,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
      ],
    });
    return stored as ContactUnblockResult;
  }

  const eventKey = `contact_unblocked:${existing.block_id}`;
  const stored = await runIdempotent(db, {
    actorId: owner,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          `UPDATE contact_blocks
              SET released_at = ?, released_by = ?
            WHERE block_id = ? AND released_at IS NULL`,
        )
        .bind(at, owner, existing.block_id),
      eventStatementIfAbsent(
        db,
        {
          eventKey,
          scopeKind: 'inbox',
          scopeId: owner,
          eventType: 'contact_unblocked',
          refId: existing.block_id,
          metadata: { blocked_actor_id: target.actor_id },
        },
        at,
      ),
      inboxHeadStatementIfEvent(db, owner, eventKey, at, 0),
      ...(caller.kind === 'human'
        ? [outboxStatementIfAbsent(db, { topic: inboxTopic(owner), eventKey }, at)]
        : []),
    ],
  });
  return stored as ContactUnblockResult;
}

interface BlockJoinRow extends ContactBlockRow {
  blocked_kind: 'human' | 'agent';
  blocked_name: string;
  blocked_session: string | null;
}

export async function contactBlocksList(
  db: D1Database,
  principal: Principal,
  input: ContactBlocksListInput,
): Promise<ContactBlockPage> {
  const viewer = actorId(principal);
  const limit = clampPage(
    input.limit,
    LIMITS.contactBlocksPageDefault,
    LIMITS.contactBlocksPageMax,
  );
  const scope = `contact_blocks:${viewer}`;
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const where = cursor
    ? 'b.blocker_actor_id = ? AND (b.created_at < ? OR (b.created_at = ? AND b.block_id > ?))'
    : 'b.blocker_actor_id = ?';
  const binds: unknown[] = cursor
    ? [viewer, cursor.seq, cursor.seq, cursor.key ?? '']
    : [viewer];
  const rows = await db
    .prepare(
      `SELECT b.*,
              a.kind AS blocked_kind, a.name AS blocked_name,
              a.agent_session_id AS blocked_session
         FROM contact_blocks b
         JOIN actors a ON a.actor_id = b.blocked_actor_id
        WHERE ${where}
        ORDER BY b.created_at DESC, b.block_id ASC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<BlockJoinRow>();
  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((row) =>
      blockView(row, {
        actor_id: row.blocked_actor_id,
        kind: row.blocked_kind,
        name: row.blocked_name,
        agent_session_id: row.blocked_session,
      } as ActorRow),
    ),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.block_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

interface ReportJoinRow extends ContactReportRow {
  target_kind: 'human' | 'agent';
  target_name: string;
  target_session: string | null;
}

export async function contactReport(
  db: D1Database,
  principal: Principal,
  input: ContactReportInput,
): Promise<{ report: ContactReportView }> {
  const reporter = actorId(principal);
  if (input.target_actor_id === reporter) {
    throw new BusinessError('INVALID_ARGUMENT', '不能举报自己');
  }
  const target = await getActor(db, input.target_actor_id);
  if (!target) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  const note = input.note ?? '';
  if (utf8Bytes(note) > LIMITS.contactReportNoteBytes) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      `举报备注不能超过 ${LIMITS.contactReportNoteBytes} 字节`,
    );
  }

  let roomId: string | null = null;
  let messageId: string | null = null;
  let evidence: Record<string, unknown> = {};
  if (input.message_id) {
    const message = await db
      .prepare('SELECT * FROM messages WHERE message_id = ?')
      .bind(input.message_id)
      .first<{ message_id: string; room_id: string; sender_id: string; created_seq: number }>();
    if (!message) throw new BusinessError('NOT_FOUND', '消息不存在');
    if (input.room_id && input.room_id !== message.room_id) {
      throw new BusinessError('INVALID_ARGUMENT', '消息不属于指定房间');
    }
    if (message.sender_id !== target.actor_id) {
      throw new BusinessError('INVALID_ARGUMENT', '被举报消息的发送者与 target_actor_id 不一致');
    }
    const membership = await db
      .prepare(
        "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
      )
      .bind(message.room_id, reporter)
      .first<{ ok: number }>();
    if (!membership) {
      throw new BusinessError('NOT_FOUND', '消息不存在');
    }
    roomId = message.room_id;
    messageId = message.message_id;
    // 只保存定位与小体积元数据，不复制正文、预览或发送者资料。
    evidence = { message_created_seq: String(message.created_seq) };
  } else if (input.room_id) {
    const membership = await db
      .prepare(
        "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
      )
      .bind(input.room_id, reporter)
      .first<{ ok: number }>();
    if (!membership) throw new BusinessError('NOT_FOUND', '房间不存在');
    const targetMember = await db
      .prepare(
        "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
      )
      .bind(input.room_id, target.actor_id)
      .first<{ ok: number }>();
    if (!targetMember) throw new BusinessError('NOT_FOUND', '被举报成员不在该房间');
    roomId = input.room_id;
  }

  const at = nowMs();
  const reportId = newId('rep');
  const payloadHash = await sha256Hex(stableStringify(input));
  const row: ContactReportRow = {
    report_id: reportId,
    reporter_actor_id: reporter,
    target_actor_id: target.actor_id,
    category: input.category,
    note,
    room_id: roomId,
    message_id: messageId,
    evidence_json: JSON.stringify(evidence),
    status: 'received',
    created_at: at,
    updated_at: at,
  };
  const result = { report: reportView(row, target) };
  const stored = await runIdempotent(db, {
    actorId: reporter,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, reporter, input.request_id, payloadHash, resultJson, at),
      contactReportRateGuardStatement(db, reporter, at),
      db
        .prepare(
          `INSERT INTO contact_reports
             (report_id, reporter_actor_id, target_actor_id, category, note, room_id,
              message_id, evidence_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
        )
        .bind(
          reportId,
          reporter,
          target.actor_id,
          input.category,
          note,
          roomId,
          messageId,
          JSON.stringify(evidence),
          at,
          at,
        ),
    ],
  });
  return stored as { report: ContactReportView };
}

export async function contactReportsList(
  db: D1Database,
  principal: Principal,
  input: ContactReportsListInput,
): Promise<ContactReportPage> {
  const viewer = actorId(principal);
  const limit = clampPage(
    input.limit,
    LIMITS.contactReportsPageDefault,
    LIMITS.contactReportsPageMax,
  );
  const scope = `contact_reports:${viewer}`;
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const where = cursor
    ? 'r.reporter_actor_id = ? AND (r.created_at < ? OR (r.created_at = ? AND r.report_id > ?))'
    : 'r.reporter_actor_id = ?';
  const binds: unknown[] = cursor
    ? [viewer, cursor.seq, cursor.seq, cursor.key ?? '']
    : [viewer];
  const rows = await db
    .prepare(
      `SELECT r.*,
              a.kind AS target_kind, a.name AS target_name,
              a.agent_session_id AS target_session
         FROM contact_reports r
         JOIN actors a ON a.actor_id = r.target_actor_id
        WHERE ${where}
        ORDER BY r.created_at DESC, r.report_id ASC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<ReportJoinRow>();
  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((row) =>
      reportView(row, {
        actor_id: row.target_actor_id,
        kind: row.target_kind,
        name: row.target_name,
        agent_session_id: row.target_session,
      } as ActorRow),
    ),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.report_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

/** 定向 @ 静默的复用入口；调用方负责保持群消息本体不变。 */
export async function filterMutedMentions(
  db: D1Database,
  roomKind: 'direct' | 'group',
  sender: string,
  targets: string[],
): Promise<string[]> {
  if (roomKind !== 'group' || targets.length === 0) return targets;
  const muted = await mutedMentionTargets(db, sender, targets);
  return muted.size === 0 ? targets : targets.filter((target) => !muted.has(target));
}

import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  DeliveryCancelInput,
  DeliveryClaimInput,
  DeliveryCompleteInput,
  DeliveryFailInput,
  DeliveryReportInput,
  DeliveryRetryInput,
  InboxListInput,
} from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import {
  eventStatement,
  inboxHeadStatement,
  inboxTopic,
  outboxStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, getDelivery, getMember, getMessage, getRoom } from '../storage/queries';
import type { DeliveryRow } from '../storage/rows';
import {
  isOneClaimedConflict,
  mapBatchError,
  operationsStatement,
  runIdempotent,
} from '../storage/transactions/runner';
import {
  finalMessagePlan,
  messageCoreStatements,
  messageGuardStatements,
  messageView,
  type MessageView,
} from './messages';
import { actorId, type Principal } from './principal';
import type { MessagePreviewView } from './rooms';
import { directBlockGuardStatement } from './contact-blocks';
import { roomDissolvedGuardStatement } from './room-access';
import { memoryMessageChangeStatements, type MemoryIntakeOptions } from '../memory/intake';

/** 投递消息在摘要之外附带发送者展示身份，避免 Agent 凭记忆猜 @ 对象。 */
export interface DeliveryMessageView extends MessagePreviewView {
  /** 发送者展示名；actor 不存在或名称为空时为 null。 */
  sender_name: string | null;
  /** 发送者类型；actor 不存在时为 null。 */
  sender_kind: 'human' | 'agent' | null;
}

export interface DeliveryView {
  delivery_id: string;
  recipient_id: string;
  message_id: string;
  room_id: string;
  state: DeliveryRow['state'];
  attempt: number;
  claim_id: string | null;
  claimed_at: string | null;
  progress_at: string | null;
  result_message_id: string | null;
  error: string | null;
  created_seq: string;
  created_at: string;
  updated_at: string;
  message: DeliveryMessageView | null;
}

export interface InboxPage {
  items: DeliveryView[];
  next_cursor: string | null;
  has_more: boolean;
  pending_count: number;
  claimed_delivery_id: string | null;
}

const encoder = new TextEncoder();
void encoder;

interface DeliveryMessageRow {
  message_id: string;
  sender_id: string;
  created_seq: number;
  preview: string;
  body_bytes: number;
  created_at: number;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
}

function senderNameOf(value: string | null): string | null {
  return value === null || value === '' ? null : value;
}

function deliveryMessageView(row: DeliveryMessageRow | null): DeliveryMessageView | null {
  if (!row) return null;
  return {
    message_id: row.message_id,
    sender_id: row.sender_id,
    sender_name: senderNameOf(row.sender_name),
    sender_kind: row.sender_kind,
    created_seq: String(row.created_seq),
    preview: row.preview,
    body_bytes: row.body_bytes,
    created_at: String(row.created_at),
  };
}

async function getDeliveryMessageView(
  db: D1Database,
  messageId: string,
): Promise<DeliveryMessageView | null> {
  const row = await db
    .prepare(
      `SELECT m.message_id, m.sender_id, m.created_seq, m.preview, m.body_bytes, m.created_at,
              a.name AS sender_name, a.kind AS sender_kind
         FROM messages m
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.message_id = ?`,
    )
    .bind(messageId)
    .first<DeliveryMessageRow>();
  return deliveryMessageView(row);
}

function view(row: DeliveryRow, message: DeliveryMessageView | null): DeliveryView {
  return {
    delivery_id: row.delivery_id,
    recipient_id: row.recipient_id,
    message_id: row.message_id,
    room_id: row.room_id,
    state: row.state,
    attempt: row.attempt,
    claim_id: row.claim_id,
    claimed_at: row.claimed_at === null ? null : String(row.claimed_at),
    progress_at: row.progress_at === null ? null : String(row.progress_at),
    result_message_id: row.result_message_id,
    error: row.error,
    created_seq: String(row.created_seq),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    message,
  };
}

async function deliveryView(db: D1Database, row: DeliveryRow): Promise<DeliveryView> {
  return view(row, await getDeliveryMessageView(db, row.message_id));
}

interface InboxRow extends DeliveryRow {
  m_preview: string;
  m_body_bytes: number;
  m_sender_id: string;
  m_sender_name: string | null;
  m_sender_kind: 'human' | 'agent' | null;
  m_created_at: number;
}

export async function inboxList(
  db: D1Database,
  principal: Principal,
  input: InboxListInput,
): Promise<InboxPage> {
  const actor = actorId(principal);
  const limit = clampPage(input.limit, LIMITS.inboxPageDefault, LIMITS.inboxPageMax);
  const scope = `inbox:${actor}`;
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const state = input.state ?? 'active';
  const states =
    state === 'all' ? null : state === 'active' ? ['pending', 'claimed'] : [state];
  const stateFilter = states ? `AND d.state IN (${states.map(() => '?').join(',')})` : '';
  const binds: unknown[] = states ? [actor, ...states] : [actor];
  if (cursor) binds.push(cursor.seq);
  binds.push(limit + 1);

  const rows = await db
    .prepare(
      `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? ${stateFilter}
          ${cursor ? 'AND d.created_seq > ?' : ''}
        ORDER BY d.created_seq ASC
        LIMIT ?`,
    )
    .bind(...binds)
    .all<InboxRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  const [actorRow, claimed] = await Promise.all([
    getActor(db, actor),
    db
      .prepare("SELECT delivery_id FROM deliveries WHERE recipient_id = ? AND state = 'claimed' LIMIT 1")
      .bind(actor)
      .first<{ delivery_id: string }>(),
  ]);

  return {
    items: page.map((row) =>
      view(row, {
        message_id: row.message_id,
        sender_id: row.m_sender_id,
        sender_name: senderNameOf(row.m_sender_name),
        sender_kind: row.m_sender_kind,
        created_seq: String(row.created_seq),
        preview: row.m_preview,
        body_bytes: row.m_body_bytes,
        created_at: String(row.m_created_at),
      }),
    ),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'after',
            seq: last.created_seq,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
    pending_count: actorRow?.pending_count ?? 0,
    claimed_delivery_id: claimed?.delivery_id ?? null,
  };
}

async function requireOwnedDelivery(
  db: D1Database,
  principal: Principal,
  deliveryId: string,
): Promise<DeliveryRow> {
  const actor = actorId(principal);
  const delivery = await getDelivery(db, deliveryId);
  if (!delivery || delivery.recipient_id !== actor) {
    throw new BusinessError('NOT_FOUND', 'delivery 不存在');
  }
  return delivery;
}

/**
 * 写入 recipient 自己的 inbox 状态事件。
 *
 * `notify` 决定是否写 `inbox:{actor}` outbox：claim/report/complete/fail 是
 * recipient 自己发起的变更，再唤醒自己会形成“claim → 唤醒 → 再读/再 claim”
 * 的回环，因此这些动作只更新事件与 `pending_count`，不产生提示。
 * 新增待办、取消与重试重新入队仍需要提示接收方，保持 `notify = true`。
 */
function inboxEventStatements(
  db: D1Database,
  actor: string,
  deliveryId: string,
  eventKey: string,
  eventType: string,
  at: number,
  pendingDelta: number,
  metadata: Record<string, unknown>,
  notify: boolean,
): D1PreparedStatement[] {
  return [
    eventStatement(
      db,
      {
        eventKey,
        scopeKind: 'inbox',
        scopeId: actor,
        eventType,
        refId: deliveryId,
        metadata,
      },
      at,
    ),
    ...(notify ? [outboxStatement(db, { topic: inboxTopic(actor), eventKey }, at)] : []),
    inboxHeadStatement(db, actor, eventKey, at, pendingDelta),
  ];
}

/**
 * 交付状态变化同时发布房间提示，让发送方页面刷新回执。
 *
 * 这里不推进 `rooms.head_seq`：回执不是消息，推进 head 会让会话列表
 * 出现没有新消息的未读点。事件本身仍进入 room scope，sync 可读到。
 */
function roomDeliveryEventStatements(
  db: D1Database,
  delivery: DeliveryRow,
  requestId: string,
  action: string,
  eventType: string,
  at: number,
  metadata: Record<string, unknown>,
): D1PreparedStatement[] {
  const eventKey = `room_delivery:${action}:${delivery.delivery_id}:${requestId}`;
  return [
    eventStatement(
      db,
      {
        eventKey,
        scopeKind: 'room',
        scopeId: delivery.room_id,
        eventType,
        refId: delivery.delivery_id,
        metadata: {
          delivery_id: delivery.delivery_id,
          message_id: delivery.message_id,
          ...metadata,
        },
      },
      at,
    ),
    outboxStatement(db, { topic: roomTopic(delivery.room_id), eventKey }, at),
  ];
}

function claimedGuard(
  db: D1Database,
  deliveryId: string,
  attempt: number,
  claimId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'staleAttempt',
        "NOT EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ? AND state = 'claimed' AND attempt = ? AND claim_id = ?)",
      ),
    )
    .bind(deliveryId, attempt, claimId);
}

interface DeliverySender {
  id: string | null;
  name: string | null;
  kind: 'human' | 'agent' | null;
}

/**
 * 原始消息发送者；用于 stream 回执的 attention、定位与展示名。
 * 消息或 actor 不存在时返回 null 字段，不让回执写入失败。
 */
async function deliverySender(
  db: D1Database,
  delivery: DeliveryRow,
): Promise<DeliverySender> {
  const row = await db
    .prepare(
      `SELECT m.sender_id, a.name, a.kind
         FROM messages m
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.message_id = ?`,
    )
    .bind(delivery.message_id)
    .first<{ sender_id: string; name: string | null; kind: 'human' | 'agent' | null }>();
  if (!row) return { id: null, name: null, kind: null };
  return {
    id: row.sender_id,
    name: senderNameOf(row.name),
    kind: row.kind ?? null,
  };
}

/** Requeueing and claiming must not restore work revoked by room or contact changes. */
function deliveryExecutionGuards(db: D1Database, delivery: DeliveryRow): D1PreparedStatement[] {
  return [
    roomDissolvedGuardStatement(db, delivery.room_id),
    directBlockGuardStatement(db, delivery.room_id),
    db.prepare(guardSql('notMember', `NOT EXISTS (
      SELECT 1 FROM room_members rm JOIN rooms r ON r.room_id = rm.room_id
      JOIN messages m ON m.message_id = ?
      WHERE rm.room_id = ? AND rm.actor_id = ? AND rm.status = 'active'
        AND (r.kind = 'direct' OR r.member_history_policy = 'full' OR m.created_seq >= rm.joined_seq)
    )`)).bind(delivery.message_id, delivery.room_id, delivery.recipient_id),
    db.prepare(guardSql('actorDisabled',
      'EXISTS (SELECT 1 FROM actors WHERE actor_id = ? AND disabled_at IS NOT NULL)',
    )).bind(delivery.recipient_id),
    db.prepare(guardSql('blocked', `EXISTS (
      SELECT 1 FROM contact_blocks b JOIN messages m ON m.sender_id = b.blocked_actor_id
      WHERE m.message_id = ? AND b.blocker_actor_id = ?
        AND b.released_at IS NULL AND b.mute_mentions = 1
    )`)).bind(delivery.message_id, delivery.recipient_id),
  ];
}

export async function deliveryClaim(
  db: D1Database,
  principal: Principal,
  input: DeliveryClaimInput,
): Promise<DeliveryView> {
  const actor = actorId(principal);
  const delivery = await requireOwnedDelivery(db, principal, input.delivery_id);

  const at = nowMs();
  const claimId = crypto.randomUUID();
  const eventKey = `claim:${delivery.delivery_id}:${input.request_id}`;
  const payloadHash = await sha256Hex(stableStringify(input));
  const sender = await deliverySender(db, delivery);

  try {
    await runIdempotent(db, {
      actorId: actor,
      requestId: input.request_id,
      payloadHash,
      result: { delivery_id: delivery.delivery_id },
      build: (resultJson) => [
        operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
        ...deliveryExecutionGuards(db, delivery),
        db
          .prepare(
            guardSql(
              'notMember',
              "NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active')",
            ),
          )
          .bind(delivery.room_id, actor),
        db
          .prepare(
            guardSql(
              'claimConflict',
              "NOT EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ? AND state = 'pending')",
            ),
          )
          .bind(delivery.delivery_id),
        db
          .prepare(
            `UPDATE deliveries
                SET state = 'claimed', attempt = attempt + 1, claim_id = ?,
                    claimed_at = ?, progress_at = ?, last_reminded_at = NULL, updated_at = ?
              WHERE delivery_id = ? AND recipient_id = ? AND state = 'pending'`,
          )
          .bind(claimId, at, at, at, delivery.delivery_id, actor),
        ...inboxEventStatements(
          db,
          actor,
          delivery.delivery_id,
          eventKey,
          'delivery_claimed',
          at,
          -1,
          { message_id: delivery.message_id, room_id: delivery.room_id },
          false,
        ),
        ...roomDeliveryEventStatements(
          db,
          delivery,
          input.request_id,
          'claim',
          'delivery_claimed',
          at,
          {
            state: 'claimed',
            actor_id: actor,
            recipient_id: delivery.recipient_id,
            sender_id: sender.id,
            sender_name: sender.name,
            sender_kind: sender.kind,
          },
        ),
      ],
    });
  } catch (error) {
    if (isOneClaimedConflict(error)) {
      throw new BusinessError('CLAIM_CONFLICT', '当前已有领取中的工作，不能并行领取');
    }
    throw mapBatchError(error) ?? error;
  }

  const updated = await getDelivery(db, delivery.delivery_id);
  if (!updated) throw new BusinessError('NOT_FOUND', 'delivery 不存在');
  return deliveryView(db, updated);
}

export async function deliveryReport(
  db: D1Database,
  principal: Principal,
  input: DeliveryReportInput,
): Promise<{ delivery_id: string; attempt: number; progress_at: string }> {
  const actor = actorId(principal);
  const delivery = await requireOwnedDelivery(db, principal, input.delivery_id);
  const at = nowMs();
  const eventKey = `progress:${delivery.delivery_id}:${input.request_id}`;
  const payloadHash = await sha256Hex(stableStringify(input));
  const sender = await deliverySender(db, delivery);

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result: { delivery_id: delivery.delivery_id, attempt: input.attempt },
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, delivery.room_id),
      claimedGuard(db, input.delivery_id, input.attempt, input.claim_id),
      db
        .prepare(
          `UPDATE deliveries
              SET progress_at = ?, last_reminded_at = NULL, updated_at = ?
            WHERE delivery_id = ?`,
        )
        .bind(at, at, delivery.delivery_id),
      ...inboxEventStatements(
        db,
        actor,
        delivery.delivery_id,
        eventKey,
        'delivery_progress',
        at,
        0,
        { status: input.status, attempt: input.attempt },
        false,
      ),
      ...roomDeliveryEventStatements(
        db,
        delivery,
        input.request_id,
        'progress',
        'delivery_progress',
        at,
        {
          state: 'claimed',
          attempt: input.attempt,
          actor_id: actor,
          recipient_id: delivery.recipient_id,
          sender_id: sender.id,
          sender_name: sender.name,
          sender_kind: sender.kind,
        },
      ),
    ],
  });

  return {
    delivery_id: delivery.delivery_id,
    attempt: input.attempt,
    progress_at: String(at),
  };
}

export interface CompleteResult {
  delivery: DeliveryView;
  message: MessageView | null;
}

export async function deliveryComplete(
  db: D1Database,
  principal: Principal,
  input: DeliveryCompleteInput,
  memory?: MemoryIntakeOptions | null,
): Promise<CompleteResult> {
  const actor = actorId(principal);
  const delivery = await requireOwnedDelivery(db, principal, input.delivery_id);

  const at = nowMs();
  const plan = input.final_body
    ? await finalMessagePlan(
        db,
        actor,
        delivery,
        input.final_body,
        input.client_message_id ?? `complete:${delivery.delivery_id}:${input.attempt}`,
      )
    : null;
  if (plan) plan.at = at;

  const eventKey = `complete:${delivery.delivery_id}:${input.request_id}`;
  const payloadHash = await sha256Hex(stableStringify(input));
  const sender = await deliverySender(db, delivery);
  const result = {
    delivery_id: delivery.delivery_id,
    message_id: plan?.messageId ?? null,
  };
  // final_body 是真实的最终消息，与 message_send 共用同一来源 key 约定；
  // 这里没有新的 delivery，因此只登记来源，不产生额外预热。
  let finalMemoryStatements: D1PreparedStatement[] = [];
  if (memory?.capture && plan) {
    const [room, member] = await Promise.all([
      getRoom(db, delivery.room_id),
      getMember(db, delivery.room_id, actor),
    ]);
    if (room && member && member.status === 'active') {
      finalMemoryStatements = memoryMessageChangeStatements(db, memory, {
        messageId: plan.messageId,
        eventKey: plan.eventKey,
        senderId: actor,
        body: plan.body,
        bodyBytes: plan.bodyBytes,
        digest: plan.body.length > 0 ? await sha256Hex(plan.body) : null,
        createdAt: at,
        roomId: room.room_id,
        origin: {
          roomId: room.room_id,
          memberGeneration: member.member_generation,
          policyRevision: room.policy_revision,
          joinedSeq: member.joined_seq,
          joinedAt: member.joined_at,
          archiveHeadSeq: room.archive_head_seq,
        },
        deliveries: [],
        taskRootId: plan.taskRootId ?? null,
        now: at,
      });
    }
  }

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, delivery.room_id),
      claimedGuard(db, delivery.delivery_id, input.attempt, input.claim_id),
      ...(plan ? [...messageGuardStatements(db, plan), ...messageCoreStatements(db, plan)] : []),
      ...finalMemoryStatements,
      db
        .prepare(
          `UPDATE deliveries
              SET state = 'completed', result_message_id = ?, error = NULL, updated_at = ?
            WHERE delivery_id = ? AND state = 'claimed' AND attempt = ? AND claim_id = ?`,
        )
        .bind(plan?.messageId ?? null, at, delivery.delivery_id, input.attempt, input.claim_id),
      ...inboxEventStatements(
        db,
        actor,
        delivery.delivery_id,
        eventKey,
        'delivery_completed',
        at,
        0,
        { message_id: delivery.message_id, attempt: input.attempt },
        false,
      ),
      ...roomDeliveryEventStatements(
        db,
        delivery,
        input.request_id,
        'complete',
        'delivery_completed',
        at,
        {
          state: 'completed',
          attempt: input.attempt,
          actor_id: actor,
          recipient_id: delivery.recipient_id,
          sender_id: sender.id,
          sender_name: sender.name,
          sender_kind: sender.kind,
        },
      ),
    ],
  });

  const updated = await getDelivery(db, delivery.delivery_id);
  if (!updated) throw new BusinessError('NOT_FOUND', 'delivery 不存在');
  const message =
    updated.result_message_id !== null ? await getMessage(db, updated.result_message_id) : null;
  return {
    delivery: await deliveryView(db, updated),
    message: message ? await messageView(db, message) : null,
  };
}

export async function deliveryFail(
  db: D1Database,
  principal: Principal,
  input: DeliveryFailInput,
): Promise<DeliveryView> {
  const actor = actorId(principal);
  const delivery = await requireOwnedDelivery(db, principal, input.delivery_id);
  const at = nowMs();
  const eventKey = `fail:${delivery.delivery_id}:${input.request_id}`;
  const payloadHash = await sha256Hex(stableStringify(input));
  const sender = await deliverySender(db, delivery);

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result: { delivery_id: delivery.delivery_id },
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      roomDissolvedGuardStatement(db, delivery.room_id),
      claimedGuard(db, delivery.delivery_id, input.attempt, input.claim_id),
      db
        .prepare(
          `UPDATE deliveries SET state = 'failed', error = ?, updated_at = ?
            WHERE delivery_id = ? AND state = 'claimed' AND attempt = ? AND claim_id = ?`,
        )
        .bind(input.error, at, delivery.delivery_id, input.attempt, input.claim_id),
      ...inboxEventStatements(
        db,
        actor,
        delivery.delivery_id,
        eventKey,
        'delivery_failed',
        at,
        0,
        { attempt: input.attempt },
        false,
      ),
      ...roomDeliveryEventStatements(
        db,
        delivery,
        input.request_id,
        'fail',
        'delivery_failed',
        at,
        {
          state: 'failed',
          attempt: input.attempt,
          actor_id: actor,
          recipient_id: delivery.recipient_id,
          sender_id: sender.id,
          sender_name: sender.name,
          sender_kind: sender.kind,
        },
      ),
    ],
  });

  const updated = await getDelivery(db, delivery.delivery_id);
  if (!updated) throw new BusinessError('NOT_FOUND', 'delivery 不存在');
  return deliveryView(db, updated);
}

async function canControlDelivery(
  db: D1Database,
  actor: string,
  delivery: DeliveryRow,
): Promise<boolean> {
  if (delivery.recipient_id === actor) return true;
  const message = await getMessage(db, delivery.message_id);
  if (message?.sender_id === actor) return true;
  const room = await getRoom(db, delivery.room_id);
  return room?.owner_id === actor;
}

export async function deliveryCancel(
  db: D1Database,
  principal: Principal,
  input: DeliveryCancelInput,
): Promise<DeliveryView> {
  const actor = actorId(principal);
  const delivery = await getDelivery(db, input.delivery_id);
  if (!delivery) throw new BusinessError('NOT_FOUND', 'delivery 不存在');
  if (!(await canControlDelivery(db, actor, delivery))) {
    throw new BusinessError('NOT_OWNER', '只有请求者、房间 owner 或接收者可以取消');
  }
  if (delivery.state === 'cancelled') return deliveryView(db, delivery);
  if (delivery.state === 'completed' || delivery.state === 'failed') {
    throw new BusinessError('CONFLICT', '已结束的工作不能取消', { state: delivery.state });
  }

  const at = nowMs();
  const eventKey = `cancel:${delivery.delivery_id}:${input.request_id}`;
  const payloadHash = await sha256Hex(stableStringify(input));
  const sender = await deliverySender(db, delivery);

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result: { delivery_id: delivery.delivery_id },
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'claimConflict',
            "NOT EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ? AND state IN ('pending', 'claimed'))",
          ),
        )
        .bind(delivery.delivery_id),
      // 只有 pending 计入 pending_count；按执行时的真实状态扣减，避免与 claim 竞态。
      db
        .prepare(
          `UPDATE actors
              SET pending_count = pending_count - (
                    SELECT CASE WHEN state = 'pending' THEN 1 ELSE 0 END
                      FROM deliveries WHERE delivery_id = ?
                  ),
                  updated_at = ?
            WHERE actor_id = ?`,
        )
        .bind(delivery.delivery_id, at, delivery.recipient_id),
      db
        .prepare(
          `UPDATE deliveries SET state = 'cancelled', error = ?, updated_at = ?
            WHERE delivery_id = ? AND state IN ('pending', 'claimed')`,
        )
        .bind(input.reason, at, delivery.delivery_id),
      ...inboxEventStatements(
        db,
        delivery.recipient_id,
        delivery.delivery_id,
        eventKey,
        'delivery_cancelled',
        at,
        0,
        {
          reason: input.reason,
          actor_id: actor,
          room_id: delivery.room_id,
          message_id: delivery.message_id,
          sender_id: sender.id,
          sender_name: sender.name,
          sender_kind: sender.kind,
        },
        true,
      ),
      ...roomDeliveryEventStatements(
        db,
        delivery,
        input.request_id,
        'cancel',
        'delivery_cancelled',
        at,
        {
          state: 'cancelled',
          actor_id: actor,
          recipient_id: delivery.recipient_id,
          sender_id: sender.id,
          sender_name: sender.name,
          sender_kind: sender.kind,
        },
      ),
    ],
  });

  const updated = await getDelivery(db, delivery.delivery_id);
  if (!updated) throw new BusinessError('NOT_FOUND', 'delivery 不存在');
  return deliveryView(db, updated);
}

export async function deliveryRetry(
  db: D1Database,
  principal: Principal,
  input: DeliveryRetryInput,
): Promise<DeliveryView> {
  const actor = actorId(principal);
  const delivery = await getDelivery(db, input.delivery_id);
  if (!delivery) throw new BusinessError('NOT_FOUND', 'delivery 不存在');
  if (!(await canControlDelivery(db, actor, delivery))) {
    throw new BusinessError('NOT_OWNER', '只有请求者或房间 owner 可以重试');
  }

  const at = nowMs();
  const eventKey = `retry:${delivery.delivery_id}:${input.request_id}`;
  const payloadHash = await sha256Hex(stableStringify(input));
  const sender = await deliverySender(db, delivery);

  await runIdempotent(db, {
    actorId: actor,
    requestId: input.request_id,
    payloadHash,
    result: { delivery_id: delivery.delivery_id },
    build: (resultJson) => [
      operationsStatement(db, actor, input.request_id, payloadHash, resultJson, at),
      ...deliveryExecutionGuards(db, delivery),
      db.prepare(guardSql('notMember', `NOT EXISTS (
        SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'
      )`)).bind(delivery.room_id, actor),
      db.prepare(guardSql('notOwner', `NOT EXISTS (
        SELECT 1 FROM deliveries d JOIN messages m ON m.message_id = d.message_id
        JOIN rooms r ON r.room_id = d.room_id
        WHERE d.delivery_id = ? AND (d.recipient_id = ? OR m.sender_id = ? OR r.owner_id = ?)
      )`)).bind(delivery.delivery_id, actor, actor, actor),
      db.prepare(guardSql('queueFull',
        "(SELECT COUNT(*) FROM deliveries WHERE recipient_id = ? AND state = 'pending') + 1 > ?",
      )).bind(delivery.recipient_id, LIMITS.pendingPerActor),
      db
        .prepare(
          guardSql(
            'staleAttempt',
            'NOT EXISTS (SELECT 1 FROM deliveries WHERE delivery_id = ? AND attempt = ? AND state IN (\'failed\', \'cancelled\', \'claimed\'))',
          ),
        )
        .bind(delivery.delivery_id, input.expected_attempt),
      db
        .prepare(
          `UPDATE deliveries
              SET state = 'pending', claim_id = NULL, claimed_at = NULL, progress_at = NULL,
                  last_reminded_at = NULL, error = NULL, updated_at = ?
            WHERE delivery_id = ? AND attempt = ? AND state IN ('failed', 'cancelled', 'claimed')`,
        )
        .bind(at, delivery.delivery_id, input.expected_attempt),
      ...inboxEventStatements(
        db,
        delivery.recipient_id,
        delivery.delivery_id,
        eventKey,
        'delivery_retried',
        at,
        1,
        {
          attempt: input.expected_attempt,
          actor_id: actor,
          room_id: delivery.room_id,
          message_id: delivery.message_id,
          sender_id: sender.id,
          sender_name: sender.name,
          sender_kind: sender.kind,
        },
        true,
      ),
      ...roomDeliveryEventStatements(
        db,
        delivery,
        input.request_id,
        'retry',
        'delivery_retried',
        at,
        {
          state: 'pending',
          attempt: input.expected_attempt,
          actor_id: actor,
          recipient_id: delivery.recipient_id,
          sender_id: sender.id,
          sender_name: sender.name,
          sender_kind: sender.kind,
        },
      ),
    ],
  });

  const updated = await getDelivery(db, delivery.delivery_id);
  if (!updated) throw new BusinessError('NOT_FOUND', 'delivery 不存在');
  return deliveryView(db, updated);
}

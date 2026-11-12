import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type { ContactRequestInput } from '../contracts/schemas';
import { sortedPairKey } from '../storage/db';
import {
  eventStatementIfAbsent,
  inboxHeadStatement,
  inboxHeadStatementIfEvent,
  inboxTopic,
  outboxStatementIfAbsent,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, type D1Like } from '../storage/queries';
import type { ActorRow, ContactRelationRow, ContactRequestRow } from '../storage/rows';
import { mapBatchError } from '../storage/transactions/runner';
import { getActiveManagement } from './agent-access';
import { contactBlockGuardStatement } from './contact-blocks';
import { resolveContactTarget } from './contact-target';
import { directRoomIdFor, directRoomStatements } from './direct-room';

/**
 * 双向联系人关系与好友申请共享的底层能力。
 *
 * `contacts` 是单侧个人收藏/历史，不是同意；双向关系只认
 * `contact_relations`。申请、拒绝、过期与撤销只写持久事件，不产生
 * delivery，也不向 Agent 的 actor stream 写 outbox，避免唤醒 Agent 执行任务。
 * 好友邀请链接兑换同样复用这里的双向关系写入，但它是直接建联、没有申请。
 */

export type ContactRequestStatus =
  | 'pending'
  | 'accepted'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface ContactActorView {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  agent_session_id: string | null;
}

export interface ContactRequestView {
  contact_request_id: string;
  status: ContactRequestStatus;
  direction: 'incoming' | 'outgoing';
  message: string;
  auto_accepted: boolean;
  from_actor: ContactActorView;
  to_actor: ContactActorView;
  created_at: string;
  updated_at: string;
  expires_at: string;
  responded_at: string | null;
  responded_by: string | null;
  can_respond: boolean;
  can_cancel: boolean;
}

export interface ContactRelationView {
  pair_key: string;
  actor_ids: string[];
  status: 'active' | 'ended';
  source: 'request' | 'auto_manager' | 'invite_link';
  created_at: string;
  updated_at: string;
  ended_at: string | null;
}

export interface ContactRequestResult {
  request: ContactRequestView | null;
  relation: ContactRelationView | null;
  status: ContactRequestStatus;
  already_friends: boolean;
  auto_accepted: boolean;
}

export interface ContactRequestPage {
  items: ContactRequestView[];
  next_cursor: string | null;
  has_more: boolean;
}

export function actorView(actor: ActorRow): ContactActorView {
  return {
    actor_id: actor.actor_id,
    kind: actor.kind,
    name: actor.name,
    agent_session_id: actor.agent_session_id,
  };
}

export function relationView(row: ContactRelationRow): ContactRelationView {
  return {
    pair_key: row.pair_key,
    actor_ids: [row.actor_a, row.actor_b],
    status: row.status,
    source: row.source,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    ended_at: row.ended_at === null ? null : String(row.ended_at),
  };
}

export async function getActiveRelation(
  db: D1Like,
  actorA: string,
  actorB: string,
): Promise<ContactRelationRow | null> {
  const pairKey = sortedPairKey(actorA, actorB);
  return db
    .prepare("SELECT * FROM contact_relations WHERE pair_key = ? AND status = 'active'")
    .bind(pairKey)
    .first<ContactRelationRow>();
}

export async function getRelationByPair(
  db: D1Like,
  pairKey: string,
): Promise<ContactRelationRow | null> {
  return db
    .prepare('SELECT * FROM contact_relations WHERE pair_key = ?')
    .bind(pairKey)
    .first<ContactRelationRow>();
}

/**
 * 关系结束是否来自拉黑（含解除拉黑后仍保留的历史记录）。
 *
 * `owner`、`peer`、`endedAt` 必须是代码内固定的列表达式，不能来自用户输入。
 * 拉黑与删除好友都会把关系写成 `ended`：拉黑后联系人仍以 `relation=none`
 * 可见并保留会话入口，删除好友则应从双方默认列表隐藏。解除拉黑时间不早于
 * 关系结束时间即可认定是拉黑来源；之后重新建联再删除时，新的 `ended_at`
 * 会晚于旧拉黑记录，仍按删除处理。
 */
export function relationEndedByBlockSql(
  owner: string,
  peer: string,
  endedAt: string,
): string {
  return `EXISTS (
    SELECT 1
      FROM contact_blocks block_history
     WHERE (block_history.released_at IS NULL OR block_history.released_at >= ${endedAt})
       AND (
         (block_history.blocker_actor_id = ${owner}
          AND block_history.blocked_actor_id = ${peer})
         OR
         (block_history.blocker_actor_id = ${peer}
          AND block_history.blocked_actor_id = ${owner})
       )
  )`;
}

/**
 * 双方任意一人删除好友都会结束共享关系；个人收藏行由调用方处理。
 *
 * `notifyTarget` 默认为 true（删除好友需要让对方刷新关系）；
 * 拉黑传 false，避免把拉黑本身变成一条对对方的个人提醒。
 */
export function endRelationStatements(
  db: D1Database,
  owner: string,
  target: ActorRow,
  requestId: string,
  at: number,
  options: { notifyTarget?: boolean } = {},
): D1PreparedStatement[] {
  const pairKey = sortedPairKey(owner, target.actor_id);
  const eventKey = `contact_relation_ended:${owner}:${requestId}`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE contact_relations
            SET status = 'ended', ended_at = ?, ended_by = ?, updated_at = ?
          WHERE pair_key = ? AND status = 'active'`,
      )
      .bind(at, owner, at, pairKey),
  ];
  if (options.notifyTarget === false) return statements;
  statements.push(
    db
      .prepare(
        `INSERT INTO events
           (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
         SELECT 'inbox', ?, 'contact_relation_ended', ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM contact_relations
             WHERE pair_key = ? AND status = 'ended' AND ended_by = ? AND ended_at = ?
          )
         ON CONFLICT(event_key) DO NOTHING`,
      )
      .bind(
        target.actor_id,
        pairKey,
        JSON.stringify({ pair_key: pairKey, ended_by: owner }),
        eventKey,
        at,
        pairKey,
        owner,
        at,
      ),
    inboxHeadStatementIfEvent(db, target.actor_id, eventKey, at, 0),
  );
  if (target.kind === 'human') {
    statements.push(outboxStatementIfAbsent(db, { topic: inboxTopic(target.actor_id), eventKey }, at));
  }
  return statements;
}

/**
 * direct 房间创建时的关系校验。
 *
 * 关系 active 或“管理者↔自有 Agent”允许；后者在同一事务内自动建立关系并
 * 写入双方个人收藏。闸门始终执行，避免预检后关系被另一端删除。
 */
export function directRelationStatements(
  db: D1Database,
  owner: string,
  target: ActorRow,
  at: number,
): D1PreparedStatement[] {
  const pairKey = sortedPairKey(owner, target.actor_id);
  const [actorA, actorB] = [owner, target.actor_id].sort();
  return [
    // 拉黑优先于好友关系：同一事务内先拒绝，避免预检后被另一端绕过。
    contactBlockGuardStatement(db, owner, target.actor_id),
    db
      .prepare(
        guardSql(
          'friendRequired',
          `NOT EXISTS (
             SELECT 1 FROM contact_relations WHERE pair_key = ? AND status = 'active'
           )
           AND NOT EXISTS (
             SELECT 1 FROM agent_managements
              WHERE status = 'active'
                AND ((agent_id = ? AND manager_id = ?) OR (agent_id = ? AND manager_id = ?))
           )`,
        ),
      )
      .bind(pairKey, owner, target.actor_id, target.actor_id, owner),
    db
      .prepare(
        `INSERT INTO contact_relations
           (pair_key, actor_a, actor_b, status, source, request_id, created_at, updated_at)
         SELECT ?, ?, ?, 'active', 'auto_manager', NULL, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM agent_managements
             WHERE status = 'active'
               AND ((agent_id = ? AND manager_id = ?) OR (agent_id = ? AND manager_id = ?))
          )
         ON CONFLICT(pair_key) DO UPDATE SET
           status = 'active',
           source = 'auto_manager',
           updated_at = excluded.updated_at,
           ended_at = NULL,
           ended_by = NULL
         WHERE contact_relations.status <> 'active'`,
      )
      .bind(pairKey, actorA, actorB, at, at, owner, target.actor_id, target.actor_id, owner),
    contactPairInsert(db, owner, target.actor_id, at),
    contactPairInsert(db, target.actor_id, owner, at),
  ];
}

/** direct 房间内的新消息必须仍有 active 关系；历史读取不经过该闸门。 */
export function directMessageGuardStatement(
  db: D1Database,
  roomId: string,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'friendRequired',
        `EXISTS (SELECT 1 FROM rooms r WHERE r.room_id = ? AND r.kind = 'direct')
         AND NOT EXISTS (
           SELECT 1
             FROM rooms r
             JOIN contact_relations c ON c.pair_key = r.direct_pair_key
            WHERE r.room_id = ? AND c.status = 'active'
         )`,
      ),
    )
    .bind(roomId, roomId);
}

export function contactPairInsert(
  db: D1Database,
  owner: string,
  target: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO contacts (owner_actor_id, target_actor_id, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(owner_actor_id, target_actor_id) DO NOTHING`,
    )
    .bind(owner, target, at);
}

/**
 * 接受申请、管理者自动建联或好友链接兑换时复用；upsert 不会重复写 contacts。
 *
 * 关系激活与 direct 房间创建必须同事务：房间 id 由 pair_key 确定性生成，
 * 重复接受、幂等重放或并发激活都只会命中已有的 `rooms`/事件行。这里不套用
 * 显式建房的活跃房间上限，避免好友关系因房间配额而无法建立；显式
 * `network_room_create` 仍保留原有限制。
 */
export async function activateRelationStatements(
  db: D1Database,
  actorAId: string,
  actorBId: string,
  source: 'request' | 'auto_manager' | 'invite_link',
  requestId: string | null,
  at: number,
): Promise<D1PreparedStatement[]> {
  const pairKey = sortedPairKey(actorAId, actorBId);
  const [actorA, actorB] = [actorAId, actorBId].sort();
  const roomId = await directRoomIdFor(actorAId, actorBId);
  return [
    db
      .prepare(
        `INSERT INTO contact_relations
           (pair_key, actor_a, actor_b, status, source, request_id, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
         ON CONFLICT(pair_key) DO UPDATE SET
           status = 'active',
           source = excluded.source,
           request_id = COALESCE(excluded.request_id, contact_relations.request_id),
           updated_at = excluded.updated_at,
           ended_at = NULL,
           ended_by = NULL`,
      )
      .bind(pairKey, actorA, actorB, source, requestId, at, at),
    contactPairInsert(db, actorAId, actorBId, at),
    contactPairInsert(db, actorBId, actorAId, at),
    ...directRoomStatements(db, actorAId, actorBId, roomId, at),
  ];
}

export async function resolveTarget(
  db: D1Database,
  input: ContactRequestInput,
): Promise<ActorRow> {
  return resolveContactTarget(db, input);
}

export async function pendingForPair(
  db: D1Like,
  pairKey: string,
): Promise<ContactRequestRow | null> {
  return db
    .prepare("SELECT * FROM contact_requests WHERE pair_key = ? AND status = 'pending'")
    .bind(pairKey)
    .first<ContactRequestRow>();
}

export async function getRequest(
  db: D1Like,
  contactRequestId: string,
): Promise<ContactRequestRow | null> {
  return db
    .prepare('SELECT * FROM contact_requests WHERE contact_request_id = ?')
    .bind(contactRequestId)
    .first<ContactRequestRow>();
}

/**
 * 好友申请通知：events + inbox head 持久化；仅人类收件箱写 outbox。
 * Agent 的通知不进入 actor stream，避免被误当成新任务唤醒。
 */
export function notificationStatements(
  db: D1Database,
  actor: ActorRow,
  spec: { eventKey: string; eventType: string; refId: string; metadata: Record<string, unknown> },
  at: number,
): D1PreparedStatement[] {
  const statements = [
    eventStatementIfAbsent(
      db,
      {
        eventKey: spec.eventKey,
        scopeKind: 'inbox',
        scopeId: actor.actor_id,
        eventType: spec.eventType,
        refId: spec.refId,
        metadata: spec.metadata,
      },
      at,
    ),
    inboxHeadStatement(db, actor.actor_id, spec.eventKey, at, 0),
  ];
  if (actor.kind === 'human') {
    statements.push(
      outboxStatementIfAbsent(db, { topic: inboxTopic(actor.actor_id), eventKey: spec.eventKey }, at),
    );
  }
  return statements;
}

export async function expireRequestRow(
  db: D1Database,
  row: ContactRequestRow,
  at: number,
): Promise<void> {
  if (row.status !== 'pending' || row.expires_at > at) return;
  const eventKey = `contact_request_expired:${row.contact_request_id}`;
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE contact_requests
            SET status = 'expired', updated_at = ?, responded_at = ?, responded_by = NULL
          WHERE contact_request_id = ? AND status = 'pending'`,
      )
      .bind(at, at, row.contact_request_id),
    db
      .prepare(
        `INSERT INTO events
           (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
         SELECT 'inbox', ?, 'contact_request_expired', ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM contact_requests
             WHERE contact_request_id = ? AND status = 'expired'
          )
         ON CONFLICT(event_key) DO NOTHING`,
      )
      .bind(
        row.from_actor_id,
        row.contact_request_id,
        JSON.stringify({
          pair_key: row.pair_key,
          from_actor_id: row.from_actor_id,
          to_actor_id: row.to_actor_id,
        }),
        eventKey,
        at,
        row.contact_request_id,
      ),
    inboxHeadStatementIfEvent(db, row.from_actor_id, eventKey, at, 0),
  ];
  const requester = await getActor(db, row.from_actor_id);
  if (requester?.kind === 'human') {
    statements.push(outboxStatementIfAbsent(db, { topic: inboxTopic(requester.actor_id), eventKey }, at));
  }
  await db.batch(statements);
}

/** 惰性 + 维护任务共用的过期扫描；事件与状态同一批次写入。 */
export async function expireContactRequests(
  db: D1Database,
  at: number,
  limit = LIMITS.contactRequestExpiryBatchMax,
): Promise<number> {
  const rows = await db
    .prepare(
      `SELECT * FROM contact_requests
        WHERE status = 'pending' AND expires_at <= ?
        ORDER BY expires_at ASC, contact_request_id ASC
        LIMIT ?`,
    )
    .bind(at, limit)
    .all<ContactRequestRow>();
  let expired = 0;
  for (const row of rows.results) {
    try {
      await expireRequestRow(db, row, at);
      expired += 1;
    } catch (error) {
      if (!mapBatchError(error)) throw error;
    }
  }
  return expired;
}

export async function expireForPair(
  db: D1Database,
  pairKey: string,
  at: number,
): Promise<void> {
  const row = await db
    .prepare(
      `SELECT * FROM contact_requests
        WHERE pair_key = ? AND status = 'pending' AND expires_at <= ?`,
    )
    .bind(pairKey, at)
    .first<ContactRequestRow>();
  if (row) {
    try {
      await expireRequestRow(db, row, at);
    } catch (error) {
      if (!mapBatchError(error)) throw error;
    }
  }
}

/** 当前管理者与本 Agent 之间的申请自动建立关系；其他 Agent 仍走策略。 */
export async function isManagerAgentPair(
  db: D1Database,
  caller: ActorRow,
  target: ActorRow,
): Promise<boolean> {
  if (caller.kind === 'human' && target.kind === 'agent') {
    const management = await getActiveManagement(db, target.actor_id);
    return management?.manager_id === caller.actor_id;
  }
  if (caller.kind === 'agent' && target.kind === 'human') {
    const management = await getActiveManagement(db, caller.actor_id);
    return management?.manager_id === target.actor_id;
  }
  return false;
}

export function isPendingPairConflict(error: unknown): boolean {
  return String(error).includes('idx_contact_requests_pending_pair');
}

export function joinedRequestView(
  row: ContactRequestRow & {
    from_kind: 'human' | 'agent';
    from_name: string;
    from_session: string | null;
    to_kind: 'human' | 'agent';
    to_name: string;
    to_session: string | null;
  },
  viewer: string,
): ContactRequestView {
  return {
    contact_request_id: row.contact_request_id,
    status: row.status,
    direction: row.from_actor_id === viewer ? 'outgoing' : 'incoming',
    message: row.message,
    auto_accepted: row.auto_accepted === 1,
    from_actor: {
      actor_id: row.from_actor_id,
      kind: row.from_kind,
      name: row.from_name,
      agent_session_id: row.from_session,
    },
    to_actor: {
      actor_id: row.to_actor_id,
      kind: row.to_kind,
      name: row.to_name,
      agent_session_id: row.to_session,
    },
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    expires_at: String(row.expires_at),
    responded_at: row.responded_at === null ? null : String(row.responded_at),
    responded_by: row.responded_by,
    can_respond: false,
    can_cancel: row.status === 'pending' && row.from_actor_id === viewer,
  };
}

import { newId } from './db';

export interface EventSpec {
  eventKey: string;
  scopeKind: 'room' | 'inbox' | 'actor';
  scopeId: string;
  eventType: string;
  refId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface OutboxSpec {
  topic: string;
  eventKey: string;
}

/** 插入 events；event_key 是事务内唯一的事件身份。 */
export function eventStatement(db: D1Database, spec: EventSpec, at: number): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      spec.scopeKind,
      spec.scopeId,
      spec.eventType,
      spec.refId ?? null,
      JSON.stringify(spec.metadata ?? {}),
      spec.eventKey,
      at,
    );
}

/**
 * 幂等插入事件：同一 event_key 已存在时保持原行。
 *
 * 仅用于 event_key 由业务身份（而非本次请求）决定、且并发创建必须收敛到同一行的场景，
 * 例如单聊房间的 `room_created`。普通业务事件使用 {@link eventStatement}，
 * 让重复插入显式失败。
 */
export function eventStatementIfAbsent(
  db: D1Database,
  spec: EventSpec,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_key) DO NOTHING`,
    )
    .bind(
      spec.scopeKind,
      spec.scopeId,
      spec.eventType,
      spec.refId ?? null,
      JSON.stringify(spec.metadata ?? {}),
      spec.eventKey,
      at,
    );
}

/** 插入 outbox；event_seq 由同一事务内已写入的 event_key 解析。 */
export function outboxStatement(
  db: D1Database,
  spec: OutboxSpec,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (outbox_id, topic, event_seq, status, attempts, next_attempt_at, created_at)
       VALUES (?, ?, (SELECT event_seq FROM events WHERE event_key = ?), 'pending', 0, ?, ?)`,
    )
    .bind(newId('obx'), spec.topic, spec.eventKey, at, at);
}

/**
 * 幂等 outbox：同一 (topic, event_seq) 只保留一行。
 *
 * 对应事件可能由 `INSERT ... SELECT ... WHERE EXISTS` 条件写入（例如并发
 * 下状态已被另一端改变），此时不能写入 NULL `event_seq`：列声明为
 * NOT NULL，一旦插入会回滚整个事务。这里从 events 取行，事件不存在时
 * 直接不产生 outbox；提示本来也只对已落库的事件有意义。
 */
export function outboxStatementIfAbsent(
  db: D1Database,
  spec: OutboxSpec,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (outbox_id, topic, event_seq, status, attempts, next_attempt_at, created_at)
       SELECT ?, ?, e.event_seq, 'pending', 0, ?, ?
         FROM events e
        WHERE e.event_key = ?
       ON CONFLICT(topic, event_seq) DO NOTHING`,
    )
    .bind(newId('obx'), spec.topic, at, at, spec.eventKey);
}

/**
 * 幂等 outbox，且要求事件 metadata 的指定字段等于本次操作标识。
 *
 * 撤回事件使用稳定的 `message_recalled:<message_id>` key；重复撤回请求不能
 * 因为 outbox 已被 GC 就对旧事件补写提示。调用方只传受控的 metadata 键与
 * 本次 nonce，不拼接用户输入 SQL。
 */
export function outboxStatementIfEventMetadata(
  db: D1Database,
  spec: OutboxSpec,
  metadataKey: string,
  metadataValue: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (outbox_id, topic, event_seq, status, attempts, next_attempt_at, created_at)
       SELECT ?, ?, e.event_seq, 'pending', 0, ?, ?
         FROM events e
        WHERE e.event_key = ? AND json_extract(e.metadata, ?) = ?
       ON CONFLICT(topic, event_seq) DO NOTHING`,
    )
    .bind(newId('obx'), spec.topic, at, at, spec.eventKey, `$.${metadataKey}`, metadataValue);
}

export function roomTopic(roomId: string): string {
  return `room:${roomId}`;
}

export function inboxTopic(actorId: string): string {
  return `inbox:${actorId}`;
}

/** 统一 actor stream 的进程内通知 topic。 */
export function actorTopic(actorId: string): string {
  return `actor:${actorId}`;
}

/** 更新房间 head 与 member 版本（成员事件使用同一 head 序号）。 */
export function roomHeadStatement(
  db: D1Database,
  roomId: string,
  eventKey: string,
  at: number,
  lastMessageId?: string,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE rooms
         SET head_seq = MAX(head_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
             last_message_id = COALESCE(?, last_message_id),
             updated_at = ?
       WHERE room_id = ?`,
    )
    .bind(eventKey, lastMessageId ?? null, at, roomId);
}

export function roomMemberSeqStatement(
  db: D1Database,
  roomId: string,
  eventKey: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE rooms
         SET head_seq = MAX(head_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
             member_seq = MAX(member_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
             updated_at = ?
       WHERE room_id = ?`,
    )
    .bind(eventKey, eventKey, at, roomId);
}

/**
 * 只推进成员版本，不推进消息 head。
 *
 * 接受邀请等成员变化对客户端可见，但不是聊天消息：推进 head 会让
 * `last_read_seq !== head_seq`，在邀请人会话里制造一条没有内容的未读。
 * 历史边界仍由成员的 `joined_seq` 独立表达。
 */
export function roomMemberVersionStatement(
  db: D1Database,
  roomId: string,
  eventKey: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE rooms
         SET member_seq = MAX(member_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
             updated_at = ?
       WHERE room_id = ?`,
    )
    .bind(eventKey, at, roomId);
}

export function inboxHeadStatement(
  db: D1Database,
  actorId: string,
  eventKey: string,
  at: number,
  pendingDelta: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE actors
         SET inbox_head_seq = MAX(inbox_head_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
             pending_count = pending_count + ?,
             updated_at = ?
       WHERE actor_id = ?`,
    )
    .bind(eventKey, pendingDelta, at, actorId);
}

/**
 * 仅在事件确实已插入时推进 inbox head。
 *
 * 用于由后台扫描条件写入的事件：并发扫描或状态已被 report 改变时，
 * INSERT ... SELECT 可能不产生行，此时不能用 NULL 覆盖 head。
 * `pendingDelta` 仍走同一字段；提醒类事件固定传 0。
 */
export function inboxHeadStatementIfEvent(
  db: D1Database,
  actorId: string,
  eventKey: string,
  at: number,
  pendingDelta: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE actors
         SET inbox_head_seq = MAX(inbox_head_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
             pending_count = pending_count + ?,
             updated_at = ?
       WHERE actor_id = ? AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
    )
    .bind(eventKey, pendingDelta, at, actorId, eventKey);
}

/**
 * 仅在本次事件已插入时推进 inbox head，并按事件 metadata 的
 * `previous_state` 受控扣减 `pending_count`。
 *
 * 只供“条件取消 pending/claimed 投递”使用：只有 pending 计入待办，claimed
 * 取消不扣减。delta 从本次事件自身读取，不接受调用方传入的任意 SQL；事件
 * 不存在时不更新任何列。
 */
export function inboxHeadStatementIfEventPreviousState(
  db: D1Database,
  actorId: string,
  eventKey: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE actors
         SET inbox_head_seq = MAX(inbox_head_seq, (SELECT event_seq FROM events WHERE event_key = ?)),
             pending_count = pending_count + COALESCE((
               SELECT CASE WHEN json_extract(metadata, '$.previous_state') = 'pending' THEN -1 ELSE 0 END
                 FROM events WHERE event_key = ?
             ), 0),
             updated_at = ?
       WHERE actor_id = ? AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
    )
    .bind(eventKey, eventKey, at, actorId, eventKey);
}

/** 房间创建时所有参与者的 inbox 事件（含分享入口），重复执行不产生新提示。 */
export function inboxChangeStatements(
  db: D1Database,
  actorIds: string[],
  eventKeyFor: (actor: string) => string,
  eventType: string,
  at: number,
  refId: string,
  onlyIfMember = false,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const actor of actorIds) {
    const eventKey = eventKeyFor(actor);
    statements.push(
      onlyIfMember
        ? db
            .prepare(
              `INSERT INTO events
                 (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
               SELECT 'inbox', ?, ?, ?, ?, ?, ?
                WHERE EXISTS (
                  SELECT 1 FROM room_members
                   WHERE room_id = ? AND actor_id = ? AND status = 'active'
                )
               ON CONFLICT(event_key) DO NOTHING`,
            )
            .bind(actor, eventType, refId, JSON.stringify({}), eventKey, at, refId, actor)
        : eventStatementIfAbsent(
            db,
            { eventKey, scopeKind: 'inbox', scopeId: actor, eventType, refId },
            at,
          ),
      outboxStatementIfAbsent(db, { topic: inboxTopic(actor), eventKey }, at),
      inboxHeadStatementIfEvent(db, actor, eventKey, at, 0),
    );
  }
  return statements;
}

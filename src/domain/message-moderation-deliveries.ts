import { inboxHeadStatementIfEventPreviousState, inboxTopic, outboxStatementIfAbsent, roomTopic } from '../storage/events';

/**
 * 消息撤回取消投递的 SQL 生成器。
 *
 * 只生成语句，不执行、不拆事务。`messageRecall` 把这些语句与撤回事件、
 * 正文清空、置顶清理和审计放进同一个 `db.batch()`，保证全有或全无。
 *
 * 条件事件先读真实 `deliveries.state`，再由后续 UPDATE 只处理
 * pending/claimed；completed/failed/cancelled 保持原状态。所有副作用都
 * 要求本次撤回转换事件（含 `operation_nonce`）在同批可见，避免并发撤回
 * 的第二批把取消/计数错误归属给自己。
 */
export interface MessageRecallTransition {
  roomId: string;
  messageId: string;
  /** 实际执行撤回的 actor（owner 或消息作者）。 */
  actorId: string;
  /** 本次 batch 的唯一转换标识；只写入事件 metadata，不是凭据。 */
  nonce: string;
  at: number;
}

/** 被撤回消息预读到的投递身份；状态在 batch 执行时重新判定。 */
export interface RecallDeliveryRef {
  delivery_id: string;
  recipient_id: string;
}

export function messageRecallEventKey(messageId: string): string {
  return `message_recalled:${messageId}`;
}

export function cancelMessageDeliveriesStatements(
  db: D1Database,
  deliveries: RecallDeliveryRef[],
  transition: MessageRecallTransition,
): D1PreparedStatement[] {
  const recallKey = messageRecallEventKey(transition.messageId);
  const statements: D1PreparedStatement[] = [];

  for (const delivery of deliveries) {
    const inboxKey = `recall_cancel:${delivery.delivery_id}:${transition.nonce}`;
    const roomKey = `room_delivery:recall_cancel:${delivery.delivery_id}:${transition.nonce}`;

    statements.push(
      // 只有真实 pending/claimed 且本次撤回转换存在时才产生 inbox 取消事件。
      db
        .prepare(
          `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
           SELECT 'inbox', d.recipient_id, 'delivery_cancelled', d.delivery_id,
                  json_object(
                    'room_id', d.room_id,
                    'message_id', d.message_id,
                    'delivery_id', d.delivery_id,
                    'recipient_id', d.recipient_id,
                    'sender_id', m.sender_id,
                    'actor_id', ?,
                    'state', 'cancelled',
                    'attempt', d.attempt,
                    'previous_state', d.state,
                    'reason', 'message_recalled'
                  ),
                  ?, ?
             FROM deliveries d
             JOIN messages m ON m.message_id = d.message_id
            WHERE d.delivery_id = ? AND d.state IN ('pending', 'claimed')
              AND EXISTS (
                SELECT 1 FROM events
                 WHERE event_key = ? AND json_extract(metadata, '$.operation_nonce') = ?
              )`,
        )
        .bind(
          transition.actorId,
          inboxKey,
          transition.at,
          delivery.delivery_id,
          recallKey,
          transition.nonce,
        ),
      // pending_count 仍只由 inboxHead helper 维护；delta 从事件自身读取。
      inboxHeadStatementIfEventPreviousState(db, delivery.recipient_id, inboxKey, transition.at),
      // 取消仍通知 recipient；撤回者自己不需要被自己的状态变更唤醒。
      ...(delivery.recipient_id === transition.actorId
        ? []
        : [
            outboxStatementIfAbsent(
              db,
              { topic: inboxTopic(delivery.recipient_id), eventKey: inboxKey },
              transition.at,
            ),
          ]),
      // 房间回执：只在本次 inbox 取消事件已写入时发布，沿用 room_delivery 形态。
      db
        .prepare(
          `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
           SELECT 'room', d.room_id, 'delivery_cancelled', d.delivery_id,
                  json_object(
                    'delivery_id', d.delivery_id,
                    'message_id', d.message_id,
                    'state', 'cancelled',
                    'reason', 'message_recalled',
                    'actor_id', ?,
                    'recipient_id', d.recipient_id,
                    'sender_id', m.sender_id
                  ),
                  ?, ?
             FROM deliveries d
             JOIN messages m ON m.message_id = d.message_id
            WHERE d.delivery_id = ?
              AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
        )
        .bind(transition.actorId, roomKey, transition.at, delivery.delivery_id, inboxKey),
      outboxStatementIfAbsent(
        db,
        { topic: roomTopic(transition.roomId), eventKey: roomKey },
        transition.at,
      ),
      // 只把仍处于 pending/claimed 的投递转为 cancelled；已结束状态原样保留。
      db
        .prepare(
          `UPDATE deliveries
              SET state = 'cancelled', error = 'message_recalled', updated_at = ?
            WHERE delivery_id = ? AND state IN ('pending', 'claimed')
              AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
        )
        .bind(transition.at, delivery.delivery_id, inboxKey),
    );
  }

  return statements;
}

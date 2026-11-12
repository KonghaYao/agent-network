/**
 * 取消未结束投递的唯一 SQL 入口。
 *
 * 调用方负责在同一事务内先维护 `pending_count`（只有 `pending` 计入），本 helper
 * 只改 `deliveries.state`，不写事件、不调整计数，保持原事务顺序与语义。
 */
export interface OpenDeliveryFilter {
  roomId?: string;
  recipientId?: string;
  /** 只取消该发送者消息产生的投递。 */
  senderId?: string;
}

export function cancelOpenDeliveriesStatement(
  db: D1Database,
  filter: OpenDeliveryFilter,
  reason: string,
  at: number,
): D1PreparedStatement {
  const conditions = ["state IN ('pending', 'claimed')"];
  const params: string[] = [];
  if (filter.roomId !== undefined) {
    conditions.push('room_id = ?');
    params.push(filter.roomId);
  }
  if (filter.recipientId !== undefined) {
    conditions.push('recipient_id = ?');
    params.push(filter.recipientId);
  }
  if (filter.senderId !== undefined) {
    conditions.push('message_id IN (SELECT message_id FROM messages WHERE sender_id = ?)');
    params.push(filter.senderId);
  }
  return db
    .prepare(
      `UPDATE deliveries
          SET state = 'cancelled', error = ?, updated_at = ?
        WHERE ${conditions.join(' AND ')}`,
    )
    .bind(reason, at, ...params);
}

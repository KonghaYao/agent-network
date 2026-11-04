/** 历史页共用的投递状态聚合；消息与 timeline 使用同一投影。 */

export interface DeliveryStateRow {
  message_id?: string;
  state: string;
  n: number;
  max_claimed_at: number | null;
  max_updated_at: number | null;
}

export interface DeliveryStateSummary {
  states: Record<string, number>;
  claimedAt: number | null;
  updatedAt: number | null;
}

export function nullableString(value: number | null): string | null {
  return value === null ? null : String(value);
}

/**
 * 聚合 delivery 状态与 claimed 时间。
 *
 * 网页用 claimed_at/updated_at 判断“处理中未更新”，不新增 DB 字段；
 * 取所有 claimed 投递中的最早领取与最近更新，兼容多条 Agent 投递。
 */
export function summarizeDeliveryStates(rows: DeliveryStateRow[]): DeliveryStateSummary {
  const states: Record<string, number> = {};
  let claimedAt: number | null = null;
  let updatedAt: number | null = null;
  for (const row of rows) {
    states[row.state] = row.n;
    if (row.state !== 'claimed') continue;
    if (row.max_claimed_at !== null) {
      claimedAt = claimedAt === null ? row.max_claimed_at : Math.min(claimedAt, row.max_claimed_at);
    }
    if (row.max_updated_at !== null) {
      updatedAt = updatedAt === null ? row.max_updated_at : Math.max(updatedAt, row.max_updated_at);
    }
  }
  return { states, claimedAt, updatedAt };
}

export async function deliveryStatesFor(
  db: D1Database,
  messageIds: string[],
): Promise<Map<string, DeliveryStateSummary>> {
  if (messageIds.length === 0) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT message_id, state, COUNT(*) AS n,
              MAX(CASE WHEN state = 'claimed' THEN claimed_at END) AS max_claimed_at,
              MAX(CASE WHEN state = 'claimed' THEN updated_at END) AS max_updated_at
         FROM deliveries
        WHERE message_id IN (${placeholders}) GROUP BY message_id, state`,
    )
    .bind(...messageIds)
    .all<DeliveryStateRow & { message_id: string }>();
  const grouped = new Map<string, DeliveryStateRow[]>();
  for (const row of rows.results) {
    const list = grouped.get(row.message_id) ?? [];
    list.push(row);
    grouped.set(row.message_id, list);
  }
  const map = new Map<string, DeliveryStateSummary>();
  for (const [messageId, list] of grouped) map.set(messageId, summarizeDeliveryStates(list));
  return map;
}

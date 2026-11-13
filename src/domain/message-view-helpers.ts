/** 历史页共用的投递状态聚合；消息与 timeline 使用同一投影。 */

import {
  listDeliveryStates,
  listMessageMentions,
  type DeliveryStateRow,
} from '../storage/queries';

export type { DeliveryStateRow };

export interface DeliveryStateSummary {
  states: Record<string, number>;
  claimedAt: number | null;
  updatedAt: number | null;
}

export type MentionSource = 'explicit' | 'text' | 'all';

/** 消息提及的稳定投影；source 表示目标来自显式选择、正文还是 @所有人。 */
export interface MentionView {
  actor_id: string;
  kind: 'human' | 'agent';
  source: MentionSource;
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
  const rows = await listDeliveryStates(db, messageIds);
  const grouped = new Map<string, DeliveryStateRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.message_id) ?? [];
    list.push(row);
    grouped.set(row.message_id, list);
  }
  const map = new Map<string, DeliveryStateSummary>();
  for (const [messageId, list] of grouped) map.set(messageId, summarizeDeliveryStates(list));
  return map;
}

/** 批量读取消息提及；历史页、timeline 与发送结果共用同一投影。 */
export async function mentionsFor(
  db: D1Database,
  messageIds: string[],
): Promise<Map<string, MentionView[]>> {
  const rows = await listMessageMentions(db, messageIds);
  const map = new Map<string, MentionView[]>();
  for (const row of rows) {
    const list = map.get(row.message_id) ?? [];
    list.push({ actor_id: row.actor_id, kind: row.actor_kind, source: row.source });
    map.set(row.message_id, list);
  }
  return map;
}

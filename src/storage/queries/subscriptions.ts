import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';

import { orm, schema, toD1 } from '../drizzle';
import type { D1Like } from '../queries';
import type {
  EventSubscriptionRow,
} from '../rows';

/** 按订阅 ID 读取完整订阅；缺失返回 null。 */
export async function getEventSubscription(
  db: D1Like,
  subscriptionId: string,
): Promise<EventSubscriptionRow | null> {
  const query = orm(db)
    .select()
    .from(schema.mcpEventSubscriptions)
    .where(eq(schema.mcpEventSubscriptions.subscription_id, subscriptionId));
  return toD1(db, query).first<EventSubscriptionRow>();
}

/** 扫描器按稳定 ID 分页读取活跃订阅；调用方负责截断探针行。 */
export async function listEventSubscriptionsForScan(
  db: D1Like,
  now: number,
  afterId: string,
  limit: number,
): Promise<EventSubscriptionRow[]> {
  const query = orm(db)
    .select()
    .from(schema.mcpEventSubscriptions)
    .where(
      and(
        eq(schema.mcpEventSubscriptions.active, 1),
        gt(schema.mcpEventSubscriptions.refresh_before, now),
        gt(schema.mcpEventSubscriptions.subscription_id, afterId),
      ),
    )
    .orderBy(asc(schema.mcpEventSubscriptions.subscription_id))
    .limit(limit);
  const result = await toD1(db, query).all<EventSubscriptionRow>();
  return result.results;
}

/** 投递前复核订阅所需字段；字段顺序与 raw 查询保持一致。 */
export interface EventSubscriptionRefreshRow {
  active: number;
  refresh_before: number;
  credential_id: string;
  secret_ciphertext: string;
  secret_nonce: string;
  previous_secret_ciphertext: string | null;
  previous_secret_nonce: string | null;
  previous_secret_expires_at: number | null;
}

/** 投递前复核订阅状态、密钥轮换与凭据。 */
export async function getEventSubscriptionRefresh(
  db: D1Like,
  subscriptionId: string,
): Promise<EventSubscriptionRefreshRow | null> {
  const query = orm(db)
    .select({
      active: schema.mcpEventSubscriptions.active,
      refresh_before: schema.mcpEventSubscriptions.refresh_before,
      credential_id: schema.mcpEventSubscriptions.credential_id,
      secret_ciphertext: schema.mcpEventSubscriptions.secret_ciphertext,
      secret_nonce: schema.mcpEventSubscriptions.secret_nonce,
      previous_secret_ciphertext: schema.mcpEventSubscriptions.previous_secret_ciphertext,
      previous_secret_nonce: schema.mcpEventSubscriptions.previous_secret_nonce,
      previous_secret_expires_at: schema.mcpEventSubscriptions.previous_secret_expires_at,
    })
    .from(schema.mcpEventSubscriptions)
    .where(eq(schema.mcpEventSubscriptions.subscription_id, subscriptionId));
  return toD1(db, query).first<EventSubscriptionRefreshRow>();
}

/** 订阅队列中待处理/处理中的投递数。 */
export async function countPendingEventDeliveries(
  db: D1Like,
  subscriptionId: string,
): Promise<number> {
  const query = orm(db)
    .select({ n: sql<number>`count(*)`.as('n') })
    .from(schema.mcpEventDeliveries)
    .where(
      and(
        eq(schema.mcpEventDeliveries.subscription_id, subscriptionId),
        inArray(schema.mcpEventDeliveries.status, ['pending', 'processing']),
      ),
    );
  const row = await toD1(db, query).first<{ n: number }>();
  return row?.n ?? 0;
}

/** 订阅队首的待处理/处理中事件序号；没有积压返回 null。 */
export async function earliestPendingEventDeliverySeq(
  db: D1Like,
  subscriptionId: string,
): Promise<number | null> {
  const query = orm(db)
    .select({ seq: sql<number | null>`min(${schema.mcpEventDeliveries.event_seq})`.as('seq') })
    .from(schema.mcpEventDeliveries)
    .where(
      and(
        eq(schema.mcpEventDeliveries.subscription_id, subscriptionId),
        inArray(schema.mcpEventDeliveries.status, ['pending', 'processing']),
      ),
    );
  const row = await toD1(db, query).first<{ seq: number | null }>();
  return row?.seq ?? null;
}

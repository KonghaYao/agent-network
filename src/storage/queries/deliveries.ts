import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';

import { orm, schema, toD1 } from '../drizzle';
import type { D1Like } from '../queries';
import type {
  DeliveryRow,
} from '../rows';

/** 消息级投递状态聚合；调用方自己按 message_id 分组。 */
export interface DeliveryStateRow {
  message_id: string;
  state: string;
  n: number;
  max_claimed_at: number | null;
  max_updated_at: number | null;
}

export async function listDeliveryStates(
  db: D1Like,
  messageIds: string[],
): Promise<DeliveryStateRow[]> {
  if (messageIds.length === 0) return [];
  const statement = orm(db)
    .select({
      message_id: schema.deliveries.message_id,
      state: schema.deliveries.state,
      n: sql<number>`count(*)`.as('n'),
      max_claimed_at: sql<number | null>`max(case when ${schema.deliveries.state} = 'claimed' then ${schema.deliveries.claimed_at} end)`.as(
        'max_claimed_at',
      ),
      max_updated_at: sql<number | null>`max(case when ${schema.deliveries.state} = 'claimed' then ${schema.deliveries.updated_at} end)`.as(
        'max_updated_at',
      ),
    })
    .from(schema.deliveries)
    .where(inArray(schema.deliveries.message_id, messageIds))
    .groupBy(schema.deliveries.message_id, schema.deliveries.state);
  const result = await toD1(db, statement).all<DeliveryStateRow>();
  return result.results;
}

/** 收件箱投递列表行：`d.*` 加消息摘要与发送者展示身份。 */
export interface InboxDeliveryRow extends DeliveryRow {
  m_preview: string;
  m_body_bytes: number;
  m_sender_id: string;
  m_sender_name: string | null;
  m_sender_kind: 'human' | 'agent' | null;
  m_created_at: number;
}

export interface InboxDeliveryQuery {
  recipientId: string;
  /** null 表示不限状态；非空时按 `state IN (...)` 过滤。 */
  states: readonly DeliveryRow['state'][] | null;
  /** 上一页游标（不含）；null 表示首屏。 */
  afterSeq: number | null;
  limit: number;
}

export async function listInboxDeliveries(
  db: D1Like,
  query: InboxDeliveryQuery,
): Promise<InboxDeliveryRow[]> {
  const statement = orm(db)
    .select({
      delivery_id: schema.deliveries.delivery_id,
      recipient_id: schema.deliveries.recipient_id,
      message_id: schema.deliveries.message_id,
      room_id: schema.deliveries.room_id,
      state: schema.deliveries.state,
      attempt: schema.deliveries.attempt,
      claim_id: schema.deliveries.claim_id,
      claimed_at: schema.deliveries.claimed_at,
      progress_at: schema.deliveries.progress_at,
      result_message_id: schema.deliveries.result_message_id,
      error: schema.deliveries.error,
      created_seq: schema.deliveries.created_seq,
      created_at: schema.deliveries.created_at,
      updated_at: schema.deliveries.updated_at,
      last_reminded_at: schema.deliveries.last_reminded_at,
      m_preview: sql<string>`${schema.messages.preview}`.as('m_preview'),
      m_body_bytes: sql<number>`${schema.messages.body_bytes}`.as('m_body_bytes'),
      m_sender_id: sql<string>`${schema.messages.sender_id}`.as('m_sender_id'),
      m_created_at: sql<number>`${schema.messages.created_at}`.as('m_created_at'),
      m_sender_name: sql<string | null>`${schema.actors.name}`.as('m_sender_name'),
      m_sender_kind: sql<string | null>`${schema.actors.kind}`.as('m_sender_kind'),
    })
    .from(schema.deliveries)
    .innerJoin(schema.messages, eq(schema.messages.message_id, schema.deliveries.message_id))
    .leftJoin(schema.actors, eq(schema.actors.actor_id, schema.messages.sender_id))
    .where(
      and(
        eq(schema.deliveries.recipient_id, query.recipientId),
        query.states === null ? undefined : inArray(schema.deliveries.state, [...query.states]),
        query.afterSeq === null ? undefined : gt(schema.deliveries.created_seq, query.afterSeq),
      ),
    )
    .orderBy(asc(schema.deliveries.created_seq))
    .limit(query.limit);
  const result = await toD1(db, statement).all<InboxDeliveryRow>();
  return result.results;
}

export async function getDelivery(db: D1Like, deliveryId: string): Promise<DeliveryRow | null> {
  const query = orm(db)
    .select()
    .from(schema.deliveries)
    .where(eq(schema.deliveries.delivery_id, deliveryId));
  return toD1(db, query).first<DeliveryRow>();
}

export async function getDeliveryForMessage(
  db: D1Like,
  recipientId: string,
  messageId: string,
): Promise<DeliveryRow | null> {
  const query = orm(db)
    .select()
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.recipient_id, recipientId),
        eq(schema.deliveries.message_id, messageId),
      ),
    );
  return toD1(db, query).first<DeliveryRow>();
}

export async function getClaimedDelivery(
  db: D1Like,
  recipientId: string,
): Promise<DeliveryRow | null> {
  const query = orm(db)
    .select()
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.recipient_id, recipientId),
        eq(schema.deliveries.state, 'claimed'),
      ),
    )
    .limit(1);
  return toD1(db, query).first<DeliveryRow>();
}

/** 收件箱只需 claimed 的存在性与 ID；避免把整行投递读进响应路径。 */
export async function getClaimedDeliveryId(
  db: D1Like,
  recipientId: string,
): Promise<string | null> {
  const query = orm(db)
    .select({ delivery_id: schema.deliveries.delivery_id })
    .from(schema.deliveries)
    .where(
      and(
        eq(schema.deliveries.recipient_id, recipientId),
        eq(schema.deliveries.state, 'claimed'),
      ),
    )
    .limit(1);
  const row = await toD1(db, query).first<{ delivery_id: string }>();
  return row?.delivery_id ?? null;
}

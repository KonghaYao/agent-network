import { LIMITS } from '../contracts/limits';
import type { Env } from '../env';
import { nowMs, utf8Bytes } from '../storage/db';
import {
  buildMessageCreatedPayload,
  buildWebhookOccurrence,
  MESSAGE_CREATED_ARGUMENTS,
} from './definitions';
import { newEventDeliveryId } from './subscriptions';
import type { EventSubscriptionRow } from '../storage/rows';

interface ScanCandidateRow {
  event_seq: number;
  room_id: string;
  message_id: string;
  metadata: string;
  created_at: number;
  room_kind: 'direct' | 'group';
}

interface DeliveryMatchRow {
  message_id: string;
  delivery_id: string;
  state: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
}

interface SubscriptionHeadRow {
  head: number;
  floor: number;
}

interface CountRow {
  n: number;
}

async function suspendSubscription(
  env: Env,
  subscriptionId: string,
  reason: string,
  now: number,
): Promise<void> {
  await env.DB.batch([
    env.DB
      .prepare(
        'UPDATE mcp_event_subscriptions SET active = 0, last_error = ?, updated_at = ? WHERE subscription_id = ?',
      )
      .bind(reason, now, subscriptionId),
    env.DB
      .prepare(
        "DELETE FROM mcp_event_deliveries WHERE subscription_id = ? AND status IN ('pending', 'processing')",
      )
      .bind(subscriptionId),
  ]);
}

async function subscriptionHeadAndFloor(
  env: Env,
  actorIdValue: string,
  roomId: string | undefined,
): Promise<SubscriptionHeadRow> {
  if (roomId !== undefined) {
    const row = await env.DB
      .prepare(
        `SELECT r.head_seq AS head, r.events_min_seq AS floor
           FROM rooms r
           JOIN room_members m
             ON m.room_id = r.room_id AND m.actor_id = ? AND m.status = 'active'
          WHERE r.room_id = ?`,
      )
      .bind(actorIdValue, roomId)
      .first<SubscriptionHeadRow>();
    return row ?? { head: 0, floor: 0 };
  }
  const row = await env.DB
    .prepare(
      `SELECT COALESCE(MAX(r.head_seq), 0) AS head,
              COALESCE(MAX(r.events_min_seq), 0) AS floor
         FROM rooms r
         JOIN room_members m ON m.room_id = r.room_id
        WHERE m.actor_id = ? AND m.status = 'active'`,
    )
    .bind(actorIdValue)
    .first<SubscriptionHeadRow>();
  return row ?? { head: 0, floor: 0 };
}

async function isActiveMember(env: Env, actorIdValue: string, roomId: string): Promise<boolean> {
  const row = await env.DB
    .prepare(
      "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
    )
    .bind(roomId, actorIdValue)
    .first<{ ok: number }>();
  return row !== null;
}

async function pendingDeliveryCount(env: Env, subscriptionId: string): Promise<number> {
  const row = await env.DB
    .prepare(
      `SELECT COUNT(*) AS n FROM mcp_event_deliveries
        WHERE subscription_id = ? AND status IN ('pending', 'processing')`,
    )
    .bind(subscriptionId)
    .first<CountRow>();
  return row?.n ?? 0;
}

async function deliveryMatches(
  env: Env,
  actorIdValue: string,
  messageIds: string[],
): Promise<Map<string, DeliveryMatchRow>> {
  if (messageIds.length === 0) return new Map();
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = await env.DB
    .prepare(
      `SELECT message_id, delivery_id, state FROM deliveries
        WHERE recipient_id = ? AND message_id IN (${placeholders})`,
    )
    .bind(actorIdValue, ...messageIds)
    .all<DeliveryMatchRow>();
  return new Map(rows.results.map((row) => [row.message_id, row]));
}

async function scanSubscription(
  env: Env,
  subscription: EventSubscriptionRow,
  now: number,
): Promise<void> {
  let argumentsValue: { room_id?: string; attention?: 'action_required' | 'informational' };
  try {
    argumentsValue = MESSAGE_CREATED_ARGUMENTS.parse(
      JSON.parse(subscription.arguments_json) as unknown,
    );
  } catch {
    await suspendSubscription(env, subscription.subscription_id, 'invalid_arguments', now);
    return;
  }

  if (
    argumentsValue.room_id !== undefined &&
    !(await isActiveMember(env, subscription.actor_id, argumentsValue.room_id))
  ) {
    await suspendSubscription(env, subscription.subscription_id, 'membership_revoked', now);
    return;
  }

  await env.DB
    .prepare('UPDATE mcp_event_subscriptions SET last_scan_at = ? WHERE subscription_id = ?')
    .bind(now, subscription.subscription_id)
    .run();

  const { head, floor } = await subscriptionHeadAndFloor(
    env,
    subscription.actor_id,
    argumentsValue.room_id,
  );
  let scanned = subscription.scanned_seq;
  if (scanned < floor) scanned = floor;
  if (scanned >= head) {
    if (scanned !== subscription.scanned_seq) {
      await env.DB
        .prepare(
          'UPDATE mcp_event_subscriptions SET scanned_seq = ?, updated_at = ? WHERE subscription_id = ?',
        )
        .bind(scanned, now, subscription.subscription_id)
        .run();
    }
    return;
  }

  const rows = await env.DB
    .prepare(
      `SELECT e.event_seq, e.scope_id AS room_id, e.ref_id AS message_id,
              e.metadata, e.created_at, r.kind AS room_kind
         FROM events e
         JOIN rooms r ON r.room_id = e.scope_id
         JOIN room_members m
           ON m.room_id = e.scope_id AND m.actor_id = ? AND m.status = 'active'
          AND m.joined_seq <= e.event_seq
        WHERE e.scope_kind = 'room'
          AND e.event_type = 'message_created'
          AND e.event_seq > ?
          AND e.event_seq <= ?
          ${argumentsValue.room_id !== undefined ? 'AND e.scope_id = ?' : ''}
        ORDER BY e.event_seq ASC
        LIMIT ?`,
    )
    .bind(
      subscription.actor_id,
      scanned,
      head,
      ...(argumentsValue.room_id !== undefined ? [argumentsValue.room_id] : []),
      LIMITS.eventsScanBatchMax,
    )
    .all<ScanCandidateRow>();

  if (rows.results.length === 0) {
    await env.DB
      .prepare(
        'UPDATE mcp_event_subscriptions SET scanned_seq = ?, updated_at = ? WHERE subscription_id = ?',
      )
      .bind(head, now, subscription.subscription_id)
      .run();
    return;
  }

  const matches = await deliveryMatches(
    env,
    subscription.actor_id,
    rows.results.map((row) => row.message_id),
  );
  const queueCount = await pendingDeliveryCount(env, subscription.subscription_id);
  let available = Math.max(
    0,
    LIMITS.eventsPendingDeliveriesPerSubscription - queueCount,
  );

  const statements: D1PreparedStatement[] = [];
  let lastProcessed = scanned;
  for (const row of rows.results) {
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = {};
    }
    const senderId = typeof metadata.sender_id === 'string' ? metadata.sender_id : null;
    if (senderId === null) {
      console.warn('agent-network events scan skipped event without sender', {
        subscription_id: subscription.subscription_id,
        event_seq: row.event_seq,
      });
      lastProcessed = row.event_seq;
      continue;
    }
    if (senderId === subscription.actor_id) {
      lastProcessed = row.event_seq;
      continue;
    }

    const match = matches.get(row.message_id);
    const attention: 'action_required' | 'informational' =
      match?.state === 'pending' ? 'action_required' : 'informational';
    if (argumentsValue.attention !== undefined && argumentsValue.attention !== attention) {
      lastProcessed = row.event_seq;
      continue;
    }
    if (available <= 0) break;

    const payload = buildMessageCreatedPayload({
      eventSeq: row.event_seq,
      roomId: row.room_id,
      roomKind: row.room_kind,
      messageId: row.message_id,
      senderId,
      createdAt: row.created_at,
      ...(match ? { deliveryId: match.delivery_id, deliveryState: match.state } : {}),
      attention,
    });
    const occurrence = buildWebhookOccurrence(payload, row.created_at);
    const body = JSON.stringify(occurrence);
    if (utf8Bytes(body) > LIMITS.eventsWebhookMaxPayloadBytes) {
      console.warn('agent-network events scan skipped oversized payload', {
        subscription_id: subscription.subscription_id,
        event_seq: row.event_seq,
      });
      lastProcessed = row.event_seq;
      continue;
    }

    statements.push(
      env.DB
        .prepare(
          `INSERT INTO mcp_event_deliveries (
             delivery_id, subscription_id, event_seq, event_id, payload_json,
             status, attempts, next_attempt_at, created_at
           ) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)
           ON CONFLICT(subscription_id, event_seq) DO NOTHING`,
        )
        .bind(
          newEventDeliveryId(),
          subscription.subscription_id,
          row.event_seq,
          payload.event_id,
          body,
          now,
          now,
        ),
    );
    available -= 1;
    lastProcessed = row.event_seq;
  }

  if (lastProcessed > scanned || statements.length > 0) {
    statements.push(
      env.DB
        .prepare(
          'UPDATE mcp_event_subscriptions SET scanned_seq = ?, updated_at = ? WHERE subscription_id = ?',
        )
        .bind(lastProcessed, now, subscription.subscription_id),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
}

/** 扫描所有活跃订阅，把匹配事件写入投递 outbox。 */
export async function scanEventSubscriptions(env: Env): Promise<void> {
  if (!env.EVENTS) return;
  const now = nowMs();
  const subscriptions = await env.DB
    .prepare(
      `SELECT * FROM mcp_event_subscriptions
        WHERE active = 1 AND refresh_before > ?
        ORDER BY last_scan_at ASC, subscription_id ASC
        LIMIT ?`,
    )
    .bind(now, LIMITS.eventsScanSubscriptionsPerTick)
    .all<EventSubscriptionRow>();
  for (const subscription of subscriptions.results) {
    try {
      await scanSubscription(env, subscription, now);
    } catch (error) {
      console.error('agent-network events scan failed', {
        subscription_id: subscription.subscription_id,
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  }
}

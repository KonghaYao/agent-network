import { LIMITS } from '../contracts/limits';
import type { Env } from '../env';
import { addJitter, nowMs } from '../storage/db';
import {
  decryptSecret,
  parseWebhookSecret,
  signWebhook,
  webhookTimestamp,
} from './security';
import { postCallback, CallbackRequestError } from './client';
import { MESSAGE_CREATED_ARGUMENTS } from './definitions';
import {
  callbackHostOf,
  elapsedMs,
  logEventsInfo,
  logEventsWarn,
} from './log';

interface FreshSubscriptionRow {
  active: number;
  refresh_before: number;
  credential_id: string;
  secret_ciphertext: string;
  secret_nonce: string;
  previous_secret_ciphertext: string | null;
  previous_secret_nonce: string | null;
  previous_secret_expires_at: number | null;
}

interface DueDeliveryRow {
  delivery_id: string;
  subscription_id: string;
  event_seq: number;
  event_id: string;
  payload_json: string;
  attempts: number;
  created_at: number;
  actor_id: string;
  event_name: string;
  arguments_json: string;
  callback_url: string;
  credential_id: string;
  refresh_before: number;
  active: number;
  secret_ciphertext: string;
  secret_nonce: string;
  previous_secret_ciphertext: string | null;
  previous_secret_nonce: string | null;
  previous_secret_expires_at: number | null;
}

export interface DeliveryRunResult {
  claimed: number;
  delivered: number;
  retried: number;
  abandoned: number;
}

type DeliveryOutcome =
  | { kind: 'delivered'; status: number }
  | { kind: 'retry'; status?: number; error: string }
  | { kind: 'abandoned'; status?: number; error: string; countFailure: boolean };

function retryDelay(attempt: number): number {
  const base = Math.min(
    LIMITS.eventsWebhookRetryMaxMs,
    LIMITS.eventsWebhookRetryBaseMs * 2 ** Math.max(0, attempt - 1),
  );
  return addJitter(base, 0.2);
}

async function suspendSubscription(
  env: Env,
  subscriptionId: string,
  reason: string,
  now: number,
): Promise<void> {
  logEventsWarn('delivery.suspend', {
    subscription_id: subscriptionId,
    reason,
  });
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

async function credentialUsable(env: Env, credentialId: string): Promise<boolean> {
  const row = await env.DB
    .prepare('SELECT revoked_at FROM credentials WHERE credential_id = ?')
    .bind(credentialId)
    .first<{ revoked_at: number | null }>();
  return row !== null && row.revoked_at === null;
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

function classifyStatus(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) return { kind: 'delivered', status };
  if (status === 410 || status === 413) {
    return { kind: 'abandoned', status, error: 'http_4xx', countFailure: false };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { kind: 'retry', status, error: status >= 500 ? 'http_5xx' : `http_${status}` };
  }
  if (status >= 300 && status < 400) {
    return { kind: 'abandoned', status, error: 'redirect', countFailure: true };
  }
  if (status >= 400 && status < 500) {
    return { kind: 'abandoned', status, error: 'http_4xx', countFailure: true };
  }
  return { kind: 'abandoned', status, error: 'unexpected_status', countFailure: true };
}

async function deliverOne(
  env: Env,
  row: DueDeliveryRow,
  leaseToken: string,
  now: number,
): Promise<'delivered' | 'retried' | 'abandoned' | 'skipped'> {
  const events = env.EVENTS!;
  const startedAt = Date.now();

  // 领取后重新读取订阅，尽量缩小刷新轮换/撤销与在途投递的竞态。
  const fresh = await env.DB
    .prepare(
      `SELECT active, refresh_before, credential_id, secret_ciphertext, secret_nonce,
              previous_secret_ciphertext, previous_secret_nonce, previous_secret_expires_at
         FROM mcp_event_subscriptions WHERE subscription_id = ?`,
    )
    .bind(row.subscription_id)
    .first<FreshSubscriptionRow>();
  if (!fresh) {
    logEventsWarn('delivery.skip', {
      subscription_id: row.subscription_id,
      event_id: row.event_id,
      reason: 'subscription_missing',
    });
    return 'skipped';
  }

  if (fresh.active !== 1 || fresh.refresh_before <= now) {
    await suspendSubscription(env, row.subscription_id, 'subscription_expired', now);
    return 'skipped';
  }
  if (!(await credentialUsable(env, fresh.credential_id))) {
    await suspendSubscription(env, row.subscription_id, 'credential_revoked', now);
    return 'skipped';
  }
  let roomId: string | undefined;
  try {
    roomId = MESSAGE_CREATED_ARGUMENTS.parse(JSON.parse(row.arguments_json) as unknown).room_id;
  } catch {
    await suspendSubscription(env, row.subscription_id, 'invalid_arguments', now);
    return 'skipped';
  }
  if (roomId !== undefined && !(await isActiveMember(env, row.actor_id, roomId))) {
    await suspendSubscription(env, row.subscription_id, 'membership_revoked', now);
    return 'skipped';
  }

  const secrets: Uint8Array[] = [];
  try {
    secrets.push(parseWebhookSecret(await decryptSecret(
      events.encryptionKey,
      fresh.secret_ciphertext,
      fresh.secret_nonce,
    )));
    if (
      fresh.previous_secret_ciphertext !== null &&
      fresh.previous_secret_nonce !== null &&
      fresh.previous_secret_expires_at !== null &&
      fresh.previous_secret_expires_at > now
    ) {
      secrets.push(parseWebhookSecret(await decryptSecret(
        events.encryptionKey,
        fresh.previous_secret_ciphertext,
        fresh.previous_secret_nonce,
      )));
    }
  } catch {
    logEventsWarn('delivery.skip', {
      subscription_id: row.subscription_id,
      event_id: row.event_id,
      reason: 'secret_unavailable',
    });
    await suspendSubscription(env, row.subscription_id, 'secret_unavailable', now);
    return 'skipped';
  }

  const timestamp = webhookTimestamp(now);
  const signature = secrets
    .map((secret) => signWebhook(secret, row.event_id, timestamp, row.payload_json))
    .join(' ');
  logEventsInfo('delivery.attempt', {
    subscription_id: row.subscription_id,
    event_id: row.event_id,
    event_seq: row.event_seq,
    attempt: row.attempts + 1,
    callback_host: callbackHostOf(row.callback_url),
    // webhook 投递只依赖 active 订阅、凭据与房间成员资格，不依赖 SSE/login/presence。
    presence_required: false,
    secret_count: secrets.length,
  });
  let outcome: DeliveryOutcome;
  try {
    const response = await postCallback({
      url: new URL(row.callback_url),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'WeBots-MCP-Events/1.0',
        'webhook-id': row.event_id,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
        'x-mcp-subscription-id': row.subscription_id,
      },
      body: row.payload_json,
      timeoutMs: events.deliveryTimeoutMs,
      maxResponseBytes: LIMITS.eventsWebhookResponseBytes,
      rules: events,
      tlsCa: events.tlsCa,
    });
    outcome = classifyStatus(response.status);
  } catch (error) {
    if (error instanceof CallbackRequestError) {
      if (error.reason === 'blocked_address') {
        outcome = { kind: 'abandoned', error: 'blocked_address', countFailure: true };
      } else {
        outcome = { kind: 'retry', error: error.reason };
      }
    } else {
      outcome = { kind: 'retry', error: 'network_error' };
    }
  }

  let status: 'delivered' | 'abandoned' | 'pending' = 'pending';
  let nextAttemptAt = now;
  let attempts = row.attempts;
  let lastError: string | null = outcome.kind === 'delivered' ? null : outcome.error;
  let deliveredAt: number | null = null;

  if (outcome.kind === 'delivered') {
    status = 'delivered';
    deliveredAt = now;
  } else if (outcome.kind === 'abandoned') {
    status = 'abandoned';
  } else {
    attempts = row.attempts + 1;
    const tooMany = attempts >= LIMITS.eventsWebhookMaxAttempts;
    const tooOld = now - row.created_at > LIMITS.eventsWebhookMaxAgeMs;
    if (tooMany || tooOld) {
      status = 'abandoned';
    } else {
      status = 'pending';
      nextAttemptAt = now + retryDelay(attempts);
    }
  }

  const deliveryUpdate = await env.DB
    .prepare(
      `UPDATE mcp_event_deliveries
          SET status = ?, attempts = ?, next_attempt_at = ?, lease_token = NULL,
              lease_until = NULL, last_http_status = ?, last_error = ?, delivered_at = ?
        WHERE delivery_id = ? AND status = 'processing' AND lease_token = ?`,
    )
    .bind(
      status,
      attempts,
      nextAttemptAt,
      outcome.status ?? null,
      lastError,
      deliveredAt,
      row.delivery_id,
      leaseToken,
    )
    .run();
  if ((deliveryUpdate.meta.changes ?? 0) === 0) return 'skipped';

  if (status === 'delivered') {
    await env.DB
      .prepare(
        `UPDATE mcp_event_subscriptions
            SET last_delivery_at = ?, last_error = NULL, consecutive_failures = 0, updated_at = ?
          WHERE subscription_id = ?`,
      )
      .bind(now, now, row.subscription_id)
      .run();
    logEventsInfo('delivery.result', {
      subscription_id: row.subscription_id,
      event_id: row.event_id,
      status: 'delivered',
      http_status: outcome.status ?? null,
      attempt: attempts,
      duration_ms: elapsedMs(startedAt),
      presence_required: false,
    });
    return 'delivered';
  }

  const countFailure =
    outcome.kind === 'retry' || (outcome.kind === 'abandoned' && outcome.countFailure);
  if (countFailure) {
    await env.DB
      .prepare(
        `UPDATE mcp_event_subscriptions
            SET consecutive_failures = consecutive_failures + 1,
                last_error = ?,
                updated_at = ?,
                active = CASE
                  WHEN consecutive_failures + 1 >= ? THEN 0
                  ELSE active
                END
          WHERE subscription_id = ?`,
      )
      .bind(lastError ?? 'delivery_failed', now, LIMITS.eventsFailureSuspensionThreshold, row.subscription_id)
      .run();
  }
  if (status === 'abandoned') {
    logEventsWarn('delivery.result', {
      subscription_id: row.subscription_id,
      event_id: row.event_id,
      status: 'abandoned',
      http_status: outcome.status ?? null,
      category: lastError,
      attempt: attempts,
      duration_ms: elapsedMs(startedAt),
      presence_required: false,
    });
    return 'abandoned';
  }
  logEventsWarn('delivery.result', {
    subscription_id: row.subscription_id,
    event_id: row.event_id,
    status: 'retry',
    http_status: outcome.status ?? null,
    category: lastError,
    attempt: attempts,
    duration_ms: elapsedMs(startedAt),
    presence_required: false,
  });
  return 'retried';
}

async function runLimited<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += limit) {
    await Promise.all(items.slice(index, index + limit).map((item) => worker(item)));
  }
}

/** 领取并投递到期的 webhook；同一订阅始终最多一条在途。 */
export async function drainEventDeliveries(env: Env): Promise<DeliveryRunResult> {
  const result: DeliveryRunResult = { claimed: 0, delivered: 0, retried: 0, abandoned: 0 };
  if (!env.EVENTS) return result;
  const now = nowMs();
  const leaseToken = crypto.randomUUID();
  const leaseUntil = now + LIMITS.eventsWebhookTimeoutMs + 60_000;

  await env.DB
    .prepare(
      "UPDATE mcp_event_deliveries SET status = 'pending', lease_token = NULL, lease_until = NULL WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until < ?",
    )
    .bind(now)
    .run();

  const due = await env.DB
    .prepare(
      `SELECT d.delivery_id, d.subscription_id, d.event_seq, d.event_id, d.payload_json,
              d.attempts, d.created_at,
              s.actor_id, s.event_name, s.arguments_json, s.callback_url, s.credential_id,
              s.refresh_before, s.active, s.secret_ciphertext, s.secret_nonce,
              s.previous_secret_ciphertext, s.previous_secret_nonce,
              s.previous_secret_expires_at
         FROM mcp_event_deliveries d
         JOIN mcp_event_subscriptions s ON s.subscription_id = d.subscription_id
        WHERE d.status = 'pending' AND d.next_attempt_at <= ?
          AND s.active = 1 AND s.refresh_before > ?
          AND NOT EXISTS (
            SELECT 1 FROM mcp_event_deliveries d2
             WHERE d2.subscription_id = d.subscription_id
               AND d2.event_seq < d.event_seq
               AND d2.status IN ('pending', 'processing')
          )
        ORDER BY d.next_attempt_at ASC, d.event_seq ASC
        LIMIT ?`,
    )
    .bind(now, now, LIMITS.eventsDeliveryBatchMax)
    .all<DueDeliveryRow>();

  const claimed: DueDeliveryRow[] = [];
  for (const row of due.results) {
    const update = await env.DB
      .prepare(
        "UPDATE mcp_event_deliveries SET status = 'processing', lease_token = ?, lease_until = ? WHERE delivery_id = ? AND status = 'pending'",
      )
      .bind(leaseToken, leaseUntil, row.delivery_id)
      .run();
    if ((update.meta.changes ?? 0) > 0) claimed.push(row);
  }
  result.claimed = claimed.length;

  await runLimited(claimed, LIMITS.eventsWebhookConcurrency, async (row) => {
    const outcome = await deliverOne(env, row, leaseToken, nowMs());
    if (outcome === 'delivered') result.delivered += 1;
    else if (outcome === 'retried') result.retried += 1;
    else if (outcome === 'abandoned') result.abandoned += 1;
  });
  return result;
}

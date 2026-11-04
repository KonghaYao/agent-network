import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import {
  EVENTS_ERROR_CODES,
  MESSAGE_CREATED_EVENT_NAME,
} from '../contracts/events';
import type { Env } from '../env';
import { getMember, getRoom } from '../storage/queries';
import { newId, nowMs, randomToken } from '../storage/db';
import {
  guardSql,
} from '../storage/guards';
import { mapBatchError } from '../storage/transactions/runner';
import type { Principal } from '../domain/principal';
import type { EventSubscriptionRow } from '../storage/rows';
import {
  canonicalArguments,
  EVENT_DEFINITIONS,
  subscriptionIdFor,
} from './definitions';
import {
  callbackFailure,
  EventsError,
  invalidEventsArgument,
} from './errors';
import { postCallback, CallbackRequestError } from './client';
import {
  CallbackTargetError,
  CallbackUrlError,
  constantTimeEqual,
  decryptSecret,
  encryptSecret,
  normalizeCallbackUrl,
  parseWebhookSecret,
  resolveCallbackTarget,
  signWebhook,
  webhookTimestamp,
} from './security';

export interface SubscribeInput {
  name: string;
  arguments?: unknown;
  delivery: { mode: string; url: string; secret: string };
  cursor?: string | null;
  ttlMs?: number | null;
}

export interface UnsubscribeInput {
  name: string;
  arguments?: unknown;
  delivery: { mode?: string; url: string; secret?: string };
}

export interface SubscribeResult {
  [key: string]: unknown;
  id: string;
  refreshBefore: string;
  cursor: string;
  truncated: boolean;
}

const verificationAttempts = new Map<string, number[]>();

function requireIdentity(principal: Principal): {
  actorId: string;
  credentialId: string;
} {
  if (!principal.actor || !principal.credential) {
    throw new BusinessError('CREDENTIAL_INVALID', '当前凭据尚未注册；先调用 network_register');
  }
  return {
    actorId: principal.actor.actor_id,
    credentialId: principal.credential.credential_id,
  };
}

function assertEventName(name: string): void {
  if (name !== MESSAGE_CREATED_EVENT_NAME) {
    throw new EventsError('unknown_event', 'unknown event name', {
      kind: 'event',
      code: EVENTS_ERROR_CODES.unknownEvent,
    });
  }
}

async function assertRoomMembership(env: Env, actorIdValue: string, roomId: string): Promise<void> {
  const room = await getRoom(env.DB, roomId);
  if (!room) {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  const member = await getMember(env.DB, roomId, actorIdValue);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
}

function parseCursor(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invalidEventsArgument('cursor 必须是十进制 event_seq 字符串');
  }
  return parsed;
}

function clampTtl(value: number | null | undefined, now: number): number {
  if (value === undefined) return now + LIMITS.eventsSubscriptionTtlMs;
  // 服务只授予有限寿命；ttlMs: null 按最大授权处理。
  if (value === null) return now + LIMITS.eventsSubscriptionTtlMaxMs;
  if (!Number.isInteger(value) || value < 0) {
    throw invalidEventsArgument('ttlMs 必须是非负整数或 null');
  }
  return now + Math.min(Math.max(value, LIMITS.eventsSubscriptionTtlMinMs), LIMITS.eventsSubscriptionTtlMaxMs);
}

interface HeadAndFloor {
  head: number;
  floor: number;
}

async function headAndFloor(env: Env, actorIdValue: string, roomId?: string): Promise<HeadAndFloor> {
  if (roomId !== undefined) {
    const room = await getRoom(env.DB, roomId);
    return { head: room?.head_seq ?? 0, floor: room?.events_min_seq ?? 0 };
  }
  const row = await env.DB.prepare(
    `SELECT COALESCE(MAX(r.head_seq), 0) AS head,
            COALESCE(MAX(r.events_min_seq), 0) AS floor
       FROM rooms r
       JOIN room_members m ON m.room_id = r.room_id
      WHERE m.actor_id = ? AND m.status = 'active'`,
  )
    .bind(actorIdValue)
    .first<HeadAndFloor>();
  return { head: row?.head ?? 0, floor: row?.floor ?? 0 };
}

async function verificationCached(
  env: Env,
  actorIdValue: string,
  callbackUrlKey: string,
  now: number,
): Promise<boolean> {
  const cached = await env.DB
    .prepare(
      `SELECT 1 AS ok FROM webhook_verifications
        WHERE actor_id = ? AND callback_url_key = ? AND expires_at > ?`,
    )
    .bind(actorIdValue, callbackUrlKey, now)
    .first<{ ok: number }>();
  if (cached) return true;

  const existing = await env.DB
    .prepare(
      `SELECT 1 AS ok FROM mcp_event_subscriptions
        WHERE actor_id = ? AND callback_url_key = ?
          AND verified_at > 0 AND refresh_before > ?`,
    )
    .bind(actorIdValue, callbackUrlKey, now)
    .first<{ ok: number }>();
  return existing !== null;
}

function beginVerification(hostname: string, now: number, perMinute: number): void {
  const attempts = verificationAttempts.get(hostname) ?? [];
  const cutoff = now - 60_000;
  const recent = attempts.filter((at) => at > cutoff);
  if (recent.length >= perMinute) {
    verificationAttempts.set(hostname, recent);
    throw new EventsError('limit', 'callback verification rate limit exceeded', {
      limit: 'verification',
      max: perMinute,
    });
  }
  recent.push(now);
  verificationAttempts.set(hostname, recent);
}

async function verifyCallback(
  env: Env,
  callbackUrl: URL,
  subscriptionId: string,
  secretBytes: Uint8Array,
): Promise<void> {
  const events = env.EVENTS!;
  const now = nowMs();
  beginVerification(callbackUrl.hostname, now, events.verificationPerHostPerMinute);

  // 先解析一次，保证私网地址以 -32602 策略拒绝，而不是伪装成连接失败。
  try {
    await resolveCallbackTarget(callbackUrl, events);
  } catch (error) {
    if (error instanceof CallbackTargetError) {
      if (error.reason === 'blocked_address') {
        throw invalidEventsArgument('callback URL 解析到非公网地址', {
          code: 'INVALID_CALLBACK_URL',
          reason: 'private_address',
        });
      }
      throw callbackFailure('connection_refused');
    }
    throw error;
  }

  const challenge = randomToken(32);
  const body = JSON.stringify({ type: 'verification', challenge });
  const webhookId = `msg_${crypto.randomUUID()}`;
  const timestamp = webhookTimestamp(now);
  const signature = signWebhook(secretBytes, webhookId, timestamp, body);

  let response;
  try {
    response = await postCallback({
      url: callbackUrl,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'WeBots-MCP-Events/1.0',
        'webhook-id': webhookId,
        'webhook-timestamp': timestamp,
        'webhook-signature': signature,
        'x-mcp-subscription-id': subscriptionId,
      },
      body,
      timeoutMs: events.verificationTimeoutMs,
      maxResponseBytes: LIMITS.eventsWebhookResponseBytes,
      rules: events,
      tlsCa: events.tlsCa,
    });
  } catch (error) {
    if (error instanceof CallbackRequestError) {
      if (error.reason === 'blocked_address') {
        throw invalidEventsArgument('callback URL 解析到非公网地址', {
          code: 'INVALID_CALLBACK_URL',
          reason: 'private_address',
        });
      }
      if (error.reason === 'tls_error') throw callbackFailure('tls_error');
      if (error.reason === 'timeout') throw callbackFailure('timeout');
      throw callbackFailure('connection_refused');
    }
    throw error;
  }

  if (response.status < 200 || response.status >= 300) {
    throw callbackFailure(response.status >= 500 ? 'http_5xx' : 'http_4xx');
  }
  let echoed: unknown;
  try {
    echoed = (JSON.parse(response.body) as { challenge?: unknown }).challenge;
  } catch {
    throw callbackFailure('challenge_failed');
  }
  if (typeof echoed !== 'string' || !constantTimeEqual(echoed, challenge)) {
    throw callbackFailure('challenge_failed');
  }
}

async function safeCursor(env: Env, subscriptionId: string, scanned: number): Promise<string> {
  const pending = await env.DB
    .prepare(
      `SELECT MIN(event_seq) AS seq FROM mcp_event_deliveries
        WHERE subscription_id = ? AND status IN ('pending', 'processing')`,
    )
    .bind(subscriptionId)
    .first<{ seq: number | null }>();
  if (pending?.seq !== null && pending?.seq !== undefined) {
    return String(Math.max(0, pending.seq - 1));
  }
  return String(Math.max(0, scanned));
}

export async function listEventDefinitions(): Promise<{ events: unknown[] }> {
  return { events: EVENT_DEFINITIONS.map((definition) => definition) };
}

export async function subscribeEvents(
  env: Env,
  principal: Principal,
  input: SubscribeInput,
): Promise<SubscribeResult> {
  const events = env.EVENTS;
  if (!events) throw new BusinessError('INVALID_ARGUMENT', 'MCP Events 未启用');
  const identity = requireIdentity(principal);
  assertEventName(input.name);
  if (input.delivery.mode !== 'webhook') {
    throw new EventsError('delivery_mode', 'unsupported delivery mode', {
      feature: 'deliveryMode',
      value: input.delivery.mode,
      code: EVENTS_ERROR_CODES.unsupportedDelivery,
    });
  }

  const argumentsValue = canonicalArguments(input.arguments);
  if (argumentsValue.values.room_id !== undefined) {
    await assertRoomMembership(env, identity.actorId, argumentsValue.values.room_id);
  }

  let callbackUrl: URL;
  try {
    callbackUrl = normalizeCallbackUrl(input.delivery.url, events);
  } catch (error) {
    if (error instanceof CallbackUrlError) {
      throw invalidEventsArgument('callback URL 不合法', {
        code: 'INVALID_CALLBACK_URL',
        reason: error.reason,
      });
    }
    throw error;
  }

  let secretBytes: Uint8Array;
  try {
    secretBytes = parseWebhookSecret(input.delivery.secret);
  } catch {
    throw invalidEventsArgument('delivery.secret 必须是 whsec_ + base64（解码后 24–64 字节）', {
      code: 'INVALID_ARGUMENT',
      field: 'delivery.secret',
    });
  }

  const requestedCursor = parseCursor(input.cursor);
  const now = nowMs();
  const refreshBefore = clampTtl(input.ttlMs, now);
  const callbackUrlKey = callbackUrl.href;
  const subscriptionId = await subscriptionIdFor(
    identity.actorId,
    callbackUrlKey,
    input.name,
    argumentsValue.json,
  );

  const existing = await env.DB
    .prepare('SELECT * FROM mcp_event_subscriptions WHERE subscription_id = ?')
    .bind(subscriptionId)
    .first<EventSubscriptionRow>();

  const { head, floor } = await headAndFloor(
    env,
    identity.actorId,
    argumentsValue.values.room_id,
  );

  let scannedSeq: number;
  let truncated = false;
  let resetDeliveries = false;
  const activeRefresh = existing !== null && existing.active === 1 && existing.refresh_before > now;
  const pausedRefresh = existing !== null && existing.active === 0 && existing.refresh_before > now;

  if (activeRefresh || pausedRefresh) {
    scannedSeq = existing.scanned_seq;
    if (scannedSeq < floor) {
      scannedSeq = floor;
      truncated = true;
    }
  } else if (existing !== null) {
    resetDeliveries = true;
    const base = requestedCursor ?? head;
    scannedSeq = Math.max(base, floor);
    truncated = base < floor;
  } else {
    const base = requestedCursor ?? head;
    scannedSeq = Math.max(base, floor);
    truncated = base < floor;
  }

  const encrypted = await encryptSecret(events.encryptionKey, input.delivery.secret);
  let previousCiphertext: string | null = null;
  let previousNonce: string | null = null;
  let previousExpiresAt: number | null = null;
  if (existing) {
    let oldSecret: string | null = null;
    try {
      oldSecret = await decryptSecret(
        events.encryptionKey,
        existing.secret_ciphertext,
        existing.secret_nonce,
      );
    } catch {
      // 密钥轮换后旧密文不可读：按新 secret 重新开始，不保留双签。
      oldSecret = null;
    }
    if (oldSecret !== null && oldSecret !== input.delivery.secret) {
      previousCiphertext = existing.secret_ciphertext;
      previousNonce = existing.secret_nonce;
      previousExpiresAt = now + LIMITS.eventsSecretRotationGraceMs;
    } else if (oldSecret !== null) {
      previousCiphertext = existing.previous_secret_ciphertext;
      previousNonce = existing.previous_secret_nonce;
      previousExpiresAt =
        existing.previous_secret_expires_at !== null &&
        existing.previous_secret_expires_at > now
          ? existing.previous_secret_expires_at
          : null;
      if (previousExpiresAt === null) {
        previousCiphertext = null;
        previousNonce = null;
      }
    }
  }

  const verified = await verificationCached(env, identity.actorId, callbackUrlKey, now);
  if (!verified) {
    await verifyCallback(env, callbackUrl, subscriptionId, secretBytes);
  }

  const statements = [
    env.DB
      .prepare(
        guardSql(
          'eventSubscriptionLimit',
          'SELECT COUNT(*) FROM mcp_event_subscriptions WHERE actor_id = ? AND active = 1 AND subscription_id != ?',
        ) + ' >= ?',
      )
      .bind(identity.actorId, subscriptionId, LIMITS.eventsSubscriptionsPerActor),
    env.DB
      .prepare(
        guardSql(
          'eventSubscriptionGlobal',
          'SELECT COUNT(*) FROM mcp_event_subscriptions WHERE active = 1 AND subscription_id != ?',
        ) + ' >= ?',
      )
      .bind(subscriptionId, LIMITS.eventsSubscriptionsGlobal),
    ...(resetDeliveries
      ? [
          env.DB
            .prepare('DELETE FROM mcp_event_deliveries WHERE subscription_id = ?')
            .bind(subscriptionId),
        ]
      : []),
    env.DB
      .prepare(
        `INSERT INTO mcp_event_subscriptions (
           subscription_id, actor_id, event_name, arguments_json, callback_url,
           callback_url_key, credential_id, secret_ciphertext, secret_nonce,
           previous_secret_ciphertext, previous_secret_nonce,
           previous_secret_expires_at, refresh_before, scanned_seq, last_scan_at,
           last_delivery_at, last_error, consecutive_failures, active, verified_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 1, ?, ?, ?)
         ON CONFLICT(subscription_id) DO UPDATE SET
           actor_id = excluded.actor_id,
           event_name = excluded.event_name,
           arguments_json = excluded.arguments_json,
           callback_url = excluded.callback_url,
           callback_url_key = excluded.callback_url_key,
           credential_id = excluded.credential_id,
           secret_ciphertext = excluded.secret_ciphertext,
           secret_nonce = excluded.secret_nonce,
           previous_secret_ciphertext = excluded.previous_secret_ciphertext,
           previous_secret_nonce = excluded.previous_secret_nonce,
           previous_secret_expires_at = excluded.previous_secret_expires_at,
           refresh_before = excluded.refresh_before,
           scanned_seq = excluded.scanned_seq,
           last_scan_at = excluded.last_scan_at,
           last_delivery_at = excluded.last_delivery_at,
           last_error = NULL,
           consecutive_failures = 0,
           active = 1,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
      )
      .bind(
        subscriptionId,
        identity.actorId,
        input.name,
        argumentsValue.json,
        callbackUrlKey,
        callbackUrlKey,
        identity.credentialId,
        encrypted.ciphertext,
        encrypted.nonce,
        previousCiphertext,
        previousNonce,
        previousExpiresAt,
        refreshBefore,
        scannedSeq,
        existing?.last_scan_at ?? 0,
        existing?.last_delivery_at ?? null,
        now,
        existing?.created_at ?? now,
        now,
      ),
    env.DB
      .prepare(
        `INSERT INTO webhook_verifications (actor_id, callback_url_key, verified_at, expires_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(actor_id, callback_url_key) DO UPDATE SET
           verified_at = excluded.verified_at,
           expires_at = excluded.expires_at`,
      )
      .bind(identity.actorId, callbackUrlKey, now, now + LIMITS.eventsVerificationCacheMs),
  ];

  try {
    await env.DB.batch(statements);
  } catch (error) {
    const business = mapBatchError(error);
    if (business) throw business;
    throw error;
  }

  return {
    id: subscriptionId,
    refreshBefore: new Date(refreshBefore).toISOString(),
    cursor: await safeCursor(env, subscriptionId, scannedSeq),
    truncated,
  };
}

export async function unsubscribeEvents(
  env: Env,
  principal: Principal,
  input: UnsubscribeInput,
): Promise<Record<string, unknown>> {
  const identity = requireIdentity(principal);
  assertEventName(input.name);
  if (input.delivery.mode !== undefined && input.delivery.mode !== 'webhook') {
    throw new EventsError('delivery_mode', 'unsupported delivery mode', {
      feature: 'deliveryMode',
      value: input.delivery.mode,
      code: EVENTS_ERROR_CODES.unsupportedDelivery,
    });
  }
  const argumentsValue = canonicalArguments(input.arguments);
  let callbackUrl: URL;
  try {
    // 取消只要求与订阅时同一 URL；allowlist/私网策略可能已变化，不阻止取消。
    callbackUrl = normalizeCallbackUrl(input.delivery.url, {
      allowPrivateCallbacks: true,
      callbackAllowlist: null,
    });
  } catch (error) {
    if (error instanceof CallbackUrlError) {
      throw invalidEventsArgument('callback URL 不合法', {
        code: 'INVALID_CALLBACK_URL',
        reason: error.reason,
      });
    }
    throw error;
  }
  const subscriptionId = await subscriptionIdFor(
    identity.actorId,
    callbackUrl.href,
    input.name,
    argumentsValue.json,
  );
  await env.DB
    .prepare('DELETE FROM mcp_event_subscriptions WHERE subscription_id = ?')
    .bind(subscriptionId)
    .run();
  return {};
}

/** 供测试/维护使用的订阅读取。 */
export async function getEventSubscription(
  env: Env,
  subscriptionId: string,
): Promise<EventSubscriptionRow | null> {
  return env.DB
    .prepare('SELECT * FROM mcp_event_subscriptions WHERE subscription_id = ?')
    .bind(subscriptionId)
    .first<EventSubscriptionRow>();
}

export function newEventDeliveryId(): string {
  return newId('evd');
}

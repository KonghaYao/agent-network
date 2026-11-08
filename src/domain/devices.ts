import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type { DeviceRevokeInput } from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement, inboxHeadStatement, inboxTopic, outboxStatement } from '../storage/events';
import { guardSql } from '../storage/guards';
import type { CredentialRow } from '../storage/rows';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';

/** 设备列表、单设备撤销与认证活动时间。 */

export interface DeviceView {
  device_id: string;
  label: string;
  platform: string;
  status: 'active' | 'revoked';
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  current: boolean;
  active_credentials: number;
  total_credentials: number;
}

export interface DeviceListResult {
  items: DeviceView[];
  current_device_id: string | null;
}

export interface DeviceRevokeResult {
  device_id: string;
  revoked_credentials: number;
  already_revoked: boolean;
  revoked_at: string;
}

interface DeviceRowResult {
  device_id: string;
  label: string;
  platform: string;
  status: 'active' | 'revoked';
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
  active_credentials: number;
  total_credentials: number;
  credential_last_used_at: number | null;
}

export async function listDevices(
  db: D1Database,
  principal: Principal,
): Promise<DeviceListResult> {
  const caller = actorId(principal);
  const rows = await db
    .prepare(
      `SELECT d.device_id, d.label, d.platform, d.status, d.created_at, d.last_seen_at,
              d.revoked_at,
              COALESCE(SUM(CASE WHEN c.revoked_at IS NULL THEN 1 ELSE 0 END), 0) AS active_credentials,
              COUNT(c.credential_id) AS total_credentials,
              MAX(c.last_used_at) AS credential_last_used_at
         FROM devices d
         LEFT JOIN credentials c
           ON c.actor_id = d.actor_id AND c.device_id = d.device_id
        WHERE d.actor_id = ?
        GROUP BY d.actor_id, d.device_id
        ORDER BY d.status = 'active' DESC, COALESCE(d.last_seen_at, 0) DESC, d.device_id ASC
        LIMIT ?`,
    )
    .bind(caller, LIMITS.deviceListMax)
    .all<DeviceRowResult>();
  const currentDeviceId = principal.credential?.device_id ?? null;
  return {
    items: rows.results.map((row) => {
      const lastSeen = Math.max(row.last_seen_at ?? 0, row.credential_last_used_at ?? 0) || null;
      return {
        device_id: row.device_id,
        label: row.label,
        platform: row.platform,
        status: row.status,
        created_at: String(row.created_at),
        last_seen_at: lastSeen === null ? null : String(lastSeen),
        revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
        current: currentDeviceId === row.device_id,
        active_credentials: row.active_credentials,
        total_credentials: row.total_credentials,
      };
    }),
    current_device_id: currentDeviceId,
  };
}

export interface DeviceRevokeOutcome {
  result: DeviceRevokeResult;
  revokedCredentialIds: string[];
}

export async function revokeDevice(
  db: D1Database,
  principal: Principal,
  input: DeviceRevokeInput,
): Promise<DeviceRevokeOutcome> {
  const caller = actorId(principal);
  const now = nowMs();
  const device = await db
    .prepare('SELECT * FROM devices WHERE actor_id = ? AND device_id = ?')
    .bind(caller, input.device_id)
    .first<{ status: 'active' | 'revoked'; revoked_at: number | null }>();
  if (!device) {
    throw new BusinessError('NOT_FOUND', '设备不存在或不属于当前身份', {
      device_id: input.device_id,
    });
  }
  if (device.status === 'revoked') {
    return {
      result: {
        device_id: input.device_id,
        revoked_credentials: 0,
        already_revoked: true,
        revoked_at: String(device.revoked_at ?? now),
      },
      revokedCredentialIds: [],
    };
  }
  const credentials = await db
    .prepare(
      'SELECT credential_id FROM credentials WHERE actor_id = ? AND device_id = ? AND revoked_at IS NULL',
    )
    .bind(caller, input.device_id)
    .all<{ credential_id: string }>();
  const credentialIds = credentials.results.map((row) => row.credential_id);
  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `device_revoked:${caller}:${input.device_id}:${input.request_id}`;
  try {
    await runIdempotent(db, {
      actorId: caller,
      requestId: input.request_id,
      payloadHash,
      result: { device_id: input.device_id, revoked_credentials: credentialIds.length },
      build: (resultJson) => [
        operationsStatement(db, caller, input.request_id, payloadHash, resultJson, now),
        db
          .prepare(
            guardSql(
              'deviceStale',
              `NOT EXISTS (
                 SELECT 1 FROM devices WHERE actor_id = ? AND device_id = ? AND status = 'active'
               )`,
            ),
          )
          .bind(caller, input.device_id),
        db
          .prepare(
            `UPDATE devices
                SET status = 'revoked', revoked_at = ?, revoked_by = ?
              WHERE actor_id = ? AND device_id = ? AND status = 'active'`,
          )
          .bind(now, caller, caller, input.device_id),
        db
          .prepare(
            `UPDATE credentials
                SET revoked_at = ?, revoked_by = ?
              WHERE actor_id = ? AND device_id = ? AND revoked_at IS NULL`,
          )
          .bind(now, caller, caller, input.device_id),
        // 撤销设备同时关闭它创建的待确认挑战，避免丢失设备继续批准新设备。
        db
          .prepare(
            `UPDATE device_pairings
                SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?,
                    cancel_reason = 'creator_device_revoked', updated_at = ?
              WHERE actor_id = ? AND created_by_credential_id IN (
                SELECT credential_id FROM credentials
                 WHERE actor_id = ? AND device_id = ?
              ) AND status IN ('pending', 'approved')`,
          )
          .bind(now, caller, now, caller, caller, input.device_id),
        eventStatement(
          db,
          {
            eventKey,
            scopeKind: 'inbox',
            scopeId: caller,
            eventType: 'device_revoked',
            refId: input.device_id,
            metadata: { device_id: input.device_id, revoked_credentials: credentialIds.length },
          },
          now,
        ),
        outboxStatement(db, { topic: inboxTopic(caller), eventKey }, now),
        inboxHeadStatement(db, caller, eventKey, now, 0),
      ],
    });
  } catch (error) {
    if (error instanceof BusinessError && error.code === 'CONFLICT') {
      const current = await db
        .prepare('SELECT status, revoked_at FROM devices WHERE actor_id = ? AND device_id = ?')
        .bind(caller, input.device_id)
        .first<{ status: string; revoked_at: number | null }>();
      if (current?.status === 'revoked') {
        return {
          result: {
            device_id: input.device_id,
            revoked_credentials: 0,
            already_revoked: true,
            revoked_at: String(current.revoked_at ?? now),
          },
          revokedCredentialIds: [],
        };
      }
    }
    throw error;
  }
  return {
    result: {
      device_id: input.device_id,
      revoked_credentials: credentialIds.length,
      already_revoked: false,
      revoked_at: String(now),
    },
    revokedCredentialIds: credentialIds,
  };
}

/**
 * 认证路径的最近活动写入节流。
 *
 * 只更新摘要与设备时间，不写事件、不产生未读；失败不影响本次认证。
 */
export async function touchCredentialActivity(
  db: D1Database,
  credential: CredentialRow,
  at = nowMs(),
): Promise<void> {
  if (
    credential.last_used_at !== null &&
    at - credential.last_used_at < LIMITS.deviceActivityThrottleMs
  ) {
    return;
  }
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE credentials SET last_used_at = ?
            WHERE credential_id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
        )
        .bind(at, credential.credential_id, at - LIMITS.deviceActivityThrottleMs),
      db
        .prepare(
          `INSERT INTO devices (actor_id, device_id, label, platform, status, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(actor_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
           WHERE devices.status = 'active'`,
        )
        .bind(
          credential.actor_id,
          credential.device_id,
          credential.label ?? '',
          '',
          at,
          at,
        ),
    ]);
  } catch {
    // 活动时间只是展示信息；写入失败不能阻断已认证请求。
  }
}

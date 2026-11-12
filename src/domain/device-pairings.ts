import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  DevicePairingApproveInput,
  DevicePairingCancelInput,
  DevicePairingCreateInput,
  DevicePairingJoinInput,
  DevicePairingListInput,
  DevicePairingRedeemInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, stableStringify, utf8Bytes } from '../storage/db';
import { eventStatement, inboxHeadStatement, inboxTopic, outboxStatement } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, getCredentialByHash } from '../storage/queries';
import type { DevicePairingRow } from '../storage/rows';
import {
  operationsStatement,
  resolveReplay,
  runIdempotent,
} from '../storage/transactions/runner';
import { identityView, type IdentityView } from './identity';
import { actorId, type Principal } from './principal';
import { hasControlChars } from '../contracts/text';
import { hashSecret } from './secrets';

/**
 * 设备配对挑战。
 *
 * 已登录设备 create 生成 5 分钟挑战，明文只出现一次，服务端只存 SHA-256；
 * 新设备 join 用本地生成的未注册 token 证明，绑定 challenge 到
 * device_token_hash，并显示一个从摘要派生的确认码；已登录设备 approve 后
 * 新设备 redeem 才创建同 actor 的独立 credential。
 *
 * 所有写操作带 request_id；挑战/token 明文不写 operations.result_json。
 */

const PAIRING_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PAIRING_LENGTH = 12;


export interface DevicePairingView {
  pairing_id: string;
  status: 'pending' | 'approved' | 'redeemed' | 'expired' | 'cancelled';
  actor_id: string;
  device_id: string | null;
  device_label: string;
  platform: string;
  confirm_code: string | null;
  created_at: string;
  expires_at: string;
  approved_at: string | null;
  redeemed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string;
  attempts: number;
  max_attempts: number;
  created_by_current_device: boolean;
}

export interface DevicePairingActorView {
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
}

export interface DevicePairingCreateResult {
  pairing_id: string;
  challenge: string;
  pair_url: string;
  expires_at: string;
  created_at: string;
}

export interface DevicePairingJoinResult {
  pairing: DevicePairingView;
  actor: DevicePairingActorView;
}

export interface DevicePairingListResult {
  items: DevicePairingView[];
  pending_count: number;
}

export interface DevicePairingRedeemResult extends IdentityView {
  paired: true;
  device_id: string;
  pairing_id: string;
}

function normalizeDeviceText(raw: string | undefined, maxBytes: number, field: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (utf8Bytes(value) > maxBytes) {
    throw new BusinessError('INVALID_ARGUMENT', `${field} 超过 ${maxBytes} 字节`);
  }
  if (hasControlChars(value)) {
    throw new BusinessError('INVALID_ARGUMENT', `${field} 不能包含控制字符或换行`);
  }
  return value;
}

/** 短码使用 Crockford Base32：去掉 I/L/O/U 的歧义，12 位约 60 bit 熵。 */
export function normalizeDeviceChallenge(raw: string): string {
  const compact = raw
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/gu, '')
    .replaceAll('I', '1')
    .replaceAll('L', '1')
    .replaceAll('O', '0')
    .replaceAll('U', 'V');
  if (compact.length !== PAIRING_LENGTH || !/^[0-9A-HJKMNP-TV-Z]{12}$/u.test(compact)) {
    throw new BusinessError(
      'PAIRING_INVALID',
      '配对码格式不正确；请输入或扫描 12 位配对码（不含 I/L/O/U）',
    );
  }
  return compact;
}

function randomChallenge(): string {
  const bytes = new Uint8Array(PAIRING_LENGTH);
  crypto.getRandomValues(bytes);
  let value = '';
  for (const byte of bytes) value += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
  return value;
}

async function challengeHash(challenge: string): Promise<string> {
  return hashSecret('pairing', challenge);
}

/**
 * 确认码只从服务端保存的 device_token_hash 与 pairing_id 派生。
 *
 * 它既不是挑战也不是 token；新设备与已登录设备各自显示同一短码，
 * 让批准人能核对“确认的是哪一台设备”，但短码不能兑换凭据。
 */
export async function pairingConfirmCode(
  pairingId: string,
  deviceTokenHash: string,
): Promise<string> {
  const digest = await hashSecret('pairing-confirm', `${pairingId}:${deviceTokenHash}`);
  const code = digest.slice(0, 8).toUpperCase();
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function pairingView(
  row: DevicePairingRow,
  currentCredentialId: string | null,
): Promise<DevicePairingView> {
  return {
    pairing_id: row.pairing_id,
    status: row.status,
    actor_id: row.actor_id ?? '',
    device_id: row.device_id,
    device_label: row.device_label,
    platform: row.platform,
    confirm_code: row.device_token_hash
      ? await pairingConfirmCode(row.pairing_id, row.device_token_hash)
      : null,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    approved_at: row.approved_at === null ? null : String(row.approved_at),
    redeemed_at: row.redeemed_at === null ? null : String(row.redeemed_at),
    cancelled_at: row.cancelled_at === null ? null : String(row.cancelled_at),
    cancel_reason: row.cancel_reason,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    created_by_current_device:
      currentCredentialId !== null && row.created_by_credential_id === currentCredentialId,
  };
}

async function getPairingById(db: D1Database, pairingId: string): Promise<DevicePairingRow | null> {
  return db
    .prepare('SELECT * FROM device_pairings WHERE pairing_id = ?')
    .bind(pairingId)
    .first<DevicePairingRow>();
}

async function getPairingByChallenge(
  db: D1Database,
  challenge: string,
): Promise<DevicePairingRow | null> {
  const hash = await challengeHash(challenge);
  return db
    .prepare('SELECT * FROM device_pairings WHERE challenge_hash = ?')
    .bind(hash)
    .first<DevicePairingRow>();
}

/**
 * 惰性过期：读取时把已到期的 pending/approved 挑战标为 expired。
 *
 * 不依赖后台定时器；挑战过期后即使进程重启也保持失败。
 */
async function refreshPairing(db: D1Database, row: DevicePairingRow, at: number): Promise<DevicePairingRow> {
  if (row.status !== 'pending' && row.status !== 'approved') return row;
  if (row.expires_at > at) return row;
  await db
    .prepare(
      `UPDATE device_pairings
          SET status = 'expired', updated_at = ?
        WHERE pairing_id = ? AND status IN ('pending', 'approved') AND expires_at <= ?`,
    )
    .bind(at, row.pairing_id, at)
    .run();
  return { ...row, status: 'expired', updated_at: at };
}

function pairingReason(row: DevicePairingRow): string {
  if (row.status === 'expired') return 'expired';
  if (row.status === 'cancelled') {
    if (row.cancel_reason === 'attempts_exceeded') return 'attempts_exceeded';
    return 'cancelled';
  }
  if (row.status === 'redeemed') return 'already_redeemed';
  if (row.status === 'approved') return 'approved';
  return 'pending';
}

function pairingInvalid(reason: string, details: Record<string, unknown> = {}): never {
  const messages: Record<string, string> = {
    expired: '配对挑战已过期，请让已登录设备重新生成二维码或短码',
    cancelled: '配对挑战已被拒绝或撤销，请让已登录设备重新生成',
    already_redeemed: '配对挑战已被使用，请重新生成',
    not_approved: '已登录设备尚未确认这台新设备，请等待确认后再试',
    attempts_exceeded: '配对尝试次数已用尽，请让已登录设备重新生成挑战',
    device_mismatch: '当前 token 不是该挑战绑定的新设备，不能兑换',
    already_bound: '当前 token 已绑定身份；新设备请先生成本地 token',
    revoked_device: '该设备已被撤销，不能重新配对；请更换设备标识后重试',
    unavailable: '配对挑战不存在或已失效，请重新扫描',
  };
  throw new BusinessError('PAIRING_INVALID', messages[reason] ?? '配对挑战无效', {
    reason,
    ...details,
  });
}

async function recordFailedAttempt(
  db: D1Database,
  row: DevicePairingRow,
  actorIdValue: string,
  reason: 'device_mismatch' | 'attempts_exceeded',
  details: Record<string, unknown>,
): Promise<never> {
  const nextAttempts = row.attempts + 1;
  const exhausted = nextAttempts >= row.max_attempts;
  const stored = {
    pairing_id: row.pairing_id,
    attempts: nextAttempts,
    reason: exhausted ? 'attempts_exceeded' : reason,
    cancelled: exhausted,
  };
  const payloadHash = await sha256Hex(
    stableStringify({ pairing_id: row.pairing_id, reason, request_id: actorIdValue }),
  );
  const outcome = (await runIdempotent(db, {
    actorId: `pairing-attempt:${row.pairing_id}`,
    requestId: actorIdValue,
    payloadHash,
    result: stored,
    build: (resultJson) => [
      operationsStatement(
        db,
        `pairing-attempt:${row.pairing_id}`,
        actorIdValue,
        payloadHash,
        resultJson,
        nowMs(),
      ),
      db
        .prepare(
          `UPDATE device_pairings
              SET attempts = MIN(attempts + 1, max_attempts),
                  status = CASE WHEN attempts + 1 >= max_attempts THEN 'cancelled' ELSE status END,
                  cancelled_at = CASE WHEN attempts + 1 >= max_attempts THEN ? ELSE cancelled_at END,
                  cancelled_by = CASE WHEN attempts + 1 >= max_attempts THEN ? ELSE cancelled_by END,
                  cancel_reason = CASE WHEN attempts + 1 >= max_attempts THEN 'attempts_exceeded' ELSE cancel_reason END,
                  updated_at = ?
            WHERE pairing_id = ? AND status IN ('pending', 'approved')`,
        )
        .bind(nowMs(), `pairing-attempt:${row.pairing_id}`, nowMs(), row.pairing_id),
    ],
  })) as { reason?: string; cancelled?: boolean };
  pairingInvalid(outcome.reason === 'attempts_exceeded' ? 'attempts_exceeded' : reason, details);
}

async function assertDeviceNotRevoked(
  db: D1Database,
  actorIdValue: string,
  deviceId: string,
): Promise<void> {
  const revoked = await db
    .prepare(
      "SELECT 1 AS present FROM devices WHERE actor_id = ? AND device_id = ? AND status = 'revoked' LIMIT 1",
    )
    .bind(actorIdValue, deviceId)
    .first<{ present: number }>();
  if (revoked) pairingInvalid('revoked_device');
}

export async function createDevicePairing(
  db: D1Database,
  principal: Principal,
  input: DevicePairingCreateInput,
  origin: string,
): Promise<DevicePairingCreateResult> {
  const caller = actorId(principal);
  const credential = principal.credential;
  if (!credential) throw new BusinessError('CREDENTIAL_INVALID', '配对需要已注册凭据');
  const now = nowMs();
  const deviceLabel = normalizeDeviceText(
    input.device_label,
    LIMITS.devicePairingLabelBytes,
    '设备名称',
  );
  const platform = normalizeDeviceText(
    input.platform,
    LIMITS.devicePairingPlatformBytes,
    '设备平台',
  );
  const device = await db
    .prepare('SELECT * FROM devices WHERE actor_id = ? AND device_id = ?')
    .bind(caller, credential.device_id)
    .first<{ status: string }>();
  if (device?.status === 'revoked') {
    throw new BusinessError('CREDENTIAL_INVALID', '当前设备已撤销，不能创建配对挑战');
  }
  await db
    .prepare(
      `INSERT INTO devices (actor_id, device_id, label, platform, status, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)
       ON CONFLICT(actor_id, device_id) DO UPDATE SET
         label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE devices.label END,
         platform = CASE WHEN excluded.platform <> '' THEN excluded.platform ELSE devices.platform END,
         last_seen_at = excluded.last_seen_at
       WHERE devices.status = 'active'`,
    )
    .bind(caller, credential.device_id, deviceLabel, platform, now, now)
    .run();

  const live = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM device_pairings
        WHERE actor_id = ? AND status IN ('pending', 'approved') AND expires_at > ?`,
    )
    .bind(caller, now)
    .first<{ n: number }>();
  if ((live?.n ?? 0) >= LIMITS.devicePairingPendingMax) {
    throw new BusinessError('CONFLICT', '待确认的配对挑战过多，请先拒绝或等待旧挑战过期');
  }

  const ttl = input.expires_in_ms ?? LIMITS.devicePairingTtlMs;
  const expiresAt = now + ttl;
  const pairingId = newId('pair');
  const challenge = randomChallenge();
  const hash = await challengeHash(challenge);
  const stored = {
    pairing_id: pairingId,
    expires_at: String(expiresAt),
    created_at: String(now),
  };
  const payloadHash = await sha256Hex(stableStringify(input));
  const outcome = await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: stored,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, now),
      db
        .prepare(
          `INSERT INTO device_pairings
             (pairing_id, challenge_hash, status, actor_id, created_at, expires_at,
              approved_by_actor_id, approved_by_credential_id, approved_at,
              redeemed_credential_id, redeemed_at, attempts, max_attempts, updated_at,
              created_by_credential_id, device_id, device_label, platform, device_token_hash,
              cancelled_at, cancelled_by, cancel_reason)
           VALUES (?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, NULL, NULL,
                  0, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, '')`,
        )
        .bind(
          pairingId,
          hash,
          caller,
          now,
          expiresAt,
          LIMITS.devicePairingMaxAttempts,
          now,
          credential.credential_id,
          deviceLabel,
          platform,
        ),
    ],
  });
  // 首次返回 stored 本身；重放是 JSON.parse 出的新对象，不能再吐挑战明文。
  if (outcome !== stored) {
    throw new BusinessError(
      'TOKEN_NOT_REPLAYABLE',
      '配对挑战只在首次响应出现一次；请使用新的 request_id 重新生成',
    );
  }
  return {
    ...stored,
    challenge,
    pair_url: `${origin.replace(/\/+$/u, '')}/pair#c=${encodeURIComponent(challenge)}`,
  };
}

export async function joinDevicePairing(
  db: D1Database,
  principal: Principal,
  input: DevicePairingJoinInput,
): Promise<DevicePairingJoinResult> {
  if (principal.actor) pairingInvalid('already_bound');
  if (!principal.credentialHash) {
    pairingInvalid('unavailable', { hint: '新设备需要先在本地生成并保存 token' });
  }
  const normalized = normalizeDeviceChallenge(input.challenge);
  const now = nowMs();
  let row = await getPairingByChallenge(db, normalized);
  if (!row) pairingInvalid('unavailable');
  row = await refreshPairing(db, row, now);
  if (row.status === 'expired' || row.status === 'cancelled' || row.status === 'redeemed') {
    pairingInvalid(pairingReason(row));
  }
  if (!row.actor_id) pairingInvalid('unavailable');
  const pairingActorId = row.actor_id;

  const deviceLabel = normalizeDeviceText(
    input.device_label,
    LIMITS.devicePairingLabelBytes,
    '设备名称',
  );
  const platform = normalizeDeviceText(
    input.platform,
    LIMITS.devicePairingPlatformBytes,
    '设备平台',
  );

  if (row.device_token_hash && row.device_token_hash !== principal.credentialHash) {
    await recordFailedAttempt(db, row, input.request_id, 'device_mismatch', {
      pairing_id: row.pairing_id,
    });
  }

  if (!row.device_token_hash) {
    const payloadHash = await sha256Hex(stableStringify({ ...input, challenge: normalized }));
    const claimed = await runIdempotent(db, {
      actorId: `pairing-join:${row.pairing_id}`,
      requestId: input.request_id,
      payloadHash,
      result: { pairing_id: row.pairing_id },
      build: (resultJson) => {
        const eventKey = `device_pairing_requested:${row!.pairing_id}`;
        return [
          operationsStatement(
            db,
            `pairing-join:${row!.pairing_id}`,
            input.request_id,
            payloadHash,
            resultJson,
            now,
          ),
          db
            .prepare(
              guardSql(
                'pairingInvalid',
                `NOT EXISTS (
                   SELECT 1 FROM device_pairings
                    WHERE pairing_id = ? AND status = 'pending' AND device_token_hash IS NULL
                      AND expires_at > ? AND attempts < max_attempts
                 )`,
              ),
            )
            .bind(row!.pairing_id, now),
          db
            .prepare(
              `UPDATE device_pairings
                  SET device_token_hash = ?, device_id = ?, device_label = ?, platform = ?, updated_at = ?
                WHERE pairing_id = ? AND status = 'pending' AND device_token_hash IS NULL`,
            )
            .bind(
              principal.credentialHash,
              input.device_id,
              deviceLabel,
              platform,
              now,
              row!.pairing_id,
            ),
          eventStatement(
            db,
            {
              eventKey,
              scopeKind: 'inbox',
              scopeId: pairingActorId,
              eventType: 'device_pairing_requested',
              refId: row!.pairing_id,
              metadata: {
                pairing_id: row!.pairing_id,
                device_id: input.device_id,
                device_label: deviceLabel,
                platform,
              },
            },
            now,
          ),
          outboxStatement(db, { topic: inboxTopic(pairingActorId), eventKey }, now),
          inboxHeadStatement(db, pairingActorId, eventKey, now, 0),
        ];
      },
    }).catch(async (error) => {
      // 并发 join：重新读取后按“同一 token 幂等 / 其他 token 失败”收敛。
      const current = await getPairingByChallenge(db, normalized);
      if (current && current.device_token_hash === principal.credentialHash) return null;
      if (current) await recordFailedAttempt(db, current, input.request_id, 'device_mismatch', {});
      throw error;
    });
    void claimed;
    row = await getPairingByChallenge(db, normalized);
    if (!row) pairingInvalid('unavailable');
  } else if (
    row.device_token_hash === principal.credentialHash &&
    row.status === 'pending' &&
    (row.device_id !== input.device_id || row.device_label !== deviceLabel || row.platform !== platform)
  ) {
    // 同一 token 的合法重试允许更新展示信息，不改变绑定关系。
    await db
      .prepare(
        `UPDATE device_pairings
            SET device_id = ?, device_label = ?, platform = ?, updated_at = ?
          WHERE pairing_id = ? AND status = 'pending'`,
      )
      .bind(input.device_id, deviceLabel, platform, now, row.pairing_id)
      .run();
    row = await getPairingByChallenge(db, normalized);
  }

  if (!row) pairingInvalid('unavailable');
  if (row.status === 'expired' || row.status === 'cancelled' || row.status === 'redeemed') {
    pairingInvalid(pairingReason(row));
  }
  if (row.device_token_hash !== principal.credentialHash) {
    pairingInvalid('device_mismatch');
  }
  const actor = await getActor(db, row.actor_id!);
  if (!actor) pairingInvalid('unavailable');
  return {
    pairing: await pairingView(row, null),
    actor: { actor_id: actor.actor_id, name: actor.name, kind: actor.kind },
  };
}

export async function listDevicePairings(
  db: D1Database,
  principal: Principal,
  input: DevicePairingListInput,
): Promise<DevicePairingListResult> {
  const caller = actorId(principal);
  const now = nowMs();
  await db
    .prepare(
      `UPDATE device_pairings
          SET status = 'expired', updated_at = ?
        WHERE actor_id = ? AND status IN ('pending', 'approved') AND expires_at <= ?`,
    )
    .bind(now, caller, now)
    .run();
  const limit = Math.min(input.limit ?? LIMITS.devicePairingListDefault, LIMITS.devicePairingListMax);
  const rows = await db
    .prepare(
      `SELECT * FROM device_pairings
        WHERE actor_id = ? AND status IN ('pending', 'approved', 'redeemed', 'expired', 'cancelled')
        ORDER BY status IN ('pending', 'approved') DESC, created_at DESC
        LIMIT ?`,
    )
    .bind(caller, limit)
    .all<DevicePairingRow>();
  const currentCredentialId = principal.credential?.credential_id ?? null;
  const items = await Promise.all(rows.results.map((row) => pairingView(row, currentCredentialId)));
  return {
    items,
    pending_count: items.filter((item) => item.status === 'pending').length,
  };
}

export async function approveDevicePairing(
  db: D1Database,
  principal: Principal,
  input: DevicePairingApproveInput,
): Promise<{ pairing: DevicePairingView }> {
  const caller = actorId(principal);
  const credential = principal.credential;
  if (!credential) throw new BusinessError('CREDENTIAL_INVALID', '批准配对需要已注册凭据');
  const now = nowMs();
  let row = await getPairingById(db, input.pairing_id);
  if (!row) pairingInvalid('unavailable');
  if (row.actor_id !== caller) {
    throw new BusinessError('PERMISSION_DENIED', '只能批准当前身份自己的配对请求', {
      pairing_id: input.pairing_id,
    });
  }
  row = await refreshPairing(db, row, now);
  if (row.status === 'approved' || row.status === 'redeemed') {
    return { pairing: await pairingView(row, credential.credential_id) };
  }
  if (row.status !== 'pending') pairingInvalid(pairingReason(row));
  if (!row.device_token_hash) {
    throw new BusinessError('PAIRING_INVALID', '新设备尚未完成配对申请，请刷新后再确认', {
      reason: 'not_joined',
      pairing_id: row.pairing_id,
    });
  }

  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `device_pairing_approved:${row.pairing_id}`;
  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { pairing_id: row.pairing_id, approved: true },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, now),
      db
        .prepare(
          guardSql(
            'pairingInvalid',
            `NOT EXISTS (
               SELECT 1 FROM device_pairings
                WHERE pairing_id = ? AND actor_id = ? AND status = 'pending'
                  AND device_token_hash IS NOT NULL AND expires_at > ?
                  AND attempts < max_attempts
             )`,
          ),
        )
        .bind(row!.pairing_id, caller, now),
      db
        .prepare(
          `UPDATE device_pairings
              SET status = 'approved', approved_by_actor_id = ?, approved_by_credential_id = ?,
                  approved_at = ?, updated_at = ?
            WHERE pairing_id = ? AND status = 'pending'`,
        )
        .bind(caller, credential.credential_id, now, now, row!.pairing_id),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'inbox',
          scopeId: caller,
          eventType: 'device_pairing_approved',
          refId: row!.pairing_id,
          metadata: {
            pairing_id: row!.pairing_id,
            device_id: row!.device_id,
            device_label: row!.device_label,
            platform: row!.platform,
          },
        },
        now,
      ),
      outboxStatement(db, { topic: inboxTopic(caller), eventKey }, now),
      inboxHeadStatement(db, caller, eventKey, now, 0),
    ],
  });
  row = await getPairingById(db, input.pairing_id);
  if (!row) pairingInvalid('unavailable');
  return { pairing: await pairingView(row, credential.credential_id) };
}

export async function cancelDevicePairing(
  db: D1Database,
  principal: Principal,
  input: DevicePairingCancelInput,
): Promise<{ pairing: DevicePairingView }> {
  const caller = actorId(principal);
  const now = nowMs();
  let row = await getPairingById(db, input.pairing_id);
  if (!row) pairingInvalid('unavailable');
  if (row.actor_id !== caller) {
    throw new BusinessError('PERMISSION_DENIED', '只能取消当前身份自己的配对请求', {
      pairing_id: input.pairing_id,
    });
  }
  row = await refreshPairing(db, row, now);
  if (row.status === 'cancelled' || row.status === 'expired') {
    return { pairing: await pairingView(row, principal.credential?.credential_id ?? null) };
  }
  if (row.status === 'redeemed') pairingInvalid(pairingReason(row));

  const reason = normalizeDeviceText(input.reason, 512, '拒绝原因') || 'cancelled_by_user';
  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `device_pairing_cancelled:${row.pairing_id}`;
  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: { pairing_id: row.pairing_id, cancelled: true },
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, now),
      db
        .prepare(
          guardSql(
            'pairingInvalid',
            `NOT EXISTS (
               SELECT 1 FROM device_pairings
                WHERE pairing_id = ? AND actor_id = ? AND status IN ('pending', 'approved')
             )`,
          ),
        )
        .bind(row!.pairing_id, caller),
      db
        .prepare(
          `UPDATE device_pairings
              SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?
            WHERE pairing_id = ? AND status IN ('pending', 'approved')`,
        )
        .bind(now, caller, reason, now, row!.pairing_id),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'inbox',
          scopeId: caller,
          eventType: 'device_pairing_cancelled',
          refId: row!.pairing_id,
          metadata: { pairing_id: row!.pairing_id, reason },
        },
        now,
      ),
      outboxStatement(db, { topic: inboxTopic(caller), eventKey }, now),
      inboxHeadStatement(db, caller, eventKey, now, 0),
    ],
  });
  row = await getPairingById(db, input.pairing_id);
  if (!row) pairingInvalid('unavailable');
  return { pairing: await pairingView(row, principal.credential?.credential_id ?? null) };
}

export async function redeemDevicePairing(
  db: D1Database,
  principal: Principal,
  input: DevicePairingRedeemInput,
  origin: string,
): Promise<DevicePairingRedeemResult> {
  const normalized = normalizeDeviceChallenge(input.challenge);
  const now = nowMs();
  let row = await getPairingByChallenge(db, normalized);
  if (!row) pairingInvalid('unavailable');
  if (!row.actor_id) pairingInvalid('unavailable');
  const pairingActorId = row.actor_id;

  const payloadHash = await sha256Hex(stableStringify({ ...input, challenge: normalized }));
  // 网络重试：新 token 已经兑换成功后，同一 request_id 必须返回同一身份，
  // 但只有真正持有该 credential 的请求才能读到重放结果。
  const replay = await resolveReplay(
    db,
    `pairing-redeem:${row.pairing_id}`,
    input.request_id,
    payloadHash,
  );
  if (replay.found) {
    if (
      principal.actor?.actor_id === pairingActorId &&
      principal.credential?.credential_id === row.redeemed_credential_id
    ) {
      return replay.result as DevicePairingRedeemResult;
    }
    pairingInvalid('device_mismatch');
  }

  if (principal.actor) {
    if (
      row.status === 'redeemed' &&
      row.redeemed_credential_id === principal.credential?.credential_id &&
      principal.actor.actor_id === pairingActorId
    ) {
      const actor = await getActor(db, pairingActorId);
      if (!actor) pairingInvalid('unavailable');
      return {
        ...identityView(actor, origin),
        paired: true,
        device_id: row.device_id ?? principal.credential.device_id,
        pairing_id: row.pairing_id,
      };
    }
    pairingInvalid('already_bound');
  }
  if (!principal.credentialHash) pairingInvalid('unavailable');

  row = await refreshPairing(db, row, now);
  if (row.status === 'expired' || row.status === 'cancelled') pairingInvalid(pairingReason(row));
  if (row.status === 'redeemed') pairingInvalid('already_redeemed');
  if (row.status === 'pending') pairingInvalid('not_approved');
  if (row.device_token_hash !== principal.credentialHash || row.device_id !== input.device_id) {
    await recordFailedAttempt(db, row, input.request_id, 'device_mismatch', {
      pairing_id: row.pairing_id,
    });
  }
  await assertDeviceNotRevoked(db, pairingActorId, input.device_id);

  const existing = await getCredentialByHash(db, principal.credentialHash);
  if (existing) {
    if (
      existing.actor_id === pairingActorId &&
      existing.device_id === input.device_id &&
      existing.revoked_at === null
    ) {
      const actor = await getActor(db, pairingActorId);
      if (!actor) pairingInvalid('unavailable');
      return {
        ...identityView(actor, origin),
        paired: true,
        device_id: existing.device_id,
        pairing_id: row.pairing_id,
      };
    }
    pairingInvalid('already_bound');
  }

  const actor = await getActor(db, pairingActorId);
  if (!actor) pairingInvalid('unavailable');
  const credentialId = newId('cred');
  const eventKey = `device_paired:${row.pairing_id}`;
  const result = {
    ...identityView(actor, origin),
    paired: true as const,
    device_id: input.device_id,
    pairing_id: row.pairing_id,
  };
  const outcome = await runIdempotent(db, {
    actorId: `pairing-redeem:${row.pairing_id}`,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(
        db,
        `pairing-redeem:${row.pairing_id}`,
        input.request_id,
        payloadHash,
        resultJson,
        now,
      ),
      db
        .prepare(
          guardSql(
            'pairingInvalid',
            `NOT EXISTS (
               SELECT 1 FROM device_pairings
                WHERE pairing_id = ? AND status = 'approved' AND expires_at > ?
                  AND device_token_hash = ? AND device_id = ? AND attempts < max_attempts
             )`,
          ),
        )
        .bind(row!.pairing_id, now, principal.credentialHash, input.device_id),
      db
        .prepare(
          guardSql(
            'pairingInvalid',
            `EXISTS (SELECT 1 FROM devices WHERE actor_id = ? AND device_id = ? AND status = 'revoked')`,
          ),
        )
        .bind(pairingActorId, input.device_id),
      db
        .prepare(
          `INSERT INTO credentials
             (credential_id, actor_id, device_id, token_hash, revoked_at, created_at, last_used_at, revoked_by, label)
           VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
        )
        .bind(
          credentialId,
          pairingActorId,
          input.device_id,
          principal.credentialHash,
          now,
          now,
          row!.device_label || null,
        ),
      db
        .prepare(
          `INSERT INTO devices (actor_id, device_id, label, platform, status, created_at, last_seen_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(actor_id, device_id) DO UPDATE SET
             label = CASE WHEN excluded.label <> '' THEN excluded.label ELSE devices.label END,
             platform = CASE WHEN excluded.platform <> '' THEN excluded.platform ELSE devices.platform END,
             status = 'active', last_seen_at = excluded.last_seen_at`,
        )
        .bind(
          pairingActorId,
          input.device_id,
          row!.device_label,
          row!.platform,
          now,
          now,
        ),
      db
        .prepare(
          `UPDATE device_pairings
              SET status = 'redeemed', redeemed_credential_id = ?, redeemed_at = ?, updated_at = ?
            WHERE pairing_id = ? AND status = 'approved'`,
        )
        .bind(credentialId, now, now, row!.pairing_id),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'inbox',
          scopeId: pairingActorId,
          eventType: 'device_paired',
          refId: row!.pairing_id,
          metadata: {
            pairing_id: row!.pairing_id,
            device_id: input.device_id,
            device_label: row!.device_label,
            platform: row!.platform,
          },
        },
        now,
      ),
      outboxStatement(db, { topic: inboxTopic(pairingActorId), eventKey }, now),
      inboxHeadStatement(db, pairingActorId, eventKey, now, 0),
    ],
  });
  return outcome as DevicePairingRedeemResult;
}


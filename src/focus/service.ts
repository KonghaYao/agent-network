/**
 * 任务秘书服务身份。
 *
 * 所有用户的秘书共用同一个固定服务 actor：Swarm 以部署服务凭据回调
 * WeBots MCP，owner 只能从 `attempt_ref` 对应的作业推导。明文 token 只
 * 在启动时读取一次，数据库仅保存带 `token` 域前缀的 SHA-256 摘要；凭据
 * 轮换时撤销旧摘要再插入新摘要，不写日志。
 */

import { BusinessError } from '../contracts/errors';
import { nowMs, hashToken, newId } from '../storage/db';
import type { Principal } from '../domain/principal';

export const FOCUS_SERVICE_ACTOR_ID = 'act_focus_service';
export const FOCUS_SERVICE_ACTOR_NAME = '任务秘书运行时';
const FOCUS_SERVICE_DEVICE_ID = 'focus-runtime';
const FOCUS_SERVICE_METADATA = JSON.stringify({
  system: true,
  role: 'focus_service',
});

export interface FocusServiceActor {
  actorId: string;
  rotated: boolean;
}

/**
 * 确保服务 actor 与当前服务 token 摘要存在。
 *
 * 同一 token 重复调用是幂等的；token 变化时旧 credential 被撤销后插入
 * 新摘要。整个过程在一个 batch 中完成，不会短暂保留两个有效凭据。
 */
export async function ensureFocusServiceActor(
  db: D1Database,
  serviceToken: string,
): Promise<FocusServiceActor> {
  const tokenHash = await hashToken(serviceToken);
  const at = nowMs();
  const actor = await db
    .prepare('SELECT actor_id, kind, agent_session_id FROM actors WHERE actor_id = ?')
    .bind(FOCUS_SERVICE_ACTOR_ID)
    .first<{ actor_id: string; kind: string; agent_session_id: string | null }>();
  if (actor && (actor.kind !== 'agent' || actor.agent_session_id !== null)) {
    throw new Error('focus service actor exists with incompatible identity');
  }
  const current = await db
    .prepare(
      `SELECT credential_id, token_hash FROM credentials
        WHERE actor_id = ? AND revoked_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(FOCUS_SERVICE_ACTOR_ID)
    .first<{ credential_id: string; token_hash: string }>();
  if (actor && current?.token_hash === tokenHash) {
    return { actorId: FOCUS_SERVICE_ACTOR_ID, rotated: false };
  }

  const statements: D1PreparedStatement[] = [];
  if (!actor) {
    statements.push(
      db
        .prepare(
          `INSERT INTO actors
             (actor_id, kind, agent_session_id, name, metadata,
              inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
           VALUES (?, 'agent', NULL, ?, ?, 0, 0, 0, ?, ?)`,
        )
        .bind(
          FOCUS_SERVICE_ACTOR_ID,
          FOCUS_SERVICE_ACTOR_NAME,
          FOCUS_SERVICE_METADATA,
          at,
          at,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `UPDATE credentials SET revoked_at = ?, revoked_by = ?
          WHERE actor_id = ? AND revoked_at IS NULL`,
      )
      .bind(at, FOCUS_SERVICE_ACTOR_ID, FOCUS_SERVICE_ACTOR_ID),
    db
      .prepare(
        `INSERT INTO credentials (credential_id, actor_id, device_id, token_hash, revoked_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .bind(newId('cred'), FOCUS_SERVICE_ACTOR_ID, FOCUS_SERVICE_DEVICE_ID, tokenHash, at),
  );
  await db.batch(statements);
  return { actorId: FOCUS_SERVICE_ACTOR_ID, rotated: true };
}

export function isFocusServicePrincipal(principal: Principal): boolean {
  return (
    principal.actor?.actor_id === FOCUS_SERVICE_ACTOR_ID && principal.actor.kind === 'agent'
  );
}

/** 秘书工具只接受固定服务身份；普通 Agent、卡主秘书 actor 一律拒绝。 */
export function requireFocusService(principal: Principal): void {
  if (!isFocusServicePrincipal(principal)) {
    throw new BusinessError('PERMISSION_DENIED', '任务秘书工具只允许服务运行时调用');
  }
}

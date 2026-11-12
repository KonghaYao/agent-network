import { parseMetadataObject } from '../contracts/metadata';
import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  AgentReissueTokenInput,
  AgentRenameInput,
  MeRenameInput,
  RegisterInput,
} from '../contracts/schemas';
import {
  hashToken,
  newId,
  nowMs,
  randomToken,
  sha256Hex,
  stableStringify,
  utf8Bytes,
} from '../storage/db';
import { eventStatement, inboxHeadStatement, inboxTopic, outboxStatement } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor, getActorBySession, getCredentialByHash } from '../storage/queries';
import type { ActorRow, CredentialRow, RecoveryTicketRow } from '../storage/rows';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';
import { managementEventStatements } from './agent-management';
import { memoryInitialSpaceStatements } from '../memory/statements';
import {
  managementPermissionGuard,
  managementVersionGuard,
  requireManageAgent,
} from './agent-access';
import { actorId, actorResources, type Principal } from './principal';
import { hasControlChars } from '../contracts/text';
import { hashSecret } from './secrets';

export interface IdentityView {
  actor_id: string;
  kind: 'human' | 'agent';
  agent_session_id: string | null;
  name: string;
  metadata: Record<string, unknown>;
  pending_count: number;
  inbox_head_seq: string;
  created_at: string;
  share_url: string | null;
  resources: string[];
}

export function identityView(actor: ActorRow, origin: string): IdentityView {
  return {
    actor_id: actor.actor_id,
    kind: actor.kind,
    agent_session_id: actor.agent_session_id,
    name: actor.name,
    metadata: parseMetadataObject(actor.metadata),
    pending_count: actor.pending_count,
    inbox_head_seq: String(actor.inbox_head_seq),
    created_at: String(actor.created_at),
    share_url: actor.agent_session_id ? `${origin}/a/${encodeURIComponent(actor.agent_session_id)}` : null,
    resources: actorResources(actor.actor_id),
  };
}

async function registrationResult(
  db: D1Database,
  principal: Principal,
  input: RegisterInput,
  origin: string,
): Promise<IdentityView> {
  if (!principal.actor) throw new BusinessError('CREDENTIAL_INVALID', '凭据未绑定 actor');
  return identityView(principal.actor, origin);
}

/**
 * 注册 human/agent actor 并原子绑定当前凭据。
 *
 * 未注册凭据也可调用；已注册凭据重复调用返回同一身份。
 */
export async function register(
  db: D1Database,
  principal: Principal,
  input: RegisterInput,
  origin: string,
): Promise<IdentityView> {
  if (principal.actor) {
    if (principal.actor.kind !== input.kind) {
      throw new BusinessError('CONFLICT', '当前凭据已注册为另一种 actor 类型');
    }
    if (input.actor_id && input.actor_id !== principal.actor.actor_id) {
      throw new BusinessError('ACTOR_EXISTS', '当前凭据已绑定其他 actor_id');
    }
    return identityView(principal.actor, origin);
  }

  if (!principal.credentialHash) {
    throw new BusinessError('CREDENTIAL_INVALID', '注册需要 Bearer 凭据；客户端应先本地生成并保存');
  }
  if (input.metadata && utf8Bytes(JSON.stringify(input.metadata)) > LIMITS.actorMetadataBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', 'actor metadata 超过 4 KiB');
  }
  if (input.kind === 'agent' && !input.agent_session_id) {
    throw new BusinessError('INVALID_ARGUMENT', 'agent 注册必须提供 agent_session_id');
  }

  const at = nowMs();
  const actorKey = input.actor_id ?? newId(input.kind === 'agent' ? 'agt' : 'usr');
  const credentialId = newId('cred');
  const metadata = JSON.stringify(input.metadata ?? {});
  const result = {
    actor_id: actorKey,
    kind: input.kind,
    agent_session_id: input.agent_session_id ?? null,
    name: input.name,
    share_url: input.agent_session_id
      ? `${origin}/a/${encodeURIComponent(input.agent_session_id)}`
      : null,
    resources: actorResources(actorKey),
  };
  const payloadHash = await sha256Hex(stableStringify(input));

  const statements: D1PreparedStatement[] = [
    operationsStatement(db, actorKey, input.request_id, payloadHash, JSON.stringify(result), at),
    db
      .prepare(guardSql('actorExists', 'EXISTS (SELECT 1 FROM actors WHERE actor_id = ?)'))
      .bind(actorKey),
    db
      .prepare(
        guardSql(
          'actorExists',
          "EXISTS (SELECT 1 FROM actors WHERE agent_session_id = ? AND ? IS NOT NULL)",
        ),
      )
      .bind(input.agent_session_id ?? null, input.agent_session_id ?? null),
    db
      .prepare(
        `INSERT INTO actors
           (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`,
      )
      .bind(actorKey, input.kind, input.agent_session_id ?? null, input.name, metadata, at, at),
    db
      .prepare(
        `INSERT INTO credentials (credential_id, actor_id, device_id, token_hash, revoked_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .bind(
        credentialId,
        actorKey,
        input.device_id ?? 'default',
        principal.credentialHash,
        at,
      ),
    db
      .prepare(
        `INSERT INTO devices (actor_id, device_id, label, platform, status, created_at, last_seen_at)
         VALUES (?, ?, '', '', 'active', ?, ?)
         ON CONFLICT(actor_id, device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
         WHERE devices.status = 'active'`,
      )
      .bind(actorKey, input.device_id ?? 'default', at, at),
    ...(input.kind === 'agent'
      ? memoryInitialSpaceStatements(db, {
          spaceId: newId('msp'),
          transitionId: newId('mtr'),
          instanceId: newId('mni'),
          agentId: actorKey,
          ownerActorId: actorKey,
          ownershipKind: 'self_owned',
          managementBindingId: null,
          now: at,
        })
      : []),
  ];

  try {
    await db.batch(statements);
  } catch (error) {
    const text = String(error);
    if (text.includes('guard_actor_exists')) {
      throw new BusinessError('ACTOR_EXISTS', 'actor_id 或 agent_session_id 已被占用');
    }
    if (text.includes('UNIQUE constraint failed: credentials.token_hash')) {
      const existing = await getCredentialByHash(db, principal.credentialHash);
      if (existing) {
        const actor = await getActor(db, existing.actor_id);
        if (actor) return identityView(actor, origin);
      }
    }
    throw error;
  }

  const actor = await getActor(db, actorKey);
  if (!actor) throw new BusinessError('CONFLICT', '注册事务已提交但读不到 actor');
  return identityView(actor, origin);
}

export async function me(db: D1Database, principal: Principal, origin: string): Promise<IdentityView> {
  const id = actorId(principal);
  const actor = await getActor(db, id);
  if (!actor) throw new BusinessError('NOT_FOUND', 'actor 不存在');
  return identityView(actor, origin);
}

export async function updateProfile(
  db: D1Database,
  principal: Principal,
  input: { request_id: string; name?: string; metadata?: Record<string, unknown> },
  origin: string,
): Promise<IdentityView> {
  const id = actorId(principal);
  const at = nowMs();
  if (input.metadata && utf8Bytes(JSON.stringify(input.metadata)) > LIMITS.actorMetadataBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', 'actor metadata 超过 4 KiB');
  }
  const eventKey = `profile:${id}:${input.request_id}`;
  const result = { actor_id: id, updated: true };
  const payloadHash = await sha256Hex(stableStringify(input));

  await runIdempotent(db, {
    actorId: id,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, id, input.request_id, payloadHash, resultJson, at),
      db.prepare(guardSql('notMember', 'NOT EXISTS (SELECT 1 FROM actors WHERE actor_id = ?)')).bind(id),
      db
        .prepare(
          `UPDATE actors SET name = COALESCE(?, name), metadata = COALESCE(?, metadata), updated_at = ?
           WHERE actor_id = ?`,
        )
        .bind(input.name ?? null, input.metadata ? JSON.stringify(input.metadata) : null, at, id),
      eventStatement(
        db,
        { eventKey, scopeKind: 'inbox', scopeId: id, eventType: 'profile_updated', refId: id },
        at,
      ),
      outboxStatement(db, { topic: inboxTopic(id), eventKey }, at),
      inboxHeadStatement(db, id, eventKey, at, 0),
    ],
  });

  const actor = await getActor(db, id);
  if (!actor) throw new BusinessError('NOT_FOUND', 'actor 不存在');
  return identityView(actor, origin);
}

export interface AgentRenameResult {
  actor_id: string;
  name: string;
  updated_at: string;
}

export interface MeRenameResult {
  actor_id: string;
  name: string;
  updated_at: string;
}

/**
 * 自助改名校验：trim、非空、字符/字节上限、拒绝控制字符。
 *
 * 错误信息只描述规则，不回显输入内容，避免把潜在凭据或注入文本写进响应。
 */
export function normalizeActorName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new BusinessError('INVALID_ARGUMENT', '名称不能为空');
  if (Array.from(name).length > LIMITS.actorNameMax) {
    throw new BusinessError('INVALID_ARGUMENT', `名称不能超过 ${LIMITS.actorNameMax} 个字符`);
  }
  if (utf8Bytes(name) > LIMITS.actorNameBytes) {
    throw new BusinessError('INVALID_ARGUMENT', `名称不能超过 ${LIMITS.actorNameBytes} 字节`);
  }
  if (hasControlChars(name)) {
    throw new BusinessError('INVALID_ARGUMENT', '名称不能包含控制字符或换行');
  }
  return name;
}

/**
 * 修改当前 principal 自己的展示名称。
 *
 * 没有目标 actor 参数，权限只来自当前 Bearer；任何 principal 都只能改自己。
 * 与 `network_agent_rename` 的开放管理边界无关，不改变其 human 限制。
 * 幂等写入同时发出 profile_updated 事件，供订阅方刷新显示名。
 */
export async function renameMe(
  db: D1Database,
  principal: Principal,
  input: MeRenameInput,
): Promise<MeRenameResult> {
  const id = actorId(principal);
  const name = normalizeActorName(input.name);
  const at = nowMs();
  const eventKey = `profile:${id}:${input.request_id}`;
  const result: MeRenameResult = { actor_id: id, name, updated_at: String(at) };
  const payloadHash = await sha256Hex(stableStringify(input));

  await runIdempotent(db, {
    actorId: id,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, id, input.request_id, payloadHash, resultJson, at),
      db.prepare(guardSql('notMember', 'NOT EXISTS (SELECT 1 FROM actors WHERE actor_id = ?)')).bind(id),
      db.prepare('UPDATE actors SET name = ?, updated_at = ? WHERE actor_id = ?').bind(name, at, id),
      eventStatement(
        db,
        { eventKey, scopeKind: 'inbox', scopeId: id, eventType: 'profile_updated', refId: id },
        at,
      ),
      outboxStatement(db, { topic: inboxTopic(id), eventKey }, at),
      inboxHeadStatement(db, id, eventKey, at, 0),
    ],
  });

  return result;
}

/**
 * 重命名 Agent actor。
 *
 * 只有该 Agent 的 active manager 或持有 `manage_agent` 委托的 human 可调用；
 * 目标必须是 Agent。群角色、联系人和浏览器本地 owner 字段都不构成授权。
 * 事务内再次执行权限 guard，避免“先读后写”窗口。
 */
export async function renameAgent(
  db: D1Database,
  principal: Principal,
  input: AgentRenameInput,
): Promise<AgentRenameResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const { target } = await requireManageAgent(db, principal, input.actor_id, at);
  const name = normalizeActorName(input.name);
  const eventKey = `profile:${target.actor_id}:${input.request_id}`;
  const result = { actor_id: target.actor_id, name, updated_at: String(at) };
  const payloadHash = await sha256Hex(stableStringify(input));
  const versionGuard = managementVersionGuard(
    db,
    target.actor_id,
    input.expected_permission_version,
  );

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      managementPermissionGuard(db, target.actor_id, caller, at),
      ...(versionGuard ? [versionGuard] : []),
      db
        .prepare("UPDATE actors SET name = ?, updated_at = ? WHERE actor_id = ? AND kind = 'agent'")
        .bind(name, at, target.actor_id),
      eventStatement(
        db,
        {
          eventKey,
          scopeKind: 'inbox',
          scopeId: target.actor_id,
          eventType: 'profile_updated',
          refId: target.actor_id,
          metadata: { actor_id: caller, name },
        },
        at,
      ),
      outboxStatement(db, { topic: inboxTopic(target.actor_id), eventKey }, at),
      inboxHeadStatement(db, target.actor_id, eventKey, at, 0),
    ],
  });

  return result;
}

export interface AgentReissueTokenResult {
  actor_id: string;
  token: string;
  mcp_url: string;
  revoked_count: number;
  issued_at: string;
}

interface AgentReissueTokenStored {
  actor_id: string;
  revoked_count: number;
  issued_at: string;
}

/**
 * 注销目标 Agent 的全部现有凭据并签发新 token。
 *
 * 只有该 Agent 的 active manager 或持有 `manage_agent` 委托的 human 可调用；
 * 权限 guard 与凭据写入在同一事务内执行，因此“撤销委托/停用”和“重发 token”
 * 并发时按提交顺序裁决：失去权限的一方返回 PERMISSION_DENIED。
 *
 * raw token 只存在于本次响应：operations 只保存 actor_id/revoked_count/issued_at。
 * 同一 request_id 重放时 runIdempotent 返回反序列化的结果对象，与本次新建的
 * stored 引用不同，因此可明确拒绝重放而不泄露 token。
 */
export async function reissueAgentToken(
  db: D1Database,
  principal: Principal,
  input: AgentReissueTokenInput,
  origin: string,
): Promise<AgentReissueTokenResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const { target } = await requireManageAgent(db, principal, input.actor_id, at);
  const token = randomToken(32);
  const tokenHash = await hashToken(token);
  const credentialId = newId('cred');
  const active = await db
    .prepare('SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL')
    .bind(target.actor_id)
    .first<{ n: number }>();
  const stored: AgentReissueTokenStored = {
    actor_id: target.actor_id,
    revoked_count: active?.n ?? 0,
    issued_at: String(at),
  };
  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `credential_reissue:${target.actor_id}:${input.request_id}`;
  const versionGuard = managementVersionGuard(
    db,
    target.actor_id,
    input.expected_permission_version,
  );

  const outcome = await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: stored,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      managementPermissionGuard(db, target.actor_id, caller, at),
      ...(versionGuard ? [versionGuard] : []),
      db
        .prepare(
          'UPDATE credentials SET revoked_at = ?, revoked_by = ? WHERE actor_id = ? AND revoked_at IS NULL',
        )
        .bind(at, caller, target.actor_id),
      db
        .prepare(
          `INSERT INTO credentials (credential_id, actor_id, device_id, token_hash, revoked_at, created_at)
           VALUES (?, ?, 'reissue', ?, NULL, ?)`,
        )
        .bind(credentialId, target.actor_id, tokenHash, at),
      ...managementEventStatements(db, {
        eventKey,
        agentId: target.actor_id,
        managerId: caller,
        type: 'credential_reissued',
        metadata: {
          actor_id: target.actor_id,
          revoked_count: stored.revoked_count,
          changed_by: caller,
        },
        at,
        notifyAgent: true,
      }),
    ],
  });

  // 首次写入返回 stored 本身；重放返回 JSON.parse 出的新对象（见上方注释）。
  if (outcome !== stored) {
    throw new BusinessError(
      'TOKEN_NOT_REPLAYABLE',
      '新 token 只在首次响应返回一次；请使用新的 request_id 重新签发',
    );
  }

  const base = origin.replace(/\/+$/u, '');
  return {
    ...stored,
    token,
    mcp_url: `${base}/mcp?token=${encodeURIComponent(token)}`,
  };
}

export async function recoveryCreate(
  db: D1Database,
  principal: Principal,
  input: { request_id: string },
): Promise<{ ticket: string; expires_at: string }> {
  const id = actorId(principal);
  const at = nowMs();
  const ticket = randomToken(32);
  const ticketHash = await hashSecret('ticket', ticket);
  const expiresAt = at + LIMITS.recoveryTicketMs;
  const result = { ticket, expires_at: String(expiresAt) };
  const payloadHash = await sha256Hex(stableStringify(input));

  const stored = (await runIdempotent(db, {
    actorId: id,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, id, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          `INSERT INTO recovery_tickets (ticket_hash, actor_id, expires_at, consumed_at, redeemed_credential_id, redeem_request_id, created_at)
           VALUES (?, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .bind(ticketHash, id, expiresAt, at),
    ],
  })) as { ticket: string; expires_at: string };
  return stored;
}

export async function recoveryRedeem(
  db: D1Database,
  principal: Principal,
  input: { request_id: string; ticket: string; device_id: string },
  origin: string,
): Promise<IdentityView & { recovered: true }> {
  if (!principal.credentialHash) {
    throw new BusinessError('CREDENTIAL_INVALID', '恢复兑换需要 Bearer 凭据；新设备应先本地生成并保存');
  }
  const ticketHash = await hashSecret('ticket', input.ticket);
  const ticket = await db
    .prepare('SELECT * FROM recovery_tickets WHERE ticket_hash = ?')
    .bind(ticketHash)
    .first<RecoveryTicketRow>();
  if (!ticket) throw new BusinessError('RECOVERY_INVALID', '恢复 ticket 不存在');
  const at = nowMs();
  if (ticket.consumed_at !== null) {
    if (ticket.redeem_request_id === input.request_id) {
      const actor = await getActor(db, ticket.actor_id);
      const credential = await getCredentialByHash(db, principal.credentialHash);
      if (actor && credential) {
        return { ...identityView(actor, origin), recovered: true };
      }
    }
    throw new BusinessError('RECOVERY_INVALID', '恢复 ticket 已被使用');
  }
  if (ticket.expires_at <= at) throw new BusinessError('RECOVERY_INVALID', '恢复 ticket 已过期');

  const actor = await getActor(db, ticket.actor_id);
  if (!actor) throw new BusinessError('RECOVERY_INVALID', '恢复目标 actor 不存在');
  if (principal.actor) {
    throw new BusinessError('RECOVERY_INVALID', '当前凭据已注册，不能兑换恢复 ticket');
  }

  const credentialId = newId('cred');
  const result = { actor_id: actor.actor_id };
  const payloadHash = await sha256Hex(stableStringify(input));
  await runIdempotent(db, {
    actorId: actor.actor_id,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, actor.actor_id, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'recoveryInvalid',
            'NOT EXISTS (SELECT 1 FROM recovery_tickets WHERE ticket_hash = ? AND consumed_at IS NULL AND expires_at > ?)',
          ),
        )
        .bind(ticketHash, at),
      db
        .prepare(
          `INSERT INTO credentials (credential_id, actor_id, device_id, token_hash, revoked_at, created_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .bind(credentialId, actor.actor_id, input.device_id, principal.credentialHash, at),
      db
        .prepare(
          `UPDATE recovery_tickets
             SET consumed_at = ?, redeemed_credential_id = ?, redeem_request_id = ?
           WHERE ticket_hash = ?`,
        )
        .bind(at, credentialId, input.request_id, ticketHash),
    ],
  });

  const fresh = await getActor(db, actor.actor_id);
  return { ...identityView(fresh ?? actor, origin), recovered: true };
}

/** 按 agent_session_id 解析 actor；分享页与 contact_add 共用。 */
export async function resolveActorBySession(db: D1Database, sessionId: string): Promise<ActorRow> {
  const actor = await getActorBySession(db, sessionId);
  if (!actor) throw new BusinessError('NOT_FOUND', 'agent_session_id 未注册');
  return actor;
}

export async function resolveCredential(
  db: D1Database,
  tokenHash: string,
): Promise<{ credential: CredentialRow; actor: ActorRow } | null> {
  const credential = await getCredentialByHash(db, tokenHash);
  if (!credential || credential.revoked_at !== null) return null;
  const actor = await getActor(db, credential.actor_id);
  return actor ? { credential, actor } : null;
}

export { registrationResult };

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  AgentClaimCancelInput,
  AgentClaimConfirmInput,
  AgentClaimStartInput,
  AgentCreateInput,
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
import { eventStatement } from '../storage/events';
import { guardSql } from '../storage/guards';
import type { AgentClaimRow } from '../storage/rows';
import { operationsStatement, resolveReplay, runIdempotent } from '../storage/transactions/runner';
import { getActiveManagement } from './agent-access';
import { managementEventStatements } from './agent-management';
import {
  memoryInitialSpaceStatements,
  memoryOwnershipTransferStatements,
} from '../memory/statements';
import type { MemorySpaceRow } from '../memory/rows';
import { normalizeActorName } from './identity';
import { actorId, type Principal } from './principal';
import { hashSecret } from './secrets';

/**
 * A01 生命周期：human 原子创建 Agent；未绑定 Agent 通过自身凭据 + human
 * 一次性 code 完成双端认领。所有 secret（token、claim code）只出现在首次
 * 响应，不写入 operations.result_json。
 */

function claimCodeHash(code: string): Promise<string> {
  return hashSecret('claim', code);
}

export interface AgentCreateResult {
  actor_id: string;
  name: string;
  agent_session_id: string | null;
  share_url: string;
  token: string;
  mcp_url: string;
  issued_at: string;
  management: { binding_id: string; permission_version: number; created_at: string };
}

interface AgentCreateStored {
  actor_id: string;
  name: string;
  agent_session_id: string | null;
  share_url: string;
  issued_at: string;
  management: { binding_id: string; permission_version: number; created_at: string };
}

/**
 * 原子创建 Agent、管理绑定与初始凭据。
 *
 * 只有已注册 human 可调用；新 token 由服务端生成，只在首次响应出现。
 * 同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE，不重放 token。
 */
export async function createAgent(
  db: D1Database,
  principal: Principal,
  input: AgentCreateInput,
  origin: string,
): Promise<AgentCreateResult> {
  const caller = principal.actor;
  if (!caller) throw new BusinessError('CREDENTIAL_INVALID', '当前凭据尚未注册');
  if (caller.kind !== 'human') {
    throw new BusinessError('PERMISSION_DENIED', '只有 human 身份可以创建并管理 Agent');
  }
  if (input.metadata && utf8Bytes(JSON.stringify(input.metadata)) > LIMITS.actorMetadataBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', 'actor metadata 超过 4 KiB');
  }
  const name = normalizeActorName(input.name);
  const at = nowMs();
  const agentId = newId('agt');
  const sessionId =
    input.agent_session_id ?? `sess_${crypto.randomUUID().replace(/-/g, '')}`;
  const token = randomToken(32);
  const tokenHash = await hashToken(token);
  const credentialId = newId('cred');
  const bindingId = newId('amb');
  const base = origin.replace(/\/+$/u, '');
  const mcpUrl = `${base}/mcp?token=${encodeURIComponent(token)}`;
  const share = `${base}/a/${encodeURIComponent(sessionId)}`;
  const stored: AgentCreateStored = {
    actor_id: agentId,
    name,
    agent_session_id: sessionId,
    share_url: share,
    issued_at: String(at),
    management: { binding_id: bindingId, permission_version: 1, created_at: String(at) },
  };
  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `agent_create:${agentId}`;

  const outcome = await runIdempotent(db, {
    actorId: caller.actor_id,
    requestId: input.request_id,
    payloadHash,
    result: stored,
    build: (resultJson) => [
      operationsStatement(db, caller.actor_id, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(guardSql('actorExists', 'EXISTS (SELECT 1 FROM actors WHERE actor_id = ?)'))
        .bind(agentId),
      db
        .prepare(
          guardSql(
            'actorExists',
            'EXISTS (SELECT 1 FROM actors WHERE agent_session_id = ?)',
          ),
        )
        .bind(sessionId),
      db
        .prepare(
          `INSERT INTO actors
             (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
              pending_count, created_at, updated_at)
           VALUES (?, 'agent', ?, ?, ?, 0, 0, 0, ?, ?)`,
        )
        .bind(
          agentId,
          sessionId,
          name,
          JSON.stringify(input.metadata ?? {}),
          at,
          at,
        ),
      db
        .prepare(
          `INSERT INTO credentials (credential_id, actor_id, device_id, token_hash, revoked_at, created_at)
           VALUES (?, ?, 'created', ?, NULL, ?)`,
        )
        .bind(credentialId, agentId, tokenHash, at),
      db
        .prepare(
          `INSERT INTO agent_managements
             (binding_id, agent_id, manager_id, status, grant_source, scopes_json, permission_version,
              initiated_by, confirmed_by, created_at, confirmed_at, expires_at, revoked_at, revoked_by, updated_at)
           VALUES (?, ?, ?, 'active', 'created', '[]', 1, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .bind(bindingId, agentId, caller.actor_id, caller.actor_id, caller.actor_id, at, at, at),
      ...memoryInitialSpaceStatements(db, {
        spaceId: newId('msp'),
        transitionId: newId('mtr'),
        instanceId: newId('mni'),
        agentId,
        ownerActorId: caller.actor_id,
        ownershipKind: 'managed',
        managementBindingId: bindingId,
        now: at,
      }),
      ...managementEventStatements(db, {
        eventKey,
        agentId,
        managerId: caller.actor_id,
        type: 'agent_management_bound',
        metadata: { manager_id: caller.actor_id, grant_source: 'created', permission_version: 1 },
        at,
        notifyAgent: false,
      }),
    ],
  });

  if (outcome !== stored) {
    throw new BusinessError(
      'TOKEN_NOT_REPLAYABLE',
      '新 Agent token 只在首次响应返回一次；请使用新的 request_id 重新创建',
    );
  }
  return { ...stored, token, mcp_url: mcpUrl };
}

export interface AgentClaimStartResult {
  claim_id: string;
  agent_id: string;
  code: string;
  expires_at: string;
  max_attempts: number;
}

interface AgentClaimStartStored {
  claim_id: string;
  agent_id: string;
  expires_at: string;
  max_attempts: number;
}

/**
 * Agent 用自身凭据发起认领，生成一次性 code。
 *
 * code 原文只在首次响应出现，服务端只保存 SHA-256；human 必须在另一端
 * 用 code 确认。只有 unclaimed Agent 可发起，已绑定 Agent 需走交接。
 */
export async function agentClaimStart(
  db: D1Database,
  principal: Principal,
  input: AgentClaimStartInput,
): Promise<AgentClaimStartResult> {
  const caller = principal.actor;
  if (!caller) throw new BusinessError('CREDENTIAL_INVALID', '当前凭据尚未注册');
  if (caller.kind !== 'agent') {
    throw new BusinessError('PERMISSION_DENIED', '只有 Agent 自身可以发起认领');
  }
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller.actor_id, input.request_id, payloadHash);
  if (replay.found) {
    // claim code 是只出现一次的 secret，和 token 一样不能由重放取回。
    throw new BusinessError(
      'TOKEN_NOT_REPLAYABLE',
      '认领码只在首次响应返回一次；请使用新的 request_id 重新发起',
    );
  }
  const existing = await getActiveManagement(db, caller.actor_id);
  if (existing) {
    throw new BusinessError('CLAIM_CONFLICT', '该 Agent 已有管理者，只能通过管理权交接变更', {
      actor_id: caller.actor_id,
    });
  }
  const pending = await db
    .prepare("SELECT * FROM agent_claims WHERE agent_id = ? AND status = 'pending'")
    .bind(caller.actor_id)
    .first<AgentClaimRow>();
  if (pending) {
    throw new BusinessError('CLAIM_CONFLICT', '已有待确认的认领；先取消或等待过期', {
      claim_id: pending.claim_id,
    });
  }
  const ttl = Math.min(
    input.expires_in_ms ?? LIMITS.agentClaimTtlMs,
    LIMITS.agentClaimTtlMs,
  );
  const code = randomToken(24);
  const claimId = newId('acl');
  const expiresAt = at + ttl;
  const stored: AgentClaimStartStored = {
    claim_id: claimId,
    agent_id: caller.actor_id,
    expires_at: String(expiresAt),
    max_attempts: LIMITS.agentClaimMaxAttempts,
  };
  const eventKey = `agent_claim:${claimId}`;
  const codeHash = await claimCodeHash(code);

  const outcome = await runIdempotent(db, {
    actorId: caller.actor_id,
    requestId: input.request_id,
    payloadHash,
    result: stored,
    build: (resultJson) => [
      operationsStatement(db, caller.actor_id, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'claimConflict',
            `EXISTS (SELECT 1 FROM agent_managements WHERE agent_id = ? AND status = 'active')
             OR EXISTS (SELECT 1 FROM agent_claims WHERE agent_id = ? AND status = 'pending')`,
          ),
        )
        .bind(caller.actor_id, caller.actor_id),
      db
        .prepare(
          `INSERT INTO agent_claims
             (claim_id, agent_id, claim_code_hash, status, attempts, max_attempts,
              created_at, expires_at, confirmed_by, confirmed_at, updated_at)
           VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, NULL, NULL, ?)`,
        )
        .bind(
          claimId,
          caller.actor_id,
          codeHash,
          LIMITS.agentClaimMaxAttempts,
          at,
          expiresAt,
          at,
        ),
      eventStatement(
        db,
        {
          eventKey: `${eventKey}:audit`,
          scopeKind: 'actor',
          scopeId: caller.actor_id,
          eventType: 'agent_claim_requested',
          refId: claimId,
          metadata: { agent_id: caller.actor_id, expires_at: expiresAt },
        },
        at,
      ),
    ],
  });

  if (outcome !== stored) {
    throw new BusinessError(
      'TOKEN_NOT_REPLAYABLE',
      '认领码只在首次响应返回一次；请使用新的 request_id 重新发起',
    );
  }
  return { ...stored, code };
}

export interface AgentClaimConfirmResult {
  claim_id: string;
  agent_id: string;
  manager_id: string;
  binding_id: string;
  permission_version: number;
  confirmed_at: string;
}

/** human 用一次性 code 完成双端认领；单端请求不能绑定管理者。 */
export async function agentClaimConfirm(
  db: D1Database,
  principal: Principal,
  input: AgentClaimConfirmInput,
): Promise<AgentClaimConfirmResult> {
  const caller = principal.actor;
  if (!caller) throw new BusinessError('CREDENTIAL_INVALID', '当前凭据尚未注册');
  if (caller.kind !== 'human') {
    throw new BusinessError('PERMISSION_DENIED', '只有 human 身份可以确认认领');
  }
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller.actor_id, input.request_id, payloadHash);
  if (replay.found) return replay.result as AgentClaimConfirmResult;
  const claim = await db
    .prepare('SELECT * FROM agent_claims WHERE claim_id = ?')
    .bind(input.claim_id)
    .first<AgentClaimRow>();
  if (!claim) throw new BusinessError('NOT_FOUND', '认领记录不存在');
  if (claim.status !== 'pending') {
    throw new BusinessError('CLAIM_CONFLICT', '认领已结束，不能再次确认', {
      claim_id: claim.claim_id,
      status: claim.status,
    });
  }
  if (claim.expires_at <= at) {
    await db
      .prepare(
        "UPDATE agent_claims SET status = 'expired', updated_at = ? WHERE claim_id = ? AND status = 'pending'",
      )
      .bind(at, claim.claim_id)
      .run();
    throw new BusinessError('REQUEST_EXPIRED', '认领码已过期，请让 Agent 重新发起', {
      claim_id: claim.claim_id,
    });
  }
  const expected = await claimCodeHash(input.code);
  if (expected !== claim.claim_code_hash) {
    const attempts = claim.attempts + 1;
    const rejected = attempts >= claim.max_attempts;
    await db
      .prepare(
        `UPDATE agent_claims
            SET attempts = ?, status = ?, updated_at = ?
          WHERE claim_id = ? AND status = 'pending'`,
      )
      .bind(attempts, rejected ? 'rejected' : 'pending', at, claim.claim_id)
      .run();
    if (rejected) {
      await db
        .prepare(
          `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
           VALUES ('actor', ?, 'agent_claim_rejected', ?, ?, ?, ?)`,
        )
        .bind(
          claim.agent_id,
          claim.claim_id,
          JSON.stringify({ agent_id: claim.agent_id, attempts }),
          `agent_claim_rejected:${claim.claim_id}`,
          at,
        )
        .run();
      throw new BusinessError('PERMISSION_DENIED', '认领码错误次数已达到上限，认领已拒绝', {
        claim_id: claim.claim_id,
      });
    }
    throw new BusinessError('PERMISSION_DENIED', '认领码不正确', {
      claim_id: claim.claim_id,
      attempts,
    });
  }
  const existing = await getActiveManagement(db, claim.agent_id);
  if (existing) {
    throw new BusinessError('CLAIM_CONFLICT', '该 Agent 已有管理者，只能通过管理权交接变更', {
      actor_id: claim.agent_id,
    });
  }
  const bindingId = newId('amb');
  const previousSpace = await db
    .prepare('SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1')
    .bind(claim.agent_id)
    .first<MemorySpaceRow>();
  const eventKey = `agent_claim_confirm:${claim.claim_id}`;
  const result: AgentClaimConfirmResult = {
    claim_id: claim.claim_id,
    agent_id: claim.agent_id,
    manager_id: caller.actor_id,
    binding_id: bindingId,
    permission_version: 1,
    confirmed_at: String(at),
  };

  await runIdempotent(db, {
    actorId: caller.actor_id,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller.actor_id, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'requestExpired',
            "NOT EXISTS (SELECT 1 FROM agent_claims WHERE claim_id = ? AND status = 'pending' AND expires_at > ?)",
          ),
        )
        .bind(claim.claim_id, at),
      db
        .prepare(
          guardSql(
            'claimConflict',
            `EXISTS (SELECT 1 FROM agent_managements WHERE agent_id = ? AND status = 'active')
             OR EXISTS (SELECT 1 FROM actors WHERE actor_id = ? AND kind <> 'agent')`,
          ),
        )
        .bind(claim.agent_id, claim.agent_id),
      db
        .prepare(
          `UPDATE agent_claims
              SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, attempts = attempts + 1,
                  updated_at = ?
            WHERE claim_id = ? AND status = 'pending'`,
        )
        .bind(caller.actor_id, at, at, claim.claim_id),
      db
        .prepare(
          `INSERT INTO agent_managements
             (binding_id, agent_id, manager_id, status, grant_source, scopes_json, permission_version,
              initiated_by, confirmed_by, created_at, confirmed_at, expires_at, revoked_at, revoked_by, updated_at)
           VALUES (?, ?, ?, 'active', 'claim', '[]', 1, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
        )
        .bind(
          bindingId,
          claim.agent_id,
          caller.actor_id,
          claim.agent_id,
          caller.actor_id,
          at,
          at,
          at,
        ),
      ...memoryOwnershipTransferStatements(db, {
        previous: previousSpace,
        nextSpaceId: newId('msp'),
        transitionId: newId('mtr'),
        instanceId: newId('mni'),
        agentId: claim.agent_id,
        ownerActorId: caller.actor_id,
        ownershipKind: 'managed',
        managementBindingId: bindingId,
        kind: 'initial_claim',
        now: at,
      }),
      ...managementEventStatements(db, {
        eventKey,
        agentId: claim.agent_id,
        managerId: caller.actor_id,
        type: 'agent_claim_confirmed',
        metadata: {
          claim_id: claim.claim_id,
          manager_id: caller.actor_id,
          permission_version: 1,
        },
        at,
        notifyAgent: true,
      }),
    ],
  });
  return result;
}

/** Agent 取消自己尚未确认的认领；code 立即失效。 */
export async function agentClaimCancel(
  db: D1Database,
  principal: Principal,
  input: AgentClaimCancelInput,
): Promise<{ claim_id: string; status: 'cancelled' }> {
  const caller = actorId(principal);
  const claim = await db
    .prepare('SELECT * FROM agent_claims WHERE claim_id = ?')
    .bind(input.claim_id)
    .first<AgentClaimRow>();
  if (!claim) throw new BusinessError('NOT_FOUND', '认领记录不存在');
  if (claim.agent_id !== caller) {
    throw new BusinessError('PERMISSION_DENIED', '只有发起认领的 Agent 可以取消');
  }
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) {
    return replay.result as { claim_id: string; status: 'cancelled' };
  }
  if (claim.status !== 'pending') {
    throw new BusinessError('CLAIM_CONFLICT', '认领已结束，不能取消', {
      claim_id: claim.claim_id,
      status: claim.status,
    });
  }
  const result = { claim_id: claim.claim_id, status: 'cancelled' as const };
  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'claimConflict',
            "NOT EXISTS (SELECT 1 FROM agent_claims WHERE claim_id = ? AND agent_id = ? AND status = 'pending')",
          ),
        )
        .bind(claim.claim_id, caller),
      db
        .prepare(
          "UPDATE agent_claims SET status = 'cancelled', updated_at = ? WHERE claim_id = ? AND status = 'pending'",
        )
        .bind(at, claim.claim_id),
    ],
  });
  return result;
}

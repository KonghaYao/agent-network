import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  AgentTransferCancelInput,
  AgentTransferProposeInput,
  AgentTransferRespondInput,
} from '../contracts/schemas';
import { hashToken, newId, nowMs, randomToken, sha256Hex, stableStringify } from '../storage/db';
import { eventStatement } from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor } from '../storage/queries';
import {
  operationsStatement,
  resolveReplay,
  runIdempotent,
} from '../storage/transactions/runner';
import {
  getActiveManagement,
  requireAgentTarget,
  requireManageAgent,
} from './agent-access';
import {
  contextView,
  expireAgentTransfers,
  getTransferRow,
  lifecycleStatements,
  parseContext,
  requireValidSuccessor,
  transferInboxStatements,
  workloadSnapshot,
  type AgentTransferAcceptedResult,
  type AgentTransferSimpleResult,
  type AgentTransferView,
  type TransferContextStored,
} from './agent-transfer-store';
import { memoryOwnershipTransferStatements } from '../memory/statements';
import type { MemorySpaceRow } from '../memory/rows';
import { actorId, type Principal } from './principal';

/**
 * A06 Agent 管理权交接的写路径。
 *
 * 只有 active manager 可发起；只有指定接任者可接受/拒绝。接受事务原子完成
 * 管理权切换、权限版本递增、旧委托/旧凭据撤销、运行 token 轮换与任务失权。
 */
export async function agentTransferPropose(
  db: D1Database,
  principal: Principal,
  input: AgentTransferProposeInput,
): Promise<AgentTransferView> {
  const caller = actorId(principal);
  const at = nowMs();
  const { target, access } = await requireManageAgent(db, principal, input.actor_id, at);
  const management = access.management;
  if (access.role !== 'manager' || !management || management.manager_id !== caller) {
    throw new BusinessError('PERMISSION_DENIED', '只有当前管理者可以发起管理权交接');
  }
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) return replay.result as AgentTransferView;

  const successor = requireValidSuccessor(
    await getActor(db, input.to_manager_id),
    caller,
    target.actor_id,
  );
  const credential = await db
    .prepare('SELECT 1 AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL LIMIT 1')
    .bind(successor.actor_id)
    .first<{ n: number }>();
  if (!credential) {
    throw new BusinessError('INVALID_ARGUMENT', '接任者没有有效凭据');
  }

  await expireAgentTransfers(db, target.actor_id, at);
  const existing = await db
    .prepare(
      "SELECT transfer_id FROM agent_management_transfers WHERE agent_id = ? AND status = 'pending'",
    )
    .bind(target.actor_id)
    .first<{ transfer_id: string }>();
  if (existing) {
    throw new BusinessError('CLAIM_CONFLICT', '该 Agent 已有待确认的管理权交接', {
      transfer_id: existing.transfer_id,
    });
  }

  const ttl = input.expires_in_ms ?? LIMITS.agentTransferTtlMs;
  const expiresAt = at + ttl;
  const transferId = newId('atf');
  const snapshot = await workloadSnapshot(db, target.actor_id, at);
  const storedContext: TransferContextStored = {
    note: input.note,
    proposed_by: caller,
    snapshot,
  };
  const eventKey = `management_transfer_proposed:${transferId}`;
  const result: AgentTransferView = {
    transfer_id: transferId,
    agent_id: target.actor_id,
    agent_name: target.name,
    from_manager_id: caller,
    from_manager_name: principal.actor?.name ?? '',
    to_manager_id: successor.actor_id,
    to_manager_name: successor.name,
    status: 'pending',
    from_permission_version: management.permission_version,
    expires_at: String(expiresAt),
    created_at: String(at),
    responded_at: null,
    responded_by: null,
    context: contextView(JSON.stringify(storedContext)),
    can_accept: false,
    can_reject: false,
    can_cancel: true,
  };

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
            'permissionDenied',
            `NOT EXISTS (
               SELECT 1 FROM agent_managements
                WHERE agent_id = ? AND status = 'active' AND manager_id = ?
             )`,
          ),
        )
        .bind(target.actor_id, caller),
      db
        .prepare(
          guardSql(
            'permissionDenied',
            `NOT EXISTS (
               SELECT 1 FROM actors
                WHERE actor_id = ? AND kind = 'human'
                  AND disabled_at IS NULL AND archived_at IS NULL
             )`,
          ),
        )
        .bind(successor.actor_id),
      db
        .prepare(
          guardSql(
            'versionConflict',
            `NOT EXISTS (
               SELECT 1 FROM agent_managements
                WHERE agent_id = ? AND status = 'active' AND manager_id = ?
                  AND permission_version = ?
             )`,
          ),
        )
        .bind(target.actor_id, caller, management.permission_version),
      db
        .prepare(
          guardSql(
            'permissionDenied',
            `NOT EXISTS (
               SELECT 1 FROM credentials
                WHERE actor_id = ? AND revoked_at IS NULL
             )`,
          ),
        )
        .bind(successor.actor_id),
      db
        .prepare(
          guardSql(
            'claimConflict',
            "EXISTS (SELECT 1 FROM agent_management_transfers WHERE agent_id = ? AND status = 'pending')",
          ),
        )
        .bind(target.actor_id),
      db
        .prepare(
          `INSERT INTO agent_management_transfers
             (transfer_id, agent_id, from_manager_id, to_manager_id, status,
              from_permission_version, context_json, created_by, created_at, expires_at,
              responded_at, responded_by, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, ?)`,
        )
        .bind(
          transferId,
          target.actor_id,
          caller,
          successor.actor_id,
          management.permission_version,
          JSON.stringify(storedContext),
          caller,
          at,
          expiresAt,
          at,
        ),
      ...lifecycleStatements(db, {
        agentId: target.actor_id,
        transferId,
        eventKey,
        type: 'management_transfer_proposed',
        aliasType: 'agent_transfer_proposed',
        fromManagerId: caller,
        toManagerId: successor.actor_id,
        metadata: {
          changed_by: caller,
          expires_at: String(expiresAt),
          context: snapshot,
        },
        at,
      }),
    ],
  });
  return result;
}

/**
 * 接受：原子切换管理权、撤销旧委托/旧凭据、轮换运行 token 并撤销任务资格。
 *
 * 新 token 不进入 `operations.result_json`；同一 `request_id` 重放返回同一
 * 非秘密结果（token/mcp_url 为 null），不会再次轮换。
 */
export async function agentTransferRespond(
  db: D1Database,
  principal: Principal,
  input: AgentTransferRespondInput,
  origin: string,
  hooks: {
    onAccepted?: (info: {
      agentId: string;
      revokedCredentialIds: string[];
    }) => void;
  } = {},
): Promise<AgentTransferAcceptedResult | AgentTransferSimpleResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const row = await getTransferRow(db, input.transfer_id);
  if (!row || row.to_manager_id !== caller) {
    throw new BusinessError('NOT_FOUND', '交接提议不存在或不属于当前身份');
  }
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) {
    return replay.result as AgentTransferAcceptedResult | AgentTransferSimpleResult;
  }
  if (row.status !== 'pending') {
    throw new BusinessError('CONFLICT', '交接提议状态已变化，请刷新后重试', {
      current_state: row.status,
    });
  }
  if (row.expires_at <= at) {
    await expireAgentTransfers(db, row.agent_id, at);
    throw new BusinessError('REQUEST_EXPIRED', '管理权交接提议已过期', {
      transfer_id: row.transfer_id,
    });
  }

  if (input.decision === 'reject') {
    const result: AgentTransferSimpleResult = {
      transfer_id: row.transfer_id,
      agent_id: row.agent_id,
      status: 'rejected',
      responded_at: String(at),
    };
    const context = parseContext(row.context_json);
    const eventKey = `management_transfer_rejected:${row.transfer_id}:${input.request_id}`;
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
              `NOT EXISTS (
                 SELECT 1 FROM agent_management_transfers
                  WHERE transfer_id = ? AND status = 'pending' AND to_manager_id = ?
                    AND expires_at > ?
               )`,
            ),
          )
          .bind(row.transfer_id, caller, at),
        db
          .prepare(
            `UPDATE agent_management_transfers
                SET status = 'rejected', responded_at = ?, responded_by = ?, context_json = ?,
                    updated_at = ?
              WHERE transfer_id = ? AND status = 'pending' AND to_manager_id = ?`,
          )
          .bind(
            at,
            caller,
            JSON.stringify({ ...context, response_note: input.note }),
            at,
            row.transfer_id,
            caller,
          ),
        ...lifecycleStatements(db, {
          agentId: row.agent_id,
          transferId: row.transfer_id,
          eventKey,
          type: 'management_transfer_rejected',
          aliasType: 'agent_transfer_rejected',
          fromManagerId: row.from_manager_id,
          toManagerId: row.to_manager_id,
          metadata: { changed_by: caller, reason: 'rejected' },
          at,
        }),
      ],
    });
    return result;
  }

  // 接受前重新校验接任者与当前管理关系；真正的并发裁决由事务 guard 完成。
  const successor = requireValidSuccessor(principal.actor, row.from_manager_id, row.agent_id);
  const management = await getActiveManagement(db, row.agent_id);
  if (!management) {
    throw new BusinessError('CONFLICT', '该 Agent 已没有有效管理关系');
  }
  if (management.manager_id !== row.from_manager_id) {
    throw new BusinessError('CONFLICT', '原管理者已变化，交接提议已失效');
  }
  if (management.permission_version !== row.from_permission_version) {
    throw new BusinessError('VERSION_CONFLICT', '管理权限版本已变化，请刷新后重试', {
      expected: row.from_permission_version,
      actual: management.permission_version,
    });
  }
  const agent = await requireAgentTarget(db, row.agent_id);

  const pendingCredentialIds = await db
    .prepare(
      'SELECT credential_id FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
    )
    .bind(agent.actor_id)
    .all<{ credential_id: string }>();
  const revokedCredentialIds = pendingCredentialIds.results.map((item) => item.credential_id);
  const before = await workloadSnapshot(db, agent.actor_id, at);

  const token = randomToken(32);
  const tokenHash = await hashToken(token);
  const credentialId = newId('cred');
  const nextPermissionVersion = management.permission_version + 1;
  const stored: AgentTransferAcceptedResult = {
    transfer_id: row.transfer_id,
    agent_id: agent.actor_id,
    from_manager_id: row.from_manager_id,
    to_manager_id: successor.actor_id,
    status: 'accepted',
    permission_version: nextPermissionVersion,
    accepted_at: String(at),
    revoked_delegations: before.delegation_count,
    revoked_credentials: revokedCredentialIds.length,
    cancelled_pending_deliveries: 0,
    cancelled_claimed_deliveries: 0,
    token: null,
    mcp_url: null,
  };
  const context = parseContext(row.context_json);
  const acceptedContext: TransferContextStored = {
    ...context,
    response_note: input.note,
    accepted_snapshot: {
      permission_version: nextPermissionVersion,
      revoked_delegations: stored.revoked_delegations,
      revoked_credentials: stored.revoked_credentials,
      cancelled_pending_deliveries: stored.cancelled_pending_deliveries,
      cancelled_claimed_deliveries: stored.cancelled_claimed_deliveries,
    },
  };
  const eventKey = `management_transfer_accepted:${row.transfer_id}:${input.request_id}`;
  const previousSpace = await db
    .prepare('SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1')
    .bind(agent.actor_id)
    .first<MemorySpaceRow>();

  const outcome = await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result: stored,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'claimConflict',
            `NOT EXISTS (
               SELECT 1 FROM agent_management_transfers
                WHERE transfer_id = ? AND status = 'pending' AND to_manager_id = ?
                  AND expires_at > ?
             )`,
          ),
        )
        .bind(row.transfer_id, caller, at),
      db
        .prepare(
          guardSql(
            'versionConflict',
            `NOT EXISTS (
               SELECT 1 FROM agent_managements
                WHERE agent_id = ? AND status = 'active'
                  AND manager_id = ? AND permission_version = ?
             )`,
          ),
        )
        .bind(row.agent_id, row.from_manager_id, row.from_permission_version),
      db
        .prepare(
          guardSql(
            'permissionDenied',
            `NOT EXISTS (
               SELECT 1 FROM actors a
                WHERE a.actor_id = ? AND a.kind = 'human'
                  AND a.disabled_at IS NULL AND a.archived_at IS NULL
                  AND EXISTS (
                    SELECT 1 FROM credentials c
                     WHERE c.actor_id = a.actor_id AND c.revoked_at IS NULL)
             )`,
          ),
        )
        .bind(successor.actor_id),
      db
        .prepare(
          `UPDATE agent_managements
              SET manager_id = ?, permission_version = permission_version + 1,
                  grant_source = 'transfer', confirmed_by = ?, confirmed_at = ?,
                  updated_at = ?
            WHERE agent_id = ? AND status = 'active'
              AND manager_id = ? AND permission_version = ?`,
        )
        .bind(
          successor.actor_id,
          caller,
          at,
          at,
          row.agent_id,
          row.from_manager_id,
          row.from_permission_version,
        ),
      db
        .prepare(
          `UPDATE agent_delegations
              SET status = 'revoked', revoked_at = ?, revoked_by = ?,
                  permission_version = permission_version + 1, updated_at = ?
            WHERE agent_id = ? AND status = 'active'`,
        )
        .bind(at, caller, at, row.agent_id),
      db
        .prepare(
          'UPDATE credentials SET revoked_at = ?, revoked_by = ? WHERE actor_id = ? AND revoked_at IS NULL',
        )
        .bind(at, caller, agent.actor_id),
      db
        .prepare(
          `INSERT INTO credentials (credential_id, actor_id, device_id, token_hash, revoked_at, created_at)
           VALUES (?, ?, 'management_transfer', ?, NULL, ?)`,
        )
        .bind(credentialId, agent.actor_id, tokenHash, at),
      db
        .prepare(
          `UPDATE agent_management_transfers
              SET status = 'accepted', responded_at = ?, responded_by = ?, context_json = ?,
                  updated_at = ?
            WHERE transfer_id = ? AND status = 'pending' AND to_manager_id = ?`,
        )
        .bind(at, caller, JSON.stringify(acceptedContext), at, row.transfer_id, caller),
      ...memoryOwnershipTransferStatements(db, {
        previous: previousSpace,
        nextSpaceId: newId('msp'),
        transitionId: newId('mtr'),
        instanceId: newId('mni'),
        agentId: agent.actor_id,
        ownerActorId: successor.actor_id,
        ownershipKind: 'managed',
        managementBindingId: management.binding_id,
        kind: 'management_transfer',
        now: at,
      }),
      ...lifecycleStatements(db, {
        agentId: agent.actor_id,
        transferId: row.transfer_id,
        eventKey,
        type: 'management_transfer_accepted',
        aliasType: 'agent_transfer_accepted',
        fromManagerId: row.from_manager_id,
        toManagerId: successor.actor_id,
        metadata: {
          changed_by: caller,
          permission_version: nextPermissionVersion,
          revoked_delegations: stored.revoked_delegations,
          revoked_credentials: stored.revoked_credentials,
          cancelled_pending_deliveries: stored.cancelled_pending_deliveries,
          cancelled_claimed_deliveries: stored.cancelled_claimed_deliveries,
        },
        at,
      }),
      eventStatement(
        db,
        {
          eventKey: `${eventKey}:transferred`,
          scopeKind: 'actor',
          scopeId: agent.actor_id,
          eventType: 'management_transferred',
          refId: row.transfer_id,
          metadata: {
            agent_id: agent.actor_id,
            transfer_id: row.transfer_id,
            from_manager_id: row.from_manager_id,
            to_manager_id: successor.actor_id,
            permission_version: nextPermissionVersion,
            changed_by: caller,
            changed_scope: 'agent_management',
          },
        },
        at,
      ),
      eventStatement(
        db,
        {
          eventKey: `${eventKey}:credential`,
          scopeKind: 'actor',
          scopeId: agent.actor_id,
          eventType: 'credential_rotated',
          refId: agent.actor_id,
          metadata: {
            agent_id: agent.actor_id,
            transfer_id: row.transfer_id,
            revoked_count: revokedCredentialIds.length,
            changed_by: caller,
            new_manager_id: successor.actor_id,
          },
        },
        at,
      ),
      ...transferInboxStatements(
        db,
        {
          actor: successor.actor_id,
          eventType: 'credential_rotated',
          eventKey: `${eventKey}:credential:inbox:${successor.actor_id}`,
          agentId: agent.actor_id,
          transferId: row.transfer_id,
          metadata: { changed_by: caller, revoked_count: revokedCredentialIds.length },
        },
        at,
      ),
    ],
  });

  if (outcome !== stored) {
    // 重放不再次轮换，也不再次关闭接任者用新 token 建立的新连接。
    const replayed = outcome as AgentTransferAcceptedResult;
    return { ...replayed, token: null, mcp_url: null };
  }

  hooks.onAccepted?.({
    agentId: agent.actor_id,
    revokedCredentialIds,
  });
  const base = origin.replace(/\/+$/u, '');
  return {
    ...stored,
    token,
    mcp_url: `${base}/mcp?token=${encodeURIComponent(token)}`,
  };
}

/** 发起人取消 pending；不改变管理权、委托、凭据或任务。 */
export async function agentTransferCancel(
  db: D1Database,
  principal: Principal,
  input: AgentTransferCancelInput,
): Promise<AgentTransferSimpleResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const row = await getTransferRow(db, input.transfer_id);
  if (!row || row.from_manager_id !== caller) {
    throw new BusinessError('NOT_FOUND', '交接提议不存在或不属于当前身份');
  }
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) return replay.result as AgentTransferSimpleResult;
  if (row.status !== 'pending') {
    throw new BusinessError('CONFLICT', '交接提议状态已变化，请刷新后重试', {
      current_state: row.status,
    });
  }
  if (row.expires_at <= at) {
    await expireAgentTransfers(db, row.agent_id, at);
    throw new BusinessError('REQUEST_EXPIRED', '管理权交接提议已过期', {
      transfer_id: row.transfer_id,
    });
  }
  const result: AgentTransferSimpleResult = {
    transfer_id: row.transfer_id,
    agent_id: row.agent_id,
    status: 'cancelled',
    responded_at: String(at),
  };
  const context = parseContext(row.context_json);
  const eventKey = `management_transfer_cancelled:${row.transfer_id}:${input.request_id}`;
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
            `NOT EXISTS (
               SELECT 1 FROM agent_management_transfers
                WHERE transfer_id = ? AND status = 'pending' AND from_manager_id = ?
                  AND expires_at > ?
             )`,
          ),
        )
        .bind(row.transfer_id, caller, at),
      db
        .prepare(
          `UPDATE agent_management_transfers
              SET status = 'cancelled', responded_at = ?, responded_by = ?, context_json = ?,
                  updated_at = ?
            WHERE transfer_id = ? AND status = 'pending' AND from_manager_id = ?`,
        )
        .bind(
          at,
          caller,
          JSON.stringify({ ...context, response_note: input.note }),
          at,
          row.transfer_id,
          caller,
        ),
      ...lifecycleStatements(db, {
        agentId: row.agent_id,
        transferId: row.transfer_id,
        eventKey,
        type: 'management_transfer_cancelled',
        aliasType: 'agent_transfer_cancelled',
        fromManagerId: row.from_manager_id,
        toManagerId: row.to_manager_id,
        metadata: { changed_by: caller, reason: 'cancelled' },
        at,
      }),
    ],
  });
  return result;
}

/** 读取单个提议；不可见时按不存在处理，避免泄露他人的交接。 */

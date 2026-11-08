import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { LIMITS } from '../contracts/limits';
import type {
  AgentDelegateGrantInput,
  AgentDelegateRevokeInput,
  AgentDisableInput,
  AgentEnableInput,
  AgentsManagedListInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, stableStringify, utf8Bytes } from '../storage/db';
import {
  eventStatement,
  inboxHeadStatement,
  inboxTopic,
  outboxStatement,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { getActor } from '../storage/queries';
import type { ActorRow, AgentDelegationRow } from '../storage/rows';
import { operationsStatement, resolveReplay, runIdempotent } from '../storage/transactions/runner';
import {
  MANAGE_AGENT_SCOPE,
  managementAccess,
  managementPermissionGuard,
  managementVersionGuard,
  parseScopes,
  requireAgentTarget,
  requireManageAgent,
  scopesJson,
} from './agent-access';
import { actorId, type Principal } from './principal';
import { revokeTaskEligibilityStatements } from './task-transfers';

/**
 * A01 身份归属与管理授权。
 *
 * - 创建：human 凭据原子创建 Agent + active management + 初始 credential；
 * - 管理：rename/archive/reissue/disable 只允许 active manager 或
 *   scope `manage_agent` 的 delegate；
 * - 认领：未绑定 Agent 由自身凭据发起一次性 code，human 在另一端确认；
 * - 停用：与归档正交，撤销委托与在途投递，保留任务为可见的待处理状态；
 * - 所有写操作在同一 `db.batch()` 内重放权限 guard 与权限版本 guard。
 */

const CONTROL_CHARS = /[\u0000-\u001F\u007F\u2028\u2029]/u;

export interface OpenTaskView {
  task_id: string;
  room_id: string;
  description: string;
  status: 'pending' | 'claimed';
  updated_at: string;
}

export interface PendingWorkView {
  pending_deliveries: number;
  claimed_deliveries: number;
  cancelled_deliveries: number;
  open_tasks: OpenTaskView[];
  open_task_count: number;
}

export async function pendingWork(db: D1Database, agentId: string): Promise<PendingWorkView> {
  const states = await db
    .prepare(
      'SELECT state, COUNT(*) AS n FROM deliveries WHERE recipient_id = ? GROUP BY state',
    )
    .bind(agentId)
    .all<{ state: string; n: number }>();
  const count = (state: string): number =>
    states.results.find((row) => row.state === state)?.n ?? 0;
  const tasks = await db
    .prepare(
      `SELECT t.task_id,
              t.room_id,
              t.title AS description,
              CASE WHEN t.owner_actor_id IS NULL THEN 'pending' ELSE 'claimed' END AS status,
              t.updated_at
         FROM tasks t
        WHERE (t.owner_actor_id = ? AND t.status IN ('in_progress', 'blocked', 'submitted'))
           OR (t.owner_actor_id IS NULL AND t.status = 'offered' AND EXISTS (
                 SELECT 1 FROM task_assignments a
                  WHERE a.task_id = t.task_id
                    AND a.owner_actor_id = ?
                    AND a.status = 'offered'))
        ORDER BY t.updated_at DESC, t.task_id ASC`,
    )
    .bind(agentId, agentId)
    .all<{
      task_id: string;
      room_id: string;
      description: string;
      status: 'pending' | 'claimed';
      updated_at: number;
    }>();
  return {
    pending_deliveries: count('pending'),
    claimed_deliveries: count('claimed'),
    cancelled_deliveries: count('cancelled'),
    open_tasks: tasks.results.map((row) => ({
      task_id: row.task_id,
      room_id: row.room_id,
      description: row.description,
      status: row.status,
      updated_at: String(row.updated_at),
    })),
    open_task_count: tasks.results.length,
  };
}

function shareUrl(actor: ActorRow, origin: string): string | null {
  return actor.agent_session_id
    ? `${origin}/a/${encodeURIComponent(actor.agent_session_id)}`
    : null;
}

export function managementEventStatements(
  db: D1Database,
  options: {
    eventKey: string;
    agentId: string;
    managerId: string | null;
    type: string;
    metadata: Record<string, unknown>;
    at: number;
    notifyAgent: boolean;
  },
): D1PreparedStatement[] {
  const { eventKey, agentId, managerId, type, metadata, at, notifyAgent } = options;
  const statements: D1PreparedStatement[] = [
    eventStatement(
      db,
      {
        eventKey: `${eventKey}:audit`,
        scopeKind: 'actor',
        scopeId: agentId,
        eventType: type,
        refId: agentId,
        metadata,
      },
      at,
    ),
  ];
  if (managerId) {
    const managerKey = `${eventKey}:manager`;
    statements.push(
      eventStatement(
        db,
        {
          eventKey: managerKey,
          scopeKind: 'inbox',
          scopeId: managerId,
          eventType: type,
          refId: agentId,
          metadata: { ...metadata, agent_id: agentId },
        },
        at,
      ),
      outboxStatement(db, { topic: inboxTopic(managerId), eventKey: managerKey }, at),
      inboxHeadStatement(db, managerId, managerKey, at, 0),
    );
  }
  if (notifyAgent) {
    const agentKey = `${eventKey}:agent`;
    statements.push(
      eventStatement(
        db,
        {
          eventKey: agentKey,
          scopeKind: 'inbox',
          scopeId: agentId,
          eventType: type,
          refId: agentId,
          metadata: { ...metadata, agent_id: agentId },
        },
        at,
      ),
      outboxStatement(db, { topic: inboxTopic(agentId), eventKey: agentKey }, at),
      inboxHeadStatement(db, agentId, agentKey, at, 0),
    );
  }
  return statements;
}

export interface AgentManagementView {
  actor_id: string;
  kind: 'agent';
  name: string;
  agent_session_id: string | null;
  share_url: string | null;
  archived: boolean;
  archived_at: string | null;
  archived_by: string | null;
  disabled: boolean;
  disabled_at: string | null;
  disabled_by: string | null;
  disabled_reason: string | null;
  my_role: 'manager' | 'delegate' | 'agent';
  management: {
    binding_id: string;
    manager_id: string;
    manager_name: string;
    status: 'active';
    grant_source: 'created' | 'claim' | 'transfer' | 'legacy';
    permission_version: number;
    created_at: string;
    confirmed_at: string | null;
  } | null;
  delegation: {
    delegation_id: string;
    delegate_actor_id: string;
    scopes: string[];
    permission_version: number;
    expires_at: string | null;
  } | null;
  can_manage: boolean;
  can_delegate: boolean;
  pending_work: PendingWorkView;
}

/**
 * 读取管理关系。
 *
 * Agent 自身可读自己的管理关系；active manager、scope 匹配的 delegate 可读；
 * 其他已注册身份返回 PERMISSION_DENIED。浏览器 localStorage 中的 owner
 * 字段不参与判断。
 */
export async function agentManagementGet(
  db: D1Database,
  principal: Principal,
  targetId: string,
  origin: string,
): Promise<AgentManagementView> {
  const caller = actorId(principal);
  const target = await requireAgentTarget(db, targetId);
  const access = await managementAccess(db, caller, target.actor_id, nowMs());
  if (!access) {
    throw new BusinessError('PERMISSION_DENIED', '当前身份无权读取该 Agent 的管理关系', {
      actor_id: target.actor_id,
    });
  }
  const manager = access.management
    ? await getActor(db, access.management.manager_id)
    : null;
  return {
    actor_id: target.actor_id,
    kind: 'agent',
    name: target.name,
    agent_session_id: target.agent_session_id,
    share_url: shareUrl(target, origin),
    archived: target.archived_at !== null,
    archived_at: target.archived_at === null ? null : String(target.archived_at),
    archived_by: target.archived_by,
    disabled: target.disabled_at !== null,
    disabled_at: target.disabled_at === null ? null : String(target.disabled_at),
    disabled_by: target.disabled_by,
    disabled_reason: target.disabled_reason,
    my_role: access.role,
    management: access.management
      ? {
          binding_id: access.management.binding_id,
          manager_id: access.management.manager_id,
          manager_name: manager?.name ?? '',
          status: 'active',
          grant_source: access.management.grant_source,
          permission_version: access.management.permission_version,
          created_at: String(access.management.created_at),
          confirmed_at:
            access.management.confirmed_at === null
              ? null
              : String(access.management.confirmed_at),
        }
      : null,
    delegation: access.delegation
      ? {
          delegation_id: access.delegation.delegation_id,
          delegate_actor_id: access.delegation.delegate_actor_id,
          scopes: parseScopes(access.delegation.scopes_json),
          permission_version: access.delegation.permission_version,
          expires_at:
            access.delegation.expires_at === null
              ? null
              : String(access.delegation.expires_at),
        }
      : null,
    can_manage: access.canManage,
    can_delegate: access.role === 'manager',
    pending_work: await pendingWork(db, target.actor_id),
  };
}

export interface AgentManagedItem {
  actor_id: string;
  name: string;
  agent_session_id: string | null;
  share_url: string | null;
  archived: boolean;
  disabled: boolean;
  role: 'manager' | 'delegate';
  permission_version: number;
  since: string;
}

export interface AgentsManagedListResult {
  items: AgentManagedItem[];
  next_cursor: string | null;
  has_more: boolean;
}

interface ManagedRow extends ActorRow {
  role: 'manager' | 'delegate';
  permission_version: number;
  since: number;
}

/** 列出调用者作为 manager 或 delegate 管理的 Agent；keyset 分页。 */
export async function agentsManagedList(
  db: D1Database,
  principal: Principal,
  input: AgentsManagedListInput,
  origin: string,
): Promise<AgentsManagedListResult> {
  const caller = actorId(principal);
  const scope = `managed:${caller}`;
  const limit = Math.min(
    input.limit ?? LIMITS.managedAgentsPageDefault,
    LIMITS.managedAgentsPageMax,
  );
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const at = nowMs();
  const where = cursor
    ? 'AND (CASE WHEN m.manager_id = ? THEN m.created_at ELSE d.created_at END) < ?'
    : '';
  const rows = await db
    .prepare(
      `SELECT a.*,
              CASE WHEN m.manager_id = ? THEN 'manager' ELSE 'delegate' END AS role,
              CASE WHEN m.manager_id = ? THEN m.permission_version ELSE d.permission_version END AS permission_version,
              CASE WHEN m.manager_id = ? THEN m.created_at ELSE d.created_at END AS since
         FROM actors a
         LEFT JOIN agent_managements m
           ON m.agent_id = a.actor_id AND m.status = 'active'
         LEFT JOIN agent_delegations d
           ON d.agent_id = a.actor_id AND d.delegate_actor_id = ?
          AND d.status = 'active' AND (d.expires_at IS NULL OR d.expires_at > ?)
          AND d.scopes_json LIKE '%"${MANAGE_AGENT_SCOPE}"%'
        WHERE a.kind = 'agent' AND (m.manager_id = ? OR d.delegation_id IS NOT NULL)
        ${where}
        ORDER BY since DESC, a.actor_id ASC
        LIMIT ?`,
    )
    .bind(
      ...(cursor
        ? [caller, caller, caller, caller, at, caller, cursor.seq, limit + 1]
        : [caller, caller, caller, caller, at, caller, limit + 1]),
    )
    .all<ManagedRow>();

  const items: AgentManagedItem[] = [];
  const seen = new Set<string>();
  for (const row of rows.results) {
    if (seen.has(row.actor_id)) continue;
    seen.add(row.actor_id);
    if (items.length >= limit) break;
    items.push({
      actor_id: row.actor_id,
      name: row.name,
      agent_session_id: row.agent_session_id,
      share_url: shareUrl(row, origin),
      archived: row.archived_at !== null,
      disabled: row.disabled_at !== null,
      role: row.role,
      permission_version: row.permission_version,
      since: String(row.since),
    });
  }
  const hasMore = rows.results.length > items.length;
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: Number(last.since),
            key: last.actor_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

export interface AgentDelegateGrantResult {
  delegation_id: string;
  actor_id: string;
  delegate_actor_id: string;
  scopes: string[];
  permission_version: number;
  expires_at: string | null;
  created_at: string;
}

/** manager 授予 `manage_agent` 委托；delegate 不能再转授。 */
export async function agentDelegateGrant(
  db: D1Database,
  principal: Principal,
  input: AgentDelegateGrantInput,
): Promise<AgentDelegateGrantResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const { target, access } = await requireManageAgent(db, principal, input.actor_id, at);
  if (access.role !== 'manager') {
    throw new BusinessError('PERMISSION_DENIED', '只有当前管理者可以授予委托');
  }
  const delegate = await getActor(db, input.delegate_actor_id);
  if (!delegate) throw new BusinessError('NOT_FOUND', '委托目标不存在');
  if (delegate.actor_id === caller || delegate.actor_id === target.actor_id) {
    throw new BusinessError('INVALID_ARGUMENT', '不能把委托授予自己或目标 Agent');
  }
  if (delegate.kind !== 'human') {
    throw new BusinessError('INVALID_ARGUMENT', '管理委托只能授予 human 身份');
  }
  const scopes = input.scopes ?? [MANAGE_AGENT_SCOPE];
  const ttl = Math.min(
    input.expires_in_ms ?? LIMITS.agentDelegationTtlMs,
    LIMITS.agentDelegationTtlMs,
  );
  const expiresAt = at + ttl;
  const delegationId = newId('dlg');
  const result: AgentDelegateGrantResult = {
    delegation_id: delegationId,
    actor_id: target.actor_id,
    delegate_actor_id: delegate.actor_id,
    scopes,
    permission_version: 1,
    expires_at: String(expiresAt),
    created_at: String(at),
  };
  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `agent_delegation:${delegationId}`;

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      managementPermissionGuard(db, target.actor_id, caller, at),
      db
        .prepare(
          guardSql(
            'permissionDenied',
            "NOT EXISTS (SELECT 1 FROM agent_managements WHERE agent_id = ? AND manager_id = ? AND status = 'active')",
          ),
        )
        .bind(target.actor_id, caller),
      db
        .prepare(
          guardSql(
            'claimConflict',
            "EXISTS (SELECT 1 FROM agent_delegations WHERE agent_id = ? AND delegate_actor_id = ? AND status = 'active')",
          ),
        )
        .bind(target.actor_id, delegate.actor_id),
      db
        .prepare(
          `INSERT INTO agent_delegations
             (delegation_id, agent_id, delegate_actor_id, status, scopes_json, permission_version,
              created_by, created_at, expires_at, revoked_at, revoked_by, updated_at)
           VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?, NULL, NULL, ?)`,
        )
        .bind(
          delegationId,
          target.actor_id,
          delegate.actor_id,
          scopesJson(scopes),
          caller,
          at,
          expiresAt,
          at,
        ),
      ...managementEventStatements(db, {
        eventKey,
        agentId: target.actor_id,
        managerId: caller,
        type: 'agent_delegation_granted',
        metadata: {
          delegation_id: delegationId,
          delegate_actor_id: delegate.actor_id,
          scopes,
          expires_at: expiresAt,
        },
        at,
        notifyAgent: true,
      }),
      eventStatement(
        db,
        {
          eventKey: `${eventKey}:delegate`,
          scopeKind: 'inbox',
          scopeId: delegate.actor_id,
          eventType: 'agent_delegation_granted',
          refId: delegationId,
          metadata: { agent_id: target.actor_id, delegation_id: delegationId, scopes },
        },
        at,
      ),
      outboxStatement(
        db,
        { topic: inboxTopic(delegate.actor_id), eventKey: `${eventKey}:delegate` },
        at,
      ),
      inboxHeadStatement(db, delegate.actor_id, `${eventKey}:delegate`, at, 0),
    ],
  });
  return result;
}

/** manager 撤销委托；之后 delegate 的读写会重新受授权约束。 */
export async function agentDelegateRevoke(
  db: D1Database,
  principal: Principal,
  input: AgentDelegateRevokeInput,
): Promise<{
  delegation_id: string;
  actor_id: string;
  delegate_actor_id: string;
  status: 'revoked';
  revoked_at: string;
}> {
  const caller = actorId(principal);
  const at = nowMs();
  const { target, access } = await requireManageAgent(db, principal, input.actor_id, at);
  if (access.role !== 'manager') {
    throw new BusinessError('PERMISSION_DENIED', '只有当前管理者可以撤销委托');
  }
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) {
    return replay.result as {
      delegation_id: string;
      actor_id: string;
      delegate_actor_id: string;
      status: 'revoked';
      revoked_at: string;
    };
  }
  const delegation = await db
    .prepare(
      `SELECT * FROM agent_delegations
        WHERE agent_id = ? AND delegate_actor_id = ? AND status = 'active'`,
    )
    .bind(target.actor_id, input.delegate_actor_id)
    .first<AgentDelegationRow>();
  if (!delegation) {
    throw new BusinessError('NOT_FOUND', '没有可撤销的有效委托');
  }
  const result = {
    delegation_id: delegation.delegation_id,
    actor_id: target.actor_id,
    delegate_actor_id: delegation.delegate_actor_id,
    status: 'revoked' as const,
    revoked_at: String(at),
  };
  const eventKey = `agent_delegation_revoke:${delegation.delegation_id}`;

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      managementPermissionGuard(db, target.actor_id, caller, at),
      db
        .prepare(
          guardSql(
            'permissionDenied',
            "NOT EXISTS (SELECT 1 FROM agent_managements WHERE agent_id = ? AND manager_id = ? AND status = 'active')",
          ),
        )
        .bind(target.actor_id, caller),
      db
        .prepare(
          guardSql(
            'claimConflict',
            "NOT EXISTS (SELECT 1 FROM agent_delegations WHERE delegation_id = ? AND status = 'active')",
          ),
        )
        .bind(delegation.delegation_id),
      db
        .prepare(
          `UPDATE agent_delegations
              SET status = 'revoked', revoked_at = ?, revoked_by = ?,
                  permission_version = permission_version + 1, updated_at = ?
            WHERE delegation_id = ? AND status = 'active'`,
        )
        .bind(at, caller, at, delegation.delegation_id),
      ...managementEventStatements(db, {
        eventKey,
        agentId: target.actor_id,
        managerId: caller,
        type: 'agent_delegation_revoked',
        metadata: {
          delegation_id: delegation.delegation_id,
          delegate_actor_id: delegation.delegate_actor_id,
        },
        at,
        notifyAgent: true,
      }),
      eventStatement(
        db,
        {
          eventKey: `${eventKey}:delegate`,
          scopeKind: 'inbox',
          scopeId: delegation.delegate_actor_id,
          eventType: 'agent_delegation_revoked',
          refId: delegation.delegation_id,
          metadata: {
            agent_id: target.actor_id,
            delegation_id: delegation.delegation_id,
          },
        },
        at,
      ),
      outboxStatement(
        db,
        {
          topic: inboxTopic(delegation.delegate_actor_id),
          eventKey: `${eventKey}:delegate`,
        },
        at,
      ),
      inboxHeadStatement(db, delegation.delegate_actor_id, `${eventKey}:delegate`, at, 0),
    ],
  });
  return result;
}

export interface AgentDisableResult {
  actor_id: string;
  disabled: true;
  disabled_at: string;
  disabled_by: string;
  disabled_reason: string | null;
  stopped: PendingWorkView;
}

function normalizeDisableReason(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const reason = raw.trim();
  if (!reason) return null;
  if (CONTROL_CHARS.test(reason)) {
    throw new BusinessError('INVALID_ARGUMENT', '停用原因不能包含控制字符或换行');
  }
  if (utf8Bytes(reason) > LIMITS.agentDisableReasonBytes) {
    throw new BusinessError('INVALID_ARGUMENT', '停用原因超过长度上限');
  }
  return reason;
}

/**
 * 停用 Agent：阻止新投递与新执行，撤销 active 委托，取消 pending/claimed
 * delivery，但保留 room_tasks 状态供管理者查看。归档与停用正交。
 */
export async function disableAgent(
  db: D1Database,
  principal: Principal,
  input: AgentDisableInput,
): Promise<AgentDisableResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const { target } = await requireManageAgent(db, principal, input.actor_id, at);
  const reason = normalizeDisableReason(input.reason);
  const stopped = await pendingWork(db, target.actor_id);
  const result: AgentDisableResult = {
    actor_id: target.actor_id,
    disabled: true,
    disabled_at: String(target.disabled_at ?? at),
    disabled_by: target.disabled_by ?? caller,
    disabled_reason: target.disabled_reason ?? reason,
    stopped,
  };
  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `agent_disable:${target.actor_id}:${input.request_id}`;
  // D04：停用 Agent 与撤销任务执行资格同事务。跨房间处理其负责的
  // in_progress/blocked 任务；外部副作用保持未知，不自动重跑。
  const taskRevocations = await revokeTaskEligibilityStatements(db, {
    actorId: target.actor_id,
    roomId: null,
    requestId: input.request_id,
    at,
    reason: 'agent_disabled',
  });

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      managementPermissionGuard(db, target.actor_id, caller, at),
      ...(managementVersionGuard(db, target.actor_id, input.expected_permission_version)
        ? [managementVersionGuard(db, target.actor_id, input.expected_permission_version)!]
        : []),
      db
        .prepare(
          `UPDATE agent_managements
              SET permission_version = permission_version + 1, updated_at = ?
            WHERE agent_id = ? AND status = 'active'
              AND EXISTS (SELECT 1 FROM actors WHERE actor_id = ? AND disabled_at IS NULL)`,
        )
        .bind(at, target.actor_id, target.actor_id),
      db
        .prepare(
          `UPDATE agent_delegations
              SET status = 'revoked', revoked_at = ?, revoked_by = ?,
                  permission_version = permission_version + 1, updated_at = ?
            WHERE agent_id = ? AND status = 'active'
              AND EXISTS (SELECT 1 FROM actors WHERE actor_id = ? AND disabled_at IS NULL)`,
        )
        .bind(at, caller, at, target.actor_id, target.actor_id),
      // pending 计数在取消前按当前行数扣减；与取消语句在同一事务内。
      db
        .prepare(
          `UPDATE actors
              SET pending_count = pending_count - (
                    SELECT COUNT(*) FROM deliveries
                     WHERE recipient_id = ? AND state = 'pending'
                  ),
                  disabled_at = COALESCE(disabled_at, ?),
                  disabled_by = COALESCE(disabled_by, ?),
                  disabled_reason = COALESCE(disabled_reason, ?),
                  updated_at = ?
            WHERE actor_id = ? AND kind = 'agent'`,
        )
        .bind(target.actor_id, at, caller, reason, at, target.actor_id),
      db
        .prepare(
          `UPDATE deliveries
              SET state = 'cancelled', error = ?, updated_at = ?
            WHERE recipient_id = ? AND state IN ('pending', 'claimed')`,
        )
        .bind('agent disabled', at, target.actor_id),
      ...taskRevocations,
      ...managementEventStatements(db, {
        eventKey,
        agentId: target.actor_id,
        managerId: caller,
        type: 'agent_disabled',
        metadata: {
          disabled_by: caller,
          reason,
          stopped_pending_deliveries: stopped.pending_deliveries,
          stopped_claimed_deliveries: stopped.claimed_deliveries,
          open_task_count: stopped.open_task_count,
        },
        at,
        notifyAgent: false,
      }),
    ],
  });
  return result;
}

export interface AgentEnableResult {
  actor_id: string;
  disabled: false;
  enabled_at: string;
}

/** 启用 Agent：恢复凭据可用性；不会自动恢复已取消的投递或已撤销的委托。 */
export async function enableAgent(
  db: D1Database,
  principal: Principal,
  input: AgentEnableInput,
): Promise<AgentEnableResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const { target } = await requireManageAgent(db, principal, input.actor_id, at);
  const result: AgentEnableResult = {
    actor_id: target.actor_id,
    disabled: false,
    enabled_at: String(at),
  };
  const payloadHash = await sha256Hex(stableStringify(input));
  const eventKey = `agent_enable:${target.actor_id}:${input.request_id}`;

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
      managementPermissionGuard(db, target.actor_id, caller, at),
      ...(managementVersionGuard(db, target.actor_id, input.expected_permission_version)
        ? [managementVersionGuard(db, target.actor_id, input.expected_permission_version)!]
        : []),
      db
        .prepare(
          `UPDATE agent_managements
              SET permission_version = permission_version + 1, updated_at = ?
            WHERE agent_id = ? AND status = 'active'
              AND EXISTS (SELECT 1 FROM actors WHERE actor_id = ? AND disabled_at IS NOT NULL)`,
        )
        .bind(at, target.actor_id, target.actor_id),
      db
        .prepare(
          `UPDATE actors
              SET disabled_at = NULL, disabled_by = NULL, disabled_reason = NULL, updated_at = ?
            WHERE actor_id = ? AND kind = 'agent'`,
        )
        .bind(at, target.actor_id),
      ...managementEventStatements(db, {
        eventKey,
        agentId: target.actor_id,
        managerId: caller,
        type: 'agent_enabled',
        metadata: { enabled_by: caller },
        at,
        notifyAgent: true,
      }),
    ],
  });
  return result;
}

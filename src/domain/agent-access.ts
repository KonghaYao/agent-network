import { BusinessError } from '../contracts/errors';
import { guardSql } from '../storage/guards';
import type { AgentDelegationRow, AgentManagementRow, ActorRow } from '../storage/rows';
import { getActor, type D1Like } from '../storage/queries';
import type { Principal } from './principal';

/**
 * Agent 管理授权判定。
 *
 * 唯一权威是 `agent_managements`：active manager 可管理；delegate 需要
 * `agent_delegations` 处于 active、未过期且 scopes 含 `manage_agent`。
 * 调用方 actor 的 kind、群角色、联系人和浏览器 localStorage 都不是授权依据。
 * 所有写操作在 `db.batch()` 内再次执行 guard，避免“先读后写”窗口。
 */

export const MANAGE_AGENT_SCOPE = 'manage_agent';

export interface ManagementAccess {
  role: 'manager' | 'delegate' | 'agent';
  management: AgentManagementRow | null;
  delegation: AgentDelegationRow | null;
  canManage: boolean;
  canDelegate: boolean;
}

function scopesOf(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function hasScope(raw: string, scope: string): boolean {
  return scopesOf(raw).includes(scope);
}

export function scopesJson(scopes: string[]): string {
  return JSON.stringify([...new Set(scopes)]);
}

/** 读取目标 Agent；人类或未知目标按调用场景返回明确错误。 */
export async function requireAgentTarget(db: D1Like, targetId: string): Promise<ActorRow> {
  const target = await getActor(db, targetId);
  if (!target) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  if (target.kind !== 'agent') {
    throw new BusinessError('INVALID_ARGUMENT', '目标必须是 agent actor');
  }
  return target;
}

export async function getActiveManagement(
  db: D1Like,
  agentId: string,
): Promise<AgentManagementRow | null> {
  return db
    .prepare("SELECT * FROM agent_managements WHERE agent_id = ? AND status = 'active'")
    .bind(agentId)
    .first<AgentManagementRow>();
}

async function getActiveDelegation(
  db: D1Like,
  agentId: string,
  delegateActorId: string,
  at: number,
): Promise<AgentDelegationRow | null> {
  return db
    .prepare(
      `SELECT * FROM agent_delegations
        WHERE agent_id = ? AND delegate_actor_id = ? AND status = 'active'
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(agentId, delegateActorId, at)
    .first<AgentDelegationRow>();
}

/**
 * 读取调用者的管理角色；不抛权限错误，由调用方决定何时拒绝。
 *
 * 停用不改变管理权：管理者仍可读取、启用、重发 token；Agent 自身在
 * 认证层已被 ACTOR_DISABLED 拦截，不会走到这里。
 */
export async function managementAccess(
  db: D1Like,
  callerActorId: string,
  agentId: string,
  at: number,
): Promise<ManagementAccess | null> {
  const management = await getActiveManagement(db, agentId);
  if (!management) {
    return callerActorId === agentId
      ? { role: 'agent', management: null, delegation: null, canManage: false, canDelegate: false }
      : null;
  }
  if (management.manager_id === callerActorId) {
    return {
      role: 'manager',
      management,
      delegation: null,
      canManage: true,
      canDelegate: true,
    };
  }
  if (callerActorId === agentId) {
    return {
      role: 'agent',
      management,
      delegation: null,
      canManage: false,
      canDelegate: false,
    };
  }
  const delegation = await getActiveDelegation(db, agentId, callerActorId, at);
  if (delegation && hasScope(delegation.scopes_json, MANAGE_AGENT_SCOPE)) {
    return {
      role: 'delegate',
      management,
      delegation,
      canManage: true,
      canDelegate: false,
    };
  }
  return null;
}

/**
 * 批量判断调用者能否管理给定 Agent，供房间列表标记对端权限。
 *
 * 与 `managementAccess` 使用同一张管理/委托表：active manager，或未过期的
 * `manage_agent` 委托。只返回调用者自己可管理的 actor_id 集合，不读取或
 * 暴露 manager_id，也不改变任何授权判定。
 */
export async function manageableAgentIds(
  db: D1Like,
  callerActorId: string,
  agentIds: string[],
  at: number,
): Promise<Set<string>> {
  const ids = [...new Set(agentIds)].filter((id) => id !== callerActorId);
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const [managements, delegations] = await Promise.all([
    db
      .prepare(
        `SELECT agent_id, manager_id FROM agent_managements
          WHERE status = 'active' AND agent_id IN (${placeholders})`,
      )
      .bind(...ids)
      .all<{ agent_id: string; manager_id: string }>(),
    db
      .prepare(
        `SELECT agent_id, scopes_json FROM agent_delegations
          WHERE delegate_actor_id = ? AND status = 'active'
            AND (expires_at IS NULL OR expires_at > ?)
            AND agent_id IN (${placeholders})`,
      )
      .bind(callerActorId, at, ...ids)
      .all<{ agent_id: string; scopes_json: string }>(),
  ]);
  const manageable = new Set<string>();
  for (const row of managements.results) {
    if (row.manager_id === callerActorId) manageable.add(row.agent_id);
  }
  for (const row of delegations.results) {
    if (hasScope(row.scopes_json, MANAGE_AGENT_SCOPE)) manageable.add(row.agent_id);
  }
  return manageable;
}

export interface ManageRequirement {
  target: ActorRow;
  management: AgentManagementRow;
  access: ManagementAccess;
}

/**
 * 写操作前置校验：只用于给出可读错误；真正的并发裁决仍在事务 guard。
 * 返回的 management 可能已被并发撤销，因此调用方不得仅凭它写入。
 */
export async function requireManageAgent(
  db: D1Like,
  principal: Principal,
  agentId: string,
  at: number,
): Promise<ManageRequirement> {
  const caller = principal.actor;
  if (!caller) throw new BusinessError('CREDENTIAL_INVALID', '当前凭据尚未注册');
  if (caller.kind !== 'human') {
    throw new BusinessError('PERMISSION_DENIED', '只有 human 管理身份可以执行该操作');
  }
  const target = await requireAgentTarget(db, agentId);
  const access = await managementAccess(db, caller.actor_id, agentId, at);
  if (!access || access.role === 'agent' || !access.management) {
    throw new BusinessError('PERMISSION_DENIED', '当前身份不是该 Agent 的管理者或受托人', {
      actor_id: agentId,
    });
  }
  return { target, management: access.management, access };
}

/** 事务内权限 guard；必须在业务 UPDATE 之前执行。 */
export function managementPermissionGuard(
  db: D1Database,
  agentId: string,
  callerActorId: string,
  at: number,
): D1PreparedStatement {
  return db
    .prepare(
      guardSql(
        'permissionDenied',
        `NOT EXISTS (
           SELECT 1 FROM agent_managements m
            WHERE m.agent_id = ? AND m.status = 'active'
              AND (
                m.manager_id = ?
                OR EXISTS (
                  SELECT 1 FROM agent_delegations d
                   WHERE d.agent_id = m.agent_id
                     AND d.delegate_actor_id = ?
                     AND d.status = 'active'
                     AND (d.expires_at IS NULL OR d.expires_at > ?)
                     AND EXISTS (SELECT 1 FROM json_each(d.scopes_json) WHERE json_each.value = '${MANAGE_AGENT_SCOPE}')
                )
              )
         )`,
      ),
    )
    .bind(agentId, callerActorId, callerActorId, at);
}

/** 事务内权限版本 guard；调用方传入 expected 时才写入。 */
export function managementVersionGuard(
  db: D1Database,
  agentId: string,
  expectedPermissionVersion: number | undefined,
): D1PreparedStatement | null {
  if (expectedPermissionVersion === undefined) return null;
  return db
    .prepare(
      guardSql(
        'versionConflict',
        `NOT EXISTS (
           SELECT 1 FROM agent_managements
            WHERE agent_id = ? AND status = 'active' AND permission_version = ?
         )`,
      ),
    )
    .bind(agentId, expectedPermissionVersion);
}

export function parseScopes(raw: string): string[] {
  return scopesOf(raw);
}

import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  AgentTransferGetInput,
  AgentTransferListInput,
} from '../contracts/schemas';
import { nowMs } from '../storage/db';
import { MANAGE_AGENT_SCOPE } from './agent-access';
import {
  canViewTransfer,
  expireAgentTransfers,
  getTransferRow,
  TRANSFER_VIEW_SQL,
  viewOf,
  type AgentTransferView,
  type TransferJoinRow,
} from './agent-transfer-store';
import { actorId, type Principal } from './principal';

/**
 * A06 管理权交接的读取面与管理摘要。
 *
 * 所有读取都只返回调用者本来可见的 Agent 范围；不复制原管理者的私聊、
 * 联系人或外部平台授权。
 */
export async function agentTransferGet(
  db: D1Database,
  principal: Principal,
  input: AgentTransferGetInput,
): Promise<AgentTransferView> {
  const viewer = actorId(principal);
  const at = nowMs();
  let row = await getTransferRow(db, input.transfer_id);
  if (!row) throw new BusinessError('NOT_FOUND', '交接提议不存在');
  if (!(await canViewTransfer(db, row, viewer, at))) {
    throw new BusinessError('NOT_FOUND', '交接提议不存在');
  }
  if (row.status === 'pending' && row.expires_at <= at) {
    await expireAgentTransfers(db, row.agent_id, at);
    row = (await getTransferRow(db, input.transfer_id)) ?? row;
  }
  return viewOf(row, viewer, at);
}

/**
 * 列出与调用者相关的提议。
 *
 * 只返回 caller 是发起人、接任者、目标 Agent 或有效受托人的行；`actor_id`
 * 只是收窄条件，不能越权枚举。
 */
export async function agentTransferList(
  db: D1Database,
  principal: Principal,
  input: AgentTransferListInput,
): Promise<{ items: AgentTransferView[]; has_more: boolean }> {
  const viewer = actorId(principal);
  const at = nowMs();
  const expiryCandidates = await db
    .prepare(
      `SELECT DISTINCT t.agent_id FROM agent_management_transfers t
        WHERE t.status = 'pending' AND t.expires_at <= ?
          AND (t.agent_id = ? OR t.from_manager_id = ? OR t.to_manager_id = ?
            OR EXISTS (
              SELECT 1 FROM agent_delegations d
               WHERE d.agent_id = t.agent_id AND d.delegate_actor_id = ?
                 AND d.status = 'active' AND (d.expires_at IS NULL OR d.expires_at > ?)))`,
    )
    .bind(at, viewer, viewer, viewer, viewer, at)
    .all<{ agent_id: string }>();
  for (const item of expiryCandidates.results) {
    await expireAgentTransfers(db, item.agent_id, at);
  }

  const limit = Math.min(input.limit ?? LIMITS.agentTransferListDefault, LIMITS.agentTransferListMax);
  const where: string[] = [
    `(t.agent_id = ? OR t.from_manager_id = ? OR t.to_manager_id = ?
      OR EXISTS (
        SELECT 1 FROM agent_delegations d
         WHERE d.agent_id = t.agent_id AND d.delegate_actor_id = ? AND d.status = 'active'
           AND (d.expires_at IS NULL OR d.expires_at > ?)
           AND d.scopes_json LIKE '%"${MANAGE_AGENT_SCOPE}"%'))`,
  ];
  const binds: unknown[] = [viewer, viewer, viewer, viewer, at];
  if (input.actor_id) {
    where.push('t.agent_id = ?');
    binds.push(input.actor_id);
  }
  if (input.status) {
    where.push('t.status = ?');
    binds.push(input.status);
  }
  if (input.role === 'from') {
    where.push('t.from_manager_id = ?');
    binds.push(viewer);
  } else if (input.role === 'to') {
    where.push('t.to_manager_id = ?');
    binds.push(viewer);
  } else if (input.role === 'agent') {
    where.push('t.agent_id = ?');
    binds.push(viewer);
  }
  const rows = await db
    .prepare(
      `SELECT t.*, ag.name AS agent_name, f.name AS from_manager_name,
              u.name AS to_manager_name
         FROM agent_management_transfers t
         JOIN actors ag ON ag.actor_id = t.agent_id
         JOIN actors f ON f.actor_id = t.from_manager_id
         JOIN actors u ON u.actor_id = t.to_manager_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.created_at DESC, t.transfer_id DESC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<TransferJoinRow>();
  const items = rows.results.slice(0, limit).map((row) => viewOf(row, viewer, at));
  return { items, has_more: rows.results.length > limit };
}

/** 管理视图用：当前查阅者可见的 pending 提议（含接任者视角）。 */
export async function visiblePendingTransfer(
  db: D1Database,
  agentId: string,
  viewer: string,
  at: number,
): Promise<AgentTransferView | null> {
  await expireAgentTransfers(db, agentId, at);
  const row = await db
    .prepare(
      `${TRANSFER_VIEW_SQL.replace('WHERE t.transfer_id = ?', "WHERE t.agent_id = ? AND t.status = 'pending' AND t.expires_at > ?")}`,
    )
    .bind(agentId, at)
    .first<TransferJoinRow>();
  if (!row) return null;
  if (!(await canViewTransfer(db, row, viewer, at))) return null;
  return viewOf(row, viewer, at);
}

/** 管理视图用：该 Agent 的 active 群关系（不包含成员私聊内容）。 */
export async function agentRoomRelations(
  db: D1Database,
  agentId: string,
): Promise<{
  room_id: string;
  kind: string;
  title: string | null;
  role: string;
  joined_at: string;
}[]> {
  const rows = await db
    .prepare(
      `SELECT rm.room_id, r.kind, r.title, rm.role, rm.joined_at
         FROM room_members rm
         JOIN rooms r ON r.room_id = rm.room_id
        WHERE rm.actor_id = ? AND rm.status = 'active'
        ORDER BY rm.joined_at DESC, rm.room_id ASC
        LIMIT ?`,
    )
    .bind(agentId, LIMITS.agentManagementRoomsMax)
    .all<{
      room_id: string;
      kind: string;
      title: string | null;
      role: string;
      joined_at: number;
    }>();
  return rows.results.map((row) => ({
    room_id: row.room_id,
    kind: row.kind,
    title: row.title,
    role: row.role,
    joined_at: String(row.joined_at),
  }));
}

/** 管理视图用：active 委托摘要。 */
export async function agentActiveDelegations(
  db: D1Database,
  agentId: string,
  at: number,
): Promise<{
  delegation_id: string;
  delegate_actor_id: string;
  delegate_name: string;
  scopes: string[];
  permission_version: number;
  expires_at: string | null;
  created_at: string;
}[]> {
  const rows = await db
    .prepare(
      `SELECT d.*, a.name AS delegate_name
         FROM agent_delegations d
         JOIN actors a ON a.actor_id = d.delegate_actor_id
        WHERE d.agent_id = ? AND d.status = 'active'
          AND (d.expires_at IS NULL OR d.expires_at > ?)
        ORDER BY d.created_at DESC, d.delegation_id DESC
        LIMIT ?`,
    )
    .bind(agentId, at, LIMITS.agentManagementDelegationsMax)
    .all<{
      delegation_id: string;
      delegate_actor_id: string;
      delegate_name: string;
      scopes_json: string;
      permission_version: number;
      expires_at: number | null;
      created_at: number;
    }>();
  return rows.results.map((row) => ({
    delegation_id: row.delegation_id,
    delegate_actor_id: row.delegate_actor_id,
    delegate_name: row.delegate_name,
    scopes: (() => {
      try {
        const value = JSON.parse(row.scopes_json) as unknown;
        return Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string')
          : [];
      } catch {
        return [];
      }
    })(),
    permission_version: row.permission_version,
    expires_at: row.expires_at === null ? null : String(row.expires_at),
    created_at: String(row.created_at),
  }));
}

/** 管理视图用：pending/claimed 投递明细；只返回定位信息，不含正文。 */
export async function agentInFlightDeliveries(
  db: D1Database,
  agentId: string,
): Promise<{
  pending: number;
  claimed: number;
  items: {
    delivery_id: string;
    room_id: string;
    message_id: string;
    state: string;
    attempt: number;
    updated_at: string;
  }[];
}> {
  const counts = await db
    .prepare(
      `SELECT state, COUNT(*) AS n FROM deliveries
        WHERE recipient_id = ? AND state IN ('pending', 'claimed')
        GROUP BY state`,
    )
    .bind(agentId)
    .all<{ state: string; n: number }>();
  const items = await db
    .prepare(
      `SELECT delivery_id, room_id, message_id, state, attempt, updated_at
         FROM deliveries
        WHERE recipient_id = ? AND state IN ('pending', 'claimed')
        ORDER BY updated_at DESC, delivery_id ASC
        LIMIT ?`,
    )
    .bind(agentId, LIMITS.agentManagementDeliveriesMax)
    .all<{
      delivery_id: string;
      room_id: string;
      message_id: string;
      state: string;
      attempt: number;
      updated_at: number;
    }>();
  return {
    pending: counts.results.find((row) => row.state === 'pending')?.n ?? 0,
    claimed: counts.results.find((row) => row.state === 'claimed')?.n ?? 0,
    items: items.results.map((row) => ({
      delivery_id: row.delivery_id,
      room_id: row.room_id,
      message_id: row.message_id,
      state: row.state,
      attempt: row.attempt,
      updated_at: String(row.updated_at),
    })),
  };
}

/** 管理视图用：管理/交接审计摘要，不返回凭据、token 或消息正文。 */
export async function agentManagementAudit(
  db: D1Database,
  agentId: string,
): Promise<{
  event_type: string;
  ref_id: string | null;
  created_at: string;
  summary: Record<string, unknown>;
}[]> {
  const rows = await db
    .prepare(
      `SELECT event_type, ref_id, metadata, created_at
         FROM events
        WHERE scope_kind = 'actor' AND scope_id = ?
          AND event_type IN (
            'management_transfer_proposed', 'management_transfer_accepted',
            'management_transfer_rejected', 'management_transfer_cancelled',
            'management_transfer_expired', 'management_transferred',
            'credential_rotated', 'agent_management_bound', 'agent_disabled',
            'agent_enabled')
        ORDER BY event_seq DESC
        LIMIT ?`,
    )
    .bind(agentId, LIMITS.agentManagementAuditMax)
    .all<{
      event_type: string;
      ref_id: string | null;
      metadata: string;
      created_at: number;
    }>();
  const allowed = [
    'from_manager_id',
    'to_manager_id',
    'changed_by',
    'permission_version',
    'revoked_delegations',
    'revoked_credentials',
    'cancelled_pending_deliveries',
    'cancelled_claimed_deliveries',
    'expires_at',
    'reason',
  ];
  return rows.results.map((row) => {
    let metadata: Record<string, unknown> = {};
    try {
      const value = JSON.parse(row.metadata) as unknown;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        metadata = value as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
    const summary: Record<string, unknown> = {};
    for (const key of allowed) {
      if (metadata[key] !== undefined) summary[key] = metadata[key];
    }
    return {
      event_type: row.event_type,
      ref_id: row.ref_id,
      created_at: String(row.created_at),
      summary,
    };
  });
}

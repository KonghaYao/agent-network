import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import {
  eventStatement,
  eventStatementIfAbsent,
  inboxHeadStatement,
  inboxHeadStatementIfEvent,
  inboxTopic,
  outboxStatement,
  outboxStatementIfAbsent,
} from '../storage/events';
import type { ActorRow, AgentManagementTransferRow } from '../storage/rows';
import { hasScope, MANAGE_AGENT_SCOPE } from './agent-access';

/**
 * A06 Agent 管理权交接。
 *
 * 现管理者发起指定接任者的双边确认；接任者接受时在同一事务内切换
 * `agent_managements`、递增权限版本、撤销旧委托与旧运行凭据、轮换新 token，
 * 并把该 Agent 名下未结束任务交给 D04 的统一失权入口置为 blocked。
 * 拒绝/取消/过期只关闭提议，不改管理权、不轮换凭据。
 *
 * 交接只转移管理关系：不复制原管理者的私聊、联系人、群成员身份或外部
 * 平台授权。新 token 只在首次 accept 响应出现，`operations.result_json`
 * 只保存非秘密结果。
 */

export interface AgentTransferContextView {
  note: string | null;
  proposed_by: string;
  snapshot: {
    room_count: number;
    delegation_count: number;
    pending_deliveries: number;
    claimed_deliveries: number;
  };
  response_note: string | null;
  accepted_snapshot: {
    permission_version: number;
    revoked_delegations: number;
    revoked_credentials: number;
    cancelled_pending_deliveries: number;
    cancelled_claimed_deliveries: number;
  } | null;
}

export interface AgentTransferView {
  transfer_id: string;
  agent_id: string;
  agent_name: string;
  from_manager_id: string;
  from_manager_name: string;
  to_manager_id: string;
  to_manager_name: string;
  status: AgentManagementTransferRow['status'];
  from_permission_version: number;
  expires_at: string;
  created_at: string;
  responded_at: string | null;
  responded_by: string | null;
  context: AgentTransferContextView;
  can_accept: boolean;
  can_reject: boolean;
  can_cancel: boolean;
}

export interface AgentTransferAcceptedResult {
  transfer_id: string;
  agent_id: string;
  from_manager_id: string;
  to_manager_id: string;
  status: 'accepted';
  permission_version: number;
  accepted_at: string;
  revoked_delegations: number;
  revoked_credentials: number;
  cancelled_pending_deliveries: number;
  cancelled_claimed_deliveries: number;
  /** 首次响应为明文 token；重放时为 null。 */
  token: string | null;
  mcp_url: string | null;
}

export interface AgentTransferSimpleResult {
  transfer_id: string;
  agent_id: string;
  status: 'pending' | 'rejected' | 'cancelled';
  responded_at: string | null;
}

export interface TransferJoinRow extends AgentManagementTransferRow {
  agent_name: string;
  from_manager_name: string;
  to_manager_name: string;
}

export interface TransferContextStored {
  note?: string;
  proposed_by?: string;
  snapshot?: Partial<AgentTransferContextView['snapshot']>;
  response_note?: string;
  accepted_snapshot?: AgentTransferContextView['accepted_snapshot'];
}

export const TRANSFER_VIEW_SQL = `SELECT t.*,
         ag.name AS agent_name,
         f.name AS from_manager_name,
         u.name AS to_manager_name
    FROM agent_management_transfers t
    JOIN actors ag ON ag.actor_id = t.agent_id
    JOIN actors f ON f.actor_id = t.from_manager_id
    JOIN actors u ON u.actor_id = t.to_manager_id
   WHERE t.transfer_id = ?`;

export function parseContext(raw: string): TransferContextStored {
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as TransferContextStored)
      : {};
  } catch {
    return {};
  }
}

/** 解析存储上下文；只暴露摘要，不复制消息正文或其他用户隐私。 */
export function contextView(raw: string): AgentTransferContextView {
  const context = parseContext(raw);
  const snapshot = context.snapshot ?? {};
  const accepted = context.accepted_snapshot ?? null;
  return {
    note: typeof context.note === 'string' ? context.note : null,
    proposed_by: typeof context.proposed_by === 'string' ? context.proposed_by : '',
    snapshot: {
      room_count: Number(snapshot.room_count ?? 0),
      delegation_count: Number(snapshot.delegation_count ?? 0),
      pending_deliveries: Number(snapshot.pending_deliveries ?? 0),
      claimed_deliveries: Number(snapshot.claimed_deliveries ?? 0),
    },
    response_note: typeof context.response_note === 'string' ? context.response_note : null,
    accepted_snapshot: accepted,
  };
}

export function viewOf(row: TransferJoinRow, viewer: string, at: number): AgentTransferView {
  const pending = row.status === 'pending' && row.expires_at > at;
  return {
    transfer_id: row.transfer_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    from_manager_id: row.from_manager_id,
    from_manager_name: row.from_manager_name,
    to_manager_id: row.to_manager_id,
    to_manager_name: row.to_manager_name,
    status: row.status,
    from_permission_version: row.from_permission_version,
    expires_at: String(row.expires_at),
    created_at: String(row.created_at),
    responded_at: row.responded_at === null ? null : String(row.responded_at),
    responded_by: row.responded_by,
    context: contextView(row.context_json),
    can_accept: pending && row.to_manager_id === viewer,
    can_reject: pending && row.to_manager_id === viewer,
    can_cancel: pending && row.from_manager_id === viewer,
  };
}

export async function getTransferRow(
  db: D1Database,
  transferId: string,
): Promise<TransferJoinRow | null> {
  return db.prepare(TRANSFER_VIEW_SQL).bind(transferId).first<TransferJoinRow>();
}

/** 只读摘要查询：不给交接列表暴露其他房间/消息内容。 */
export async function workloadSnapshot(
  db: D1Database,
  agentId: string,
  at: number,
): Promise<AgentTransferContextView['snapshot']> {
  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM room_members WHERE actor_id = ? AND status = 'active') AS room_count,
         (SELECT COUNT(*) FROM agent_delegations
           WHERE agent_id = ? AND status = 'active'
             AND (expires_at IS NULL OR expires_at > ?)) AS delegation_count,
         (SELECT COUNT(*) FROM deliveries
           WHERE recipient_id = ? AND state = 'pending') AS pending_deliveries,
         (SELECT COUNT(*) FROM deliveries
           WHERE recipient_id = ? AND state = 'claimed') AS claimed_deliveries`,
    )
    .bind(agentId, agentId, at, agentId, agentId)
    .first<{
      room_count: number;
      delegation_count: number;
      pending_deliveries: number;
      claimed_deliveries: number;
    }>();
  return {
    room_count: counts?.room_count ?? 0,
    delegation_count: counts?.delegation_count ?? 0,
    pending_deliveries: counts?.pending_deliveries ?? 0,
    claimed_deliveries: counts?.claimed_deliveries ?? 0,
  };
}

/**
 * 写入一条 human-only inbox 提示。
 *
 * 交接通知只进入人类管理者的个人 inbox；不创建 delivery、不增加
 * `pending_count`（delta 固定 0），也不唤醒 Agent。
 */
export function transferInboxStatements(
  db: D1Database,
  input: {
    actor: string;
    eventType: string;
    eventKey: string;
    agentId: string;
    transferId: string;
    metadata: Record<string, unknown>;
    ifAbsent?: boolean;
  },
  at: number,
): D1PreparedStatement[] {
  const spec = {
    eventKey: input.eventKey,
    scopeKind: 'inbox' as const,
    scopeId: input.actor,
    eventType: input.eventType,
    refId: input.transferId,
    metadata: { agent_id: input.agentId, transfer_id: input.transferId, ...input.metadata },
  };
  if (input.ifAbsent) {
    return [
      eventStatementIfAbsent(db, spec, at),
      outboxStatementIfAbsent(db, { topic: inboxTopic(input.actor), eventKey: spec.eventKey }, at),
      inboxHeadStatementIfEvent(db, input.actor, spec.eventKey, at, 0),
    ];
  }
  return [
    eventStatement(db, spec, at),
    outboxStatement(db, { topic: inboxTopic(input.actor), eventKey: spec.eventKey }, at),
    inboxHeadStatement(db, input.actor, spec.eventKey, at, 0),
  ];
}

/**
 * 生命周期事件：agent scope 审计 + 双方 human inbox。
 *
 * `agent_transfer_*` 是早期契约别名，同时保留以便既有事件消费者继续匹配；
 * `management_transfer_*` 是本任务对外的正式事件类型。
 */
export function lifecycleStatements(
  db: D1Database,
  input: {
    agentId: string;
    transferId: string;
    eventKey: string;
    type: string;
    aliasType: string;
    fromManagerId: string;
    toManagerId: string;
    metadata: Record<string, unknown>;
    at: number;
    ifAbsent?: boolean;
  },
): D1PreparedStatement[] {
  const base = {
    agent_id: input.agentId,
    transfer_id: input.transferId,
    from_manager_id: input.fromManagerId,
    to_manager_id: input.toManagerId,
    ...input.metadata,
  };
  const audit = input.ifAbsent ? eventStatementIfAbsent : eventStatement;
  const statements: D1PreparedStatement[] = [
    audit(
      db,
      {
        eventKey: input.eventKey,
        scopeKind: 'actor',
        scopeId: input.agentId,
        eventType: input.type,
        refId: input.transferId,
        metadata: base,
      },
      input.at,
    ),
    audit(
      db,
      {
        eventKey: `${input.eventKey}:contract`,
        scopeKind: 'actor',
        scopeId: input.agentId,
        eventType: input.aliasType,
        refId: input.transferId,
        metadata: base,
      },
      input.at,
    ),
  ];
  for (const actor of [input.fromManagerId, input.toManagerId]) {
    if (!actor) continue;
    statements.push(
      ...transferInboxStatements(
        db,
        {
          actor,
          eventType: input.type,
          eventKey: `${input.eventKey}:inbox:${actor}`,
          agentId: input.agentId,
          transferId: input.transferId,
          metadata: base,
          ifAbsent: input.ifAbsent,
        },
        input.at,
      ),
    );
  }
  return statements;
}

/**
 * 把已到期的 pending 提议收敛为 expired，并写一次事件。
 *
 * 使用 ifAbsent 事件键，重复 sweep 不产生重复审计；调用方在发起、读取、
 * 响应前执行，保证唯一 pending 索引不会长期被失效提议占用。
 */
export async function expireAgentTransfers(
  db: D1Database,
  agentId: string,
  at: number,
): Promise<AgentManagementTransferRow[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM agent_management_transfers
        WHERE agent_id = ? AND status = 'pending' AND expires_at <= ?
        ORDER BY created_at ASC`,
    )
    .bind(agentId, at)
    .all<AgentManagementTransferRow>();
  if (rows.results.length === 0) return [];
  const statements: D1PreparedStatement[] = [];
  for (const row of rows.results) {
    statements.push(
      db
        .prepare(
          `UPDATE agent_management_transfers
              SET status = 'expired', responded_at = ?, responded_by = NULL, updated_at = ?
            WHERE transfer_id = ? AND status = 'pending'`,
        )
        .bind(at, at, row.transfer_id),
      ...lifecycleStatements(db, {
        agentId,
        transferId: row.transfer_id,
        eventKey: `management_transfer_expired:${row.transfer_id}`,
        type: 'management_transfer_expired',
        aliasType: 'agent_transfer_expired',
        fromManagerId: row.from_manager_id,
        toManagerId: row.to_manager_id,
        metadata: { changed_by: null, reason: 'expired' },
        at,
        ifAbsent: true,
      }),
    );
  }
  await db.batch(statements);
  return rows.results;
}

/** 接任者视角：该 Agent 是否有等待当前 caller 确认的提议。 */
export async function pendingTransferForSuccessor(
  db: D1Database,
  agentId: string,
  viewer: string,
  at: number,
): Promise<AgentManagementTransferRow | null> {
  await expireAgentTransfers(db, agentId, at);
  return db
    .prepare(
      `SELECT * FROM agent_management_transfers
        WHERE agent_id = ? AND to_manager_id = ? AND status = 'pending' AND expires_at > ?`,
    )
    .bind(agentId, viewer, at)
    .first<AgentManagementTransferRow>();
}

export async function canViewTransfer(
  db: D1Database,
  row: AgentManagementTransferRow,
  viewer: string,
  at: number,
): Promise<boolean> {
  if (
    row.agent_id === viewer ||
    row.from_manager_id === viewer ||
    row.to_manager_id === viewer
  ) {
    return true;
  }
  const delegation = await db
    .prepare(
      `SELECT scopes_json FROM agent_delegations
        WHERE agent_id = ? AND delegate_actor_id = ? AND status = 'active'
          AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .bind(row.agent_id, viewer, at)
    .first<{ scopes_json: string }>();
  return Boolean(delegation && hasScope(delegation.scopes_json, MANAGE_AGENT_SCOPE));
}

export function requireValidSuccessor(
  successor: ActorRow | null,
  caller: string,
  agentId: string,
): ActorRow {
  if (!successor) throw new BusinessError('NOT_FOUND', '接任者不存在');
  if (successor.kind !== 'human') {
    throw new BusinessError('INVALID_ARGUMENT', '接任者必须是 human 身份');
  }
  if (successor.actor_id === caller) {
    throw new BusinessError('INVALID_ARGUMENT', '不能把管理权交接给自己');
  }
  if (successor.actor_id === agentId) {
    throw new BusinessError('INVALID_ARGUMENT', 'Agent 不能成为自己的管理者');
  }
  if (successor.disabled_at !== null || successor.archived_at !== null) {
    throw new BusinessError('INVALID_ARGUMENT', '接任者已停用或归档，不能接受管理权');
  }
  return successor;
}

/** 当前管理者发起交接；同一 Agent 只允许一条 pending。 */

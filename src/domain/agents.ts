import { agentShareUrl } from '../contracts/share-links';
import type {
  AgentArchiveInput,
  AgentUnarchiveInput,
  AgentsGetInput,
} from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { getActorManagementByIds, type ActorManagementRow } from '../storage/queries';
import type { ActorRow } from '../storage/rows';
import { operationsStatement, resolveReplay, runIdempotent } from '../storage/transactions/runner';
import {
  managementPermissionGuard,
  managementVersionGuard,
  requireAgentTarget,
  requireManageAgent,
} from './agent-access';
import { actorId, type Principal } from './principal';

/**
 * Agent 软归档是列举面可见性标记：管理列表、好友列表、群成员/待确认邀请
 * 与网页成员候选默认隐藏；`network_agents_get` 详情、direct 会话对端与
 * 历史消息保留。网页只提供已归档列表的恢复入口，不提供 Agents 管理/归档界面。
 * 不得用 `archived_at` 拒绝消息、登录、投递或凭据，也不写 events/outbox、
 * 不改变 `pending_count`、`rooms.head_seq` 或在线状态。
 *
 * 归档/取消归档属于 `agent.management.write`：只有 active manager 或持有
 * `manage_agent` 委托的 human 可调用，事务内重放权限与权限版本 guard。
 */

export interface AgentArchiveResult {
  actor_id: string;
  archived: true;
  archived_at: string;
  archived_by: string;
}

export interface AgentUnarchiveResult {
  actor_id: string;
  archived: false;
  archived_at: null;
  archived_by: null;
}

export interface AgentSummary {
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
}

export interface AgentsGetResult {
  items: AgentSummary[];
  missing_actor_ids: string[];
}

/** 对外摘要不包含 metadata、凭据、token 或 MCP URL。 */
export function agentSummaryView(actor: ActorManagementRow, origin: string): AgentSummary {
  return {
    actor_id: actor.actor_id,
    kind: 'agent',
    name: actor.name,
    agent_session_id: actor.agent_session_id,
    share_url: agentShareUrl(actor, origin),
    archived: actor.archived_at !== null,
    archived_at: actor.archived_at === null ? null : String(actor.archived_at),
    archived_by: actor.archived_by,
    disabled: actor.disabled_at !== null,
    disabled_at: actor.disabled_at === null ? null : String(actor.disabled_at),
    disabled_by: actor.disabled_by,
    disabled_reason: actor.disabled_reason,
  };
}

/** 软归档；重复归档保留首次 `archived_at` / `archived_by`，可逆且不删除数据。 */
export async function archiveAgent(
  db: D1Database,
  principal: Principal,
  input: AgentArchiveInput,
): Promise<AgentArchiveResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const target = await requireAgentTarget(db, input.actor_id);
  const payloadHash = await sha256Hex(stableStringify(input));
  // 归档结果不含秘密；同一 request_id 改参数先收敛为 IDEMPOTENCY_CONFLICT，
  // 保持幂等语义。真正的新写入仍由事务内 guard 重新授权。
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) return replay.result as AgentArchiveResult;
  await requireManageAgent(db, principal, input.actor_id, at);
  const result: AgentArchiveResult = {
    actor_id: target.actor_id,
    archived: true,
    archived_at: String(target.archived_at ?? at),
    archived_by: target.archived_by ?? caller,
  };
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
        .prepare(
          `UPDATE actors SET archived_at = COALESCE(archived_at, ?),
             archived_by = COALESCE(archived_by, ?), updated_at = ?
           WHERE actor_id = ? AND kind = 'agent'`,
        )
        .bind(at, caller, at, target.actor_id),
    ],
  });

  return result;
}

/** 取消归档；重复调用收敛为未归档，不影响任何聊天或凭据状态。 */
export async function unarchiveAgent(
  db: D1Database,
  principal: Principal,
  input: AgentUnarchiveInput,
): Promise<AgentUnarchiveResult> {
  const caller = actorId(principal);
  const at = nowMs();
  const target = await requireAgentTarget(db, input.actor_id);
  const payloadHash = await sha256Hex(stableStringify(input));
  // 与归档一致：非秘密结果先按 request_id 重放，新写入再走事务 guard。
  const replay = await resolveReplay(db, caller, input.request_id, payloadHash);
  if (replay.found) return replay.result as AgentUnarchiveResult;
  await requireManageAgent(db, principal, input.actor_id, at);
  const result: AgentUnarchiveResult = {
    actor_id: target.actor_id,
    archived: false,
    archived_at: null,
    archived_by: null,
  };
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
        .prepare(
          `UPDATE actors SET archived_at = NULL, archived_by = NULL, updated_at = ?
           WHERE actor_id = ? AND kind = 'agent'`,
        )
        .bind(at, target.actor_id),
    ],
  });

  return result;
}

/**
 * 按已知 actor_id 批量读取 Agent 摘要；不分页、不做全局枚举。
 *
 * 重复 ID 去重并保持首次出现顺序；不存在或非 Agent 的 ID 进入
 * `missing_actor_ids`，不泄露其类型或名称。
 */
export async function agentsGet(
  db: D1Database,
  principal: Principal,
  input: AgentsGetInput,
  origin: string,
): Promise<AgentsGetResult> {
  actorId(principal);
  const lookup: string[] = [];
  const seen = new Set<string>();
  for (const id of input.actor_ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    lookup.push(id);
  }

  const rows = await getActorManagementByIds(db, lookup);
  const byId = new Map(rows.map((row) => [row.actor_id, row]));
  const items: AgentSummary[] = [];
  const missing: string[] = [];
  for (const id of lookup) {
    const row = byId.get(id);
    if (!row || row.kind !== 'agent') {
      missing.push(id);
      continue;
    }
    items.push(agentSummaryView(row, origin));
  }

  return { items, missing_actor_ids: missing };
}

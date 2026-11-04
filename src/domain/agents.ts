import { BusinessError } from '../contracts/errors';
import type {
  AgentArchiveInput,
  AgentUnarchiveInput,
  AgentsGetInput,
} from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { getActor, getActorsByIds } from '../storage/queries';
import type { ActorRow } from '../storage/rows';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';

/**
 * Agent 软归档是纯管理列表标记：只影响 `network_agents_get` 返回的归档状态；
 * 网页不提供 Agents 管理入口。不得用 `archived_at` 拒绝消息、登录、投递或凭据，
 * 也不写 events/outbox、不改变 `pending_count`、`rooms.head_seq` 或在线状态。
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
}

export interface AgentsGetResult {
  items: AgentSummary[];
  missing_actor_ids: string[];
}

function shareUrl(actor: ActorRow, origin: string): string | null {
  return actor.agent_session_id
    ? `${origin}/a/${encodeURIComponent(actor.agent_session_id)}`
    : null;
}

/** 对外摘要不包含 metadata、凭据、token 或 MCP URL。 */
export function agentSummaryView(actor: ActorRow, origin: string): AgentSummary {
  return {
    actor_id: actor.actor_id,
    kind: 'agent',
    name: actor.name,
    agent_session_id: actor.agent_session_id,
    share_url: shareUrl(actor, origin),
    archived: actor.archived_at !== null,
    archived_at: actor.archived_at === null ? null : String(actor.archived_at),
    archived_by: actor.archived_by,
  };
}

/** 归档目标必须是已存在的 Agent；权限与 `network_agent_rename` 一致，不做所有权检查。 */
async function requireAgentTarget(db: D1Database, targetId: string): Promise<ActorRow> {
  const target = await getActor(db, targetId);
  if (!target) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  if (target.kind !== 'agent') {
    throw new BusinessError('INVALID_ARGUMENT', '只能归档 agent actor');
  }
  return target;
}

/** 软归档；重复归档保留首次 `archived_at` / `archived_by`，可逆且不删除数据。 */
export async function archiveAgent(
  db: D1Database,
  principal: Principal,
  input: AgentArchiveInput,
): Promise<AgentArchiveResult> {
  const caller = actorId(principal);
  const target = await requireAgentTarget(db, input.actor_id);
  const at = nowMs();
  const result: AgentArchiveResult = {
    actor_id: target.actor_id,
    archived: true,
    archived_at: String(target.archived_at ?? at),
    archived_by: target.archived_by ?? caller,
  };
  const payloadHash = await sha256Hex(stableStringify(input));

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
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
  const target = await requireAgentTarget(db, input.actor_id);
  const at = nowMs();
  const result: AgentUnarchiveResult = {
    actor_id: target.actor_id,
    archived: false,
    archived_at: null,
    archived_by: null,
  };
  const payloadHash = await sha256Hex(stableStringify(input));

  await runIdempotent(db, {
    actorId: caller,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, input.request_id, payloadHash, resultJson, at),
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

  const rows = await getActorsByIds(db, lookup);
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

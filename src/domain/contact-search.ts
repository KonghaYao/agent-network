import { BusinessError } from '../contracts/errors';
import { clampPage, LIMITS } from '../contracts/limits';
import type { ContactSearchInput } from '../contracts/schemas';
import { nowMs, utf8Bytes } from '../storage/db';
import type { ActorRow } from '../storage/rows';
import { MANAGE_AGENT_SCOPE } from './agent-access';
import { actorView, type ContactActorView } from './contact-relations';
import { actorId, type Principal } from './principal';

/**
 * 好友搜索列出可申请的人类，以及调用者已经能看到的 Agent。
 *
 * 人类沿用全局按名发现；Agent 只允许从已有的可见入口进入搜索：
 * 共享活跃房间、管理/受托管理、已有好友关系或待处理申请。这样不会把
 * 私人 Agent 变成全局可枚举的名字目录，也避免归档 Agent 重新出现在
 * 列举结果中。搜索结果不授予任何读取或发消息权限；actor_id 只是让用户
 * 在同名结果中核对目标，真正建联仍必须走 contact request → 对方 accept。
 * 双向拉黑会把目标从结果中隐藏，避免借搜索确认对方是否仍存在。
 */

export interface ContactSearchPendingRequest {
  contact_request_id: string;
  direction: 'incoming' | 'outgoing';
}

export interface ContactSearchItem {
  actor: ContactActorView;
  relation: 'active' | 'none';
  pending_request: ContactSearchPendingRequest | null;
}

export interface ContactSearchResult {
  items: ContactSearchItem[];
  truncated: boolean;
}

interface ContactSearchRow extends ActorRow {
  relation_status: 'active' | null;
  pending_request_id: string | null;
  pending_from_actor_id: string | null;
}

const WHITESPACE = /[\s\u00a0\u3000]+/gu;

/**
 * 输入法常见差异统一为 NFKC + 折叠空白：
 * 全角字母/数字、全角空格、连续空格与首尾空格都不再影响匹配。
 */
function normalizeQuery(raw: string): string {
  return raw.normalize('NFKC').replace(WHITESPACE, ' ').trim();
}

/** 再移除全部空白，兼容「网页访客 5c3d」与「网页访客5c3d」这类写法。 */
function compactQuery(normalized: string): string {
  return normalized.replace(WHITESPACE, '');
}

/**
 * 名称侧的空白折叠。名称禁止控制字符，所以只需处理普通空格、NBSP 与
 * 全角空格；SQLite 没有 NFKC，全角字母仍按原字节匹配。
 */
const COMPACT_NAME_SQL = `replace(replace(replace(replace(a.name, ' ', ''), char(9), ''), char(160), ''), char(12288), '')`;

export async function contactSearch(
  db: D1Database,
  principal: Principal,
  input: ContactSearchInput,
): Promise<ContactSearchResult> {
  const viewer = actorId(principal);
  const query = normalizeQuery(input.query);
  if (!query) {
    throw new BusinessError('INVALID_ARGUMENT', '请输入用户名');
  }
  if (utf8Bytes(query) > LIMITS.actorNameBytes) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      `用户名搜索词超过 ${LIMITS.actorNameBytes} 字节`,
    );
  }
  const compact = compactQuery(query);

  const limit = clampPage(
    input.limit,
    LIMITS.contactSearchPageDefault,
    LIMITS.contactSearchPageMax,
  );
  const rows = await db
    .prepare(
      `SELECT a.*,
              relation.status AS relation_status,
              pending.contact_request_id AS pending_request_id,
              pending.from_actor_id AS pending_from_actor_id
         FROM actors a
         LEFT JOIN contact_relations relation
           ON relation.pair_key = CASE
                WHEN ? < a.actor_id THEN ? || '|' || a.actor_id
                ELSE a.actor_id || '|' || ?
              END
          AND relation.status = 'active'
         LEFT JOIN contact_requests pending
           ON pending.pair_key = CASE
                WHEN ? < a.actor_id THEN ? || '|' || a.actor_id
                ELSE a.actor_id || '|' || ?
              END
          AND pending.status = 'pending'
          AND pending.expires_at > ?
        WHERE a.actor_id <> ?
          AND a.disabled_at IS NULL
          AND (
            a.kind = 'human'
            OR (
              a.kind = 'agent'
              AND a.archived_at IS NULL
              AND (
                relation.status = 'active'
                OR pending.contact_request_id IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM agent_managements management
                   WHERE management.agent_id = a.actor_id
                     AND management.manager_id = ?
                     AND management.status = 'active'
                )
                OR EXISTS (
                  SELECT 1 FROM agent_delegations delegation
                   WHERE delegation.agent_id = a.actor_id
                     AND delegation.delegate_actor_id = ?
                     AND delegation.status = 'active'
                     AND (delegation.expires_at IS NULL OR delegation.expires_at > ?)
                     AND delegation.scopes_json LIKE '%"${MANAGE_AGENT_SCOPE}"%'
                )
                OR EXISTS (
                  SELECT 1
                    FROM room_members viewer_membership
                    JOIN room_members target_membership
                      ON target_membership.room_id = viewer_membership.room_id
                     AND target_membership.actor_id = a.actor_id
                     AND target_membership.status = 'active'
                    JOIN rooms shared_room
                      ON shared_room.room_id = viewer_membership.room_id
                     AND shared_room.dissolved_at IS NULL
                   WHERE viewer_membership.actor_id = ?
                     AND viewer_membership.status = 'active'
                )
              )
            )
          )
          AND (
            instr(lower(a.name), lower(?)) > 0
            OR instr(lower(${COMPACT_NAME_SQL}), lower(?)) > 0
          )
          AND NOT EXISTS (
            SELECT 1
              FROM contact_blocks blocked
             WHERE blocked.released_at IS NULL
               AND (
                 (blocked.blocker_actor_id = ? AND blocked.blocked_actor_id = a.actor_id)
                 OR
                 (blocked.blocker_actor_id = a.actor_id AND blocked.blocked_actor_id = ?)
               )
          )
        ORDER BY CASE
                   WHEN lower(a.name) = lower(?) THEN 0
                   WHEN lower(${COMPACT_NAME_SQL}) = lower(?) THEN 1
                   ELSE 2
                 END ASC,
                 length(a.name) ASC,
                 lower(a.name) ASC,
                 a.actor_id ASC
        LIMIT ?`,
    )
    .bind(
      viewer,
      viewer,
      viewer,
      viewer,
      viewer,
      viewer,
      nowMs(),
      viewer,
      viewer,
      viewer,
      nowMs(),
      viewer,
      query,
      compact,
      viewer,
      viewer,
      query,
      compact,
      limit + 1,
    )
    .all<ContactSearchRow>();

  const page = rows.results.slice(0, limit);
  return {
    items: page.map((row) => ({
      actor: actorView(row),
      relation: row.relation_status === 'active' ? 'active' : 'none',
      pending_request: row.pending_request_id
        ? {
            contact_request_id: row.pending_request_id,
            direction: row.pending_from_actor_id === viewer ? 'outgoing' : 'incoming',
          }
        : null,
    })),
    truncated: rows.results.length > limit,
  };
}

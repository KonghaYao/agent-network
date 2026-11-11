import { BusinessError } from '../contracts/errors';
import { clampPage, LIMITS } from '../contracts/limits';
import type { ContactSearchInput } from '../contracts/schemas';
import { nowMs, utf8Bytes } from '../storage/db';
import type { ActorRow } from '../storage/rows';
import { actorView, type ContactActorView } from './contact-relations';
import { actorId, type Principal } from './principal';

/**
 * 好友搜索只列出可申请的人类身份。
 *
 * 搜索结果不授予任何读取或发消息权限；actor_id 只是让用户在同名结果中
 * 核对目标，真正建联仍必须走 contact request → 对方 accept。双向拉黑会把
 * 目标从结果中隐藏，避免借搜索确认对方是否仍存在。
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

export async function contactSearch(
  db: D1Database,
  principal: Principal,
  input: ContactSearchInput,
): Promise<ContactSearchResult> {
  const viewer = actorId(principal);
  const query = input.query.trim();
  if (utf8Bytes(query) > LIMITS.actorNameBytes) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      `用户名搜索词超过 ${LIMITS.actorNameBytes} 字节`,
    );
  }

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
        WHERE a.kind = 'human'
          AND a.actor_id <> ?
          AND a.disabled_at IS NULL
          AND instr(lower(a.name), lower(?)) > 0
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
        ORDER BY CASE WHEN lower(a.name) = lower(?) THEN 0 ELSE 1 END ASC,
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
      query,
      viewer,
      viewer,
      query,
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

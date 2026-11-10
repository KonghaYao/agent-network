import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  ContactAddInput,
  ContactRemoveInput,
  ContactsListInput,
} from '../contracts/schemas';
import { nowMs, sha256Hex, stableStringify } from '../storage/db';
import { getActor, getActorBySession, visibleActorSql } from '../storage/queries';
import type { ActorRow, ContactRow } from '../storage/rows';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';
import { endRelationStatements, getActiveRelation } from './contact-relations';
import { actorId, type Principal } from './principal';

export interface ContactView {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  agent_session_id: string | null;
  relation: 'active' | 'none';
  created_at: string;
}

export interface ContactPage {
  items: ContactView[];
  next_cursor: string | null;
  has_more: boolean;
}

function contactView(
  actor: ActorRow,
  createdAt: number,
  relation: 'active' | 'none',
): ContactView {
  return {
    actor_id: actor.actor_id,
    kind: actor.kind,
    name: actor.name,
    agent_session_id: actor.agent_session_id,
    relation,
    created_at: String(createdAt),
  };
}

interface ContactJoinRow extends ActorRow {
  contact_created_at: number;
  relation_status: 'active' | null;
}

/** 好友分页：按 (created_at DESC, target_actor_id ASC) 的复合 keyset。 */
export async function contactsList(
  db: D1Database,
  principal: Principal,
  input: ContactsListInput,
): Promise<ContactPage> {
  const owner = actorId(principal);
  const scope = `contacts:${owner}`;
  const limit = clampPage(input.limit, LIMITS.historyPageDefault, LIMITS.historyPageMax);
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;

  const where = cursor
    ? 'c.owner_actor_id = ? AND (c.created_at < ? OR (c.created_at = ? AND c.target_actor_id > ?))'
    : 'c.owner_actor_id = ?';
  const binds: unknown[] = cursor
    ? [owner, cursor.seq, cursor.seq, cursor.key ?? '']
    : [owner];
  const rows = await db
    .prepare(
      `SELECT a.*, c.created_at AS contact_created_at,
              r.status AS relation_status
         FROM contacts c
         JOIN actors a ON a.actor_id = c.target_actor_id
         LEFT JOIN contact_relations r
           ON r.pair_key = CASE
                WHEN c.owner_actor_id < c.target_actor_id
                  THEN c.owner_actor_id || '|' || c.target_actor_id
                ELSE c.target_actor_id || '|' || c.owner_actor_id
              END
          AND r.status = 'active'
        WHERE ${where} AND ${visibleActorSql('a')}
        ORDER BY c.created_at DESC, c.target_actor_id ASC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<ContactJoinRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  return {
    items: page.map((row) =>
      contactView(row, row.contact_created_at, row.relation_status === 'active' ? 'active' : 'none'),
    ),
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.contact_created_at,
            key: last.actor_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

async function resolveTarget(
  db: D1Database,
  input: ContactAddInput,
): Promise<ActorRow> {
  const hasId = typeof input.actor_id === 'string';
  const hasSession = typeof input.agent_session_id === 'string';
  if (hasId === hasSession) {
    throw new BusinessError('INVALID_ARGUMENT', 'actor_id 与 agent_session_id 必须且只能提供一个');
  }
  const actor = hasId
    ? await getActor(db, input.actor_id as string)
    : await getActorBySession(db, input.agent_session_id as string);
  if (!actor) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  return actor;
}

/** 幂等建立单侧个人收藏；不代表对方同意，也不产生双向关系。 */
export async function contactAdd(
  db: D1Database,
  principal: Principal,
  input: ContactAddInput,
): Promise<{ contact: ContactView }> {
  const owner = actorId(principal);
  const target = await resolveTarget(db, input);
  if (target.actor_id === owner) {
    throw new BusinessError('INVALID_ARGUMENT', '不能把自己添加为好友');
  }

  const at = nowMs();
  const [existing, relationBefore] = await Promise.all([
    db
      .prepare('SELECT * FROM contacts WHERE owner_actor_id = ? AND target_actor_id = ?')
      .bind(owner, target.actor_id)
      .first<ContactRow>(),
    getActiveRelation(db, owner, target.actor_id),
  ]);
  const payloadHash = await sha256Hex(stableStringify(input));
  const result = {
    contact: contactView(target, existing?.created_at ?? at, relationBefore ? 'active' : 'none'),
  };
  await runIdempotent(db, {
    actorId: owner,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          `INSERT INTO contacts (owner_actor_id, target_actor_id, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT(owner_actor_id, target_actor_id) DO NOTHING`,
        )
        .bind(owner, target.actor_id, at),
    ],
  });

  return result;
}

/** 删除个人收藏，并结束双方共享关系；历史消息保留。 */
export async function contactRemove(
  db: D1Database,
  principal: Principal,
  input: ContactRemoveInput,
): Promise<{ actor_id: string; removed: true }> {
  const owner = actorId(principal);
  const target = await getActor(db, input.actor_id);
  if (!target) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const result = { actor_id: input.actor_id, removed: true as const };
  await runIdempotent(db, {
    actorId: owner,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
      db
        .prepare('DELETE FROM contacts WHERE owner_actor_id = ? AND target_actor_id = ?')
        .bind(owner, input.actor_id),
      ...endRelationStatements(db, owner, target, input.request_id, at),
    ],
  });
  return result;
}

/** 事务内校验双向好友关系；单侧 contacts 收藏不算同意。 */
export async function areContacts(
  db: D1Database,
  owner: string,
  target: string,
): Promise<boolean> {
  return (await getActiveRelation(db, owner, target)) !== null;
}

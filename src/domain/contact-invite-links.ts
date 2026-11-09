import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type {
  ContactLinkCreateInput,
  ContactLinkListInput,
  ContactLinkPreviewInput,
  ContactLinkRedeemInput,
  ContactLinkRevokeInput,
} from '../contracts/schemas';
import { newId, nowMs, randomToken, sha256Hex, sortedPairKey, stableStringify } from '../storage/db';
import { guardSql } from '../storage/guards';
import { getActor } from '../storage/queries';
import type { ActorRow, ContactInviteLinkRow } from '../storage/rows';
import {
  operationsStatement,
  resolveReplay,
  runIdempotent,
} from '../storage/transactions/runner';
import { contactBlockGuardStatement, isBlockedBetween } from './contact-blocks';
import {
  actorView,
  activateRelationStatements,
  getActiveRelation,
  getRelationByPair,
  notificationStatements,
  relationView,
  type ContactActorView,
  type ContactRelationView,
} from './contact-relations';
import { actorId, type Principal } from './principal';

/**
 * 好友邀请链接：A 生成一次性链接，B 打开并登录后直接建立双向好友关系。
 *
 * 与设备配对、群邀请链接一致：token 明文只在首次创建响应出现一次，服务端
 * 只保存带域分隔前缀的 SHA-256 摘要，`operations.result_json` 只保存非秘密
 * 的状态快照。兑换不创建 `contact_requests`，不要求审批，直接复用
 * `contact_relations` / `contacts` 的事务；不产生 delivery、不增加
 * `pending_count`、不推进房间 `head_seq`。
 */

export type ContactLinkStatus = 'pending' | 'used' | 'revoked' | 'expired';

export interface ContactLinkView {
  link_id: string;
  status: ContactLinkStatus;
  created_at: string;
  expires_at: string;
  used_by: ContactActorView | null;
  used_at: string | null;
  revoked_at: string | null;
  can_revoke: boolean;
}

export interface ContactLinkCreateResult {
  link: ContactLinkView;
  share_url: string;
}

export interface ContactLinkPreviewResult {
  valid: boolean;
  status: ContactLinkStatus | 'invalid';
  owner: ContactActorView | null;
  expires_at: string | null;
  reason: 'invalid' | 'expired' | 'used' | 'revoked' | null;
}

export interface ContactLinkRedeemResult {
  link_id: string;
  owner: ContactActorView;
  relation: ContactRelationView;
  already_friends: boolean;
}

export interface ContactLinkRevokeResult {
  link: ContactLinkView;
  already_revoked: boolean;
}

export interface ContactLinkListResult {
  items: ContactLinkView[];
}

interface ContactLinkJoinRow extends ContactInviteLinkRow {
  used_by_name: string | null;
  used_by_kind: 'human' | 'agent' | null;
  used_by_session: string | null;
}

/** 只在数据库保存摘要；前缀避免与其他 token 摘要跨用途复用。 */
function contactLinkHash(token: string): Promise<string> {
  return sha256Hex(`agent-network:contact-link:${token}`);
}

function effectiveStatus(row: ContactInviteLinkRow, at: number): ContactLinkStatus {
  if (row.status === 'pending' && row.expires_at <= at) return 'expired';
  return row.status;
}

function usedByView(row: ContactLinkJoinRow): ContactActorView | null {
  if (!row.used_by || !row.used_by_name || !row.used_by_kind) return null;
  return {
    actor_id: row.used_by,
    kind: row.used_by_kind,
    name: row.used_by_name,
    agent_session_id: row.used_by_session,
  };
}

function linkView(row: ContactLinkJoinRow, viewer: string, at: number): ContactLinkView {
  const status = effectiveStatus(row, at);
  return {
    link_id: row.link_id,
    status,
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    used_by: usedByView(row),
    used_at: row.used_at === null ? null : String(row.used_at),
    revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
    can_revoke: status === 'pending' && row.owner_actor_id === viewer,
  };
}

/** 错误只携带原因与链接定位，不包含 token 或摘要。 */
function linkError(reason: 'invalid' | 'expired' | 'used' | 'revoked'): BusinessError {
  const messages = {
    invalid: '好友链接无效：链接不存在或已被删除',
    expired: '好友链接已过期：请让对方重新生成',
    used: '好友链接已被使用：每个链接只能添加一次好友',
    revoked: '好友链接已被撤销：请让对方重新生成',
  } as const;
  return new BusinessError('CONTACT_LINK_INVALID', messages[reason], { reason });
}

async function getLinkById(db: D1Database, linkId: string): Promise<ContactInviteLinkRow | null> {
  return db
    .prepare('SELECT * FROM contact_invite_links WHERE link_id = ?')
    .bind(linkId)
    .first<ContactInviteLinkRow>();
}

async function getLinkByTokenHash(
  db: D1Database,
  tokenHash: string,
): Promise<ContactInviteLinkRow | null> {
  return db
    .prepare('SELECT * FROM contact_invite_links WHERE token_hash = ?')
    .bind(tokenHash)
    .first<ContactInviteLinkRow>();
}

/** 惰性过期只改状态，不发事件、不触碰关系与投递。 */
async function expireOwnerLinks(db: D1Database, owner: string, at: number): Promise<void> {
  await db
    .prepare(
      `UPDATE contact_invite_links
          SET status = 'expired', updated_at = ?
        WHERE owner_actor_id = ? AND status = 'pending' AND expires_at <= ?`,
    )
    .bind(at, owner, at)
    .run();
}

async function expireLink(db: D1Database, linkId: string, at: number): Promise<void> {
  await db
    .prepare(
      `UPDATE contact_invite_links
          SET status = 'expired', updated_at = ?
        WHERE link_id = ? AND status = 'pending' AND expires_at <= ?`,
    )
    .bind(at, linkId, at)
    .run();
}

async function recordOnly(
  db: D1Database,
  owner: string,
  requestId: string,
  payloadHash: string,
  result: ContactLinkRedeemResult | ContactLinkRevokeResult,
  at: number,
): Promise<unknown> {
  return runIdempotent(db, {
    actorId: owner,
    requestId,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, owner, requestId, payloadHash, resultJson, at),
    ],
  });
}

/** 生成链接；同一 request_id 重放不能恢复明文，统一返回 TOKEN_NOT_REPLAYABLE。 */
export async function contactLinkCreate(
  db: D1Database,
  principal: Principal,
  input: ContactLinkCreateInput,
  origin: string,
): Promise<ContactLinkCreateResult> {
  const owner = actorId(principal);
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, owner, input.request_id, payloadHash);
  if (replay.found) {
    throw new BusinessError(
      'TOKEN_NOT_REPLAYABLE',
      '好友链接明文只在首次创建响应出现；请生成新链接，或在列表中查看已有链接状态',
    );
  }

  await expireOwnerLinks(db, owner, at);
  const linkId = newId('clink');
  const token = randomToken(LIMITS.contactLinkKeyBytes);
  const tokenHash = await contactLinkHash(token);
  const expiresAt = at + (input.expires_in_ms ?? LIMITS.contactLinkTtlMs);
  const view: ContactLinkView = {
    link_id: linkId,
    status: 'pending',
    created_at: String(at),
    expires_at: String(expiresAt),
    used_by: null,
    used_at: null,
    revoked_at: null,
    can_revoke: true,
  };
  // 只在内存与首次响应中出现 share_url；result_json 只存 link 快照。
  const safeResult = { link: view };
  const outcome = await runIdempotent(db, {
    actorId: owner,
    requestId: input.request_id,
    payloadHash,
    result: safeResult,
    build: (resultJson) => [
      operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
      // 过期行已在事务前标记；这里仍按 pending 且未过期计数，避免并发绕过上限。
      db
        .prepare(
          guardSql(
            'contactLinkLimit',
            `(SELECT COUNT(*) FROM contact_invite_links
               WHERE owner_actor_id = ? AND status = 'pending' AND expires_at > ?) >= ?`,
          ),
        )
        .bind(owner, at, LIMITS.contactLinkPendingMax),
      db
        .prepare(
          `INSERT INTO contact_invite_links
             (link_id, owner_actor_id, token_hash, status, expires_at,
              used_by, used_at, created_at, updated_at, revoked_at, revoked_by)
           VALUES (?, ?, ?, 'pending', ?, NULL, NULL, ?, ?, NULL, NULL)`,
        )
        .bind(linkId, owner, tokenHash, expiresAt, at, at),
    ],
  });
  // 并发同 request_id 已提交时返回的是解析后的非秘密快照；不能再次返回明文。
  if (outcome !== safeResult) {
    throw new BusinessError(
      'TOKEN_NOT_REPLAYABLE',
      '好友链接明文只在首次创建响应出现；请生成新链接，或在列表中查看已有链接状态',
    );
  }
  const base = origin.replace(/\/+$/u, '');
  return { link: view, share_url: `${base}/#friend=${token}` };
}

/**
 * 无鉴权预览：未登录页面先确认链接可用，再决定是否创建新身份。
 *
 * 只返回链接状态与邀请人展示信息，不返回摘要、used_by 或任何 token；
 * 无效 token 不是业务错误，调用方据此显示明确提示且不自动注册。
 */
export async function contactLinkPreview(
  db: D1Database,
  input: ContactLinkPreviewInput,
): Promise<ContactLinkPreviewResult> {
  const row = await getLinkByTokenHash(db, await contactLinkHash(input.token));
  if (!row) {
    return { valid: false, status: 'invalid', owner: null, expires_at: null, reason: 'invalid' };
  }
  const owner = await getActor(db, row.owner_actor_id);
  if (!owner) {
    return { valid: false, status: 'invalid', owner: null, expires_at: null, reason: 'invalid' };
  }
  const at = nowMs();
  const status = effectiveStatus(row, at);
  return {
    valid: status === 'pending',
    status,
    owner: actorView(owner),
    expires_at: String(row.expires_at),
    reason: status === 'pending' ? null : status,
  };
}

/**
 * 兑换链接：直接建立双向 active 关系，不创建申请、不要求审批。
 *
 * 已存在 active 关系时幂等返回 already_friends，不消费链接；链接仍可给
 * 真正的新好友使用。自己、拉黑、过期/已用/已撤销分别返回明确错误。
 */
export async function contactLinkRedeem(
  db: D1Database,
  principal: Principal,
  input: ContactLinkRedeemInput,
): Promise<ContactLinkRedeemResult> {
  const owner = actorId(principal);
  const caller = principal.actor ?? (await getActor(db, owner));
  if (!caller) throw new BusinessError('NOT_FOUND', 'actor 不存在');
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, owner, input.request_id, payloadHash);
  if (replay.found) return replay.result as ContactLinkRedeemResult;

  const row = await getLinkByTokenHash(db, await contactLinkHash(input.token));
  if (!row) throw linkError('invalid');
  if (row.owner_actor_id === owner) {
    throw new BusinessError('INVALID_ARGUMENT', '不能兑换自己的好友链接');
  }
  const status = effectiveStatus(row, at);
  if (status === 'pending' && row.status === 'pending' && row.expires_at <= at) {
    await expireLink(db, row.link_id, at);
  }
  if (status !== 'pending') throw linkError(status);

  const ownerActor = await getActor(db, row.owner_actor_id);
  if (!ownerActor) throw linkError('invalid');
  if (await isBlockedBetween(db, owner, ownerActor.actor_id)) {
    throw new BusinessError('BLOCKED', '你们之间存在拉黑关系，无法添加好友');
  }

  const existing = await getActiveRelation(db, owner, ownerActor.actor_id);
  if (existing) {
    const result: ContactLinkRedeemResult = {
      link_id: row.link_id,
      owner: actorView(ownerActor),
      relation: relationView(existing),
      already_friends: true,
    };
    return (await recordOnly(
      db,
      owner,
      input.request_id,
      payloadHash,
      result,
      at,
    )) as ContactLinkRedeemResult;
  }

  const pairKey = sortedPairKey(owner, ownerActor.actor_id);
  const prior = await getRelationByPair(db, pairKey);
  const result: ContactLinkRedeemResult = {
    link_id: row.link_id,
    owner: actorView(ownerActor),
    relation: {
      pair_key: pairKey,
      actor_ids: [owner, ownerActor.actor_id].sort(),
      status: 'active',
      source: 'invite_link',
      created_at: prior ? String(prior.created_at) : String(at),
      updated_at: String(at),
      ended_at: null,
    },
    already_friends: false,
  };
  try {
    await runIdempotent(db, {
      actorId: owner,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
        // 拉黑与链接状态都在同一事务内裁决，避免预检后并发绕过。
        contactBlockGuardStatement(db, owner, ownerActor.actor_id),
        db
          .prepare(
            guardSql(
              'contactLinkInvalid',
              `NOT EXISTS (
                 SELECT 1 FROM contact_invite_links
                  WHERE link_id = ? AND status = 'pending' AND expires_at > ?
               )`,
            ),
          )
          .bind(row.link_id, at),
        db
          .prepare(
            `UPDATE contact_invite_links
                SET status = 'used', used_by = ?, used_at = ?, updated_at = ?
              WHERE link_id = ? AND status = 'pending' AND expires_at > ?`,
          )
          .bind(owner, at, at, row.link_id, at),
        ...activateRelationStatements(
          db,
          owner,
          ownerActor.actor_id,
          'invite_link',
          row.link_id,
          at,
        ),
        ...notificationStatements(
          db,
          ownerActor,
          {
            eventKey: `contact_link_redeemed:${row.link_id}`,
            eventType: 'contact_link_redeemed',
            refId: row.link_id,
            metadata: {
              link_id: row.link_id,
              pair_key: pairKey,
              actor_id: owner,
              actor_name: caller.name,
            },
          },
          at,
        ),
        ...notificationStatements(
          db,
          caller,
          {
            eventKey: `contact_link_accepted:${row.link_id}:${owner}`,
            eventType: 'contact_link_redeemed',
            refId: row.link_id,
            metadata: {
              link_id: row.link_id,
              pair_key: pairKey,
              owner_actor_id: ownerActor.actor_id,
              owner_name: ownerActor.name,
            },
          },
          at,
        ),
      ],
    });
  } catch (error) {
    if (error instanceof BusinessError && error.code === 'CONTACT_LINK_INVALID') {
      const fresh = await getLinkById(db, row.link_id);
      if (fresh) {
        const freshStatus = effectiveStatus(fresh, at);
        if (freshStatus !== 'pending') throw linkError(freshStatus);
      }
      throw linkError('invalid');
    }
    throw error;
  }
  return result;
}

/** owner 读取自己生成的链接状态；不返回 token 或摘要。 */
export async function contactLinkList(
  db: D1Database,
  principal: Principal,
  input: ContactLinkListInput,
): Promise<ContactLinkListResult> {
  const owner = actorId(principal);
  const at = nowMs();
  await expireOwnerLinks(db, owner, at);
  const rows = await db
    .prepare(
      `SELECT l.*, a.name AS used_by_name, a.kind AS used_by_kind,
              a.agent_session_id AS used_by_session
         FROM contact_invite_links l
         LEFT JOIN actors a ON a.actor_id = l.used_by
        WHERE l.owner_actor_id = ?
        ORDER BY l.created_at DESC, l.link_id DESC
        LIMIT ?`,
    )
    .bind(owner, input.limit ?? LIMITS.contactLinkListDefault)
    .all<ContactLinkJoinRow>();
  return { items: rows.results.map((row) => linkView(row, owner, at)) };
}

/** 只有 owner 可撤销；已使用链接不能撤销，重复撤销幂等返回。 */
export async function contactLinkRevoke(
  db: D1Database,
  principal: Principal,
  input: ContactLinkRevokeInput,
): Promise<ContactLinkRevokeResult> {
  const owner = actorId(principal);
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, owner, input.request_id, payloadHash);
  if (replay.found) return replay.result as ContactLinkRevokeResult;

  const row = await getLinkById(db, input.link_id);
  if (!row) throw new BusinessError('NOT_FOUND', '好友链接不存在');
  if (row.owner_actor_id !== owner) {
    throw new BusinessError('PERMISSION_DENIED', '只有链接创建者可以撤销');
  }
  const status = effectiveStatus(row, at);
  if (status === 'used') {
    throw new BusinessError('CONFLICT', '已被使用的好友链接不能撤销');
  }
  if (status === 'revoked') {
    const already = {
      link: linkView(row as ContactLinkJoinRow, owner, at),
      already_revoked: true,
    };
    return (await recordOnly(
      db,
      owner,
      input.request_id,
      payloadHash,
      already,
      at,
    )) as ContactLinkRevokeResult;
  }

  const view: ContactLinkView = {
    link_id: row.link_id,
    status: 'revoked',
    created_at: String(row.created_at),
    expires_at: String(row.expires_at),
    used_by: null,
    used_at: null,
    revoked_at: String(at),
    can_revoke: false,
  };
  const result: ContactLinkRevokeResult = { link: view, already_revoked: false };
  try {
    await runIdempotent(db, {
      actorId: owner,
      requestId: input.request_id,
      payloadHash,
      result,
      build: (resultJson) => [
        operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
        db
          .prepare(
            guardSql(
              'contactLinkInvalid',
              `NOT EXISTS (
                 SELECT 1 FROM contact_invite_links
                  WHERE link_id = ? AND owner_actor_id = ? AND status = 'pending'
               )`,
            ),
          )
          .bind(row.link_id, owner),
        db
          .prepare(
            `UPDATE contact_invite_links
                SET status = 'revoked', revoked_at = ?, revoked_by = ?, updated_at = ?
              WHERE link_id = ? AND owner_actor_id = ? AND status = 'pending'`,
          )
          .bind(at, owner, at, row.link_id, owner),
      ],
    });
  } catch (error) {
    if (error instanceof BusinessError && error.code === 'CONTACT_LINK_INVALID') {
      const fresh = await getLinkById(db, row.link_id);
      if (fresh && fresh.status === 'revoked') {
        const already = {
          link: linkView(fresh as ContactLinkJoinRow, owner, at),
          already_revoked: true,
        };
        return (await recordOnly(
          db,
          owner,
          input.request_id,
          payloadHash,
          already,
          at,
        )) as ContactLinkRevokeResult;
      }
      if (fresh && effectiveStatus(fresh, at) === 'used') {
        throw new BusinessError('CONFLICT', '已被使用的好友链接不能撤销');
      }
    }
    throw error;
  }
  return result;
}

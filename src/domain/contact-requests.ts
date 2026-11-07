import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  ContactRequestCancelInput,
  ContactRequestInput,
  ContactRequestsListInput,
  ContactRequestRespondInput,
} from '../contracts/schemas';
import { newId, nowMs, sha256Hex, sortedPairKey, stableStringify, utf8Bytes } from '../storage/db';
import { guardSql } from '../storage/guards';
import { getActor } from '../storage/queries';
import type { ActorRow, ContactRequestRow } from '../storage/rows';
import {
  operationsStatement,
  resolveReplay,
  runIdempotent,
} from '../storage/transactions/runner';
import { canHandleRequest, canRespond, effectivePolicy } from './contact-policies';
import {
  actorView,
  activateRelationStatements,
  expireContactRequests,
  expireForPair,
  expireRequestRow,
  getActiveRelation,
  getRelationByPair,
  getRequest,
  isManagerAgentPair,
  isPendingPairConflict,
  joinedRequestView,
  notificationStatements,
  pendingForPair,
  relationView,
  resolveTarget,
  type ContactRelationView,
  type ContactRequestPage,
  type ContactRequestResult,
  type ContactRequestView,
} from './contact-relations';
import { actorId, type Principal } from './principal';

/**
 * 好友申请状态机与列表。
 *
 * A→B pending 与 B→A pending 共享同一个 pair_key，由部分唯一索引收敛；
 * 重复接受使用同一 contact_request_id 作为事件键，事务提交后不会重复通知。
 */

interface ContactRequestJoinRow extends ContactRequestRow {
  from_kind: 'human' | 'agent';
  from_name: string;
  from_session: string | null;
  to_kind: 'human' | 'agent';
  to_name: string;
  to_session: string | null;
}

function requestedView(
  row: ContactRequestRow,
  from: ActorRow,
  to: ActorRow,
  viewer: string,
  options: { canRespond: boolean; canCancel: boolean },
): ContactRequestView {
  return {
    contact_request_id: row.contact_request_id,
    status: row.status,
    direction: row.from_actor_id === viewer ? 'outgoing' : 'incoming',
    message: row.message,
    auto_accepted: row.auto_accepted === 1,
    from_actor: actorView(from),
    to_actor: actorView(to),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    expires_at: String(row.expires_at),
    responded_at: row.responded_at === null ? null : String(row.responded_at),
    responded_by: row.responded_by,
    can_respond: options.canRespond,
    can_cancel: options.canCancel,
  };
}

/** 结果中的申请视图按真实状态计算；列表用 joined 查询避免 N+1。 */
async function liveRequestView(
  db: D1Database,
  row: ContactRequestRow,
  viewer: string,
): Promise<ContactRequestView> {
  const [from, to] = await Promise.all([
    getActor(db, row.from_actor_id),
    getActor(db, row.to_actor_id),
  ]);
  if (!from || !to) throw new BusinessError('NOT_FOUND', '好友申请关联的 actor 不存在');
  const at = nowMs();
  return requestedView(row, from, to, viewer, {
    canRespond: await canRespond(db, viewer, row, to, at),
    canCancel: row.status === 'pending' && row.from_actor_id === viewer,
  });
}

function prebuiltPending(
  contactRequestId: string,
  from: ActorRow,
  to: ActorRow,
  message: string,
  at: number,
  expiresAt: number,
  viewer: string,
): ContactRequestView {
  return requestedView(
    {
      contact_request_id: contactRequestId,
      pair_key: sortedPairKey(from.actor_id, to.actor_id),
      from_actor_id: from.actor_id,
      to_actor_id: to.actor_id,
      message,
      status: 'pending',
      auto_accepted: 0,
      created_at: at,
      updated_at: at,
      expires_at: expiresAt,
      responded_at: null,
      responded_by: null,
    },
    from,
    to,
    viewer,
    { canRespond: false, canCancel: from.actor_id === viewer },
  );
}

function prebuiltAccepted(
  contactRequestId: string,
  from: ActorRow,
  to: ActorRow,
  message: string,
  at: number,
  expiresAt: number,
  viewer: string,
  autoManager: boolean,
): { request: ContactRequestView; relation: ContactRelationView } {
  const pairKey = sortedPairKey(from.actor_id, to.actor_id);
  return {
    request: requestedView(
      {
        contact_request_id: contactRequestId,
        pair_key: pairKey,
        from_actor_id: from.actor_id,
        to_actor_id: to.actor_id,
        message,
        status: 'accepted',
        auto_accepted: 1,
        created_at: at,
        updated_at: at,
        expires_at: expiresAt,
        responded_at: at,
        responded_by: autoManager ? from.actor_id : null,
      },
      from,
      to,
      viewer,
      { canRespond: false, canCancel: false },
    ),
    relation: {
      pair_key: pairKey,
      actor_ids: [from.actor_id, to.actor_id].sort(),
      status: 'active',
      source: autoManager ? 'auto_manager' : 'request',
      created_at: String(at),
      updated_at: String(at),
      ended_at: null,
    },
  };
}

function existingPendingResult(
  request: ContactRequestView,
): ContactRequestResult {
  return {
    request,
    relation: null,
    status: 'pending',
    already_friends: false,
    auto_accepted: false,
  };
}

/**
 * 早返回也走同一 `operations` 机制。
 *
 * `already_friends` 与既有 pending 都不写业务表，但如果不记录首次结果，
 * 外部状态（解除好友、撤销申请）变化后同一 `request_id` 会重新落库，
 * 违反“同一 request_id 返回首次结果”。这里只写 operations，不产生事件。
 */
async function recordEarlyResult(
  db: D1Database,
  owner: string,
  requestId: string,
  payloadHash: string,
  result: ContactRequestResult,
  at: number,
): Promise<ContactRequestResult> {
  return (await runIdempotent(db, {
    actorId: owner,
    requestId,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, owner, requestId, payloadHash, resultJson, at),
    ],
  })) as ContactRequestResult;
}

export async function contactRequest(
  db: D1Database,
  principal: Principal,
  input: ContactRequestInput,
): Promise<ContactRequestResult> {
  const owner = actorId(principal);
  const caller = principal.actor ?? (await getActor(db, owner));
  if (!caller) throw new BusinessError('NOT_FOUND', 'actor 不存在');
  const target = await resolveTarget(db, input);
  if (target.actor_id === owner) {
    throw new BusinessError('INVALID_ARGUMENT', '不能向自己发起好友申请');
  }
  const message = input.message ?? '';
  if (utf8Bytes(message) > LIMITS.contactRequestMessageBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', '好友申请附言超过 512 字节');
  }

  const at = nowMs();
  const pairKey = sortedPairKey(owner, target.actor_id);
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, owner, input.request_id, payloadHash);
  if (replay.found) return replay.result as ContactRequestResult;

  await expireForPair(db, pairKey, at);

  const relation = await getActiveRelation(db, owner, target.actor_id);
  if (relation) {
    return recordEarlyResult(
      db,
      owner,
      input.request_id,
      payloadHash,
      {
        request: null,
        relation: relationView(relation),
        status: 'accepted',
        already_friends: true,
        auto_accepted: false,
      },
      at,
    );
  }

  const existing = await pendingForPair(db, pairKey);
  if (existing) {
    const result = existingPendingResult(await liveRequestView(db, existing, owner));
    return recordEarlyResult(db, owner, input.request_id, payloadHash, result, at);
  }

  const autoManager = await isManagerAgentPair(db, caller, target);
  const policy = autoManager ? null : await effectivePolicy(db, target, at);
  const autoAccept = autoManager || policy?.policy === 'auto_accept';
  const contactRequestId = newId('creq');
  const expiresAt = at + (input.expires_in_ms ?? LIMITS.contactRequestTtlMs);

  if (autoAccept) {
    const prepared = prebuiltAccepted(
      contactRequestId,
      caller,
      target,
      message,
      at,
      expiresAt,
      owner,
      autoManager,
    );
    const result: ContactRequestResult = {
      request: prepared.request,
      relation: prepared.relation,
      status: 'accepted',
      already_friends: false,
      auto_accepted: true,
    };
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
              `INSERT INTO contact_requests
                 (contact_request_id, pair_key, from_actor_id, to_actor_id, message, status,
                  auto_accepted, created_at, updated_at, expires_at, responded_at, responded_by)
               VALUES (?, ?, ?, ?, ?, 'accepted', 1, ?, ?, ?, ?, ?)`,
            )
            .bind(
              contactRequestId,
              pairKey,
              owner,
              target.actor_id,
              message,
              at,
              at,
              expiresAt,
              at,
              autoManager ? owner : null,
            ),
          ...activateRelationStatements(
            db,
            owner,
            target.actor_id,
            autoManager ? 'auto_manager' : 'request',
            contactRequestId,
            at,
          ),
          ...notificationStatements(
            db,
            caller,
            {
              eventKey: `contact_request_accepted:${contactRequestId}`,
              eventType: 'contact_request_accepted',
              refId: contactRequestId,
              metadata: {
                pair_key: pairKey,
                from_actor_id: owner,
                to_actor_id: target.actor_id,
                auto_accepted: true,
              },
            },
            at,
          ),
          ...notificationStatements(
            db,
            target,
            {
              eventKey: `contact_request_accepted_to:${contactRequestId}`,
              eventType: 'contact_request_accepted',
              refId: contactRequestId,
              metadata: {
                pair_key: pairKey,
                from_actor_id: owner,
                to_actor_id: target.actor_id,
                auto_accepted: true,
              },
            },
            at,
          ),
        ],
        onUniqueConflict: async (error) => {
          if (!isPendingPairConflict(error)) return undefined;
          const pending = await pendingForPair(db, pairKey);
          if (!pending) return undefined;
          return existingPendingResult(await liveRequestView(db, pending, owner));
        },
      });
    } catch (error) {
      if (isPendingPairConflict(error)) {
        const pending = await pendingForPair(db, pairKey);
        if (pending) return existingPendingResult(await liveRequestView(db, pending, owner));
      }
      throw error;
    }
    return result;
  }

  const pendingView = prebuiltPending(
    contactRequestId,
    caller,
    target,
    message,
    at,
    expiresAt,
    owner,
  );
  const result = existingPendingResult(pendingView);

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
            `INSERT INTO contact_requests
               (contact_request_id, pair_key, from_actor_id, to_actor_id, message, status,
                auto_accepted, created_at, updated_at, expires_at, responded_at, responded_by)
             VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL, NULL)`,
          )
          .bind(contactRequestId, pairKey, owner, target.actor_id, message, at, at, expiresAt),
        ...notificationStatements(
          db,
          target,
          {
            eventKey: `contact_request_pending:${contactRequestId}`,
            eventType: 'contact_request_pending',
            refId: contactRequestId,
            metadata: {
              pair_key: pairKey,
              from_actor_id: owner,
              to_actor_id: target.actor_id,
              message_bytes: utf8Bytes(message),
            },
          },
          at,
        ),
        ...(policy?.policy === 'manager_approval' && policy.approver
          ? notificationStatements(
              db,
              policy.approver,
              {
                eventKey: `contact_request_review:${contactRequestId}`,
                eventType: 'contact_request_review',
                refId: contactRequestId,
                metadata: {
                  pair_key: pairKey,
                  agent_id: target.actor_id,
                  from_actor_id: owner,
                },
              },
              at,
            )
          : []),
      ],
      onUniqueConflict: async (error) => {
        if (!isPendingPairConflict(error)) return undefined;
        const pending = await pendingForPair(db, pairKey);
        if (!pending) return undefined;
        return existingPendingResult(await liveRequestView(db, pending, owner));
      },
    });
  } catch (error) {
    if (isPendingPairConflict(error)) {
      const pending = await pendingForPair(db, pairKey);
      if (pending) return existingPendingResult(await liveRequestView(db, pending, owner));
    }
    throw error;
  }
  return result;
}

export async function contactRequestsList(
  db: D1Database,
  principal: Principal,
  input: ContactRequestsListInput,
): Promise<ContactRequestPage> {
  const viewer = actorId(principal);
  const at = nowMs();
  await expireContactRequests(db, at);

  const direction = input.direction ?? 'all';
  const limit = clampPage(
    input.limit,
    LIMITS.contactRequestsPageDefault,
    LIMITS.contactRequestsPageMax,
  );
  const scope = `contact_requests:${viewer}:${direction}:${input.status ?? 'all'}`;
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (direction === 'outgoing') {
    where.push('r.from_actor_id = ?');
    binds.push(viewer);
  } else if (direction === 'incoming') {
    where.push(
      `(r.to_actor_id = ?
        OR r.to_actor_id IN (
          SELECT agent_id FROM agent_managements WHERE manager_id = ? AND status = 'active'
        ))`,
    );
    binds.push(viewer, viewer);
  } else {
    where.push(
      `(r.from_actor_id = ? OR r.to_actor_id = ?
        OR r.to_actor_id IN (
          SELECT agent_id FROM agent_managements WHERE manager_id = ? AND status = 'active'
        ))`,
    );
    binds.push(viewer, viewer, viewer);
  }
  if (input.status) {
    where.push('r.status = ?');
    binds.push(input.status);
  }
  if (cursor) {
    where.push('(r.created_at < ? OR (r.created_at = ? AND r.contact_request_id > ?))');
    binds.push(cursor.seq, cursor.seq, cursor.key ?? '');
  }

  const rows = await db
    .prepare(
      `SELECT r.*,
              f.kind AS from_kind, f.name AS from_name, f.agent_session_id AS from_session,
              t.kind AS to_kind, t.name AS to_name, t.agent_session_id AS to_session
         FROM contact_requests r
         JOIN actors f ON f.actor_id = r.from_actor_id
         JOIN actors t ON t.actor_id = r.to_actor_id
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC, r.contact_request_id ASC
        LIMIT ?`,
    )
    .bind(...binds, limit + 1)
    .all<ContactRequestJoinRow>();

  const page = rows.results.slice(0, limit);
  const hasMore = rows.results.length > limit;
  const last = page.at(-1);
  const items: ContactRequestView[] = [];
  for (const row of page) {
    const view = joinedRequestView(row, viewer);
    if (row.status === 'pending') {
      const target = await getActor(db, row.to_actor_id);
      if (target) view.can_respond = await canRespond(db, viewer, row, target, at);
    }
    items.push(view);
  }

  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: 'before',
            seq: last.created_at,
            key: last.contact_request_id,
            snapshot: 0,
          })
        : null,
    has_more: hasMore,
  };
}

async function acceptedResult(
  db: D1Database,
  row: ContactRequestRow,
  viewer: string,
): Promise<ContactRequestResult> {
  const relation = await getRelationByPair(db, row.pair_key);
  return {
    request: await liveRequestView(db, row, viewer),
    relation: relation ? relationView(relation) : null,
    status: row.status,
    already_friends: false,
    auto_accepted: row.auto_accepted === 1,
  };
}

export async function contactRequestRespond(
  db: D1Database,
  principal: Principal,
  input: ContactRequestRespondInput,
): Promise<ContactRequestResult> {
  const viewer = actorId(principal);
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, viewer, input.request_id, payloadHash);
  if (replay.found) return replay.result as ContactRequestResult;

  let row = await getRequest(db, input.contact_request_id);
  if (!row) throw new BusinessError('NOT_FOUND', '好友申请不存在');
  if (row.status === 'pending' && row.expires_at <= at) {
    await expireRequestRow(db, row, at);
    row = await getRequest(db, input.contact_request_id);
    if (!row) throw new BusinessError('NOT_FOUND', '好友申请不存在');
  }

  const target = await getActor(db, row.to_actor_id);
  const requester = await getActor(db, row.from_actor_id);
  if (!target || !requester) {
    throw new BusinessError('NOT_FOUND', '好友申请关联的 actor 不存在');
  }
  if (!(await canHandleRequest(db, viewer, row, target, at))) {
    throw new BusinessError('PERMISSION_DENIED', '当前身份不能处理该好友申请');
  }
  if (row.status === 'expired') {
    throw new BusinessError('REQUEST_EXPIRED', '好友申请已过期');
  }
  if (row.status === 'accepted') {
    if (input.action === 'accept') return acceptedResult(db, row, viewer);
    throw new BusinessError('CONFLICT', '好友申请已接受，不能再拒绝');
  }
  if (row.status !== 'pending') {
    throw new BusinessError('CONFLICT', '好友申请已结束');
  }

  const accept = input.action === 'accept';
  const result: ContactRequestResult = accept
    ? {
        request: requestedView(
          {
            ...row,
            status: 'accepted',
            updated_at: at,
            responded_at: at,
            responded_by: viewer,
            auto_accepted: 0,
          },
          requester,
          target,
          viewer,
          { canRespond: false, canCancel: false },
        ),
        relation: {
          pair_key: row.pair_key,
          actor_ids: [row.from_actor_id, row.to_actor_id].sort(),
          status: 'active',
          source: 'request',
          created_at: String(at),
          updated_at: String(at),
          ended_at: null,
        },
        status: 'accepted',
        already_friends: false,
        auto_accepted: false,
      }
    : {
        request: requestedView(
          {
            ...row,
            status: 'rejected',
            updated_at: at,
            responded_at: at,
            responded_by: viewer,
            auto_accepted: 0,
          },
          requester,
          target,
          viewer,
          { canRespond: false, canCancel: false },
        ),
        relation: null,
        status: 'rejected',
        already_friends: false,
        auto_accepted: false,
      };

  const eventKey = accept
    ? `contact_request_accepted:${row.contact_request_id}`
    : `contact_request_rejected:${row.contact_request_id}`;

  await runIdempotent(db, {
    actorId: viewer,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => {
      const statements: D1PreparedStatement[] = [
        operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, at),
        db
          .prepare(
            guardSql(
              'contactRequestStale',
              accept
                ? `NOT EXISTS (SELECT 1 FROM contact_requests WHERE contact_request_id = ? AND status IN ('pending', 'accepted'))`
                : `NOT EXISTS (SELECT 1 FROM contact_requests WHERE contact_request_id = ? AND status = 'pending')`,
            ),
          )
          .bind(row?.contact_request_id ?? ''),
        db
          .prepare(
            `UPDATE contact_requests
                SET status = ?, updated_at = ?, responded_at = ?, responded_by = ?, auto_accepted = 0
              WHERE contact_request_id = ? AND status = 'pending'`,
          )
          .bind(
            accept ? 'accepted' : 'rejected',
            at,
            at,
            viewer,
            row?.contact_request_id ?? '',
          ),
      ];
      if (accept) {
        statements.push(
          ...activateRelationStatements(
            db,
            row.from_actor_id,
            row.to_actor_id,
            'request',
            row.contact_request_id,
            at,
          ),
        );
      }
      statements.push(
        ...notificationStatements(
          db,
          requester,
          {
            eventKey,
            eventType: accept ? 'contact_request_accepted' : 'contact_request_rejected',
            refId: row.contact_request_id,
            metadata: {
              pair_key: row.pair_key,
              from_actor_id: row.from_actor_id,
              to_actor_id: row.to_actor_id,
              responded_by: viewer,
            },
          },
          at,
        ),
      );
      return statements;
    },
  });

  const stored = await getRequest(db, input.contact_request_id);
  if (!stored) throw new BusinessError('NOT_FOUND', '好友申请不存在');
  return acceptedResult(db, stored, viewer);
}

export async function contactRequestCancel(
  db: D1Database,
  principal: Principal,
  input: ContactRequestCancelInput,
): Promise<ContactRequestResult> {
  const viewer = actorId(principal);
  const at = nowMs();
  const payloadHash = await sha256Hex(stableStringify(input));
  const replay = await resolveReplay(db, viewer, input.request_id, payloadHash);
  if (replay.found) return replay.result as ContactRequestResult;

  let row = await getRequest(db, input.contact_request_id);
  if (!row) throw new BusinessError('NOT_FOUND', '好友申请不存在');
  if (row.from_actor_id !== viewer) {
    throw new BusinessError('PERMISSION_DENIED', '只有申请发起者可以撤销');
  }
  if (row.status === 'pending' && row.expires_at <= at) {
    await expireRequestRow(db, row, at);
    row = await getRequest(db, input.contact_request_id);
    if (!row) throw new BusinessError('NOT_FOUND', '好友申请不存在');
  }
  if (row.status === 'expired') throw new BusinessError('REQUEST_EXPIRED', '好友申请已过期');
  if (row.status === 'cancelled') {
    return {
      request: await liveRequestView(db, row, viewer),
      relation: null,
      status: 'cancelled',
      already_friends: false,
      auto_accepted: false,
    };
  }
  if (row.status !== 'pending') throw new BusinessError('CONFLICT', '好友申请已结束');

  const target = await getActor(db, row.to_actor_id);
  const requester = await getActor(db, row.from_actor_id);
  if (!target || !requester) {
    throw new BusinessError('NOT_FOUND', '好友申请关联的 actor 不存在');
  }
  const result: ContactRequestResult = {
    request: requestedView(
      { ...row, status: 'cancelled', updated_at: at, responded_at: at, responded_by: viewer },
      requester,
      target,
      viewer,
      { canRespond: false, canCancel: false },
    ),
    relation: null,
    status: 'cancelled',
    already_friends: false,
    auto_accepted: false,
  };
  const eventKey = `contact_request_cancelled:${row.contact_request_id}`;

  await runIdempotent(db, {
    actorId: viewer,
    requestId: input.request_id,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, viewer, input.request_id, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'contactRequestStale',
            "NOT EXISTS (SELECT 1 FROM contact_requests WHERE contact_request_id = ? AND status = 'pending')",
          ),
        )
        .bind(row?.contact_request_id ?? ''),
      db
        .prepare(
          `UPDATE contact_requests
              SET status = 'cancelled', updated_at = ?, responded_at = ?, responded_by = ?
            WHERE contact_request_id = ? AND status = 'pending'`,
        )
        .bind(at, at, viewer, row?.contact_request_id ?? ''),
      ...notificationStatements(
        db,
        target,
        {
          eventKey,
          eventType: 'contact_request_cancelled',
          refId: row.contact_request_id,
          metadata: {
            pair_key: row.pair_key,
            from_actor_id: row.from_actor_id,
            to_actor_id: row.to_actor_id,
            responded_by: viewer,
          },
        },
        at,
      ),
    ],
  });

  const stored = await getRequest(db, input.contact_request_id);
  if (!stored) throw new BusinessError('NOT_FOUND', '好友申请不存在');
  return {
    request: await liveRequestView(db, stored, viewer),
    relation: null,
    status: stored.status,
    already_friends: false,
    auto_accepted: false,
  };
}

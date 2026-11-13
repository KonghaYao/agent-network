/** rooms.ts 拆分模块：create。纯移动，行为保持不变。 */

import { BusinessError, type BusinessErrorCode } from '../../contracts/errors';
import { LIMITS } from '../../contracts/limits';
import { type RoomCreateInput } from '../../contracts/schemas';
import { newId, nowMs, sha256Hex, sortedPairKey, stableStringify } from '../../storage/db';
import { eventStatement, inboxChangeStatements, outboxStatement, roomHeadStatement, roomTopic } from '../../storage/events';
import { guardSql } from '../../storage/guards';
import { getActor, getActorRowsByIds } from '../../storage/queries';
import { type ActorRow } from '../../storage/rows';
import { operationsStatement, runIdempotent } from '../../storage/transactions/runner';
import { getActiveManagement } from '../agent-access';
import { isBlockedBetween } from '../contact-blocks';
import { directRelationStatements, getActiveRelation } from '../contact-relations';
import { directRoomIdFor, directRoomStatements } from '../direct-room';
import { actorId, type Principal } from '../principal';
import { roomDetail } from './detail';
import { type RoomDetail, type RoomCreateMemberResult } from './views';

export async function ensureActors(db: D1Database, ids: string[]): Promise<ActorRow[]> {
  if (ids.length === 0) return [];
  const rows = await getActorRowsByIds(db, ids);
  const found = new Map(rows.map((row) => [row.actor_id, row]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new BusinessError('INVALID_ARGUMENT', '成员 actor 不存在', { missing });
  }
  return ids.map((id) => found.get(id) as ActorRow);
}

export function uniqueOthers(self: string, members: string[]): string[] {
  return [...new Set(members)].filter((id) => id !== self);
}

/**
 * Agent 无需好友关系也能直接入群的两个条件：尚未被认领，或由调用者管理。
 *
 * unclaimed Agent 没有可确认邀请的管理者，生成 pending 邀请只会永远等待；
 * 因此与自有 Agent 一样直接 active。已被其他人管理的 Agent 仍须好友关系。
 */
export async function agentJoinsWithoutRelation(
  db: D1Database,
  owner: string,
  target: ActorRow,
): Promise<boolean> {
  if (target.kind !== 'agent') return false;
  const management = await getActiveManagement(db, target.actor_id);
  return management === null || management.manager_id === owner;
}

/**
 * 加成员预检：人类仍须 active 好友关系；Agent 额外允许 unclaimed / 自有管理者。
 *
 * 拉黑由调用方先裁决，保证 BLOCKED 优先于 FRIEND_REQUIRED。事务内还有等价
 * 的 guard，这里只负责提交前给出稳定错误。
 */
export async function requireJoinableTargets(
  db: D1Database,
  owner: string,
  targets: ActorRow[],
): Promise<void> {
  for (const target of targets) {
    if (await getActiveRelation(db, owner, target.actor_id)) continue;
    if (await agentJoinsWithoutRelation(db, owner, target)) continue;
    throw new BusinessError('FRIEND_REQUIRED', '只能把好友加入群聊', {
      actor_id: target.actor_id,
    });
  }
}

export interface CreateTargetEvaluation {
  actor: ActorRow;
  status: 'active' | 'failed';
  code: BusinessErrorCode | null;
  message: string | null;
}

/**
 * 建群候选的提交前判定：拉黑优先，其次 Agent 管理关系，最后好友关系。
 *
 * 人拉人直接入群，不再生成待确认邀请：所有合格候选都在同一事务内成为
 * active 成员。失败的候选不会静默剔除：调用方把逐对象结果返回给客户端，
 * 整次建群在提交前终止。
 */
export async function evaluateCreateTargets(
  db: D1Database,
  owner: string,
  actors: ActorRow[],
): Promise<CreateTargetEvaluation[]> {
  const evaluations: CreateTargetEvaluation[] = [];
  for (const actor of actors) {
    if (await isBlockedBetween(db, owner, actor.actor_id)) {
      evaluations.push({
        actor,
        status: 'failed',
        code: 'BLOCKED',
        message: '双方存在拉黑关系，不能邀请对方加入群聊',
      });
      continue;
    }
    if (await agentJoinsWithoutRelation(db, owner, actor)) {
      evaluations.push({ actor, status: 'active', code: null, message: null });
      continue;
    }
    if (await getActiveRelation(db, owner, actor.actor_id)) {
      evaluations.push({ actor, status: 'active', code: null, message: null });
      continue;
    }
    evaluations.push({
      actor,
      status: 'failed',
      code: 'FRIEND_REQUIRED',
      message: '只能把好友加入群聊',
    });
  }
  return evaluations;
}

export function evaluationResult(evaluation: CreateTargetEvaluation): RoomCreateMemberResult {
  return {
    actor_id: evaluation.actor.actor_id,
    kind: evaluation.actor.kind,
    name: evaluation.actor.name,
    status: evaluation.status,
    code: evaluation.code,
    message: evaluation.message,
  };
}

/** 提交后按真实成员状态生成逐对象结果，竞态失败给出可读原因。 */
export async function deriveCreateResults(
  db: D1Database,
  owner: string,
  evaluations: CreateTargetEvaluation[],
  detail: RoomDetail,
): Promise<RoomCreateMemberResult[]> {
  const active = new Set(detail.members.map((member) => member.actor_id));
  return Promise.all(
    evaluations.map(async (evaluation) => {
      if (active.has(evaluation.actor.actor_id)) {
        return { ...evaluationResult(evaluation), status: 'active', code: null, message: null };
      }
      if (await isBlockedBetween(db, owner, evaluation.actor.actor_id)) {
        return {
          ...evaluationResult(evaluation),
          status: 'failed',
          code: 'BLOCKED',
          message: '提交时双方已建立拉黑关系，未加入群聊',
        };
      }
      return {
        ...evaluationResult(evaluation),
        status: 'failed',
        code: 'CONFLICT',
        message: '提交时成员资格已变化，未加入群聊',
      };
    }),
  );
}

export async function roomCreate(
  db: D1Database,
  principal: Principal,
  input: RoomCreateInput,
): Promise<RoomDetail> {
  const owner = actorId(principal);
  const others = uniqueOthers(owner, input.members);
  if (others.length === 0) {
    throw new BusinessError('INVALID_ARGUMENT', '房间至少需要另一个成员');
  }
  const targetActors = await ensureActors(db, others);

  if (input.kind === 'direct') {
    if (others.length !== 1) {
      throw new BusinessError('INVALID_ARGUMENT', '单聊只能指定一个对方');
    }
    return createDirect(db, principal, others[0] as string, input.request_id);
  }

  // 拉黑优先于好友关系裁决，返回稳定的 BLOCKED 而不是 FRIEND_REQUIRED。
  const evaluations = await evaluateCreateTargets(db, owner, targetActors);
  const failedEvaluations = evaluations.filter((evaluation) => evaluation.status === 'failed');
  const memberResults = evaluations.map(evaluationResult);
  if (failedEvaluations.length > 0) {
    // 提交前解释所有不合格对象，不创建半成品群。
    const first = failedEvaluations[0] as CreateTargetEvaluation;
    const detailText = failedEvaluations
      .map((evaluation) => `${evaluation.actor.name}（${evaluation.message}）`)
      .join('、');
    throw new BusinessError(
      first.code ?? 'INVALID_ARGUMENT',
      `以下成员不能加入群聊：${detailText}`,
      { results: memberResults },
    );
  }

  // 人拉人直接入群：所有通过预检的候选都在建群事务内成为 active 成员，
  // 不再生成待确认邀请，也不占用 100 人容量之外的邀请名额。
  const activeOthers = evaluations.map((evaluation) => evaluation.actor.actor_id);

  if (activeOthers.length + 1 > LIMITS.groupMembersMax) {
    throw new BusinessError('ROOM_FULL', '群成员数量超过上限', {
      limit: LIMITS.groupMembersMax,
      results: memberResults,
    });
  }

  const at = nowMs();
  const roomId = newId('rm');
  const payloadHash = await sha256Hex(stableStringify(input));
  const roomRef = `room_created:${roomId}`;
  const participants = [owner, ...activeOthers];

  let outcome: unknown;
  try {
    outcome = await runIdempotent(db, {
      actorId: owner,
      requestId: input.request_id,
      payloadHash,
      result: { room_id: roomId },
      build: (resultJson) => [
        operationsStatement(db, owner, input.request_id, payloadHash, resultJson, at),
        db
          .prepare(
            guardSql(
              'roomLimit',
              '(SELECT COUNT(*) FROM room_members WHERE actor_id = ? AND status = \'active\') >= ?',
            ),
          )
          .bind(owner, LIMITS.activeRoomsPerActor),
        db
          .prepare(
            `INSERT INTO rooms
               (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq, member_seq, last_message_id, member_history_policy, created_at, updated_at)
             VALUES (?, 'group', ?, ?, NULL, 0, 0, 0, NULL, 'full', ?, ?)`,
          )
          .bind(roomId, owner, input.title ?? '', at, at),
        eventStatement(
          db,
          {
            eventKey: roomRef,
            scopeKind: 'room',
            scopeId: roomId,
            eventType: 'room_created',
            refId: roomId,
            metadata: {
              owner_id: owner,
              members: activeOthers,
              invited: [],
            },
          },
          at,
        ),
        outboxStatement(db, { topic: roomTopic(roomId), eventKey: roomRef }, at),
        roomHeadStatement(db, roomId, roomRef, at),
        db
          .prepare(
            `INSERT INTO room_members
               (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
             VALUES (?, ?, 'owner', 'active', (SELECT event_seq FROM events WHERE event_key = ?), 0, ?, 1, ?)`,
          )
          .bind(roomId, owner, roomRef, at, at),
        // 自有 Agent 与其他合格候选都直接 active；插入时复核拉黑/管理关系，
        // 竞态失败只影响该目标。
        ...activeOthers.map((member) =>
          db
            .prepare(
              `INSERT INTO room_members
                 (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at, role_revision, updated_at)
               SELECT ?, ?, 'member', 'active',
                      (SELECT event_seq FROM events WHERE event_key = ?), 0, ?, 1, ?
                WHERE NOT EXISTS (
                        SELECT 1 FROM contact_blocks
                         WHERE released_at IS NULL
                           AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
                             OR (blocker_actor_id = ? AND blocked_actor_id = ?))
                      )
                  AND (
                    EXISTS (
                      SELECT 1 FROM contact_relations
                       WHERE pair_key = ? AND status = 'active'
                    )
                    OR (
                      EXISTS (
                        SELECT 1 FROM actors
                         WHERE actor_id = ? AND kind = 'agent'
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM agent_managements
                         WHERE agent_id = ? AND status = 'active' AND manager_id <> ?
                      )
                    )
                  )`,
            )
            .bind(
              roomId,
              member,
              roomRef,
              at,
              at,
              owner,
              member,
              member,
              owner,
              sortedPairKey(owner, member),
              member,
              member,
              owner,
            ),
        ),
        // 预检合格的候选在提交时全部失效时整批回滚，不能留下只有 owner 的群。
        db
          .prepare(
            guardSql(
              'inviteTargetsMissing',
              `NOT EXISTS (
                 SELECT 1 FROM room_members WHERE room_id = ? AND actor_id <> ?
               )`,
            ),
          )
          .bind(roomId, owner),
        ...inboxChangeStatements(
          db,
          participants,
          (actor) => `room_created:${roomId}:${actor}`,
          'room_created',
          at,
          roomId,
          true,
        ),
      ],
    });
  } catch (error) {
    if (
      error instanceof BusinessError &&
      error.details?.reason === 'invite_targets_missing'
    ) {
      const detail = {
        room: { room_id: roomId },
        members: [],
        invited: [],
      } as unknown as RoomDetail;
      const results = await deriveCreateResults(db, owner, evaluations, detail);
      throw new BusinessError(
        firstFailureCode(results),
        '成员资格在提交时已变化，群未创建',
        { results, reason: 'invite_targets_missing' },
      );
    }
    throw error;
  }

  // 重放同一 request_id 时 runIdempotent 返回首次提交的 {room_id}；不能再用
  // 本次随机生成的 roomId 读取详情，否则重放会得到 NOT_FOUND。
  const committed = outcome as { room_id?: string } | undefined;
  const committedRoomId =
    typeof committed?.room_id === 'string' ? committed.room_id : roomId;
  const detail = await roomDetail(db, committedRoomId, owner);
  return {
    ...detail,
    results: await deriveCreateResults(db, owner, evaluations, detail),
  };
}

export function firstFailureCode(results: RoomCreateMemberResult[]): BusinessErrorCode {
  return results.find((result) => result.status === 'failed')?.code ?? 'FRIEND_REQUIRED';
}

export async function createDirect(
  db: D1Database,
  principal: Principal,
  target: string,
  requestId: string,
): Promise<RoomDetail> {
  const owner = actorId(principal);
  const at = nowMs();
  const targetActor = await getActor(db, target);
  if (!targetActor) throw new BusinessError('NOT_FOUND', '目标 actor 不存在');
  if (await isBlockedBetween(db, owner, target)) {
    throw new BusinessError('BLOCKED', '双方存在拉黑关系，不能创建单聊');
  }
  const roomId = await directRoomIdFor(owner, target);
  const payloadHash = await sha256Hex(
    stableStringify({ kind: 'direct', members: [target], request_id: requestId }),
  );

  await runIdempotent(db, {
    actorId: owner,
    requestId,
    payloadHash,
    result: { room_id: roomId },
    build: (resultJson) => [
      operationsStatement(db, owner, requestId, payloadHash, resultJson, at),
      db
        .prepare(
          guardSql(
            'roomLimit',
            `(SELECT COUNT(*) FROM room_members WHERE actor_id = ? AND status = 'active') >= ?
             AND NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = ?)`,
          ),
        )
        .bind(owner, LIMITS.activeRoomsPerActor, roomId),
      // 好友激活可能已自动建出这个 direct 房间；打开已有会话不能被配额拦住，
      // 配额只约束真正新增的房间。
      ...directRelationStatements(db, owner, targetActor, at),
      ...directRoomStatements(db, owner, target, roomId, at),
    ],
  });

  return roomDetail(db, roomId, owner);
}


/**
 * G06 遗留无主群防御（本地事务）。
 *
 * 修复前的缺陷允许 owner 在独自一人时退群，留下
 * `rooms.owner_id IS NULL AND rooms.dissolved_at IS NULL` 的活跃群。
 * 本测试直接用内存 SQLite 构造该历史状态（正常工具路径已无法产生），
 * 验证邀请、邀请链接、入群申请批准和成员添加都被事务闸门拒绝，且不会
 * 自动解散、硬删或回填 owner。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { BusinessError } from '../../src/contracts/errors';
import type { Principal } from '../../src/domain/principal';
import { roomInvitationAccept, hashRoomInviteKey } from '../../src/domain/room-invitations';
import { roomInviteCreate } from '../../src/domain/room-invite-links';
import { roomJoinRequestRespond } from '../../src/domain/room-join-requests';
import { roomMembersUpdate } from '../../src/domain/rooms';
import { getActor } from '../../src/storage/queries';
import type { CredentialRow } from '../../src/storage/rows';
import { CheckFailure, check, checkEqual } from './harness';

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const AT = 1_700_000_000_000;
const ROOM = 'rm_g06_ownerless_room';
const ADMIN = 'usr_g06_ownerless_admin';
const TARGET = 'usr_g06_ownerless_target';
const LINK_INVITATION = 'rinv_g06_ownerless_link';
const JOIN_REQUEST = 'jrq_g06_ownerless_approve';

function openDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${ADMIN}', 'human', NULL, 'G06 Ownerless Admin', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${TARGET}', 'human', NULL, 'G06 Ownerless Target', '{}', 0, 0, 0, ${AT}, ${AT});

    -- 历史缺陷留下的状态：群未解散，但没有 owner。
    INSERT INTO rooms
      (room_id, kind, owner_id, title, head_seq, events_min_seq, member_seq,
       created_at, updated_at)
    VALUES ('${ROOM}', 'group', NULL, 'G06 遗留无主群', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
       role_revision, updated_at)
    VALUES ('${ROOM}', '${ADMIN}', 'admin', 'active', 0, 0, ${AT}, 1, ${AT});
  `);
  return db;
}

function credentialFor(actorId: string): CredentialRow {
  return {
    credential_id: 'cred_g06_ownerless',
    actor_id: actorId,
    device_id: 'dev_g06_ownerless',
    token_hash: 'g06-ownerless-token-hash',
    revoked_at: null,
    created_at: AT,
    last_used_at: null,
    revoked_by: null,
    label: null,
  };
}

async function principalFor(db: D1Database, actorId: string): Promise<Principal> {
  const actor = await getActor(db, actorId);
  if (!actor) throw new CheckFailure('seed', `缺少 actor: ${actorId}`);
  return {
    credentialHash: 'g06-ownerless-credential-hash',
    actor,
    credential: credentialFor(actorId),
  };
}

async function expectConflict(
  label: string,
  promise: Promise<unknown>,
  reason: string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof BusinessError)) throw error;
    checkEqual(label, error.code, 'CONFLICT');
    checkEqual(`${label}（原因）`, error.details?.reason, reason);
    return;
  }
  throw new CheckFailure(label, '期望 CONFLICT，但调用成功');
}

export async function runOwnerlessRoomUnitChecks(): Promise<void> {
  console.log('  · G06 遗留无主群加入防御（本地事务）');
  const db = openDb();
  const d1 = createD1(db);
  try {
    const admin = await principalFor(d1, ADMIN);
    const target = await principalFor(d1, TARGET);
    const inviteKey = 'g06-ownerless-link-key';
    const expiresAt = Date.now() + 86_400_000;
    db.prepare(
      `INSERT INTO room_invitations
         (invitation_id, room_id, inviter_id, target_actor_id, token_hash, kind,
          status, max_uses, used_count, expires_at, revision, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, 'link', 'pending', 20, 0, ?, 1, ?, ?)`,
    ).run(
      LINK_INVITATION,
      ROOM,
      ADMIN,
      await hashRoomInviteKey(inviteKey),
      expiresAt,
      AT,
      AT,
    );
    db.prepare(
      `INSERT INTO room_join_requests
         (join_request_id, invitation_id, room_id, applicant_id, status, message,
          revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', '', 1, ?, ?)`,
    ).run(JOIN_REQUEST, LINK_INVITATION, ROOM, TARGET, AT, AT);

    await expectConflict(
      'G06 无主群不能创建邀请链接',
      roomInviteCreate(
        d1,
        admin,
        { request_id: `g06_ownerless_create_${crypto.randomUUID()}`, room_id: ROOM },
        'https://unit.g06.test',
      ),
      'owner_missing',
    );
    await expectConflict(
      'G06 无主群旧邀请链接不能加入',
      roomInvitationAccept(d1, target, {
        request_id: `g06_ownerless_accept_${crypto.randomUUID()}`,
        invitation_id: LINK_INVITATION,
        invite_key: inviteKey,
        action: 'accept',
      }),
      'owner_missing',
    );
    await expectConflict(
      'G06 无主群不能批准入群申请',
      roomJoinRequestRespond(d1, admin, {
        request_id: `g06_ownerless_approve_${crypto.randomUUID()}`,
        join_request_id: JOIN_REQUEST,
        action: 'approve',
      }),
      'owner_missing',
    );
    await expectConflict(
      'G06 无主群不能添加成员',
      roomMembersUpdate(d1, admin, {
        request_id: `g06_ownerless_add_${crypto.randomUUID()}`,
        room_id: ROOM,
        add: [TARGET],
      }),
      'owner_missing',
    );

    const room = db
      .prepare('SELECT owner_id, dissolved_at FROM rooms WHERE room_id = ?')
      .get(ROOM) as { owner_id: string | null; dissolved_at: number | null };
    checkEqual('G06 无主群防御不改写 owner_id', room.owner_id, null);
    checkEqual('G06 无主群防御不自动解散', room.dissolved_at, null);
    const invitation = db
      .prepare('SELECT status FROM room_invitations WHERE invitation_id = ?')
      .get(LINK_INVITATION) as { status: string };
    checkEqual('G06 无主群防御不消费邀请', invitation.status, 'pending');
    const joinRequest = db
      .prepare('SELECT status FROM room_join_requests WHERE join_request_id = ?')
      .get(JOIN_REQUEST) as { status: string };
    checkEqual('G06 无主群防御不改写申请状态', joinRequest.status, 'pending');
    check(
      'G06 无主群防御不写入成员',
      (db
        .prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'")
        .get(ROOM) as { n: number }).n === 1,
    );
  } finally {
    db.close();
  }
}

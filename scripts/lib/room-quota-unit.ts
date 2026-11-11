/**
 * 房间配额与 direct 复用（本地事务）。
 *
 * 好友关系激活会自动建出确定性 direct 房间；自动建房不经过 `roomLimit`
 * 闸门，可能让调用者达到上限。此后打开已有会话不能因配额失败，只有真正
 * 新建房间才继续受 `activeRoomsPerActor` 约束。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { BusinessError } from '../../src/contracts/errors';
import { LIMITS } from '../../src/contracts/limits';
import type { Principal } from '../../src/domain/principal';
import { roomCreate } from '../../src/domain/rooms';
import { getActor } from '../../src/storage/queries';
import type { CredentialRow } from '../../src/storage/rows';
import { CheckFailure, checkEqual } from './harness';

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const AT = 1_700_000_000_000;
const HUMAN = 'usr_quota_human';
const FRIEND = 'agt_quota_friend';
const OTHER = 'agt_quota_other';

function openDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES
      ('${HUMAN}', 'human', NULL, 'Quota Human', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${FRIEND}', 'agent', 'sess_quota_friend', 'Quota Friend', '{}', 0, 0, 0, ${AT}, ${AT}),
      ('${OTHER}', 'agent', 'sess_quota_other', 'Quota Other', '{}', 0, 0, 0, ${AT}, ${AT});

    -- 好友激活已自动建出 direct 房间；这里只补关系行，房间由首次复用调用确认。
    INSERT INTO contact_relations
      (pair_key, actor_a, actor_b, status, source, request_id, created_at, updated_at)
    VALUES
      ('${FRIEND}|${HUMAN}', '${FRIEND}', '${HUMAN}', 'active', 'request', NULL, ${AT}, ${AT}),
      ('${OTHER}|${HUMAN}', '${OTHER}', '${HUMAN}', 'active', 'request', NULL, ${AT}, ${AT});
  `);
  return db;
}

function credentialFor(actorId: string): CredentialRow {
  return {
    credential_id: 'cred_quota',
    actor_id: actorId,
    device_id: 'dev_quota',
    token_hash: 'quota-token-hash',
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
    credentialHash: 'quota-credential-hash',
    actor,
    credential: credentialFor(actorId),
  };
}

function activeMemberships(db: Database, actorId: string): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'")
      .get(actorId) as { n: number }
  ).n;
}

function roomCount(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n;
}

/** 直接写库补足历史房间，模拟自动建联累计到配额上限。 */
function seedActiveRooms(db: Database, actorId: string, count: number): void {
  const insertRoom = db.prepare(
    `INSERT INTO rooms
       (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
        member_seq, last_message_id, created_at, updated_at)
     VALUES (?, 'group', ?, 'Quota Seed', NULL, 0, 0, 0, NULL, ?, ?)`,
  );
  const insertMember = db.prepare(
    `INSERT INTO room_members
       (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at)
     VALUES (?, ?, 'owner', 'active', 0, 0, ?)`,
  );
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const roomId = `rm_quota_seed_${activeMemberships(db, actorId)}_${index}`;
      insertRoom.run(roomId, actorId, AT, AT);
      insertMember.run(roomId, actorId, AT);
    }
  })();
}

async function expectRoomLimit(label: string, promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof BusinessError)) throw error;
    checkEqual(label, error.code, 'CONFLICT');
    checkEqual(`${label}（原因）`, error.message, '活跃房间数量达到上限');
    return;
  }
  throw new CheckFailure(label, '期望 CONFLICT，但调用成功');
}

export async function runRoomQuotaUnitChecks(): Promise<void> {
  console.log('  · 房间配额与 direct 复用（本地事务）');
  const db = openDb();
  const d1 = createD1(db);
  try {
    const human = await principalFor(d1, HUMAN);
    const created = await roomCreate(d1, human, {
      request_id: `quota_create_${crypto.randomUUID()}`,
      kind: 'direct',
      members: [FRIEND],
    });
    const roomId = created.room.room_id;
    checkEqual('配额用例初始 active 房间数', activeMemberships(db, HUMAN), 1);

    seedActiveRooms(db, HUMAN, LIMITS.activeRoomsPerActor - activeMemberships(db, HUMAN));
    checkEqual(
      '配额用例达到 activeRoomsPerActor 上限',
      activeMemberships(db, HUMAN),
      LIMITS.activeRoomsPerActor,
    );

    const roomsBefore = roomCount(db);
    const reused = await roomCreate(d1, human, {
      request_id: `quota_reuse_${crypto.randomUUID()}`,
      kind: 'direct',
      members: [FRIEND],
    });
    checkEqual('达到上限时已有 direct 房间复用成功', reused.room.room_id, roomId);
    checkEqual('复用自己的房间不新增房间行', roomCount(db), roomsBefore);
    checkEqual(
      '复用自己的房间不增加 active 成员关系',
      activeMemberships(db, HUMAN),
      LIMITS.activeRoomsPerActor,
    );

    await expectRoomLimit(
      '达到上限后新建 direct 仍被拒绝',
      roomCreate(d1, human, {
        request_id: `quota_new_${crypto.randomUUID()}`,
        kind: 'direct',
        members: [OTHER],
      }),
    );
    checkEqual('被拒绝的新建 direct 不落库', roomCount(db), roomsBefore);

    seedActiveRooms(db, HUMAN, 1);
    checkEqual(
      '配额用例超过 activeRoomsPerActor 上限',
      activeMemberships(db, HUMAN),
      LIMITS.activeRoomsPerActor + 1,
    );
    const overLimitReused = await roomCreate(d1, human, {
      request_id: `quota_reuse_over_${crypto.randomUUID()}`,
      kind: 'direct',
      members: [FRIEND],
    });
    checkEqual('超过上限时已有 direct 房间仍可复用', overLimitReused.room.room_id, roomId);
    checkEqual('超过上限后又新增房间只来自 seed', roomCount(db), roomsBefore + 1);
  } finally {
    db.close();
  }
}

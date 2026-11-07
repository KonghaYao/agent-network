/**
 * G02 邀请链接幂等结果的本地安全测试。
 *
 * 使用内存 SQLite + 真实 migrations，不依赖正在运行的服务；验证
 * `operations.result_json` 不保存明文 key/分享 URL，且同一 `request_id`
 * 重放在撤销前后都返回 `TOKEN_NOT_REPLAYABLE`，不能恢复旧链接或旧状态。
 */

import { Database } from 'bun:sqlite';
import { join } from 'node:path';

import { createD1 } from '../../src/bun/d1';
import { migrate } from '../../src/bun/migrate';
import { BusinessError } from '../../src/contracts/errors';
import type { Principal } from '../../src/domain/principal';
import { roomInviteCreate, roomInviteRevoke } from '../../src/domain/room-invite-links';
import { getActor } from '../../src/storage/queries';
import type { CredentialRow } from '../../src/storage/rows';
import { CheckFailure, check, checkEqual } from './harness';

const MIGRATIONS = join(import.meta.dir, '../../migrations');
const AT = 1_700_000_000_000;
const OWNER = 'usr_g02_unit_owner';
const ROOM = 'rm_g02_unit_room';
const ORIGIN = 'https://unit.g02.test';

function openDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db, MIGRATIONS);
  db.exec(`
    INSERT INTO actors
      (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
       pending_count, created_at, updated_at)
    VALUES ('${OWNER}', 'human', NULL, 'G02 Unit Owner', '{}', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO rooms
      (room_id, kind, owner_id, title, head_seq, events_min_seq, member_seq,
       created_at, updated_at)
    VALUES ('${ROOM}', 'group', '${OWNER}', 'G02 Unit Room', 0, 0, 0, ${AT}, ${AT});

    INSERT INTO room_members
      (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
       role_revision, updated_at)
    VALUES ('${ROOM}', '${OWNER}', 'owner', 'active', 0, 0, ${AT}, 1, ${AT});
  `);
  return db;
}

function credentialFor(actorId: string): CredentialRow {
  return {
    credential_id: 'cred_g02_unit',
    actor_id: actorId,
    device_id: 'dev_g02_unit',
    token_hash: 'g02-unit-token-hash',
    revoked_at: null,
    created_at: AT,
    last_used_at: null,
    revoked_by: null,
    label: null,
  };
}

async function expectCode(
  label: string,
  promise: Promise<unknown>,
  code: string,
): Promise<BusinessError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BusinessError) {
      checkEqual(label, error.code, code);
      return error;
    }
    throw error;
  }
  throw new CheckFailure(label, `期望错误 ${code}，但调用成功`);
}

function operationResultJson(db: Database, actorId: string, requestId: string): string {
  const row = db
    .prepare('SELECT result_json FROM operations WHERE actor_id = ? AND request_id = ?')
    .get(actorId, requestId) as { result_json: string } | null;
  if (!row) throw new CheckFailure('operation', `缺少 operations 行: ${requestId}`);
  return row.result_json;
}

export async function runRoomInviteReplayUnitChecks(): Promise<void> {
  console.log('  · G02 邀请链接幂等与明文保护（本地事务）');
  const db = openDb();
  const d1 = createD1(db);
  try {
    const owner = await getActor(d1, OWNER);
    if (!owner) throw new CheckFailure('seed', '缺少 owner actor');
    const principal: Principal = {
      credentialHash: 'g02-unit-credential-hash',
      actor: owner,
      credential: credentialFor(OWNER),
    };
    const requestId = `g02_unit_${crypto.randomUUID().replaceAll('-', '')}`;
    const input = { request_id: requestId, room_id: ROOM, max_uses: 5 };

    const created = await roomInviteCreate(d1, principal, input, ORIGIN);
    check(
      'G02 首次创建返回明文 invite_key',
      typeof created.invite_key === 'string' && created.invite_key.length > 0,
    );
    checkEqual(
      'G02 首次创建返回 /j/<key> 分享 URL',
      created.share_url,
      `${ORIGIN}/j/${created.invite_key}`,
    );

    const storedJson = operationResultJson(db, OWNER, requestId);
    check(
      'G02 operations.result_json 不含明文 invite_key',
      !storedJson.includes(created.invite_key!),
      storedJson,
    );
    check(
      'G02 operations.result_json 不含分享 URL 或 /j/ 前缀',
      !storedJson.includes('/j/') && !storedJson.includes('share_url'),
      storedJson,
    );
    check(
      'G02 operations.result_json 不保存 invite_key 字段',
      !storedJson.includes('invite_key'),
      storedJson,
    );
    checkEqual(
      'G02 operations.result_json 仍保存邀请状态与次数',
      JSON.stringify({
        invitation_id: (JSON.parse(storedJson) as { invitation: { invitation_id: string } })
          .invitation.invitation_id,
        status: (JSON.parse(storedJson) as { invitation: { status: string } }).invitation.status,
        max_uses: (JSON.parse(storedJson) as { invitation: { max_uses: number } }).invitation
          .max_uses,
      }),
      JSON.stringify({
        invitation_id: created.invitation.invitation_id,
        status: 'pending',
        max_uses: 5,
      }),
    );

    await expectCode(
      'G02 同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE',
      roomInviteCreate(d1, principal, input, ORIGIN),
      'TOKEN_NOT_REPLAYABLE',
    );

    const revoked = await roomInviteRevoke(d1, principal, {
      request_id: `g02_unit_revoke_${crypto.randomUUID().replaceAll('-', '')}`,
      invitation_id: created.invitation.invitation_id,
      expected_revision: created.invitation.revision,
    });
    checkEqual('G02 样本链接撤销后状态为 revoked', revoked.status, 'revoked');

    await expectCode(
      'G02 撤销后重放仍返回 TOKEN_NOT_REPLAYABLE',
      roomInviteCreate(d1, principal, input, ORIGIN),
      'TOKEN_NOT_REPLAYABLE',
    );
    checkEqual(
      'G02 撤销与重放后 operations.result_json 仍不含明文',
      operationResultJson(db, OWNER, requestId),
      storedJson,
    );
    const invitationStatus = db
      .prepare('SELECT status FROM room_invitations WHERE invitation_id = ?')
      .get(created.invitation.invitation_id) as { status: string };
    checkEqual('G02 重放没有把已撤销链接改回 pending', invitationStatus.status, 'revoked');
  } finally {
    db.close();
  }
}

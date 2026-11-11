import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { contactRequestsList } from '../src/domain/contact-requests';
import { roomInvitationAccept } from '../src/domain/room-invitations';
import type { Principal } from '../src/domain/principal';
import type { Env } from '../src/env';
import { drainOutbox } from '../src/realtime/outbox';
import { getActor } from '../src/storage/queries';

const sqlite = new Database(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
migrate(sqlite, resolve(import.meta.dir, '../migrations'));
const db = createD1(sqlite);
const now = Date.now();

function seedActor(actorId: string): void {
  sqlite.prepare(
    `INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata,
                         inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
     VALUES (?, 'human', NULL, ?, '{}', 0, 0, 0, ?, ?)`,
  ).run(actorId, actorId, now, now);
}

async function principal(actorId: string): Promise<Principal> {
  return { actor: await getActor(db, actorId), credential: null, credentialHash: '' };
}

try {
  seedActor('usr_viewer');
  seedActor('usr_owner');
  seedActor('usr_invitee');
  for (let index = 0; index < 51; index += 1) {
    const actorId = `usr_expired_${index}`;
    seedActor(actorId);
    sqlite.prepare(
      `INSERT INTO contact_requests
         (contact_request_id, pair_key, from_actor_id, to_actor_id, status,
          created_at, updated_at, expires_at)
       VALUES (?, ?, ?, 'usr_viewer', 'pending', ?, ?, ?)`,
    ).run(`creq_expired_${index}`, `${actorId}|usr_viewer`, actorId, now, now, now - 1);
  }
  const viewer = await principal('usr_viewer');
  const pending = await contactRequestsList(db, viewer, { direction: 'incoming', status: 'pending', limit: 100 });
  assert.equal(pending.items.length, 0);
  const expired = await contactRequestsList(db, viewer, { direction: 'incoming', status: 'expired', limit: 100 });
  assert.equal(expired.items.length, 51);
  assert.ok(expired.items.every((item) => item.status === 'expired' && !item.can_respond));
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM contact_requests WHERE status = 'pending'")
    .get() as { n: number }).n, 51);
  console.log('✓ 好友申请读取不触发全局过期写入，过期状态按时间展示');

  sqlite.prepare(
    `INSERT INTO rooms (room_id, kind, owner_id, title, direct_pair_key,
                        head_seq, events_min_seq, member_seq, created_at, updated_at)
     VALUES ('rm_race', 'group', 'usr_owner', '竞态', NULL, 0, 0, 0, ?, ?)`,
  ).run(now, now);
  sqlite.prepare(
    `INSERT INTO room_members (room_id, actor_id, role, status, joined_seq,
                              last_read_seq, joined_at)
     VALUES ('rm_race', 'usr_owner', 'owner', 'active', 0, 0, ?)`,
  ).run(now);
  sqlite.prepare(
    `INSERT INTO room_invitations
       (invitation_id, room_id, inviter_id, target_actor_id, kind, status,
        max_uses, used_count, expires_at, created_at, updated_at)
     VALUES ('rin_race', 'rm_race', 'usr_owner', 'usr_invitee', 'direct', 'pending',
       1, 0, ?, ?, ?)`,
  ).run(now + 60_000, now, now);
  const invitee = await principal('usr_invitee');
  const intercept = (policy: 'approval' | 'open'): D1Database => ({
    prepare: db.prepare.bind(db),
    exec: db.exec.bind(db),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      sqlite.prepare(
        'UPDATE rooms SET member_join_policy = ?, policy_revision = policy_revision + 1 WHERE room_id = ?',
      ).run(policy, 'rm_race');
      return db.batch<T>(statements);
    },
  });
  await assert.rejects(
    roomInvitationAccept(intercept('approval'), invitee, { request_id: 'race_direct', invitation_id: 'rin_race', action: 'accept' }),
    (error: unknown) => (error as { code?: string }).code === 'VERSION_CONFLICT',
  );
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS n FROM room_members WHERE actor_id = 'usr_invitee'")
    .get() as { n: number }).n, 0);
  assert.equal((sqlite.prepare("SELECT status FROM room_invitations WHERE invitation_id = 'rin_race'")
    .get() as { status: string }).status, 'pending');
  await assert.rejects(
    roomInvitationAccept(intercept('open'), invitee, { request_id: 'race_approval', invitation_id: 'rin_race', action: 'accept' }),
    (error: unknown) => (error as { code?: string }).code === 'VERSION_CONFLICT',
  );
  assert.equal((sqlite.prepare('SELECT COUNT(*) AS n FROM room_join_requests').get() as { n: number }).n, 0);
  const accepted = await roomInvitationAccept(db, invitee, {
    request_id: 'race_success', invitation_id: 'rin_race', action: 'accept',
  });
  assert.equal(accepted.status, 'accepted');
  console.log('✓ 入群审批切换的两个分支在事务内复核策略');

  sqlite.exec('DELETE FROM outbox');
  sqlite.prepare(
    `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
     VALUES ('actor', 'usr_viewer', 'test_event', 'test', '{}', 'test_outbox_race', ?)`,
  ).run(now);
  const event = sqlite.prepare("SELECT event_seq FROM events WHERE event_key = 'test_outbox_race'")
    .get() as { event_seq: number };
  sqlite.prepare(
    `INSERT INTO outbox (outbox_id, topic, event_seq, status, next_attempt_at, created_at)
     VALUES ('out_test_race', 'actor:usr_viewer', ?, 'pending', 0, ?)`,
  ).run(event.event_seq, now);
  let emitted = 0;
  const env = {
    DB: db,
    NOTIFICATION_HUB: {
      publishActor: () => { throw new Error('injected fan-out failure'); },
    },
  } as unknown as Env;
  const originalError = console.error;
  console.error = () => undefined;
  let failure;
  try {
    failure = await drainOutbox(env);
  } finally {
    console.error = originalError;
  }
  assert.equal(failure.published, 0);
  assert.equal(failure.failed, 1);
  assert.equal((sqlite.prepare("SELECT status FROM outbox WHERE outbox_id = 'out_test_race'")
    .get() as { status: string }).status, 'pending');
  sqlite.prepare("UPDATE outbox SET next_attempt_at = 0 WHERE outbox_id = 'out_test_race'").run();
  env.NOTIFICATION_HUB = {
    publishActor: () => { emitted += 1; },
  } as unknown as Env['NOTIFICATION_HUB'];
  const recovered = await drainOutbox(env);
  assert.equal(recovered.published, 1);
  assert.equal(emitted, 1);
  assert.equal((sqlite.prepare("SELECT status FROM outbox WHERE outbox_id = 'out_test_race'")
    .get() as { status: string }).status, 'completed');
  console.log('✓ 实时 fan-out 失败后保留可重试 outbox，成功后完成');
} finally {
  sqlite.close();
}

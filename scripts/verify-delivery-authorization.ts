/** Regression: retries must not resurrect work revoked by room/contact changes. */
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { BusinessError } from '../src/contracts/errors';
import { LIMITS } from '../src/contracts/limits';
import { deliveryClaim, deliveryRetry } from '../src/domain/deliveries';
import { getActor } from '../src/storage/queries';

let checks = 0;
async function scenario(name: string, setup: string, code: string | null, claim = false, retryAs = 'sender') {
  const sqlite = new Database(':memory:');
  migrate(sqlite, join(import.meta.dir, '../migrations'));
  const db = createD1(sqlite);
  sqlite.exec(`
    INSERT INTO actors (actor_id,kind,name,created_at,updated_at) VALUES
      ('sender','human','Sender',1,1), ('agent','agent','Agent',1,1);
    INSERT INTO rooms (room_id,kind,owner_id,created_at,updated_at)
      VALUES ('room','group','sender',1,1);
    INSERT INTO room_members (room_id,actor_id,role,status,joined_seq,joined_at)
      VALUES ('room','sender','owner','active',0,1), ('room','agent','member','active',0,1);
    INSERT INTO messages (message_id,room_id,sender_id,client_message_id,created_seq,body,body_bytes,preview,created_at)
      VALUES ('message','room','sender','client',1,'work',4,'work',1);
    INSERT INTO deliveries (delivery_id,recipient_id,message_id,room_id,state,created_seq,created_at,updated_at)
      VALUES ('delivery','agent','message','room','cancelled',1,1,1);
    ${claim ? "UPDATE deliveries SET state = 'pending'; UPDATE actors SET pending_count = 1 WHERE actor_id = 'agent';" : ''}
    ${setup}
  `);
  const before = JSON.stringify(sqlite.query('SELECT * FROM deliveries').all());
  const beforeActors = JSON.stringify(sqlite.query('SELECT * FROM actors').all());
  const principal = { actor: await getActor(db, claim ? 'agent' : retryAs), credential: null, credentialHash: 'test' };
  const invoke = () => claim
    ? deliveryClaim(db, principal, { request_id: crypto.randomUUID(), delivery_id: 'delivery' })
    : deliveryRetry(db, principal, { request_id: crypto.randomUUID(), delivery_id: 'delivery', expected_attempt: 0 });
  if (code) {
    await assert.rejects(invoke, (e: unknown) => e instanceof BusinessError && e.code === code, name);
    assert.equal(JSON.stringify(sqlite.query('SELECT * FROM deliveries').all()), before, `${name}: delivery rollback`);
    assert.equal(JSON.stringify(sqlite.query('SELECT * FROM actors').all()), beforeActors, `${name}: inbox rollback`);
    for (const table of ['events','outbox','operations']) {
      assert.equal((sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n, 0, `${name}: ${table} rollback`);
    }
    checks += 6;
  } else {
    const result = await invoke();
    assert.equal(result.state, claim ? 'claimed' : 'pending', name);
    assert.equal((await getActor(db, 'agent'))!.pending_count, claim ? 0 : 1);
    checks += 2;
  }
  sqlite.close();
}

await scenario('ordinary retry remains supported', '', null);
await scenario('ordinary claim remains supported', '', null, true);
await scenario('recipient retries its own claimed work without manager binding', "UPDATE deliveries SET state = 'claimed', claim_id = 'old-claim';", null, false, 'agent');
await scenario('rejoined recipient with full history can retry', "UPDATE room_members SET joined_seq = 2 WHERE actor_id = 'agent'; UPDATE rooms SET member_history_policy = 'full';", null, false, 'agent');
for (const claim of [false, true]) {
  await scenario('dissolved archive', "UPDATE rooms SET dissolved_at = 2, archive_head_seq = 1;", 'CONFLICT', claim);
  await scenario('removed recipient', "UPDATE room_members SET status = 'removed' WHERE actor_id = 'agent';", 'NOT_MEMBER', claim);
  await scenario('rejoined recipient cannot reclaim hidden history', "UPDATE room_members SET joined_seq = 2, member_generation = 2 WHERE actor_id = 'agent';", 'NOT_MEMBER', claim);
  await scenario('disabled recipient', "UPDATE actors SET disabled_at = 2 WHERE actor_id = 'agent';", 'ACTOR_DISABLED', claim);
  const block = "INSERT INTO contact_blocks (block_id,blocker_actor_id,blocked_actor_id,reason,mute_mentions,created_at) VALUES ('block','agent','sender','',1,2);";
  await scenario('muted group delivery', block, 'BLOCKED', claim);
  await scenario('direct block even with mentions unmuted', block + "UPDATE rooms SET kind = 'direct'; UPDATE contact_blocks SET mute_mentions = 0;", 'BLOCKED', claim);
}
await scenario('removed sender cannot restart work', "UPDATE room_members SET status = 'removed' WHERE actor_id = 'sender';", 'NOT_MEMBER');
let queue = '';
for (let i = 0; i < LIMITS.pendingPerActor; i++) {
  queue += `INSERT INTO deliveries (delivery_id,recipient_id,message_id,room_id,state,created_seq,created_at,updated_at) VALUES ('q${i}','agent','m${i}','room','pending',${i+2},1,1);`;
}
queue += `UPDATE actors SET pending_count = ${LIMITS.pendingPerActor} WHERE actor_id = 'agent';`;
await scenario('retry respects queue capacity', queue, 'QUEUE_FULL');
console.log(`Delivery authorization regressions: ${checks} assertions passed`);

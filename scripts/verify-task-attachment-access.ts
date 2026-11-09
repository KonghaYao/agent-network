/** Task creation cannot retain an expired or history-invisible attachment. */
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { BusinessError } from '../src/contracts/errors';
import { taskCreate } from '../src/domain/tasks';
import { getActor } from '../src/storage/queries';

let assertions = 0;
async function scenario(name: string, setup: string, allowed = false, beforeBatch = '') {
  const sqlite = new Database(':memory:');
  migrate(sqlite, join(import.meta.dir, '../migrations'));
  const db = createD1(sqlite);
  sqlite.exec(`
    INSERT INTO actors (actor_id,kind,name,created_at,updated_at) VALUES ('user','human','User',1,1);
    INSERT INTO rooms (room_id,kind,owner_id,created_at,updated_at) VALUES ('room','group','user',1,1);
    INSERT INTO room_members (room_id,actor_id,role,status,joined_seq,joined_at)
      VALUES ('room','user','owner','active',10,10);
    INSERT INTO room_files (room_file_id,room_id,file_id,uploader_id,name,mime_type,size,sha256,created_at,expires_at,created_seq)
      VALUES ('rf','room','file','user','secret.txt','text/plain',1,'${'a'.repeat(64)}',20,${Date.now()+100000},20);
    ${setup}
  `);
  let before = JSON.stringify(sqlite.query('SELECT * FROM room_files').all());
  if (beforeBatch) {
    const batch = db.batch.bind(db);
    db.batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
      sqlite.exec(beforeBatch);
      before = JSON.stringify(sqlite.query('SELECT * FROM room_files').all());
      return batch<T>(statements);
    };
  }
  const principal = { actor: await getActor(db, 'user'), credential: null, credentialHash: 'test' };
  const invoke = () => taskCreate(db, principal, {
    request_id: crypto.randomUUID(), room_id: 'room', title: 'Attachment check', attachment_file_ids: ['file'],
  });
  if (allowed) {
    await invoke();
    assert.equal((sqlite.query('SELECT retained FROM room_files').get() as {retained:number}).retained, 1);
    assertions++;
  } else {
    await assert.rejects(invoke, (e: unknown) => e instanceof BusinessError && e.code === 'FILE_UNAVAILABLE', name);
    assert.equal(JSON.stringify(sqlite.query('SELECT * FROM room_files').all()), before, name);
    for (const table of ['tasks','task_attachments','file_references','operations','events','outbox']) {
      assert.equal((sqlite.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n:number}).n, 0, `${name}: ${table}`);
    }
    assertions += 8;
  }
  sqlite.close();
}
await scenario('visible live attachment', '', true);
await scenario('hidden by sequence boundary', 'UPDATE room_files SET created_seq = 9;');
await scenario('legacy hidden by timestamp boundary', 'UPDATE room_files SET created_seq = NULL, created_at = 9;');
await scenario('expired room file', 'UPDATE room_files SET expires_at = 21;');
await scenario('retained file remains usable after old expiry', 'UPDATE room_files SET expires_at = 21, retained = 1;', true);
await scenario('full history permits historical file', "UPDATE room_files SET created_seq = 9; UPDATE rooms SET member_history_policy = 'full';", true);
const drive = `INSERT INTO drive_files (file_id,owner_scope,uploader_id,name,mime_type,size,sha256,state,visibility,room_id,created_at,expires_at,retained)
 VALUES ('file','actor:user','user','secret.txt','text/plain',1,'${'a'.repeat(64)}','bound','private','room',1,2,0);`;
await scenario('expired drive file cannot be revived', drive);
await scenario('deleted drive file cannot be revived', drive + "UPDATE drive_files SET state = 'deleted';");
await scenario('expiry changes after preflight', '', false, 'UPDATE room_files SET expires_at = 21;');
await scenario('history policy changes after preflight',
  "UPDATE rooms SET member_history_policy = 'full'; UPDATE room_files SET created_seq = 9;",
  false, "UPDATE rooms SET member_history_policy = 'from_join';");
await scenario('drive deletion after preflight', drive + `UPDATE drive_files SET expires_at = ${Date.now()+100000};`,
  false, "UPDATE drive_files SET state = 'deleted';");
console.log(`Task attachment access regressions: ${assertions} assertions passed`);
